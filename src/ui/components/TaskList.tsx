import { useState } from 'react';
import type { TaskInfo } from '../../shared/types';
import { TaskActions } from './TaskActions';
import { ActivityFeed, ModelChip, PlanBar, activityLine } from './Activity';
import { ClaudeMark, CodexMark } from './Brand';
import { api } from '../api';
import { useT } from '../i18n';
import { fmtTokens, relTime, shortPath } from '../format';

const STATE_ICON: Record<TaskInfo['state'], string> = {
  running: '◐',
  waiting: '⏳',
  idle: '○',
  done: '✓',
  failed: '✕',
};

const KIND_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', custom: 'Custom', dispatch: 'Run' };

export function TaskList({ tasks, compact = false, expandable = false }: { tasks: TaskInfo[]; compact?: boolean; expandable?: boolean }) {
  const { t, lang } = useT();
  const [open, setOpen] = useState<string | null>(null);
  const shown = compact ? tasks.filter((x) => x.state !== 'idle').slice(0, 6) : tasks;
  if (!shown.length) return <p className="muted empty">{t.noTasks}</p>;
  return (
    <ul className="tasks">
      {shown.map((task) => (
        <li key={task.id} className={`task st-${task.state} ${open === task.id ? 'open' : ''} ${expandable ? 'expandable' : ''}`}>
          <span className="task-state" title={t[task.state]}>
            <span className="task-icon" aria-hidden>
              {STATE_ICON[task.state]}
            </span>
            <span className="task-state-label">{t[task.state]}</span>
          </span>
          <div
            className="task-main"
            role={expandable ? 'button' : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? open === task.id : undefined}
            onClick={expandable ? () => setOpen(open === task.id ? null : task.id) : undefined}
            onKeyDown={
              expandable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpen(open === task.id ? null : task.id);
                    }
                  }
                : undefined
            }
          >
            <div className="task-title">
              <span className={`kind kind-${task.kind}`}>
                {task.kind === 'claude-code' ? <ClaudeMark size={11} /> : task.kind === 'codex' ? <CodexMark size={11} /> : null}
                {KIND_LABEL[task.kind] ?? task.kind}
              </span>
              <span className="task-name">{task.title}</span>
              {task.host && <span className="host-tag">@{task.host}</span>}
            </div>
            {open !== task.id && <LatestActivity task={task} />}
            {(task.detail || task.cwd) && (
              <div className="task-detail">
                {task.detail}
                {task.detail && task.cwd ? ' · ' : ''}
                {task.cwd && <span className="mono">{shortPath(task.cwd)}</span>}
              </div>
            )}
            {task.workload && (
              <div className="task-work small muted">
                ⚡ {fmtTokens(task.workload.tokensPerMin)} {t.tokPerMin}
                {task.workload.contextTokens && task.workload.contextWindow
                  ? ` · ${t.ctx} ${Math.round((task.workload.contextTokens / task.workload.contextWindow) * 100)}%`
                  : ''}
                {` · ${t.sessionTotal} ${fmtTokens(task.workload.sessionTokens)}`}
              </div>
            )}
            {task.progress !== undefined && (
              <div className="task-progress" role="progressbar" aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${task.progress}%` }} />
              </div>
            )}
          </div>
          <div className="task-meta">
            <span className="muted small">{relTime(task.updatedAt, t, lang)}</span>
            {(task.kind === 'custom' || task.kind === 'dispatch') && !compact && (
              <button className="link" onClick={() => void api.deleteTask(task.id)}>
                {t.remove}
              </button>
            )}
            {expandable && (
              <button className="link" onClick={() => setOpen(open === task.id ? null : task.id)} aria-label={open === task.id ? 'collapse' : 'expand'}>
                {open === task.id ? '▴' : '▾'}
              </button>
            )}
          </div>
          {open === task.id && (
            <div className="task-panel">
              <ModelChip task={task} />
              {task.activity?.plan && <PlanBar plan={task.activity.plan} open />}
              {!!task.activity?.feed.length && <ActivityFeed items={task.activity.feed} max={6} />}
              <TaskActions task={task} onDone={() => setOpen(null)} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One-line "what it's doing now" under a collapsed task. */
function LatestActivity({ task }: { task: TaskInfo }) {
  const { t } = useT();
  const last = task.activity?.feed.at(-1);
  if (!last) return null;
  const l = activityLine(last, t);
  const plan = task.activity?.plan;
  return (
    <div className="task-latest small">
      {plan && (
        <span className="task-plan-n">
          {plan.done}/{plan.total}
        </span>
      )}
      <span aria-hidden>{l.icon}</span> {l.label && <b>{l.label}</b>} <span className="task-latest-text">{l.text}</span>
    </div>
  );
}
