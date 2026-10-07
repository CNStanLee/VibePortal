import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectTerminals, launchTerminal, pickTerminal, psQuote, terminalLaunch, winQuote, windowsStart, type DetectEnv, type TerminalInfo } from '../src/core/terminals';
import { fakeCli } from './fakeCli';

const fakeFs = (files: string[]): DetectEnv['exists'] => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};

test('terminals: Windows finds Windows Terminal, PowerShell, cmd and Git Bash (from git on PATH)', () => {
  const env = {
    PATH: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\system32',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  };
  const list = detectTerminals({
    platform: 'win32',
    env,
    exists: fakeFs([
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\system32\\cmd.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\mintty.exe',
      'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe',
    ]),
  });
  assert.deepEqual(
    list.map((t) => t.id),
    ['wt', 'powershell', 'cmd', 'git-bash'],
  );
  assert.equal(list[0].shell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'Windows Terminal runs commands in PowerShell');
  const git = list.find((t) => t.id === 'git-bash')!;
  assert.equal(git.path, 'C:\\Program Files\\Git\\usr\\bin\\mintty.exe');
  assert.equal(git.msystem, 'UCRT64');
  // PowerShell 7 is preferred over Windows PowerShell inside Windows Terminal
  const with7 = detectTerminals({ platform: 'win32', env, exists: fakeFs(['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) });
  assert.deepEqual(
    with7.map((t) => [t.id, t.shell]),
    [
      ['wt', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
      ['pwsh', undefined],
    ],
  );
});

test('terminals: Linux lists what is on PATH, the desktop’s own terminal first', () => {
  const exists = fakeFs(['/usr/bin/gnome-terminal', '/usr/bin/konsole', '/usr/bin/xterm', '/usr/local/bin/kitty']);
  const plain = detectTerminals({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, exists });
  assert.deepEqual(
    plain.map((t) => t.id),
    ['gnome-terminal', 'konsole', 'kitty', 'xterm'],
  );
  const kde = detectTerminals({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin', XDG_CURRENT_DESKTOP: 'KDE' }, exists });
  assert.equal(kde[0].id, 'konsole');
  assert.equal(pickTerminal(plain, 'auto')?.id, 'gnome-terminal');
  assert.equal(pickTerminal(plain, 'xterm')?.id, 'xterm');
  assert.equal(pickTerminal(plain, 'wt')?.id, 'gnome-terminal', 'a choice that is not installed falls back to the first one');
  assert.equal(pickTerminal([], 'auto'), undefined);
});

const T = (id: TerminalInfo['id'], p: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, name: id, path: p, ...extra });
const resume = ['C:\\Users\\O\'Neil\\AppData\\Roaming\\npm\\claude.cmd', '--resume', '0c4b4a6e-58a5-4e4a-9d0e-9b5a3e3f8a11'];

test('terminals: each Windows terminal gets the command quoted for its own shell', () => {
  const cmd = terminalLaunch(T('cmd', 'C:\\Windows\\system32\\cmd.exe'), 'C:\\work', resume);
  assert.equal(cmd.verbatim, true);
  assert.deepEqual(cmd.args, ['/s', '/k', `""C:\\Users\\O'Neil\\AppData\\Roaming\\npm\\claude.cmd" "--resume" "0c4b4a6e-58a5-4e4a-9d0e-9b5a3e3f8a11""`]);
  assert.throws(() => terminalLaunch(T('cmd', 'cmd.exe'), 'C:\\', ['C:\\100%\\claude.cmd']), /Command Prompt/, '% would expand inside cmd');
  assert.deepEqual(terminalLaunch(T('cmd', 'cmd.exe'), 'C:\\', null).args, ['/k']);

  const ps = terminalLaunch(T('powershell', 'powershell.exe'), 'C:\\work', resume);
  assert.deepEqual(ps.args, ['-NoLogo', '-NoExit', '-Command', `& 'C:\\Users\\O''Neil\\AppData\\Roaming\\npm\\claude.cmd' '--resume' '0c4b4a6e-58a5-4e4a-9d0e-9b5a3e3f8a11'`]);
  assert.equal(psQuote('it’s'), `'it’’s'`, 'typographic quotes close a PowerShell string too');

  const wt = terminalLaunch(T('wt', 'wt.exe', { shell: 'pwsh.exe' }), 'C:\\a;b', ['C:\\x;y\\codex.exe', 'resume', 'abc']);
  assert.deepEqual(wt.args.slice(0, 7), ['-w', 'new', 'new-tab', '-d', 'C:\\a\\;b', '--title', 'VibePortal']);
  assert.equal(wt.args[7], 'pwsh.exe');
  assert.match(wt.args.at(-1)!, /^& 'C:\\x\\;y\\codex\.exe' 'resume' 'abc'$/, "wt's ; separator is escaped");

  const exists = fakeFs(['C:\\Users\\O\'Neil\\AppData\\Roaming\\npm\\claude']);
  const bash = terminalLaunch(T('git-bash', 'C:\\Git\\usr\\bin\\mintty.exe', { shell: 'C:\\Git\\bin\\bash.exe', msystem: 'UCRT64' }), 'C:\\work', resume, exists);
  assert.deepEqual(bash.env, { CHERE_INVOKING: '1', MSYSTEM: 'UCRT64' });
  assert.deepEqual(bash.args.slice(0, 5), ['-t', 'VibePortal', '/usr/bin/bash', '--login', '-c']);
  assert.equal(bash.args[5], `'C:/Users/O'\\''Neil/AppData/Roaming/npm/claude' '--resume' '0c4b4a6e-58a5-4e4a-9d0e-9b5a3e3f8a11'; exec bash --login -i`, 'npm’s sh shim, forward slashes');
});

test('terminals: Windows starts the terminal through Start-Process, arguments quoted as CreateProcess splits them', () => {
  assert.equal(winQuote('plain'), 'plain');
  assert.equal(winQuote(''), '""');
  assert.equal(winQuote('a b'), '"a b"');
  assert.equal(winQuote('C:\\dir with space\\'), '"C:\\dir with space\\\\"', 'a trailing backslash is doubled before the closing quote');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  const decode = (p: { args: string[] }) => Buffer.from(p.args.at(-1)!, 'base64').toString('utf16le');

  const s = windowsStart(terminalLaunch(T('powershell', 'C:\\ps.exe'), 'C:\\w', resume), "C:\\O'Neil's repo", 'C:\\ps.exe');
  assert.equal(s.file, 'C:\\ps.exe');
  assert.equal(s.args.at(-2), '-EncodedCommand');
  const script = decode(s);
  assert.ok(script.includes(`Start-Process -PassThru -FilePath 'C:\\ps.exe' -WorkingDirectory 'C:\\O''Neil''s repo' -ArgumentList `), script);
  assert.ok(script.includes(`-ArgumentList '-NoLogo -NoExit -Command "& ''C:\\Users\\O''''Neil\\AppData\\Roaming\\npm\\claude.cmd'' ''--resume'' ''0c4b4a6e-58a5-4e4a-9d0e-9b5a3e3f8a11''"'`), script);
  // a cmd plan is already quoted for cmd: it goes in as it is
  assert.ok(decode(windowsStart(terminalLaunch(T('cmd', 'C:\\cmd.exe'), 'C:\\w', ['C:\\x\\claude.cmd']), 'C:\\w', 'ps')).includes(`-ArgumentList '/s /k ""C:\\x\\claude.cmd""'`));
  assert.ok(!decode(windowsStart(terminalLaunch(T('powershell', 'C:\\ps.exe'), 'C:\\w', null), 'C:\\w', 'ps')).includes(`-ArgumentList ''`), 'no empty argument list');
});

test('terminals: Linux terminals run the command, then stay open on a shell', () => {
  const cmd = ['/home/me/.local/bin/claude', '--resume', 'id with space'];
  const keep = ['sh', '-c', '"$@"; exec "${SHELL:-/bin/sh}"', 'sh', ...cmd];
  assert.deepEqual(terminalLaunch(T('gnome-terminal', '/usr/bin/gnome-terminal'), '/repo', cmd).args, ['--working-directory=/repo', '--', ...keep]);
  assert.deepEqual(terminalLaunch(T('konsole', '/usr/bin/konsole'), '/repo', cmd).args, ['--workdir', '/repo', '-e', ...keep]);
  assert.deepEqual(terminalLaunch(T('kitty', '/usr/bin/kitty'), '/repo', cmd).args, ['--directory', '/repo', ...keep]);
  assert.deepEqual(terminalLaunch(T('wezterm', '/usr/bin/wezterm'), '/repo', cmd).args, ['start', '--cwd', '/repo', '--', ...keep]);
  assert.deepEqual(terminalLaunch(T('xterm', '/usr/bin/xterm'), '/repo', null).args, []);
  assert.deepEqual(terminalLaunch(T('gnome-terminal', '/usr/bin/gnome-terminal'), '/repo', null).args, ['--working-directory=/repo']);
});

// keep config out of the real ~/.vibeportal
process.env.VIBEPORTAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-term-cfg-'));

test('terminals: what a task opens — the conversation resumed, or a shell in its folder', async () => {
  const { loadConfig } = await import('../src/core/config');
  const { Monitor } = await import('../src/core/monitor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-term-cmd-'));
  const claudeBin = fakeCli(dir, 'claude', '');
  const codexBin = fakeCli(dir, 'codex', '');
  const m = new Monitor({ ...loadConfig(), claudeBin, codexBin, claudeDir: path.join(dir, 'claude-dir') });
  const base = { title: 't', state: 'done' as const, updatedAt: '', cwd: dir };
  const sid = '0c4b4a6e-58a5-4e4a-9d0e-9b5a3e3f8a11';
  assert.deepEqual(m.terminalCommand({ ...base, id: `claude:${sid}`, kind: 'claude-code' }), { cwd: dir, command: [claudeBin, '--resume', sid] });
  assert.deepEqual(m.terminalCommand({ ...base, id: `claude:${sid}`, kind: 'claude-code', alive: true }).command, [claudeBin, '--resume', sid, '--fork-session'], 'a live session is forked');
  // Codex thread ids are UUIDs (v7) — digits and dashes
  const thread = '0199a5c3-7d2e-7f31-9b8e-3c1f0e6a4b2d';
  assert.deepEqual(m.terminalCommand({ ...base, id: `codex:${thread}`, kind: 'codex' }).command, [codexBin, 'resume', thread]);
  assert.deepEqual(m.terminalCommand({ ...base, id: 'dispatch:x', kind: 'dispatch', provider: 'openai', sessionId: thread }).command, [codexBin, 'resume', thread]);
  assert.deepEqual(m.terminalCommand({ ...base, id: 'custom:build', kind: 'custom' }), { cwd: dir, command: null });
  assert.throws(() => m.terminalCommand({ ...base, id: 'claude:not-a-uuid; calc', kind: 'claude-code' }), /invalid session id/);
  assert.throws(() => m.terminalCommand({ ...base, id: 'codex:a b', kind: 'codex' }), /invalid session id/);
  assert.throws(() => m.terminalCommand({ ...base, id: 'custom:gone', kind: 'custom', cwd: path.join(dir, 'missing') }), /Working directory not found/);
});

test('terminals: the setting takes known terminals only', async () => {
  const { applyPatch, loadConfig, toPublic } = await import('../src/core/config');
  const cfg = loadConfig();
  assert.equal(cfg.terminal, 'auto');
  assert.equal(applyPatch(cfg, { terminal: 'git-bash' }).terminal, 'git-bash');
  assert.equal(applyPatch(cfg, { terminal: 'calc.exe' as never }).terminal, 'auto');
  assert.equal(toPublic(applyPatch(cfg, { terminal: 'konsole' })).terminal, 'konsole');
});

/**
 * Opens every terminal installed here for real, running a stand-in `claude.cmd`
 * from a folder whose name needs quoting in every shell, and checks what it got.
 * Opens windows on the desktop, so only when asked: VP_TERMINAL_E2E=1.
 */
test('terminals: every installed terminal really runs the command in the folder', { skip: !process.env.VP_TERMINAL_E2E }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vp term O'Neil 終端 "));
  const marker = path.join(dir, 'got.json');
  const bin = fakeCli(dir, 'claude', `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, tty: !!process.stdout.isTTY }));`);
  const list = detectTerminals();
  assert.ok(list.length > 0, 'at least one terminal');
  for (const term of list) {
    await t.test(term.name, async () => {
      fs.rmSync(marker, { force: true });
      process.env.CLAUDECODE = '1'; // must not leak into the terminal
      const pid = await launchTerminal(terminalLaunch(term, dir, [bin, '--resume', 'abc-123', '--fork-session']), dir);
      assert.ok(pid, 'the terminal’s pid');
      try {
        const end = Date.now() + 20_000;
        while (!fs.existsSync(marker) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
        assert.ok(fs.existsSync(marker), `${term.name} ran the command`);
        await new Promise((r) => setTimeout(r, 100));
        const got = JSON.parse(fs.readFileSync(marker, 'utf8'));
        assert.deepEqual(got.args, ['--resume', 'abc-123', '--fork-session']);
        assert.equal(fs.realpathSync(got.cwd).toLowerCase(), fs.realpathSync(dir).toLowerCase());
        assert.equal(got.claudecode, null);
        // a console of its own, i.e. a window (mintty is a GUI with a pty of its own, not a console)
        if (term.id !== 'git-bash') assert.equal(got.tty, true, 'the command runs in a console window');
      } finally {
        delete process.env.CLAUDECODE;
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
          // mintty starts itself again under another pid: close whatever still runs from the test folder
          const tag = path.basename(dir).slice(-6); // mkdtemp's random suffix: the rest is quoted differently per shell
          spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
        } else process.kill(pid!);
      }
    });
  }
});
