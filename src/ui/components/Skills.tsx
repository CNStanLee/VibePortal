import { useEffect, useMemo, useState } from 'react';
import type { SkillDetail, SkillInfo, SkillSource } from '../../shared/types';
import { api } from '../api';
import { fmt, useT, type Dict } from '../i18n';
import { relTime, shortPath } from '../format';

type Filter = 'all' | 'library' | 'agents' | 'project';
const SRC_LABEL: Record<SkillSource, string> = { library: 'VibePortal', claude: 'Claude Code', codex: 'Codex', agents: '.agents', project: '' };

/**
 * Every skill the agents can use, with VibePortal's library on top: browse,
 * read, add by hand, install into Claude Code / Codex, or start a task with it.
 */
export function SkillsPage({ onUse }: { onUse: (ids: string[]) => void }) {
  const { t, lang } = useT();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = (fresh = false) =>
    api
      .skills(fresh)
      .then((s) => {
        setSkills(s);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load(true);
    const id = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(id);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (skills ?? [])
        .filter((s) => !s.installedCopy)
        .filter((s) => filter === 'all' || (filter === 'library' ? s.source === 'library' : filter === 'project' ? s.source === 'project' : ['claude', 'codex', 'agents'].includes(s.source)))
        .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
        // library first, then the user's own, managed (synced / system) last
        .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)),
    [skills, filter, q],
  );
  const current = shown.find((s) => s.id === sel) ?? null;
  // on a phone the details sit under the list: bring them into view
  useEffect(() => {
    if (sel && window.innerWidth <= 760) document.querySelector('.skill-detail-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [sel]);

  return (
    <div className="skills-page">
      <section className="card">
        <header className="card-head">
          <h2>{t.skills}</h2>
          <button className="btn primary" onClick={() => setCreating(true)}>
            + {t.newSkill}
          </button>
        </header>
        <p className="muted small">{t.skillsHelp}</p>
        <div className="skills-bar">
          <input className="skills-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.skillSearch} aria-label={t.skillSearch} />
          <div className="seg" role="radiogroup">
            {(['all', 'library', 'agents', 'project'] as Filter[]).map((f) => (
              <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? t.srcAll : f === 'library' ? t.srcLibrary : f === 'agents' ? t.srcAgents : t.srcProject}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="action-msg small">{error}</p>}
      </section>

      {creating && (
        <NewSkillForm
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            void load(true).then(() => setSel(s.id));
          }}
        />
      )}

      <div className="skills-layout">
        <ul className="skill-list" aria-label={t.skills}>
          {skills === null && !error && <li className="muted small">…</li>}
          {skills !== null && !shown.length && <li className="muted small">{t.noSkills}</li>}
          {shown.map((s) => (
            <li key={s.id}>
              <button className={`skill-item ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)} aria-pressed={sel === s.id}>
                <span className="skill-name">{s.name}</span>
                <span className="skill-desc">{s.description}</span>
                <span className="skill-tags">
                  <SourceTag s={s} t={t} />
                  {s.installed?.map((a) => (
                    <span key={a} className="nt-src src-open">
                      {fmt(t.installedIn, { a: a === 'claude' ? 'Claude Code' : 'Codex' })}
                    </span>
                  ))}
                  {s.source === 'library' && <span className="muted tiny">{s.manual ? t.manualSkill : s.origin ? t.autoArchived : ''}</span>}
                  <span className="muted tiny">{relTime(s.updatedAt, t, lang)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="skill-detail-wrap">{current ? <SkillView key={current.id} skill={current} onUse={onUse} onChanged={() => void load(true)} /> : <section className="card muted small">{t.pickSkill}</section>}</div>
      </div>
    </div>
  );
}

const rank = (s: SkillInfo) => (s.source === 'library' ? 0 : s.managed ? 3 : s.source === 'project' ? 2 : 1);

function SourceTag({ s, t }: { s: SkillInfo; t: Dict }) {
  if (s.source === 'project') return <span className="nt-src">{s.project?.split(/[/\\]/).pop()}</span>;
  return (
    <span className={`nt-src ${s.source === 'library' ? 'src-open' : ''}`}>
      {SRC_LABEL[s.source]}
      {s.managed ? ` · ${t.managed}` : ''}
    </span>
  );
}

function SkillView({ skill, onUse, onChanged }: { skill: SkillInfo; onUse: (ids: string[]) => void; onChanged: () => void }) {
  const { t } = useT();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.skill(skill.id).then(setDetail, (e) => setMsg((e as Error).message));
  }, [skill.id, skill.updatedAt]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lib = skill.source === 'library';

  return (
    <section className="card skill-view">
      <header className="card-head">
        <h2>{skill.name}</h2>
        <button className="btn primary" onClick={() => onUse([skill.id])}>
          ▶ {t.useInTask}
        </button>
      </header>
      <p className="small">{skill.description}</p>
      <p className="muted tiny mono" title={skill.path}>
        {shortPath(skill.path)}
        {skill.origin && (
          <>
            {' '}
            · {t.fromPath} {shortPath(skill.origin)}
          </>
        )}
      </p>
      <div className="action-row">
        {lib ? (
          <>
            {(['claude', 'codex'] as const).map((a) => {
              const on = skill.installed?.includes(a);
              const label = a === 'claude' ? 'Claude Code' : 'Codex';
              return (
                <button key={a} className="btn ghost" disabled={busy} onClick={() => void act(() => api.installSkill(skill.id, a, !on))} title={t.installHelp}>
                  {on ? `✓ ${fmt(t.installedIn, { a: label })} · ${t.uninstall}` : fmt(t.installTo, { a: label })}
                </button>
              );
            })}
            <button
              className="btn ghost"
              onClick={() => {
                setDraft(detail?.body ?? '');
                setEditing((x) => !x);
              }}
            >
              ✏️ {t.edit}
            </button>
            <button className="btn ghost danger" disabled={busy} onClick={() => confirm(t.confirmDelete) && void act(() => api.deleteSkill(skill.id))}>
              {t.delete}
            </button>
          </>
        ) : (
          <button className="btn ghost" disabled={busy} onClick={() => void act(() => api.archiveSkill(skill.id))}>
            ★ {t.addToLibrary}
          </button>
        )}
      </div>
      {msg && <p className="action-msg small">{msg}</p>}
      {editing ? (
        <form
          className="skill-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.updateSkill(skill.id, draft)).then(() => setEditing(false));
          }}
        >
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={18} spellCheck={false} className="mono" aria-label="SKILL.md" />
          <div className="action-row">
            <button className="btn primary" disabled={busy}>
              {t.save}
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              ×
            </button>
          </div>
        </form>
      ) : (
        <pre className="skill-body">{detail ? detail.body : '…'}</pre>
      )}
      {detail && detail.files.length > 1 && (
        <details className="small">
          <summary>
            {t.files} ({detail.files.length})
          </summary>
          <ul className="skill-files mono tiny">
            {detail.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function NewSkillForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (s: SkillInfo) => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card new-skill"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setMsg('');
        api
          .createSkill({ name, description, body })
          .then(onCreated, (err) => setMsg((err as Error).message))
          .finally(() => setBusy(false));
      }}
    >
      <h2>{t.newSkill}</h2>
      <label className="field">
        <span>{t.skillName}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="pr-review" autoFocus />
      </label>
      <label className="field">
        <span>{t.skillDesc}</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Use when reviewing a pull request…" />
      </label>
      <label className="field">
        <span>{t.skillBody}</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="mono" placeholder={'# Steps\n1. …'} />
      </label>
      {msg && <p className="action-msg small">{msg}</p>}
      <div className="action-row">
        <button className="btn primary" disabled={busy || !name.trim() || !description.trim()}>
          {t.create}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          ×
        </button>
      </div>
    </form>
  );
}
