import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClaudePet, CodexPet, PetMood, ProviderSnapshot, QuotaWindow, Snapshot, TaskInfo } from '../../shared/types';
import { desktop, dismissedTasks } from '../api';
import { fmt, useT } from '../i18n';
import { fmtDuration, fmtTokens } from '../format';
import { Mascot, type CrabScene, type MascotKind } from './Mascots';
import { TaskActions, followTask } from './TaskActions';
import { ActivityFeed, ModelChip, PlanBar, ProgressBar } from './Activity';
import { PlanDate, ResetCreditsLine } from './ProviderCard';
import { NewTask } from './NewTask';
import { PermissionPrompt, TaskHistoryView } from './TaskDetail';
import { PixelText } from './PixelText';

interface Props {
  snapshot: Snapshot | null;
  /** 'window' = standalone transparent Electron window; 'floating' = overlay inside the dashboard */
  variant: 'window' | 'floating';
  onOpenDashboard?: () => void;
}

const MAX_CLONES = 5;
const ATTENTION_MS = 30 * 60_000;
/** a tool call older than this no longer decides what the crab is up to */
const SCENE_FRESH_MS = 3 * 60_000;
/** how long a freshly appeared clone plays its "split off" animation */
const SPAWN_MS = 1100;

interface Unit {
  key: string;
  species: MascotKind;
  mood: PetMood;
  provider: 'claude' | 'openai';
  task?: TaskInfo;
  attention: boolean;
}

const MOOD_LABEL: Record<PetMood, { zh: string; en: string }> = {
  idle: { zh: '发呆中', en: 'Chilling' },
  working: { zh: '干活中', en: 'Working' },
  waiting: { zh: '等你处理', en: 'Needs you' },
  alert: { zh: '额度紧张', en: 'Quota alert' },
  sleeping: { zh: '睡觉中', en: 'Sleeping' },
  happy: { zh: '完成啦', en: 'Done!' },
};

/**
 * The pet "stage": one clone per active task (crab = Claude Code, whale girl =
 * Codex), or the home pets showing plan limits when nothing is going on.
 */
export function PetWidget({ snapshot, variant, onOpenDashboard }: Props) {
  const { t, lang } = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [dismissTick, setDismissTick] = useState(0);
  const [launching, setLaunching] = useState(false);
  const [mini, setMiniState] = useState(() => {
    try {
      return localStorage.getItem('vp.petMini') === '1';
    } catch {
      return false;
    }
  });
  const setMini = (on: boolean) => {
    setMiniState(on);
    setOpen(null);
    try {
      localStorage.setItem('vp.petMini', on ? '1' : '0');
    } catch {
      /* private mode */
    }
  };
  const [historyId, setHistoryId] = useState<string | null>(null);
  // where the floating pet was dropped, as its bottom-right corner: opening a card grows the stage up, not down
  const [floatPos, setFloatPos] = useState<FloatPos | null>(() => loadFloatPos());
  // where a floating-pet drag has got to: moved straight on the element, committed on release
  const dragPos = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; wx: number; wy: number; slop: number; moved: boolean; ready: boolean } | null>(null);
  const lastClick = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const bridge = desktop();
  const cfg = snapshot?.petConfig ?? { enabled: true, size: 140, character: 'duo' as const, claudePet: 'crab' as const, codexPet: 'bot' as const };
  // phones get a pocket-sized pet (and fewer clones, below)
  const phone = variant === 'floating' && typeof window !== 'undefined' && window.innerWidth <= 760;
  const size = variant === 'floating' ? Math.round(cfg.size * (phone ? 0.45 : 0.7)) : cfg.size;

  const units = useMemo(() => buildUnits(snapshot, cfg.character, cfg.claudePet ?? 'crab', cfg.codexPet), [snapshot, cfg.character, cfg.claudePet, cfg.codexPet, dismissTick]);
  const clones = units.filter((u) => u.task);
  const maxClones = phone ? 2 : MAX_CLONES;
  const overflow = clones.length > maxClones ? clones.length - maxClones : 0;
  const shown = clones.length ? clones.slice(0, maxClones) : units;

  // clones that weren't there on the previous renders split off with an animation
  const firstSeen = useRef(new Map<string, number>());
  const mounted = useRef(false);
  const now = Date.now();
  for (const u of shown) if (!firstSeen.current.has(u.key)) firstSeen.current.set(u.key, mounted.current ? now : 0);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const spawning = (key: string) => now - (firstSeen.current.get(key) ?? 0) < SPAWN_MS;

  // pop the panel open for the first unit that needs attention (once per event)
  const announced = useRef(new Set<string>());
  useEffect(() => {
    // on a phone a bubble popping open by itself would cover the page: the attention ring says enough
    if (phone) return;
    const u = shown.find((x) => x.attention && x.task);
    if (!u?.task) return;
    const stamp = `${u.task.id}@${u.task.finishedAt ?? u.task.state}`;
    if (announced.current.has(stamp)) return;
    announced.current.add(stamp);
    setOpen((o) => o ?? u.key);
  }, [shown]);
  // a run just started from a card: it may not be in the snapshot yet
  const expected = useRef<{ key: string; until: number } | null>(null);
  useEffect(() => {
    if (!open || shown.some((u) => u.key === open)) return;
    if (expected.current?.key === open && Date.now() < expected.current.until) return;
    // a run that went on with your queued instruction keeps its card open
    const next = shown.find((u) => u.task?.continuedFrom === open);
    setOpen(next ? next.key : null);
  }, [shown, open]);
  const historyTask = followTask(snapshot?.tasks ?? [], historyId);

  // standalone window: fit the window to the stage
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (variant !== 'window' || !bridge || !el) return;
    const ro = new ResizeObserver(() => bridge.petResize(el.scrollWidth + 8, el.scrollHeight + 8));
    ro.observe(el);
    return () => ro.disconnect();
  }, [variant, bridge]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // a finger wobbles more than a mouse: a tap must not turn into a (tiny) drag
    const d = { sx: e.screenX, sy: e.screenY, wx: 0, wy: 0, slop: e.pointerType === 'mouse' ? 4 : 12, moved: false, ready: false };
    drag.current = d;
    if (variant === 'window' && bridge) {
      void bridge.getPetPos().then(([x, y]) => Object.assign(d, { wx: x, wy: y, ready: true }));
    } else {
      const r = stageRef.current?.getBoundingClientRect();
      Object.assign(d, { wx: r?.left ?? 0, wy: r?.top ?? 0, ready: true });
    }
  };
  const finishMove = () => {
    const el = stageRef.current;
    el?.classList.remove('dragging');
    if (variant === 'window') return bridge?.petDragEnd();
    const moved = dragPos.current;
    dragPos.current = null;
    if (!moved || !el) return;
    const r = el.getBoundingClientRect();
    const p = clampFloat({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom });
    // the drag moved the stage by left / top: hand it back to the bottom-right anchor
    Object.assign(el.style, { left: 'auto', top: 'auto', right: `${p.right}px`, bottom: `${p.bottom}px` });
    setFloatPos(p);
    saveFloatPos(p);
  };
  /** A drag ends with the button — also when the release never arrived (window moved under the cursor). */
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) finishMove();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    // no button held: the pointer-up was lost — stop, instead of the pet following the mouse around
    if ((e.buttons & 1) === 0) return endDrag();
    if (!d.ready) return;
    const dx = e.screenX - d.sx;
    const dy = e.screenY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < d.slop) return;
    if (!d.moved) stageRef.current?.classList.add('dragging');
    d.moved = true;
    if (variant === 'window' && bridge) return bridge.setPetPos(d.wx + dx, d.wy + dy);
    // no re-render per pointer move: the stage follows the finger directly
    const p = clampToViewport(d.wx + dx, d.wy + dy);
    dragPos.current = p;
    const el = stageRef.current;
    if (el) Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, right: 'auto', bottom: 'auto' });
  };
  const onPointerUp = (key: string) => () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) return finishMove();
    const now = Date.now();
    if (now - lastClick.current < 320) {
      lastClick.current = 0;
      (onOpenDashboard ?? bridge?.openDashboard)?.();
      return;
    }
    lastClick.current = now;
    // the card opens right away (a second click still opens the dashboard)
    setOpen((o) => (o === key ? null : key));
  };

  const style: React.CSSProperties = variant === 'floating' && floatPos ? { left: 'auto', top: 'auto', right: floatPos.right, bottom: floatPos.bottom } : {};

  // phones: the open card sits just above the pet (below it when the pet is up near the top)
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!phone || !el) return;
    const hit = open ? el.querySelector('.pet-unit.open .pet-hit') : null;
    if (!hit) {
      el.style.removeProperty('--card-bottom');
      el.style.removeProperty('--card-top');
      return;
    }
    const r = hit.getBoundingClientRect();
    if (r.top > 220) {
      el.style.setProperty('--card-bottom', `${Math.round(window.innerHeight - r.top + 6)}px`);
      el.style.removeProperty('--card-top');
    } else {
      el.style.setProperty('--card-bottom', 'auto');
      el.style.setProperty('--card-top', `${Math.round(r.bottom + 6)}px`);
    }
  }, [open, phone, floatPos]);

  // minimized (floating pet only, remembered per browser): just a small crab button
  if (variant === 'floating' && mini) {
    const waiting = shown.some((u) => u.attention);
    return (
      <button className={`pet-mini ${waiting ? 'attention' : ''}`} onClick={() => setMini(false)} aria-label={t.petRestore} title={t.petRestore}>
        <img src="./icon.svg" alt="" width={34} height={34} />
        {clones.length > 0 && <span className="count">{clones.length}</span>}
      </button>
    );
  }

  return (
    <div
      ref={stageRef}
      className={`pet-stage pet-${variant}`}
      style={style}
      onContextMenu={(e) => {
        if (variant === 'window' && bridge) {
          e.preventDefault();
          bridge.petMenu();
        }
      }}
    >
      {historyTask && <TaskHistoryView task={historyTask} device={snapshot?.machineName} onClose={() => setHistoryId(null)} />}
      {variant === 'floating' && (
        <button className="pet-x" onClick={() => setMini(true)} aria-label={t.petMinimize} title={t.petMinimize}>
          –
        </button>
      )}
      <div className="pet-side">
        {launching && (
          <div className="pet-launch">
            <NewTask compact onClose={() => setLaunching(false)} onStarted={() => setLaunching(false)} />
          </div>
        )}
        <button
          className={`pet-add ${launching ? 'on' : ''}`}
          onClick={() => setLaunching((x) => !x)}
          aria-expanded={launching}
          aria-label={t.newTask}
          title={t.newTaskTitle}
        >
          +
        </button>
      </div>
      {shown.map((u) => {
        const provider = snapshot?.providers.find((p) => p.provider === u.provider);
        const isOpen = open === u.key;
        const spawn = spawning(u.key);
        const scene = crabScene(u, shown.indexOf(u));
        return (
          <div key={u.key} className={`pet-unit ${isOpen ? 'open' : ''} ${u.attention ? 'attention' : ''} ${spawn ? 'spawn' : ''}`}>
            <div
              className={`pet-bubble mood-${u.mood}`}
              role="status"
              aria-live="polite"
              // the collapsed bubble opens like the pet does; inside an open one, clicks belong to its controls
              onClick={(e) => !isOpen && !(e.target as HTMLElement).closest('button, a, input, textarea, select, form, details') && setOpen(u.key)}
            >
              {isOpen && (
                <button className="pet-bubble-close" onClick={() => setOpen(null)} onPointerDown={(e) => e.stopPropagation()} aria-label={t.close} title={t.close}>
                  ×
                </button>
              )}
              {/* the desktop window is resized to fit, so only the in-page pet folds smoothly */}
              <Fold smooth={variant === 'floating'}>
                {u.task ? (
                  <TaskBubble
                    unit={u}
                    provider={provider}
                    open={isOpen}
                    onClose={() => {
                      setOpen(null);
                      setDismissTick((x) => x + 1);
                    }}
                    onHistory={variant === 'floating' ? () => setHistoryId(u.task!.id) : undefined}
                    onContinued={(id) => {
                      // the card stays open on the run that carries your instruction
                      expected.current = { key: id, until: Date.now() + 8000 };
                      setDismissTick((x) => x + 1);
                      setOpen(id);
                    }}
                  />
                ) : (
                  <HomeBubble unit={u} snapshot={snapshot} provider={provider} open={isOpen} />
                )}
              </Fold>
            </div>
            {/* the pet keeps its place when its card opens: the card grows up and to the left */}
            <div className="pet-body">
            <div
              className="pet-hit"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp(u.key)}
              onPointerCancel={endDrag}
              onLostPointerCapture={() => drag.current && !drag.current.moved && (drag.current = null)}
              title={lang === 'zh' ? '单击展开 · 双击打开面板 · 拖动移动' : 'Click: details · Double-click: dashboard · Drag: move'}
            >
              {spawn && (
                <span className="pet-poof" aria-hidden>
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              )}
              <Mascot kind={u.species} mood={u.mood} size={size} scene={scene} />
              {provider && provider.quotas.length > 0 && <MiniBars provider={provider} size={size} />}
            </div>
            <PetLabel unit={u} scene={scene} />
            </div>
          </div>
        );
      })}
      {overflow > 0 && <div className="pet-more">{fmt(t.more, { n: overflow })}</div>}
    </div>
  );
}

/** Grows and shrinks with its content (a bubble opening, a new feed line) instead of jumping. */
function Fold({ smooth, children }: { smooth: boolean; children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number>();
  useLayoutEffect(() => {
    const el = inner.current;
    if (!smooth || !el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [smooth]);
  if (!smooth) return <>{children}</>;
  return (
    <div className="pet-fold" style={{ height: h }}>
      <div ref={inner}>{children}</div>
    </div>
  );
}

function TaskBubble({
  unit,
  provider,
  open,
  onClose,
  onHistory,
  onContinued,
}: {
  unit: Unit;
  provider?: ProviderSnapshot;
  open: boolean;
  onClose: () => void;
  onHistory?: () => void;
  onContinued?: (taskId: string) => void;
}) {
  const { t, lang } = useT();
  const task = unit.task!;
  const w = task.workload;
  const ctxPct = w?.contextTokens && w.contextWindow ? Math.round((w.contextTokens / w.contextWindow) * 100) : undefined;
  const act = task.activity;
  const feed = act?.feed ?? [];
  return (
    <>
      <div className="pet-bubble-head">
        <span className={`pet-state st-${task.state}`}>{unit.attention && task.state !== 'waiting' ? t.nextStep : t[task.state]}</span>
        {task.host && <span className="host-tag">{fmt(t.hostTag, { h: task.host })}</span>}
      </div>
      <div className="pet-msg" title={task.title}>
        {task.title}
      </div>
      <ModelChip task={task} editable={open} />
      {task.permissions && <PermissionPrompt items={task.permissions} compact />}
      {/* "needs you" details (permission requests…) matter more than the feed */}
      {task.detail && (task.state === 'waiting' || !feed.length) && !open && <div className="pet-detail">{task.detail}</div>}
      {act?.plan && <PlanBar plan={act.plan} open={open} />}
      {task.progress !== undefined && !act?.plan && <ProgressBar value={task.progress} />}
      {feed.length > 0 && <ActivityFeed items={feed} max={open ? 5 : 2} />}
      {w && (
        <div className="pet-work">
          <span title={t.tokPerMin}>
            ⚡ {fmtTokens(w.tokensPerMin)} {t.tokPerMin}
          </span>
          {ctxPct !== undefined && (
            <span className="ctx-meter" title={`${t.ctx} ${fmtTokens(w.contextTokens!)} / ${fmtTokens(w.contextWindow!)}`}>
              {t.ctx}{' '}
              <span className="bar">
                <span style={{ width: `${Math.min(100, ctxPct)}%` }} />
              </span>{' '}
              {ctxPct}%
            </span>
          )}
          {open && <span>Σ {fmtTokens(w.sessionTokens)}</span>}
        </div>
      )}
      {open && (
        <>
          <TaskActions task={task} compact onDone={onClose} onHistory={onHistory} onContinued={onContinued} />
          {provider && <QuotaRows quotas={provider.quotas} provider={provider} lang={lang} />}
        </>
      )}
    </>
  );
}

const VERBS: Record<string, string[]> = {
  edit: ['Crafting', 'Forging', 'Tinkering'],
  write: ['Crafting', 'Forging', 'Sculpting'],
  run: ['Cooking', 'Simmering', 'Stir-frying'],
  read: ['Reading', 'Studying'],
  search: ['Sleuthing', 'Scouting'],
  web: ['Browsing', 'Scouting'],
  agent: ['Delegating', 'Rallying'],
  wait: ['Brewing', 'Steeping'],
  ask: ['Asking you'],
  tool: ['Tinkering', 'Wiring'],
  think: ['Pondering', 'Conjuring', 'Noodling'],
};
const HOME_VERBS: Partial<Record<CrabScene, string>> = { rice: 'Snacking', tea: 'Sipping tea', read: 'Reading' };

/** What the pet is up to, as a playful word ("Cooking…"), plus the repo it works in. */
function petStatus(u: Unit, scene?: CrabScene): { word?: string; dots: boolean; tone: string; repo?: string } {
  const task = u.task;
  if (!task) {
    if (u.mood === 'sleeping') return { word: 'Zzz', dots: false, tone: 'muted' };
    if (u.mood === 'alert') return { word: 'Low quota!', dots: false, tone: 'warn' };
    const w = scene ? HOME_VERBS[scene] : undefined;
    return { word: w, dots: !!w, tone: 'muted' };
  }
  const repo = task.cwd ? task.cwd.split(/[/\\]/).filter(Boolean).pop() : undefined;
  if (task.state === 'waiting') return { word: 'Needs you!', dots: false, tone: 'warn', repo };
  if (task.state === 'failed') return { word: 'Oops!', dots: false, tone: 'bad', repo };
  if (task.state !== 'running') return { word: 'Done!', dots: false, tone: 'good', repo };
  const last = [...(task.activity?.feed ?? [])].reverse().find((i) => i.kind === 'tool');
  const fresh = last && Date.now() - Date.parse(last.ts) < SCENE_FRESH_MS;
  const list = VERBS[fresh ? last.verb ?? 'tool' : 'think'] ?? VERBS.think;
  // a different word now and then, stable between re-renders
  const pick = (hash(task.id) + Math.floor(Date.now() / 60_000)) % list.length;
  return { word: list[pick], dots: true, tone: 'work', repo };
}

function PetLabel({ unit, scene }: { unit: Unit; scene?: CrabScene }) {
  const s = petStatus(unit, scene);
  if (!s.word && !s.repo) return null;
  const repo = s.repo && s.repo.length > 18 ? s.repo.slice(0, 17) + '…' : s.repo;
  return (
    <div className="pet-label">
      {s.word && <PixelText text={s.word} dots={s.dots} wave={s.tone === 'work'} className={`tone-${s.tone}`} />}
      {repo && <PixelText text={repo} className="pet-label-repo" title={unit.task?.cwd} />}
    </div>
  );
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function HomeBubble({ unit, snapshot, provider, open }: { unit: Unit; snapshot: Snapshot | null; provider?: ProviderSnapshot; open: boolean }) {
  const { t, lang } = useT();
  const pet = snapshot?.pets?.[unit.provider];
  return (
    <>
      <div className="pet-bubble-head">
        <span className="pet-mood">
          {provider?.name ?? 'VibePortal'} · {MOOD_LABEL[unit.mood][lang]}
        </span>
      </div>
      <div className="pet-msg">{pet?.message ?? t.loading}</div>
      {provider && <QuotaRows quotas={provider.quotas} provider={provider} lang={lang} all={open} />}
      {open && provider?.resetCredits && <ResetCreditsLine rc={provider.resetCredits} />}
      {open && provider?.plan && (
        <div className="pet-foot">
          {provider.plan.name}
          <PlanDate plan={provider.plan} />
        </div>
      )}
    </>
  );
}

/**
 * Three small bars beside the pet — 5-hour, weekly, and the fullest other
 * window — so usage is readable at a glance without opening the bubble.
 */
function MiniBars({ provider, size }: { provider: ProviderSnapshot; size: number }) {
  const { t, lang } = useT();
  const q = provider.quotas;
  const session = q.find((x) => x.kind === 'session');
  const weekly = q.find((x) => x.kind === 'weekly');
  const other = q.filter((x) => x !== session && x !== weekly).sort((a, b) => b.percent - a.percent)[0];
  const slots: { key: string; q?: QuotaWindow }[] = [{ key: '5h', q: session }, { key: '7d', q: weekly }, ...(other ? [{ key: 'x', q: other }] : [])];
  const h = Math.round(size * 0.3);
  const w = Math.max(4, Math.round(size * 0.04));
  return (
    <div className="pet-minibars" role="group" aria-label={`${provider.name}: ${t.quotaBars}`} title={t.quotaBars} style={{ height: h }}>
      {slots.map((s) => {
        const reset = s.q?.resetsAt ? fmtDuration(Date.parse(s.q.resetsAt) - Date.now(), lang) : '';
        const tip = s.q ? `${s.q.kind === 'session' ? t.window5h : s.q.label}: ${Math.round(s.q.percent)}%${reset ? ` · ↻${reset}` : ''}` : t.no5h;
        return (
          <span
            key={s.key}
            className={`mb ${s.q ? `sev-${s.q.severity}` : 'none'} ${s.q?.forecast?.willExhaustBeforeReset ? 'exhaust' : ''}`}
            style={{ width: w }}
            title={`${provider.name} · ${tip}`}
            role="meter"
            aria-label={tip}
            aria-valuenow={s.q ? Math.round(s.q.percent) : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            {s.q && <span className="mb-fill" style={{ height: `${Math.max(4, Math.min(100, s.q.percent))}%` }} />}
          </span>
        );
      })}
    </div>
  );
}

/** Each window keeps its own reset time — they are independent. */
function QuotaRows({ quotas, provider, lang, all = true }: { quotas: QuotaWindow[]; provider: ProviderSnapshot; lang: 'zh' | 'en'; all?: boolean }) {
  const { t } = useT();
  const session = quotas.find((q) => q.kind === 'session');
  const rest = quotas.filter((q) => q !== session).sort((a, b) => b.percent - a.percent);
  const rows = all ? rest : rest.slice(0, 1);
  return (
    <div className="pet-meters">
      {session ? (
        <QuotaRow q={session} lang={lang} />
      ) : (
        <div className="pet-meter none" title={t.no5h}>
          <span className="pet-meter-name">{t.window5h}</span>
          <span className="muted">—</span>
        </div>
      )}
      {rows.map((q) => (
        <QuotaRow key={q.id} q={q} lang={lang} />
      ))}
      {!all && rest.length > 1 && (
        <div className="pet-foot">
          {provider.name} · +{rest.length - 1}
        </div>
      )}
    </div>
  );
}

function QuotaRow({ q, lang }: { q: QuotaWindow; lang: 'zh' | 'en' }) {
  const { t } = useT();
  const reset = q.resetsAt ? fmtDuration(Date.parse(q.resetsAt) - Date.now(), lang) : '';
  return (
    <div className={`pet-meter sev-${q.severity} ${q.forecast?.willExhaustBeforeReset ? 'exhaust' : ''}`} title={q.label}>
      <span className="pet-meter-name">{q.kind === 'session' ? t.window5h : q.label}</span>
      <span className="pet-meter-track">
        <span className="pet-meter-fill" style={{ width: `${Math.min(100, q.percent)}%` }} />
      </span>
      <span className="pet-meter-val">{Math.round(q.percent)}%</span>
      {reset && <span className="pet-meter-reset">↻{reset}</span>}
    </div>
  );
}

/** What the crab is up to, from the task's latest tool call; home crabs rotate through snack breaks. */
function crabScene(u: Unit, index: number): CrabScene | undefined {
  if (u.species !== 'crab') return undefined;
  if (u.task) {
    if (u.mood !== 'working') return undefined;
    const last = [...(u.task.activity?.feed ?? [])].reverse().find((i) => i.kind === 'tool');
    if (!last || Date.now() - Date.parse(last.ts) > SCENE_FRESH_MS) return 'code';
    switch (last.verb) {
      case 'run':
        return 'cook';
      case 'read':
        return 'read';
      case 'search':
      case 'web':
        return 'search';
      case 'wait':
        return 'tea';
      default:
        return 'code';
    }
  }
  if (u.mood !== 'idle') return undefined;
  const IDLE: CrabScene[] = ['rice', 'tea', 'rice', 'read'];
  return IDLE[(Math.floor(Date.now() / 90_000) + index) % IDLE.length];
}

function buildUnits(snapshot: Snapshot | null, character: 'duo' | 'claude' | 'codex', claudePet: ClaudePet, codexPet: CodexPet): Unit[] {
  const dismissed = dismissedTasks();
  const now = Date.now();
  // clones always follow the task's service: the Claude pet for Claude Code, the Codex pet for Codex
  const speciesFor = (p: 'claude' | 'openai'): MascotKind => (p === 'openai' ? codexPet : claudePet);
  const providerFor = (t: TaskInfo): 'claude' | 'openai' => t.provider ?? (t.kind === 'codex' ? 'openai' : 'claude');
  const units: Unit[] = [];
  for (const task of snapshot?.tasks ?? []) {
    // archived: seen and put away, nothing to call you over
    if (task.archived) continue;
    const stamp = task.finishedAt ?? task.updatedAt;
    const finishedRecently = !!task.finishedAt && now - Date.parse(task.finishedAt) < ATTENTION_MS;
    const failedRecently = task.state === 'failed' && now - Date.parse(task.updatedAt) < ATTENTION_MS;
    const notDismissed = dismissed[task.id] !== stamp;
    const attention = (task.state === 'waiting' || ((finishedRecently || failedRecently) && task.state !== 'running')) && notDismissed;
    if (task.state !== 'running' && !attention) continue;
    const p = providerFor(task);
    const mood: PetMood = task.state === 'running' ? 'working' : task.state === 'waiting' ? 'waiting' : task.state === 'failed' ? 'alert' : 'happy';
    units.push({ key: task.id, species: speciesFor(p), mood, provider: p, task, attention });
  }
  // needs-you first, then just-finished, then running
  const rank = (u: Unit) => (u.task?.state === 'waiting' ? 0 : u.attention ? 1 : 2);
  units.sort((a, b) => rank(a) - rank(b));
  if (units.length) return units;

  const home = (p: 'claude' | 'openai'): Unit => ({
    key: `home-${p}`,
    species: speciesFor(p),
    provider: p,
    mood: snapshot?.pets?.[p]?.mood ?? 'idle',
    attention: false,
  });
  if (character === 'duo') return [home('claude'), home('openai')];
  return [home(character === 'codex' ? 'openai' : 'claude')];
}

// v2: the bottom-right corner (the old top-left positions are dropped)
const FLOAT_KEY = 'vp.petPos2';
type FloatPos = { right: number; bottom: number };
function loadFloatPos(): FloatPos | null {
  try {
    const p = JSON.parse(localStorage.getItem(FLOAT_KEY) ?? 'null');
    return p && typeof p.right === 'number' && typeof p.bottom === 'number' ? clampFloat(p) : null;
  } catch {
    return null;
  }
}
/** keeps a dropped pet on screen: at least its corner, 120px of it */
function clampFloat(p: FloatPos): FloatPos {
  return { right: Math.round(Math.max(0, Math.min(window.innerWidth - 120, p.right))), bottom: Math.round(Math.max(0, Math.min(window.innerHeight - 120, p.bottom))) };
}
function saveFloatPos(p: FloatPos | null) {
  try {
    if (p) localStorage.setItem(FLOAT_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
function clampToViewport(x: number, y: number) {
  return { x: Math.max(0, Math.min(window.innerWidth - 160, x)), y: Math.max(0, Math.min(window.innerHeight - 160, y)) };
}
