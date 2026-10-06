import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Monitor, type Notice } from '../core/monitor';
import { cleanRunOptions } from '../core/actions';
import { LOCAL_ONLY_FIELDS, applyPatch, checkPassword, hasRemoteAuth, saveConfig, toPublic } from '../core/config';
import { LoginLimiter, VIA_TUNNEL, authMode, authorized, clientIp, isLocalRequest, issueSession, verifyGoogleIdToken } from './auth';
import { Tunnel, checkProvider } from '../core/tunnel';
import type { ServerInfo } from '../shared/types';
import { FarmStore } from '../core/farm';
import { FarmSocial } from '../core/farmSocial';
import { importGithubProfile } from '../core/githubProfile';
import { farmCardSvg } from '../shared/farmCard';
import { Discovery, lanAddresses, newHostId, parseRemoteTaskId } from '../core/remote';
import { WebPush } from '../core/webpush';

export interface ServerOptions {
  monitor: Monitor;
  uiDir: string;
  /** explicit bind host (CLI --host); when omitted it follows the remoteAccess setting */
  host?: string;
  port: number;
  mode: 'desktop' | 'web';
  version: string;
  /** Called after settings are saved (desktop uses it for launch-at-login, pet window…). */
  onSettingsChanged?: () => void;
}

export interface ServerHandle {
  port: number;
  /** loopback URL for local use */
  url: string;
  /** re-listen on the host implied by the current settings (remote access on/off) */
  applyBinding(): Promise<void>;
  close(): void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { monitor } = opts;
  const clients = new Set<http.ServerResponse>();
  const farm = new FarmStore();
  const social = new FarmSocial(monitor.config.machineName);
  const discovery = new Discovery(monitor.config.instanceId, () => ({
    name: monitor.config.machineName,
    port: boundPort,
    announce: boundHost === '0.0.0.0',
  }));
  discovery.start();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  monitor.on('snapshot', (s) => broadcast('snapshot', s));
  monitor.on('notice', (n: Notice) => broadcast('notice', n));
  // phones and browsers that subscribed get it even with the page closed
  const push = new WebPush();
  monitor.on('notice', (n: Notice) => {
    if (monitor.config.notifications) void push.broadcast({ ...n, body: n.body.slice(0, 300), tag: n.taskId ?? n.title });
  });
  // keep proxies / sleeping laptops from silently dropping the stream
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000).unref();

  let boundPort = opts.port;
  let boundHost = '127.0.0.1';
  const limiter = new LoginLimiter();
  const tunnel = new Tunnel(() => {});
  // the tunnel gets a loopback port of its own: everything arriving there is public traffic
  let ingress: http.Server | undefined;
  let ingressPort = 0;
  const syncTunnel = async () => {
    const want = monitor.config.publicTunnel && hasRemoteAuth(monitor.config);
    if (want && !ingress) {
      const s = http.createServer((req, res) => {
        (req as unknown as Record<symbol, boolean>)[VIA_TUNNEL] = true;
        void handler(req, res);
      });
      // a fixed port (app port + 1) so settings kept outside VibePortal (Tailscale Funnel) stay valid
      const listenOn = (port: number) =>
        new Promise<void>((resolve, reject) => {
          s.once('error', reject);
          s.listen(port, '127.0.0.1', () => resolve());
        });
      await listenOn(boundPort + 1).catch(() => listenOn(0));
      ingress = s;
      const a = s.address();
      ingressPort = typeof a === 'object' && a ? a.port : 0;
    }
    tunnel.sync(want, ingressPort, monitor.config.tunnelProvider, { ngrokDomain: monitor.config.ngrokDomain, ngrokAuthtoken: monitor.config.ngrokAuthtoken });
    if (!want && ingress) {
      ingress.closeAllConnections();
      ingress.close();
      ingress = undefined;
    }
  };
  process.once('exit', () => tunnel.stop());
  const wantedHost = () => opts.host ?? (monitor.config.remoteAccess ? '0.0.0.0' : '127.0.0.1');
  const info = (req: http.IncomingMessage): ServerInfo => {
    const base = `http://127.0.0.1:${boundPort}`;
    return {
      viewerLocal: isLocalRequest(req),
      instanceId: monitor.config.instanceId,
      passwordSet: !!monitor.config.remotePassword,
      // only a connected tunnel goes into links / the QR code
      publicUrl: monitor.config.publicUrl || (tunnel.state.state === 'on' ? tunnel.state.url : undefined),
      tunnel: tunnel.state,
      version: opts.version,
      mode: opts.mode,
      hookUrl: `${base}/api/hooks/claude`,
      taskUrl: `${base}/api/tasks`,
      authRequired: true,
      machineName: monitor.config.machineName,
      boundHost,
      port: boundPort,
      lanUrls: boundHost === '0.0.0.0' ? lanAddresses().map((ip) => `http://${ip}:${boundPort}`) : [],
      discovered: discovery.list().filter((d) => !monitor.config.hosts.some((h) => sameHost(h.url, d.url))),
    };
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      if (!p.startsWith('/api/')) return serveStatic(opts.uiDir, p, res);
      if (p === '/api/health' && req.method === 'OPTIONS') {
        // preflight for the cross-device online check (it sends ngrok's skip-warning header)
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'ngrok-skip-browser-warning', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      if (p === '/api/health') {
        // readable cross-origin, so a page on one device can show whether another is online
        res.setHeader('Access-Control-Allow-Origin', '*');
        const c = monitor.config;
        return json(res, 200, {
          ok: true,
          app: 'vibeportal',
          name: c.machineName,
          auth: authMode(req, c),
          password: !!c.remotePassword,
          // the client id is public (it is in every Google sign-in page anyway)
          google: c.googleClientId && c.googleOwners.length ? c.googleClientId : undefined,
        });
      }
      if (p === '/api/login/google' && req.method === 'POST') {
        const ip = clientIp(req);
        const wait = limiter.wait(ip);
        if (wait) return json(res, 429, { error: `too many attempts — try again in ${Math.ceil(wait / 1000)} s` });
        const c = monitor.config;
        if (!c.googleClientId || !c.googleOwners.length) return json(res, 400, { error: 'Google sign-in is not set up on this machine' });
        const email = await verifyGoogleIdToken(String((await readJson(req))?.credential ?? ''), c.googleClientId).catch((e) => {
          limiter.fail(ip);
          throw e;
        });
        if (!c.googleOwners.includes(email)) {
          limiter.fail(ip);
          return json(res, 403, { error: `${email} is not allowed on this machine` });
        }
        limiter.success(ip);
        return json(res, 200, { ...issueSession(c), email });
      }
      if (p === '/api/login' && req.method === 'POST') {
        const ip = clientIp(req);
        const wait = limiter.wait(ip);
        if (wait) return json(res, 429, { error: `too many attempts — try again in ${Math.ceil(wait / 1000)} s` });
        const body = await readJson(req);
        if (!monitor.config.remotePassword) return json(res, 400, { error: 'no password is set on this machine' });
        if (!checkPassword(monitor.config, String(body?.password ?? ''))) {
          limiter.fail(ip);
          return json(res, 401, { error: 'wrong password' });
        }
        limiter.success(ip);
        return json(res, 200, issueSession(monitor.config));
      }
      // ── a public farm, through its share link (only when its owner made it public) ──
      const pub = /^\/api\/public\/farm\/([a-z0-9]{16,32})(?:\/(water|card\.svg))?$/.exec(p);
      if (pub) {
        const view = () => farm.view(monitor.current()?.providers);
        if (!pub[2] && req.method === 'GET') {
          res.setHeader('Access-Control-Allow-Origin', '*');
          const card = social.publicFor(pub[1], view);
          return card ? json(res, 200, card) : json(res, 404, { error: 'no such farm' });
        }
        if (pub[2] === 'card.svg' && req.method === 'GET') {
          const card = social.publicFor(pub[1], view);
          if (!card) return json(res, 404, { error: 'no such farm' });
          // for a GitHub profile README: GitHub's image proxy keeps a copy for a while
          res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
          return res.end(farmCardSvg(card, url.searchParams.get('lang') === 'zh' ? 'zh' : 'en'));
        }
        if (pub[2] === 'water' && req.method === 'POST') {
          return json(res, 200, social.water(pub[1], await readJson(req), clientIp(req), (m) => farm.water(m)));
        }
      }
      if (!authorized(req, url, monitor.config)) return json(res, 401, { error: 'unauthorized' });

      if (p === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        const snap = monitor.current();
        if (snap) res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/api/snapshot' && req.method === 'GET') return json(res, 200, monitor.current() ?? null);
      // ── the crab farm ──
      if (p === '/api/farm' && req.method === 'GET') return json(res, 200, farm.view(monitor.current()?.providers));
      const fm = /^\/api\/farm\/(draw|plant|harvest|uproot|store|display|discard)$/.exec(p);
      if (fm && req.method === 'POST') return json(res, 200, farm.act(fm[1], await readJson(req), monitor.current()?.providers));
      if (p === '/api/farm/social') {
        if (req.method === 'POST') social.update(await readJson(req));
        else if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        return json(res, 200, social.view(info(req).publicUrl));
      }
      if (p === '/api/farm/social/github' && req.method === 'POST') {
        const r = await importGithubProfile(String((await readJson(req))?.github ?? '')).catch((e: Error & { status?: number }) => e);
        if (r instanceof Error) return json(res, r.status ?? 502, { error: r.message });
        return json(res, 200, r);
      }
      if (p === '/api/farm/social/rotate' && req.method === 'POST') {
        social.rotate();
        return json(res, 200, social.view(info(req).publicUrl));
      }
      if (p === '/api/farm/friends') {
        if (req.method === 'POST') social.addFriend(String((await readJson(req))?.link ?? ''), social.view().shareId);
        else if (req.method === 'DELETE') social.removeFriend(String((await readJson(req))?.url ?? ''));
        else if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        return json(res, 200, await social.friends());
      }
      if (p === '/api/farm/friends/water' && req.method === 'POST') {
        return json(res, 200, await social.waterFriend(String((await readJson(req))?.url ?? ''), info(req).publicUrl));
      }
      if (p === '/api/info' && req.method === 'GET') return json(res, 200, info(req));
      if (p === '/api/refresh' && req.method === 'POST') {
        await monitor.refresh();
        return json(res, 200, monitor.current() ?? null);
      }
      if (p === '/api/settings') {
        if (req.method === 'GET') return json(res, 200, toPublic(monitor.config));
        if (req.method === 'PUT') {
          const body = await readJson(req);
          // a remote session must not be able to widen access (password, tunnel, binding)
          if (!isLocalRequest(req) && LOCAL_ONLY_FIELDS.some((k) => body && k in body)) {
            return json(res, 403, { error: 'security settings can only be changed on this machine' });
          }
          const next = applyPatch(monitor.config, body ?? {});
          const rebind = next.remoteAccess !== monitor.config.remoteAccess;
          saveConfig(next);
          monitor.setConfig(next);
          void syncTunnel();
          opts.onSettingsChanged?.();
          json(res, 200, toPublic(next));
          // after the response went out: the client reconnects on the new binding
          if (rebind) setTimeout(() => void applyBinding(), 100);
          return;
        }
      }

      // ── remote hosts ──────────────────────────────────────────────────────
      if (p === '/api/hosts' && req.method === 'POST') {
        const body = await readJson(req);
        const host = await verifyHost(String(body?.url ?? ''), String(body?.token ?? ''), body?.name);
        const cfg = monitor.config;
        const next = { ...cfg, hosts: [...cfg.hosts.filter((h) => !sameHost(h.url, host.url)), { id: newHostId(), ...host }] };
        saveConfig(next);
        monitor.setConfig(next);
        return json(res, 200, toPublic(next));
      }
      const hostDel = /^\/api\/hosts\/([\w-]+)$/.exec(p);
      if (hostDel && req.method === 'DELETE') {
        const cfg = monitor.config;
        const next = { ...cfg, hosts: cfg.hosts.filter((h) => h.id !== hostDel[1]) };
        saveConfig(next);
        monitor.setConfig(next);
        return json(res, 200, toPublic(next));
      }

      // open a repository from the analysis table — only paths VibePortal itself reported
      if (p === '/api/projects/open' && req.method === 'POST') {
        const body = await readJson(req);
        const key = typeof body?.key === 'string' ? body.key : '';
        const known = monitor.current()?.providers.some((pr) => pr.projects.some((x) => x.key === key));
        if (!known) return json(res, 404, { error: 'unknown project' });
        monitor.actions.openPath(key);
        return json(res, 200, { ok: true });
      }

      // bind the Google account that signs in here (only on the machine itself)
      if (p === '/api/google/bind' && req.method === 'POST') {
        if (!isLocalRequest(req)) return json(res, 403, { error: 'bind a Google account on the machine itself' });
        const c = monitor.config;
        if (!c.googleClientId) return json(res, 400, { error: 'enter the Google client id first' });
        const email = await verifyGoogleIdToken(String((await readJson(req))?.credential ?? ''), c.googleClientId);
        const next = { ...c, googleOwners: [...new Set([...c.googleOwners, email])] };
        saveConfig(next);
        monitor.setConfig(next);
        void syncTunnel();
        return json(res, 200, toPublic(next));
      }

      // ── new tasks ─────────────────────────────────────────────────────────
      if (p === '/api/launch/options' && req.method === 'GET') return json(res, 200, monitor.launchOptions());
      if (p === '/api/launch' && req.method === 'POST') return json(res, 200, monitor.startTask(await readJson(req)));

      // ── skills ────────────────────────────────────────────────────────────
      if (p === '/api/skills') {
        if (req.method === 'GET') return json(res, 200, monitor.skills.list(url.searchParams.has('fresh')));
        if (req.method === 'POST') return json(res, 200, monitor.skills.create((await readJson(req)) ?? {}));
      }
      const sk = /^\/api\/skills\/([0-9a-f]{12})(\/install|\/archive)?$/.exec(p);
      if (sk) {
        const id = sk[1];
        const target = url.searchParams.get('target') === 'codex' ? 'codex' : 'claude';
        if (!sk[2] && req.method === 'GET') {
          const d = monitor.skills.get(id);
          return d ? json(res, 200, d) : json(res, 404, { error: 'skill not found' });
        }
        if (!sk[2] && req.method === 'PUT') {
          monitor.skills.update(id, (await readJson(req))?.content);
          return json(res, 200, { ok: true });
        }
        if (!sk[2] && req.method === 'DELETE') {
          monitor.skills.remove(id);
          return json(res, 200, { ok: true });
        }
        if (sk[2] === '/install' && req.method === 'POST') {
          monitor.skills.install(id, target);
          return json(res, 200, { ok: true });
        }
        if (sk[2] === '/install' && req.method === 'DELETE') {
          monitor.skills.uninstall(id, target);
          return json(res, 200, { ok: true });
        }
        if (sk[2] === '/archive' && req.method === 'POST') {
          const s = monitor.skills.list().find((x) => x.id === id);
          if (!s) return json(res, 404, { error: 'skill not found' });
          const slug = monitor.skills.archive(s.dir, {});
          return slug ? json(res, 200, { slug }) : json(res, 400, { error: 'skill folder is too large to archive (max 200 files / 2 MB)' });
        }
      }

      if (p === '/api/tunnel/check' && req.method === 'GET') {
        const provider = (url.searchParams.get('provider') ?? monitor.config.tunnelProvider) as typeof monitor.config.tunnelProvider;
        if (!['ngrok', 'tailscale', 'localhost.run', 'pinggy', 'cloudflare'].includes(provider)) return json(res, 400, { error: 'unknown provider' });
        return json(res, 200, await checkProvider(provider, monitor.config));
      }

      // ── permission prompts of background runs ───────────────────────────
      // the run's MCP tool asks (only from this machine) and waits for the answer
      if (p === '/api/permissions/request' && req.method === 'POST') {
        if (!isLocalRequest(req)) return json(res, 403, { error: 'only the local permission tool may ask' });
        const body = await readJson(req);
        const job = String(body?.job ?? '');
        if (!/^dispatch-[a-z0-9]+$/.test(job)) return json(res, 400, { error: 'unknown run' });
        const d = await monitor.permissions.request(job, String(body?.tool_name ?? 'tool').slice(0, 100), body?.input ?? {});
        return json(res, 200, d);
      }
      const pm = /^\/api\/permissions\/([0-9a-f]{12})$/.exec(p);
      if (pm && req.method === 'POST') {
        const body = await readJson(req);
        const ok = monitor.permissions.answer(pm[1], body?.allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied in VibePortal.' }, !!body?.always);
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'already answered' });
      }

      // ── official remote control ──────────────────────────────────────────
      if (p === '/api/official' && req.method === 'GET') return json(res, 200, monitor.official.state());
      if (p === '/api/official/trust' && req.method === 'POST') {
        const cwd = String((await readJson(req))?.cwd ?? '');
        if (!(await monitor.official.trustClaudeFolder(cwd))) return json(res, 409, { error: 'Claude Code kept overwriting the setting — try again' });
        return json(res, 200, { ok: true });
      }
      if (p === '/api/official/claude') {
        if (req.method === 'POST') {
          const cwd = String((await readJson(req))?.cwd ?? '');
          monitor.official.startClaude(cwd, `${monitor.config.machineName} · ${path.basename(cwd)}`);
          return json(res, 200, monitor.official.state());
        }
        if (req.method === 'DELETE') {
          monitor.official.stopClaude(url.searchParams.get('cwd') ?? '');
          return json(res, 200, monitor.official.state());
        }
      }
      const oc = /^\/api\/official\/codex\/(start|stop|pair)$/.exec(p);
      if (oc && req.method === 'POST') {
        if (oc[1] === 'pair') return json(res, 200, await monitor.official.pairCodex());
        await (oc[1] === 'start' ? monitor.official.startCodex() : monitor.official.stopCodex());
        return json(res, 200, monitor.official.state());
      }

      // ── machine resources (?host=<id> asks a remote VibePortal) ──────────
      if (p === '/api/resources' && req.method === 'GET') {
        const hostId = url.searchParams.get('host');
        if (!hostId) return json(res, 200, await monitor.resources.get());
        const host = monitor.config.hosts.find((h) => h.id === hostId);
        if (!host) return json(res, 404, { error: 'unknown host' });
        const up = await fetch(new URL('api/resources', host.url.endsWith('/') ? host.url : host.url + '/'), {
          headers: { Authorization: `Bearer ${host.token}` },
          signal: AbortSignal.timeout(10_000),
        });
        res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await up.text());
      }

      if (p === '/api/push' && req.method === 'GET') {
        return json(res, 200, { publicKey: push.publicKey, subscribed: !!push.find(url.searchParams.get('endpoint') ?? ''), devices: push.count });
      }
      if (p === '/api/push/subscribe' && req.method === 'POST') {
        const body = await readJson(req);
        const err = push.subscribe(body?.subscription, typeof body?.label === 'string' ? body.label : undefined);
        return json(res, err ? 400 : 200, err ? { error: err } : { ok: true });
      }
      if (p === '/api/push/unsubscribe' && req.method === 'POST') {
        push.unsubscribe(String((await readJson(req))?.endpoint ?? ''));
        return json(res, 200, { ok: true });
      }
      if (p === '/api/push/test' && req.method === 'POST') {
        const body = await readJson(req);
        const sub = push.find(String(body?.endpoint ?? ''));
        if (!sub) return json(res, 400, { error: 'this browser is not subscribed' });
        const text = typeof body.body === 'string' ? body.body.slice(0, 200) : 'Notifications reach this device.';
        await push.send(sub, { title: '🔔 VibePortal', body: text, tag: 'vp-test' }).catch((e) => {
          throw Object.assign(e as Error, { status: 502 });
        });
        return json(res, 200, { ok: true });
      }
      if (p === '/api/hooks/claude' && req.method === 'POST') {
        const body = await readJson(req);
        const ok = monitor.tasks.ingestClaudeHook(body);
        if (ok) monitor.poke();
        return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'expected a Claude Code hook payload' });
      }
      if (p === '/api/hooks/snippet' && req.method === 'GET') {
        return json(res, 200, hookSnippet(info(req).hookUrl, monitor.config.apiToken));
      }
      if (p === '/api/tasks') {
        if (req.method === 'GET') return json(res, 200, monitor.current()?.tasks ?? []);
        if (req.method === 'POST') {
          const r = monitor.tasks.upsertCustom(await readJson(req));
          if (typeof r === 'string') return json(res, 400, { error: r });
          monitor.poke();
          return json(res, 200, r);
        }
      }

      // ── archive: put inactive conversations away / bring them back ──
      if (p === '/api/tasks-archive' && req.method === 'POST') {
        const body = (await readJson(req)) as { ids?: unknown; restore?: unknown };
        const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : undefined;
        const tasks = monitor.current()?.tasks ?? [];
        const n = body?.restore ? monitor.archive.restore(ids) : monitor.archive.archive(ids ? tasks.filter((x) => ids.includes(x.id)) : tasks);
        monitor.poke();
        return json(res, 200, { ok: true, n });
      }

      // ── task actions: /api/tasks/<id>[/context|/suggest|/continue|/open] ──
      const tm = /^\/api\/tasks\/([^/]+)(?:\/(context|history|suggest|continue|queue|open|vscode))?$/.exec(p);
      if (tm) {
        const id = decodeURIComponent(tm[1]);
        const action = tm[2];
        const remote = parseRemoteTaskId(id);
        if (remote) return proxyRemote(req, res, remote, action);
        if (!action && req.method === 'DELETE') {
          const ok = monitor.tasks.removeCustom(id);
          monitor.poke();
          return json(res, ok ? 200 : 404, { ok });
        }
        const task = monitor.findTask(id);
        if (!task) return json(res, 404, { error: 'task not found' });
        if (action === 'context' && req.method === 'GET') return json(res, 200, monitor.taskContext(task));
        if (action === 'history' && req.method === 'GET') return json(res, 200, monitor.taskHistory(task));
        if (action === 'suggest' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 200, { suggestions: await monitor.suggest(task, body?.lang === 'en' ? 'en' : 'zh') });
        }
        if (action === 'continue' && req.method === 'POST') {
          const body = await readJson(req);
          const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
          if (!prompt) return json(res, 400, { error: 'prompt is required' });
          const run = cleanRunOptions(task.kind === 'codex' || (task.kind === 'dispatch' && task.provider === 'openai') ? 'codex' : 'claude', body);
          return json(res, 200, monitor.continueTask(task, prompt.slice(0, 20_000), run));
        }
        if (action === 'queue' && req.method === 'DELETE') {
          monitor.clearQueue(task);
          return json(res, 200, { ok: true });
        }
        if (action === 'vscode' && req.method === 'POST') {
          const body = await readJson(req);
          monitor.openInVscode(task, typeof body?.prompt === 'string' ? body.prompt.trim() : undefined);
          return json(res, 200, { ok: true });
        }
        if (action === 'open' && req.method === 'POST') {
          monitor.actions.open(task);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return json(res, status, { error: (e as Error).message, code: (e as { code?: unknown }).code });
    }
  };

  /** Forwards a task action to the VibePortal instance that owns the task. */
  async function proxyRemote(req: http.IncomingMessage, res: http.ServerResponse, r: { hostId: string; taskId: string }, action?: string) {
    const host = monitor.config.hosts.find((h) => h.id === r.hostId);
    if (!host) return json(res, 404, { error: 'unknown host' });
    const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : JSON.stringify((await readJson(req)) ?? {});
    const target = new URL(`api/tasks/${encodeURIComponent(r.taskId)}${action ? '/' + action : ''}`, host.url.endsWith('/') ? host.url : host.url + '/');
    const up = await fetch(target, {
      method: req.method,
      headers: { Authorization: `Bearer ${host.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body,
      signal: AbortSignal.timeout(action === 'suggest' ? 150_000 : 15_000),
    });
    res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await up.text());
  }

  let server: http.Server | undefined;
  const listen = (host: string, port: number) =>
    new Promise<http.Server>((resolve, reject) => {
      const s = http.createServer(handler);
      s.once('error', reject);
      s.listen(port, host, () => {
        s.off('error', reject);
        resolve(s);
      });
    });

  async function applyBinding() {
    const host = wantedHost();
    if (server && host === boundHost) return;
    const old = server;
    if (old) {
      // SSE clients reconnect by themselves
      old.closeAllConnections();
      await new Promise<void>((r) => old.close(() => r()));
      clients.clear();
    }
    try {
      server = await listen(host, boundPort);
      boundHost = host;
    } catch (e) {
      if (old) {
        // couldn't take the new binding — go back to the old one
        server = await listen(boundHost, boundPort);
      } else throw e;
    }
  }

  // first bind: allow a fallback to a random port when ours is taken
  const host = wantedHost();
  try {
    server = await listen(host, opts.port);
  } catch (e) {
    if (opts.mode !== 'desktop') throw e;
    console.warn(`[vibeportal] port ${opts.port} unavailable (${(e as Error).message}); using a random port`);
    server = await listen(host, 0);
  }
  boundHost = host;
  const addr = server.address();
  boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  monitor.setPermissionEndpoint(`http://127.0.0.1:${boundPort}`, monitor.config.apiToken);
  await syncTunnel();

  return {
    get port() {
      return boundPort;
    },
    url: `http://127.0.0.1:${boundPort}`,
    applyBinding,
    close() {
      monitor.official.stopAll();
      tunnel.stop();
      ingress?.close();
      discovery.stop();
      server?.closeAllConnections();
      server?.close();
    },
  };
}

/** Checks a remote VibePortal (url + token) before saving it. */
async function verifyHost(rawUrl: string, token: string, name?: unknown) {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('invalid URL'), { status: 400 });
  }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('URL must be http(s)'), { status: 400 });
  // a pasted "connection link" carries the token in ?token=
  const t = token || u.searchParams.get('token') || '';
  if (!t) throw Object.assign(new Error('token is required'), { status: 400 });
  const base = `${u.protocol}//${u.host}${u.pathname.replace(/\/?$/, '/')}`;
  let remoteName = '';
  try {
    const r = await fetch(new URL('api/info', base), { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(6000) });
    if (r.status === 401) throw Object.assign(new Error('token rejected by remote'), { status: 400 });
    if (!r.ok) throw Object.assign(new Error(`remote answered HTTP ${r.status}`), { status: 502 });
    remoteName = ((await r.json()) as ServerInfo).machineName ?? '';
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    throw Object.assign(new Error(`cannot reach ${base}: ${(e as Error).message}`), { status: 502 });
  }
  return { url: base, token: t, name: (typeof name === 'string' && name.trim()) || remoteName || u.hostname };
}

const sameHost = (a: string, b: string) => {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1 << 20) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const base = path.resolve(root);
  let file = path.resolve(base, rel || 'index.html');
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // SPA fallback
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('UI not built — run `npm run build:ui`');
      return;
    }
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

/** settings.json fragment that forwards Claude Code hook events to VibePortal. */
export function hookSnippet(hookUrl: string, token: string) {
  // curl ships with Windows 10+; NUL / double quotes work from both cmd and Git Bash there
  const command =
    process.platform === 'win32'
      ? `curl -s -m 2 -o NUL -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${token}" --data-binary @- ${hookUrl}`
      : `curl -s -m 2 -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' --data-binary @- ${hookUrl} >/dev/null 2>&1 || true`;
  const entry = [{ hooks: [{ type: 'command', command }] }];
  const events = ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionStart', 'SessionEnd'];
  return { hooks: Object.fromEntries(events.map((e) => [e, entry])) };
}
