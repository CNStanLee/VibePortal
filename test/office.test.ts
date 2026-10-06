import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-office-'));
process.env.VIBEPORTAL_HOME = home;

import { autoLayout, cascadeGrants, estimateTeam, fitToBudget, grantOf, nodePrompt, wouldCycle, type OfficeNode } from '../src/shared/office';
import { Office, cleanTeam, parsePlan, parseReview, reviewPrompt, type OfficeHost } from '../src/core/office';
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
function fakeHost(opts: { limit?: number; verdict?: string } = {}) {
  const started: { jobId: string; prompt: string; agent: string }[] = [];
  const running = new Set<string>();
  let office: Office;
  const host: OfficeHost & { started: typeof started; finish(i: number, state?: 'done' | 'failed'): void; stopped: string[]; judged: { prompt: string; model: string }[] } = {
    started,
    stopped: [],
    start(req) {
      if (running.size >= (opts.limit ?? 3)) throw Object.assign(new Error('Too many'), { status: 429 });
      const jobId = `j${++jobSeq}`;
      running.add(jobId);
      started.push({ jobId, prompt: req.prompt, agent: req.agent });
      // like the real runner: the start publishes, which observes the office again
      office.observe([]);
      office.onJob({ id: jobId, state: 'running' });
      return { jobId, taskId: `dispatch:${jobId}` };
    },
    stop(jobId) {
      host.stopped.push(jobId);
    },
    report: (taskId) => `report of ${taskId}`,
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
  assert.throws(() => office.startRun(office.saveTeam({ name: 'X', nodes: [node('a')] }).id, () => true), /folder/);
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
  const team = cleanTeam({ nodes: [{ id: 'l', role: 'lead' }, { id: 'r', role: 'researcher', parent: 'l' }, { id: 'e', role: 'engineer', parent: 'l', grants: ['edit', 'bogus'] }] });
  assert.deepEqual(team.nodes.map((n) => n.grants), [['edit', 'run', 'git'], [], ['edit']], 'role defaults, cut to the lead; unknown grants dropped');
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
