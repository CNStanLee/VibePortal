import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-office-'));
process.env.VIBEPORTAL_HOME = home;

import { OFFICE_GRANTS, applyPreset, presetOf, specOf, undelivered, assignModels, autoLayout, cascadeGrants, deliveryOf, layoutTree, parseChecks, parseVerdicts, stageOf, estimateTeam, fitToBudget, grantOf, nodePrompt, roughRate, shiftEfforts, teamEffort, usdToWeeklyPct, weeklyPctToUsd, weeklyRates, withEffortLevel, wouldCycle, type OfficeHelper, type OfficeNode } from '../src/shared/office';
import { subagentsOf } from '../src/core/subagents';
import { Office, cleanTeam, parsePlan, parseReview, planPrompt, reviewPrompt, type OfficeHost } from '../src/core/office';
import type { TaskInfo } from '../src/shared/types';

const node = (id: string, parent?: string, extra: Partial<OfficeNode> = {}): OfficeNode => ({ id, name: id.toUpperCase(), role: 'engineer', agent: 'claude', model: 'sonnet', effort: 'medium', task: `do ${id}`, ...(parent ? { parent } : {}), grants: ['edit', 'run'], x: 0, y: 0, ...extra });

test('office: a saved team keeps only a tree, with sane values', () => {
  const team = cleanTeam({
    name: '  Squad ',
    budget: -3,
    cwd: 'relative/path',
    permission: 'yolo',
    nodes: [
      { id: 'a', name: 'Lead', role: 'lead', agent: 'claude', model: 'opus', effort: 'high' },
      { id: 'b', parent: 'a', agent: 'codex', effort: 'max', model: 'bad model; rm -rf' },
      { id: 'c', parent: 'b', role: 'boss' },
      { id: 'a', name: 'duplicate' },
      { id: 'd', parent: 'ghost' },
      { id: 'e', parent: 'e' },
    ],
  });
  assert.equal(team.name, 'Squad');
  assert.equal(team.budget, 0.1, 'budget clamped');
  assert.equal(team.cwd, undefined, 'only absolute folders');
  assert.deepEqual(team.nodes.map((n) => n.id), ['a', 'b', 'c', 'd', 'e']);
  const b = team.nodes[1];
  assert.equal(b.agent, 'codex');
  assert.equal(b.effort, undefined, 'codex has no "max" effort');
  assert.equal(b.model, undefined, 'model names that are not names are dropped');
  assert.equal(team.nodes[2].role, 'engineer');
  assert.equal(team.nodes[3].parent, undefined, 'unknown supervisor dropped');
  assert.equal(team.nodes[4].parent, undefined, 'no reporting to yourself');

  // a loop a → c → b → a is broken
  const loop = cleanTeam({ nodes: [node('a', 'c'), node('b', 'a'), node('c', 'b')] });
  assert.ok(loop.nodes.some((n) => !n.parent), 'someone ends up on top');
  assert.equal(wouldCycle(loop.nodes, 'a', 'c') && !!loop.nodes.find((n) => n.id === 'a')?.parent, false);
});

test('office: the planner reply becomes a laid-out team', () => {
  const reply = JSON.stringify({
    result: `Sure:\n${JSON.stringify({
      name: 'Docs crew',
      nodes: [
        { key: 'a1', parent: null, name: 'Chief', role: 'lead', agent: 'claude', model: 'opus', effort: 'high', task: 'Own it' },
        { key: 'a2', parent: 'a1', name: 'Writer', role: 'writer', agent: 'claude', model: 'haiku', effort: 'low', task: 'Write' },
        { key: 'a3', parent: 'a1', name: 'Coder', role: 'wizard', agent: 'codex', effort: 'medium', task: 'Code' },
        { key: 'a4', parent: 'zz', name: 'Orphan', agent: 'claude', task: 'Alone' },
      ],
    })}`,
  });
  const team = parsePlan(reply, 'Ship the docs', 4);
  assert.equal(team.name, 'Docs crew');
  assert.equal(team.goal, 'Ship the docs');
  assert.equal(team.budget, 4);
  const [chief, writer, coder, orphan] = team.nodes;
  assert.equal(writer.parent, chief.id);
  assert.equal(coder.parent, chief.id);
  assert.equal(coder.role, 'engineer');
  assert.equal(orphan.parent, undefined);
  assert.ok(writer.y > chief.y, 'reports sit below their lead');
  assert.equal(chief.x, (writer.x + coder.x) / 2, 'the lead is centred over its team');
  assert.throws(() => parsePlan('no json here', 'g', 1), /did not reply/);
  assert.throws(() => parsePlan('{"nodes": []}', 'g', 1), /empty team/);
});

test('office: estimates grow with effort and model, and fit-to-budget brings them down', () => {
  const nodes = [node('lead', undefined, { model: 'opus', effort: 'high', role: 'lead' }), node('a', 'lead', { model: 'opus', effort: 'max' }), node('b', 'lead', { agent: 'codex', model: undefined, effort: 'high' })];
  const est = estimateTeam(nodes);
  assert.ok(est.byNode.a.cost > est.byNode.lead.cost * 1.5, 'max effort costs more');
  assert.ok(est.byNode.b.cost < est.byNode.a.cost);
  assert.equal(Math.round(est.cost * 1e6), Math.round(Object.values(est.byNode).reduce((s, x) => s + x.cost, 0) * 1e6));

  const fit = fitToBudget(nodes, est.cost / 3);
  assert.ok(fit.fits);
  assert.ok(estimateTeam(fit.nodes).cost <= est.cost / 3);
  assert.equal(fit.nodes.length, 3);
  const none = fitToBudget(nodes, 0.0001);
  assert.equal(none.fits, false, 'it says when it cannot');
  assert.ok(none.nodes.every((n) => n.agent === 'codex' || n.model === 'haiku'));
});

test('office: a desk is told the goal, its supervisor, its task and its people’s reports', () => {
  const nodes = [node('lead', undefined, { role: 'lead', task: 'Integrate' }), node('a', 'lead', { task: 'Build the API' }), node('b', 'lead', { agent: 'codex', task: 'Write tests' })];
  const leaf = nodePrompt({ goal: 'Ship v2', nodes }, nodes[1], []);
  assert.match(leaf, /Ship v2/);
  assert.match(leaf, /You report to LEAD/);
  assert.match(leaf, /Build the API/);
  assert.doesNotMatch(leaf, /reports:/);
  const top = nodePrompt({ goal: 'Ship v2', nodes }, nodes[0], [
    { node: nodes[1], state: 'done', report: 'API done' },
    { node: nodes[2], state: 'failed', report: 'x'.repeat(20_000) },
  ]);
  assert.match(top, /top of the team/);
  assert.match(top, /### A \(engineer, Claude\) — done\nAPI done/);
  assert.match(top, /### B \(engineer, Codex\) — FAILED/);
  assert.ok(top.length < 20_000, 'stays under the launcher limit');
});

test('office: layout keeps a loop from hanging it', () => {
  const laid = autoLayout([node('a', 'b'), node('b', 'a'), node('c')]);
  assert.equal(laid.length, 3);
});

// job ids stay unique across tests (runs of earlier tests may still be "running")
let jobSeq = 0;

/** A host that records what it was asked to start and lets the test finish runs. */
function fakeHost(opts: { limit?: number; verdict?: string; report?: (taskId: string) => string | undefined } = {}) {
  const started: { jobId: string; prompt: string; agent: string; cwd: string }[] = [];
  const running = new Set<string>();
  let office: Office;
  const host: OfficeHost & { started: typeof started; finish(i: number, state?: 'done' | 'failed'): void; stopped: string[]; judged: { prompt: string; model: string }[] } = {
    started,
    stopped: [],
    start(req) {
      if (running.size >= (opts.limit ?? 3)) throw Object.assign(new Error('Too many'), { status: 429 });
      const jobId = `j${++jobSeq}`;
      running.add(jobId);
      started.push({ jobId, prompt: req.prompt, agent: req.agent, cwd: req.cwd });
      // like the real runner: the start publishes, which observes the office again
      office.observe([]);
      office.onJob({ id: jobId, state: 'running' });
      return { jobId, taskId: `dispatch:${jobId}` };
    },
    stop(jobId) {
      host.stopped.push(jobId);
    },
    report: (taskId) => opts.report?.(taskId) ?? `report of ${taskId}`,
    judged: [] as { prompt: string; model: string }[],
    async judge(prompt, model) {
      host.judged.push({ prompt, model });
      return opts.verdict ?? '{"allow": true, "reason": "needed"}';
    },
    jobs: () => [...running].map((id) => ({ id, running: true })),
    changed() {},
    finish(i, state = 'done') {
      const id = started[i].jobId;
      running.delete(id);
      office.onJob({ id, state });
    },
  };
  return { host, bind: (o: Office) => (office = o) };
}

test('office: a run goes bottom-up and carries reports up', () => {
  const office = new Office();
  const { host, bind } = fakeHost({ limit: 2 });
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: 'T', goal: 'G', budget: 50, cwd: home, nodes: [node('lead', undefined, { role: 'lead' }), node('a', 'lead'), node('b', 'lead', { agent: 'codex' }), node('c', 'lead')] });
  const run = office.startRun(team.id, () => true);
  assert.deepEqual(host.started.map((s) => s.prompt.match(/You are (\w+)/)?.[1]), ['A', 'B'], 'the people start first, two at a time');
  assert.equal(host.started[1].agent, 'codex');
  assert.equal(run.progress.lead.state, 'waiting');
  assert.equal(run.progress.c.state, 'waiting', 'held back by the run limit, not failed');
  assert.throws(() => office.startRun(team.id, () => true), /already at work/);

  host.finish(0);
  assert.equal(run.progress.a.state, 'done');
  assert.equal(run.progress.a.report, `report of dispatch:${host.started[0].jobId}`);
  assert.equal(host.started.length, 3, 'C takes the free slot');
  host.finish(1, 'failed');
  host.finish(2);
  assert.equal(host.started.length, 4);
  const lead = host.started[3];
  assert.match(lead.prompt, /You are LEAD/);
  assert.ok(lead.prompt.includes(`report of dispatch:${host.started[0].jobId}`));
  assert.match(lead.prompt, /— FAILED/);
  host.finish(3);
  assert.equal(run.state, 'failed', 'one desk failed');
  assert.ok(run.endedAt);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'office.json'), 'utf8'));
  assert.equal(saved.runs.at(-1).state, 'failed');
});

test('office: a run stops everything once the budget is spent', () => {
  const office = new Office();
  const { host, bind } = fakeHost();
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: 'B', budget: 0.5, cwd: home, nodes: [node('lead'), node('a', 'lead'), node('b', 'lead')] });
  const run = office.startRun(team.id, () => true);
  const task = (jobId: string, sessionTokens: number) => ({ id: `dispatch:${jobId}`, kind: 'dispatch', title: '', state: 'running', updatedAt: '', workload: { tokensPerMin: 0, sessionTokens, model: 'claude-sonnet-5-5' }, activity: { feed: [{ ts: '', kind: 'tool', verb: 'edit', text: 'src/x.ts' }] } }) as TaskInfo;
  const [j1, j2] = host.started.map((x) => x.jobId);
  office.observe([task(j1, 10_000)]);
  assert.equal(run.state, 'running');
  assert.equal(run.progress.a.verb, 'edit');
  assert.equal(run.progress.a.doing, 'src/x.ts');
  assert.ok(run.spent > 0 && run.spent < 0.5);
  office.observe([task(j1, 10_000), task(j2, 400_000)]);
  assert.equal(run.state, 'over-budget');
  assert.deepEqual(host.stopped.sort(), [j1, j2].sort());
  assert.equal(run.progress.lead.state, 'skipped');
  assert.equal(run.progress.a.error, 'over budget');
  assert.throws(() => office.startRun('nope', () => true), /no such team/);
  assert.throws(() => office.startRun(office.saveTeam({ name: 'X', cwd: path.join(home, 'missing'), nodes: [node('a')] }).id, () => false), /folder/);
});

test('office: a desk follows its conversation into a later run, and its sub-agents join it', () => {
  const office = new Office();
  const { host, bind } = fakeHost();
  let helpers: OfficeHelper[] = [{ id: 'h1', name: 'review A', state: 'running', startedAt: new Date().toISOString(), verb: 'read', doing: 'paper.pdf' }];
  host.helpers = () => helpers;
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: 'R', budget: 0.5, cwd: home, nodes: [node('lead', undefined, { role: 'lead' })] });
  const run = office.startRun(team.id, () => true);
  const j1 = host.started[0].jobId;
  const task = (id: string, sessionTokens: number, startedAt = new Date().toISOString()) => ({ id, kind: 'dispatch', title: '', state: 'running', sessionId: 's1', startedAt, updatedAt: '', workload: { tokensPerMin: 0, sessionTokens, model: 'claude-sonnet-5-5' } }) as TaskInfo;
  office.observe([task(`dispatch:${j1}`, 1000)]);
  assert.equal(run.progress.lead.sessionId, 's1');
  assert.deepEqual(run.progress.lead.helpers?.map((h) => [h.name, h.state]), [['review A', 'running']], 'a sub-agent it started is on the floor');
  host.finish(0);
  assert.equal(run.state, 'done');
  assert.equal(run.progress.lead.helpers?.[0].state, 'stopped', 'its run ended: so did the sub-agent');

  // the developer continues the lead's conversation: a new background run of the same session
  helpers = [...helpers, { id: 'h2', name: 'edit B', state: 'running', startedAt: new Date().toISOString() }];
  const later = new Date(Date.now() + 1000).toISOString();
  office.observe([task('dispatch:j-next', 400_000, later)]);
  assert.equal(run.state, 'running', 'the run opens again');
  assert.ok(run.resumedAt);
  assert.equal(run.progress.lead.state, 'running');
  assert.equal(run.progress.lead.round, 2);
  assert.equal(run.progress.lead.jobId, 'j-next');
  assert.equal(run.progress.lead.helpers?.length, 2);
  assert.ok(run.spent > run.budget);
  assert.equal(run.state, 'running', 'taken up by the developer: the budget does not stop it');
  office.onJob({ id: 'j-next', state: 'done' });
  assert.equal(run.progress.lead.state, 'done');
  assert.equal(run.progress.lead.report, 'report of dispatch:j-next');
  assert.equal(run.state, 'done');
  // an older run of the team does not follow; neither does the same task again
  office.observe([task('dispatch:j-next', 400_000, later)]);
  assert.equal(run.state, 'done');
});

test('office: sub-agents are read from a session’s transcript folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-sub-'));
  const transcript = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(transcript, '');
  const sub = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const line = (o: object) => JSON.stringify(o) + '\n';
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Reviewer 1' }));
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), line({ type: 'user', message: { content: 'go' } }) + line({ type: 'assistant', cwd: dir, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(dir, 'paper.tex') } }] } }) + line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }));
  fs.writeFileSync(path.join(sub, 'agent-a2.meta.json'), JSON.stringify({ description: 'Reviewer 2' }));
  fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }));
  fs.writeFileSync(path.join(sub, 'agent-a3.jsonl'), line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
  const list = subagentsOf(transcript);
  const by = Object.fromEntries(list.map((h) => [h.id, h]));
  assert.equal(list.length, 3);
  assert.deepEqual([by.a1.name, by.a1.type, by.a1.state, by.a1.verb, by.a1.doing], ['Reviewer 1', 'general-purpose', 'running', 'read', 'paper.tex']);
  assert.equal(by.a2.state, 'done');
  assert.ok(by.a2.endedAt);
  assert.equal(by.a3.state, 'stopped');
  assert.deepEqual(subagentsOf(transcript, Date.now() + 60_000), [], 'only the ones started since');
  assert.deepEqual(subagentsOf(path.join(dir, 'none.jsonl')), []);
});

test('office: default workspaces are created on first run, isolated, persisted and reused', () => {
  const office = new Office();
  const { host, bind } = fakeHost();
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: '../Untitled', nodes: [node('dev')] });
  assert.equal(team.cwd, undefined);
  const run = office.startRun(team.id, (p) => fs.statSync(p).isDirectory());
  assert.ok(team.cwd!.startsWith(path.join(home, 'workspaces') + path.sep));
  assert.equal(host.started[0].cwd, team.cwd);
  assert.equal(new Office().view().teams.find((t) => t.id === team.id)?.cwd, team.cwd);
  office.stopRun(run.id);
  const cwd = team.cwd;
  office.startRun(team.id, (p) => fs.statSync(p).isDirectory());
  assert.equal(team.cwd, cwd);
  const second = office.saveTeam({ name: team.name, nodes: [node('dev')] });
  office.startRun(second.id, (p) => fs.statSync(p).isDirectory());
  assert.notEqual(second.cwd, cwd);
  assert.throws(() => office.saveTeam({ cwd: 'relative/path' }), /absolute/);
  const invalid = office.saveTeam({ cwd: path.join(home, 'missing-explicit'), nodes: [node('dev')] });
  assert.throws(() => office.startRun(invalid.id, () => false), /folder/);
  assert.equal(fs.existsSync(invalid.cwd!), false, 'an explicit invalid repo is never silently replaced');
});

test('office: permissions — which one a tool needs, and a desk holds only what its supervisor holds', () => {
  assert.equal(grantOf('Edit', { file_path: 'a.ts' }), 'edit');
  assert.equal(grantOf('Bash', { command: 'npm test' }), 'run');
  assert.equal(grantOf('Bash', { command: 'npm test && git commit -m x' }), 'git');
  assert.equal(grantOf('Bash', { command: 'git -C repo push origin main' }), 'git');
  assert.equal(grantOf('Bash', { command: 'git status' }), 'run');
  assert.equal(grantOf('WebFetch', { url: 'https://x' }), 'web');
  assert.equal(grantOf('mcp__github__create_issue', {}), 'tools');

  const nodes = cascadeGrants([node('lead', undefined, { grants: ['edit'] }), node('a', 'lead', { grants: ['edit', 'run', 'git'] }), node('b', 'a', { grants: ['run', 'edit'] })]);
  assert.deepEqual(nodes.map((n) => n.grants), [['edit'], ['edit'], ['edit']]);
  const team = cleanTeam({ nodes: [{ id: 'l', role: 'lead', grants: ['edit', 'run', 'git'] }, { id: 'r', role: 'researcher', parent: 'l' }, { id: 'e', role: 'engineer', parent: 'l', grants: ['edit', 'bogus'] }] });
  assert.deepEqual(team.nodes.map((n) => n.grants), [['edit', 'run', 'git'], ['edit', 'run', 'git'], ['edit']], 'everything by default, cut to the lead; unknown grants dropped');
  assert.match(nodePrompt({ goal: '', nodes: team.nodes }, team.nodes[2], []), /Your permissions: edit files\. .*your supervisor Agent/);

  assert.deepEqual(parseReview(JSON.stringify({ result: 'Sure. {"allow": false, "reason": "too risky"}' })), { allow: false, reason: 'too risky' });
  assert.deepEqual(parseReview('Thinking {about it}. {"allow": true, "reason": "ok"}'), { allow: true, reason: 'ok' });
  assert.equal(parseReview('maybe'), undefined);
  assert.match(reviewPrompt('Ship', team.nodes[0], team.nodes[2], { grant: 'git', tool: 'Bash', summary: 'git push' }), /asks for permission to commit \/ push with git: Bash — git push/);
});

test('office: requests go up the chain to whoever holds the permission', async () => {
  const office = new Office();
  const { host, bind } = fakeHost();
  bind(office);
  office.attach(host);
  const team = office.saveTeam({
    name: 'P',
    budget: 50,
    cwd: home,
    nodes: [node('lead', undefined, { role: 'lead', grants: ['edit', 'run', 'git', 'web'], model: 'opus' }), node('mgr', 'lead', { role: 'manager', grants: ['edit', 'run'], review: 'auto' }), node('dev', 'mgr', { grants: ['edit'] })],
  });
  const run = office.startRun(team.id, () => true);
  const dev = host.started[0].jobId;
  assert.match(host.started[0].prompt, /Your permissions: edit files\./);

  // its own permission: allowed at once, nobody asked
  const asks = () => run.progress.dev.asks ?? [];
  assert.deepEqual(await office.decide(dev, 'Edit', { file_path: 'x' }), { behavior: 'allow' });
  assert.equal(asks().length, 0);
  // the manager holds "run" and hands it down by itself
  assert.deepEqual(await office.decide(dev, 'Bash', { command: 'npm test' }), { behavior: 'allow' });
  assert.equal(asks()[0].to, 'mgr');
  assert.equal(asks()[0].state, 'allowed');
  assert.ok(run.progress.dev.grants?.includes('run'), 'kept for the rest of the run');
  assert.equal(host.judged.length, 0);
  // the manager has no web: the lead's agent reviews it (with the lead's model) and allows it
  assert.deepEqual(await office.decide(dev, 'WebFetch', { url: 'https://docs' }), { behavior: 'allow' });
  assert.equal(host.judged.length, 1);
  assert.equal(host.judged[0].model, 'opus');
  assert.match(host.judged[0].prompt, /You are LEAD .*supervising DEV/);
  assert.equal(asks().at(-1)?.to, 'lead');
  assert.ok((run.extra ?? 0) > 0, 'the review is counted against the budget');
  // nobody holds "tools": it goes to the developer
  assert.equal(await office.decide(dev, 'mcp__x__y', {}), undefined);
  assert.equal(asks().at(-1)?.state, 'user');
  assert.equal(asks().at(-1)?.to, undefined);
  // not an office run: the normal prompt
  assert.equal(await office.decide('dispatch-other', 'Bash', {}), undefined);
});

test('office: a supervisor can refuse, and can pass requests to the developer', async () => {
  const office = new Office();
  const { host, bind } = fakeHost({ verdict: '{"allow": false, "reason": "no pushing from here"}' });
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: 'R', budget: 50, cwd: home, nodes: [node('lead', undefined, { grants: ['edit', 'run', 'git'] }), node('dev', 'lead', { grants: ['edit'] })] });
  const run = office.startRun(team.id, () => true);
  const dev = host.started[0].jobId;
  const asks = () => run.progress.dev.asks ?? [];
  const d = await office.decide(dev, 'Bash', { command: 'git push --force' });
  assert.equal(d?.behavior, 'deny');
  assert.match(d?.message ?? '', /LEAD denied this: no pushing from here/);
  assert.equal(asks().at(-1)?.state, 'denied');
  assert.ok(!run.progress.dev.grants?.includes('git'));

  office.saveTeam({ ...team, nodes: team.nodes.map((n) => (n.id === 'lead' ? { ...n, review: 'user' } : n)) });
  run.nodes = run.nodes.map((n) => (n.id === 'lead' ? { ...n, review: 'user' } : n));
  assert.equal(await office.decide(dev, 'Bash', { command: 'npm i' }), undefined, 'passed to the developer');
  assert.equal(asks().at(-1)?.to, 'lead');
  assert.equal(asks().at(-1)?.state, 'user');
});

test('office: teams saved before desks had permissions load (the floor no longer crashes on them)', () => {
  const file = path.join(home, 'office.json');
  const keep = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ teams: [{ id: 'old', name: 'Old', goal: 'g', budget: 35, permission: 'auto', nodes: [{ id: 'a', name: 'Lead', role: 'lead', agent: 'claude', task: '', x: 1, y: 2 }, { id: 'b', name: 'W', role: 'writer', agent: 'claude', task: '', parent: 'a', x: 3, y: 4 }], updatedAt: '2026-10-06T00:00:00Z' }], runs: [{ id: 'r', teamId: 'old', state: 'done', nodes: [{ id: 'a', role: 'lead' }], progress: { a: { state: 'done' } } }] }));
  const office = new Office();
  const [team] = office.view().teams;
  assert.deepEqual(team.nodes.map((n) => n.grants), [OFFICE_GRANTS, OFFICE_GRANTS], 'they get everything, like a new desk');
  assert.equal((team as { permission?: string }).permission, undefined);
  assert.deepEqual(office.view().runs[0].nodes[0].grants, OFFICE_GRANTS);
  fs.writeFileSync(file, keep);
});

test('office: weekly limits — tokens per 1% from this week, the budget as a share of each week', () => {
  const day = (date: string, tokens: number) => ({ date, totals: { input: tokens, output: 0, cacheRead: 999, cacheWrite: 0, total: tokens, messages: 1, cost: 0 }, byModel: {} });
  const now = Date.now();
  const resets = new Date(now + 2 * 86400_000).toISOString();
  const local = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const providers = [
    {
      provider: 'claude',
      quotas: [
        { id: 'weekly_all', kind: 'weekly', percent: 50, resetsAt: resets, windowMinutes: 10080, label: 'Weekly', severity: 'normal' },
        { id: 'weekly_scoped:Fable', kind: 'weekly', percent: 80, resetsAt: resets, windowMinutes: 10080, label: 'Weekly · Fable', severity: 'normal' },
      ],
      daily: [day(local(now - 9 * 86400_000), 9e9), day(local(now - 86400_000), 6_000_000), day(local(now), 4_000_000)],
    },
    { provider: 'openai', quotas: [{ id: 'codex', kind: 'weekly', percent: 10, resetsAt: resets, windowMinutes: 10080, label: 'Weekly', severity: 'normal' }], daily: [day(local(now), 200_000)] },
  ] as unknown as import('../src/shared/types').ProviderSnapshot[];
  const rates = weeklyRates(providers);
  assert.equal(rates.claude?.used, 50);
  assert.equal(rates.claude?.tokensPerPct, 200_000, 'only this week counts: 10M tokens / 50%');
  assert.deepEqual(rates.claude?.others, [{ label: 'Weekly · Fable', used: 80 }]);
  assert.equal(roughRate(rates.claude), false);
  assert.equal(roughRate(rates.codex), true, 'few tokens: rough');

  const nodes = [node('a', undefined, { model: 'sonnet' })];
  const pct = usdToWeeklyPct(10, 'claude', nodes, rates.claude)!;
  assert.ok(pct > 0);
  assert.ok(Math.abs(weeklyPctToUsd(pct, 'claude', nodes, rates.claude)! - 10) < 1e-9, 'and back');
  assert.equal(usdToWeeklyPct(10, 'claude', nodes, undefined), undefined);

  const prompt = planPrompt('Build it', { budget: 5, lang: 'en', claude: true, codex: true, rates });
  assert.match(prompt, /Claude: 50% of its weekly limit used, 50% left/);
  assert.match(prompt, /Weekly · Fable: 80% used/);
  assert.match(prompt, /Codex: 10% of its weekly limit used/);
  assert.match(prompt, /"difficulty"/);
  assert.match(prompt, /at most 4 levels/);
  assert.match(planPrompt('x', { budget: 1, lang: 'zh', claude: true, codex: false }), /Codex: not installed/);
});

test('office: models by difficulty, strengths and weekly room; effort sliders', () => {
  const nodes = [node('lead', undefined, { role: 'lead' }), node('eng', 'lead', { difficulty: 3 }), node('test', 'lead', { role: 'tester', difficulty: 2 }), node('hard', 'lead', { difficulty: 5 }), node('doc', 'lead', { role: 'writer', difficulty: 1 })];
  const roomy = { claude: { used: 70, sample: 1e7, others: [] }, codex: { used: 20, sample: 1e7, others: [] } };
  const a = assignModels(nodes, { rates: roomy, available: { claude: true, codex: true } });
  const by = Object.fromEntries(a.map((n) => [n.id, n]));
  assert.equal(by.lead.agent, 'claude');
  assert.equal(by.lead.model, 'opus');
  assert.equal(by.eng.agent, 'codex', 'implementation goes where there is more room');
  assert.equal(by.test.agent, 'codex');
  assert.equal(by.hard.agent, 'claude', 'the hardest part stays on Claude');
  assert.equal(by.hard.effort, 'xhigh');
  assert.equal(by.doc.model, 'haiku');
  assert.equal(by.doc.effort, 'low');
  const tight = assignModels(nodes, { rates: { claude: { used: 92, sample: 1e7, others: [] }, codex: { used: 20, sample: 1e7, others: [] } }, available: { claude: true, codex: true } });
  assert.deepEqual(tight.map((n) => n.agent), ['claude', 'codex', 'codex', 'codex', 'codex'], 'Claude nearly used up: only the lead stays');
  assert.ok(assignModels(nodes, { rates: roomy, available: { claude: true, codex: false } }).every((n) => n.agent === 'claude'));

  const codex = node('c', undefined, { agent: 'codex', effort: 'low' });
  assert.equal(withEffortLevel(codex, 9).effort, 'xhigh', 'Codex tops out at xhigh');
  assert.equal(withEffortLevel(node('x'), -3).effort, 'low', 'Claude bottoms out at low');
  const up = shiftEfforts([node('p', undefined, { effort: 'medium' }), codex], 2);
  assert.deepEqual(up.map((n) => n.effort), ['xhigh', 'high']);
  assert.equal(teamEffort(up), (4 + 3) / 2);
});

test('office: deliverables and criteria — kept clean, planned, and told to each desk', () => {
  const team = cleanTeam({
    nodes: [
      { id: 'a', role: 'lead', deliverable: '  The release  ', criteria: ['- tests pass', '', '2. docs updated', 'c', 'd', 'e', 'f', 'g'] },
      { id: 'b', parent: 'a', deliverable: 42, criteria: '* API done\n\n• typed' },
    ],
  });
  assert.equal(team.nodes[0].deliverable, 'The release');
  assert.deepEqual(team.nodes[0].criteria, ['tests pass', 'docs updated', 'c', 'd', 'e', 'f'], 'bullets dropped, at most 6');
  assert.equal(team.nodes[1].deliverable, undefined);
  assert.deepEqual(team.nodes[1].criteria, ['API done', 'typed'], 'one per line');

  const prompt = planPrompt('Ship it', { budget: 5, lang: 'en', claude: true, codex: true });
  assert.match(prompt, /"deliverable"/);
  assert.match(prompt, /"criteria"/);
  const planned = parsePlan(
    JSON.stringify({ nodes: [{ key: 'a', role: 'lead', task: 'Lead', deliverable: 'A merged PR', criteria: ['CI green'] }, { key: 'b', parent: 'a', task: 'Code', deliverable: 'The diff', criteria: ['compiles', 'tested'] }] }),
    'Ship it',
    5,
  );
  assert.equal(planned.nodes[1].deliverable, 'The diff');
  assert.deepEqual(planned.nodes[1].criteria, ['compiles', 'tested']);

  const nodes = [node('lead', undefined, { role: 'lead', deliverable: 'The release', criteria: ['all green'] }), node('a', 'lead', { deliverable: 'The API', criteria: ['endpoints documented', 'tests pass'] })];
  const leaf = nodePrompt({ goal: 'G', nodes }, nodes[1], []);
  assert.match(leaf, /What you hand to LEAD \(your deliverable\): The API/);
  assert.match(leaf, /- endpoints documented\n- tests pass/);
  assert.match(leaf, /- \[x\] <criterion>/);
  assert.doesNotMatch(leaf, /ACCEPTED/, 'nobody reports to it');
  const top = nodePrompt({ goal: 'G', nodes }, nodes[0], [{ node: nodes[1], state: 'done', report: 'done' }]);
  assert.match(top, /hand to the developer/);
  assert.match(top, /Deliverable: The API\nCriteria: endpoints documented; tests pass\ndone/);
  assert.match(top, /"ACCEPTED: <name>" or "REJECTED: <name>/);
  const bare = nodePrompt({ goal: 'G', nodes: [node('x')] }, node('x'), []);
  assert.doesNotMatch(bare, /deliverable|checklist/, 'nothing about it when none is set');
});

test('office: a report’s checklist and its supervisor’s verdicts', () => {
  const crit = ['Tests pass', 'Docs **updated**', 'No lint errors'];
  const report = 'Did it.\n- [x] a task-list item from the work\n\nChecklist:\n- [x] tests pass (42 of 42)\n- [ ] docs updated — no time\n* [X] No lint errors';
  assert.deepEqual(parseChecks(report, crit), ['met', 'unmet', 'met'], 'by the criterion’s words');
  assert.deepEqual(parseChecks('[x] one\n[ ] two\n[x] three', crit), ['met', 'unmet', 'met'], 'else by position among the last lines');
  assert.deepEqual(parseChecks('no checklist', crit), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(parseChecks('[x] tests pass', crit), ['met', 'unknown', 'unknown']);
  assert.deepEqual(parseChecks('anything', []), []);

  const people = [
    { id: 'u', name: 'UI' },
    { id: 'l', name: 'UI lead' },
    { id: 'z', name: '测试员' },
  ];
  const v = parseVerdicts('Summary\nACCEPTED: UI lead — solid\n- **REJECTED**: UI: contrast still low\n接受：测试员\nACCEPTED: Nobody', people);
  assert.deepEqual(v, { l: { accepted: true, note: 'solid' }, u: { accepted: false, note: 'contrast still low' }, z: { accepted: true } });
  assert.deepEqual(parseVerdicts(undefined, people), {});
});

test('office: a run reads the checklist and the verdicts from the whole report', () => {
  const office = new Office();
  const long = 'x'.repeat(6000);
  const { host, bind } = fakeHost({
    report: (taskId) => {
      const i = host.started.findIndex((s) => `dispatch:${s.jobId}` === taskId);
      return i === 0 ? `${long}\n- [x] api works\n- [ ] typed — later` : `${long}\nREJECTED: A — types missing\n- [x] shipped`;
    },
  });
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: 'T', goal: 'G', budget: 50, cwd: home, nodes: [node('lead', undefined, { role: 'lead', criteria: ['shipped'] }), node('a', 'lead', { criteria: ['api works', 'typed'] })] });
  const run = office.startRun(team.id, () => true);
  assert.equal(deliveryOf(run.progress.a), 'making');
  host.finish(0);
  assert.deepEqual(run.progress.a.checks, ['met', 'unmet'], 'past the clipped part of the report');
  assert.equal(deliveryOf(run.progress.a), 'delivered');
  host.finish(1);
  assert.deepEqual(run.progress.lead.checks, ['met']);
  assert.equal(run.progress.a.accepted, false);
  assert.equal(run.progress.a.acceptNote, 'types missing');
  assert.equal(deliveryOf(run.progress.a), 'rejected');
  assert.equal(deliveryOf(undefined), 'none');
});

test('office: handoff steps and a tree layout with rows as tall as their tallest box', () => {
  const nodes = [node('lead'), node('m', 'lead'), node('w1', 'm'), node('w2', 'm'), node('t', 'lead')];
  assert.deepEqual(nodes.map((n) => stageOf(nodes, n.id)), [3, 2, 1, 1, 1]);
  const pos = layoutTree(nodes, { w: 100, h: (n) => (n.id === 't' ? 90 : 40), gapX: 10, gapY: 20, pad: 5 });
  assert.equal(pos.get('lead')!.y, 5);
  assert.equal(pos.get('m')!.y, 65);
  assert.equal(pos.get('t')!.y, 65);
  assert.equal(pos.get('w1')!.y, 65 + 90 + 20, 'the row below starts under the tallest box');
  assert.equal(pos.get('m')!.x, (pos.get('w1')!.x + pos.get('w2')!.x) / 2);
  const looped = [node('p', 'q'), node('q', 'p')];
  assert.equal(stageOf(looped, 'p') > 0, true, 'a loop does not hang it');
  assert.equal(autoLayout(looped).length, 2);
});

test('office: desks start with every permission, and a preset sets the whole team', () => {
  const planned = parsePlan(JSON.stringify({ nodes: [{ key: 'a', role: 'lead', task: 'L', grants: ['edit'] }, { key: 'b', parent: 'a', role: 'researcher', task: 'R' }] }), 'G', 5);
  assert.deepEqual(planned.nodes.map((n) => n.grants), [OFFICE_GRANTS, OFFICE_GRANTS], 'the planner hands out everything');
  assert.doesNotMatch(planPrompt('G', { budget: 5, lang: 'en', claude: true, codex: true }), /grants/);
  assert.equal(presetOf(planned.nodes), 'all');

  const nodes = [node('lead', undefined, { role: 'lead' }), node('r', 'lead', { role: 'researcher' }), node('w', 'lead', { role: 'writer', grants: [] })];
  assert.equal(presetOf(nodes), undefined, 'a mix matches no preset');
  for (const p of ['all', 'build', 'edit', 'read'] as const) {
    const set = applyPreset(nodes, p);
    assert.ok(set.every((n) => n.grants.join() === set[0].grants.join()), `${p}: everyone the same`);
    assert.equal(presetOf(set), p);
  }
  assert.deepEqual(applyPreset(nodes, 'all')[2].grants, OFFICE_GRANTS, 'not just the top of the team');
  assert.deepEqual(applyPreset(nodes, 'build')[1].grants, ['edit', 'run']);
  const byRole = applyPreset(nodes, 'role');
  assert.deepEqual(byRole.map((n) => n.grants), [['edit', 'run', 'git'], [], ['edit']], 'by role, cut to the lead');
  assert.equal(presetOf(byRole), 'role');
});

test('office: deliverables come first — the final one is settled before the team, the team is cut from it', () => {
  const free = planPrompt('Ship dark mode', { budget: 5, lang: 'en', claude: true, codex: true });
  const at = (re: RegExp) => free.search(re);
  assert.ok(at(/Step 1 — the final deliverable/) >= 0);
  assert.ok(at(/Step 1/) < at(/Step 2 — break the deliverable down/) && at(/Step 2/) < at(/Step 3 — who makes each deliverable/), 'what comes out, then its parts, then who');
  assert.ok(at(/Step 3/) < at(/"difficulty" 1-5/), 'models are picked for the makers, last');
  assert.match(free, /\{"name":"team name","deliverable":"the final deliverable","criteria"/);
  const fixed = planPrompt('Ship dark mode', { budget: 5, lang: 'en', claude: true, codex: true, deliverable: 'A PR with dark mode', criteria: ['tests pass', ' '] });
  assert.match(fixed, /The developer has settled it; keep it word for word\.\nFinal deliverable: A PR with dark mode\nIt is accepted when:\n- tests pass$/m);

  const reply = JSON.stringify({
    deliverable: 'Planner’s final',
    criteria: ['p1'],
    nodes: [
      { key: 'a', role: 'lead', task: 'L', deliverable: 'Lead’s own', criteria: ['l1'] },
      { key: 'b', parent: 'a', task: 'B', deliverable: 'Part B', criteria: ['b1'] },
    ],
  });
  const t1 = parsePlan(reply, 'G', 5);
  assert.equal(t1.deliverable, 'Planner’s final');
  assert.deepEqual(t1.criteria, ['p1']);
  assert.equal(t1.nodes[0].deliverable, undefined, 'the lead takes the team’s');
  assert.deepEqual(specOf(t1, t1.nodes[0]), { deliverable: 'Planner’s final', criteria: ['p1'] });
  assert.deepEqual(specOf(t1, t1.nodes[1]), { deliverable: 'Part B', criteria: ['b1'] });
  const t2 = parsePlan(reply, 'G', 5, new Date(), { deliverable: 'Mine', criteria: ['m1', 'm2'] });
  assert.equal(t2.deliverable, 'Mine', 'the developer’s final deliverable wins');
  assert.deepEqual(t2.criteria, ['m1', 'm2']);
  const t3 = parsePlan(JSON.stringify({ nodes: [{ key: 'a', role: 'lead', task: 'L', deliverable: 'Only the lead’s', criteria: ['x'] }] }), 'G', 5);
  assert.equal(t3.deliverable, 'Only the lead’s', 'a lead-only answer still lands on the team');

  // a desk without a deliverable holds the team back; the top desk has the team's
  const team = cleanTeam({ deliverable: 'The release', criteria: ['- all green'], nodes: [{ id: 'l', role: 'lead' }, { id: 'a', parent: 'l', deliverable: 'API' }, { id: 'b', parent: 'l' }] });
  assert.deepEqual(team.criteria, ['all green']);
  assert.deepEqual(undelivered(team).map((n) => n.id), ['b']);
  assert.deepEqual(undelivered({ ...team, deliverable: undefined }).map((n) => n.id), ['l', 'b']);

  const lead = nodePrompt(team, team.nodes[0], []);
  assert.match(lead, /What you hand to the developer \(your deliverable\): The release\n\nIt counts as delivered when:\n- all green\n\nYour assignment \(how you get there\)/, 'the deliverable before the assignment');
  assert.match(nodePrompt(team, team.nodes[1], []), /It goes into LEAD's deliverable: The release|It goes into Agent's deliverable: The release/);
});

test('office: a run judges the top desk by the team’s final criteria', () => {
  const office = new Office();
  const { host, bind } = fakeHost({ report: () => 'done\n- [x] all green\n- [ ] documented — later' });
  bind(office);
  office.attach(host);
  const team = office.saveTeam({ name: 'F', goal: 'G', deliverable: 'The release', criteria: ['all green', 'documented'], budget: 50, cwd: home, nodes: [node('lead', undefined, { role: 'lead' })] });
  const run = office.startRun(team.id, () => true);
  assert.equal(run.deliverable, 'The release', 'the run keeps what it set out to deliver');
  assert.match(host.started[0].prompt, /your deliverable\): The release/);
  host.finish(0);
  assert.deepEqual(run.progress.lead.checks, ['met', 'unmet']);
});
