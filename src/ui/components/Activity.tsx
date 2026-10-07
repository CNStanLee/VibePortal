import { useEffect, useState } from 'react';
import type { ActivityItem, ActivityVerb, LaunchOptions, TaskInfo, TaskPlan } from '../../shared/types';
import { cachedLaunchOptions, effortsFor, runOverride, setRunOverride, type RunOverride } from '../api';
import { fmt, useT, type Dict } from '../i18n';

/*
 * Progress shown in the pet's speech bubble. The server sends structured items
 * (verb + raw target); labels are localized here. The agent's own words are
 * shown as written — nothing is translated or generated.
 */

const VERB: Record<ActivityVerb, { icon: string; key: keyof Dict }> = {
  read: { icon: '📖', key: 'actRead' },
  edit: { icon: '✏️', key: 'actEdit' },
  write: { icon: '📝', key: 'actWrite' },
  run: { icon: '▶', key: 'actRun' },
  search: { icon: '🔍', key: 'actSearch' },
  web: { icon: '🌐', key: 'actWeb' },
  agent: { icon: '🤝', key: 'actAgent' },
  ask: { icon: '❓', key: 'actAsk' },
  wait: { icon: '⏳', key: 'actWait' },
  tool: { icon: '🔧', key: 'actTool' },
};

export function activityLine(item: ActivityItem, t: Dict): { icon: string; label: string; text?: string } {
  if (item.kind === 'say') return { icon: '💬', label: '', text: item.text };
  if (item.kind === 'prompt') return { icon: '🙋', label: t.actYou, text: item.text };
  const v = VERB[item.verb ?? 'tool'];
  const text = item.verb === 'tool' ? [item.tool, item.text].filter(Boolean).join(' · ') : item.text;
  return { icon: v.icon, label: t[v.key], text };
}

export function ActivityFeed({ items, max }: { items: ActivityItem[]; max: number }) {
  const { t, lang } = useT();
  const shown = items.slice(-max);
  return (
    <ul className="pet-feed">
      {shown.map((item, i) => {
        const l = activityLine(item, t);
        const latest = i === shown.length - 1;
        return (
          // keyed by time: a new line mounts (and fades in), older ones just lose the highlight
          <li
            key={`${item.ts}-${item.kind}`}
            className={`pet-feed-row k-${item.kind} ${latest ? 'latest' : ''}`}
            title={`${new Date(item.ts).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en')} · ${l.label} ${l.text ?? ''}`}
          >
            <span className="pet-feed-icon" aria-hidden>
              {l.icon}
            </span>
            {l.label && <span className="pet-feed-verb">{l.label}</span>}
            {l.text && <span className="pet-feed-text">{l.text}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function PlanBar({ plan, open }: { plan: TaskPlan; open: boolean }) {
  const { t } = useT();
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  const steps = open ? planWindow(plan) : [];
  return (
    <div className="pet-plan">
      <div className="pet-plan-row" title={fmt(t.planStepsDone, { d: plan.done, n: plan.total })}>
        <span className="pet-plan-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t.taskPlan}>
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="pet-plan-n">
          {plan.done}/{plan.total}
        </span>
        {!open && plan.current && <span className="pet-plan-cur">{plan.current}</span>}
      </div>
      {steps.length > 0 && (
        <ol className="pet-steps">
          {steps.map((s, i) => (
            <li key={i} className={`step-${s.status}`}>
              <span aria-hidden>{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▸' : '·'}</span> {s.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Up to six steps around the one in progress. */
function planWindow(plan: TaskPlan) {
  const cur = Math.max(0, plan.steps.findIndex((s) => s.status !== 'completed'));
  const start = Math.max(0, Math.min(cur - 2, plan.steps.length - 6));
  return plan.steps.slice(start, start + 6);
}

/** Simple percent bar for custom tasks that report `progress`. */
export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="pet-plan-row">
      <span className="pet-plan-track" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${value}%` }} />
      </span>
      <span className="pet-plan-n">{Math.round(value)}%</span>
    </div>
  );
}

/** Shortens "claude-opus-5-5-20260101" → "opus-5-5". */
const shortModel = (m?: string) => m?.replace(/^claude-/, '').replace(/-\d{8}$/, '');

/**
 * Current model + effort of the task, and a picker for the next instruction
 * sent from here (an interactive session can't be switched from outside).
 */
export function ModelChip({ task, editable = true }: { task: TaskInfo; editable?: boolean }) {
  const { t } = useT();
  const w = task.workload;
  const agent = task.kind === 'codex' || task.provider === 'openai' ? 'codex' : 'claude';
  const [ov, setOv] = useState<RunOverride>(() => runOverride(task.id));
  const [editing, setEditing] = useState(false);
  const [opts, setOpts] = useState<LaunchOptions | null>(null);
  useEffect(() => {
    if (editing && !opts) cachedLaunchOptions().then(setOpts).catch(() => {});
  }, [editing, opts]);
  // a collapsed bubble only shows the chip; the picker lives in the expanded one
  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  const canEdit = !!task.canContinue && editable;
  if (!w?.model && !w?.effort && !task.canContinue) return null;
  const cur = [shortModel(w?.model), w?.effort].filter(Boolean).join(' · ') || '—';
  const next = [shortModel(ov.model), ov.effort].filter(Boolean).join(' · ');
  const info = opts?.agents[agent];
  const update = (o: RunOverride) => {
    setOv(o);
    setRunOverride(task.id, o);
  };
  return (
    <div className="pet-model" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`model-chip ${next ? 'has-next' : ''}`}
        disabled={!canEdit}
        onClick={() => setEditing((x) => !x)}
        aria-expanded={editing}
        title={`${t.model} · ${t.effort}${task.canContinue ? ` — ${t.nextRunHelp}` : ''}`}
      >
        <span aria-hidden>◆</span> {cur}
        {next && (
          <span className="model-next">
            {' '}
            → {next}
          </span>
        )}
        {canEdit && <span aria-hidden> ▾</span>}
      </button>
      {editing && (
        <div className="model-edit">
          <label>
            <span>{t.model}</span>
            <select value={ov.model ?? ''} onChange={(e) => update({ ...ov, model: e.target.value || undefined })}>
              <option value="">
                {t.current}
                {w?.model ? ` (${shortModel(w.model)})` : ''}
              </option>
              {info?.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t.effort}</span>
            <select value={ov.effort ?? ''} onChange={(e) => update({ ...ov, effort: e.target.value || undefined })}>
              <option value="">
                {t.current}
                {w?.effort ? ` (${w.effort})` : ''}
              </option>
              {effortsFor(info, ov.model ?? w?.model).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <div className="model-edit-foot" title={t.nextRunHelp}>
            <span className="muted tiny">ⓘ {t.nextRun}</span>
            {next && (
              <button type="button" className="link" onClick={() => update({})}>
                {t.resetDefault}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

