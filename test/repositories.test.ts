import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cloneRepository, normalizeCloneDir, recentRepositories, repositoryName, type RepositoryCommand } from '../src/core/repositories';
import { launchProjects } from '../src/core/projects';
import { applyPatch, loadConfig, saveConfig, toPublic } from '../src/core/config';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-repositories-'));
const git = async (args: string[]) => (await promisify(execFile)('git', args)).stdout;
process.env.VIBEPORTAL_HOME = path.join(temp, 'config');
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('clone directory has a default, expands home, and survives a config reload', () => {
  const config = loadConfig();
  assert.equal(config.cloneDir, path.join(os.homedir(), 'Projects'));
  assert.equal(normalizeCloneDir(' ~/my projects '), path.join(os.homedir(), 'my projects'));
  const next = applyPatch(config, { cloneDir: path.join(temp, 'custom projects') });
  saveConfig(next);
  assert.equal(toPublic(loadConfig()).cloneDir, next.cloneDir);
  for (const value of ['', 'relative/folder', 'bad\0path']) assert.throws(() => applyPatch(config, { cloneDir: value }), /absolute path/);
});

test('only repository names safe for a child folder are accepted', () => {
  assert.equal(repositoryName('my-org/.github'), 'my-org/.github');
  for (const value of ['../repo', 'owner/..', 'owner/.', 'owner/repo.', '-flag/repo', 'owner/repo/other', 'owner/repo;echo', 'owner/CON', 'owner/NUL.txt', null]) {
    assert.throws(() => repositoryName(value));
  }
});

test('recent repositories include accessible org repos and sort by latest push', async () => {
  const result = await recentRepositories(async (bin, args) => {
    assert.equal(bin, 'gh');
    assert.ok(args.includes('github.com'));
    assert.ok(args.some((s) => s.startsWith('user/repos?sort=pushed')));
    return JSON.stringify([
      { full_name: 'me/old', private: true, pushed_at: '2026-01-01T00:00:00Z', description: 'Old work' },
      { full_name: 'org/new', private: true, pushed_at: '2026-10-01T00:00:00Z', permissions: { pull: true } },
      { full_name: 'org/denied', permissions: { pull: false } },
      { full_name: 'org/disabled', disabled: true },
      { full_name: '../outside' },
    ]);
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.repositories.map((r) => r.fullName), ['org/new', 'me/old']);
  assert.equal(result.repositories[0].private, true);
  assert.equal(result.repositories[1].description, 'Old work');
});

test('without gh, the token git stores for github.com lists the repositories', async () => {
  const calls: string[] = [];
  const result = await recentRepositories(
    async (bin, args, _timeout, input) => {
      calls.push(`${bin} ${args[0]}`);
      if (bin === 'gh') throw new Error('gh: command not found');
      assert.deepEqual(args, ['credential', 'fill']);
      assert.match(input ?? '', /host=github\.com/);
      return 'protocol=https\nhost=github.com\nusername=me\npassword=gho_secret\n';
    },
    async (token, apiPath) => {
      assert.equal(token, 'gho_secret');
      assert.ok(apiPath.startsWith('user/repos?sort=pushed'));
      return [{ full_name: 'me/app', private: true, pushed_at: '2026-10-01T00:00:00Z' }];
    },
  );
  assert.deepEqual(calls, ['gh api', 'git credential']);
  assert.deepEqual(result, { state: 'ready', repositories: [{ fullName: 'me/app', description: '', private: true, pushedAt: '2026-10-01T00:00:00Z' }] });
});

test('a clone falls back to the GitHub CLI when git cannot fetch', async () => {
  const parent = path.join(temp, 'fallback');
  const bins: string[] = [];
  const result = await cloneRepository('acme/web', parent, async (bin) => {
    bins.push(bin);
    if (bin === 'git') throw new Error('Authentication failed');
    return '';
  });
  assert.deepEqual(bins, ['git', 'gh']);
  assert.equal(result.path, path.join(parent, 'web'));
});

test('missing gh, authentication/network failure, and malformed data leave local selection usable', async () => {
  for (const response of [null, 'invalid json', '{}']) {
    const result = await recentRepositories(async () => { if (response === null) throw new Error('unavailable'); return response; });
    assert.deepEqual(result, { state: 'unavailable', repositories: [] });
  }
  assert.deepEqual(await recentRepositories(async () => '[]'), { state: 'ready', repositories: [] });
});

test('clone creates a real working tree under the configured parent and becomes a recent local project', async () => {
  const source = path.join(temp, 'source');
  await git(['init', '--bare', source]);
  const parent = path.join(temp, 'projects with spaces');
  const run: RepositoryCommand = async (bin, args) => {
    assert.equal(bin, 'git');
    assert.deepEqual(args.slice(0, 3), ['clone', '--', 'https://github.com/acme/web.git']);
    assert.equal(args[3], path.join(parent, 'web'));
    await git(['clone', source, args[3]]);
    await git(['-C', args[3], 'remote', 'set-url', 'origin', 'https://github.com/acme/web.git']);
    return '';
  };
  const result = await cloneRepository('acme/web', parent, run);
  assert.equal(result.path, path.join(parent, 'web'));
  assert.equal((await git(['-C', result.path, 'rev-parse', '--is-inside-work-tree'])).trim(), 'true');
  assert.deepEqual(result.sources, ['clone']);
  fs.mkdirSync(path.join(parent, 'not-a-repo'));
  const projects = launchProjects({ claude: [], codex: [] }, parent);
  assert.ok(projects.some((p) => p.path === result.path && p.sources.includes('clone')));
  assert.ok(!projects.some((p) => p.path === path.join(parent, 'not-a-repo')));

  // Reusing the clone must not reset it, pull, or discard local files.
  fs.writeFileSync(path.join(result.path, 'uncommitted.txt'), 'keep');
  const reused = await cloneRepository('acme/web', parent, async (bin, args) => {
    assert.equal(bin, 'git');
    return git(args);
  });
  assert.equal(reused.path, result.path);
  assert.equal(fs.readFileSync(path.join(reused.path, 'uncommitted.txt'), 'utf8'), 'keep');
});

test('existing unrelated directories, files, and different-owner clones are never overwritten', async () => {
  const parent = path.join(temp, 'conflicts');
  fs.mkdirSync(path.join(parent, 'web', '.git'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'web', 'keep'), 'important');
  await assert.rejects(cloneRepository('acme/web', parent, async () => 'git@github.com:someone/web.git'), /already exists/);
  assert.equal(fs.readFileSync(path.join(parent, 'web', 'keep'), 'utf8'), 'important');
  fs.writeFileSync(path.join(parent, 'file'), 'keep');
  await assert.rejects(cloneRepository('acme/file', parent, async () => { throw new Error('must not run'); }), /already exists/);
  assert.equal(fs.readFileSync(path.join(parent, 'file'), 'utf8'), 'keep');
});

test('SSH origins reuse an existing clone without invoking gh', async () => {
  const parent = path.join(temp, 'ssh');
  fs.mkdirSync(path.join(parent, 'web', '.git'), { recursive: true });
  const result = await cloneRepository('ACME/web', parent, async (bin) => {
    assert.equal(bin, 'git');
    return 'git@github.com:acme/web.git\n';
  });
  assert.equal(result.path, path.join(parent, 'web'));
});

test('failed clones clean up only their reserved destination and allow retries', async () => {
  const parent = path.join(temp, 'retry');
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, 'keep'), 'untouched');
  await assert.rejects(cloneRepository('acme/web', parent, async () => { throw new Error('offline'); }), /Could not clone/);
  assert.equal(fs.existsSync(path.join(parent, 'web')), false);
  assert.equal(fs.readFileSync(path.join(parent, 'keep'), 'utf8'), 'untouched');
  const result = await cloneRepository('acme/web', parent, async () => '');
  assert.equal(result.path, path.join(parent, 'web'));
});

test('concurrent clones cannot reuse or remove an in-progress checkout', async () => {
  const parent = path.join(temp, 'concurrent');
  let finish!: () => void;
  const first = cloneRepository('acme/web', parent, () => new Promise((resolve) => { finish = () => resolve(''); }));
  await assert.rejects(cloneRepository('acme/web', parent, async () => ''), /already being cloned/);
  assert.ok(fs.existsSync(path.join(parent, 'web')));
  finish();
  await first;
});
