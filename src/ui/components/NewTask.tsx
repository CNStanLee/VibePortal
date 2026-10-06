import { useEffect, useMemo, useState } from 'react';
import type { LaunchAgent, LaunchOptions, LaunchPermission, LaunchProject, SkillInfo } from '../../shared/types';
import { api, cachedLaunchOptions } from '../api';
import { fmt, useT, type Dict } from '../i18n';
import { ClaudeMark, CodexMark } from './Brand';
import { shortPath } from '../format';

const LAST_KEY = 'vp.lastLaunch';
interface Last {
  agent?: LaunchAgent;
  cwd?: string;
  model?: Partial<Record<LaunchAgent, string>>;
  effort?: Partial<Record<LaunchAgent, string>>;
  permission?: LaunchPermission;
}
function loadLast(): Last {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function saveLast(l: Last) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

const SRC_KEY: Record<LaunchProject['sources'][number], keyof Dict> = { open: 'srcOpen', vscode: 'srcVscode', claude: 'srcClaude', codex: 'srcCodex' };

/**
 * Start a new Claude Code / Codex session in a repo or VS Code folder, with a
 * chosen model and effort. `compact` is the pet's quick panel.
 */
export function NewTask({
  compact = false,
  initialSkills = [],
  onStarted,
  onClose,
}: {
  compact?: boolean;
  initialSkills?: string[];
  onStarted?: (taskId: string) => void;
  onClose?: () => void;
}) {
  const { t } = useT();
  const last = useMemo(loadLast, []);
  const [opts, setOpts] = useState<LaunchOptions | null>(null);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState<LaunchAgent>(last.agent ?? 'claude');
  const [query, setQuery] = useState('');
  const [cwd, setCwd] = useState(last.cwd ?? '');
  const [model, setModel] = useState(last.model?.[last.agent ?? 'claude'] ?? '');
  const [effort, setEffort] = useState(last.effort?.[last.agent ?? 'claude'] ?? '');
  const [permission, setPermission] = useState<LaunchPermission>(last.permission ?? 'default');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [picked, setPicked] = useState<string[]>(initialSkills);

  useEffect(() => {
    api.skills().then((s) => setSkills(s.filter((x) => !x.installedCopy)), () => {});
  }, []);

  useEffect(() => {
    cachedLaunchOptions()
      .then((o) => {
        setOpts(o);
        // fall back to an installed agent / a folder that still exists
        if (!o.agents[agent]?.available) {
          const other: LaunchAgent = agent === 'claude' ? 'codex' : 'claude';
          if (o.agents[other]?.available) pickAgent(other);
        }
        if (!cwd || !o.projects.some((p) => p.path === cwd)) setCwd(o.projects[0]?.path ?? '');
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickAgent = (a: LaunchAgent) => {
    setAgent(a);
    setModel(last.model?.[a] ?? '');
    setEffort(last.effort?.[a] ?? '');
  };

  const q = query.trim().toLowerCase();
  const projects = (opts?.projects ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  const shown = projects.slice(0, compact ? 5 : 8);
  const typedPath = /^(\/|[a-zA-Z]:[\\/])/.test(query.trim()) && !projects.some((p) => p.path === query.trim()) ? query.trim() : '';
  const info = opts?.agents[agent];

  const start = async () => {
    if (!cwd || !prompt.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.launch({ agent, cwd, prompt: prompt.trim(), model: model || undefined, effort: effort || undefined, permission, skills: picked.length ? picked : undefined });
      saveLast({
        agent,
        cwd,
        permission,
        model: { ...last.model, [agent]: model },
        effort: { ...last.effort, [agent]: effort },
      });
      setPrompt('');
      onStarted?.(r.taskId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={`new-task ${compact ? 'compact' : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose?.();
      }}
    >
      <div className="nt-head">
        <b>{t.newTaskTitle}</b>
        {onClose && (
          <button type="button" className="link" onClick={onClose} aria-label="close">
            ×
          </button>
        )}
      </div>

      <div className="nt-agents" role="radiogroup" aria-label={t.agent}>
        {(['claude', 'codex'] as LaunchAgent[]).map((a) => {
          const ok = opts?.agents[a]?.available ?? true;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={agent === a}
              className={`nt-agent ${agent === a ? 'on' : ''}`}
              disabled={!ok}
              onClick={() => pickAgent(a)}
              title={ok ? undefined : t.cliMissing}
            >
              {a === 'claude' ? <ClaudeMark size={13} /> : <CodexMark size={13} />} {a === 'claude' ? 'Claude Code' : 'Codex'}
              {!ok && <span className="muted tiny"> · {t.cliMissing}</span>}
            </button>
          );
        })}
      </div>

      <label className="nt-label">{t.project}</label>
      <input className="nt-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.projectSearch} spellCheck={false} />
      <ul className="nt-projects" role="listbox" aria-label={t.project}>
        {typedPath && (
          <li role="option" aria-selected={cwd === typedPath} className={cwd === typedPath ? 'on' : ''} onClick={() => setCwd(typedPath)}>
            <span className="nt-pname">📁 {t.usePath}</span>
            <span className="nt-ppath mono">{typedPath}</span>
          </li>
        )}
        {shown.map((p) => (
          <li key={p.path} role="option" aria-selected={cwd === p.path} className={cwd === p.path ? 'on' : ''} onClick={() => setCwd(p.path)} title={p.path}>
            <span className="nt-pname">
              {p.name}
              {p.sources.map((s) => (
                <span key={s} className={`nt-src src-${s}`}>
                  {t[SRC_KEY[s]]}
                </span>
              ))}
            </span>
            <span className="nt-ppath mono">{shortPath(p.path)}</span>
          </li>
        ))}
        {opts && !shown.length && !typedPath && <li className="muted small nt-empty">{t.noProjects}</li>}
        {!opts && !error && <li className="muted small nt-empty">…</li>}
      </ul>

      <div className="nt-row">
        <label>
          <span className="nt-label">{t.model}</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">
              {t.byDefault}
              {info?.defaultModel ? ` (${info.defaultModel})` : ''}
            </option>
            {info?.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="nt-label">{t.effort}</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">
              {t.byDefault}
              {info?.defaultEffort ? ` (${info.defaultEffort})` : ''}
            </option>
            {info?.efforts.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {!compact && (
          <label>
            <span className="nt-label">{t.permission}</span>
            <select value={permission} onChange={(e) => setPermission(e.target.value as LaunchPermission)} title={t.permHelp}>
              <option value="default">{t.permDefault}</option>
              <option value="edits">{t.permEdits}</option>
            </select>
          </label>
        )}
      </div>

      <SkillPicker skills={skills} cwd={cwd} picked={picked} onChange={setPicked} />

      <textarea
        className="nt-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t.taskPrompt}
        rows={compact ? 2 : 4}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start();
        }}
      />
      {!compact && <div className="muted tiny">{t.permHelp}</div>}
      <div className="nt-foot">
        {error && <span className="action-msg small">{error}</span>}
        <button className="btn primary" disabled={busy || !cwd || !prompt.trim() || !info?.available} title="Ctrl+Enter">
          {busy ? t.starting : t.start}
        </button>
      </div>
    </form>
  );
}

/** Chosen skills as chips, plus a dropdown to add more (project skills only for the chosen folder). */
function SkillPicker({ skills, cwd, picked, onChange }: { skills: SkillInfo[]; cwd: string; picked: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useT();
  const usable = skills.filter((s) => s.source !== 'project' || s.project === cwd);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const rest = usable.filter((s) => !picked.includes(s.id));
  const groups: [string, SkillInfo[]][] = [
    [t.srcLibrary, rest.filter((s) => s.source === 'library')],
    [t.srcProject, rest.filter((s) => s.source === 'project')],
    [t.srcAgents, rest.filter((s) => s.source !== 'library' && s.source !== 'project')],
  ];
  if (!skills.length && !picked.length) return null;
  return (
    <div className="nt-skills">
      <span className="nt-label">
        {t.skillsOptional}
        {picked.length > 0 && ` · ${fmt(t.skillsPicked, { n: picked.length })}`}
      </span>
      <div className="nt-skill-chips">
        {picked.map((id) => (
          <span key={id} className="chip on" title={byId.get(id)?.description}>
            {byId.get(id)?.name ?? id}
            <button type="button" className="link" aria-label="remove" onClick={() => onChange(picked.filter((x) => x !== id))}>
              ×
            </button>
          </span>
        ))}
        {rest.length > 0 && (
          <select value="" onChange={(e) => e.target.value && onChange([...picked, e.target.value])} aria-label={t.skillsOptional}>
            <option value="">+ {t.skills}…</option>
            {groups
              .filter(([, list]) => list.length)
              .map(([label, list]) => (
                <optgroup key={label} label={label}>
                  {list.slice(0, 60).map((s) => (
                    <option key={s.id} value={s.id} title={s.description}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
        )}
      </div>
    </div>
  );
}
