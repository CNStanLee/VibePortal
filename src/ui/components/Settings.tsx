import { useEffect, useState } from 'react';
import type { ClaudePet, CodexPet, PublicSettings, ServerInfo, SettingsPatch } from '../../shared/types';
import { api, desktop, getToken } from '../api';
import { useT } from '../i18n';
import { RemoteSettings } from './Remote';
import { disablePush, enablePush, pushEnabled, pushSupport, testPush } from '../push';
import { GoogleSettings } from './GoogleAccount';

export function SettingsPage({ info }: { info: ServerInfo | null }) {
  const { t, lang } = useT();
  const [s, setS] = useState<PublicSettings | null>(null);
  const [patch, setPatch] = useState<SettingsPatch>({});
  const [status, setStatus] = useState<string>('');
  const [snippet, setSnippet] = useState<string>('');
  const isDesktop = !!desktop() || info?.mode === 'desktop';

  useEffect(() => {
    api.settings().then(setS).catch((e) => setStatus(String(e.message)));
    api
      .hookSnippet()
      .then((j) => setSnippet(JSON.stringify(j, null, 2)))
      .catch(() => {});
  }, []);

  if (!s) return <p className="muted">{status || t.loading}</p>;

  const v = { ...s, ...patch, pet: { ...s.pet, ...(patch.pet ?? {}) } } as PublicSettings & SettingsPatch;
  const set = (p: SettingsPatch) => {
    setPatch((old) => ({ ...old, ...p, pet: p.pet ? { ...old.pet, ...p.pet } : old.pet }));
    setStatus('');
  };
  const save = async () => {
    try {
      const next = await api.saveSettings(patch);
      setS(next);
      setPatch({});
      setStatus(t.saved);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };
  const num = (k: keyof SettingsPatch) => (e: React.ChangeEvent<HTMLInputElement>) => set({ [k]: Number(e.target.value) } as SettingsPatch);
  const dirty = Object.keys(patch).length > 0;
  const taskExample = `curl -X POST ${info?.taskUrl ?? 'http://127.0.0.1:8787/api/tasks'} \\
  -H 'Authorization: Bearer ${getToken() ?? '<token>'}' -H 'Content-Type: application/json' \\
  -d '{"id":"train-42","title":"Train model","state":"running","progress":35}'`;

  return (
    <div className="settings">
      <section className="card">
        <h2>{t.general}</h2>
        <div className="form-grid">
          <Field label={t.historyDays}>
            <input type="number" min={1} max={365} value={v.historyDays} onChange={num('historyDays')} />
          </Field>
          <Field label={t.pollSeconds}>
            <input type="number" min={5} max={600} value={v.pollSeconds} onChange={num('pollSeconds')} />
          </Field>
          <Field label={t.subPollSeconds}>
            <input type="number" min={60} max={3600} value={v.subscriptionPollSeconds} onChange={num('subscriptionPollSeconds')} />
          </Field>
          <Field label={t.claudeDir}>
            <input value={v.claudeDir} onChange={(e) => set({ claudeDir: e.target.value })} spellCheck={false} />
          </Field>
          <Field label={t.codexDir}>
            <input value={v.codexDir} onChange={(e) => set({ codexDir: e.target.value })} spellCheck={false} />
          </Field>
          <Field label={t.cloneDir}>
            <input value={v.cloneDir ?? ''} onChange={(e) => set({ cloneDir: e.target.value })} spellCheck={false} />
            <span className="muted tiny">{t.cloneDirHelp}</span>
          </Field>
          <Field label={t.machineName}>
            <input value={v.machineName} onChange={(e) => set({ machineName: e.target.value })} spellCheck={false} />
          </Field>
        </div>
        <h3>{t.thresholds}</h3>
        <div className="form-grid">
          <Field label={t.warnAt}>
            <input type="number" min={1} max={100} value={v.warnPercent} onChange={num('warnPercent')} />
          </Field>
          <Field label={t.criticalAt}>
            <input type="number" min={1} max={100} value={v.criticalPercent} onChange={num('criticalPercent')} />
          </Field>
        </div>
        <div className="checks">
          <Check label={t.notifications} checked={v.notifications} onChange={(c) => set({ notifications: c })} />
          {isDesktop && <Check label={t.launchAtLogin} checked={v.launchAtLogin} onChange={(c) => set({ launchAtLogin: c })} />}
        </div>
        {!desktop() && <PushSettings notificationsOn={s.notifications} />}
      </section>

      <section className="card">
        <h2>{t.pet}</h2>
        <div className="form-grid">
          <Check label={isDesktop ? t.petEnabled : t.floatingPet} checked={v.pet.enabled} onChange={(c) => set({ pet: { enabled: c } })} />
          <Field label={`${t.petSize} (${v.pet.size}px)`}>
            <input type="range" min={80} max={240} step={10} value={v.pet.size} onChange={(e) => set({ pet: { size: Number(e.target.value) } })} />
          </Field>
          <Field label={t.petCharacter}>
            <select value={v.pet.character} onChange={(e) => set({ pet: { character: e.target.value as 'duo' | 'claude' | 'codex' } })}>
              <option value="duo">{t.duo}</option>
              <option value="claude">{t.crab}</option>
              <option value="codex">{t.codexOnly}</option>
            </select>
          </Field>
          <Field label={t.claudePet}>
            <select value={v.pet.claudePet} onChange={(e) => set({ pet: { claudePet: e.target.value as ClaudePet } })}>
              <option value="crab">{t.crabPet}</option>
              <option value="frog">{t.frog}</option>
            </select>
          </Field>
          <Field label={t.codexPet}>
            <select value={v.pet.codexPet} onChange={(e) => set({ pet: { codexPet: e.target.value as CodexPet } })}>
              <option value="bot">{t.bot}</option>
              <option value="whale">{t.whale}</option>
              <option value="frog">{t.frog}</option>
            </select>
          </Field>
          <Field label={lang === 'zh' ? '“建议下一步”使用的模型' : 'Model for "suggest next step"'}>
            <input value={v.suggestModel} onChange={(e) => set({ suggestModel: e.target.value })} spellCheck={false} />
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>{t.adminKeys}</h2>
        <p className="muted small">{t.adminHelp}</p>
        <div className="form-grid">
          <KeyField label={t.anthropicKey} isSet={s.anthropicAdminKeySet} value={patch.anthropicAdminKey} onChange={(x) => set({ anthropicAdminKey: x })} />
          <KeyField label={t.openaiKey} isSet={s.openaiAdminKeySet} value={patch.openaiAdminKey} onChange={(x) => set({ openaiAdminKey: x })} />
        </div>
      </section>

      <div className="save-bar">
        <button className="btn primary" disabled={!dirty} onClick={save}>
          {t.save}
        </button>
        <span className="muted small" role="status">
          {status}
        </span>
      </div>

      <section className="card">
        <h2>{t.hooks}</h2>
        <p className="muted small">{t.hooksHelp}</p>
        <CodeBlock text={snippet} />
        <h3>{lang === 'zh' ? '自定义任务' : 'Custom tasks'}</h3>
        <p className="muted small">{t.customTasksHelp}</p>
        <CodeBlock text={taskExample} />
      </section>

      <RemoteSettings settings={s} onSettings={setS} />
      <GoogleSettings settings={s} onSettings={setS} />

      {info && (
        <p className="muted small">
          VibePortal {info.version} · {info.mode} · {info.machineName}
        </p>
      )}
    </div>
  );
}

/** Web Push for this browser: task notifications with the page closed. */
function PushSettings({ notificationsOn }: { notificationsOn: boolean }) {
  const { t } = useT();
  const support = pushSupport();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    pushEnabled()
      .then(setOn)
      .catch(() => setOn(false));
  }, []);
  const run = (f: () => Promise<unknown>, after?: string) => async () => {
    setBusy(true);
    setMsg('');
    try {
      await f();
      setOn(await pushEnabled());
      if (after) setMsg(after);
    } catch (e) {
      setMsg((e as Error).message === 'denied' || Notification.permission === 'denied' ? t.pushDenied : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const blocked = support === 'ok' && Notification.permission === 'denied';
  return (
    <div className="push-settings">
      <h3>{t.pushTitle}</h3>
      <p className="muted small">{t.pushHelp}</p>
      {support === 'ok' ? (
        <div className="checks">
          {on ? (
            <>
              <span className="push-on">✓ {t.pushOn}</span>
              <button className="btn" disabled={busy} onClick={run(() => testPush(t.pushTestBody), t.pushSent)}>
                {t.pushTest}
              </button>
              <button className="btn ghost" disabled={busy} onClick={run(disablePush)}>
                {t.pushDisable}
              </button>
            </>
          ) : (
            <button className="btn primary" disabled={busy || on === null || blocked} onClick={run(enablePush)}>
              🔔 {t.pushEnable}
            </button>
          )}
        </div>
      ) : (
        <p className="muted small">{support === 'insecure' ? t.pushInsecure : support === 'ios-install' ? t.pushIos : t.pushUnsupported}</p>
      )}
      {blocked && <p className="muted small">{t.pushDenied}</p>}
      {on && !notificationsOn && <p className="muted small">{t.pushOffGlobal}</p>}
      {msg && (
        <p className="muted small" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function KeyField({ label, isSet, value, onChange }: { label: string; isSet: boolean; value?: string; onChange: (v: string) => void }) {
  const { t } = useT();
  return (
    <label className="field">
      <span>
        {label} {isSet && value === undefined && <em className="ok-tag">✓ {t.keySet}</em>}
      </span>
      <div className="row">
        <input type="password" autoComplete="off" placeholder={isSet ? '••••••••' : ''} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        {isSet && (
          <button type="button" className="btn ghost" onClick={() => onChange('')}>
            {t.clear}
          </button>
        )}
      </div>
    </label>
  );
}

function CodeBlock({ text }: { text: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="code">
      <pre>{text}</pre>
      <button
        className="btn ghost copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? t.copied : t.copy}
      </button>
    </div>
  );
}
