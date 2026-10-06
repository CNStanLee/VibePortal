import { useEffect, useRef, useState } from 'react';
import type { PublicSettings, ServerInfo } from '../../shared/types';
import { api } from '../api';
import { fmt, useT } from '../i18n';
import { probe, renderGoogleButton, syncDevices, forgetDevice, type Device } from '../google';

/** Google's own "Sign in with Google" button. */
export function GoogleButton({ clientId, onCredential, autoSelect = true }: { clientId: string; onCredential: (c: string) => void; autoSelect?: boolean }) {
  const { lang } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const cb = useRef(onCredential);
  cb.current = onCredential;
  useEffect(() => {
    if (!ref.current) return;
    renderGoogleButton(ref.current, clientId, (c) => cb.current(c), { autoSelect, lang }).catch((e) => setError((e as Error).message));
  }, [clientId, autoSelect, lang]);
  return (
    <div className="google-btn">
      <div ref={ref} />
      {error && <p className="action-msg small">{error}</p>}
    </div>
  );
}

/** Origins Google accepts for this page: https, or http://localhost. */
const usableOrigin = (o: string) => o.startsWith('https://') || /^http:\/\/localhost(:\d+)?$/.test(o);

/** Settings card: set up Google sign-in, bind the account, see the devices. */
export function GoogleSettings({ settings, onSettings }: { settings: PublicSettings; onSettings: (s: PublicSettings) => void }) {
  const { t } = useT();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [clientId, setClientId] = useState(settings.googleClientId);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.info().then(setInfo, () => {});
  }, []);
  useEffect(() => setClientId(settings.googleClientId), [settings.googleClientId]);
  const local = info?.viewerLocal ?? true;
  const port = info?.port ?? 8787;
  const origins = [...new Set([`http://localhost:${port}`, info?.publicUrl, usableOrigin(location.origin) ? location.origin : undefined].filter(Boolean) as string[])];
  const run = async (fn: () => Promise<PublicSettings>) => {
    setBusy(true);
    setMsg('');
    try {
      onSettings(await fn());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const bound = settings.googleOwners;

  return (
    <section className="card google-card">
      <h2>{t.googleSection}</h2>
      <p className="muted small">{t.googleHelp}</p>
      <ol className="setup-steps">
        <li className={settings.googleClientId ? 'ok' : ''}>
          <span className="setup-mark">{settings.googleClientId ? '✓' : 1}</span>
          <div className="setup-body">
            <div className="setup-title">{t.gStep1}</div>
            <div className="small">
              {t.gStep1Body}
              <ul className="origin-list">
                {origins.map((o) => (
                  <li key={o}>
                    <code className="setup-cmd">{o}</code>
                  </li>
                ))}
              </ul>
              <span className="muted">{t.gStep1Consent}</span>{' '}
              <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                Credentials ↗
              </a>{' '}
              ·{' '}
              <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">
                Drive API ↗
              </a>
            </div>
          </div>
        </li>
        <li className={settings.googleClientId ? 'ok' : ''}>
          <span className="setup-mark">{settings.googleClientId ? '✓' : 2}</span>
          <div className="setup-body">
            <div className="setup-title">{t.gStep2}</div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.saveSettings({ googleClientId: clientId.trim() }));
              }}
            >
              <input className="mono small google-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} disabled={!local} />
              {clientId.trim() !== settings.googleClientId && (
                <button className="btn primary" disabled={busy || !local}>
                  {t.save}
                </button>
              )}
            </form>
            <span className="muted tiny">{t.gStep2Hint}</span>
          </div>
        </li>
        <li className={bound.length ? 'ok' : ''}>
          <span className="setup-mark">{bound.length ? '✓' : 3}</span>
          <div className="setup-body">
            <div className="setup-title">{t.gStep3}</div>
            {bound.map((e) => (
              <div key={e} className="row small bound-row">
                <span>{fmt(t.gBound, { e })}</span>
                {local && (
                  <button type="button" className="link" disabled={busy} onClick={() => void run(() => api.saveSettings({ googleOwners: bound.filter((x) => x !== e) }))}>
                    {t.gUnbind}
                  </button>
                )}
              </div>
            ))}
            {settings.googleClientId && local && !bound.length && (
              usableOrigin(location.origin) ? (
                <GoogleButton clientId={settings.googleClientId} autoSelect={false} onCredential={(c) => void run(() => api.googleBind(c))} />
              ) : (
                <span className="warn-text small">{fmt(t.gOriginWarn, { p: port })}</span>
              )
            )}
          </div>
        </li>
      </ol>
      {msg && <p className="action-msg small">{msg}</p>}
      {settings.googleClientId && bound.length > 0 && <DevicesList clientId={settings.googleClientId} info={info} hint={bound[0]} />}
    </section>
  );
}

/** The account's VibePortals (from Drive), with online status and a link to each. */
export function DevicesList({ clientId, info, hint }: { clientId: string; info: ServerInfo | null; hint?: string }) {
  const { t } = useT();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const me = (): Device | null => {
    if (!info) return null;
    const url = info.publicUrl || (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : info.lanUrls[0]) || location.origin;
    return { id: info.instanceId, name: info.machineName, url, updatedAt: new Date().toISOString() };
  };
  const refresh = async (forget?: string) => {
    const self = me();
    if (!self) return;
    setBusy(true);
    setMsg('');
    try {
      const list = forget ? await forgetDevice(clientId, forget, self) : await syncDevices(clientId, self, hint);
      setDevices(list);
      const st: Record<string, boolean> = { [self.id]: true };
      await Promise.all(list.filter((d) => d.id !== self.id).map(async (d) => (st[d.id] = await probe(d.url))));
      setOnline(st);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="devices">
      <h3>{t.devices}</h3>
      <p className="muted small">{t.devicesHelp}</p>
      {info && !info.publicUrl && <p className="muted tiny">{t.noPublicUrl}</p>}
      {devices && (
        <ul className="device-list">
          {devices.map((d) => {
            const self = d.id === info?.instanceId;
            return (
              <li key={d.id}>
                <span className={`conn-dot ${online[d.id] ? 'on' : ''}`} aria-hidden />
                <div className="device-main">
                  <b>{d.name}</b> {self && <span className="nt-src src-open">{t.thisDevice}</span>}
                  <span className="mono tiny muted">{d.url}</span>
                </div>
                {!self && (
                  <>
                    <a className="btn ghost" href={d.url} target="_blank" rel="noreferrer">
                      {t.openLink} ↗
                    </a>
                    <button className="link tiny" disabled={busy} onClick={() => void refresh(d.id)}>
                      {t.forget}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button className="btn ghost" disabled={busy || !info} onClick={() => void refresh()}>
        {busy ? '…' : devices ? t.devicesRefresh : t.devicesSync}
      </button>
      {msg && <p className="action-msg small">{msg}</p>}
    </div>
  );
}

/** Tasks page: the device list for whoever signed in with Google. */
export function DevicesCard() {
  const { t } = useT();
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  useEffect(() => {
    api.settings().then(setSettings, () => {});
    api.info().then(setInfo, () => {});
  }, []);
  if (!settings?.googleClientId || !settings.googleOwners.length) return null;
  return (
    <section className="card" aria-label={t.devices}>
      <DevicesList clientId={settings.googleClientId} info={info} hint={settings.googleOwners[0]} />
    </section>
  );
}
