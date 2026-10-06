import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTailer } from '../src/core/jsonl';
import { ClaudeLocalCollector } from '../src/core/collectors/claudeLocal';
import { CodexLocalCollector, decodeJwt } from '../src/core/collectors/codexLocal';
import { parseProfile, parseUsage } from '../src/core/collectors/claudeSubscription';
import { TaskTracker, mapStatus } from '../src/core/tasks';
import { applyPatch } from '../src/core/config';
import { PriceBook } from '../src/core/prices';
import { QuotaHistory } from '../src/core/forecast';
import { parseWham } from '../src/core/collectors/chatgptUsage';
import { UsageLedger, projectKey, repoWeb, toWebUrl } from '../src/core/ledger';
import { parseRemoteTaskId } from '../src/core/remote';

const T = { warn: 75, critical: 90 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-'));

test('tailer reads only appended complete lines, including split multi-byte chars', () => {
  const dir = tmp();
  const f = path.join(dir, 'a.jsonl');
  const seen: any[] = [];
  const tail = new JsonlTailer();
  fs.writeFileSync(f, '{"a":1}\n{"b":"中');
  tail.read(f, (o) => seen.push(o));
  assert.deepEqual(seen, [{ a: 1 }]);
  fs.appendFileSync(f, '文"}\n');
  tail.read(f, (o) => seen.push(o));
  assert.deepEqual(seen, [{ a: 1 }, { b: '中文' }]);
  tail.read(f, (o) => seen.push(o));
  assert.equal(seen.length, 2, 'no re-reads');
});

test('claude transcripts: usage is de-duplicated per message+request', () => {
  const c = new ClaudeLocalCollector();
  const now = new Date().toISOString();
  const line = (id: string, req: string) => ({
    type: 'assistant',
    timestamp: now,
    requestId: req,
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } },
  });
  c.ingest(line('m1', 'r1'));
  c.ingest(line('m1', 'r1')); // same message, second content block
  c.ingest(line('m2', 'r2'));
  c.ingest({ type: 'assistant', timestamp: now, message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 1 } } });
  const today = c.ledger.today();
  assert.equal(today.messages, 2);
  assert.equal(today.total, 2 * 135);
  // opus 5.5 priced: (10*4 + 5*20 + 100*0.2 + 20*5)/1e6 per message (no 1h breakdown → 5m write rate)
  assert.ok(Math.abs(today.cost - 2 * (10 * 4 + 5 * 20 + 100 * 0.2 + 20 * 5) / 1e6) < 1e-12);
  assert.equal(c.ledger.daily(7).at(-1)?.byModel['claude-opus-5-5'].output, 10);
});

test('codex logs: cumulative token counts become deltas; latest rate limits win', async () => {
  const dir = tmp();
  const day = path.join(dir, 'sessions', '2026', '10', '06');
  fs.mkdirSync(day, { recursive: true });
  const ts = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const resets = Math.floor(Date.now() / 1000) + 3600;
  const rows = [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'sess-1', cwd: '/w/proj' } },
    { timestamp: ts(1), type: 'turn_context', payload: { model: 'gpt-x' } },
    { timestamp: ts(2), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: ts(3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110 } }, rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: resets }, plan_type: 'plus' } } },
    { timestamp: ts(4), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 100, output_tokens: 30, total_tokens: 280 } }, rate_limits: { primary: { used_percent: 92, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 40, window_minutes: 10080 }, plan_type: 'plus' } } },
  ];
  fs.writeFileSync(path.join(day, 'rollout-2026-10-06T10-00-00-sess-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const c = new CodexLocalCollector();
  await c.collect(dir, 7);
  const today = c.ledger.today();
  assert.equal(today.total, 280);
  assert.equal(today.cacheRead, 100);
  assert.equal(today.input, 150);
  const q = c.quotas(T);
  assert.equal(q.quotas.length, 2);
  assert.equal(q.quotas[0].label, '5-hour window');
  assert.equal(q.quotas[0].percent, 92);
  assert.equal(q.quotas[0].severity, 'critical');
  assert.equal(q.quotas[1].label, 'Weekly window');
  const tasks = c.tasks(new Map([['sess-1', 'Fix the bug']]));
  assert.equal(tasks[0].title, 'Fix the bug');
  assert.equal(tasks[0].state, 'running');
});

test('claude usage: limits array and legacy shape', () => {
  const modern = parseUsage(
    {
      limits: [
        { kind: 'session', percent: 12, severity: 'normal', resets_at: '2030-01-01T00:00:00Z' },
        { kind: 'weekly_scoped', percent: 86, severity: 'warning', scope: { model: { display_name: 'Opus' } } },
      ],
    },
    T,
  );
  assert.deepEqual(
    modern.map((q) => [q.label, q.percent, q.severity]),
    [
      ['5-hour session', 12, 'normal'],
      ['Weekly · Opus', 86, 'warning'],
    ],
  );
  const legacy = parseUsage({ five_hour: { utilization: 95, resets_at: null }, seven_day: { utilization: 20 } }, T);
  assert.equal(legacy[0].severity, 'critical');
  assert.equal(legacy[1].label, 'Weekly · all models');
});

test('claude profile → plan name', () => {
  assert.equal(parseProfile({ organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }).name, 'Claude Max 20x');
  assert.equal(parseProfile({ account: { has_claude_pro: true }, organization: {} }).name, 'Claude Pro');
  assert.equal(parseProfile({}).name, 'Claude Free');
});

test('jwt claims decode', () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })).toString('base64url');
  assert.equal(decodeJwt(`x.${payload}.y`)['https://api.openai.com/auth'].chatgpt_plan_type, 'pro');
  assert.equal(decodeJwt('garbage'), undefined);
});

test('hook events drive claude task state', () => {
  const tr = new TaskTracker();
  const dir = tmp();
  assert.equal(tr.ingestClaudeHook({ hook_event_name: 'Stop' }), false, 'needs session_id');
  tr.ingestClaudeHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/x/app', prompt: 'do  the\nthing' });
  let t = tr.claudeTasks(dir)[0];
  assert.equal(t.state, 'running');
  assert.equal(t.title, 'app');
  assert.equal(t.detail, 'do the thing');
  tr.ingestClaudeHook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  assert.equal(tr.claudeTasks(dir)[0].state, 'waiting');
  tr.ingestClaudeHook({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
  assert.equal(tr.claudeTasks(dir)[0].state, 'idle');
  tr.ingestClaudeHook({ session_id: 's1', hook_event_name: 'SessionEnd' });
  assert.equal(tr.claudeTasks(dir).length, 0);
});

test('custom tasks: validation, merge and removal', () => {
  const tr = new TaskTracker();
  assert.equal(typeof tr.upsertCustom({}), 'string');
  tr.upsertCustom({ id: 'job', title: 'Build', state: 'running', progress: 150 });
  const t = tr.upsertCustom({ id: 'job', state: 'done' });
  assert.ok(typeof t !== 'string');
  assert.equal(t.title, 'Build');
  assert.equal(t.progress, 100);
  assert.equal(t.state, 'done');
  assert.ok(tr.removeCustom('custom:job'));
  assert.equal(tr.customTasks().length, 0);
});

test('session status mapping', () => {
  assert.equal(mapStatus('busy'), 'running');
  assert.equal(mapStatus('idle'), 'idle');
  assert.equal(mapStatus('waiting_for_permission'), 'waiting');
  assert.equal(mapStatus(undefined), 'idle');
});

test('settings patch clamps values and keeps secrets', () => {
  const base = applyPatch(
    {
      claudeDir: '/c', codexDir: '/x', historyDays: 30, pollSeconds: 15, subscriptionPollSeconds: 300, warnPercent: 75, criticalPercent: 90,
      notifications: true, pet: { enabled: true, size: 140, character: 'duo', codexPet: 'bot' }, suggestModel: 'haiku', claudeBin: '', codexBin: '', prices: {},
      anthropicAdminKey: 'k', openaiAdminKey: '', launchAtLogin: false, apiToken: 't', port: 8787, remoteAccess: false, machineName: 'm',
      instanceId: 'i', hosts: [], remotePassword: null, sessionSecret: 's', publicTunnel: false, tunnelProvider: 'localhost.run', ngrokDomain: '', ngrokAuthtoken: '', publicUrl: '',
    },
    { subscriptionPollSeconds: 5, pet: { size: 9999, character: 'claude', codexPet: 'whale' }, suggestModel: 'bad model; rm -rf /' },
  );
  assert.equal(base.subscriptionPollSeconds, 60);
  assert.equal(base.pet.size, 320);
  assert.equal(base.pet.character, 'claude');
  assert.equal(base.pet.codexPet, 'whale');
  assert.equal(base.suggestModel, 'haiku', 'rejects odd model names');
  assert.equal(base.anthropicAdminKey, 'k');
  assert.equal(applyPatch(base, { anthropicAdminKey: '' }).anthropicAdminKey, '');
  assert.equal(applyPatch(base, { remoteAccess: true }).remoteAccess, true);
});

test('price book: prefix match, cache tiers, overrides', () => {
  const pb = new PriceBook({ 'gpt-6-astra': { input: 2, output: 8 } });
  // Opus 5.5: $4 in / $20 out / $0.20 cache read / 1h write = 2x input
  const c = pb.cost('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 1e6 });
  assert.equal(Math.round(c * 100) / 100, 4 + 20 + 0.2 + 8);
  assert.ok(pb.find('claude-opus-4-5-20251101'), 'dated ids match');
  assert.equal(pb.find('claude-opus-5-5')?.input, 4, 'longest prefix wins over claude-opus-5');
  assert.equal(pb.find('gpt-6-astra')?.output, 8);
  assert.equal(pb.find('mystery-model'), undefined);
});

test('forecast: window average, recent pace and exhaustion before reset', () => {
  const dir = tmp();
  const h = new QuotaHistory(path.join(dir, 'h.json'));
  const now = Date.parse('2026-10-06T12:00:00Z');
  // 5h window that started 2h ago, 40% used → 20%/h → 100% in 3h, exactly at reset
  const q = { id: 's', label: 's', percent: 40, severity: 'normal' as const, kind: 'session' as const, windowMinutes: 300, resetsAt: new Date(now + 3 * 3600_000).toISOString() };
  const f1 = h.forecast('k', q, now)!;
  assert.equal(f1.basis, 'window');
  assert.equal(f1.windowRatePerHour, 20);
  assert.equal(f1.willExhaustBeforeReset, false);
  // recent samples show a faster pace: 20% → 40% in the last 30 minutes
  h.record('k', { ...q, percent: 20 }, now - 30 * 60_000);
  const f2 = h.forecast('k', q, now)!;
  assert.equal(f2.basis, 'recent');
  assert.equal(f2.ratePerHour, 40);
  assert.equal(f2.willExhaustBeforeReset, true);
  assert.ok(Date.parse(f2.exhaustAt!) < Date.parse(q.resetsAt));
});

test('wham usage parsing: windows, labels and extra limits', () => {
  const qs = parseWham(
    {
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 2000000000 },
        secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 2000500000 },
      },
      additional_rate_limits: [{ limit_name: 'gpt-reserve', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } }],
    },
    T,
  );
  assert.deepEqual(
    qs.map((q) => [q.kind, q.label, q.percent]),
    [
      ['session', '5-hour window', 30],
      ['weekly', 'Weekly window', 10],
      ['other', 'Gpt Reserve · Weekly window', 0],
    ],
  );
});

test('ledger: per-repository aggregation via git root', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo', 'src'), { recursive: true });
  const l = new UsageLedger();
  const tt = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, total: n, messages: 1, cost: n / 1000 });
  l.add(Date.now(), 'm1', tt(100), projectKey(path.join(dir, 'repo', 'src')));
  l.add(Date.now(), 'm2', tt(50), projectKey(path.join(dir, 'repo')));
  const [p] = l.projects(7);
  assert.equal(p.key, path.join(dir, 'repo'));
  assert.equal(p.name, 'repo');
  assert.equal(p.total.total, 150);
  assert.equal(p.today.total, 150);
  assert.equal(p.spark[13], 150);
  assert.equal(Object.keys(p.byModel).length, 2);
});

test('remote task ids round-trip', () => {
  assert.deepEqual(parseRemoteTaskId('remote:ab12:claude:uuid-1'), { hostId: 'ab12', taskId: 'claude:uuid-1' });
  assert.equal(parseRemoteTaskId('claude:uuid-1'), undefined);
});

test('git remotes become web links without credentials', () => {
  assert.equal(toWebUrl('https://github.com/CNStanLee/VibePortal.git'), 'https://github.com/CNStanLee/VibePortal');
  assert.equal(toWebUrl('git@github.com:org/repo.git'), 'https://github.com/org/repo');
  assert.equal(toWebUrl('ssh://git@gitlab.example.com:2222/team/proj.git'), 'https://gitlab.example.com/team/proj');
  assert.equal(toWebUrl('https://user:ghp_secret@github.com/org/private.git'), 'https://github.com/org/private');
  assert.equal(toWebUrl('/local/path/repo'), undefined);
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  assert.deepEqual(repoWeb(dir), { webUrl: 'https://github.com/a/b', forge: 'github' });
});
