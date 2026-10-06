import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import type { RemoteHostConfig, RemoteHostSnapshot, Snapshot, TaskInfo } from '../shared/types';

export const DISCOVERY_PORT = 8788;

/**
 * Pulls snapshots from other VibePortal instances (e.g. GPU servers where the
 * agents actually run) so their tasks and limits show up here.
 */
export class RemoteHosts {
  private state = new Map<string, { snap?: Snapshot; error?: string; at?: number }>();
  private inflight = new Set<string>();

  async poll(hosts: RemoteHostConfig[]) {
    const ids = new Set(hosts.map((h) => h.id));
    for (const k of this.state.keys()) if (!ids.has(k)) this.state.delete(k);
    await Promise.all(
      hosts.map(async (h) => {
        if (this.inflight.has(h.id)) return;
        this.inflight.add(h.id);
        try {
          const res = await fetch(new URL('api/snapshot', withSlash(h.url)), {
            headers: { Authorization: `Bearer ${h.token}` },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) throw new Error(res.status === 401 ? 'token rejected' : `HTTP ${res.status}`);
          this.state.set(h.id, { snap: (await res.json()) as Snapshot, at: Date.now() });
        } catch (e) {
          const prev = this.state.get(h.id);
          this.state.set(h.id, { snap: prev?.snap, at: prev?.at, error: (e as Error).message });
        } finally {
          this.inflight.delete(h.id);
        }
      }),
    );
  }

  snapshots(hosts: RemoteHostConfig[]): RemoteHostSnapshot[] {
    return hosts.map((h) => {
      const st = this.state.get(h.id);
      const stale = !st?.at || Date.now() - st.at > 120_000;
      return {
        id: h.id,
        name: h.name,
        url: h.url,
        online: !!st?.snap && !st.error && !stale,
        error: st?.error,
        updatedAt: st?.at ? new Date(st.at).toISOString() : undefined,
        providers: (st?.snap?.providers ?? []).map((p) => ({ provider: p.provider, name: p.name, plan: p.plan, quotas: p.quotas, resetCredits: p.resetCredits })),
      };
    });
  }

  /** Remote tasks, re-keyed so actions can be routed back to their host. */
  tasks(hosts: RemoteHostConfig[]): TaskInfo[] {
    const out: TaskInfo[] = [];
    for (const h of hosts) {
      const st = this.state.get(h.id);
      if (!st?.snap || st.error) continue;
      for (const t of st.snap.tasks ?? []) {
        if (t.host) continue; // don't re-export a host's own remotes (avoids loops)
        out.push({ ...t, id: `remote:${h.id}:${t.id}`, host: h.name });
      }
    }
    return out;
  }
}

export function parseRemoteTaskId(id: string): { hostId: string; taskId: string } | undefined {
  const m = /^remote:([^:]+):(.+)$/.exec(id);
  return m ? { hostId: m[1], taskId: m[2] } : undefined;
}

export const newHostId = () => crypto.randomBytes(4).toString('hex');
const withSlash = (u: string) => (u.endsWith('/') ? u : u + '/');

export interface Discovered {
  id: string;
  name: string;
  /** http://ip:port */
  url: string;
  seenAt: string;
}

/**
 * LAN discovery: when remote access is on, announce ourselves by UDP broadcast;
 * always listen for others. Only name/port/instance id are broadcast — never the token.
 */
export class Discovery {
  private sock?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private found = new Map<string, Discovered & { at: number }>();

  constructor(
    private instanceId: string,
    private info: () => { name: string; port: number; announce: boolean },
  ) {}

  start() {
    try {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => this.stop());
      sock.on('message', (buf, rinfo) => {
        try {
          const m = JSON.parse(buf.toString('utf8'));
          if (m?.app !== 'vibeportal' || m.id === this.instanceId || typeof m.port !== 'number') return;
          this.found.set(m.id, {
            id: String(m.id).slice(0, 32),
            name: String(m.name ?? rinfo.address).slice(0, 64),
            url: `http://${rinfo.address}:${m.port}`,
            seenAt: new Date().toISOString(),
            at: Date.now(),
          });
        } catch {
          /* not ours */
        }
      });
      sock.bind(DISCOVERY_PORT, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          /* ignore */
        }
      });
      this.sock = sock;
      this.timer = setInterval(() => this.announce(), 10_000);
      this.timer.unref();
      setTimeout(() => this.announce(), 1000).unref();
    } catch {
      /* discovery is best-effort */
    }
  }

  private announce() {
    const i = this.info();
    if (!i.announce || !this.sock) return;
    const msg = Buffer.from(JSON.stringify({ app: 'vibeportal', id: this.instanceId, name: i.name, port: i.port }));
    for (const addr of broadcastAddresses()) this.sock.send(msg, DISCOVERY_PORT, addr, () => {});
  }

  list(): Discovered[] {
    const cutoff = Date.now() - 60_000;
    return [...this.found.values()].filter((d) => d.at > cutoff).map(({ at: _at, ...d }) => d);
  }

  stop() {
    clearInterval(this.timer);
    try {
      this.sock?.close();
    } catch {
      /* already closed */
    }
    this.sock = undefined;
  }
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}
