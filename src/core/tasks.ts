import fs from 'node:fs';
import path from 'node:path';
import type { TaskInfo, TaskState } from '../shared/types';
import type { ActivityLog } from './activity';

interface HookObs {
  sessionId: string;
  ts: number;
  state: TaskState;
  detail?: string;
  cwd?: string;
  ended?: boolean;
}

const TASK_STATES: TaskState[] = ['running', 'waiting', 'idle', 'done', 'failed'];

/**
 * Tracks Claude Code sessions (from ~/.claude/sessions/<pid>.json plus optional
 * hook events) and arbitrary user tasks pushed through the HTTP API.
 */
export class TaskTracker {
  private hooks = new Map<string, HookObs>();
  private custom = new Map<string, TaskInfo>();

  /** Ingests a Claude Code hook payload (the JSON Claude Code writes to the hook's stdin). */
  /** Hook payloads from VibePortal's own `claude -p` suggestion runs are accepted but ignored. */
  ignoreCwd?: string;
  /** hook events also feed the progress log, so the pet updates without waiting for a transcript poll */
  activity?: ActivityLog;

  ingestClaudeHook(p: any): boolean {
    const sessionId = typeof p?.session_id === 'string' ? p.session_id : undefined;
    const event = typeof p?.hook_event_name === 'string' ? p.hook_event_name : undefined;
    if (!sessionId || !event) return false;
    if (this.ignoreCwd && p.cwd === this.ignoreCwd) return true;
    const prev = this.hooks.get(sessionId);
    const obs: HookObs = { sessionId, ts: Date.now(), state: prev?.state ?? 'idle', detail: prev?.detail, cwd: p.cwd ?? prev?.cwd };
    switch (event) {
      case 'UserPromptSubmit':
        obs.state = 'running';
        obs.detail = typeof p.prompt === 'string' ? oneLine(p.prompt, 90) : obs.detail;
        this.activity?.prompt(sessionId, obs.ts, p.prompt);
        break;
      case 'PreToolUse':
      case 'PostToolUse':
        obs.state = 'running';
        if (p.tool_name) obs.detail = `⚙ ${p.tool_name}`;
        if (event === 'PreToolUse' && p.tool_name) this.activity?.tool(sessionId, obs.ts, p.tool_name, p.tool_input, { id: p.tool_use_id, cwd: p.cwd });
        break;
      case 'PermissionRequest':
        obs.state = 'waiting';
        obs.detail = p.tool_name ? `Permission: ${p.tool_name}` : 'Permission requested';
        break;
      case 'Notification': {
        const msg = typeof p.message === 'string' ? p.message : '';
        const idle = p.notification_type === 'idle_prompt' || /waiting for your input/i.test(msg);
        obs.state = idle ? 'idle' : 'waiting';
        if (msg) obs.detail = oneLine(msg, 90);
        break;
      }
      case 'Stop':
        obs.state = 'idle';
        break;
      case 'SessionStart':
        obs.state = 'idle';
        break;
      case 'SessionEnd':
        obs.ended = true;
        break;
      default:
        return true; // accepted but not state-changing (SubagentStop, PreCompact, …)
    }
    this.hooks.set(sessionId, obs);
    return true;
  }

  /** Background runs started from VibePortal ("continue with an instruction"). */
  upsertDispatch(job: { id: string; title: string; state: TaskState; detail?: string; cwd?: string }, provider?: TaskInfo['provider']) {
    const prev = this.custom.get(job.id);
    const now = new Date().toISOString();
    this.custom.set(job.id, {
      id: `dispatch:${job.id}`,
      kind: 'dispatch',
      provider: provider ?? prev?.provider,
      title: job.title,
      state: job.state,
      detail: job.detail,
      cwd: job.cwd,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
    });
  }

  upsertCustom(body: any): TaskInfo | string {
    const id = typeof body?.id === 'string' && body.id.trim() ? body.id.trim().slice(0, 100) : undefined;
    if (!id) return 'field "id" (string) is required';
    const prev = this.custom.get(id);
    const state: TaskState = TASK_STATES.includes(body.state) ? body.state : prev?.state ?? 'running';
    const now = new Date().toISOString();
    const t: TaskInfo = {
      id: `custom:${id}`,
      kind: 'custom',
      title: typeof body.title === 'string' ? body.title.slice(0, 120) : prev?.title ?? id,
      state,
      detail: typeof body.detail === 'string' ? body.detail.slice(0, 200) : prev?.detail,
      progress: typeof body.progress === 'number' ? Math.max(0, Math.min(100, body.progress)) : prev?.progress,
      cwd: typeof body.cwd === 'string' ? body.cwd : prev?.cwd,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
    };
    this.custom.set(id, t);
    return t;
  }

  removeCustom(id: string): boolean {
    return this.custom.delete(id.replace(/^(custom|dispatch):/, ''));
  }

  /**
   * `ownedBy` maps a session's pid to a VibePortal background job; such sessions
   * are reported through `linked` instead of as tasks of their own.
   */
  claudeTasks(
    claudeDir: string,
    aiTitle: (sessionId: string) => string | undefined = () => undefined,
    ownedBy: (pid: number) => string | undefined = () => undefined,
    linked?: Map<string, string>,
  ): TaskInfo[] {
    const out = new Map<string, TaskInfo>();
    const dir = path.join(claudeDir, 'sessions');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      /* no sessions dir (older Claude Code) — rely on hooks */
    }
    for (const f of files) {
      let s: any;
      try {
        s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      if (!s?.sessionId || !isAlive(s.pid)) continue;
      const job = typeof s.pid === 'number' ? ownedBy(s.pid) : undefined;
      if (job) {
        linked?.set(job, s.sessionId);
        continue;
      }
      const fileTs = Number(s.statusUpdatedAt ?? s.updatedAt ?? s.startedAt ?? 0);
      const hook = this.hooks.get(s.sessionId);
      if (hook?.ended) continue;
      let state = mapStatus(s.status);
      let detail: string | undefined;
      if (hook && hook.ts >= fileTs) state = hook.state;
      if (hook) detail = hook.detail;
      const updated = Math.max(fileTs, hook?.ts ?? 0);
      out.set(s.sessionId, {
        id: `claude:${s.sessionId}`,
        kind: 'claude-code',
        provider: 'claude',
        alive: true,
        canContinue: true,
        ide: s.entrypoint === 'claude-vscode' ? 'vscode' : s.entrypoint === 'cli' ? 'terminal' : undefined,
        title: s.name || aiTitle(s.sessionId) || (s.cwd ? path.basename(s.cwd) : 'Claude Code'),
        state,
        detail: detail ?? (s.entrypoint ? `via ${s.entrypoint}` : undefined),
        cwd: s.cwd,
        startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : undefined,
        updatedAt: new Date(updated || Date.now()).toISOString(),
      });
    }
    // sessions only known through hooks (e.g. Claude Code versions without the sessions dir)
    const now = Date.now();
    for (const h of this.hooks.values()) {
      if (out.has(h.sessionId)) continue;
      if (h.ended || now - h.ts > 30 * 60_000) {
        if (now - h.ts > 6 * 3600_000) this.hooks.delete(h.sessionId);
        continue;
      }
      out.set(h.sessionId, {
        id: `claude:${h.sessionId}`,
        kind: 'claude-code',
        provider: 'claude',
        canContinue: true,
        title: aiTitle(h.sessionId) || (h.cwd ? path.basename(h.cwd) : `session ${h.sessionId.slice(0, 8)}`),
        state: h.state,
        detail: h.detail,
        cwd: h.cwd,
        updatedAt: new Date(h.ts).toISOString(),
      });
    }
    return [...out.values()];
  }

  customTasks(): TaskInfo[] {
    const now = Date.now();
    for (const [k, t] of this.custom) {
      const age = now - Date.parse(t.updatedAt);
      const finished = t.state === 'done' || t.state === 'failed';
      if ((finished && age > 3600_000) || age > 24 * 3600_000) this.custom.delete(k);
    }
    return [...this.custom.values()];
  }
}

export function mapStatus(status: unknown): TaskState {
  const s = String(status ?? '').toLowerCase();
  if (/wait|permission|approv|input|blocked/.test(s)) return 'waiting';
  if (/busy|running|working|thinking|active/.test(s)) return 'running';
  if (/error|fail/.test(s)) return 'failed';
  return 'idle';
}

function isAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return true; // can't tell — assume alive
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
