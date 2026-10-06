import { useEffect, useRef, useState } from 'react';
import type { PublicSettings, ServerInfo, SettingsPatch, TunnelProvider } from '../../shared/types';
import { api, type TunnelCheck } from '../api';
import { fmt, useT, type Dict } from '../i18n';

interface ProviderDef {
  id: TunnelProvider;
  name: string;
  /** fixed = the address never changes */
  fixed: boolean;
  note: keyof Dict;
  install?: { url: string; cmd?: string };
}

const PROVIDERS: ProviderDef[] = [
  { id: 'ngrok', name: 'ngrok', fixed: true, note: 'provNgrokNote', install: { url: 'https://ngrok.com/download', cmd: 'sudo snap install ngrok' } },
  { id: 'tailscale', name: 'Tailscale Funnel', fixed: true, note: 'provTailscaleNote', install: { url: 'https://tailscale.com/download', cmd: 'curl -fsSL https://tailscale.com/install.sh | sh' } },
  { id: 'localhost.run', name: 'localhost.run', fixed: false, note: 'provLhrNote' },
  { id: 'pinggy', name: 'Pinggy', fixed: false, note: 'provPinggyNote' },
  { id: 'cloudflare', name: 'Cloudflare', fixed: false, note: 'provCfNote', install: { url: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' } },
];

/**
 * "Access from the internet" as a short checklist: pick a relay, see what it
 * still needs (password, install, login), and it starts by itself as soon as
 * everything is in place.
 */
export function PublicAccess({
  settings,
  info,
  passwordSet,
  local,
  busy,
  save,
}: {
  settings: PublicSettings;
  info: ServerInfo | null;
  passwordSet: boolean;
  local: boolean;
  busy: boolean;
  save: (p: SettingsPatch) => Promise<boolean>;
}) {
  const { t } = useT();
  const provider = settings.tunnelProvider;
  const def = PROVIDERS.find((p) => p.id === provider)!;
  const [check, setCheck] = useState<TunnelCheck | null>(null);
  const refresh = () => api.tunnelCheck(provider).then(setCheck, () => setCheck(null));
  useEffect(() => {
    setCheck(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, settings.ngrokAuthtokenSet]);

  const needsToken = provider === 'ngrok' && check?.token === 'none';
  const needsLogin = provider === 'tailscale' && check?.installed && !check.loggedIn;
  const ready = passwordSet && !!check?.installed && !needsToken && !needsLogin;

  // choosing a relay (or finishing its setup) starts it — no separate switch to find
  const autoStart = useRef<TunnelProvider | null>(null);
  useEffect(() => {
    if (local && ready && autoStart.current === provider && !settings.publicTunnel) {
      autoStart.current = null;
      void save({ publicTunnel: true });
    }
  }, [local, ready, provider, settings.publicTunnel, save]);
  const pick = (id: TunnelProvider) => {
    autoStart.current = id;
    if (id !== provider) void save({ tunnelProvider: id });
  };

  const tunnel = info?.tunnel;
  const on = settings.publicTunnel;
  const steps: { ok: boolean; title: string; body?: React.ReactNode }[] = [
    { ok: passwordSet, title: t.stepPassword, body: !passwordSet && <span className="muted">{t.stepPasswordHint}</span> },
    {
      ok: !!check?.installed,
      title: provider === 'localhost.run' || provider === 'pinggy' ? t.stepSsh : fmt(t.stepInstall, { p: def.name }),
      body:
        check === null ? (
          <span className="muted">…</span>
        ) : check.installed ? (
          check.version && <span className="muted">v{check.version}</span>
        ) : (
          def.install && (
            <span>
              {def.install.cmd && <code className="setup-cmd">{def.install.cmd}</code>}{' '}
              <a href={def.install.url} target="_blank" rel="noreferrer">
                {t.install} ↗
              </a>{' '}
              <button type="button" className="link" onClick={() => void refresh()}>
                {t.recheck}
              </button>
            </span>
          )
        ),
    },
  ];
  if (provider === 'ngrok') {
    steps.push({
      ok: !!check && check.token !== 'none',
      title: t.stepNgrokLogin,
      body: <NgrokFields settings={settings} check={check} disabled={busy || !local} onSave={(p) => ((autoStart.current = 'ngrok'), save(p))} />,
    });
  }
  if (provider === 'tailscale') {
    steps.push({
      ok: !!check?.loggedIn,
      title: t.stepTsLogin,
      body: !check?.loggedIn && (
        <span>
          <code className="setup-cmd">sudo tailscale up</code>{' '}
          <button type="button" className="link" onClick={() => void refresh()}>
            {t.recheck}
          </button>
        </span>
      ),
    });
  }
  steps.push({
    ok: on && tunnel?.state === 'on',
    title: t.stepConnect,
    body: (
      <div className="setup-connect">
        <label className="switch">
          <input
            type="checkbox"
            checked={on}
            disabled={busy || !local || (!on && !ready)}
            onChange={(e) => void save({ publicTunnel: e.target.checked })}
          />
          <span>{on ? t.tunnelOnLabel : t.tunnelOffLabel}</span>
        </label>
        {on && tunnel && <TunnelStatus tunnel={tunnel} />}
      </div>
    ),
  });

  return (
    <div className="public-access">
      <p className="muted small">{t.tunnelHelp}</p>
      <div className="provider-picks" role="radiogroup" aria-label={t.tunnelVia}>
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === provider}
            className={`provider-pick ${p.id === provider ? 'on' : ''}`}
            disabled={busy || !local}
            onClick={() => pick(p.id)}
          >
            <b>{p.name}</b>
            <span className={`nt-src ${p.fixed ? 'src-open' : ''}`}>{p.fixed ? t.fixedAddr : t.tempAddr}</span>
          </button>
        ))}
      </div>
      <p className="muted tiny">{t[def.note]}</p>
      <ol className="setup-steps">
        {steps.map((s, i) => (
          <li key={i} className={s.ok ? 'ok' : ''}>
            <span className="setup-mark" aria-hidden>
              {s.ok ? '✓' : i + 1}
            </span>
            <div className="setup-body">
              <div className="setup-title">{s.title}</div>
              {s.body && <div className="small">{s.body}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TunnelStatus({ tunnel }: { tunnel: ServerInfo['tunnel'] }) {
  const { t } = useT();
  if (tunnel.state === 'on' && tunnel.url)
    return (
      <span className="small">
        <span className="good-text">● </span>
        <a className="mono" href={tunnel.url} target="_blank" rel="noreferrer">
          {tunnel.url}
        </a>
      </span>
    );
  if (tunnel.state === 'starting') return <span className="muted small">{t.tunnelStarting}</span>;
  const msg =
    tunnel.reason === 'busy'
      ? t.tunnelBusy
      : tunnel.reason === 'blocked' && tunnel.provider === 'cloudflare'
        ? t.tunnelBlocked
        : tunnel.reason === 'auth'
          ? t.tunnelAuth
          : tunnel.error;
  return (
    <span className={`small ${tunnel.reason === 'busy' ? 'warn-text' : 'action-msg'}`}>
      {msg}
      {tunnel.link && (
        <>
          {' '}
          <a href={tunnel.link} target="_blank" rel="noreferrer">
            {tunnel.state === 'missing' ? t.install : t.openLink} ↗
          </a>
        </>
      )}
    </span>
  );
}

function NgrokFields({
  settings,
  check,
  disabled,
  onSave,
}: {
  settings: PublicSettings;
  check: TunnelCheck | null;
  disabled: boolean;
  onSave: (p: SettingsPatch) => Promise<boolean>;
}) {
  const { t } = useT();
  const [domain, setDomain] = useState(settings.ngrokDomain);
  const [token, setToken] = useState('');
  useEffect(() => setDomain(settings.ngrokDomain), [settings.ngrokDomain]);
  const dirty = domain.trim() !== settings.ngrokDomain || !!token.trim();
  return (
    <form
      className="ngrok-fields"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ ngrokDomain: domain.trim(), ...(token.trim() ? { ngrokAuthtoken: token.trim() } : {}) }).then((ok) => ok && setToken(''));
      }}
    >
      {check?.token === 'ngrok-config' ? (
        <span className="muted">{t.ngrokTokenFromConfig}</span>
      ) : (
        <label className="field">
          <span>
            {t.ngrokToken}
            {check?.token === 'vibeportal' && <span className="muted tiny"> · {t.ngrokTokenSet}</span>}{' '}
            <a className="tiny" href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noreferrer">
              {t.getToken} ↗
            </a>
          </span>
          <input className="mono small" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={check?.token === 'vibeportal' ? '••••••••' : '2abc…'} />
        </label>
      )}
      <label className="field">
        <span>
          {t.ngrokDomain} <span className="muted tiny">· {t.ngrokDomainOptional}</span>{' '}
          <a className="tiny" href="https://dashboard.ngrok.com/domains" target="_blank" rel="noreferrer">
            dashboard ↗
          </a>
        </span>
        <input className="mono small" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="your-name.ngrok-free.app" spellCheck={false} />
      </label>
      {dirty && (
        <div className="row">
          <button className="btn primary" disabled={disabled}>
            {t.save}
          </button>
        </div>
      )}
    </form>
  );
}
