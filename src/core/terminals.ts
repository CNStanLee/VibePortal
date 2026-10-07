import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TerminalId, TerminalOption, TerminalPref } from '../shared/types';

/**
 * Terminals a session can be opened in: the ones installed on this machine,
 * which one "auto" picks, and the command line that opens a window in a
 * folder — optionally running an agent CLI (`claude --resume …`) there.
 *
 * Nothing goes through a shell string we build from untrusted text: the
 * command is a fixed binary, fixed flags and a validated session id. Where a
 * terminal only takes one command string (cmd, PowerShell) each part is quoted
 * for that shell, and parts that can't be quoted safely are refused.
 */

export const TERMINAL_IDS: readonly TerminalId[] = [
  'wt',
  'pwsh',
  'powershell',
  'cmd',
  'git-bash',
  'ptyxis',
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'kitty',
  'alacritty',
  'wezterm',
  'foot',
  'x-terminal-emulator',
  'xterm',
];

const NAMES: Record<TerminalId, string> = {
  wt: 'Windows Terminal',
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: 'Command Prompt',
  'git-bash': 'Git Bash',
  ptyxis: 'Ptyxis',
  'gnome-terminal': 'GNOME Terminal',
  konsole: 'Konsole',
  'xfce4-terminal': 'Xfce Terminal',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  wezterm: 'WezTerm',
  foot: 'foot',
  'x-terminal-emulator': 'Default terminal (x-terminal-emulator)',
  xterm: 'XTerm',
};

export const isTerminalPref = (v: unknown): v is TerminalPref => v === 'auto' || TERMINAL_IDS.includes(v as TerminalId);

export interface TerminalInfo extends TerminalOption {
  path: string;
  /** Windows Terminal: the shell it runs a command in (PowerShell 7, else Windows PowerShell) */
  shell?: string;
  /** Git Bash: the MSYS2 environment its login profile sets up (UCRT64 in newer Git for Windows) */
  msystem?: string;
}

export interface DetectEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
}

const realEnv = (): DetectEnv => ({
  platform: process.platform,
  env: process.env,
  // lstat: Windows Terminal's wt.exe is an app execution alias, a reparse point stat() can't follow
  exists: (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
});

/** The terminals installed here, in the order "auto" prefers them. */
export function detectTerminals(d: DetectEnv = realEnv()): TerminalInfo[] {
  const win = d.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = (d.env.PATH ?? d.env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  const onPath = (name: string): string | undefined => {
    for (const dir of dirs) {
      const f = p.join(dir, win && !/\.exe$/i.test(name) ? `${name}.exe` : name);
      if (d.exists(f)) return f;
    }
    return undefined;
  };
  const first = (...cands: (string | undefined)[]) => cands.find((c) => !!c && d.exists(c));
  const out: TerminalInfo[] = [];
  const add = (id: TerminalId, file: string | undefined, extra: Partial<TerminalInfo> = {}) => {
    if (file) out.push({ id, name: NAMES[id], path: file, ...extra });
  };

  if (win) {
    const sysRoot = d.env.SystemRoot || d.env.windir || 'C:\\Windows';
    const programFiles = d.env.ProgramFiles || 'C:\\Program Files';
    const local = d.env.LOCALAPPDATA || (d.env.USERPROFILE ? p.join(d.env.USERPROFILE, 'AppData', 'Local') : '');
    const pwsh = first(onPath('pwsh'), p.join(programFiles, 'PowerShell', '7', 'pwsh.exe'));
    const powershell = first(p.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), onPath('powershell'));
    const wt = first(onPath('wt'), local && p.join(local, 'Microsoft', 'WindowsApps', 'wt.exe'));
    if (wt && (pwsh || powershell)) add('wt', wt, { shell: pwsh || powershell });
    add('pwsh', pwsh);
    add('powershell', powershell);
    add('cmd', first(d.env.ComSpec, p.join(sysRoot, 'System32', 'cmd.exe')));
    // Git for Windows: from git.exe on PATH (…\Git\cmd\git.exe, …\Git\mingw64\bin\git.exe) up to its root
    const roots = [p.join(programFiles, 'Git'), local && p.join(local, 'Programs', 'Git')];
    const git = onPath('git');
    if (git) for (let r = p.dirname(git), i = 0; i < 3; i++, r = p.dirname(r)) roots.unshift(r);
    const root = roots.find((r) => r && d.exists(p.join(r, 'bin', 'bash.exe')));
    if (root) {
      const mintty = p.join(root, 'usr', 'bin', 'mintty.exe');
      const msystem = d.exists(p.join(root, 'ucrt64', 'bin', 'git.exe')) ? 'UCRT64' : 'MINGW64';
      add('git-bash', d.exists(mintty) ? mintty : p.join(root, 'bin', 'bash.exe'), { shell: p.join(root, 'bin', 'bash.exe'), msystem });
    }
    return out;
  }

  if (d.platform === 'darwin') return out;

  // Linux / BSD desktops: the desktop's own terminal first
  const desktop = (d.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase();
  const order: TerminalId[] = ['ptyxis', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'wezterm', 'foot', 'x-terminal-emulator', 'xterm'];
  const lead: TerminalId | undefined = desktop.includes('KDE') ? 'konsole' : desktop.includes('XFCE') ? 'xfce4-terminal' : undefined;
  for (const id of lead ? [lead, ...order.filter((x) => x !== lead)] : order) add(id, onPath(id));
  return out;
}

/** The terminal a preference resolves to: the chosen one when it is installed, else the first one found. */
export function pickTerminal(list: TerminalInfo[], pref: TerminalPref): TerminalInfo | undefined {
  return (pref !== 'auto' && list.find((t) => t.id === pref)) || list[0];
}

export interface LaunchPlan {
  file: string;
  args: string[];
  /** pass `args` to CreateProcess as they are (they are already quoted for cmd) */
  verbatim?: boolean;
  env?: Record<string, string>;
}

/** A PowerShell single-quoted string (PowerShell also treats the typographic quotes as quotes). */
export const psQuote = (s: string) => `'${s.replace(/['‘’‚‛]/g, '$&$&')}'`;

/** A POSIX shell single-quoted string. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** cmd.exe has no escape inside double quotes: refuse what would break out or expand. */
function cmdQuote(s: string): string {
  if (/["%\r\n]/.test(s)) throw Object.assign(new Error(`cannot pass ${JSON.stringify(s)} to Command Prompt`), { status: 400 });
  return `"${s}"`;
}

/** Git Bash runs Windows paths with forward slashes; an npm .cmd shim has a sh twin next to it. */
function forBash(command: string[], exists: (p: string) => boolean): string[] {
  let [bin, ...rest] = command;
  const twin = bin.replace(/\.(cmd|bat)$/i, '');
  if (twin !== bin && exists(twin)) bin = twin;
  return [bin.replace(/\\/g, '/'), ...rest];
}

/**
 * How to open `t` in `cwd`, running `command` ([bin, ...args]) when given —
 * the window stays open on a shell after the command ends, so its last words
 * (or an error) can still be read. Pure: tests build plans for any platform.
 */
export function terminalLaunch(t: TerminalInfo, cwd: string, command: string[] | null, exists: (p: string) => boolean = realEnv().exists): LaunchPlan {
  const keepOpen = command ? ['sh', '-c', '"$@"; exec "${SHELL:-/bin/sh}"', 'sh', ...command] : null;
  switch (t.id) {
    case 'cmd':
      // /s strips the outer quotes and keeps the rest as it is
      return { file: t.path, args: command ? ['/s', '/k', `"${command.map(cmdQuote).join(' ')}"`] : ['/k'], verbatim: true };
    case 'pwsh':
    case 'powershell':
      return { file: t.path, args: command ? ['-NoLogo', '-NoExit', '-Command', `& ${command.map(psQuote).join(' ')}`] : ['-NoLogo'] };
    case 'wt': {
      // wt splits its command line at ';' unless it is escaped
      const esc = (s: string) => s.replace(/;/g, '\\;');
      const inner = command ? [t.shell!, '-NoLogo', '-NoExit', '-Command', `& ${command.map(psQuote).join(' ')}`] : [t.shell!, '-NoLogo'];
      return { file: t.path, args: ['-w', 'new', 'new-tab', '-d', esc(cwd), '--title', 'VibePortal', ...inner.map(esc)] };
    }
    case 'git-bash': {
      // CHERE_INVOKING: the login profile stays in the folder instead of going home
      const env = { CHERE_INVOKING: '1', MSYSTEM: t.msystem ?? 'MINGW64' };
      const script = command ? `${forBash(command, exists).map(shQuote).join(' ')}; exec bash --login -i` : null;
      const bashArgs = script ? ['--login', '-c', script] : ['--login', '-i'];
      // mintty (what Git Bash itself opens in) runs bash by its path inside Git's own tree
      if (/mintty\.exe$/i.test(t.path)) return { file: t.path, args: ['-t', 'VibePortal', '/usr/bin/bash', ...bashArgs], env };
      return { file: t.shell ?? t.path, args: bashArgs, env };
    }
    case 'gnome-terminal':
      return { file: t.path, args: [`--working-directory=${cwd}`, ...(keepOpen ? ['--', ...keepOpen] : [])] };
    case 'ptyxis':
      return { file: t.path, args: ['--new-window', `--working-directory=${cwd}`, ...(keepOpen ? ['--', ...keepOpen] : [])] };
    case 'konsole':
      return { file: t.path, args: ['--workdir', cwd, ...(keepOpen ? ['-e', ...keepOpen] : [])] };
    case 'xfce4-terminal':
      return { file: t.path, args: [`--working-directory=${cwd}`, ...(keepOpen ? ['-x', ...keepOpen] : [])] };
    case 'kitty':
      return { file: t.path, args: ['--directory', cwd, ...(keepOpen ?? [])] };
    case 'alacritty':
      return { file: t.path, args: ['--working-directory', cwd, ...(keepOpen ? ['-e', ...keepOpen] : [])] };
    case 'wezterm':
      return { file: t.path, args: ['start', '--cwd', cwd, ...(keepOpen ? ['--', ...keepOpen] : [])] };
    case 'foot':
      return { file: t.path, args: [`--working-directory=${cwd}`, ...(keepOpen ?? [])] };
    case 'x-terminal-emulator':
    case 'xterm':
      // no working-directory flag: the process's own cwd is used
      return { file: t.path, args: keepOpen ? ['-e', ...keepOpen] : [] };
  }
}

/** One argument as CreateProcess / the C runtime split a command line (what Node does for spawn). */
export function winQuote(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === '\\') slashes++;
    else {
      out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch;
      slashes = 0;
    }
  }
  return out + '\\'.repeat(slashes * 2) + '"';
}

/**
 * Windows: a detached spawn gets no console at all (DETACHED_PROCESS), so cmd
 * and PowerShell would run without a window. Start-Process opens the terminal
 * the way Explorer would — a console of its own (on Windows 11 in the default
 * terminal app), outside VibePortal's process tree — and prints its pid. The
 * script goes in encoded, so nothing in it is re-parsed on the way.
 */
export function windowsStart(plan: LaunchPlan, cwd: string, powershell: string): LaunchPlan {
  const line = plan.verbatim ? plan.args.join(' ') : plan.args.map(winQuote).join(' ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { $p = Start-Process -PassThru -FilePath ${psQuote(plan.file)} -WorkingDirectory ${psQuote(cwd)}${line ? ` -ArgumentList ${psQuote(line)}` : ''}; $p.Id }`,
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
  return { file: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env: plan.env };
}

/** Opens a terminal window in `cwd` (running `command` there); returns the one it used. */
export async function openTerminal(pref: TerminalPref, cwd: string, command: string[] | null, list: TerminalInfo[] = detectTerminals()): Promise<TerminalOption> {
  const t = pickTerminal(list, pref);
  if (!t) throw Object.assign(new Error('No terminal found on this computer'), { status: 501 });
  await launchTerminal(terminalLaunch(t, cwd, command), cwd);
  return { id: t.id, name: t.name };
}

/** Starts a plan; resolves with the terminal's pid once it is up. */
export function launchTerminal(plan: LaunchPlan, cwd: string): Promise<number | undefined> {
  // the agent should label the session itself, not inherit VibePortal's own environment
  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env, ELECTRON_RUN_AS_NODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CLAUDECODE: undefined };
  const fail = (msg: string) => Object.assign(new Error(`Could not open the terminal: ${msg}`), { status: 500 });
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const s = windowsStart(plan, cwd, ps);
    return new Promise((resolve, reject) => {
      execFile(s.file, s.args, { cwd, env, windowsHide: true, timeout: 30_000 }, (e, out, err) =>
        e ? reject(fail(String(err || e.message).trim().split('\n')[0])) : resolve(Number(String(out).trim()) || undefined),
      );
    });
  }
  return new Promise((resolve, reject) => {
    // its own session: the terminal outlives VibePortal
    const child = spawn(plan.file, plan.args, { cwd: cwd || os.homedir(), env, stdio: 'ignore', detached: true });
    child.once('error', (e) => reject(fail(e.message)));
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}
