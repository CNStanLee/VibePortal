import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLog, describeTool, firstSentence } from '../src/core/activity';
import { ClaudeLocalCollector } from '../src/core/collectors/claudeLocal';
import { TaskTracker } from '../src/core/tasks';

test('activity: tool calls map to verbs with repo-relative targets', () => {
  assert.deepEqual(describeTool('Edit', { file_path: '/r/src/a.ts' }, '/r'), { verb: 'edit', text: 'src/a.ts' });
  assert.deepEqual(describeTool('Read', { file_path: '/elsewhere/b.md' }, '/r'), { verb: 'read', text: 'b.md' });
  assert.deepEqual(describeTool('Bash', { command: 'npm test', description: 'Run the tests' }), { verb: 'run', text: 'Run the tests' });
  assert.deepEqual(describeTool('exec_command', { cmd: "python - <<'PY'\nprint(1)\nPY" }), { verb: 'run', text: "python - <<'PY'" });
  assert.deepEqual(describeTool('exec', 'text(await tools.exec_command({cmd:"rg -n foo src",workdir:"/r"}))'), { verb: 'run', text: 'rg -n foo src' });
  assert.deepEqual(describeTool('apply_patch', '*** Begin Patch\n*** Update File: /r/x.ts\n*** Update File: /r/y.ts\n*** End Patch', '/r'), { verb: 'edit', text: 'x.ts +1' });
  assert.deepEqual(describeTool('mcp__srv__do_thing', {}), { verb: 'tool' });
  assert.equal(describeTool('write_stdin', {}), null);
});

test('activity: feed keeps the latest items in time order and de-duplicates hook + transcript copies', () => {
  const log = new ActivityLog();
  const t0 = Date.parse('2026-10-06T10:00:00Z');
  for (let i = 0; i < 8; i++) log.tool('s', t0 + i * 1000, 'Read', { file_path: `/f${i}` });
  log.tool('s', t0 + 20_000, 'Bash', { command: 'make' }, { id: 'toolu_1' }); // via hook
  log.tool('s', t0 + 20_500, 'Bash', { command: 'make' }, { id: 'toolu_1' }); // same call, from the transcript
  log.say('s', t0 + 10_000, '## Done\nAll **tests** pass. Next I will tidy up.');
  const feed = log.get('s')!.feed;
  assert.equal(feed.length, 6);
  assert.deepEqual(
    feed.map((f) => f.text),
    ['f4', 'f5', 'f6', 'f7', 'Done', 'make'],
  );
  assert.equal(firstSentence('All **tests** pass. Next I will tidy up.'), 'All tests pass.');
});

test('activity: plans from TodoWrite, TaskCreate/TaskUpdate and Codex update_plan', () => {
  const log = new ActivityLog();
  log.tool('a', 1, 'TodoWrite', {
    todos: [
      { content: 'Parse logs', status: 'completed', activeForm: 'Parsing logs' },
      { content: 'Draw bubble', status: 'in_progress', activeForm: 'Drawing the bubble' },
      { content: 'Test', status: 'pending', activeForm: 'Testing' },
    ],
  });
  assert.deepEqual({ ...log.get('a')!.plan, steps: undefined }, { done: 1, total: 3, current: 'Drawing the bubble', steps: undefined });
  assert.equal(log.get('a')!.feed.length, 0, 'plan tools stay out of the feed');

  log.tool('b', 1, 'TaskCreate', { subject: 'One', activeForm: 'Doing one' });
  log.tool('b', 2, 'TaskCreate', { subject: 'Two' });
  log.tool('b', 3, 'TaskUpdate', { taskId: '1', status: 'completed' });
  log.tool('b', 4, 'TaskUpdate', { taskId: '2', status: 'in_progress' });
  assert.equal(log.get('b')!.plan!.done, 1);
  assert.equal(log.get('b')!.plan!.current, 'Two');

  log.tool('c', 1, 'update_plan', { plan: [{ step: 'A', status: 'completed' }, { step: 'B', status: 'pending' }] });
  assert.deepEqual([log.get('c')!.plan!.done, log.get('c')!.plan!.current], [1, 'B']);
});

test('activity: claude transcripts and hooks feed the same session log', () => {
  const c = new ClaudeLocalCollector();
  const ts = new Date().toISOString();
  c.ingest({ type: 'ai-title', aiTitle: 'Pet bubble', sessionId: 's1' });
  c.ingest({ type: 'user', sessionId: 's1', timestamp: ts, message: { role: 'user', content: 'show progress on the pet' } });
  c.ingest({ type: 'user', sessionId: 's1', timestamp: ts, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } });
  c.ingest({
    type: 'assistant',
    sessionId: 's1',
    cwd: '/r',
    timestamp: ts,
    message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Edit', input: { file_path: '/r/src/x.tsx' } }], usage: { input_tokens: 1 } },
  });
  c.ingest({ type: 'assistant', sessionId: 's1', isSidechain: true, timestamp: ts, message: { content: [{ type: 'text', text: 'sub-agent chatter' }] } });
  const tracker = new TaskTracker();
  tracker.activity = c.activity;
  tracker.ingestClaudeHook({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_9', tool_input: { file_path: '/r/src/x.tsx' }, cwd: '/r' });
  assert.equal(c.activity.title('s1'), 'Pet bubble');
  assert.deepEqual(
    c.activity.get('s1')!.feed.map((f) => [f.kind, f.verb, f.text]),
    [
      ['prompt', undefined, 'show progress on the pet'],
      ['tool', 'edit', 'src/x.tsx'],
    ],
  );
});

test('plan renewal is projected monthly; reset credits and dollar pools are parsed', async () => {
  const { nextMonthly, parseProfile, parseUsage } = await import('../src/core/collectors/claudeSubscription');
  const { parseResetCredits } = await import('../src/core/collectors/chatgptUsage');
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(nextMonthly('2026-08-12T21:32:08Z', now), '2026-10-12T21:32:08.000Z');
  assert.equal(nextMonthly('2025-10-26T00:34:27Z', now), '2026-10-26T00:34:27.000Z');
  assert.equal(nextMonthly('2026-01-31T00:00:00Z', Date.parse('2026-02-10T00:00:00Z')), '2026-02-28T00:00:00.000Z', 'clamped to short months');
  const plan = parseProfile({ organization: { organization_type: 'claude_max', subscription_status: 'active', subscription_created_at: '2026-08-12T21:32:08Z' } });
  assert.equal(plan.renewsEstimated, true);
  assert.ok(plan.renewsAt);
  assert.deepEqual(parseResetCredits({ rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 } }), { available: 2, usableNow: 0 });
  assert.equal(parseResetCredits({}), undefined);
  const pools = parseUsage({ five_hour: { utilization: 2 }, some_pool: { utilization: 40, limit_dollars: 250, used_dollars: 100, resets_at: '2026-11-05T00:00:00Z' } }, { warn: 75, critical: 90 }).filter((q) => q.id.startsWith('pool:'));
  assert.deepEqual(pools.map((q) => [q.percent, q.usedDollars, q.limitDollars]), [[40, 100, 250]]);
});

test('remote auth: password sessions, public requests never accept the API token', async () => {
  const { applyPatch, checkPassword } = await import('../src/core/config');
  const { authorized, issueSession, validSession, LoginLimiter, authMode } = await import('../src/server/auth');
  const base: any = {
    claudeDir: '/c', codexDir: '/x', historyDays: 30, pollSeconds: 15, subscriptionPollSeconds: 300, warnPercent: 75, criticalPercent: 90,
    notifications: true, pet: { enabled: true, size: 140, character: 'duo', codexPet: 'bot' }, suggestModel: 'haiku', claudeBin: '', codexBin: '', prices: {},
    anthropicAdminKey: '', openaiAdminKey: '', launchAtLogin: false, apiToken: 'tok', port: 8787, remoteAccess: true, machineName: 'm',
    instanceId: 'i', hosts: [], remotePassword: null, sessionSecret: 's0', publicTunnel: false, tunnelProvider: 'localhost.run', ngrokDomain: '', ngrokAuthtoken: '', publicUrl: '', googleClientId: '', googleOwners: [],
  };
  assert.throws(() => applyPatch(base, { publicTunnel: true }), /password/);
  assert.throws(() => applyPatch(base, { remotePassword: 'short' }), /8 characters/);
  const cfg = applyPatch(base, { remotePassword: 'correct horse' });
  assert.ok(checkPassword(cfg, 'correct horse'));
  assert.ok(!checkPassword(cfg, 'wrong'));
  assert.notEqual(cfg.sessionSecret, 's0', 'a new password signs everyone out');

  const req = (addr: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: addr }, headers }) as any;
  const u = (q = '') => new URL(`http://x/api/snapshot${q}`);
  const local = req('127.0.0.1');
  const lan = req('192.168.1.5');
  const tunnel = req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' });
  assert.ok(authorized(local, u('?token=tok'), cfg), 'this machine: token works');
  assert.ok(!authorized(lan, u('?token=tok'), cfg), 'LAN with a password: token links stop working');
  assert.ok(authorized(req('192.168.1.5', { authorization: 'Bearer tok' }), u(), cfg), 'LAN machine-to-machine header still works');
  assert.ok(!authorized(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4', authorization: 'Bearer tok' }), u(), cfg), 'public: never the API token');
  const s = issueSession(cfg);
  assert.ok(validSession(cfg, s.token));
  assert.ok(authorized(tunnel, u(`?token=${s.token}`), cfg), 'public: a password session works');
  assert.ok(!validSession(applyPatch(cfg, { remotePassword: 'another one!' }), s.token), 'changing the password revokes sessions');
  assert.ok(!validSession(cfg, s.token.slice(0, -2) + 'xx'), 'tampered session rejected');
  assert.equal(authMode(tunnel, base), 'password', 'public callers always get the password screen');
  // an SSH relay delivers from 127.0.0.1 with no forwarding headers: the tunnel port marks it
  const { VIA_TUNNEL } = await import('../src/server/auth');
  const ssh = req('127.0.0.1');
  ssh[VIA_TUNNEL] = true;
  assert.ok(!authorized(ssh, u('?token=tok'), cfg), 'tunnel port: API token refused');
  assert.ok(authorized(ssh, u(`?token=${s.token}`), cfg), 'tunnel port: password session works');
  assert.equal(authMode(ssh, cfg), 'password');
  assert.equal(authMode(local, cfg), 'token');

  const lim = new LoginLimiter();
  for (let i = 0; i < 4; i++) lim.fail('ip');
  assert.equal(lim.wait('ip'), 0);
  lim.fail('ip');
  assert.ok(lim.wait('ip') > 0, 'locked out after 5 failures');
});

test('skills: frontmatter, manual skills, auto-archive of task-written skills, install, prompt', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { SkillStore, frontmatter } = await import('../src/core/skills');
  const { writtenFiles } = await import('../src/core/activity');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-skills-'));
  process.env.VIBEPORTAL_HOME = path.join(root, 'home');
  const claudeDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: >\n  Ship the app\n  to prod\n---\nSteps…');

  assert.deepEqual(frontmatter('---\nname: "a b"\ndescription: it\'s fine\n---\n'), { name: 'a b', description: "it's fine" });
  const store = new SkillStore(() => ({ claudeDir, codexDir, projects: [repo] }));
  const proj = store.list(true).find((s) => s.source === 'project')!;
  assert.equal(proj.description, 'Ship the app to prod');
  store.flush(); // first scan: baseline only, nothing archived
  assert.equal(store.list(true).filter((s) => s.source === 'library').length, 0);

  // a task writes a new skill somewhere → archived into the library at the next flush
  const out = path.join(root, 'work', 'lint-fix');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'SKILL.md'), '---\nname: lint-fix\ndescription: Fix lint errors\n---\nRun the linter.');
  fs.writeFileSync(path.join(out, 'helper.sh'), 'echo hi');
  for (const f of writtenFiles('Write', { file_path: path.join(out, 'SKILL.md') })) store.noteWrite(f, { agent: 'claude' });
  assert.deepEqual(writtenFiles('apply_patch', '*** Begin Patch\n*** Add File: a/SKILL.md\n*** End Patch', '/r'), ['/r/a/SKILL.md']);
  store.flush();
  const lib = store.list(true).find((s) => s.source === 'library' && s.name === 'lint-fix')!;
  assert.ok(lib, 'archived');
  assert.equal(lib.origin, out);
  assert.deepEqual(store.get(lib.id)!.files.sort(), ['.vibeportal.json', 'SKILL.md', 'helper.sh']);

  // a project skill edited later is archived too
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(proj.path, later, later);
  store.flush();
  assert.ok(store.list(true).some((s) => s.source === 'library' && s.name === 'deploy'));

  const manual = store.create({ name: 'My Review', description: 'How I review PRs', body: '# Review\nCheck tests.' });
  assert.equal(manual.slug, 'my-review');
  assert.throws(() => store.create({ name: 'My Review', description: 'x', body: '' }), /already exists/);

  store.install(manual.id, 'claude');
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'my-review', 'SKILL.md')));
  assert.deepEqual(store.list(true).find((s) => s.id === manual.id)!.installed, ['claude']);
  store.uninstall(manual.id, 'claude');
  assert.ok(!fs.existsSync(path.join(claudeDir, 'skills', 'my-review')));
  assert.throws(() => store.install(proj.id, 'claude'), /library/);

  assert.match(store.promptFor([manual.id]), /My Review: .*my-review[\\/]SKILL\.md/);
  assert.throws(() => store.promptFor(['nope']), /unknown skill/);
  assert.equal(store.promptFor([]), '');
});

test('tunnel: ngrok static domain and Tailscale Funnel (fake CLIs)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-bin-'));
  // ngrok: fails without a token, prints "started tunnel" with one
  fs.writeFileSync(
    path.join(bin, 'ngrok'),
    `#!/bin/sh\nif [ -z "$NGROK_AUTHTOKEN" ]; then echo '{"lvl":"eror","msg":"session closing","err":"authentication failed: ERR_NGROK_4018"}'; sleep 5; exit 1; fi\necho '{"lvl":"info","msg":"started tunnel","url":"https://vibe-test.ngrok-free.app"}'\nsleep 30\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'tailscale'),
    `#!/bin/sh\ncase "$1" in funnel) exit 0;; status) echo '{"Self":{"DNSName":"box.tail1234.ts.net."}}';; esac\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const { Tunnel } = await import('../src/core/tunnel');
  const until = async (t: InstanceType<typeof Tunnel>, ok: (s: any) => boolean) => {
    for (let i = 0; i < 50 && !ok(t.state); i++) await new Promise((r) => setTimeout(r, 100));
    return t.state;
  };
  const a = new Tunnel(() => {});
  a.sync(true, 18999, 'ngrok', { ngrokDomain: 'vibe-test.ngrok-free.app' });
  const noTok = await until(a, (s) => s.state === 'error');
  assert.equal(noTok.reason, 'auth');
  assert.match(String(noTok.link), /dashboard\.ngrok\.com/);
  a.sync(true, 18999, 'ngrok', { ngrokDomain: 'vibe-test.ngrok-free.app', ngrokAuthtoken: 'x'.repeat(30) });
  assert.deepEqual(await until(a, (s) => s.state === 'on'), { state: 'on', provider: 'ngrok', url: 'https://vibe-test.ngrok-free.app' });
  a.stop();
  const b = new Tunnel(() => {});
  b.sync(true, 18999, 'tailscale');
  assert.equal((await until(b, (s) => s.state === 'on')).url, 'https://box.tail1234.ts.net');
  b.stop();
});

test('Google ID tokens: signature, audience, expiry and verified e-mail are all checked', async () => {
  const crypto = await import('node:crypto');
  const { verifyGoogleIdToken } = await import('../src/server/auth');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'k1', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const sign = (claims: Record<string, unknown>, kid = 'k1') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const cid = 'abc.apps.googleusercontent.com';
  const good = { iss: 'https://accounts.google.com', aud: cid, exp: now + 600, iat: now, email: 'Me@Gmail.com', email_verified: true };
  assert.equal(await verifyGoogleIdToken(sign(good), cid, [jwk]), 'me@gmail.com');
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, aud: 'other.apps.googleusercontent.com' }), cid, [jwk]), /another app/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, exp: now - 3600 }), cid, [jwk]), /expired/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, email_verified: false }), cid, [jwk]), /verified/);
  await assert.rejects(verifyGoogleIdToken(sign({ ...good, iss: 'evil.example' }), cid, [jwk]), /issuer/);
  const t = sign(good);
  const forged = t.slice(0, t.indexOf('.') + 1) + Buffer.from(JSON.stringify({ ...good, email: 'attacker@gmail.com' })).toString('base64url') + t.slice(t.lastIndexOf('.'));
  await assert.rejects(verifyGoogleIdToken(forged, cid, [jwk]), /signature/);
  await assert.rejects(verifyGoogleIdToken(sign(good, 'nope'), cid, [jwk]), /unknown signing key/);
});
