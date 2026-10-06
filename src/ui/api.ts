import { useEffect, useRef, useState } from 'react';
import { demoCall, demoSnapshot, isDemo } from './demo';
import type { FarmView } from '../shared/farm';
import type { FarmProfile, FarmSocialView, FriendFarm } from '../shared/farmSocial';
import type { LaunchOptions, LaunchRequest, OfficialRemoteState, TaskHistory, PublicSettings, ResourceSnapshot, ServerInfo, SettingsPatch, SkillDetail, SkillInfo, Snapshot, TaskContext } from '../shared/types';

export interface Notice {
  title: string;
  body: string;
  level: 'info' | 'warning' | 'critical';
  taskId?: string;
}

/** What a tunnel relay still needs (Settings → Remote checklist). */
export interface TunnelCheck {
  installed: boolean;
  version?: string;
  token?: 'ngrok-config' | 'vibeportal' | 'none';
  loggedIn?: boolean;
}

/** Model / effort the user picked for a task's next instruction (per browser). */
export interface RunOverride {
  model?: string;
  effort?: string;
}
const RUN_KEY = 'vp.runOverrides';
export function runOverride(taskId: string): RunOverride {
  try {
    return JSON.parse(localStorage.getItem(RUN_KEY) ?? '{}')[taskId] ?? {};
  } catch {
    return {};
  }
}
export function setRunOverride(taskId: string, o: RunOverride) {
  try {
    const all = JSON.parse(localStorage.getItem(RUN_KEY) ?? '{}');
    if (o.model || o.effort) all[taskId] = o;
    else delete all[taskId];
    const entries = Object.entries(all).slice(-100);
    localStorage.setItem(RUN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
}

let launchCache: Promise<LaunchOptions> | undefined;
let launchCacheAt = 0;
/** Launch options change rarely (projects, installed CLIs): share one fetch for a minute. */
export function cachedLaunchOptions(): Promise<LaunchOptions> {
  if (!launchCache || Date.now() - launchCacheAt > 60_000) {
    launchCacheAt = Date.now();
    launchCache = api.launchOptions().catch((e) => {
      launchCache = undefined;
      throw e;
    });
  }
  return launchCache;
}

/** Tasks the user dismissed from the pet's "what next?" prompt (per browser). */
const DISMISS_KEY = 'vp.dismissed';
export function dismissedTasks(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
/** Remembers which finish/update we dismissed, so a later finish prompts again. */
export function dismissTask(id: string, stamp: string) {
  try {
    const d = dismissedTasks();
    d[id] = stamp;
    const entries = Object.entries(d).slice(-200);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
}

interface DesktopBridge {
  desktop: true;
  platform: string;
  openDashboard(): void;
  hidePet(): void;
  petMenu(): void;
  getPetPos(): Promise<[number, number]>;
  setPetPos(x: number, y: number): void;
  petDragEnd(): void;
  petResize(width: number, height: number): void;
}

declare global {
  interface Window {
    vibeportal?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.vibeportal;

const TOKEN_KEY = 'vp.token';

function store(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Picks the API token up from ?token=… once, then keeps it out of the address bar. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try {
      store()?.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode */
    }
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    memToken = fromUrl;
    return fromUrl;
  }
  try {
    memToken = store()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    memToken = null;
  }
  return memToken;
}

let memToken: string | null = null;
export const getToken = () => memToken;
export function setToken(t: string) {
  memToken = t;
  try {
    store()?.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

export class AuthError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (isDemo()) return demoCall(method, path, body) as T;
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${memToken ?? ''}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('unauthorized');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // keep the server's reason code (e.g. "untrusted") next to the message
    throw Object.assign(new Error(err?.error ?? `HTTP ${res.status}`), { code: err?.code });
  }
  return res.json();
}

/** Unauthenticated calls: how this server wants us to sign in, and the password login. */
export const auth = {
  mode: async (): Promise<'password' | 'token'> => (await auth.health()).auth,
  /** how this server wants us to sign in: token / password, and Google when it is set up */
  health: async (): Promise<{ auth: 'password' | 'token'; password: boolean; google?: string; name?: string }> => {
    try {
      const r = await (await fetch('api/health')).json();
      return { auth: r.auth ?? 'token', password: r.password ?? r.auth === 'password', google: r.google, name: r.name };
    } catch {
      return { auth: 'token', password: false };
    }
  },
  loginGoogle: async (credential: string): Promise<{ token: string; email: string }> => {
    const res = await fetch('api/login/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  },
  login: async (password: string): Promise<{ token: string; expiresAt: string }> => {
    const res = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  },
};

export const api = {
  snapshot: () => call<Snapshot | null>('GET', 'api/snapshot'),
  refresh: () => call<Snapshot | null>('POST', 'api/refresh'),
  info: () => call<ServerInfo>('GET', 'api/info'),
  settings: () => call<PublicSettings>('GET', 'api/settings'),
  saveSettings: (p: SettingsPatch) => call<PublicSettings>('PUT', 'api/settings', p),
  hookSnippet: () => call<unknown>('GET', 'api/hooks/snippet'),
  deleteTask: (id: string) => call<{ ok: boolean }>('DELETE', `api/tasks/${encodeURIComponent(id)}`),
  taskHistory: (id: string) => call<TaskHistory>('GET', `api/tasks/${encodeURIComponent(id)}/history`),
  answerPermission: (id: string, allow: boolean, always = false) => call<{ ok: boolean }>('POST', `api/permissions/${id}`, { allow, always }),
  taskContext: (id: string) => call<TaskContext>('GET', `api/tasks/${encodeURIComponent(id)}/context`),
  suggest: (id: string, lang: string) => call<{ suggestions: string[] }>('POST', `api/tasks/${encodeURIComponent(id)}/suggest`, { lang }),
  continueTask: (id: string, prompt: string, run: RunOverride = {}) => call<{ jobId: string; queued?: boolean }>('POST', `api/tasks/${encodeURIComponent(id)}/continue`, { prompt, ...run }),
  farm: () => call<FarmView>('GET', 'api/farm'),
  farmAct: <R = unknown>(action: 'draw' | 'plant' | 'harvest' | 'uproot' | 'discard', body: Record<string, unknown>) => call<{ farm: FarmView; result?: R }>('POST', `api/farm/${action}`, body),
  clearQueue: (id: string) => call<{ ok: boolean }>('DELETE', `api/tasks/${encodeURIComponent(id)}/queue`),
  farmSocial: () => call<FarmSocialView>('GET', 'api/farm/social'),
  farmSocialUpdate: (body: { profile?: FarmProfile; public?: boolean }) => call<FarmSocialView>('POST', 'api/farm/social', body),
  farmSocialRotate: () => call<FarmSocialView>('POST', 'api/farm/social/rotate', {}),
  farmFriends: () => call<FriendFarm[]>('GET', 'api/farm/friends'),
  farmFriendAdd: (link: string) => call<FriendFarm[]>('POST', 'api/farm/friends', { link }),
  farmFriendRemove: (url: string) => call<FriendFarm[]>('DELETE', 'api/farm/friends', { url }),
  farmFriendWater: (url: string) => call<{ friend: FriendFarm; result: unknown }>('POST', 'api/farm/friends/water', { url }),
  launchOptions: () => call<LaunchOptions>('GET', 'api/launch/options'),
  launch: (r: LaunchRequest) => call<{ jobId: string; taskId: string }>('POST', 'api/launch', r),
  skills: (fresh = false) => call<SkillInfo[]>('GET', `api/skills${fresh ? '?fresh=1' : ''}`),
  skill: (id: string) => call<SkillDetail>('GET', `api/skills/${id}`),
  createSkill: (s: { name: string; description: string; body: string }) => call<SkillInfo>('POST', 'api/skills', s),
  updateSkill: (id: string, content: string) => call<{ ok: boolean }>('PUT', `api/skills/${id}`, { content }),
  deleteSkill: (id: string) => call<{ ok: boolean }>('DELETE', `api/skills/${id}`),
  installSkill: (id: string, target: 'claude' | 'codex', on: boolean) => call<{ ok: boolean }>(on ? 'POST' : 'DELETE', `api/skills/${id}/install?target=${target}`, on ? {} : undefined),
  archiveSkill: (id: string) => call<{ slug: string }>('POST', `api/skills/${id}/archive`, {}),
  googleBind: (credential: string) => call<PublicSettings>('POST', 'api/google/bind', { credential }),
  tunnelCheck: (provider: string) => call<TunnelCheck>('GET', `api/tunnel/check?provider=${encodeURIComponent(provider)}`),
  resources: (host?: string) => call<ResourceSnapshot>('GET', `api/resources${host ? `?host=${encodeURIComponent(host)}` : ''}`),
  openInVscode: (id: string, prompt?: string) => call<{ ok: boolean }>('POST', `api/tasks/${encodeURIComponent(id)}/vscode`, { prompt }),
  official: () => call<OfficialRemoteState>('GET', 'api/official'),
  trustClaudeFolder: (cwd: string) => call<{ ok: boolean }>('POST', 'api/official/trust', { cwd }),
  startClaudeRemote: (cwd: string) => call<OfficialRemoteState>('POST', 'api/official/claude', { cwd }),
  stopClaudeRemote: (cwd: string) => call<OfficialRemoteState>('DELETE', `api/official/claude?cwd=${encodeURIComponent(cwd)}`),
  codexRemote: (action: 'start' | 'stop') => call<OfficialRemoteState>('POST', `api/official/codex/${action}`, {}),
  codexPair: () => call<{ code: string; expiresAt: string }>('POST', 'api/official/codex/pair', {}),
  openTask: (id: string) => call<{ ok: boolean }>('POST', `api/tasks/${encodeURIComponent(id)}/open`, {}),
  openProject: (key: string) => call<{ ok: boolean }>('POST', 'api/projects/open', { key }),
  addHost: (url: string, token: string) => call<PublicSettings>('POST', 'api/hosts', { url, token }),
  removeHost: (id: string) => call<PublicSettings>('DELETE', `api/hosts/${encodeURIComponent(id)}`),
  push: (endpoint?: string) => call<{ publicKey: string; subscribed: boolean; devices: number }>('GET', `api/push${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`),
  pushSubscribe: (subscription: PushSubscriptionJSON, label: string) => call<{ ok: boolean }>('POST', 'api/push/subscribe', { subscription, label }),
  pushUnsubscribe: (endpoint: string) => call<{ ok: boolean }>('POST', 'api/push/unsubscribe', { endpoint }),
  pushTest: (endpoint: string, body: string) => call<{ ok: boolean }>('POST', 'api/push/test', { endpoint, body }),
};

export type LiveState = { snapshot: Snapshot | null; connected: boolean; authFailed: boolean };

/** Live snapshot over Server-Sent Events, with a polling fallback. */
export function useLive(onNotice?: (n: Notice) => void): LiveState {
  const [state, setState] = useState<LiveState>({ snapshot: null, connected: false, authFailed: false });
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  useEffect(() => {
    if (isDemo()) {
      setState({ snapshot: demoSnapshot(), connected: true, authFailed: false });
      return;
    }
    let es: EventSource | null = null;
    let closed = false;
    let retry: number | undefined;

    const open = () => {
      if (closed) return;
      es = new EventSource(`api/events?token=${encodeURIComponent(memToken ?? '')}`);
      es.addEventListener('snapshot', (e) => {
        const snapshot = JSON.parse((e as MessageEvent).data) as Snapshot;
        setState({ snapshot, connected: true, authFailed: false });
      });
      es.addEventListener('notice', (e) => noticeRef.current?.(JSON.parse((e as MessageEvent).data)));
      es.onopen = () => setState((s) => ({ ...s, connected: true }));
      es.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        es?.close();
        // EventSource hides the status code: probe once to tell auth failures from outages
        api
          .snapshot()
          .then((snapshot) => setState({ snapshot, connected: false, authFailed: false }))
          .catch((err) => setState((s) => ({ ...s, authFailed: err instanceof AuthError })))
          .finally(() => {
            retry = window.setTimeout(open, 4000);
          });
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
      window.clearTimeout(retry);
    };
  }, []);

  return state;
}
