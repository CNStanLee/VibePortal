import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ClaudePet, CodexPet, PetCharacter, PublicSettings, RemoteHostConfig, SettingsPatch, TunnelProvider } from '../shared/types';

export interface Config {
  claudeDir: string;
  codexDir: string;
  historyDays: number;
  pollSeconds: number;
  subscriptionPollSeconds: number;
  warnPercent: number;
  criticalPercent: number;
  notifications: boolean;
  pet: { enabled: boolean; size: number; character: PetCharacter; claudePet: ClaudePet; codexPet: CodexPet };
  /** model alias passed to `claude -p --model` for next-step suggestions */
  suggestModel: string;
  /** explicit CLI paths when they are not on PATH (e.g. GUI launch without a login shell) */
  claudeBin: string;
  codexBin: string;
  /** extra/override prices in USD per million tokens, keyed by model id prefix */
  prices: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>;
  anthropicAdminKey: string;
  openaiAdminKey: string;
  launchAtLogin: boolean;
  /** Bearer token required by the HTTP API (except from localhost in desktop mode). */
  apiToken: string;
  port: number;
  remoteAccess: boolean;
  machineName: string;
  /** stable id used for LAN discovery */
  instanceId: string;
  hosts: RemoteHostConfig[];
  /** scrypt hash of the remote-access password (null = none) */
  remotePassword: { salt: string; hash: string } | null;
  /** signs login sessions; rotated whenever the password changes, which signs everyone out */
  sessionSecret: string;
  publicTunnel: boolean;
  tunnelProvider: TunnelProvider;
  ngrokDomain: string;
  ngrokAuthtoken: string;
  publicUrl: string;
  googleClientId: string;
  googleOwners: string[];
}

export function dataDir(): string {
  return process.env.VIBEPORTAL_HOME || path.join(os.homedir(), '.vibeportal');
}

const configPath = () => path.join(dataDir(), 'config.json');

function defaults(): Config {
  const home = os.homedir();
  return {
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    codexDir: process.env.CODEX_HOME || path.join(home, '.codex'),
    historyDays: 30,
    pollSeconds: 15,
    subscriptionPollSeconds: 300,
    warnPercent: 75,
    criticalPercent: 90,
    notifications: true,
    pet: { enabled: true, size: 140, character: 'duo', claudePet: 'crab', codexPet: 'bot' },
    suggestModel: 'haiku',
    claudeBin: '',
    codexBin: '',
    prices: {},
    anthropicAdminKey: process.env.ANTHROPIC_ADMIN_KEY || '',
    openaiAdminKey: process.env.OPENAI_ADMIN_KEY || '',
    launchAtLogin: false,
    apiToken: crypto.randomBytes(18).toString('base64url'),
    port: 8787,
    remoteAccess: false,
    machineName: os.hostname(),
    instanceId: crypto.randomBytes(6).toString('hex'),
    hosts: [],
    remotePassword: null,
    sessionSecret: crypto.randomBytes(32).toString('base64url'),
    publicTunnel: false,
    // needs only the ssh client, and gets out over port 22 where Cloudflare's 7844 is often blocked
    tunnelProvider: 'localhost.run',
    ngrokDomain: '',
    ngrokAuthtoken: '',
    publicUrl: '',
    googleClientId: '',
    googleOwners: [],
  };
}

export function loadConfig(): Config {
  const base = defaults();
  let cfg = base;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    cfg = { ...base, ...raw, pet: { ...base.pet, ...(raw.pet || {}) } };
    cfg.pet = migratePet(cfg.pet as unknown as Record<string, unknown>);
    // keep the new secret stable across restarts, or every login would expire on restart
    if (!raw.sessionSecret) saveConfig(cfg);
  } catch {
    // first run: persist so the generated API token stays stable
    saveConfig(cfg);
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function toPublic(cfg: Config): PublicSettings {
  return {
    claudeDir: cfg.claudeDir,
    codexDir: cfg.codexDir,
    historyDays: cfg.historyDays,
    pollSeconds: cfg.pollSeconds,
    subscriptionPollSeconds: cfg.subscriptionPollSeconds,
    warnPercent: cfg.warnPercent,
    criticalPercent: cfg.criticalPercent,
    notifications: cfg.notifications,
    pet: { ...cfg.pet },
    suggestModel: cfg.suggestModel,
    anthropicAdminKeySet: !!cfg.anthropicAdminKey,
    openaiAdminKeySet: !!cfg.openaiAdminKey,
    launchAtLogin: cfg.launchAtLogin,
    remoteAccess: cfg.remoteAccess,
    machineName: cfg.machineName,
    hosts: cfg.hosts.map(({ id, name, url }) => ({ id, name, url })),
    passwordSet: !!cfg.remotePassword,
    publicTunnel: cfg.publicTunnel,
    tunnelProvider: cfg.tunnelProvider,
    ngrokDomain: cfg.ngrokDomain,
    ngrokAuthtokenSet: !!cfg.ngrokAuthtoken,
    publicUrl: cfg.publicUrl,
    googleClientId: cfg.googleClientId,
    googleOwners: [...cfg.googleOwners],
  };
}

/** Fields only a request from this machine may change. */
export const LOCAL_ONLY_FIELDS = ['remotePassword', 'publicTunnel', 'tunnelProvider', 'ngrokDomain', 'ngrokAuthtoken', 'publicUrl', 'remoteAccess', 'googleClientId', 'googleOwners'] as const;

/** Remote viewers can sign in: a password, or a bound Google account. */
export const hasRemoteAuth = (cfg: Config) => !!cfg.remotePassword || (!!cfg.googleClientId && cfg.googleOwners.length > 0);

export function hashPassword(pw: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('base64url');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('base64url') };
}

export function checkPassword(cfg: Config, pw: string): boolean {
  const p = cfg.remotePassword;
  if (!p || typeof pw !== 'string' || pw.length > 256) return false;
  const a = crypto.scryptSync(pw, p.salt, 32);
  const b = Buffer.from(p.hash, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

export function applyPatch(cfg: Config, p: SettingsPatch): Config {
  const next: Config = { ...cfg, pet: { ...cfg.pet } };
  if (typeof p.claudeDir === 'string' && p.claudeDir.trim()) next.claudeDir = p.claudeDir.trim();
  if (typeof p.codexDir === 'string' && p.codexDir.trim()) next.codexDir = p.codexDir.trim();
  next.historyDays = clamp(p.historyDays, 1, 365, cfg.historyDays);
  next.pollSeconds = clamp(p.pollSeconds, 5, 600, cfg.pollSeconds);
  // the subscription endpoint is shared with Claude Code itself — don't hammer it
  next.subscriptionPollSeconds = clamp(p.subscriptionPollSeconds, 60, 3600, cfg.subscriptionPollSeconds);
  next.warnPercent = clamp(p.warnPercent, 1, 100, cfg.warnPercent);
  next.criticalPercent = clamp(p.criticalPercent, 1, 100, cfg.criticalPercent);
  if (typeof p.notifications === 'boolean') next.notifications = p.notifications;
  if (typeof p.launchAtLogin === 'boolean') next.launchAtLogin = p.launchAtLogin;
  if (typeof p.remoteAccess === 'boolean') next.remoteAccess = p.remoteAccess;
  if (typeof p.machineName === 'string' && p.machineName.trim()) next.machineName = p.machineName.trim().slice(0, 64);
  if (p.pet) {
    if (typeof p.pet.enabled === 'boolean') next.pet.enabled = p.pet.enabled;
    next.pet.size = clamp(p.pet.size, 80, 320, cfg.pet.size);
    if (isCharacter(p.pet.character)) next.pet.character = p.pet.character;
    if (p.pet.claudePet === 'crab' || p.pet.claudePet === 'frog') next.pet.claudePet = p.pet.claudePet;
    if (p.pet.codexPet === 'bot' || p.pet.codexPet === 'whale' || p.pet.codexPet === 'frog') next.pet.codexPet = p.pet.codexPet;
  }
  if (typeof p.suggestModel === 'string' && /^[\w.:-]{1,64}$/.test(p.suggestModel.trim())) next.suggestModel = p.suggestModel.trim();
  if (typeof p.remotePassword === 'string') {
    if (p.remotePassword === '') {
      next.remotePassword = null; // the tunnel stays only if a Google account still guards it (checked below)
    } else {
      if (p.remotePassword.length < 8) throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
      next.remotePassword = hashPassword(p.remotePassword);
    }
    next.sessionSecret = crypto.randomBytes(32).toString('base64url');
  }
  if (typeof p.publicTunnel === 'boolean') {
    if (p.publicTunnel && !hasRemoteAuth(next)) throw Object.assign(new Error('set a password or bind a Google account before enabling public access'), { status: 400 });
    next.publicTunnel = p.publicTunnel;
  }
  if (['ngrok', 'tailscale', 'localhost.run', 'pinggy', 'cloudflare'].includes(p.tunnelProvider as string)) next.tunnelProvider = p.tunnelProvider!;
  if (typeof p.ngrokDomain === 'string') {
    const d = p.ngrokDomain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
    if (d && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw Object.assign(new Error('ngrok domain must look like name.ngrok-free.app'), { status: 400 });
    next.ngrokDomain = d;
  }
  if (typeof p.ngrokAuthtoken === 'string') {
    const t = p.ngrokAuthtoken.trim();
    if (t && !/^[\w-]{20,200}$/.test(t)) throw Object.assign(new Error('that does not look like an ngrok authtoken'), { status: 400 });
    next.ngrokAuthtoken = t;
  }
  if (typeof p.publicUrl === 'string') {
    const u = p.publicUrl.trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(u)) throw Object.assign(new Error('public URL must look like https://host[/path]'), { status: 400 });
    if (u && !hasRemoteAuth(next)) throw Object.assign(new Error('set a password or bind a Google account before adding a public address'), { status: 400 });
    next.publicUrl = u;
  }
  if (typeof p.googleClientId === 'string') {
    const id = p.googleClientId.trim();
    if (id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw Object.assign(new Error('a Google client id ends in .apps.googleusercontent.com'), { status: 400 });
    if (id !== next.googleClientId) next.sessionSecret = crypto.randomBytes(32).toString('base64url');
    next.googleClientId = id;
  }
  // accounts are added only through a verified Google sign-in (POST /api/google/bind); a patch can remove them
  if (Array.isArray(p.googleOwners)) {
    const keep = next.googleOwners.filter((e) => (p.googleOwners as unknown[]).includes(e));
    if (keep.length !== next.googleOwners.length) next.sessionSecret = crypto.randomBytes(32).toString('base64url');
    next.googleOwners = keep;
  }
  if (!hasRemoteAuth(next)) next.publicTunnel = false;
  if (typeof p.anthropicAdminKey === 'string') next.anthropicAdminKey = p.anthropicAdminKey.trim();
  if (typeof p.openaiAdminKey === 'string') next.openaiAdminKey = p.openaiAdminKey.trim();
  return next;
}

const isCharacter = (c: unknown): c is PetCharacter => c === 'duo' || c === 'claude' || c === 'codex';

/** Older configs used character 'blob' | 'cat' | 'crab' | 'whale'. */
function migratePet(pet: Record<string, unknown>): Config['pet'] {
  const old = pet.character;
  const character: PetCharacter = isCharacter(old) ? old : old === 'crab' ? 'claude' : old === 'whale' ? 'codex' : 'duo';
  const codexPet: CodexPet = pet.codexPet === 'frog' ? 'frog' : pet.codexPet === 'whale' || old === 'whale' ? 'whale' : 'bot';
  return {
    enabled: pet.enabled !== false,
    size: typeof pet.size === 'number' ? pet.size : 140,
    character,
    claudePet: pet.claudePet === 'frog' ? 'frog' : 'crab',
    codexPet,
  };
}
