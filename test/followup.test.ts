import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// keep runs/config out of the real ~/.vibeportal
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-followup-'));
process.env.VIBEPORTAL_HOME = home;

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('an instruction sent to a busy background run waits for its turn, then resumes the same session', { skip: process.platform === 'win32' }, async () => {
  const { loadConfig } = await import('../src/core/config');
  const { Monitor } = await import('../src/core/monitor');
  // a stand-in `claude`: logs its arguments and stdin, then takes a moment
  const log = path.join(home, 'calls.log');
  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nin=$(cat | tr "\\n" " ")\necho "$* :: $in" >> "${log}"\nsleep 0.4\necho ok\n`, { mode: 0o755 });
  const m = new Monitor({ ...loadConfig(), claudeBin: bin, claudeDir: path.join(home, 'claude-dir') });
  const { jobId } = m.actions.start({ agent: 'claude', cwd: home, prompt: 'first' }, { claudeBin: bin, codexBin: '' });
  const first = m.tasks.customTasks().find((t) => t.id === `dispatch:${jobId}`)!;
  assert.equal(first.canContinue, true, 'a busy run takes instructions');

  const r1 = m.continueTask(first, 'second');
  const r2 = m.continueTask(first, 'third');
  assert.equal(r1.queued, true);
  assert.equal(r2.queued, true);

  // the first turn ends → one follow-up run with both instructions, in the same session
  await until(() => m.tasks.customTasks().some((t) => t.continuedFrom === first.id));
  const next = m.tasks.customTasks().find((t) => t.continuedFrom === first.id)!;
  assert.equal(next.state, 'running');
  assert.ok(!m.tasks.customTasks().some((t) => t.id === first.id), 'the old run hands its card over');
  await until(() => fs.readFileSync(log, 'utf8').trim().split('\n').length >= 2);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(calls[1], new RegExp(`--resume ${first.sessionId}`));
  assert.doesNotMatch(calls[1], /--fork-session/);
  assert.match(calls[1], /:: second +third *$/);
  await until(() => !m.actions.hasRunning());
});

test('queued instructions can be taken back', { skip: process.platform === 'win32' }, async () => {
  const { loadConfig } = await import('../src/core/config');
  const { Monitor } = await import('../src/core/monitor');
  const bin = path.join(home, 'claude-slow');
  fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nsleep 0.3\n`, { mode: 0o755 });
  const m = new Monitor({ ...loadConfig(), claudeBin: bin, claudeDir: path.join(home, 'claude-dir') });
  const { jobId } = m.actions.start({ agent: 'claude', cwd: home, prompt: 'go' }, { claudeBin: bin, codexBin: '' });
  const task = m.tasks.customTasks().find((t) => t.id === `dispatch:${jobId}`)!;
  m.continueTask(task, 'later');
  m.clearQueue(task);
  await until(() => !m.actions.hasRunning());
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!m.tasks.customTasks().some((t) => t.continuedFrom === task.id));
  assert.equal(m.tasks.customTasks().find((t) => t.id === task.id)?.state, 'done');
});

test('the team planner runs on the model and reasoning effort picked for it', { skip: process.platform === 'win32' }, async () => {
  const { loadConfig } = await import('../src/core/config');
  const { Monitor } = await import('../src/core/monitor');
  // a stand-in `claude`: logs its arguments, replies with a one-desk team
  const log = path.join(home, 'plan.log');
  const reply = path.join(home, 'plan.json');
  fs.writeFileSync(reply, JSON.stringify({ result: JSON.stringify({ nodes: [{ key: 'a', role: 'lead', task: 'Lead', deliverable: 'It', criteria: ['done'] }] }) }));
  const bin = path.join(home, 'claude-plan');
  fs.writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\necho "$*" >> "${log}"\ncat "${reply}"\n`, { mode: 0o755 });
  const m = new Monitor({ ...loadConfig(), claudeBin: bin, claudeDir: path.join(home, 'claude-dir') });
  const team = await m.planTeam({ goal: 'Ship it', budget: 3, model: 'opus', effort: 'xhigh' });
  assert.deepEqual(team.nodes[0].criteria, ['done']);
  await m.planTeam({ goal: 'Ship it', budget: 3, model: 'bad model; rm', effort: 'turbo' });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.match(calls[0], /--model opus --effort xhigh/);
  assert.match(calls[1], /--model sonnet --output-format/, 'unknown values fall back to the default');
  assert.doesNotMatch(calls[1], /--effort/);
});
