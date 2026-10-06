import path from 'node:path';
import { JsonlTailer, findJsonl, yieldToLoop } from '../jsonl';
import { SessionStats, UsageLedger, projectKey } from '../ledger';
import { PriceBook } from '../prices';
import { ActivityLog } from '../activity';
import type { SourceStatus, TokenTotals } from '../../shared/types';

/**
 * Reads token usage from Claude Code transcripts (~/.claude/projects/**\/*.jsonl).
 * Each assistant message can be written several times (one line per content
 * block), all carrying the same usage, so entries are de-duplicated by
 * message id + request id.
 */
export class ClaudeLocalCollector {
  readonly ledger = new UsageLedger();
  readonly sessions = new SessionStats();
  /** per-session progress feed (tool calls, replies, plan) for the pet */
  readonly activity = new ActivityLog();
  private tailer = new JsonlTailer();
  private seen = new Set<string>();
  private lastDir = '';
  private prices = new PriceBook();
  /** sessionId → transcript file, for the task actions */
  readonly transcripts = new Map<string, string>();
  status: SourceStatus = { id: 'claude-code-logs', label: 'Claude Code logs', state: 'unavailable' };

  async collect(claudeDir: string, historyDays: number, prices?: PriceBook) {
    if (prices && prices !== this.prices) {
      this.prices = prices;
      this.reset(); // costs are computed at ingest time
    }
    if (claudeDir !== this.lastDir) {
      this.reset();
      this.lastDir = claudeDir;
    }
    const root = path.join(claudeDir, 'projects');
    const since = Date.now() - historyDays * 86400_000;
    const files = findJsonl(root, since);
    if (files.length === 0) {
      this.status = { ...this.status, state: 'unavailable', message: `No transcripts under ${root}`, updatedAt: new Date().toISOString() };
      return;
    }
    for (const f of files) {
      if (!f.includes(`${path.sep}subagents${path.sep}`)) this.transcripts.set(path.basename(f, '.jsonl'), f);
      // only assistant lines carry usage; besides those, only prompts and titles are worth a JSON.parse
      this.tailer.read(f, (o) => this.ingest(o), claudeLineFilter);
      await yieldToLoop();
    }
    this.ledger.prune(Math.max(historyDays, 35));
    this.status = {
      ...this.status,
      state: 'ok',
      message: `${files.length} transcript files`,
      updatedAt: new Date().toISOString(),
    };
  }

  ingest(o: any) {
    this.track(o);
    if (o?.type !== 'assistant') return;
    const msg = o.message;
    const u = msg?.usage;
    if (!u || !msg.model || msg.model === '<synthetic>') return;
    const key = `${msg.id ?? o.uuid}:${o.requestId ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const w1h = Math.min(cacheWrite, num(u.cache_creation?.ephemeral_1h_input_tokens));
    const t: TokenTotals = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite,
      total: 0,
      messages: 1,
      cost: 0,
    };
    t.total = t.input + t.output + t.cacheRead + t.cacheWrite;
    t.cost = this.prices.cost(msg.model, { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite5m: cacheWrite - w1h, cacheWrite1h: w1h });
    const ts = Date.parse(o.timestamp);
    this.ledger.add(ts, msg.model, t, projectKey(o.cwd));
    const sid = o.sessionId ?? o.session_id;
    // workload counts new tokens only — cache reads are cheap and would swamp the rate
    if (sid) this.sessions.add(sid, ts, t.input + t.output + t.cacheWrite, t.input + t.cacheRead + t.cacheWrite, msg.model, undefined, typeof o.effort === 'string' ? o.effort : undefined);
  }

  /** Feeds the progress log; sub-agent (sidechain) lines would only confuse the main feed. */
  private track(o: any) {
    const sid = o?.sessionId ?? o?.session_id;
    if (!sid || o.isSidechain) return;
    if (o.type === 'ai-title') return this.activity.setTitle(sid, o.aiTitle);
    const ts = Date.parse(o.timestamp);
    const content = o.message?.content;
    if (o.type === 'user' && !o.isMeta) {
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
      return this.activity.prompt(sid, ts, text);
    }
    if (o.type !== 'assistant' || !Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === 'tool_use') this.activity.tool(sid, ts, b.name, b.input, { id: b.id, cwd: o.cwd });
      else if (b?.type === 'text') this.activity.say(sid, ts, b.text, o.uuid);
    }
  }

  unpriced(): string[] {
    return this.ledger.models().filter((m) => !this.prices.find(m));
  }

  private reset() {
    this.ledger.clear();
    this.sessions.clear();
    this.activity.clear();
    this.transcripts.clear();
    this.tailer = new JsonlTailer();
    this.seen.clear();
  }
}

/** Tool results are the bulk of a transcript and are never needed here. */
const claudeLineFilter = (line: string) =>
  line.includes('"usage"') || line.includes('"type":"ai-title"') || (line.includes('"type":"user"') && !line.includes('"tool_use_id"'));

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
