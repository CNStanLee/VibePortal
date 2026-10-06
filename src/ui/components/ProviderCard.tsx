import type { ProviderSnapshot, QuotaWindow } from '../../shared/types';
import { fmt, useT } from '../i18n';
import { fmtDuration, fmtTokens, fmtUsd, relTime } from '../format';
import { ClaudeMark, OpenAIMark } from './Brand';

const LINKS = {
  claude: [
    { key: 'login', url: 'https://claude.ai/login' },
    { key: 'usagePage', url: 'https://claude.ai/settings/usage' },
    { key: 'apiConsole', url: 'https://platform.claude.com/' },
  ],
  openai: [
    { key: 'login', url: 'https://chatgpt.com/auth/login' },
    { key: 'usagePage', url: 'https://chatgpt.com/codex/settings/usage' },
    { key: 'apiConsole', url: 'https://platform.openai.com/usage' },
  ],
} as const;

const SEV_ICON = { normal: '●', warning: '▲', critical: '◆' } as const;

export function QuotaMeter({ q }: { q: QuotaWindow }) {
  const { t, lang } = useT();
  const pct = Math.max(0, Math.min(100, q.percent));
  const reset = q.resetsAt ? Date.parse(q.resetsAt) - Date.now() : undefined;
  return (
    <div className={`meter sev-${q.severity}`}>
      <div className="meter-top">
        <span className="meter-label">{q.label}</span>
        <span className="meter-value">{Math.round(q.percent)}%</span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={q.label}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="meter-sub">
        <span className="sev-tag">
          <span aria-hidden>{SEV_ICON[q.severity]}</span> {t[q.severity]}
        </span>
        {q.usedDollars !== undefined && q.limitDollars !== undefined && (
          <span>
            {fmtUsd(q.usedDollars)} / {fmtUsd(q.limitDollars)}
          </span>
        )}
        {reset !== undefined && (
          <span title={new Date(q.resetsAt!).toLocaleString()}>
            ↻ {t.resetsIn} {fmtDuration(reset, lang)}
          </span>
        )}
      </div>
      {q.forecast && <ForecastLine q={q} />}
    </div>
  );
}

export function ForecastLine({ q }: { q: QuotaWindow }) {
  const { t, lang } = useT();
  const f = q.forecast!;
  const pace = `${fmt(t.rate, { r: f.ratePerHour })} · ${f.basis === 'recent' ? t.basisRecent : t.basisWindow}`;
  if (f.willExhaustBeforeReset && f.exhaustAt) {
    const when = new Date(f.exhaustAt);
    const inMs = when.getTime() - Date.now();
    return (
      <div className="forecast bad">
        ⚠ {fmt(t.eta, { t: `${when.toLocaleString(lang === 'zh' ? 'zh-CN' : undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (${fmtDuration(inMs, lang)})` })}
        <span className="muted"> · {pace}</span>
      </div>
    );
  }
  if (f.ratePerHour <= 0) return null;
  return (
    <div className="forecast">
      {fmt(t.projected, { p: Math.round(Math.min(f.projectedAtReset ?? 0, 999)) })}
      <span className="muted"> · {pace}</span>
    </div>
  );
}

/** Placeholder so the 5-hour window is always visible, even when a plan has none. */
export function Missing5h() {
  const { t } = useT();
  return (
    <div className="meter none">
      <div className="meter-top">
        <span className="meter-label">{t.window5h}</span>
        <span className="meter-value muted">—</span>
      </div>
      <div className="meter-sub">{t.no5h}</div>
    </div>
  );
}

export function ProviderCard({ p }: { p: ProviderSnapshot }) {
  const { t, lang } = useT();
  const brand = p.provider === 'claude' ? 'claude' : 'openai';
  const topModels = Object.entries(
    p.daily.reduce<Record<string, number>>((acc, d) => {
      for (const [m, tot] of Object.entries(d.byModel)) acc[m] = (acc[m] ?? 0) + tot.total;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const totalAll = topModels.reduce((s, [, v]) => s + v, 0) || 1;
  const problems = p.sources.filter((s) => s.state === 'error' || s.state === 'unavailable');
  const needsLogin = !p.plan && !p.quotas.length;

  return (
    <section className={`card provider brand-${brand}`} aria-labelledby={`h-${brand}`}>
      <header className="provider-head">
        <div className="provider-logo" aria-hidden>
          {brand === 'claude' ? <ClaudeMark size={24} /> : <OpenAIMark size={24} />}
        </div>
        <div className="provider-title">
          <h2 id={`h-${brand}`}>{p.name}</h2>
          <div className="plan">
            {p.plan ? (
              <>
                <span className="plan-badge">{p.plan.name}</span>
                {p.plan.status && p.plan.status !== 'active' && <span className="muted"> · {p.plan.status}</span>}
                <PlanDate plan={p.plan} />
              </>
            ) : (
              <span className="muted">{t.noPlan}</span>
            )}
          </div>
          {p.resetCredits && <ResetCreditsLine rc={p.resetCredits} />}
        </div>
        <nav className="provider-links" aria-label="links">
          {LINKS[p.provider].map((l) => (
            <a key={l.key} href={l.url} target="_blank" rel="noreferrer">
              {t[l.key]} ↗
            </a>
          ))}
        </nav>
      </header>
      {needsLogin && <p className="login-hint">{p.provider === 'claude' ? t.cliLoginClaude : t.cliLoginCodex}</p>}

      <div className="section-label">
        {t.limits}
        {p.quotasObservedAt && (
          <span className="muted small">
            {' '}
            · {t.observed} {relTime(p.quotasObservedAt, t, lang)}
          </span>
        )}
      </div>
      {p.quotas.length ? (
        <div className="meters">
          {!p.quotas.some((q) => q.kind === 'session') && <Missing5h />}
          {[...p.quotas]
            .sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
            .map((q) => (
              <QuotaMeter key={q.id} q={q} />
            ))}
        </div>
      ) : (
        <p className="muted small">{t.noLimits}</p>
      )}

      <div className="stats">
        <Stat label={t.today} value={fmtTokens(p.today.total)} sub={`${p.today.messages} ${t.messages}`} />
        <Stat label={t.last5h} value={fmtTokens(p.last5h.total)} sub={`${fmtTokens(p.last5h.output)} ${t.output}`} />
        {p.apiCost && <Stat label={`${t.apiSpend} (${p.apiCost.periodDays}${lang === 'zh' ? '' : ' '}${t.days})`} value={fmtUsd(p.apiCost.amount)} />}
      </div>

      {topModels.length > 0 && (
        <>
          <div className="section-label">{t.models}</div>
          <ul className="models">
            {topModels.map(([m, v]) => (
              <li key={m}>
                <span className="model-name">{m}</span>
                <span className="model-bar">
                  <span style={{ width: `${(v / totalAll) * 100}%` }} />
                </span>
                <span className="model-val">{fmtTokens(v)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="note">{p.provider === 'claude' ? t.claudeUsageNote : t.openaiUsageNote}</p>
      {problems.length > 0 && (
        <ul className="source-problems">
          {problems.map((s) => (
            <li key={s.id}>
              <span aria-hidden>{s.state === 'error' ? '⚠' : 'ℹ'}</span> <b>{s.label}:</b> {s.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Renewal date (estimated ones are marked), or the end date of a plan that won't renew. */
export function PlanDate({ plan }: { plan: NonNullable<ProviderSnapshot['plan']> }) {
  const { t, lang } = useT();
  const renewing = !plan.status || plan.status === 'active';
  const when = renewing ? plan.renewsAt ?? plan.until : plan.until;
  if (!when) return null;
  const d = new Date(when);
  const date = d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  const days = Math.ceil((d.getTime() - Date.now()) / 86400_000);
  const label = !renewing ? t.expires : plan.renewsEstimated ? t.renewsApprox : t.renews;
  return (
    <span className="muted plan-date" title={plan.renewsEstimated ? t.renewsEstHelp : d.toLocaleString()}>
      {' '}
      · {label} {date}
      {days >= 0 && days <= 60 && <> ({fmtDuration(d.getTime() - Date.now(), lang)})</>}
    </span>
  );
}

export function ResetCreditsLine({ rc }: { rc: NonNullable<ProviderSnapshot['resetCredits']> }) {
  const { t } = useT();
  return (
    <div className={`reset-credits ${rc.available ? '' : 'none'}`} title={t.resetCreditsHelp}>
      <span aria-hidden>🎟</span> {t.resetCredits} <b>{rc.available}</b>
      <span className="muted"> · {fmt(t.resetCreditsUsable, { n: rc.usableNow })}</span>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

const kindRank = (k: QuotaWindow['kind']) => (k === 'session' ? 0 : k === 'weekly' ? 1 : 2);
