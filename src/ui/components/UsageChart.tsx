import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ProviderSnapshot } from '../../shared/types';
import { useT } from '../i18n';
import { fmtTokens, shortDate } from '../format';

interface Row {
  date: string;
  values: number[]; // per series, same order as `series`
}

const H = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 48 };

/** Daily token usage, Claude Code + Codex stacked per day. */
export function UsageChart({ providers, days }: { providers: ProviderSnapshot[]; days: number }) {
  const { t, lang } = useT();
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const series = providers.map((p) => ({ key: p.provider, name: p.provider === 'claude' ? 'Claude Code' : 'Codex' }));
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const maps = providers.map((p) => new Map(p.daily.map((d) => [d.date, d.totals.total])));
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({ date, values: maps.map((m) => m.get(date) ?? 0) });
    }
    return out;
  }, [providers, days]);

  const max = Math.max(1, ...rows.map((r) => r.values.reduce((a, b) => a + b, 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = innerW / rows.length;
  const barW = Math.max(2, Math.min(28, step - 2)); // ≥2px surface gap between bars
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const labelEvery = Math.ceil(rows.length / Math.max(2, Math.floor(innerW / 46)));
  const total = rows.reduce((s, r) => s + r.values.reduce((a, b) => a + b, 0), 0);

  return (
    <section className="card chart-card" aria-labelledby="h-chart">
      <header className="chart-head">
        <div>
          <h2 id="h-chart">{t.dailyTokens}</h2>
          <div className="muted small">
            {days} {t.days} · {fmtTokens(total)} {t.tokens}
          </div>
        </div>
        <div className="chart-tools">
          <ul className="legend" aria-label="legend">
            {series.map((s, i) => (
              <li key={s.key}>
                <span className={`swatch p-${s.key}`} aria-hidden /> {s.name}
              </li>
            ))}
          </ul>
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={mode === 'chart'} onClick={() => setMode('chart')}>
              {t.chartBars}
            </button>
            <button role="tab" aria-selected={mode === 'table'} onClick={() => setMode('table')}>
              {t.chartTable}
            </button>
          </div>
        </div>
      </header>

      {mode === 'chart' ? (
        <div className="chart" ref={wrap} onMouseLeave={() => setHover(null)}>
          <svg width={width} height={H} role="img" aria-label={t.dailyTokens}>
            {ticks.map((v) => (
              <g key={v}>
                <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
                <text className="axis" x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                  {fmtTokens(v)}
                </text>
              </g>
            ))}
            <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
            {rows.map((r, i) => {
              const cx = PAD.left + step * i + step / 2;
              let acc = 0;
              const lastNonZero = r.values.reduce((li, v, k) => (v > 0 ? k : li), -1);
              return (
                <g key={r.date}>
                  {r.values.map((v, k) => {
                    if (v <= 0) return null;
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    // 2px surface gap between stacked segments
                    const h = Math.max(1, y0 - y1 - (k > 0 ? 2 : 0));
                    return (
                      <path
                        key={k}
                        className={`bar p-${series[k].key} ${hover !== null && hover !== i ? 'dim' : ''}`}
                        d={roundedTop(cx - barW / 2, y0 - (k > 0 ? 2 : 0) - h, barW, h, k === lastNonZero ? Math.min(4, barW / 2, h) : 0)}
                      />
                    );
                  })}
                  {i % labelEvery === (rows.length - 1) % labelEvery && (
                    <text className="axis" x={cx} y={H - 8} textAnchor="middle">
                      {shortDate(r.date, lang)}
                    </text>
                  )}
                  {/* hit target wider than the mark */}
                  <rect
                    x={PAD.left + step * i}
                    y={PAD.top}
                    width={step}
                    height={innerH}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    tabIndex={-1}
                  />
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <Tooltip
              row={rows[hover]}
              series={series}
              left={PAD.left + step * hover + step / 2}
              width={width}
            />
          )}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t.date}</th>
                {series.map((s) => (
                  <th key={s.key} className="num">
                    {s.name}
                  </th>
                ))}
                <th className="num">{t.total}</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.date}>
                  <td>{r.date}</td>
                  {r.values.map((v, k) => (
                    <td key={k} className="num">
                      {v ? fmtTokens(v) : '—'}
                    </td>
                  ))}
                  <td className="num">{fmtTokens(r.values.reduce((a, b) => a + b, 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Tooltip({ row, series, left, width }: { row: Row; series: { key: string; name: string }[]; left: number; width: number }) {
  const { t } = useT();
  const sum = row.values.reduce((a, b) => a + b, 0);
  const flip = left > width - 170;
  return (
    <div className="tooltip" style={flip ? { right: width - left + 10 } : { left: left + 10 }}>
      <div className="tt-title">{row.date}</div>
      {row.values.map((v, k) => (
        <div key={k} className="tt-row">
          <span className={`swatch p-${series[k].key}`} aria-hidden />
          <span>{series[k].name}</span>
          <b>{fmtTokens(v)}</b>
        </div>
      ))}
      <div className="tt-row tt-total">
        <span />
        <span>{t.total}</span>
        <b>{fmtTokens(sum)}</b>
      </div>
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceTicks(max: number): number[] {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const stepN = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + stepN * 0.999; v += stepN) out.push(v);
  return out.length > 1 ? out : [0, stepN];
}
