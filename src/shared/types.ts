// Types shared by the Node core, the HTTP server and the React UI.

export type Provider = 'claude' | 'openai';

export type Severity = 'normal' | 'warning' | 'critical';

/** One rate-limit / quota window, e.g. "5-hour session" or "weekly (Opus)". */
export interface QuotaWindow {
  id: string;
  label: string;
  /** 0–100 */
  percent: number;
  resetsAt?: string;
  severity: Severity;
  /** Dollar-denominated windows (monthly spend caps). */
  usedDollars?: number;
  limitDollars?: number;
  /** session = 5-hour window, weekly = 7-day window */
  kind: 'session' | 'weekly' | 'other';
  windowMinutes?: number;
  forecast?: Forecast;
}

export interface Forecast {
  /** percentage points per hour used for the projection */
  ratePerHour: number;
  basis: 'recent' | 'window';
  /** average rate since the window started (always available) */
  windowRatePerHour: number;
  /** when 100% is reached at this rate (undefined if not before reset / rate 0) */
  exhaustAt?: string;
  /** projected % at reset time */
  projectedAtReset?: number;
  willExhaustBeforeReset: boolean;
}

export interface PlanInfo {
  /** Human readable, e.g. "Claude Max 5x", "ChatGPT Pro". */
  name: string;
  /** Raw tier string from the provider, e.g. "default_claude_max_5x", "prolite". */
  tier?: string;
  status?: string;
  since?: string;
  until?: string;
  /** next renewal; estimated = projected monthly from the subscription start, not reported */
  renewsAt?: string;
  renewsEstimated?: boolean;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite (+ reasoning for OpenAI, already counted in output) */
  total: number;
  messages: number;
  /** estimated API-equivalent cost in USD (0 when the model has no known price) */
  cost: number;
}

export interface DailyUsage {
  /** YYYY-MM-DD, local time */
  date: string;
  totals: TokenTotals;
  byModel: Record<string, TokenTotals>;
}

/** Usage attributed to one repository (git root of the session's working directory). */
export interface ProjectUsage {
  /** absolute path of the repo root (or cwd when not in a git repo) */
  key: string;
  name: string;
  total: TokenTotals;
  today: TokenTotals;
  last7d: TokenTotals;
  byModel: Record<string, TokenTotals>;
  /** tokens per day, oldest first, for the last 14 days */
  spark: number[];
  lastActive: string;
  /** web page of the `origin` remote (credentials stripped), when there is one */
  webUrl?: string;
  forge?: 'github' | 'gitlab' | 'bitbucket' | 'other';
}

export interface CostSummary {
  /** USD over the reporting period */
  amount: number;
  periodDays: number;
  daily: { date: string; amount: number }[];
}

export type SourceState = 'ok' | 'unavailable' | 'error' | 'disabled';

export interface SourceStatus {
  id: string;
  label: string;
  state: SourceState;
  message?: string;
  updatedAt?: string;
}

export interface ProviderSnapshot {
  provider: Provider;
  /** Display name: "Claude" / "ChatGPT" */
  name: string;
  plan?: PlanInfo;
  quotas: QuotaWindow[];
  /** When the quota numbers were observed (may be older for log-derived data). */
  quotasObservedAt?: string;
  daily: DailyUsage[];
  today: TokenTotals;
  last5h: TokenTotals;
  apiCost?: CostSummary;
  sources: SourceStatus[];
  projects: ProjectUsage[];
  /** models without a known price (cost shown as unknown) */
  unpricedModels: string[];
  /** ChatGPT rate-limit reset credits ("重置券") */
  resetCredits?: ResetCredits;
}

export interface ResetCredits {
  available: number;
  /** how many can be applied right now (e.g. only once a window is used up) */
  usableNow: number;
}

export type TaskState = 'running' | 'waiting' | 'idle' | 'done' | 'failed';

export interface TaskInfo {
  id: string;
  /** claude-code | codex | custom | dispatch */
  kind: string;
  provider?: Provider;
  title: string;
  state: TaskState;
  detail?: string;
  cwd?: string;
  /** 0–100 for custom tasks that report progress */
  progress?: number;
  startedAt?: string;
  updatedAt: string;
  /** set when the task was seen going from running to idle/done */
  finishedAt?: string;
  /** whether the "continue with an instruction" action is available */
  canContinue?: boolean;
  /** the owning process is still alive (interactive session open) */
  alive?: boolean;
  /** where the conversation lives: the VS Code extension or a terminal CLI */
  ide?: 'vscode' | 'terminal';
  workload?: Workload;
  /** recent progress parsed from the transcript / hooks, for the pet's speech bubble */
  activity?: TaskActivity;
  /** machine name for tasks merged from a remote VibePortal */
  host?: string;
}

/** What a tool call was doing; the UI turns it into a localized label. */
export type ActivityVerb = 'read' | 'edit' | 'write' | 'run' | 'search' | 'web' | 'agent' | 'ask' | 'wait' | 'tool';

export interface ActivityItem {
  ts: string;
  /** tool = a tool call, say = the agent's own words, prompt = the user's instruction */
  kind: 'tool' | 'say' | 'prompt';
  verb?: ActivityVerb;
  /** raw tool name (shown for verb 'tool') */
  tool?: string;
  /** target / snippet, untranslated: a file, a command, a sentence */
  text?: string;
}

export interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TaskPlan {
  done: number;
  total: number;
  /** the step in progress (its active form when the agent gave one) */
  current?: string;
  steps: PlanStep[];
}

export interface TaskActivity {
  /** oldest first */
  feed: ActivityItem[];
  plan?: TaskPlan;
}

export interface Workload {
  /** average over the last 5 minutes */
  tokensPerMin: number;
  sessionTokens: number;
  /** size of the latest request's prompt (≈ current context) */
  contextTokens?: number;
  contextWindow?: number;
  model?: string;
  /** reasoning effort of the latest turn (low … max), when the log records it */
  effort?: string;
}

export interface TaskContext {
  lastPrompt?: string;
  lastReply?: string;
  output?: string;
}

export type PetMood = 'idle' | 'working' | 'waiting' | 'alert' | 'sleeping' | 'happy';
/** which home pets show when nothing is running */
export type PetCharacter = 'duo' | 'claude' | 'codex';
/** the pet that represents Codex */
export type CodexPet = 'bot' | 'whale';

export interface PetState {
  mood: PetMood;
  /** Short line shown in the speech bubble. */
  message: string;
}

export interface RemoteHostConfig {
  id: string;
  name: string;
  url: string;
  token: string;
}

export interface RemoteHostSnapshot {
  id: string;
  name: string;
  url: string;
  online: boolean;
  error?: string;
  updatedAt?: string;
  providers: Pick<ProviderSnapshot, 'provider' | 'name' | 'plan' | 'quotas' | 'resetCredits'>[];
}

export interface Snapshot {
  generatedAt: string;
  providers: ProviderSnapshot[];
  tasks: TaskInfo[];
  pet: PetState;
  /** per-provider pets: the crab follows Claude, the whale girl follows ChatGPT/Codex */
  pets: Record<Provider, PetState>;
  petConfig: { enabled: boolean; size: number; character: PetCharacter; codexPet: CodexPet };
  historyDays: number;
  machineName: string;
  remotes: RemoteHostSnapshot[];
  /** official remote control (Claude remote-control environments, Codex daemon) */
  official?: OfficialRemoteState;
}

export interface OfficialRemoteState {
  claude: { cwd: string; name: string; state: 'connecting' | 'ready' | 'error'; url?: string; error?: string; startedAt: string }[];
  codex: { state: 'off' | 'starting' | 'on' | 'error'; serverName?: string; environmentId?: string; error?: string };
}

/** relays that give this machine a public https address */
export type TunnelProvider = 'ngrok' | 'tailscale' | 'localhost.run' | 'pinggy' | 'cloudflare';

export interface PublicSettings {
  claudeDir: string;
  codexDir: string;
  historyDays: number;
  pollSeconds: number;
  subscriptionPollSeconds: number;
  warnPercent: number;
  criticalPercent: number;
  notifications: boolean;
  pet: { enabled: boolean; size: number; character: PetCharacter; codexPet: CodexPet };
  suggestModel: string;
  anthropicAdminKeySet: boolean;
  openaiAdminKeySet: boolean;
  /** Only meaningful in desktop mode */
  launchAtLogin: boolean;
  /** listen on all interfaces so phones / other machines can connect */
  remoteAccess: boolean;
  machineName: string;
  hosts: { id: string; name: string; url: string }[];
  /** remote browsers must log in with a password */
  passwordSet: boolean;
  /** run a tunnel (SSH relay or Cloudflare) for access from the internet */
  publicTunnel: boolean;
  tunnelProvider: TunnelProvider;
  /** ngrok: the account's static domain (e.g. name.ngrok-free.app) — the address never changes */
  ngrokDomain: string;
  ngrokAuthtokenSet: boolean;
  /** the user's own public address (port forward / reverse proxy), shown in the QR code */
  publicUrl: string;
  /** Google sign-in: the OAuth client id (Web application) from the user's Google Cloud project */
  googleClientId: string;
  /** Google accounts allowed to sign in to this machine */
  googleOwners: string[];
}

export interface SettingsPatch extends Partial<Omit<PublicSettings, 'anthropicAdminKeySet' | 'openaiAdminKeySet' | 'pet' | 'hosts' | 'passwordSet' | 'ngrokAuthtokenSet'>> {
  pet?: Partial<PublicSettings['pet']>;
  /** new remote-access password; empty string removes it */
  remotePassword?: string;
  /** empty string clears it */
  ngrokAuthtoken?: string;
  /** empty string clears the key */
  anthropicAdminKey?: string;
  openaiAdminKey?: string;
}

export interface ServerInfo {
  version: string;
  mode: 'desktop' | 'web';
  hookUrl: string;
  taskUrl: string;
  authRequired: boolean;
  machineName: string;
  /** host the server is bound to right now */
  boundHost: string;
  port: number;
  /** http://<lan-ip>:<port> addresses (empty when remote access is off) */
  lanUrls: string[];
  /** other VibePortal instances announcing themselves on the LAN */
  discovered: { id: string; name: string; url: string; seenAt: string }[];
  /** the request came from this machine (security settings can only be changed locally) */
  viewerLocal: boolean;
  /** stable id of this VibePortal, for the device list */
  instanceId: string;
  passwordSet: boolean;
  /** https address reachable from the internet (tunnel or the configured public URL) */
  publicUrl?: string;
  /** `url` while starting is assigned but not reachable yet; `reason` explains common failures */
  tunnel: {
    state: 'off' | 'starting' | 'on' | 'error' | 'missing';
    provider?: TunnelProvider;
    url?: string;
    error?: string;
    reason?: 'blocked' | 'timeout' | 'auth' | 'approve' | 'busy';
    /** a page the user has to visit (enable Funnel, get an authtoken…) */
    link?: string;
  };
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0, cost: 0 };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    messages: a.messages + b.messages,
    cost: a.cost + b.cost,
  };
}

// ── new tasks ───────────────────────────────────────────────────────────────
export type LaunchAgent = 'claude' | 'codex';

export interface LaunchProject {
  path: string;
  name: string;
  /** where we know it from: agent history, a VS Code window that is open now, or VS Code's folder list */
  sources: ('claude' | 'codex' | 'open' | 'vscode')[];
  lastUsed?: string;
  git: boolean;
}

export interface LaunchOptions {
  projects: LaunchProject[];
  agents: Record<LaunchAgent, LaunchAgentInfo>;
}

export interface LaunchAgentInfo {
  available: boolean;
  /** aliases first, then models seen in this machine's logs */
  models: string[];
  efforts: string[];
  /** what the CLI uses when nothing is chosen (from its own settings) */
  defaultModel?: string;
  defaultEffort?: string;
}

/** default = the user's own Claude Code / Codex permission settings; edits = may change files in the folder */
export type LaunchPermission = 'default' | 'edits';

export interface LaunchRequest {
  agent: LaunchAgent;
  cwd: string;
  prompt: string;
  /** empty = the CLI's default model */
  model?: string;
  effort?: string;
  permission?: LaunchPermission;
  /** skill ids whose SKILL.md the agent is told to read first */
  skills?: string[];
}

// ── local resources ─────────────────────────────────────────────────────────
export interface ResourceSnapshot {
  at: string;
  host: string;
  platform: string;
  uptimeSec: number;
  cpu: { model: string; cores: number; percent: number; perCore: number[]; load?: [number, number, number] };
  memory: { total: number; used: number; available: number; swapTotal?: number; swapUsed?: number };
  gpus: GpuInfo[];
  /** set when GPUs could not be queried (no nvidia-smi, driver error…) */
  gpuNote?: string;
  disks: DiskInfo[];
  processes: ProcessInfo[];
  /** oldest first, one point per sample */
  history: { at: string; cpu: number; mem: number; gpu?: number; gpuMem?: number }[];
}

export interface GpuInfo {
  index: number;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  tempC?: number;
  powerW?: number;
  powerLimitW?: number;
  processes: { pid: number; name: string; mem: number }[];
}

export interface DiskInfo {
  mount: string;
  fs?: string;
  total: number;
  used: number;
  free: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  /** % of one core (can exceed 100 on multi-core) */
  cpu: number;
  rss: number;
  /** claude / codex / vibeportal processes */
  agent?: 'claude' | 'codex';
}

// ── skills ──────────────────────────────────────────────────────────────────
/** library = VibePortal's own archive; claude / codex / agents = user skill folders; project = a repo's skill folder */
export type SkillSource = 'library' | 'claude' | 'codex' | 'agents' | 'project';

export interface SkillInfo {
  id: string;
  /** folder name */
  slug: string;
  name: string;
  description: string;
  source: SkillSource;
  /** absolute path of SKILL.md */
  path: string;
  dir: string;
  updatedAt: string;
  project?: string;
  /** synced / system skills managed by the CLI itself */
  managed?: boolean;
  /** library: where it was archived from, when */
  origin?: string;
  archivedAt?: string;
  manual?: boolean;
  /** library skills installed into these agents */
  installed?: ('claude' | 'codex')[];
  /** a copy VibePortal installed (shown under its library entry) */
  installedCopy?: boolean;
}

export interface SkillDetail extends SkillInfo {
  body: string;
  files: string[];
}
