import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { LaunchProject, OfficialRemoteState } from '../../shared/types';
import { api, cachedLaunchOptions } from '../api';
import { fmt, useT } from '../i18n';
import { fmtDuration, shortPath } from '../format';
import { ClaudeMark, CodexMark } from './Brand';

/**
 * The agents' official Remote Control: Claude Code environments per folder
 * (a claude.ai/code link + QR) and the Codex daemon with a pairing code.
 */
export function OfficialRemoteCard({ state }: { state?: OfficialRemoteState }) {
  const { t, lang } = useT();
  const [projects, setProjects] = useState<LaunchProject[]>([]);
  const [cwd, setCwd] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    cachedLaunchOptions()
      .then((o) => {
        setProjects(o.projects);
        setCwd((c) => c || o.projects[0]?.path || '');
      })
      .catch(() => {});
  }, []);
  // countdown for the pairing code
  useEffect(() => {
    if (!pair) return;
    const id = window.setInterval(() => {
      if (Date.parse(pair.expiresAt) < Date.now()) setPair(null);
      tick((x) => x + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [pair]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const claude = state?.claude ?? [];
  const codex = state?.codex ?? { state: 'off' as const };
  const running = new Set(claude.map((c) => c.cwd));

  return (
    <section className="card official" aria-labelledby="h-official">
      <h2 id="h-official">{t.official}</h2>
      <p className="muted small">{t.officialHelp}</p>

      <div className="official-grid">
        <div className="official-col">
          <h3>
            <ClaudeMark size={14} /> {t.rcClaude}
          </h3>
          <p className="muted small">{t.rcClaudeHelp}</p>
          <div className="row">
            <select value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label={t.project}>
              {projects.map((p) => (
                <option key={p.path} value={p.path} disabled={running.has(p.path)}>
                  {p.name} — {shortPath(p.path)}
                </option>
              ))}
            </select>
            <button className="btn primary" disabled={!cwd || running.has(cwd) || busy === 'claude'} onClick={() => void run('claude', () => api.startClaudeRemote(cwd))}>
              {t.rcStart}
            </button>
          </div>
          <ul className="official-list">
            {claude.map((c) => (
              <li key={c.cwd}>
                <ClaudeEnvRow env={c} onStop={() => void run('stop' + c.cwd, () => api.stopClaudeRemote(c.cwd))} />
              </li>
            ))}
          </ul>
        </div>

        <div className="official-col">
          <h3>
            <CodexMark size={14} /> {t.rcCodex}
            <span className={`rc-state st-${codex.state}`}>{codex.state === 'on' ? t.rcOn : codex.state === 'starting' ? t.rcConnecting : codex.state === 'error' ? '!' : t.rcOff}</span>
          </h3>
          <p className="muted small">{t.rcCodexHelp}</p>
          <div className="row">
            {codex.state === 'on' ? (
              <>
                <button className="btn primary" disabled={!!busy} onClick={() => void run('pair', async () => setPair(await api.codexPair()))}>
                  {t.rcPair}
                </button>
                <button className="btn ghost" disabled={!!busy} onClick={() => void run('codex', () => api.codexRemote('stop').then(() => setPair(null)))}>
                  {t.rcStop}
                </button>
              </>
            ) : (
              <button className="btn primary" disabled={!!busy || codex.state === 'starting'} onClick={() => void run('codex', () => api.codexRemote('start'))}>
                {busy === 'codex' || codex.state === 'starting' ? t.rcConnecting : t.rcStart}
              </button>
            )}
          </div>
          {codex.state === 'on' && codex.serverName && <p className="muted tiny">{codex.serverName}</p>}
          {codex.state === 'error' && <p className="action-msg small">{codex.error}</p>}
          {pair && (
            <div className="pair-code" aria-live="polite">
              <span className="pair-digits mono">{pair.code}</span>
              <span className="muted small">{fmt(t.rcPairHint, { t: fmtDuration(Date.parse(pair.expiresAt) - Date.now(), lang) })}</span>
            </div>
          )}
        </div>
      </div>
      {msg && <p className="action-msg small">{msg}</p>}
    </section>
  );
}

function ClaudeEnvRow({ env, onStop }: { env: OfficialRemoteState['claude'][number]; onStop: () => void }) {
  const { t } = useT();
  const [qr, setQr] = useState('');
  useEffect(() => {
    if (!env.url) return setQr('');
    QRCode.toDataURL(env.url, { margin: 1, width: 150 }).then(setQr, () => setQr(''));
  }, [env.url]);
  return (
    <div className={`official-env st-${env.state}`}>
      <div className="official-env-main">
        <b>{env.name}</b>
        <span className="muted tiny mono">{shortPath(env.cwd)}</span>
        {env.state === 'connecting' && <span className="muted small">{t.rcConnecting}</span>}
        {env.state === 'ready' && env.url && (
          <>
            <span className="small good-text">{t.rcReady}</span>
            <a className="mono small" href={env.url} target="_blank" rel="noreferrer">
              claude.ai/code ↗
            </a>
          </>
        )}
        {env.state === 'error' && <span className="action-msg small">{env.error}</span>}
        <button className="btn ghost" onClick={onStop}>
          {t.rcStop}
        </button>
      </div>
      {qr && env.state === 'ready' && <img className="official-qr" src={qr} alt="QR" width={120} height={120} />}
    </div>
  );
}
