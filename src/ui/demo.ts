// Demo mode (?demo): the whole UI runs on made-up but realistic data, with no
// server. Used for the README screenshots and for trying the UI out.
import { discardCrop, displayCrop, draw, farmView, growMinutes, harvest, newFarm, plant, storeCrop, uproot, type FarmState, type Rarity, type SeedColor } from '../shared/farm';
import { cleanProfile, publicFarm, type FarmProfile, type FarmSocialView, type FriendFarm, type PublicFarm } from '../shared/farmSocial';
import type {
  DailyUsage,
  LaunchOptions,
  OfficialRemoteState,
  ProjectUsage,
  ProviderSnapshot,
  PublicSettings,
  QuotaWindow,
  ResourceSnapshot,
  ServerInfo,
  SkillDetail,
  SkillInfo,
  Snapshot,
  TaskInfo,
  TokenTotals,
} from '../shared/types';

export const isDemo = () => {
  try {
    return new URLSearchParams(location.search).has('demo');
  } catch {
    return false;
  }
};

const now = Date.now();
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const inH = (h: number) => new Date(now + h * 3600_000).toISOString();
const day = (d: number) => {
  const x = new Date(now - d * 86400_000);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
// deterministic "random" so screenshots are stable
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function totals(total: number, costPerM: number): TokenTotals {
  const cacheRead = Math.round(total * 0.82);
  const cacheWrite = Math.round(total * 0.08);
  const output = Math.round(total * 0.03);
  const input = total - cacheRead - cacheWrite - output;
  return { input, output, cacheRead, cacheWrite, total, messages: Math.round(total / 260_000), cost: (total / 1e6) * costPerM };
}

function daily(models: [string, number, number][], days = 30): DailyUsage[] {
  return Array.from({ length: days }, (_, i) => {
    const d = days - 1 - i;
    const weekday = new Date(now - d * 86400_000).getDay();
    const busy = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const byModel: Record<string, TokenTotals> = {};
    let sum = 0;
    for (const [m, base, price] of models) {
      const v = Math.round(base * busy * (0.55 + rnd() * 0.9));
      byModel[m] = totals(v, price);
      sum += v;
    }
    return { date: day(d), totals: totals(sum, 0.45), byModel };
  });
}

function project(name: string, share: number, all: number, forge: ProjectUsage['forge'] = 'github'): ProjectUsage {
  const total = Math.round(all * share);
  return {
    key: `/home/dev/src/${name}`,
    name,
    total: totals(total, 0.45),
    today: totals(Math.round(total * 0.06), 0.45),
    last7d: totals(Math.round(total * 0.3), 0.45),
    byModel: { 'claude-opus-5-5': totals(Math.round(total * 0.7), 0.5), 'claude-sonnet-5-5': totals(Math.round(total * 0.3), 0.3) },
    spark: Array.from({ length: 14 }, () => Math.round((total / 30) * (0.3 + rnd() * 1.4))),
    lastActive: ago(600 + rnd() * 80_000),
    webUrl: `https://github.com/acme/${name}`,
    forge,
  };
}

const q = (id: string, label: string, kind: QuotaWindow['kind'], percent: number, resetH: number, rate: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => {
  const projected = percent + rate * resetH;
  return {
    id,
    label,
    kind,
    percent,
    resetsAt: inH(resetH),
    severity: percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal',
    windowMinutes: kind === 'session' ? 300 : 10080,
    forecast: {
      ratePerHour: rate,
      basis: 'recent',
      windowRatePerHour: rate * 0.8,
      projectedAtReset: projected,
      willExhaustBeforeReset: projected > 100,
      exhaustAt: projected > 100 ? new Date(now + ((100 - percent) / rate) * 3600_000).toISOString() : undefined,
    },
    ...extra,
  };
};

function snapshot(): Snapshot {
  const claudeDaily = daily([
    ['claude-opus-5-5', 52_000_000, 0.5],
    ['claude-sonnet-5-5', 21_000_000, 0.3],
    ['claude-haiku-4-5', 4_000_000, 0.1],
  ]);
  const codexDaily = daily([
    ['gpt-6.1-sol', 9_000_000, 0],
    ['gpt-6-astra', 2_500_000, 0],
  ]);
  const sumOf = (d: DailyUsage[]) => d.reduce((a, x) => a + x.totals.total, 0);
  const claude: ProviderSnapshot = {
    provider: 'claude',
    name: 'Claude',
    plan: { name: 'Claude Max 5x', status: 'active', renewsAt: inH(24 * 9), renewsEstimated: true },
    quotas: [
      q('session', '5-hour session', 'session', 38, 2.4, 9),
      q('weekly_all', 'Weekly · all models', 'weekly', 54, 52, 0.4),
      q('weekly_scoped:Opus', 'Weekly · Opus', 'weekly', 81, 52, 0.45),
    ],
    quotasObservedAt: ago(40),
    daily: claudeDaily,
    today: claudeDaily.at(-1)!.totals,
    last5h: totals(31_000_000, 0.45),
    sources: [],
    projects: [project('acme-web', 0.38, sumOf(claudeDaily)), project('ml-pipeline', 0.27, sumOf(claudeDaily)), project('infra', 0.16, sumOf(claudeDaily), 'gitlab'), project('docs-site', 0.09, sumOf(claudeDaily))],
    unpricedModels: [],
  };
  const openai: ProviderSnapshot = {
    provider: 'openai',
    name: 'ChatGPT',
    plan: { name: 'ChatGPT Pro', renewsAt: inH(24 * 19), renewsEstimated: true },
    quotas: [q('codex-primary_window', 'Weekly window', 'weekly', 23, 80, 0.12), q('extra-x', 'Reserve · Weekly window', 'other', 6, 140, 0.02)],
    quotasObservedAt: ago(30),
    daily: codexDaily,
    today: codexDaily.at(-1)!.totals,
    last5h: totals(6_200_000, 0),
    sources: [],
    projects: [project('ml-pipeline', 0.6, sumOf(codexDaily)), project('acme-web', 0.4, sumOf(codexDaily))],
    unpricedModels: ['gpt-6.1-sol', 'gpt-6-astra'],
    resetCredits: { available: 2, usableNow: 0 },
  };
  const tasks: TaskInfo[] = [
    {
      id: 'claude:11111111-1111-4111-8111-111111111111',
      kind: 'claude-code',
      provider: 'claude',
      title: 'Checkout refactor',
      state: 'running',
      alive: true,
      ide: 'vscode',
      canContinue: true,
      cwd: '/home/dev/src/acme-web',
      startedAt: ago(1500),
      updatedAt: ago(3),
      workload: { tokensPerMin: 21_400, sessionTokens: 3_900_000, contextTokens: 238_000, contextWindow: 1_000_000, model: 'claude-opus-5-5', effort: 'high' },
      activity: {
        plan: {
          done: 3,
          total: 5,
          current: 'Moving price rules into the cart service',
          steps: [
            { text: 'Map the checkout flow', status: 'completed' },
            { text: 'Extract the cart service', status: 'completed' },
            { text: 'Port the coupon tests', status: 'completed' },
            { text: 'Move price rules into the cart service', status: 'in_progress' },
            { text: 'Run the e2e suite', status: 'pending' },
          ],
        },
        feed: [
          { kind: 'prompt', ts: ago(1500), text: 'Split the checkout page into a cart service and keep every test green' },
          { kind: 'tool', ts: ago(90), verb: 'read', text: 'src/cart/pricing.ts' },
          { kind: 'say', ts: ago(40), text: 'The discount stacking lives in two places — consolidating it in the service.' },
          { kind: 'tool', ts: ago(6), verb: 'edit', text: 'src/cart/service.ts' },
        ],
      },
    },
    {
      id: 'codex:22222222-2222-4222-8222-222222222222',
      kind: 'codex',
      provider: 'openai',
      title: 'Faster data loader',
      state: 'running',
      ide: 'vscode',
      canContinue: true,
      cwd: '/home/dev/src/ml-pipeline',
      startedAt: ago(900),
      updatedAt: ago(5),
      workload: { tokensPerMin: 8_200, sessionTokens: 1_200_000, contextTokens: 96_000, contextWindow: 258_000, model: 'gpt-6.1-sol', effort: 'xhigh' },
      activity: {
        feed: [
          { kind: 'say', ts: ago(120), text: 'Profiling shows 70% of the time in JPEG decode — switching to a worker pool.' },
          { kind: 'tool', ts: ago(8), verb: 'run', text: 'pytest tests/test_loader.py -q' },
        ],
      },
    },
    {
      id: 'claude:33333333-3333-4333-8333-333333333333',
      kind: 'claude-code',
      provider: 'claude',
      title: 'Terraform plan review',
      state: 'waiting',
      alive: true,
      ide: 'terminal',
      canContinue: true,
      cwd: '/home/dev/src/infra',
      detail: '🔐 Bash: terraform apply plan.out',
      permissions: [{ id: 'aaaaaaaaaaaa', jobId: 'dispatch-demo', tool: 'Bash', summary: 'terraform apply plan.out', createdAt: ago(30) }],
      updatedAt: ago(30),
      workload: { tokensPerMin: 0, sessionTokens: 640_000, contextTokens: 88_000, contextWindow: 1_000_000, model: 'claude-sonnet-5-5', effort: 'medium' },
      activity: { feed: [{ kind: 'tool', ts: ago(32), verb: 'ask', text: 'Apply the plan to staging?' }] },
    },
    {
      id: 'claude:44444444-4444-4444-8444-444444444444',
      kind: 'claude-code',
      provider: 'claude',
      title: 'Docs: API reference',
      state: 'idle',
      alive: true,
      ide: 'vscode',
      canContinue: true,
      cwd: '/home/dev/src/docs-site',
      updatedAt: ago(420),
      finishedAt: ago(400),
      workload: { tokensPerMin: 0, sessionTokens: 410_000, model: 'claude-opus-5-5', effort: 'high' },
      activity: { feed: [{ kind: 'say', ts: ago(400), text: 'All 42 endpoints documented, examples run against the mock server.' }] },
    },
    {
      id: 'remote:gpu:custom:train',
      kind: 'custom',
      title: 'Train vision model',
      state: 'running',
      progress: 64,
      detail: 'epoch 32/50 · val acc 91.8%',
      host: 'gpu-box',
      updatedAt: ago(20),
      startedAt: ago(14_000),
    },
    // put away with "Archive inactive"
    { id: 'claude:55555555-5555-4555-8555-555555555555', kind: 'claude-code', provider: 'claude', title: 'Fix flaky login test', state: 'idle', canContinue: true, cwd: '/home/dev/src/acme-web', updatedAt: ago(26_000), archived: true },
    { id: 'codex:66666666-6666-4666-8666-666666666666', kind: 'codex', provider: 'openai', title: 'Bump dependencies', state: 'done', canContinue: true, cwd: '/home/dev/src/ml-pipeline', updatedAt: ago(52_000), archived: true },
  ];
  return {
    generatedAt: ago(0),
    providers: [claude, openai],
    tasks,
    pet: { mood: 'working', message: '3 tasks running' },
    pets: { claude: { mood: 'working', message: '2 tasks running' }, openai: { mood: 'working', message: 'Faster data loader' } },
    petConfig: { enabled: true, size: 140, character: 'duo', claudePet: 'crab', codexPet: 'bot' },
    historyDays: 30,
    machineName: 'workstation',
    remotes: [
      {
        id: 'gpu',
        name: 'gpu-box',
        url: 'http://192.168.1.40:8787/',
        online: true,
        updatedAt: ago(15),
        providers: [{ provider: 'claude', name: 'Claude', quotas: [q('session', '5-hour session', 'session', 38, 2.4, 9)] }],
      },
    ],
    official: demoOfficial,
  };
}

const demoOfficial: OfficialRemoteState = {
  claude: [{ cwd: '/home/dev/src/acme-web', name: 'workstation · acme-web', state: 'ready', url: 'https://claude.ai/code?environment=env_demo', startedAt: ago(600) }],
  codex: { state: 'on', serverName: 'workstation' },
};

function resources(): ResourceSnapshot {
  const history = Array.from({ length: 120 }, (_, i) => ({
    at: new Date(now - (119 - i) * 5000).toISOString(),
    cpu: Math.round(28 + 22 * Math.sin(i / 9) + rnd() * 12),
    mem: Math.round(46 + i / 12 + rnd() * 2),
    gpu: Math.round(70 + 20 * Math.sin(i / 14) + rnd() * 6),
    gpuMem: 61,
  }));
  return {
    at: ago(0),
    host: 'workstation',
    platform: 'Linux 6.8.0',
    uptimeSec: 3 * 86400 + 5 * 3600,
    cpu: { model: 'AMD Ryzen 9 7950X', cores: 16, percent: history.at(-1)!.cpu, perCore: Array.from({ length: 16 }, () => Math.round(10 + rnd() * 70)), load: [5.2, 4.8, 4.1] },
    memory: { total: 64 * 2 ** 30, used: 33.6 * 2 ** 30, available: 30.4 * 2 ** 30, swapTotal: 8 * 2 ** 30, swapUsed: 0 },
    gpus: [
      {
        index: 0,
        name: 'NVIDIA RTX 4090',
        util: history.at(-1)!.gpu!,
        memUsed: 14.7 * 2 ** 30,
        memTotal: 24 * 2 ** 30,
        tempC: 67,
        powerW: 312,
        powerLimitW: 450,
        processes: [{ pid: 48211, name: 'python3', mem: 14.1 * 2 ** 30 }],
      },
    ],
    disks: [
      { mount: '/', fs: 'ext4', total: 1000 * 2 ** 30, used: 612 * 2 ** 30, free: 388 * 2 ** 30 },
      { mount: '/data', fs: 'ext4', total: 4000 * 2 ** 30, used: 3560 * 2 ** 30, free: 440 * 2 ** 30 },
    ],
    processes: [
      { pid: 48211, name: 'python3', cpu: 312, rss: 9.2 * 2 ** 30 },
      { pid: 2210, name: 'claude', cpu: 14.5, rss: 410 * 2 ** 20, agent: 'claude' },
      { pid: 2388, name: 'codex', cpu: 9.1, rss: 220 * 2 ** 20, agent: 'codex' },
      { pid: 1730, name: 'code', cpu: 6.2, rss: 1.6 * 2 ** 30 },
      { pid: 912, name: 'postgres', cpu: 3.4, rss: 540 * 2 ** 20 },
    ],
    history,
  };
}

const skills: SkillInfo[] = [
  { id: 'aaaaaaaaaaa1', slug: 'release-checklist', name: 'release-checklist', description: 'Steps to cut a release: changelog, version bump, tag, smoke-test the installers.', source: 'library', path: '/home/dev/.vibeportal/skills/release-checklist/SKILL.md', dir: '/home/dev/.vibeportal/skills/release-checklist', updatedAt: ago(3600), manual: true, installed: ['claude'] },
  { id: 'aaaaaaaaaaa2', slug: 'flaky-test-hunt', name: 'flaky-test-hunt', description: 'Reproduce and fix flaky tests: rerun with seeds, bisect, isolate shared state.', source: 'library', path: '/home/dev/.vibeportal/skills/flaky-test-hunt/SKILL.md', dir: '/home/dev/.vibeportal/skills/flaky-test-hunt', updatedAt: ago(7200), origin: '/home/dev/src/acme-web/.claude/skills/flaky-test-hunt', archivedAt: ago(7200) },
  { id: 'aaaaaaaaaaa3', slug: 'gpu-profiling', name: 'gpu-profiling', description: 'Profile CUDA kernels with nsys / ncu and summarise the hot spots.', source: 'project', project: '/home/dev/src/ml-pipeline', path: '/home/dev/src/ml-pipeline/.claude/skills/gpu-profiling/SKILL.md', dir: '/home/dev/src/ml-pipeline/.claude/skills/gpu-profiling', updatedAt: ago(86_400) },
  { id: 'aaaaaaaaaaa4', slug: 'pdf', name: 'pdf', description: 'Read, merge, split and fill PDF files.', source: 'claude', managed: true, path: '/home/dev/.claude/skills/pdf/SKILL.md', dir: '/home/dev/.claude/skills/pdf', updatedAt: ago(5 * 86_400) },
];

const info: ServerInfo = {
  version: 'demo',
  mode: 'web',
  hookUrl: 'http://127.0.0.1:8787/api/hooks/claude',
  taskUrl: 'http://127.0.0.1:8787/api/tasks',
  authRequired: true,
  machineName: 'workstation',
  boundHost: '0.0.0.0',
  port: 8787,
  lanUrls: ['http://192.168.1.20:8787'],
  discovered: [],
  viewerLocal: true,
  instanceId: 'demo0001',
  passwordSet: true,
  publicUrl: 'https://workstation-demo.ngrok-free.app',
  tunnel: { state: 'on', provider: 'ngrok', url: 'https://workstation-demo.ngrok-free.app' },
};

const settings: PublicSettings = {
  claudeDir: '/home/dev/.claude',
  codexDir: '/home/dev/.codex',
  historyDays: 30,
  pollSeconds: 15,
  subscriptionPollSeconds: 300,
  warnPercent: 75,
  criticalPercent: 90,
  notifications: true,
  pet: { enabled: true, size: 140, character: 'duo', claudePet: 'crab', codexPet: 'bot' },
  suggestModel: 'haiku',
  anthropicAdminKeySet: false,
  openaiAdminKeySet: false,
  launchAtLogin: true,
  remoteAccess: true,
  machineName: 'workstation',
  hosts: [{ id: 'gpu', name: 'gpu-box', url: 'http://192.168.1.40:8787/' }],
  passwordSet: true,
  publicTunnel: true,
  tunnelProvider: 'ngrok',
  ngrokDomain: '',
  ngrokAuthtokenSet: false,
  publicUrl: '',
  googleClientId: '1234567890-demo.apps.googleusercontent.com',
  googleOwners: ['you@gmail.com'],
};

const launch: LaunchOptions = {
  projects: ['acme-web', 'ml-pipeline', 'infra', 'docs-site'].map((n, i) => ({
    path: `/home/dev/src/${n}`,
    name: n,
    sources: i < 2 ? ['claude', 'open'] : ['vscode'],
    lastUsed: ago(i * 3600),
    git: true,
  })),
  agents: {
    claude: { available: true, models: ['fable', 'opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: 'opus', defaultEffort: 'high' },
    codex: { available: true, models: ['gpt-6.1-sol', 'gpt-6-astra'], efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], defaultModel: 'gpt-6.1-sol', defaultEffort: 'xhigh' },
  },
};

let snap: Snapshot | null = null;
export const demoSnapshot = () => (snap ??= snapshot());

/** Answers the API calls the UI makes, so every page renders. */
export function demoCall(method: string, path: string, body?: unknown): unknown {
  const p = path.replace(/\?.*$/, '');
  if (p === 'api/farm' || p.startsWith('api/farm/')) return demoFarmCall(p, body);
  if (p === 'api/snapshot' || p === 'api/refresh') return demoSnapshot();
  if (p === 'api/info') return info;
  if (p === 'api/settings') return settings;
  if (p === 'api/launch/options') return launch;
  if (p === 'api/resources') return resources();
  if (p === 'api/skills') return skills;
  if (/^api\/skills\/\w+$/.test(p)) {
    const s = skills.find((x) => p.endsWith(x.id)) ?? skills[0];
    return { ...s, body: `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\n1. …\n2. …\n`, files: ['SKILL.md'] } satisfies SkillDetail;
  }
  if (p === 'api/official') return demoOfficial;
  if (p === 'api/tunnel/check') return { installed: true, version: '3.39.11', token: 'ngrok-config' };
  if (/\/history$/.test(p)) {
    const t = demoSnapshot().tasks.find((x) => p.includes(encodeURIComponent(x.id)));
    const items = (t?.activity?.feed ?? []).map((f) =>
      f.kind === 'tool' ? { role: 'tool' as const, verb: f.verb, tool: f.tool, text: f.text ?? '', ts: f.ts } : { role: f.kind === 'prompt' ? ('user' as const) : ('assistant' as const), text: f.text ?? '', ts: f.ts },
    );
    return { items, truncated: false };
  }
  if (/\/context$/.test(p)) {
    const t = demoSnapshot().tasks.find((x) => p.includes(encodeURIComponent(x.id)));
    const feed = t?.activity?.feed ?? [];
    return {
      lastPrompt: feed.find((f) => f.kind === 'prompt')?.text ?? `Continue: ${t?.title ?? ''}`,
      lastReply: [...feed].reverse().find((f) => f.kind === 'say' || f.kind === 'tool')?.text ?? t?.detail,
    };
  }
  if (p === 'api/hooks/snippet') return { hooks: {} };
  if (method !== 'GET') return { ok: true };
  return {};
}

// ── the crab farm, in memory: a few draws' worth of tokens and a half-grown field ──
let demoFarm: FarmState | undefined;
function demoFarmCall(p: string, body: unknown): unknown {
  if (!demoFarm) {
    const now = Date.now();
    const f = newFarm(new Date(now - 3 * 86400_000).toISOString().slice(0, 10));
    for (let d = 0; d < 3; d++) f.days[new Date(now - d * 86400_000).toISOString().slice(0, 10)] = 2_400_000 + d * 700_000;
    draw(f, 10);
    f.seeds.slice(0, 5).forEach((s, i) => plant(f, i * 2, s.id, now - (i + 1) * growMinutes(s.species) * 15_000));
    harvest(f, 0, now + 864e5);
    // a few lucky finds on the shelf, so the showcase shows off the rarer kinds
    f.crops.push(
      { id: 'demo-crop-1', species: 'worldtree', rarity: 'mythic', color: 'rainbow', harvestedAt: now - 2 * 86400_000 },
      { id: 'demo-crop-2', species: 'phoenix', rarity: 'legendary', color: 'red', harvestedAt: now - 30 * 3600_000 },
      { id: 'demo-crop-3', species: 'cherry', rarity: 'epic', color: 'pink', harvestedAt: now - 20 * 3600_000 },
      { id: 'demo-crop-4', species: 'lavender', rarity: 'rare', color: 'purple', mutated: true, harvestedAt: now - 9 * 3600_000 },
    );
    f.stored.push(
      { id: 'demo-crop-5', species: 'tulip', rarity: 'common', color: 'yellow', harvestedAt: now - 3 * 86400_000 },
      { id: 'demo-crop-6', species: 'daisy', rarity: 'common', color: 'white', harvestedAt: now - 3 * 86400_000 },
    );
    f.seeds.push({ id: 'demo-seed-mythic', species: 'moonflower', rarity: 'mythic', color: 'white' });
    demoFarm = f;
  }
  if (p === 'api/farm') return farmView(demoFarm);
  if (p.startsWith('api/farm/social')) {
    const b = (body ?? {}) as { profile?: FarmProfile; public?: boolean };
    if (b.profile) demoSocial.profile = cleanProfile(b.profile);
    if (typeof b.public === 'boolean') demoSocial.public = b.public;
    return demoSocial;
  }
  if (p === 'api/farm/friends/water') return { friend: demoFriends()[0], result: { minutes: 20, plants: 2 } };
  if (p === 'api/farm/friends') return demoFriends();
  const b = (body ?? {}) as Record<string, unknown>;
  const s = demoFarm;
  let result: unknown;
  const action = p.slice('api/farm/'.length);
  if (action === 'draw') result = draw(s, Number(b.count) || 1);
  else if (action === 'plant') plant(s, Number(b.plot), String(b.seedId));
  else if (action === 'harvest') result = harvest(s, Number(b.plot));
  else if (action === 'uproot') uproot(s, Number(b.plot));
  else if (action === 'store') storeCrop(s, String(b.cropId));
  else if (action === 'display') displayCrop(s, String(b.cropId));
  else if (action === 'discard') discardCrop(s, String(b.cropId));
  return { farm: farmView(s), result };
}

// ── the farm's social side (made-up farmers) ──
const demoSocial: FarmSocialView = {
  profile: { name: 'Ada', bio: 'Ships with a crab on her desk', github: 'ada-dev', linkedin: 'https://www.linkedin.com/in/ada-dev', x: 'ada_dev' },
  public: true,
  shareId: 'demo0farm0share0id0',
  publicUrl: 'https://ada.example.ngrok.app/',
  visitors: [
    { name: 'Grace', github: 'grace-h', farm: 'https://grace.example.dev/#/visit/demo0grace0farm0id0', at: Date.now() - 40 * 60_000 },
    { name: 'Linus', at: Date.now() - 5 * 3600_000 },
  ],
  friends: [
    { url: 'https://grace.example.dev/#/visit/demo0grace0farm0id0', addedAt: Date.now() - 86400_000 },
    { url: 'https://kenji.example.dev/#/visit/demo0kenji0farm0id0', addedAt: Date.now() - 3 * 86400_000 },
  ],
};

function demoFriendFarm(id: string, profile: FarmProfile, crops: [string, Rarity, SeedColor][], tokens: number): PublicFarm {
  const now = Date.now();
  const f = newFarm('2026-09-01');
  f.days['2026-09-01'] = tokens;
  crops.forEach(([species, rarity, color], i) => f.crops.push({ id: `${id}-${i}`, species, rarity, color, harvestedAt: now - i * 3600_000 }));
  f.plots[0] = { seed: { id: 's', species: 'rose', rarity: 'rare', color: 'red' }, plantedAt: now - 3600_000, readyAt: now + 2 * 3600_000 };
  f.plots[4] = { seed: { id: 't', species: 'tulip', rarity: 'common', color: 'yellow' }, plantedAt: now - 3600_000, readyAt: now - 60_000 };
  return publicFarm(id, profile, farmView(f, now), { waterToday: 3, visitors: [{ name: 'Ada', github: 'ada-dev', at: now - 20 * 60_000 }], friends: 4 });
}

function demoFriends(): FriendFarm[] {
  return [
    {
      url: demoSocial.friends[0].url,
      farm: demoFriendFarm('demo0grace0farm0id0', { name: 'Grace', bio: 'Compilers & crabs', github: 'grace-h', linkedin: 'https://www.linkedin.com/in/grace-h' }, [
        ['dragonblood', 'mythic', 'gold'],
        ['startree', 'legendary', 'blue'],
        ['crystal', 'epic', 'purple'],
        ['orchid', 'rare', 'pink'],
        ['sunflower', 'fine', 'yellow'],
        ['daisy', 'common', 'white'],
      ], 1_900_000_000),
    },
    {
      url: demoSocial.friends[1].url,
      farm: demoFriendFarm('demo0kenji0farm0id0', { name: 'Kenji', github: 'kenji-k', x: 'kenji_k' }, [
        ['bonsai', 'rare', 'blue'],
        ['pumpkin', 'fine', 'orange'],
        ['carrot', 'common', 'orange'],
        ['clover', 'common', 'blue'],
      ], 420_000_000),
    },
  ];
}

/** A public farm for the visit page in demo mode. */
export function demoPublicFarm(): PublicFarm {
  return demoFriends()[0].farm!;
}
