import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { PublicSettings, RemoteHostSnapshot, ServerInfo } from '../../shared/types';
import { api, getToken } from '../api';
import { useT } from '../i18n';
import { fmtDuration, relTime } from '../format';
import { PublicAccess } from './PublicAccess';

/** Settings card: expose this machine on the LAN, and connect to other machines. */
export function RemoteSettings({ settings, onSettings }: { settings: PublicSettings; onSettings: (s: PublicSettings) => void }) {
  const { t } = useT();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [qr, setQr] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadInfo = () => api.info().then(setInfo).catch(() => {});
  // poll quickly while a tunnel is connecting / retrying, so the link and QR code follow it
  const settling = settings.publicTunnel && info?.tunnel.state !== 'on';
  useEffect(() => {
    void loadInfo();
    const id = window.setInterval(loadInfo, settling ? 3000 : 10_000);
    return () => window.clearInterval(id);
  }, [settling]);

  const lan = info?.lanUrls ?? [];
  const pw = info?.passwordSet ?? settings.passwordSet;
  const publicUrl = info?.publicUrl;
  const [qrTarget, setQrTarget] = useState<'public' | 'lan'>('public');
  const target = qrTarget === 'public' && publicUrl ? publicUrl : lan[0];
  // with a password the QR code is a plain address: whoever scans it signs in
  const withToken = (base: string) => (pw ? `${base}/` : `${base}/?token=${encodeURIComponent(getToken() ?? '')}`);
  const link = target ? withToken(target) : '';
  const machineLink = lan[0] ? `${lan[0]}/?token=${encodeURIComponent(getToken() ?? '')}` : '';
  useEffect(() => {
    if (!link) return setQr('');
    QRCode.toDataURL(link, { margin: 1, width: 180 }).then(setQr, () => setQr(''));
  }, [link]);

  const save = async (patch: Parameters<typeof api.saveSettings>[0]) => {
    setBusy(true);
    setMsg('');
    try {
      onSettings(await api.saveSettings(patch));
      return true;
    } catch (e) {
      setMsg((e as Error).message);
      return false;
    } finally {
      window.setTimeout(() => {
        void loadInfo();
        setBusy(false);
      }, 800);
    }
  };
  const toggle = (on: boolean) => void save({ remoteAccess: on });
  const add = async (u = url, tk = token) => {
    setBusy(true);
    setMsg('');
    try {
      onSettings(await api.addHost(u.trim(), tk.trim()));
      setUrl('');
      setToken('');
      void loadInfo();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const local = info?.viewerLocal ?? true;
  const tunnel = info?.tunnel;

  return (
    <section className="card">
      <h2>{t.remote}</h2>
      <label className="check">
        <input type="checkbox" checked={settings.remoteAccess} disabled={busy || !local} onChange={(e) => toggle(e.target.checked)} />
        <span>{t.remoteAccess}</span>
      </label>
      <p className="muted small">{t.remoteHelp}</p>

      <h3>{t.pwSection}</h3>
      <p className={`small ${pw ? 'muted' : 'warn-text'}`}>{pw ? t.pwOn : t.pwOff}</p>
      {local ? (
        <PasswordForm passwordSet={pw} busy={busy} onSave={(p) => save({ remotePassword: p })} />
      ) : (
        <p className="muted small">{t.pwLocalOnly}</p>
      )}

      <h3>{t.publicSection}</h3>
      <PublicAccess settings={settings} info={info} passwordSet={pw} local={local} busy={busy} save={save} />
      {local && (
        <details className="own-url">
          <summary className="small">{t.ownUrl}</summary>
          <PublicUrlField value={settings.publicUrl} disabled={busy || !pw} onSave={(u) => save({ publicUrl: u })} />
        </details>
      )}

      {!settings.remoteAccess && !publicUrl && (
        <div className="field">
          <span>{t.access}</span>
          <CopyField text={`${location.origin}${location.pathname}?token=${encodeURIComponent(getToken() ?? '')}`} />
        </div>
      )}
      {(publicUrl || (settings.remoteAccess && lan.length > 0)) && (
        <div className="remote-share">
          {qr && (
            <figure className="qr">
              {publicUrl && lan.length > 0 && (
                <div className="seg" role="radiogroup">
                  {(['public', 'lan'] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={qrTarget === k} className={qrTarget === k ? 'on' : ''} onClick={() => setQrTarget(k)}>
                      {k === 'public' ? t.qrPublic : t.qrLan}
                    </button>
                  ))}
                </div>
              )}
              <img src={qr} alt="QR" width={160} height={160} />
              <figcaption className="muted small">{pw ? t.scanPw : t.scanQr}</figcaption>
            </figure>
          )}
          <div className="remote-links">
            {publicUrl && (
              <div className="field">
                <span>{t.qrPublic}</span>
                <CopyField text={withToken(publicUrl)} />
              </div>
            )}
            {settings.remoteAccess && lan.length > 0 && (
              <div className="field">
                <span>{t.lanLinks}</span>
                {lan.map((u) => (
                  <a key={u} className="mono small" href={withToken(u)} target="_blank" rel="noreferrer">
                    {u}
                  </a>
                ))}
              </div>
            )}
            {settings.remoteAccess && machineLink && local && (
              <div className="field">
                <span>{pw ? t.connLinkToken : t.connLink}</span>
                <CopyField text={machineLink} />
              </div>
            )}
          </div>
        </div>
      )}

      <h3>{t.hosts}</h3>
      <p className="muted small">{t.hostsHelp}</p>
      {settings.hosts.length > 0 && (
        <ul className="host-list">
          {settings.hosts.map((h) => (
            <li key={h.id}>
              <b>{h.name}</b> <span className="mono small muted">{h.url}</span>
              <button className="link" onClick={() => api.removeHost(h.id).then(onSettings)}>
                {t.remove2}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="host-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t.hostUrlPh} spellCheck={false} />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={t.tokenPh} spellCheck={false} />
        <button className="btn primary" disabled={!url.trim() || busy}>
          {t.add}
        </button>
      </form>
      {info && info.discovered.length > 0 && (
        <>
          <h3>{t.discoveredOnLan}</h3>
          <ul className="host-list">
            {info.discovered.map((d) => (
              <li key={d.id}>
                <b>{d.name}</b> <span className="mono small muted">{d.url}</span>
                <button className="link" onClick={() => setUrl(d.url)}>
                  {t.add} →
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {msg && <p className="action-msg small">{msg}</p>}
    </section>
  );
}

function PasswordForm({ passwordSet, busy, onSave }: { passwordSet: boolean; busy: boolean; onSave: (p: string) => Promise<boolean> }) {
  const { t } = useT();
  const [editing, setEditing] = useState(!passwordSet);
  const [value, setValue] = useState('');
  useEffect(() => setEditing(!passwordSet), [passwordSet]);
  if (!editing) {
    return (
      <div className="row">
        <button type="button" className="btn ghost" onClick={() => setEditing(true)}>
          {t.pwChange}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void onSave('')}>
          {t.pwClear}
        </button>
      </div>
    );
  }
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(value).then((ok) => ok && setValue(''));
      }}
    >
      <input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t.pwNew} aria-label={t.pwNew} />
      <button className="btn primary" disabled={busy || value.length < 8}>
        {t.pwSave}
      </button>
      {passwordSet && (
        <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
          ×
        </button>
      )}
    </form>
  );
}

function PublicUrlField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (u: string) => Promise<boolean> }) {
  const { t } = useT();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <form
      className="field"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(v.trim());
      }}
    >
      <span>{t.ownUrl}</span>
      <div className="row">
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={t.ownUrlPh} spellCheck={false} disabled={disabled} className="mono small" />
        <button className="btn ghost" disabled={disabled || v.trim() === value}>
          {t.save}
        </button>
      </div>
    </form>
  );
}

function CopyField({ text }: { text: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="row">
      <input readOnly value={text} onFocus={(e) => e.target.select()} className="mono small" />
      <button
        type="button"
        className="btn ghost"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
        }
      >
        {done ? t.copied : t.copy}
      </button>
    </div>
  );
}

/** Overview card listing connected machines and their tightest limits. */
export function RemoteHostsCard({ remotes }: { remotes: RemoteHostSnapshot[] }) {
  const { t, lang } = useT();
  if (!remotes.length) return null;
  return (
    <section className="card">
      <h2>{t.hosts}</h2>
      <ul className="remote-hosts">
        {remotes.map((h) => (
          <li key={h.id}>
            <div className="remote-host-head">
              <span className={`conn-dot ${h.online ? 'on' : ''}`} aria-hidden /> <b>{h.name}</b>
              <span className="muted small">
                {h.online ? t.online : `${t.offlineHost}${h.error ? ` · ${h.error}` : ''}`} · {relTime(h.updatedAt, t, lang)}
              </span>
            </div>
            <div className="remote-quotas">
              {h.providers.map((p) =>
                [...p.quotas]
                  .sort((a, b) => (a.kind === 'session' ? -1 : b.kind === 'session' ? 1 : b.percent - a.percent))
                  .slice(0, 2)
                  .map((q) => (
                    <span key={p.provider + q.id} className={`rq sev-${q.severity}`}>
                      <span className={`dot p-${p.provider}`} /> {p.name} · {q.kind === 'session' ? t.window5h : q.label} <b>{Math.round(q.percent)}%</b>
                      {q.resetsAt && <span className="muted"> ↻{fmtDuration(Date.parse(q.resetsAt) - Date.now(), lang)}</span>}
                    </span>
                  )),
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
