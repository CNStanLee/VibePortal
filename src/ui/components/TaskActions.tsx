import { useEffect, useState } from 'react';
import type { TaskContext, TaskInfo } from '../../shared/types';
import { api, desktop, dismissTask, runOverride } from '../api';

/** A phone / another computer: the VS Code hand-off would only fill in text on this machine's screen. */
const remoteViewer = () => !desktop() && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
import { useT } from '../i18n';

/** A task, or the background run that took its conversation over (queued instructions). */
export function followTask(tasks: TaskInfo[], id: string | null): TaskInfo | undefined {
  if (!id) return undefined;
  return tasks.find((x) => x.id === id) ?? tasks.find((x) => x.continuedFrom === id);
}

/**
 * "What next?" panel for one task: shows the last exchange, can ask Claude for
 * suggested next steps, and sends a new instruction (continue / fork in the background).
 */
export function TaskActions({
  task,
  compact = false,
  hideContext = false,
  onDone,
  onHistory,
  onContinued,
}: {
  task: TaskInfo;
  compact?: boolean;
  /** the history view shows the conversation itself */
  hideContext?: boolean;
  onDone?: () => void;
  /** opens the full conversation */
  onHistory?: () => void;
  /** the instruction started a run (task id): show that one instead of closing */
  onContinued?: (taskId: string) => void;
}) {
  const { t, lang } = useT();
  const [ctx, setCtx] = useState<TaskContext | null>(null);
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'' | 'suggest' | 'send'>('');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let alive = true;
    setCtx(null);
    api
      .taskContext(task.id)
      .then((c) => alive && setCtx(c))
      .catch(() => alive && setCtx({}));
    return () => {
      alive = false;
    };
  }, [task.id, task.updatedAt]);

  const suggest = async () => {
    setBusy('suggest');
    setMsg('');
    try {
      setSuggestions((await api.suggest(task.id, lang)).suggestions);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  // a conversation open in VS Code is owned by the extension: hand the instruction to it
  // (one history) instead of running a background copy next to it
  const vscodeClaude = task.kind === 'claude-code' && task.alive && task.ide === 'vscode';
  const vscodeCodex = task.kind === 'codex' && task.ide === 'vscode';
  // away from the desk, an instruction has to actually run: default to the background run there
  const away = remoteViewer();
  const handoffFirst = (vscodeClaude || vscodeCodex) && !away;
  // a background run that is still busy takes the instruction as a follow-up for when its turn ends
  const busyRun = task.kind === 'dispatch' && (task.state === 'running' || task.state === 'waiting');
  const toVscode = async () => {
    const prompt = text.trim();
    setBusy('send');
    setMsg('');
    try {
      if (vscodeCodex && prompt) await navigator.clipboard?.writeText(prompt).catch(() => {});
      await api.openInVscode(task.id, vscodeClaude ? prompt : undefined);
      setMsg(vscodeClaude ? t.sentToVscode : t.openedCodexVscode);
      setText('');
      dismissTask(task.id, task.finishedAt ?? task.updatedAt);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const send = async () => {
    const prompt = text.trim();
    if (!prompt) return;
    setBusy('send');
    setMsg('');
    try {
      const r = await api.continueTask(task.id, prompt, runOverride(task.id));
      setText('');
      setSuggestions(null);
      if (r.queued) return setMsg(t.queuedMsg);
      setMsg(away ? t.startedAway : t.started);
      dismissTask(task.id, task.finishedAt ?? task.updatedAt);
      if (onContinued) onContinued(`dispatch:${r.jobId}`);
      else setTimeout(() => onDone?.(), 1200);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const unqueue = async () => {
    try {
      await api.clearQueue(task.id);
      setMsg('');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const copyOpen = async () => {
    try {
      await navigator.clipboard?.writeText(text.trim());
    } catch {
      /* clipboard blocked */
    }
    void api.openTask(task.id).catch((e) => setMsg((e as Error).message));
  };

  const reply = ctx?.lastReply ?? ctx?.output;
  const forked = task.kind === 'claude-code' && task.alive;

  return (
    <div className={`task-actions ${compact ? 'compact' : ''}`} onPointerDown={(e) => e.stopPropagation()}>
      {hideContext ? null : ctx === null ? (
        <div className="muted small">…</div>
      ) : (
        <>
          {!compact && ctx.lastPrompt && (
            <div className="ctx-block">
              <div className="ctx-label">{t.lastPrompt}</div>
              <div className="ctx-text">{ctx.lastPrompt}</div>
            </div>
          )}
          {reply && (
            <div className="ctx-block">
              <div className="ctx-label">{ctx.output ? t.jobOutput : t.lastReply}</div>
              <div className="ctx-text">{reply}</div>
            </div>
          )}
        </>
      )}
      {task.canContinue && (
        <>
          {task.queued && task.queued.length > 0 && (
            <div className="queued">
              <div className="ctx-label">
                ⏳ {t.queuedTitle}{' '}
                <button type="button" className="link" onClick={() => void unqueue()}>
                  {t.unqueue}
                </button>
              </div>
              {task.queued.map((q, i) => (
                <div key={i} className="queued-item">
                  {q}
                </div>
              ))}
            </div>
          )}
          {suggestions && suggestions.length > 0 && (
            <div className="chips">
              {suggestions.map((sug) => (
                <button key={sug} className="chip" onClick={() => setText(sug)} title={sug}>
                  {sug}
                </button>
              ))}
            </div>
          )}
          <form
            className="instr"
            onSubmit={(e) => {
              e.preventDefault();
              void (handoffFirst ? toVscode() : send());
            }}
          >
            <textarea
              value={text}
              rows={1}
              onChange={(e) => {
                setText(e.target.value);
                // grow with the text (up to a limit), like a chat box
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
              }}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter is a new line (on phones the send button does it)
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={busyRun ? t.queuePh : t.instructionPh}
              disabled={busy === 'send'}
              aria-label={t.instructionPh}
            />
            <button className="btn primary" disabled={!text.trim() || !!busy} title={handoffFirst && vscodeClaude ? t.sendToVscodeHelp : undefined}>
              {busy === 'send'
                ? '…'
                : busyRun
                  ? t.queueSend
                  : handoffFirst
                  ? vscodeClaude
                    ? t.sendToVscode
                    : t.openCodexVscode
                  : vscodeClaude
                    ? t.runNowCopy
                    : t.runNow}
            </button>
          </form>
          {handoffFirst && (
            <div className="muted tiny">
              {vscodeClaude ? t.sendToVscodeHelp : t.bgSameThread}{' '}
              <button type="button" className="link" disabled={!text.trim() || !!busy} onClick={() => void send()}>
                {vscodeClaude ? t.forkInstead : t.send}
              </button>
            </div>
          )}
          {away && (vscodeClaude || vscodeCodex) && (
            <div className="muted tiny">
              {vscodeClaude ? t.awayClaudeNote : t.awayCodexNote}{' '}
              <button type="button" className="link" disabled={!text.trim() || !!busy} onClick={() => void toVscode()}>
                {t.handoffDesktop}
              </button>
            </div>
          )}
          {forked && !vscodeClaude && <div className="muted tiny">{t.forkNote}</div>}
        </>
      )}
      <div className="action-row">
        {onHistory && (
          <button className="btn ghost" onClick={onHistory}>
            📜 {t.fullHistory}
          </button>
        )}
        {(task.kind === 'claude-code' || task.kind === 'codex' || (task.kind === 'dispatch' && task.sessionId)) && !task.host && (
          <button className="btn ghost" onClick={() => void api.openInVscode(task.id).then(() => setMsg(t.openedInVscode), (e) => setMsg((e as Error).message))} title={t.openInVscodeHelp}>
            🧩 {t.openInVscode}
          </button>
        )}
        {task.canContinue && (
          <button className="btn ghost" onClick={suggest} disabled={!!busy}>
            💡 {busy === 'suggest' ? t.suggesting : t.suggest}
          </button>
        )}
        {task.cwd && (
          <button className="btn ghost" onClick={forked && text.trim() ? copyOpen : () => void api.openTask(task.id).catch((e) => setMsg((e as Error).message))}>
            📂 {forked && text.trim() ? t.copyOpen : t.openRepo}
          </button>
        )}
        <button
          className="btn ghost"
          onClick={() => {
            dismissTask(task.id, task.finishedAt ?? task.updatedAt);
            onDone?.();
          }}
        >
          {t.dismiss}
        </button>
      </div>
      {msg && <div className="action-msg small">{msg}</div>}
    </div>
  );
}
