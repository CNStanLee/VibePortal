import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBin, spawnCli } from './actions';

/** One model an agent can be started with, and the reasoning efforts it takes (when known). */
export interface CatalogModel {
  id: string;
  efforts?: string[];
}

export interface AgentCatalog {
  models: CatalogModel[];
  fetchedAt: string;
  /** Codex lists depend on the client: the version of the installed CLI that was asked for */
  cliVersion?: string;
}

type Catalogs = Partial<Record<'claude' | 'codex', AgentCatalog>>;

const REFRESH_MS = 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const byEffort = (a: string, b: string) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b);

/** Codex's `/models` reply: the models listed in its picker, in its order. */
export function parseCodexModels(body: unknown): CatalogModel[] {
  const raw = (body as { models?: unknown })?.models;
  if (!Array.isArray(raw)) throw new Error('unexpected Codex model list');
  return raw
    .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list')
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => ({
      id: m.slug as string,
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as { effort?: unknown }[]).map((l) => l?.effort).filter((e): e is string => typeof e === 'string')
        : undefined,
    }));
}

/** Anthropic's `/v1/models` reply (newest first): ids and the effort levels each supports. */
export function parseClaudeModels(body: unknown): CatalogModel[] {
  const raw = (body as { data?: unknown })?.data;
  if (!Array.isArray(raw)) throw new Error('unexpected Claude model list');
  return raw
    .filter((m) => m && typeof m.id === 'string' && m.id.startsWith('claude-'))
    .map((m) => {
      const effort = m.capabilities?.effort;
      const efforts = effort?.supported ? Object.keys(effort).filter((k) => k !== 'supported' && effort[k]?.supported).sort(byEffort) : undefined;
      return { id: m.id as string, efforts: efforts?.length ? efforts : undefined };
    });
}

/** All efforts any listed model takes, in order (undefined when the list says nothing about them). */
export function catalogEfforts(c: AgentCatalog | undefined): string[] | undefined {
  const all = new Set(c?.models.flatMap((m) => m.efforts ?? []));
  return all.size ? [...all].sort(byEffort) : undefined;
}

/**
 * The models each agent can actually be started with, refreshed every hour from the
 * providers (with this machine's logins, read-only) and kept on disk between restarts.
 * Codex is asked with the installed CLI's version: models it is too old for are left out.
 */
export class ModelCatalog {
  private data: Catalogs = {};
  private lastTry = 0;
  private busy = false;

  constructor(private file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
    } catch {
      /* first run */
    }
  }

  get(agent: 'claude' | 'codex'): AgentCatalog | undefined {
    return this.data[agent];
  }

  /** Call often; it only goes out once an hour (or right away with `force`). */
  async refresh(cfg: { claudeDir: string; codexDir: string; codexBin: string }, force = false) {
    if (this.busy || (!force && Date.now() - this.lastTry < REFRESH_MS)) return;
    this.busy = true;
    this.lastTry = Date.now();
    try {
      const [claude, codex] = await Promise.allSettled([fetchClaude(cfg.claudeDir), fetchCodex(cfg.codexDir, cfg.codexBin)]);
      // a failed fetch keeps the last good list
      if (claude.status === 'fulfilled' && claude.value.models.length) this.data.claude = claude.value;
      if (codex.status === 'fulfilled' && codex.value.models.length) this.data.codex = codex.value;
      // offline or signed out: try again in a few minutes rather than in an hour
      if (claude.status === 'rejected' || codex.status === 'rejected') this.lastTry = Date.now() - REFRESH_MS + RETRY_MS;
      if (claude.status === 'fulfilled' || codex.status === 'fulfilled') {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
      }
    } catch {
      /* best effort */
    } finally {
      this.busy = false;
    }
  }
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers: { ...headers, 'User-Agent': 'vibeportal' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} → HTTP ${res.status}`);
  return res.json();
}

async function fetchClaude(claudeDir: string): Promise<AgentCatalog> {
  const token = JSON.parse(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8'))?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('no Claude login');
  const body = await getJson('https://api.anthropic.com/v1/models?limit=100', {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  });
  return { models: parseClaudeModels(body), fetchedAt: new Date().toISOString() };
}

async function fetchCodex(codexDir: string, codexBin: string): Promise<AgentCatalog> {
  const tokens = JSON.parse(fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8'))?.tokens;
  if (!tokens?.access_token) throw new Error('no Codex login');
  const bin = resolveBin('codex', codexBin);
  const cliVersion = bin ? await versionOf(bin) : undefined;
  if (!cliVersion) throw new Error('Codex CLI version unknown');
  const body = await getJson(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(cliVersion)}`, {
    Authorization: `Bearer ${tokens.access_token}`,
    'ChatGPT-Account-Id': tokens.account_id ?? '',
    Accept: 'application/json',
  });
  return { models: parseCodexModels(body), fetchedAt: new Date().toISOString(), cliVersion };
}

/** "codex-cli 0.157.1" → "0.157.1" */
function versionOf(bin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawnCli(bin, ['--version'], { cwd: os.homedir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout?.on('data', (b) => (out += b));
    child.on('error', () => resolve(undefined));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(/\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0]);
    });
  });
}
