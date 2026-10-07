import { useEffect, useState } from 'react';
import type { GitRepositories, LaunchOptions, LaunchProject } from '../../shared/types';
import { api, cachedLaunchOptions } from '../api';
import { relTime, shortPath } from '../format';
import { useT } from '../i18n';
import { PROJECT_SOURCE_KEY } from './NewTask';

/** Pick a known folder or clone a recent GitHub repo onto the host before starting work. */
export function OfficeWorkspace({ cwd, opts, disabled, onChange, onOptions, onBusy }: {
  cwd?: string;
  opts: LaunchOptions | null;
  disabled: boolean;
  onChange: (cwd: string) => void;
  onOptions: (opts: LaunchOptions) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t, lang } = useT();
  const [source, setSource] = useState<'local' | 'github'>('local');
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<GitRepositories | null>(null);
  const [repo, setRepo] = useState('');
  const [cloneDir, setCloneDir] = useState('');
  const [savedDir, setSavedDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<'' | 'save' | 'clone'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    api.settings().then((s) => {
      // a host still running an older VibePortal has no clone directory yet
      if (alive) { setCloneDir(s.cloneDir ?? ''); setSavedDir(s.cloneDir ?? ''); }
    }).catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, []);

  const refresh = async (next: typeof source = source) => {
    setLoading(true);
    setError('');
    try {
      if (next === 'local') onOptions(await cachedLaunchOptions(true));
      else {
        const result = await api.repositories();
        setRemote(result);
        setRepo((old) => result.repositories.some((r) => r.fullName === old) ? old : '');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setLoading(false); }
  };
  const pickSource = (next: typeof source) => {
    setSource(next);
    setQuery('');
    setError('');
    setNotice('');
    if (next === 'github' && !remote) void refresh(next);
  };
  const saveDirectory = async () => {
    const settings = await api.saveSettings({ cloneDir: cloneDir.trim() });
    setCloneDir(settings.cloneDir ?? '');
    setSavedDir(settings.cloneDir ?? '');
  };
  const save = async () => {
    setWorking('save');
    setError('');
    setNotice('');
    try { await saveDirectory(); setNotice(t.saved); }
    catch (e) { setError((e as Error).message); }
    finally { setWorking(''); }
  };
  const clone = async () => {
    if (!repo || !cloneDir.trim() || disabled || working) return;
    setWorking('clone');
    onBusy(true);
    setError('');
    setNotice('');
    try {
      if (cloneDir.trim() !== savedDir) await saveDirectory();
      const project = await api.cloneRepository(repo);
      if (opts) onOptions({ ...opts, projects: [project, ...opts.projects.filter((p) => p.path !== project.path)] });
      onChange(project.path);
      setSource('local');
      setQuery('');
    } catch (e) {
      setError((e as Error).message);
    } finally { setWorking(''); onBusy(false); }
  };

  const q = query.trim().toLowerCase();
  const projects = (opts?.projects ?? []).filter((p) => !q || `${p.name} ${p.path}`.toLowerCase().includes(q));
  const typedPath = /^(\/|[a-zA-Z]:[\\/])/.test(query.trim()) && !projects.some((p) => p.path === query.trim()) ? query.trim() : '';
  const repositories = (remote?.repositories ?? []).filter((r) => !q || `${r.fullName} ${r.description}`.toLowerCase().includes(q));
  const locked = disabled || !!working;
  const separator = cloneDir.includes('\\') ? '\\' : '/';
  const target = repo && cloneDir.trim() ? `${cloneDir.trim().replace(/[\\/]+$/, '')}${separator}${repo.split('/')[1]}` : '';
  const projectRow = (p: LaunchProject) => (
    <li key={p.path}>
      <button type="button" className={`workspace-project ${cwd === p.path ? 'on' : ''}`} aria-pressed={cwd === p.path} disabled={locked} onClick={() => onChange(p.path)} title={p.path}>
        <span className="nt-pname"><span>{p.git ? '⎇' : '📁'} {p.name}</span>
          {p.sources.map((s) => <span key={s} className={`nt-src src-${s}`}>{t[PROJECT_SOURCE_KEY[s]]}</span>)}
        </span>
        <span className="nt-ppath mono">{shortPath(p.path)}</span>
      </button>
    </li>
  );

  return (
    <div className="office-workspace">
      <span className="nt-label">{t.officeFolder}</span>
      <div className="workspace-toolbar">
        <div className="workspace-sources" role="group" aria-label={t.officeFolder}>
          <button type="button" className={`chip ${source === 'local' ? 'on' : ''}`} aria-pressed={source === 'local'} disabled={locked || loading} onClick={() => pickSource('local')}>{t.officeLocalRepos}</button>
          <button type="button" className={`chip ${source === 'github' ? 'on' : ''}`} aria-pressed={source === 'github'} disabled={locked || loading} onClick={() => pickSource('github')}>{t.officeGitRepos}</button>
        </div>
        <button type="button" className="link" disabled={locked || loading} onClick={() => void refresh()}>{loading ? t.loading : t.refresh}</button>
      </div>
      <input id="office-repo-search" value={query} onChange={(e) => { setQuery(e.target.value); if (source === 'github') setRepo(''); }} disabled={locked} placeholder={source === 'local' ? t.projectSearch : t.officeRepoSearch} aria-label={source === 'local' ? t.projectSearch : t.officeRepoSearch} spellCheck={false} />
      {source === 'local' ? (
        <>
          <ul className="nt-projects workspace-projects" aria-label={t.officeLocalRepos}>
            <li><button type="button" className={`workspace-project ${!cwd ? 'on' : ''}`} aria-pressed={!cwd} disabled={locked} onClick={() => onChange('')}><span className="nt-pname">＋ {t.officeAutoFolder}</span></button></li>
            {typedPath && <li><button type="button" className={`workspace-project ${cwd === typedPath ? 'on' : ''}`} aria-pressed={cwd === typedPath} disabled={locked} onClick={() => onChange(typedPath)}><span className="nt-pname">📁 {t.usePath}</span><span className="nt-ppath mono">{typedPath}</span></button></li>}
            {projects.map(projectRow)}
            {!opts && <li className="nt-empty muted small">{t.loading}</li>}
            {opts && !projects.length && !typedPath && <li className="nt-empty muted small">{t.noProjects}</li>}
          </ul>
        </>
      ) : (
        <>
          <p className="muted tiny">{t.officeGitHelp}</p>
          {remote?.state === 'unavailable' && <p className="action-msg small" role="status">{t.officeGitUnavailable}</p>}
          <ul className="nt-projects workspace-projects" aria-label={t.officeGitRepos} aria-busy={loading}>
            {repositories.map((r) => (
              <li key={r.fullName}>
                <button type="button" className={`workspace-project ${repo === r.fullName ? 'on' : ''}`} aria-pressed={repo === r.fullName} disabled={locked || loading} onClick={() => setRepo(r.fullName)}>
                  <span className="nt-pname"><span>⎇ {r.fullName}</span><span className="nt-src">{r.private ? t.officeRepoPrivate : t.officeRepoPublic}</span></span>
                  {r.description && <span className="nt-ppath" title={r.description}>{r.description}</span>}
                  {r.pushedAt && <span className="nt-ppath">{relTime(r.pushedAt, t, lang)}</span>}
                </button>
              </li>
            ))}
            {loading && <li className="nt-empty muted small">{t.loading}</li>}
            {!loading && remote?.state === 'ready' && !repositories.length && <li className="nt-empty muted small">{t.officeNoGitRepos}</li>}
          </ul>
          <label className="nt-label" htmlFor="office-clone-dir">{t.cloneDir}</label>
          <div className="workspace-clone-dir">
            <input id="office-clone-dir" value={cloneDir} disabled={locked} placeholder="~/Projects" spellCheck={false} onChange={(e) => { setCloneDir(e.target.value); setNotice(''); }} />
            <button type="button" className="btn" disabled={locked || !cloneDir.trim() || cloneDir.trim() === savedDir} onClick={() => void save()}>{working === 'save' ? t.loading : t.save}</button>
          </div>
          <p className="muted tiny">{t.cloneDirHelp}</p>
          {target && <div className="workspace-target"><span className="nt-label">{t.officeCloneTarget}</span><span className="mono small">{target}</span></div>}
          <div className="workspace-clone-action">
            <span className="muted tiny">{t.officeCloneHelp}</span>
            <button type="button" className="btn primary" disabled={locked || loading || !repo || !cloneDir.trim()} onClick={() => void clone()}>{working === 'clone' ? t.officeCloning : t.officeClone}</button>
          </div>
        </>
      )}
      <label className="nt-label" htmlFor="office-path">{t.officeCustomFolder}</label>
      <input id="office-path" value={cwd ?? ''} disabled={locked} placeholder={t.officeFolderPh} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <p className="muted tiny">{cwd ? t.officeExistingHelp : t.officeAutoHelp}</p>
      {error && <p className="action-msg small" role="alert">{error}</p>}
      {notice && <p className="muted small" role="status">{notice}</p>}
    </div>
  );
}
