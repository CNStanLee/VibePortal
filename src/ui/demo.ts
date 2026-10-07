import { calendarEvents, RESET_POSTS, resetOutlook } from '../shared/resets';
// Demo mode (?demo): the whole UI runs on made-up but realistic data, with no
// server. Used for the README screenshots and for trying the UI out.
import { buyBait, cast, claimAd, reel, sellCrop, sellDuplicates, sellFish, startAd, takeRod, discardCrop, displayCrop, draw, farmView, growMinutes, harvest, newFarm, plant, storeCrop, uproot, type FarmState, type Rarity, type SeedColor } from '../shared/farm';
import { DEFAULT_GRANTS, autoLayout, cascadeGrants, childrenOf, specOf, costPerToken, estimateNode, newOfficeId, type OfficeNode, type OfficeRun, type OfficeTeam, type OfficeView } from '../shared/office';
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
  SkillGraph,
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
  ...(
    [
      ['b1', 'pr-review', 'Review a pull request: risky diffs first, tests, naming, a summary comment.', 'library'],
      ['b2', 'changelog', 'Write the changelog entry from merged PRs since the last tag.', 'library'],
      ['b3', 'semver-bump', 'Pick the next version from the changes and bump it everywhere.', 'library'],
      ['b4', 'ci-debug', 'Find why CI fails: read the logs, reproduce locally, fix the flaky step.', 'claude'],
      ['b5', 'e2e-tests', 'Write Playwright end-to-end tests for a user flow.', 'claude'],
      ['b6', 'docker-build', 'Build small, cached Docker images for the service.', 'codex'],
      ['b7', 'k8s-deploy', 'Roll a build out to Kubernetes with a canary and a rollback plan.', 'codex'],
      ['b8', 'dataset-clean', 'Clean and validate a training dataset: dedupe, schema checks, splits.', 'project'],
      ['b9', 'cuda-kernels', 'Write and tune CUDA kernels for the hot loops.', 'project'],
      ['ba', 'xlsx', 'Read, edit and chart spreadsheets.', 'claude'],
      ['bb', 'api-docs', 'Document every endpoint with runnable examples.', 'library'],
    ] as const
  ).map(([k, slug, description, source]): SkillInfo => ({
    id: `aaaaaaaaaa${k}`,
    slug,
    name: slug,
    description,
    source,
    ...(source === 'project' ? { project: '/home/dev/src/ml-pipeline' } : {}),
    ...(source === 'claude' && slug === 'xlsx' ? { managed: true } : {}),
    path: `/home/dev/.vibeportal/skills/${slug}/SKILL.md`,
    dir: `/home/dev/.vibeportal/skills/${slug}`,
    updatedAt: ago(86_400 * 2),
  })),
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
  cloneDir: '/home/dev/Projects',
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
  if (p === 'api/resets' || p === 'api/resets/refresh') {
    const providers = demoSnapshot().providers.map((p) => ({ ...p, quotasObservedAt: new Date().toISOString() }));
    return { events: calendarEvents(providers, [], RESET_POSTS), posts: RESET_POSTS, outlook: resetOutlook(RESET_POSTS), feed: { state: 'cached' } };
  }
  if (p === 'api/resets/posts') throw new Error('Post imports are unavailable in demo mode');
  if (p === 'api/office' || p.startsWith('api/office/')) return demoOfficeCall(method, p, body);
  if (p === 'api/snapshot' || p === 'api/refresh') return demoSnapshot();
  if (p === 'api/info') return info;
  if (p === 'api/settings') {
    if (method === 'PUT' && typeof (body as { cloneDir?: string })?.cloneDir === 'string') settings.cloneDir = (body as { cloneDir: string }).cloneDir.replace(/^~(?=\/|$)/, '/home/dev');
    return settings;
  }
  if (p === 'api/launch/options') return launch;
  if (p === 'api/repositories') return {
    state: 'ready',
    repositories: ['acme-web', 'ml-pipeline', 'infra', 'docs-site'].map((name, i) => ({ fullName: `acme/${name}`, description: ['Customer dashboard and web app', 'Training and evaluation pipelines', 'Infrastructure and deployment', 'Product documentation'][i], private: i !== 3, pushedAt: ago(i * 3600) })),
  };
  if (p === 'api/repositories/clone' && method === 'POST') {
    const name = String((body as { fullName: string }).fullName).split('/')[1];
    const project = { path: `${settings.cloneDir}/${name}`, name, sources: ['clone' as const], git: true, lastUsed: ago(0) };
    if (!launch.projects.some((p) => p.path === project.path)) launch.projects.unshift(project);
    return project;
  }
  if (p === 'api/resources') return resources();
  if (p === 'api/skills') return skills;
  if (p === 'api/skills/graph') return demoSkillGraph();
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
      { id: 'demo-crop-7', species: 'tulip', rarity: 'common', color: 'yellow', harvestedAt: now - 2 * 86400_000 },
    );
    f.seeds.push({ id: 'demo-seed-mythic', species: 'moonflower', rarity: 'mythic', color: 'white' });
    // a morning at the pond
    f.bait = 10;
    f.fish.push(
      { id: 'demo-fish-1', species: 'koi', rarity: 'rare', kg: 6.4, caughtAt: now - 3 * 3600_000 },
      { id: 'demo-fish-2', species: 'carp', rarity: 'fine', kg: 2.1, caughtAt: now - 2 * 3600_000 },
      { id: 'demo-fish-3', species: 'crucian', rarity: 'common', kg: 0.35, caughtAt: now - 3600_000 },
    );
    f.caught = { koi: 1, carp: 2, crucian: 4, minnow: 3 };
    demoFarm = f;
  }
  if (p === 'api/farm') return farmView(demoFarm);
  if (p === 'api/farm/social/github') return { login: 'ada-dev', profile: { github: 'ada-dev', name: 'Ada', bio: 'Ships with a crab on her desk', x: 'ada_dev', linkedin: 'https://www.linkedin.com/in/ada-dev' } };
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
  else if (action === 'sell') result = sellCrop(s, String(b.cropId));
  else if (action === 'sell-dupes') result = sellDuplicates(s);
  else if (action === 'sell-fish') result = sellFish(s, Array.isArray(b.ids) ? b.ids.map(String) : undefined);
  else if (action === 'rod') takeRod(s, String(b.rod));
  else if (action === 'bait') buyBait(s, Number(b.packs) || 1);
  else if (action === 'cast') result = cast(s);
  else if (action === 'reel') result = reel(s, String(b.castId));
  else if (action === 'ad') result = startAd(s);
  else if (action === 'ad-claim') result = claimAd(s, String(b.id));
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

// ── the skills as a knowledge map, as the small model would organize them ──
function demoSkillGraph(): SkillGraph {
  const id = (k: string) => `aaaaaaaaa${k.length === 2 ? 'a' : 'aa'}${k}`;
  const L = (en: string, zh: string) => ({ en, zh });
  const sk = (k: string, topic: string, en: string, zh: string) => ({ id: id(k), topic, summary: L(en, zh) });
  return {
    generatedAt: ago(3 * 3600),
    model: 'haiku',
    skillIds: skills.map((s) => s.id),
    topics: [
      { id: 'ship', name: L('Shipping', '发布交付'), summary: L('From a reviewed PR to a release in production', '从代码审查到上线发布') },
      { id: 'ship-rel', parent: 'ship', name: L('Releases', '版本发布'), summary: L('Versions, changelogs and tags', '版本号、更新日志和打标签') },
      { id: 'ship-ops', parent: 'ship', name: L('Deploy', '部署'), summary: L('Images and rollouts', '镜像构建与灰度上线') },
      { id: 'quality', name: L('Quality', '质量保障'), summary: L('Tests that catch bugs before users do', '在用户之前发现问题') },
      { id: 'ml', name: L('ML & GPU', '机器学习与 GPU'), summary: L('Data in, fast kernels out', '从数据清洗到 GPU 调优') },
      { id: 'docs', name: L('Docs & files', '文档与文件'), summary: L('Writing and reading documents', '写文档、读写各类文件') },
    ],
    skills: [
      sk('1', 'ship-rel', 'The release runbook end to end', '完整的发布流程清单'),
      sk('b2', 'ship-rel', 'Changelog from merged PRs', '根据合并的 PR 写更新日志'),
      sk('b3', 'ship-rel', 'Pick and bump the next version', '确定并更新版本号'),
      sk('b1', 'quality', 'Review risky diffs first', '优先审查高风险改动'),
      sk('2', 'quality', 'Pin down and fix flaky tests', '定位并修复不稳定的测试'),
      sk('b4', 'quality', 'Why CI is red, and the fix', '找出 CI 失败原因并修复'),
      sk('b5', 'quality', 'End-to-end tests for user flows', '为用户流程写端到端测试'),
      sk('b6', 'ship-ops', 'Small, cached Docker images', '构建小而可缓存的镜像'),
      sk('b7', 'ship-ops', 'Canary rollout with a way back', '灰度上线并可回滚'),
      sk('b8', 'ml', 'A clean, validated dataset', '清洗并校验训练数据'),
      sk('b9', 'ml', 'Tuned CUDA kernels for hot loops', '为热点循环调优 CUDA 内核'),
      sk('3', 'ml', 'Find GPU hot spots with nsys', '用 nsys 找出 GPU 瓶颈'),
      sk('bb', 'docs', 'Every endpoint, with examples', '为每个接口写可运行示例'),
      sk('4', 'docs', 'Read, merge and fill PDFs', '读取、合并、填写 PDF'),
      sk('ba', 'docs', 'Spreadsheets: edit and chart', '编辑表格、生成图表'),
    ],
    links: [
      { from: id('1'), to: id('b3'), kind: 'depends', note: L('a release needs the new version', '发布前要先定版本号') },
      { from: id('1'), to: id('b2'), kind: 'depends', note: L('the release notes come from the changelog', '发布说明来自更新日志') },
      { from: id('1'), to: id('b4'), kind: 'depends', note: L('only ship a green build', '只发布 CI 通过的版本') },
      { from: id('b7'), to: id('b6'), kind: 'depends', note: L('deploys roll out the image', '部署的是构建好的镜像') },
      { from: id('b7'), to: id('1'), kind: 'depends', note: L('roll out a cut release', '上线已发布的版本') },
      { from: id('b4'), to: id('2'), kind: 'related', note: L('flaky tests turn CI red', '不稳定的测试常让 CI 失败') },
      { from: id('b1'), to: id('b5'), kind: 'related', note: L('reviews ask for tests', '审查时会要求补测试') },
      { from: id('b9'), to: id('3'), kind: 'depends', note: L('tune what the profile shows', '根据性能分析结果调优') },
      { from: id('3'), to: id('b8'), kind: 'related', note: L('profile on the real data', '用真实数据做性能分析') },
      { from: id('b2'), to: id('b1'), kind: 'related', note: L('reviewed PRs feed the changelog', '审查过的 PR 写进更新日志') },
      { from: id('bb'), to: id('b2'), kind: 'related', note: L('docs change with each release', '文档随版本更新') },
      { from: id('ba'), to: id('b8'), kind: 'related', note: L('datasets often come as spreadsheets', '数据集常以表格形式出现') },
    ],
  };
}


// ── the office, in memory: a sample team, and runs that play out on the clock ──
const zhDemo = () => (localStorage.getItem('vp.lang') ?? navigator.language).startsWith('zh');
function demoTeam(goal?: string, id = 'demo-team'): OfficeTeam {
  const zh = zhDemo();
  const n = (key: string, name: string, role: OfficeNode['role'], agent: OfficeNode['agent'], model: string, effort: string, task: string, parent?: string): OfficeNode => ({ id: key, name, role, agent, ...(model ? { model } : {}), effort, task, ...(parent ? { parent } : {}), grants: [...DEFAULT_GRANTS], x: 0, y: 0 });
  const nodes = [
    n('lead', zh ? '总负责人' : 'Lead', 'lead', 'claude', 'opus', 'high', zh ? '整合各组成果，检查整体是否达成目标，写最终说明。' : 'Bring the pieces together, check the goal is met, write the summary.'),
    n('ui', zh ? '界面组' : 'UI', 'manager', 'claude', 'sonnet', 'medium', zh ? '合并界面相关改动并复查。' : 'Merge and recheck the UI changes.', 'lead'),
    n('css', zh ? '样式工程师' : 'Styles', 'engineer', 'claude', 'sonnet', 'medium', zh ? '为设置页加入深色主题变量和切换。' : 'Add dark theme variables and the toggle to the settings page.', 'ui'),
    n('state', zh ? '状态工程师' : 'State', 'engineer', 'codex', '', 'medium', zh ? '把主题偏好存到 localStorage 并在启动时读取。' : 'Persist the theme choice in localStorage and read it at start.', 'ui'),
    n('test', zh ? '测试员' : 'Tests', 'tester', 'codex', '', 'low', zh ? '为主题切换写测试并运行。' : 'Write and run tests for the theme toggle.', 'lead'),
    n('docs', zh ? '文档员' : 'Docs', 'writer', 'claude', 'haiku', 'low', zh ? '更新 README 和更新日志。' : 'Update the README and the changelog.', 'lead'),
  ];
  // the styles engineer starts without "run commands": it will ask for it
  nodes[2].grants = ['edit'];
  // the changelog is written once the tests have run
  nodes[5].after = ['test'];
  // what each desk hands up, and what it is accepted by
  const handoffs: Record<string, [string, string[]]> = zh
    ? {
        lead: ['可合并的深色模式改动 + 变更说明', ['设置页可切换深色 / 浅色', '全部测试通过', '更新日志已写']],
        ui: ['合并好的界面改动和复查记录', ['深色下无低对比度文字', '刷新后主题保持']],
        css: ['深色主题 CSS 变量和切换按钮', ['所有颜色走变量', '切换无闪烁']],
        state: ['主题偏好的读写模块', ['存入 localStorage', '启动时先读取再渲染']],
        test: ['主题切换测试及运行结果', ['新增测试覆盖切换和持久化', 'npm test 通过']],
        docs: ['README 段落 + 更新日志条目', ['写明如何切换主题']],
      }
    : {
        lead: ['A mergeable dark mode change + summary', ['Settings switches dark / light', 'All tests pass', 'Changelog entry written']],
        ui: ['The merged UI change and a review note', ['No low-contrast text in dark', 'Theme survives a reload']],
        css: ['Dark theme CSS variables and the toggle', ['Every colour uses a variable', 'No flash when switching']],
        state: ['The theme preference module', ['Stored in localStorage', 'Read before the first render']],
        test: ['Theme toggle tests and their run', ['New tests cover toggle and persistence', 'npm test passes']],
        docs: ['README section + changelog entry', ['Says how to switch the theme']],
      };
  // the lead's is the team's final deliverable, settled first
  for (const x of nodes) if (x.id !== 'lead') [x.deliverable, x.criteria] = handoffs[x.id] ?? [undefined, undefined];
  const [deliverable, criteria] = handoffs.lead;
  return { id, name: zh ? '深色模式小组' : 'Dark mode squad', goal: goal ?? (zh ? '给设置页加上深色模式，附带测试和更新日志' : 'Add dark mode to the settings page, with tests and a changelog entry'), deliverable, criteria, budget: 6, cwd: '/home/you/code/vibeportal', nodes: cascadeGrants(autoLayout(nodes)), updatedAt: new Date().toISOString() };
}
let demoOffice: OfficeView | undefined;
/** When each desk of a demo run starts and ends: people first, their supervisor once all are done. */
function demoTimes(run: OfficeRun): Map<string, [number, number]> {
  const t0 = Date.parse(run.startedAt);
  const times = new Map<string, [number, number]>();
  const of = (n: OfficeNode): [number, number] => {
    const known = times.get(n.id);
    if (known) return known;
    const kids = childrenOf(run.nodes, n.id).map(of);
    const start = kids.length ? Math.max(...kids.map((k) => k[1])) : t0 + 600;
    const r: [number, number] = [start, start + 5000 + (n.task.length % 7) * 900];
    times.set(n.id, r);
    return r;
  };
  run.nodes.forEach(of);
  return times;
}
const DEMO_VERBS = [
  ['read', 'src/ui/components/Settings.tsx'],
  ['search', 'theme'],
  ['edit', 'src/ui/styles.css'],
  ['run', 'npm test'],
  ['write', 'CHANGELOG.md'],
] as const;
function demoAdvance(run: OfficeRun, now = Date.now()) {
  if (run.state !== 'running') return;
  const zh = zhDemo();
  const times = demoTimes(run);
  let spent = 0;
  for (const n of run.nodes) {
    const [a, b] = times.get(n.id)!;
    const p = run.progress[n.id];
    const total = estimateNode(run.nodes, n).tokens;
    if (now < a) Object.assign(p, { state: 'waiting' });
    else if (now < b) {
      const v = DEMO_VERBS[Math.floor((now - a) / 1300) % DEMO_VERBS.length];
      Object.assign(p, { state: 'running', startedAt: new Date(a).toISOString(), verb: v[0], doing: v[1], tokens: Math.round((total * (now - a)) / (b - a)), taskId: `dispatch:demo-${n.id}` });
    } else
      Object.assign(p, {
        state: 'done',
        startedAt: new Date(a).toISOString(),
        endedAt: new Date(b).toISOString(),
        verb: undefined,
        doing: undefined,
        tokens: total,
        report: [
          zh ? `${n.name}：已完成「${n.task}」。改动了 2 个文件，测试通过，没有遗留问题。` : `${n.name}: done — ${n.task} Two files changed, tests pass, nothing left open.`,
          ...childrenOf(run.nodes, n.id).map((k) => `ACCEPTED: ${k.name}`),
          ...specOf(run, n).criteria.map((c) => `- [x] ${c}`),
        ].join('\n'),
        checks: specOf(run, n).criteria.map(() => 'met'),
      });
    // its supervisor accepts the delivery once the supervisor is done too
    if (n.parent && times.get(n.parent) && now >= times.get(n.parent)![1]) Object.assign(p, { accepted: true });
    // the styles engineer asks its manager to run the dev server halfway through, and gets it
    if (n.id === 'css' && now > a + (b - a) * 0.3) {
      const decided = now > a + (b - a) * 0.65;
      p.asks = [
        {
          id: 'demo-ask',
          grant: 'run',
          tool: 'Bash',
          summary: 'npm run dev -- --port 5173',
          at: new Date(a + (b - a) * 0.3).toISOString(),
          to: 'ui',
          state: decided ? 'allowed' : 'reviewing',
          ...(decided ? { reason: zh ? '需要启动开发服务器检查深色效果，只在本地，安全。' : 'It needs the dev server to check the dark theme; local only, safe.', decidedAt: new Date(a + (b - a) * 0.65).toISOString() } : {}),
        },
      ];
      p.grants = decided ? [...n.grants, 'run'] : n.grants;
    }
    p.cost = (p.tokens ?? 0) * costPerToken(n.agent, n.model);
    spent += p.cost;
  }
  run.spent = Math.round(spent * 1000) / 1000;
  if (Object.values(run.progress).every((p) => p.state === 'done')) Object.assign(run, { state: 'done', endedAt: new Date(Math.max(...[...times.values()].map((x) => x[1]))).toISOString() });
}
function demoOfficeCall(method: string, p: string, body: unknown): unknown {
  demoOffice ??= { teams: [demoTeam()], runs: [] };
  const o = demoOffice;
  o.runs.forEach((r) => demoAdvance(r));
  if (p === 'api/office') return o;
  if (p === 'api/office/teams' && method === 'POST') {
    const team = { ...(body as OfficeTeam), updatedAt: new Date().toISOString() };
    o.teams = o.teams.some((x) => x.id === team.id) ? o.teams.map((x) => (x.id === team.id ? team : x)) : [...o.teams, team];
    return team;
  }
  if (p === 'api/office/plan') {
    const b = body as { id?: string; goal: string; budget: number; cwd?: string };
    const team = { ...demoTeam(b.goal, b.id ?? newOfficeId('t')), budget: b.budget, cwd: b.cwd ?? '/home/you/code/vibeportal' };
    o.teams = [...o.teams.filter((x) => x.id !== team.id), team];
    return new Promise((resolve) => setTimeout(() => resolve(team), 1400));
  }
  const tm = /^api\/office\/teams\/([\w-]+)(\/run)?$/.exec(p);
  if (tm && method === 'DELETE') {
    o.teams = o.teams.filter((x) => x.id !== tm[1]);
    return { ok: true };
  }
  if (tm?.[2]) {
    const team = o.teams.find((x) => x.id === tm[1])!;
    team.cwd ||= `/home/demo/.vibeportal/workspaces/${team.id}`;
    const run: OfficeRun = { id: newOfficeId('r'), teamId: team.id, teamName: team.name, state: 'running', startedAt: new Date().toISOString(), budget: team.budget, spent: 0, nodes: team.nodes, deliverable: team.deliverable, criteria: team.criteria, progress: Object.fromEntries(team.nodes.map((n) => [n.id, { state: 'waiting' as const, grants: [...n.grants] }])) };
    o.runs.push(run);
    return run;
  }
  const rm = /^api\/office\/runs\/([\w-]+)\/stop$/.exec(p);
  if (rm) {
    const run = o.runs.find((r) => r.id === rm[1])!;
    for (const x of Object.values(run.progress)) if (x.state === 'waiting' || x.state === 'running') x.state = x.state === 'running' ? 'failed' : 'skipped';
    Object.assign(run, { state: 'stopped', endedAt: new Date().toISOString() });
    return run;
  }
  return { ok: true };
}
