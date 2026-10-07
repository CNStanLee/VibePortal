import fs from 'node:fs';
import path from 'node:path';
import type { OfficeHelper } from '../shared/office';
import { describeTool } from './activity';

/**
 * The sub-agents a Claude session started (its Agent tool): Claude Code keeps each in
 * <session>/subagents/agent-<id>.jsonl, with a .meta.json saying what it was asked to do.
 * Only the tail of each transcript is read, and only when it changed.
 */
const TAIL = 64_000;
const cache = new Map<string, { mtime: number; size: number; helper: OfficeHelper }>();

export function subagentsOf(transcript: string, sinceMs = 0, max = 12): OfficeHelper[] {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: OfficeHelper[] = [];
  for (const f of names) {
    const file = path.join(dir, f);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const old = cache.get(file);
    if (old && old.mtime === st.mtimeMs && old.size === st.size) {
      if (Date.parse(old.helper.startedAt) >= sinceMs) out.push(old.helper);
      continue;
    }
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let meta: { description?: unknown; agentType?: unknown } = {};
    let startedAt = st.birthtimeMs || st.ctimeMs;
    try {
      const m = path.join(dir, f.replace(/\.jsonl$/, '.meta.json'));
      meta = JSON.parse(fs.readFileSync(m, 'utf8'));
      startedAt = fs.statSync(m).mtimeMs;
    } catch {
      /* an older Claude Code: no meta */
    }
    const helper: OfficeHelper = {
      id,
      name: (typeof meta.description === 'string' && meta.description.trim()) || id.slice(0, 8),
      ...(typeof meta.agentType === 'string' ? { type: meta.agentType } : {}),
      ...tailState(file, st, old?.helper),
      startedAt: new Date(startedAt).toISOString(),
    };
    cache.set(file, { mtime: st.mtimeMs, size: st.size, helper });
    if (startedAt >= sinceMs) out.push(helper);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-max);
}

/** Whether it is still at it (its last word was neither a final answer nor an interruption) and what it does last. */
function tailState(file: string, st: fs.Stats, old?: OfficeHelper): Pick<OfficeHelper, 'state' | 'endedAt' | 'verb' | 'doing'> {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, st.size - TAIL);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      // the first line may be cut
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { state: old?.state ?? 'running', verb: old?.verb, doing: old?.doing };
  }
  let state: OfficeHelper['state'] | undefined;
  let tool: { verb: OfficeHelper['verb']; text?: string } | null | undefined;
  for (const line of text.split('\n').reverse()) {
    if (state && tool !== undefined) break;
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (!state && o?.type === 'assistant') state = o.message?.stop_reason === 'end_turn' ? 'done' : 'running';
    else if (!state && o?.type === 'user') {
      const said = Array.isArray(content) ? content.find((b: any) => b?.type === 'text')?.text : typeof content === 'string' ? content : '';
      state = typeof said === 'string' && said.startsWith('[Request interrupted') ? 'stopped' : 'running';
    }
    if (tool === undefined && o?.type === 'assistant' && Array.isArray(content)) {
      const use = content.filter((b: any) => b?.type === 'tool_use').pop();
      if (use) tool = describeTool(use.name, use.input, o.cwd);
    }
  }
  const s = state ?? 'running';
  return {
    state: s,
    ...(s !== 'running' ? { endedAt: new Date(st.mtimeMs).toISOString() } : {}),
    verb: s === 'running' ? (tool?.verb ?? old?.verb) : undefined,
    doing: s === 'running' ? (tool?.text ?? old?.doing)?.slice(0, 80) : undefined,
  };
}
