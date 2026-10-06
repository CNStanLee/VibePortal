import crypto from 'node:crypto';
import type { PendingPermission } from '../shared/types';

const TIMEOUT_MS = 15 * 60_000;

interface Pending extends PendingPermission {
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

export interface Decision {
  behavior: 'allow' | 'deny';
  message?: string;
}

/**
 * Permission prompts of VibePortal's background Claude runs. Instead of
 * refusing whatever would ask (headless mode), the run asks through a small
 * MCP tool (dist/mcp/permission.cjs) that waits here until you answer — in
 * the dashboard, the pet's bubble or on your phone.
 */
export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** tools allowed "for the rest of this run", per job */
  private always = new Map<string, Set<string>>();

  /** answers a request before it reaches you (an office desk's permissions and its supervisors); undefined = ask you */
  gate?: (jobId: string, tool: string, input: unknown) => Promise<Decision | undefined>;

  constructor(private onChange: (p?: PendingPermission) => void) {}

  list(): PendingPermission[] {
    return [...this.pending.values()].map(({ resolve: _r, timer: _t, ...p }) => p);
  }

  forJob(jobId: string): PendingPermission[] {
    return this.list().filter((p) => p.jobId === jobId);
  }

  /** Called by the MCP tool; resolves once someone answers (or after the timeout: deny). */
  async request(jobId: string, tool: string, input: unknown): Promise<Decision> {
    if (this.always.get(jobId)?.has(tool)) return { behavior: 'allow' };
    const gated = await this.gate?.(jobId, tool, input).catch(() => undefined);
    if (gated) return gated;
    return new Promise((resolve) => {
      const id = crypto.randomBytes(6).toString('hex');
      const p: Pending = {
        id,
        jobId,
        tool,
        summary: summarize(tool, input),
        createdAt: new Date().toISOString(),
        resolve,
        timer: setTimeout(() => this.answer(id, { behavior: 'deny', message: 'Nobody answered the permission request in time.' }), TIMEOUT_MS),
      };
      this.pending.set(id, p);
      this.onChange(this.list().find((x) => x.id === id));
    });
  }

  answer(id: string, d: Decision, alwaysForRun = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (alwaysForRun && d.behavior === 'allow') {
      const set = this.always.get(p.jobId) ?? new Set<string>();
      set.add(p.tool);
      this.always.set(p.jobId, set);
      // answer the same tool's other open requests of this run too
      for (const q of [...this.pending.values()]) if (q.jobId === p.jobId && q.tool === p.tool) this.answer(q.id, d);
    }
    p.resolve(d);
    this.onChange();
    return true;
  }

  /** A run ended: drop its open requests and remembered answers. */
  endJob(jobId: string) {
    for (const p of [...this.pending.values()]) if (p.jobId === jobId) this.answer(p.id, { behavior: 'deny', message: 'The run ended.' });
    this.always.delete(jobId);
  }
}

/** One readable line for a tool call: the command, the file, the URL… */
export function summarize(tool: string, input: unknown): string {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = a.command ?? a.file_path ?? a.notebook_path ?? a.url ?? a.pattern ?? a.query ?? a.path ?? a.description;
  const text = typeof pick === 'string' ? pick : JSON.stringify(a);
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 300 ? one.slice(0, 299) + '…' : one;
}
