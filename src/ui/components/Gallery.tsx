import type { PetMood, ProviderSnapshot, QuotaWindow, Snapshot, TaskInfo } from '../../shared/types';
import { emptyTotals } from '../../shared/types';
import { Mascot, type CrabScene, type MascotKind } from './Mascots';
import { ClaudeMark, CodexMark, OpenAIMark } from './Brand';
import { PetWidget } from './PetWidget';

const MOODS: PetMood[] = ['idle', 'working', 'waiting', 'alert', 'sleeping', 'happy'];
const SCENES: CrabScene[] = ['code', 'cook', 'read', 'search', 'rice', 'tea'];

/** Dev page (#/gallery): every mascot in every mood, plus the provider marks. */
export function Gallery() {
  return (
    <div>
      <div className="gallery">
        {(['crab', 'bot', 'whale', 'frog'] as MascotKind[]).flatMap((k) =>
          MOODS.map((m) => (
            <figure key={k + m}>
              <Mascot kind={k} mood={m} size={110} />
              <figcaption>
                {k} · {m}
              </figcaption>
            </figure>
          )),
        )}
      </div>
      <div className="gallery">
        {SCENES.map((sc) => (
          <figure key={sc}>
            <Mascot kind="crab" mood={sc === 'rice' || sc === 'tea' ? 'idle' : 'working'} size={110} scene={sc} />
            <figcaption>crab · {sc}</figcaption>
          </figure>
        ))}
      </div>
      <div className="gallery-pets">
        <PetWidget snapshot={demoSnapshot()} variant="window" />
      </div>
      <div className="gallery" style={{ gridTemplateColumns: 'repeat(6, auto)', justifyContent: 'start' }}>
        <div className="provider-logo" style={{ background: 'var(--claude)', color: '#fff' }}>
          <ClaudeMark size={26} />
        </div>
        <div className="provider-logo" style={{ background: '#0d0d0d', color: '#fff' }}>
          <OpenAIMark size={26} />
        </div>
        <div className="provider-logo" style={{ background: '#0d0d0d', color: '#fff' }}>
          <CodexMark size={26} />
        </div>
        <ClaudeMark size={64} />
        <OpenAIMark size={64} />
        <CodexMark size={64} />
      </div>
    </div>
  );
}

/** Sample tasks with progress, so the speech bubble can be checked without a live session. */
function demoSnapshot(): Snapshot {
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const tasks: TaskInfo[] = [
    {
      id: 'claude:demo',
      kind: 'claude-code',
      provider: 'claude',
      title: 'Pet speech bubble',
      state: 'running',
      cwd: '/home/me/prj/VibePortal',
      updatedAt: ago(2),
      workload: { tokensPerMin: 18_400, sessionTokens: 2_300_000, contextTokens: 210_000, contextWindow: 1_000_000 },
      activity: {
        plan: {
          done: 2,
          total: 5,
          current: 'Drawing the bubble',
          steps: [
            { text: 'Parse transcripts', status: 'completed' },
            { text: 'Wire hooks', status: 'completed' },
            { text: 'Draw the bubble', status: 'in_progress' },
            { text: 'Crab scenes', status: 'pending' },
            { text: 'Tests', status: 'pending' },
          ],
        },
        feed: [
          { kind: 'say', ts: ago(40), text: 'Backend data is right. Now the UI side.' },
          { kind: 'tool', ts: ago(3), verb: 'edit', text: 'src/ui/components/PetWidget.tsx' },
        ],
      },
    },
    {
      id: 'codex:demo',
      kind: 'codex',
      provider: 'openai',
      title: 'LAB1 TA 参考文档',
      state: 'running',
      cwd: '/home/me/prj/4C1_Lab',
      updatedAt: ago(5),
      activity: {
        feed: [
          { kind: 'say', ts: ago(30), text: 'Word 版已完成，排版预览为 16 页，包含模块图和状态图。' },
          { kind: 'tool', ts: ago(6), verb: 'run', text: 'pdftotext -layout LAB1_TA参考_中文.pdf rendered.txt' },
        ],
      },
    },
    {
      id: 'claude:demo2',
      kind: 'claude-code',
      provider: 'claude',
      title: 'Fix flaky test',
      state: 'running',
      cwd: '/home/me/prj/实验仓库',
      updatedAt: ago(1),
      activity: { feed: [{ kind: 'tool', ts: ago(1), verb: 'run', text: 'npm test' }] },
    },
  ];
  const inH = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const q = (id: string, label: string, kind: QuotaWindow['kind'], percent: number, resetH: number): QuotaWindow => ({
    id,
    label,
    kind,
    percent,
    resetsAt: inH(resetH),
    severity: percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal',
  });
  const provider = (p: 'claude' | 'openai', quotas: QuotaWindow[], extra: Partial<ProviderSnapshot>): ProviderSnapshot => ({
    provider: p,
    name: p === 'claude' ? 'Claude' : 'ChatGPT',
    quotas,
    daily: [],
    today: emptyTotals(),
    last5h: emptyTotals(),
    sources: [],
    projects: [],
    unpricedModels: [],
    ...extra,
  });
  return {
    generatedAt: ago(0),
    providers: [
      provider('claude', [q('session', '5-hour session', 'session', 38, 3), q('weekly_all', 'Weekly · all models', 'weekly', 52, 30), q('weekly_scoped:Opus', 'Weekly · Opus', 'weekly', 85, 30)], {
        plan: { name: 'Claude Max 5x', status: 'active', renewsAt: inH(24 * 6), renewsEstimated: true },
      }),
      provider('openai', [q('codex-primary_window', 'Weekly window', 'weekly', 17, 80), q('extra', 'Luna · Weekly window', 'other', 93, 150)], {
        plan: { name: 'ChatGPT Pro Lite', renewsAt: inH(24 * 20), renewsEstimated: true },
        resetCredits: { available: 2, usableNow: 0 },
      }),
    ],
    tasks,
    pet: { mood: 'working', message: '' },
    pets: { claude: { mood: 'working', message: '' }, openai: { mood: 'working', message: '' } },
    petConfig: { enabled: true, size: 120, character: 'duo', codexPet: 'bot' },
    historyDays: 30,
    machineName: 'demo',
    remotes: [],
  };
}
