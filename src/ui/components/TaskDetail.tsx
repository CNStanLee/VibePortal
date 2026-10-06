import { useEffect, useRef, useState } from 'react';
import type { HistoryItem, PendingPermission, TaskHistory, TaskInfo } from '../../shared/types';
import { api } from '../api';
import { fmt, useT, type Dict } from '../i18n';
import { relTime, shortPath } from '../format';
import { activityLine } from './Activity';
import { TaskActions } from './TaskActions';

/** A background run is waiting for you: allow / deny the tool call it wants to make. */
export function PermissionPrompt({ items, compact = false }: { items: PendingPermission[]; compact?: boolean }) {
  const { t } = useT();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  if (!items.length) return null;
  const answer = async (p: PendingPermission, allow: boolean, always = false) => {
    setBusy(p.id);
    setMsg('');
    try {
      await api.answerPermission(p.id, allow, always);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className={`perm-prompt ${compact ? 'compact' : ''}`} onPointerDown={(e) => e.stopPropagation()} role="alert">
      {items.map((p) => (
        <div key={p.id} className="perm-item">
          <div className="perm-title">
            🔐 {fmt(t.permWants, { tool: p.tool })}
          </div>
          <code className="perm-what">{p.summary}</code>
          <div className="perm-actions">
            <button className="btn primary" disabled={!!busy} onClick={() => void answer(p, true)}>
              {t.allow}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => void answer(p, false)}>
              {t.deny}
            </button>
            {!compact && (
              <button className="link small" disabled={!!busy} onClick={() => void answer(p, true, true)}>
                {fmt(t.allowAlways, { tool: p.tool })}
              </button>
            )}
          </div>
        </div>
      ))}
      {msg && <p className="action-msg small">{msg}</p>}
    </div>
  );
}

function historyLine(item: HistoryItem, t: Dict) {
  if (item.role !== 'tool') return null;
  return activityLine({ kind: 'tool', ts: item.ts ?? '', verb: item.verb, tool: item.tool, text: item.text }, t);
}

/** The whole conversation of a task (recent part), with the instruction box under it. */
export function TaskHistoryView({ task, device, onClose }: { task: TaskInfo; device?: string; onClose: () => void }) {
  const { t, lang } = useT();
  const [history, setHistory] = useState<TaskHistory | null>(null);
  const [error, setError] = useState('');
  const [showTools, setShowTools] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const load = () =>
    api
      .taskHistory(task.id)
      .then((h) => {
        setHistory(h);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    // follow a running conversation
    const id = window.setInterval(load, task.state === 'running' || task.state === 'waiting' ? 4000 : 20_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.state]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [history?.items.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = (history?.items ?? []).filter((i) => showTools || (i.role !== 'tool' && i.role !== 'result'));
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal history-modal" role="dialog" aria-modal="true" aria-label={task.title}>
        <header className="history-head">
          <div className="history-title">
            <b>{task.title}</b>
            <span className="muted tiny">
              {device && <span className="host-tag">{device}</span>} {task.cwd && <span className="mono">{shortPath(task.cwd)}</span>} · {relTime(task.updatedAt, t, lang)}
            </span>
          </div>
          <label className="check small">
            <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} />
            <span>{t.showTools}</span>
          </label>
          <button className="link" onClick={onClose} aria-label="close">
            ×
          </button>
        </header>
        <div className="history-body">
          {error && <p className="action-msg small">{error}</p>}
          {history === null && !error && <p className="muted small">…</p>}
          {history?.truncated && <p className="muted tiny history-note">{t.historyTruncated}</p>}
          {history && !history.items.length && <p className="muted small">{t.historyEmpty}</p>}
          {items.map((i, n) => {
            const tool = historyLine(i, t);
            return (
              <div key={n} className={`msg msg-${i.role} ${i.error ? 'err' : ''}`} title={i.ts ? new Date(i.ts).toLocaleString() : undefined}>
                {tool ? (
                  <span>
                    <span aria-hidden>{tool.icon}</span> <b>{tool.label}</b> <span className="mono">{tool.text}</span>
                  </span>
                ) : i.role === 'result' ? (
                  <pre>{i.text}</pre>
                ) : (
                  <div className="msg-text">{i.text}</div>
                )}
              </div>
            );
          })}
          <div ref={end} />
        </div>
        <footer className="history-foot">
          {task.permissions && <PermissionPrompt items={task.permissions} />}
          <TaskActions task={task} compact hideContext onDone={() => void load()} />
        </footer>
      </div>
    </div>
  );
}
