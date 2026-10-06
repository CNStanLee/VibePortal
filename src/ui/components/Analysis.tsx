import { useMemo, useState } from 'react';
import { addTotals, emptyTotals, type ProviderSnapshot, type QuotaWindow, type Snapshot, type TokenTotals } from '../../shared/types';
import { fmt, useT } from '../i18n';
import { api } from '../api';
import { EditorGlyph, ForgeMark } from './Brand';
import { fmtDuration, fmtTokens, fmtUsd, relTime, shortPath } from '../format';

type Range = 'today' | '7d' | 'all';

interface RepoRow {
  key: string;
  name: string;
  claude: TokenTotals;
  openai: TokenTotals;
  total: TokenTotals;
  spark: number[];
  topModel?: string;
  lastActive: string;
  webUrl?: string;
  forge?: string;
}

export function Analysis({ snapshot }: { snapshot: Snapshot }) {
  const { t, lang } = useT();
  const [range, setRange] = useState<Range>('7d');
  const providers = snapshot.providers;

  const pick = (p: { today: TokenTotals; last7d: TokenTotals; total: TokenTotals }) => (range === 'today' ? p.today : range === '7d' ? p.last7d : p.total);

  const repos: RepoRow[] = useMemo(() => {
    const m = new Map<string, RepoRow>();
    for (const prov of providers) {
      for (const pr of prov.projects) {
        let r = m.get(pr.key);
        if (!r) {
          r = {
            key: pr.key,
            name: pr.name,
            claude: emptyTotals(),
            openai: emptyTotals(),
            total: emptyTotals(),
            spark: new Array(14).fill(0),
            lastActive: pr.lastActive,
            webUrl: pr.webUrl,
            forge: pr.forge,
          };
          m.set(pr.key, r);
        }
        const v = pick(pr);
        r[prov.provider] = addTotals(r[prov.provider], v);
        r.total = addTotals(r.total, v);
        pr.spark.forEach((n, i) => (r!.spark[i] += n));
        if (pr.lastActive > r.lastActive) r.lastActive = pr.lastActive;
        const top = Object.entries(pr.byModel).sort((a, b) => b[1].total - a[1].total)[0];
        if (top && (!r.topModel || top[1].total > 0)) r.topModel = r.topModel ?? top[0];
      }
    }
    return [...m.values()].filter((r) => r.total.total > 0).sort((a, b) => b.total.total - a.total.total);
  }, [providers, range]);

  const models = useMemo(() => {
    const out = new Map<string, { provider: ProviderSnapshot['provider']; totals: TokenTotals }>();
    const cutoff = rangeCutoff(range);
    for (const prov of providers) {
      for (const d of prov.daily) {
        if (d.date < cutoff) continue;
        for (const [model, tot] of Object.entries(d.byModel)) {
          const cur = out.get(model) ?? { provider: prov.provider, totals: emptyTotals() };
          cur.totals = addTotals(cur.totals, tot);
          out.set(model, cur);
        }
      }
    }
    return [...out.entries()].sort((a, b) => b[1].totals.total - a[1].totals.total);
  }, [providers, range]);

  const all = models.reduce((acc, [, v]) => addTotals(acc, v.totals), emptyTotals());
  const unpriced = new Set(providers.flatMap((p) => p.unpricedModels));
  const cacheBase = all.input + all.cacheRead + all.cacheWrite;
  const cacheHit = cacheBase ? all.cacheRead / cacheBase : 0;
  const burn = providers.reduce((s, p) => s + p.last5h.total, 0) / 5;
  const days = range === 'today' ? 1 : range === '7d' ? 7 : snapshot.historyDays;
  const repoMax = repos[0]?.total.total || 1;

  return (
    <div className="analysis">
      <div className="analysis-head">
        <div className="seg" role="tablist">
          {(['today', '7d', 'all'] as Range[]).map((r) => (
            <button key={r} role="tab" aria-selected={range === r} onClick={() => setRange(r)}>
              {r === 'today' ? t.rangeToday : r === '7d' ? t.range7d : `${t.rangeAll} (${snapshot.historyDays}${lang === 'zh' ? '天' : 'd'})`}
            </button>
          ))}
        </div>
      </div>

      <div className="tiles">
        <Tile label={t.total} value={fmtTokens(all.total)} sub={`${fmtTokens(all.output)} ${t.output}`} />
        <Tile label={t.estCost} value={fmtUsd(all.cost)} sub={unpriced.size ? `${unpriced.size} ${lang === 'zh' ? '个模型无价格' : 'models unpriced'}` : undefined} />
        <Tile label={t.cacheHit} value={`${Math.round(cacheHit * 100)}%`} sub={`${fmtTokens(all.cacheRead)} ${t.cacheRead}`} />
        <Tile label={t.burnRate} value={`${fmtTokens(burn)}`} sub={t.perHourTok} />
        <Tile label={t.avgDaily} value={fmtTokens(all.total / days)} sub={fmtUsd(all.cost / days)} />
      </div>

      <section className="card">
        <h2>{t.forecasts}</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.window}</th>
                <th className="num">{t.used}</th>
                <th className="num">{t.speed}</th>
                <th>{t.outlook}</th>
                <th>{t.resetsIn}</th>
              </tr>
            </thead>
            <tbody>
              {providers.flatMap((p) => {
                const rows = p.quotas.map((q) => <ForecastRow key={p.provider + q.id} p={p} q={q} />);
                if (!p.quotas.some((q) => q.kind === 'session'))
                  rows.unshift(
                    <tr key={p.provider + '-5h'}>
                      <td>
                        <span className={`dot p-${p.provider}`} /> {p.name} · {t.window5h}
                      </td>
                      <td className="num muted">—</td>
                      <td className="num muted">—</td>
                      <td className="muted" colSpan={2}>
                        {t.no5h}
                      </td>
                    </tr>,
                  );
                return rows;
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>{t.repos}</h2>
        <div className="table-wrap tall">
          <table className="data repos">
            <thead>
              <tr>
                <th>{t.repo}</th>
                <th className="num">Claude</th>
                <th className="num">Codex</th>
                <th>{t.share}</th>
                <th className="num">{t.estCost}</th>
                <th className="hide-sm">14d</th>
                <th className="hide-sm">{t.lastActive}</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.key}>
                  <td>
                    <div className="repo-cell">
                      <div className="repo-text">
                        <div className="repo-name">{r.name}</div>
                        <div className="repo-path mono" title={r.key}>
                          {shortPath(r.key)}
                        </div>
                      </div>
                      <div className="repo-actions">
                        {r.webUrl && (
                          <a className="icon-btn" href={r.webUrl} target="_blank" rel="noreferrer" title={`${t.openWeb}: ${r.webUrl}`} aria-label={t.openWeb}>
                            <ForgeMark forge={r.forge} />
                          </a>
                        )}
                        <button
                          className="icon-btn"
                          title={t.openEditor}
                          aria-label={t.openEditor}
                          onClick={() => void api.openProject(r.key).catch((e) => alert((e as Error).message))}
                        >
                          <EditorGlyph />
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="num">{r.claude.total ? fmtTokens(r.claude.total) : '—'}</td>
                  <td className="num">{r.openai.total ? fmtTokens(r.openai.total) : '—'}</td>
                  <td>
                    <div className="share" title={`${fmtTokens(r.total.total)} (${Math.round((r.total.total / (all.total || 1)) * 100)}%)`}>
                      <span className="p-claude" style={{ width: `${(r.claude.total / repoMax) * 100}%` }} />
                      <span className="p-openai" style={{ width: `${(r.openai.total / repoMax) * 100}%` }} />
                    </div>
                  </td>
                  <td className="num">{r.total.cost ? fmtUsd(r.total.cost) : '—'}</td>
                  <td className="hide-sm">
                    <Spark values={r.spark} />
                  </td>
                  <td className="hide-sm muted small">{relTime(r.lastActive, t, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>{t.models}</h2>
        <div className="table-wrap tall">
          <table className="data">
            <thead>
              <tr>
                <th>{t.models}</th>
                <th className="num">{t.total}</th>
                <th className="num">{t.input}</th>
                <th className="num">{t.output}</th>
                <th className="num">{t.cacheRead}</th>
                <th className="num">{t.cacheWrite}</th>
                <th className="num">{t.estCost}</th>
                <th className="num">{t.share}</th>
              </tr>
            </thead>
            <tbody>
              {models.map(([m, v]) => (
                <tr key={m}>
                  <td>
                    <span className={`dot p-${v.provider}`} /> <span className="mono">{m}</span>
                  </td>
                  <td className="num">{fmtTokens(v.totals.total)}</td>
                  <td className="num">{fmtTokens(v.totals.input)}</td>
                  <td className="num">{fmtTokens(v.totals.output)}</td>
                  <td className="num">{fmtTokens(v.totals.cacheRead)}</td>
                  <td className="num">{fmtTokens(v.totals.cacheWrite)}</td>
                  <td className="num">{unpriced.has(m) ? '—' : fmtUsd(v.totals.cost)}</td>
                  <td className="num">{Math.round((v.totals.total / (all.total || 1)) * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">{t.priceNote}</p>
      </section>
    </div>
  );
}

function ForecastRow({ p, q }: { p: ProviderSnapshot; q: QuotaWindow }) {
  const { t, lang } = useT();
  const f = q.forecast;
  let outlook: React.ReactNode = <span className="muted">—</span>;
  if (f?.willExhaustBeforeReset && f.exhaustAt) {
    outlook = (
      <span className="bad-text">
        ⚠ {t.runsOut} · {new Date(f.exhaustAt).toLocaleString(lang === 'zh' ? 'zh-CN' : undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  } else if (f) {
    outlook = (
      <span>
        ✓ {t.safe} <span className="muted">(~{Math.round(Math.min(f.projectedAtReset ?? q.percent, 999))}%)</span>
      </span>
    );
  }
  return (
    <tr>
      <td>
        <span className={`dot p-${p.provider}`} /> {p.name} · {q.kind === 'session' ? t.window5h : q.label}
      </td>
      <td className={`num sev-text-${q.severity}`}>{Math.round(q.percent)}%</td>
      <td className="num">{f ? fmt(t.rate, { r: f.ratePerHour }) : '—'}</td>
      <td>{outlook}</td>
      <td className="small">{q.resetsAt ? fmtDuration(Date.parse(q.resetsAt) - Date.now(), lang) : '—'}</td>
    </tr>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 4;
  return (
    <svg className="spark" width={values.length * (w + 2)} height={22} aria-hidden>
      {values.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * 20) : 1;
        return <rect key={i} x={i * (w + 2)} y={22 - h} width={w} height={h} rx={1} className={v ? 'on' : 'off'} />;
      })}
    </svg>
  );
}

function rangeCutoff(r: Range): string {
  if (r === 'all') return '';
  const d = new Date();
  if (r === '7d') d.setDate(d.getDate() - 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
