import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBin } from './actions';
import { dataDir } from './config';
import type { ServerInfo, TunnelProvider } from '../shared/types';

export interface TunnelOptions {
  ngrokDomain?: string;
  ngrokAuthtoken?: string;
}

interface ProviderSpec {
  bin: 'cloudflared' | 'ssh' | 'ngrok';
  args: (port: number, o: TunnelOptions) => string[];
  env?: (o: TunnelOptions) => Record<string, string>;
  /** a readable cause for an exit that will be retried */
  explain?: (text: string) => { reason?: 'busy'; error: string; link?: string } | undefined;
  /** a fatal problem the user has to fix (e.g. missing ngrok authtoken) */
  fatal?: (text: string) => { reason: 'auth' | 'approve'; error: string; link?: string } | undefined;
  /** the public address, when this output chunk announces it */
  url: (text: string) => string | undefined;
  /** the tunnel is actually connected (the URL alone may come first) */
  ready: (text: string) => boolean;
  /** what a connection failure most likely means on this provider */
  blockedHint: RegExp;
  blockedMsg: string;
}

/**
 * SSH relays need no install (OpenSSH ships with Linux, macOS and Windows 10+)
 * and get out over ports 22 / 443. Our own SSH keys are never offered, and
 * their host keys go into VibePortal's own known_hosts file.
 */
const sshOpts = () => [
  '-T',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', `UserKnownHostsFile=${path.join(dataDir(), 'known_hosts')}`,
  '-o', 'PubkeyAuthentication=no',
  '-o', 'PasswordAuthentication=no',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ConnectTimeout=15',
];

/** ngrok logs one JSON object per line with --log-format json. */
const ngrokLines = (t: string) =>
  t
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);

const PROVIDERS: Record<Exclude<TunnelProvider, 'tailscale'>, ProviderSpec> = {
  // a free ngrok account has one static domain: the address never changes
  ngrok: {
    bin: 'ngrok',
    args: (port, o) => ['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json', ...(o.ngrokDomain ? ['--url', `https://${o.ngrokDomain}`] : [])],
    env: (o): Record<string, string> => (o.ngrokAuthtoken ? { NGROK_AUTHTOKEN: o.ngrokAuthtoken } : {}),
    url: (t) => ngrokLines(t).find((j) => j.msg === 'started tunnel' && typeof j.url === 'string')?.url,
    ready: (t) => ngrokLines(t).some((j) => j.msg === 'started tunnel'),
    fatal: (t) => {
      const e = ngrokLines(t).find((j) => (j.lvl === 'eror' || j.lvl === 'crit') && j.err);
      if (!e) return undefined;
      const err = String(e.err);
      // only a missing / rejected token needs the user; everything else is retried
      if (/ERR_NGROK_(4018|105|107)|authtoken|authentication failed/i.test(err)) {
        return { reason: 'auth', error: 'ngrok needs your authtoken (free account)', link: 'https://dashboard.ngrok.com/get-started/your-authtoken' };
      }
      return undefined;
    },
    blockedHint: /dial tcp|i\/o timeout|connection refused/i,
    blockedMsg: 'cannot reach ngrok from this network',
    explain: (t) => {
      const e = ngrokLines(t).find((j) => (j.lvl === 'eror' || j.lvl === 'crit') && j.err);
      const err = e ? String(e.err) : '';
      // ERR_NGROK_334: another agent (a manual `ngrok http`, a session that hasn't timed out yet) holds the domain
      if (/ERR_NGROK_334|already online/i.test(err)) return { reason: 'busy', error: 'the domain is in use by another ngrok session — retrying', link: 'https://dashboard.ngrok.com/agents' };
      return err ? { error: err.split('\n')[0].slice(0, 240) } : undefined;
    },
  },
  'localhost.run': {
    bin: 'ssh',
    args: (port) => [...sshOpts(), '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run', '--', '--output', 'json'],
    url: (t) => /https:\/\/[a-z0-9-]+\.lhr\.(life|pro)/.exec(t)?.[0],
    // a JSON event per (re)registered address; the free domain rotates from time to time
    ready: (t) => t.includes('tcpip_forward.register.accepted'),
    blockedHint: /timed out|Connection refused|No route|Could not resolve/i,
    blockedMsg: 'cannot reach localhost.run over SSH (port 22) from this network',
  },
  pinggy: {
    bin: 'ssh',
    args: (port) => ['-p', '443', ...sshOpts(), `-R0:127.0.0.1:${port}`, 'a.pinggy.io'],
    url: (t) => [...t.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').matchAll(/https:\/\/[a-z0-9.-]*pinggy[a-z0-9.-]*/g)].map((m) => m[0]).find((u) => !u.includes('dashboard.')),
    ready: (t) => /https:\/\/[a-z0-9-]+\.[a-z0-9.-]*pinggy/.test(t.replace(/https:\/\/dashboard\.pinggy\.io/g, '')),
    blockedHint: /timed out|Connection refused|No route|Could not resolve/i,
    blockedMsg: 'cannot reach a.pinggy.io over SSH (port 443) from this network',
  },
  cloudflare: {
    bin: 'cloudflared',
    args: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    url: (t) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(t)?.[0],
    ready: (t) => /Registered tunnel connection/.test(t),
    blockedHint: /7844/,
    blockedMsg: 'this network blocks outbound port 7844 (TCP and UDP), which Cloudflare tunnels need',
  },
};

/**
 * A public https address for this machine through a relay — Cloudflare quick
 * tunnel, localhost.run or Pinggy. No account or router setup; the address
 * changes when the tunnel restarts.
 */
export class Tunnel {
  private child?: ChildProcess;
  private key = '';
  private wanted = false;
  private opts: TunnelOptions = {};
  private retry?: NodeJS.Timeout;
  private failures = 0;
  state: ServerInfo['tunnel'] = { state: 'off' };

  constructor(private onChange: () => void) {}

  /** Starts, restarts (provider / port changed) or stops the tunnel to match the settings. */
  sync(enabled: boolean, port: number, provider: TunnelProvider, opts: TunnelOptions = {}) {
    this.wanted = enabled;
    if (!enabled) return this.stop();
    const key = `${provider}:${port}:${opts.ngrokDomain ?? ''}:${opts.ngrokAuthtoken ? 'tok' : ''}`;
    if ((this.child || this.tailscalePort) && this.key === key) return;
    this.stop();
    this.key = key;
    this.opts = opts;
    this.failures = 0;
    if (provider === 'tailscale') void this.launchTailscale(port);
    else this.launch(provider, port);
  }

  // ── Tailscale Funnel: a setting of tailscaled (not a process of ours), fixed https://<machine>.<tailnet>.ts.net
  private tailscalePort = 0;

  private async launchTailscale(port: number) {
    const bin = resolveBin('tailscale');
    if (!bin) return this.set({ state: 'missing', provider: 'tailscale', error: 'tailscale is not installed', link: 'https://tailscale.com/download' });
    this.set({ state: 'starting', provider: 'tailscale' });
    this.tailscalePort = port;
    // --bg: tailscaled keeps serving it; we turn it off again in stop()
    const r = await run(bin, ['funnel', '--bg', String(port)], 45_000);
    if (!this.wanted || this.tailscalePort !== port) return;
    const text = r.out + r.err;
    const approve = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0];
    if (r.code !== 0 || approve) {
      this.tailscalePort = 0;
      return this.set({
        state: 'error',
        provider: 'tailscale',
        reason: approve ? 'approve' : undefined,
        link: approve,
        error: approve ? 'Funnel has to be enabled for this machine in your tailnet first' : text.trim().split('\n').pop()?.slice(0, 240) || `tailscale exited (${r.code})`,
      });
    }
    const st = await run(bin, ['status', '--json'], 15_000);
    let host = '';
    try {
      host = String(JSON.parse(st.out)?.Self?.DNSName ?? '').replace(/\.$/, '');
    } catch {
      /* fall through */
    }
    if (!host) return this.set({ state: 'error', provider: 'tailscale', error: 'tailscale is not logged in (run `tailscale up`)' });
    this.set({ state: 'on', provider: 'tailscale', url: `https://${host}` });
  }

  stop() {
    clearTimeout(this.retry);
    const c = this.child;
    this.child = undefined;
    c?.kill();
    if (this.tailscalePort) {
      this.tailscalePort = 0;
      const bin = resolveBin('tailscale');
      if (bin) void run(bin, ['funnel', '--https=443', 'off'], 15_000);
    }
    if (this.state.state !== 'off') this.set({ state: 'off' });
  }

  private launch(provider: Exclude<TunnelProvider, 'tailscale'>, port: number) {
    const spec = PROVIDERS[provider];
    const bin = resolveBin(spec.bin);
    const install = { ngrok: 'https://ngrok.com/download', cloudflared: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/', ssh: undefined }[spec.bin];
    if (!bin) return this.set({ state: 'missing', provider, error: `${spec.bin} is not installed`, link: install });
    this.set({ state: 'starting', provider });
    const child = spawn(bin, spec.args(port, this.opts), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...spec.env?.(this.opts) } });
    this.child = child;
    let tail = '';
    let url: string | undefined;
    let connected = false;
    let lastErr = '';
    const giveUp = setTimeout(() => {
      if (this.child !== child || this.state.state === 'on') return;
      const blocked = spec.blockedHint.test(tail);
      this.fail(child, provider, port, {
        state: 'error',
        provider,
        reason: blocked ? 'blocked' : 'timeout',
        error: blocked ? spec.blockedMsg : lastErr || 'could not connect the tunnel',
      });
    }, 30_000);
    const scan = (b: Buffer) => {
      if (this.child !== child) return;
      const text = b.toString('utf8');
      tail = (tail + text).slice(-4000);
      const err = text
        .split('\n')
        .filter((l) => /\bERR\b|error|denied|refused|timed out/i.test(l) && !/^\s*\{/.test(l))
        .pop();
      if (err) lastErr = err.replace(/^\S+\s+ERR\s+/, '').trim().slice(0, 200);
      const fatal = spec.fatal?.(text);
      if (fatal) {
        clearTimeout(giveUp);
        // retrying won't help until the user fixes it
        this.wanted = false;
        this.child = undefined;
        child.kill();
        return this.set({ state: 'error', provider, ...fatal });
      }
      const u = spec.url(text);
      if (u) url = u;
      // check each chunk too: localhost.run's event carries a large ASCII QR code that pushes it out of `tail`
      if (spec.ready(text) || spec.ready(tail)) connected = true;
      if (url && connected) {
        clearTimeout(giveUp);
        this.failures = 0;
        if (this.state.url !== url || this.state.state !== 'on') this.set({ state: 'on', provider, url });
      } else if (u && this.state.state !== 'on') this.set({ state: 'starting', provider, url });
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (e) => this.set({ state: 'error', provider, error: String(e.message) }));
    child.on('exit', (code) => {
      clearTimeout(giveUp);
      if (this.child !== child) return; // stopped on purpose
      this.child = undefined;
      const blocked = this.state.state !== 'on' && spec.blockedHint.test(tail);
      const why = spec.explain?.(tail);
      this.set(
        blocked
          ? { state: 'error', provider, reason: 'blocked', error: spec.blockedMsg }
          : { state: 'error', provider, reason: why?.reason, error: why?.error || lastErr || `${spec.bin} exited (${code})`, link: why?.link },
      );
      this.scheduleRetry(provider, port);
    });
  }

  /** Stops a tunnel that can't connect (it would retry forever), then tries again later. */
  private fail(child: ChildProcess, provider: Exclude<TunnelProvider, 'tailscale'>, port: number, s: ServerInfo['tunnel']) {
    this.child = undefined;
    child.kill();
    this.set(s);
    this.scheduleRetry(provider, port);
  }

  private scheduleRetry(provider: Exclude<TunnelProvider, 'tailscale'>, port: number) {
    if (!this.wanted) return;
    // back off: 5 s, 10 s, 20 s … up to 2 min (a dropped session / a stale ngrok agent clears quickly)
    const delay = Math.min(120_000, 5000 * 2 ** this.failures++);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.wanted && !this.child && this.launch(provider, port), delay);
  }

  private set(s: ServerInfo['tunnel']) {
    this.state = s;
    this.onChange();
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (e, out, err) => {
      const code = e ? (typeof (e as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((e as { code?: unknown }).code) : 1) : 0;
      resolve({ code, out: String(out ?? ''), err: String(err ?? '') });
    });
  });
}

/** What a provider still needs before it can run, for the setup checklist in Settings. */
export interface TunnelCheck {
  installed: boolean;
  version?: string;
  /** ngrok: where the authtoken comes from */
  token?: 'ngrok-config' | 'vibeportal' | 'none';
  /** tailscale: logged in to a tailnet */
  loggedIn?: boolean;
}

export async function checkProvider(provider: TunnelProvider, cfg: { ngrokAuthtoken: string }): Promise<TunnelCheck> {
  const bin = resolveBin(provider === 'cloudflare' ? 'cloudflared' : provider === 'ngrok' ? 'ngrok' : provider === 'tailscale' ? 'tailscale' : 'ssh');
  if (!bin) return { installed: false, ...(provider === 'ngrok' ? { token: cfg.ngrokAuthtoken ? 'vibeportal' : 'none' } : {}) };
  if (provider === 'ngrok') {
    const v = await run(bin, ['version'], 8000);
    const conf = await run(bin, ['config', 'check'], 8000);
    const file = /at\s+(\S+\.yml)/.exec(conf.out + conf.err)?.[1];
    let inConfig = false;
    try {
      inConfig = !!file && /^\s*authtoken:\s*\S+/m.test(fs.readFileSync(file, 'utf8'));
    } catch {
      /* no config */
    }
    return { installed: true, version: /\d+\.\d+\.\d+/.exec(v.out)?.[0], token: cfg.ngrokAuthtoken ? 'vibeportal' : inConfig ? 'ngrok-config' : 'none' };
  }
  if (provider === 'tailscale') {
    const st = await run(bin, ['status', '--json'], 8000);
    let loggedIn = false;
    try {
      loggedIn = JSON.parse(st.out)?.BackendState === 'Running';
    } catch {
      /* not running */
    }
    return { installed: true, loggedIn };
  }
  return { installed: true };
}
