import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TaskInfo } from '../src/shared/types';

// keep archived.json out of the real ~/.vibeportal
process.env.VIBEPORTAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-archive-'));

const task = (id: string, state: TaskInfo['state'], updatedAt = '2026-10-06T10:00:00.000Z'): TaskInfo => ({ id, kind: 'claude-code', title: id, state, updatedAt });

test('archive: only inactive conversations go, and one that moves on comes back', async () => {
  const { TaskArchive } = await import('../src/core/archive');
  const a = new TaskArchive();
  const tasks = [task('run', 'running'), task('wait', 'waiting'), task('idle', 'idle'), task('done', 'done'), task('fail', 'failed')];
  assert.equal(a.archive(tasks), 3);
  const marked = (xs: TaskInfo[]) => a.mark(xs).filter((x) => x.archived).map((x) => x.id);
  assert.deepEqual(marked(tasks), ['idle', 'done', 'fail']);

  // kept on disk: a new store (a restart) sees the same
  assert.deepEqual(new TaskArchive().mark(tasks).filter((x) => x.archived).map((x) => x.id), ['idle', 'done', 'fail']);

  // a new message (updatedAt moves) or a new run brings it back by itself
  assert.deepEqual(marked([task('idle', 'idle', '2026-10-06T11:00:00.000Z'), task('done', 'running'), task('fail', 'failed')]), ['fail']);

  assert.equal(a.restore(['fail']), 1);
  assert.deepEqual(marked(tasks), ['idle', 'done']);
  assert.equal(a.restore(), 2);
  assert.deepEqual(marked(tasks), []);
});
