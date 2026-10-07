import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions } from '../src/core/actions';

// keep runs/config out of the real ~/.vibeportal
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-runs-'));
process.env.VIBEPORTAL_HOME = home;

const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('a background run outlives a VibePortal restart and is followed to the end', { skip: process.platform === 'win32' }, async () => {
  const { ActionRunner } = await import('../src/core/actions');
  // a stand-in `claude` that takes a while and then answers
  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nsleep 1.2\necho finished\n`, { mode: 0o755 });
  const before = new ActionRunner(() => {});
  const { jobId } = before.start({ agent: 'claude', cwd: home, prompt: 'go' }, { claudeBin: bin, codexBin: '' });
  const record = JSON.parse(fs.readFileSync(path.join(home, 'runs', 'running.json'), 'utf8'));
  assert.equal(record[0].id, jobId, 'running runs are written down');

  // "restart": a fresh runner finds the run still going and follows it
  const updates: { id: string; state: string; detail?: string }[] = [];
  const after = new ActionRunner((u) => updates.push(u));
  after.adopt();
  assert.deepEqual(
    updates.map((u) => [u.id, u.state]),
    [[jobId, 'running']],
  );
  assert.equal(after.hasRunning(), true);
  await until(() => updates.some((u) => u.state === 'done'));
  assert.equal(updates.at(-1)!.detail, 'finished', 'the output file is the run’s output');
  assert.match(after.jobOutput(jobId) ?? '', /finished/);
  assert.equal(after.hasRunning(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'runs', 'running.json'), 'utf8')), []);
});

test('a run that is gone is not adopted', { skip: process.platform === 'win32' }, async () => {
  const { ActionRunner } = await import('../src/core/actions');
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'runs', 'running.json'),
    JSON.stringify([{ id: 'dispatch-gone1', title: 't', detail: 'd', agent: 'claude', cwd: home, startedAt: 0, pid: 2 ** 22 + 7, running: true }]),
  );
  const updates: unknown[] = [];
  new ActionRunner((u) => updates.push(u)).adopt();
  assert.equal(updates.length, 0);
});

test('instructions queued on a busy run survive a restart', { skip: process.platform === 'win32' }, async () => {
  const { loadConfig } = await import('../src/core/config');
  const { Monitor } = await import('../src/core/monitor');
  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nsleep 1\necho ok\n`, { mode: 0o755 });
  const cfg = { ...loadConfig(), claudeBin: bin, claudeDir: path.join(home, 'claude-dir') };
  const m = new Monitor(cfg);
  const { jobId } = m.actions.start({ agent: 'claude', cwd: home, prompt: 'first' }, { claudeBin: bin, codexBin: '' });
  const task = m.tasks.customTasks().find((t) => t.id === `dispatch:${jobId}`)!;
  assert.equal(m.continueTask(task, 'then this').queued, true);
  const again = new Monitor(cfg) as unknown as { followUps: Map<string, { prompts: string[] }> };
  assert.deepEqual(again.followUps.get(jobId)?.prompts, ['then this']);
  // let the runs finish before the test process ends
  await until(() => !m.actions.hasRunning(), 10_000);
});

test('an instruction to a finished run continues it as one task: the new run takes the old one’s place', { skip: process.platform === 'win32' }, async () => {
  const { loadConfig } = await import('../src/core/config');
  const { Monitor } = await import('../src/core/monitor');
  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho ok\n`, { mode: 0o755 });
  const m = new Monitor({ ...loadConfig(), claudeBin: bin, claudeDir: path.join(home, 'claude-dir') });
  const { jobId } = m.actions.start({ agent: 'claude', cwd: home, prompt: 'first' }, { claudeBin: bin, codexBin: '' });
  await until(() => !m.actions.hasRunning());
  const done = m.tasks.customTasks().find((t) => t.id === `dispatch:${jobId}`)!;
  const r = m.continueTask(done, 'more');
  assert.equal(r.queued, undefined);
  const ids = m.tasks.customTasks().map((t) => t.id);
  assert.ok(!ids.includes(done.id), 'the old run makes way');
  assert.equal(m.tasks.customTasks().find((t) => t.id === `dispatch:${r.jobId}`)?.continuedFrom, done.id);
  await until(() => !m.actions.hasRunning());
});

test('Codex resumes place exec options before resume and preserve run settings', { skip: process.platform === 'win32' }, async (t) => {
  const { ActionRunner } = await import('../src/core/actions');
  const bin = path.join(home, 'codex-args');
  // Capture the actual process arguments and stdin without starting a model run.
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconsole.log(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }));\n`, { mode: 0o755 });
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const prompt = 'Continue with "quoted text"\nand a second line';
  const permissions: RunOptions['permission'][] = [undefined, 'auto', 'edits', 'ask', 'default'];
  for (const kind of ['codex', 'dispatch']) {
    for (const permission of permissions) {
      await t.test(`${kind}, permission=${permission ?? 'omitted'}`, async () => {
        const runner = new ActionRunner(() => {});
        const { jobId } = runner.continue(
          { id: 'codex-test', kind, provider: 'openai', title: 'Test', state: 'done', updatedAt: '', cwd: home },
          sessionId, prompt, { claudeBin: '', codexBin: bin },
          { model: 'test-model', effort: 'high', permission },
        );
        await until(() => !runner.hasRunning());
        const { args, input }: { args: string[]; input: string } = JSON.parse(runner.jobOutput(jobId)!);
        assert.equal(args[0], 'exec');
        const resume = args.indexOf('resume');
        assert.ok(resume > 0);
        assert.deepEqual(args.slice(resume + 1), [sessionId, '-']);
        assert.equal(args[args.indexOf('-m') + 1], 'test-model');
        assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort="high"');
        const sandbox = args.indexOf('--sandbox');
        if (permission === undefined || permission === 'auto' || permission === 'edits') {
          assert.ok(sandbox > 0 && sandbox < resume, '--sandbox belongs to exec, before resume');
          assert.equal(args[sandbox + 1], 'workspace-write');
        } else {
          assert.equal(sandbox, -1, 'ask/default preserve the CLI permission settings');
        }
        assert.equal(input, prompt);
        assert.equal(runner.jobList()[0].sessionId, sessionId);
      });
    }
  }
});
