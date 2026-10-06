import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ServerInfo } from '../shared/types';
import { api, auth, desktop, setToken, useLive, type Notice } from './api';
import { dicts, I18n, useT, type Lang } from './i18n';
import { ProviderCard } from './components/ProviderCard';
import { UsageChart } from './components/UsageChart';
import { TaskList } from './components/TaskList';
import { SettingsPage } from './components/Settings';
import { PetWidget } from './components/PetWidget';
import { Analysis } from './components/Analysis';
import { RemoteHostsCard } from './components/Remote';
import { Resources } from './components/Resources';
import { NewTask } from './components/NewTask';
import { SkillsPage } from './components/Skills';
import { FarmPage } from './components/Farm';
import { OfficePage } from './components/Office';
import { OfficialRemoteCard } from './components/OfficialRemote';
import { DevicesCard, GoogleButton } from './components/GoogleAccount';
import { localNotice, syncPush } from './push';

type Tab = 'overview' | 'analysis' | 'resources' | 'tasks' | 'office' | 'skills' | 'farm' | 'settings';
// tasks first: it's what you come back for
const TABS: Tab[] = ['tasks', 'office', 'overview', 'analysis', 'resources', 'skills', 'farm', 'settings'];
type Theme = 'system' | 'light' | 'dark';

export function I18nProvider({ initial, children }: { initial: Lang; children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('vp.lang', l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  };
  return <I18n.Provider value={{ t: dicts[lang], lang, setLang }}>{children}</I18n.Provider>;
}

export function Dashboard() {
  const { t, lang, setLang } = useT();
  const [tab, setTab] = useState<Tab>(() => (location.hash.replace('#/', '') as Tab) || 'tasks');
  const [toasts, setToasts] = useState<(Notice & { id: number })[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => readTheme());
  const [launching, setLaunching] = useState<{ skills?: string[] } | null>(null);

  const onNotice = useCallback((n: Notice) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-3), { ...n, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 8000);
    // desktop app shows native notifications from the main process
    if (!desktop()) void localNotice(n);
  }, []);
  const { snapshot, connected, authFailed } = useLive(onNotice);

  useEffect(() => {
    api.info().then(setInfo).catch(() => {});
    syncPush().catch(() => {});
  }, []);
  // follow back/forward and pasted #/… links
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#/', '') as Tab;
      setTab(TABS.includes(h) ? h : 'tasks');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    const target = tab === 'tasks' ? '' : `#/${tab}`;
    if (location.hash !== target) history.replaceState(null, '', location.pathname + location.search + target);
  }, [tab]);
  useEffect(() => applyTheme(theme), [theme]);
  const tabsRef = useRef<HTMLElement>(null);
  useTabPill(tabsRef, tab, lang);

  if (authFailed) return <TokenGate />;

  const setTheme = (th: Theme, from?: { x: number; y: number }) => {
    const commit = () => {
      flushSync(() => setThemeState(th));
      applyTheme(th);
    };
    try {
      localStorage.setItem('vp.theme', th);
    } catch {
      /* ignore */
    }
    // the new theme spreads out of the button in a circle, where the browser can
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    if (!from || !doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return commit();
    const r = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y));
    void doc
      .startViewTransition(commit)
      .ready.then(() =>
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] },
          { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' },
        ),
      )
      .catch(() => {});
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refresh();
    } finally {
      setRefreshing(false);
    }
  };
  const running = snapshot?.tasks.filter((x) => x.state === 'running' || x.state === 'waiting').length ?? 0;
  // the floating pet for every browser — phones included — except one on the computer that
  // already shows the desktop pet
  const showFloatingPet = !desktop() && !!info && (info.mode !== 'desktop' || !info.viewerLocal) && snapshot?.petConfig.enabled;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="./icon.svg" alt="" width={28} height={28} />
          <span>VibePortal</span>
          <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? t.live : t.offline}>
            <span className="conn-dot" aria-hidden /> {connected ? t.live : t.offline}
          </span>
        </div>
        <nav className="tabs" role="tablist" ref={tabsRef}>
          <span className="tab-pill" aria-hidden />
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              <TabIcon tab={k} />
              <span className="tab-label">{t[k]}</span>
              {k === 'tasks' && running > 0 && (
                <span className="count" key={running}>
                  {running}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="actions">
          <button className="btn primary" onClick={() => setLaunching({})} title={t.newTaskTitle}>
            +<span className="hide-sm"> {t.newTask}</span>
          </button>
          <button className="btn ghost" onClick={refresh} disabled={refreshing} title={t.refresh}>
            <span className={refreshing ? 'spin-inline' : ''} aria-hidden>
              ⟳
            </span>
            <span className="hide-sm"> {t.refresh}</span>
          </button>
          <button className="btn ghost" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')} title="Language">
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <button
            className="btn ghost"
            onClick={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system', { x: b.left + b.width / 2, y: b.top + b.height / 2 });
            }}
            title={`${t.theme}: ${theme}`}
            aria-label={`${t.theme}: ${theme}`}
          >
            {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
          </button>
        </div>
      </header>

      {/* keyed by tab: each page plays its entrance */}
      <main className="content" key={snapshot ? tab : 'loading'}>
        {!snapshot ? (
          <div className="loading">
            <div className="spinner" aria-hidden />
            {t.loading}
          </div>
        ) : tab === 'overview' ? (
          <div className="overview">
            <div className="providers">
              {snapshot.providers.map((p) => (
                <ProviderCard key={p.provider} p={p} />
              ))}
            </div>
            <UsageChart providers={snapshot.providers} days={Math.min(snapshot.historyDays, 60)} />
            <RemoteHostsCard remotes={snapshot.remotes ?? []} />
            <section className="card" aria-labelledby="h-active">
              <header className="card-head">
                <h2 id="h-active">{t.activeTasks}</h2>
                <button className="link" onClick={() => setTab('tasks')}>
                  {t.tasks} →
                </button>
              </header>
              <TaskList tasks={snapshot.tasks} compact machineName={snapshot.machineName} />
            </section>
          </div>
        ) : tab === 'analysis' ? (
          <Analysis snapshot={snapshot} />
        ) : tab === 'resources' ? (
          <Resources snapshot={snapshot} />
        ) : tab === 'skills' ? (
          <SkillsPage onUse={(ids) => setLaunching({ skills: ids })} />
        ) : tab === 'farm' ? (
          <FarmPage />
        ) : tab === 'office' ? (
          <OfficePage snapshot={snapshot} />
        ) : tab === 'tasks' ? (
          <div className="tasks-page">
            <section className="card">
              <TaskList tasks={snapshot.tasks} expandable machineName={snapshot.machineName} title={t.tasks} />
            </section>
            <OfficialRemoteCard state={snapshot.official} />
            <DevicesCard />
          </div>
        ) : (
          <SettingsPage info={info} />
        )}
      </main>

      {launching && (
        <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setLaunching(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={t.newTaskTitle}>
            <NewTask
              initialSkills={launching.skills}
              onClose={() => setLaunching(null)}
              onStarted={() => {
                setLaunching(null);
                onNotice({ title: t.newTask, body: t.launched, level: 'info' });
              }}
            />
          </div>
        </div>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((n) => (
          <div key={n.id} className={`toast lvl-${n.level}`}>
            <b>{n.title}</b>
            <span>{n.body}</span>
          </div>
        ))}
      </div>

      {showFloatingPet && snapshot && (
        <PetWidget
          snapshot={snapshot}
          variant="floating"
          onOpenDashboard={() => setTab('overview')}
        />
      )}
    </div>
  );
}

export function PetPage() {
  const { snapshot } = useLive();
  useEffect(() => {
    document.documentElement.classList.add('pet-page');
    applyTheme(readTheme());
  }, []);
  return (
    <PetWidget snapshot={snapshot} variant="window" />
  );
}

/** Sign-in screen: a password for remote viewers when one is set, else the access token. */
function TokenGate() {
  const { t } = useT();
  const [mode, setMode] = useState<'password' | 'token' | null>(null);
  const [google, setGoogle] = useState<string | undefined>();
  const [hasPassword, setHasPassword] = useState(true);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void auth.health().then((h) => {
      setMode(h.auth);
      setGoogle(h.google);
      setHasPassword(h.password);
    });
  }, []);
  if (!mode) return null;
  const withGoogle = async (credential: string) => {
    setBusy(true);
    setError('');
    try {
      setToken((await auth.loginGoogle(credential)).token);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const submit = async () => {
    if (mode === 'token') {
      setToken(value.trim());
      location.reload();
      return;
    }
    setBusy(true);
    setError('');
    try {
      setToken((await auth.login(value)).token);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="gate">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <img src="./icon.svg" alt="" width={48} height={48} />
        <h2>{mode === 'password' ? t.pwTitle : t.tokenTitle}</h2>
        <p className="muted small">{mode === 'password' ? (google && !hasPassword ? t.googleSignIn : t.pwHelp) : t.tokenHelp}</p>
        {mode === 'password' && google && (
          <>
            <GoogleButton clientId={google} onCredential={(c) => void withGoogle(c)} />
            {hasPassword && <div className="gate-or muted small">{t.orPassword}</div>}
          </>
        )}
        {(mode !== 'password' || hasPassword) && <input
          autoFocus
          type={mode === 'password' ? 'password' : 'text'}
          autoComplete={mode === 'password' ? 'current-password' : 'off'}
          aria-label={mode === 'password' ? t.password : t.tokenTitle}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />}
        {error && <p className="action-msg small">{error}</p>}
        {(mode !== 'password' || hasPassword) && (
          <button className="btn primary" disabled={!value.trim() || busy}>
            {mode === 'password' ? t.signIn : t.connect}
          </button>
        )}
      </form>
    </div>
  );
}

/** Line icons for the tabs (shown in the phone's bottom bar). */
function TabIcon({ tab }: { tab: Tab }) {
  const d: Record<Tab, string> = {
    overview: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    analysis: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    resources: 'M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
    tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
    office: 'M9 3h6v5H9zM12 8v4M5 12h14M5 12v3M19 12v3M12 12v3M3 15h4v5H3zM10 15h4v5h-4zM17 15h4v5h-4z',
    farm: 'M12 21v-9M12 12c0-4 3-7 7-7 0 4-3 7-7 7zM12 14c0-3-2.5-5.5-6-5.5 0 3 2.5 5.5 6 5.5zM5 21h14',
    skills: 'M12 3l2.6 5.6L20.5 9l-4.4 4 1.2 6L12 16l-5.3 3 1.2-6-4.4-4 5.9-.4z',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  };
  return (
    <svg className="tab-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d[tab]} />
    </svg>
  );
}

/** The selected-tab highlight slides (and stretches) from tab to tab instead of jumping. */
function useTabPill(ref: React.RefObject<HTMLElement | null>, tab: Tab, lang: Lang) {
  useLayoutEffect(() => {
    const nav = ref.current;
    const pill = nav?.querySelector<HTMLElement>('.tab-pill');
    if (!nav || !pill) return;
    const place = () => {
      const b = nav.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!b) return;
      pill.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
      pill.style.width = `${b.offsetWidth}px`;
      pill.style.height = `${b.offsetHeight}px`;
    };
    place();
    // only animate moves after the first placement
    const raf = requestAnimationFrame(() => pill.classList.add('ready'));
    const ro = new ResizeObserver(place);
    ro.observe(nav);
    nav.querySelectorAll('button').forEach((b) => ro.observe(b));
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ref, tab, lang]);
}

function readTheme(): Theme {
  try {
    const v = localStorage.getItem('vp.theme');
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

function applyTheme(th: Theme) {
  if (th === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = th;
}
