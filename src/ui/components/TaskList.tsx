import { useEffect, useRef, useState } from 'react';
import type { TaskInfo } from '../../shared/types';
import { TaskActions, followTask } from './TaskActions';
import { PermissionPrompt, TaskHistoryView } from './TaskDetail';
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

export function TaskList({
  tasks,
  compact = false,
  expandable = false,
  machineName,
  title,
}: {
  tasks: TaskInfo[];
  compact?: boolean;
  expandable?: boolean;
  /** this machine's name, shown on local tasks (remote ones show their host) */
  machineName?: string;
  /** the card's heading: with it, the list brings its own header (and the archive button) */
  title?: string;
}) {
  const { t, lang } = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const live = tasks.filter((x) => !x.archived);
  const archived = tasks.filter((x) => x.archived);
  const inactive = live.filter((x) => x.state === 'idle' || x.state === 'done' || x.state === 'failed');
  const shown = compact ? live.filter((x) => x.state !== 'idle').slice(0, 6) : live;
  const historyTask = followTask(tasks, historyId);
  // a run you just started from a row: it may not be in the snapshot yet
  const expected = useRef<{ id: string; until: number } | null>(null);
  // a run that went on with your instruction stays expanded
  useEffect(() => {
    if (!open || tasks.some((x) => x.id === open)) return;
    if (expected.current?.id === open && Date.now() < expected.current.until) return;
    setOpen(followTask(tasks, open)?.id ?? null);
  }, [tasks, open]);
  const archive = (body: { ids?: string[]; restore?: boolean }) => {
    setArchiving(true);
    void api
      .archiveTasks(body)
      .catch(() => {})
      .finally(() => setArchiving(false));
  };
  const head = title !== undefined && (
    <header className="card-head">
      <h2>{title}</h2>
      {inactive.length > 0 && (
        <button className="btn ghost" disabled={archiving} title={t.tasksArchiveHelp} onClick={() => archive({ ids: inactive.map((x) => x.id) })}>
          📦 {t.tasksArchive} <span className="muted">{inactive.length}</span>
        </button>
      )}
    </header>
  );
  const row = (task: TaskInfo) => (
        <li key={task.id} className={`task st-${task.state} ${open === task.id ? 'open' : ''} ${expandable ? 'expandable' : ''} ${task.archived ? 'archived' : ''}`}>
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
              {(task.host || machineName) && (
                <span className={`host-tag ${task.host ? '' : 'local'}`} title={`${t.machine}: ${task.host ?? machineName}`}>
                  🖥 {task.host ?? machineName}
                </span>
              )}
            </div>
            {task.permissions && open !== task.id && <PermissionPrompt items={task.permissions} compact />}
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
            {task.archived && (
              <button className="link" disabled={archiving} onClick={() => archive({ ids: [task.id], restore: true })}>
                {t.tasksRestore}
              </button>
            )}
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
              {task.permissions && <PermissionPrompt items={task.permissions} />}
              <TaskActions
                task={task}
                onDone={() => setOpen(null)}
                onHistory={() => setHistoryId(task.id)}
                onContinued={(id) => {
                  expected.current = { id, until: Date.now() + 8000 };
                  setOpen(id);
                }}
              />
            </div>
          )}
        </li>
  );
  return (
    <>
      {head}
      {historyTask && <TaskHistoryView task={historyTask} device={historyTask.host ?? machineName} onClose={() => setHistoryId(null)} />}
      {shown.length ? <ul className="tasks">{shown.map(row)}</ul> : <p className="muted empty">{archived.length && !compact ? t.tasksAllArchived : t.noTasks}</p>}
      {!compact && archived.length > 0 && (
        <div className="tasks-archived">
          <div className="tasks-archived-bar">
            <button className="link" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
              📦 {t.tasksArchived} · {archived.length} {showArchived ? '▴' : '▾'}
            </button>
            {showArchived && (
              <button className="link" disabled={archiving} onClick={() => archive({ restore: true })}>
                {t.tasksRestoreAll}
              </button>
            )}
          </div>
          {showArchived && <ul className="tasks">{archived.map(row)}</ul>}
        </div>
      )}
    </>
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
