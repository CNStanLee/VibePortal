import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResourceSnapshot, Snapshot } from '../../shared/types';
import { api } from '../api';
import { fmt, useT, type Dict } from '../i18n';
import { fmtDuration } from '../format';

type Sev = 'normal' | 'warning' | 'critical';
const sevOf = (pct: number, warn = 80, crit = 92): Sev => (pct >= crit ? 'critical' : pct >= warn ? 'warning' : 'normal');
const SEV_ICON: Record<Sev, string> = { normal: '●', warning: '▲', critical: '◆' };

/** Local (or a remote VibePortal's) CPU, memory, GPU, disks and busiest processes. */
export function Resources({ snapshot }: { snapshot: Snapshot }) {
  const { t, lang } = useT();
  const [host, setHost] = useState('');
  const [data, setData] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<'cpu' | 'rss'>('cpu');
  const hosts = snapshot.remotes ?? [];

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    setData(null);
    setError('');
    const tick = async () => {
      try {
        const r = await api.resources(host || undefined);
        if (alive) {
          setData(r);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) timer = window.setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [host]);

  const findings = useMemo(() => (data ? analyze(data, t) : []), [data, t]);

  return (
    <div className="resources">
      <div className="res-bar">
        <label className="res-host">
          <span className="muted small">{t.machine}</span>
          <select value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">
              {t.thisMachine} ({snapshot.machineName})
            </option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id} disabled={!h.online}>
                {h.name}
                {h.online ? '' : ` · ${t.offlineHost}`}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <span className="muted small">
            {data.host} · {data.platform} · {t.uptime} {fmtDuration(data.uptimeSec * 1000, lang)}
          </span>
        )}
      </div>
      {error && <p className="action-msg small">{error}</p>}
      {!data ? (
        !error && (
          <div className="loading">
            <div className="spinner" aria-hidden />
            {t.loading}
          </div>
        )
      ) : (
        <>
          <div className="res-tiles">
            <Tile label={t.cpu} pct={data.cpu.percent} sub={`${data.cpu.cores} ${t.cores}${data.cpu.load ? ` · ${t.load} ${data.cpu.load.join(' / ')}` : ''}`} series={data.history.map((h) => h.cpu)} times={data.history.map((h) => h.at)} />
            <Tile
              label={t.memory}
              pct={(data.memory.used / data.memory.total) * 100}
              sub={`${bytes(data.memory.used)} / ${bytes(data.memory.total)} · ${bytes(data.memory.available)} ${t.available}`}
              series={data.history.map((h) => h.mem)}
              times={data.history.map((h) => h.at)}
            />
            {data.gpus.length > 0 ? (
              <Tile
                label={data.gpus.length > 1 ? `${t.gpu} (max)` : t.gpu}
                pct={Math.max(...data.gpus.map((g) => g.util))}
                sub={`${t.vram} ${bytes(sum(data.gpus.map((g) => g.memUsed)))} / ${bytes(sum(data.gpus.map((g) => g.memTotal)))}`}
                series={data.history.map((h) => h.gpu ?? 0)}
                times={data.history.map((h) => h.at)}
              />
            ) : (
              <div className="card res-tile empty">
                <div className="res-tile-label">{t.gpu}</div>
                <div className="muted small">{data.gpuNote === 'nvidia-smi not found' ? t.noGpu : data.gpuNote ?? t.noGpu}</div>
              </div>
            )}
            {data.disks[0] && (
              <Tile
                label={`${t.disks} · ${fullest(data).mount}`}
                pct={(fullest(data).used / fullest(data).total) * 100}
                sub={`${bytes(fullest(data).free)} ${t.free} / ${bytes(fullest(data).total)}`}
              />
            )}
          </div>

          <section className="card res-findings" aria-labelledby="h-find">
            <h2 id="h-find">{t.findings}</h2>
            <ul>
              {findings.length ? (
                findings.map((f, i) => (
                  <li key={i} className={`sev-${f.sev}`}>
                    <span className="sev-tag" aria-hidden>
                      {SEV_ICON[f.sev]}
                    </span>{' '}
                    {f.text}
                  </li>
                ))
              ) : (
                <li className="sev-normal">
                  <span className="sev-tag" aria-hidden>
                    {SEV_ICON.normal}
                  </span>{' '}
                  {t.allGood}
                </li>
              )}
            </ul>
          </section>

          <div className="res-grid">
            <section className="card" aria-labelledby="h-cpu">
              <h2 id="h-cpu">
                {t.cpu} <span className="muted small">{data.cpu.model}</span>
              </h2>
              <div className="res-cores" role="list">
                {data.cpu.perCore.map((p, i) => (
                  <span key={i} role="listitem" className={`res-core sev-${sevOf(p, 85, 97)}`} title={`#${i} · ${Math.round(p)}%`} aria-label={`core ${i} ${Math.round(p)}%`}>
                    <span style={{ height: `${Math.max(2, p)}%` }} />
                  </span>
                ))}
              </div>
              <h3 className="res-h3">{t.memory}</h3>
              <Meter label={t.memory} pct={(data.memory.used / data.memory.total) * 100} right={`${bytes(data.memory.used)} / ${bytes(data.memory.total)}`} />
              {!!data.memory.swapTotal && (
                <Meter label={t.swap} pct={((data.memory.swapUsed ?? 0) / data.memory.swapTotal) * 100} right={`${bytes(data.memory.swapUsed ?? 0)} / ${bytes(data.memory.swapTotal)}`} warn={30} crit={70} />
              )}
            </section>

            <section className="card" aria-labelledby="h-gpu">
              <h2 id="h-gpu">{t.gpu}</h2>
              {data.gpus.length === 0 && <p className="muted small">{data.gpuNote === 'nvidia-smi not found' ? t.noGpu : data.gpuNote ?? t.noGpu}</p>}
              {data.gpus.map((g) => (
                <div key={g.index} className="res-gpu">
                  <div className="res-gpu-name">
                    #{g.index} {g.name}
                    <span className="muted small">
                      {g.tempC !== undefined && ` · ${t.temp} ${g.tempC}°C`}
                      {g.powerW !== undefined && ` · ${t.power} ${Math.round(g.powerW)}${g.powerLimitW ? ` / ${Math.round(g.powerLimitW)}` : ''} W`}
                    </span>
                  </div>
                  <Meter label={t.gpu} pct={g.util} right="" warn={101} crit={101} />
                  <Meter label={t.vram} pct={g.memTotal ? (g.memUsed / g.memTotal) * 100 : 0} right={`${bytes(g.memUsed)} / ${bytes(g.memTotal)}`} />
                  {g.processes.length > 0 && (
                    <table className="res-table small">
                      <thead>
                        <tr>
                          <th>{t.pid}</th>
                          <th>{t.gpuProcs}</th>
                          <th className="num">{t.vram}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.processes.map((p) => (
                          <tr key={p.pid}>
                            <td className="mono">{p.pid}</td>
                            <td>{p.name}</td>
                            <td className="num">{bytes(p.mem)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </section>

            <section className="card" aria-labelledby="h-disk">
              <h2 id="h-disk">{t.disks}</h2>
              {data.disks.map((d) => (
                <Meter key={d.mount} label={d.mount} pct={(d.used / d.total) * 100} right={`${bytes(d.free)} ${t.free} / ${bytes(d.total)}`} warn={85} crit={95} mono />
              ))}
            </section>

            <section className="card res-procs" aria-labelledby="h-proc">
              <header className="card-head">
                <h2 id="h-proc">{t.processes}</h2>
                <div className="seg" role="radiogroup">
                  {(['cpu', 'rss'] as const).map((k) => (
                    <button key={k} role="radio" aria-checked={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
                      {k === 'cpu' ? t.sortCpu : t.sortMem}
                    </button>
                  ))}
                </div>
              </header>
              <div className="table-scroll">
              <table className="res-table">
                <thead>
                  <tr>
                    <th>{t.pid}</th>
                    <th>{t.name}</th>
                    <th className="num">{t.cpu}</th>
                    <th className="num">{t.memory}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.processes]
                    .sort((a, b) => (sort === 'cpu' ? b.cpu - a.cpu || b.rss - a.rss : b.rss - a.rss))
                    .slice(0, 12)
                    .map((p) => (
                      <tr key={p.pid} className={p.agent ? `agent agent-${p.agent}` : ''}>
                        <td className="mono">{p.pid}</td>
                        <td>
                          {p.name}
                          {p.agent && <span className={`kind kind-${p.agent === 'claude' ? 'claude-code' : 'codex'}`}>{p.agent === 'claude' ? 'Claude Code' : 'Codex'}</span>}
                        </td>
                        <td className="num">{p.cpu.toFixed(1)}%</td>
                        <td className="num">{bytes(p.rss)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** Stat tile: headline %, a severity meter and the last 10 minutes as a line with a crosshair. */
function Tile({ label, pct, sub, series, times }: { label: string; pct: number; sub: string; series?: number[]; times?: string[] }) {
  const { t } = useT();
  const sev = sevOf(pct);
  return (
    <div className={`card res-tile sev-${sev}`}>
      <div className="res-tile-label">
        {label}
        {sev !== 'normal' && (
          <span className="sev-tag">
            {' '}
            <span aria-hidden>{SEV_ICON[sev]}</span> {t[sev]}
          </span>
        )}
      </div>
      <div className="res-tile-value">{Math.round(pct)}%</div>
      <div className="res-meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="res-tile-sub muted small">{sub}</div>
      {series && series.length > 1 && <Trend label={label} values={series} times={times ?? []} caption={t.last10m} />}
    </div>
  );
}

/** 0–100 line over time; hovering snaps a crosshair to the nearest sample. */
function Trend({ label, values, times, caption }: { label: string; values: number[]; times: string[]; caption: string }) {
  const W = 240;
  const H = 44;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => H - 2 - (Math.min(100, Math.max(0, v)) / 100) * (H - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setHover(Math.round(((e.clientX - r.left) / r.width) * (n - 1)));
  };
  const hi = hover !== null ? Math.max(0, Math.min(n - 1, hover)) : null;
  return (
    <div className="res-trend">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${caption}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <line x1="0" x2={W} y1={y(50)} y2={y(50)} className="res-grid-line" vectorEffect="non-scaling-stroke" />
        <path d={`${d} L${W} ${H} L0 ${H} Z`} className="res-area" />
        <path d={d} className="res-line" vectorEffect="non-scaling-stroke" />
        {hi !== null && <line x1={x(hi)} x2={x(hi)} y1="0" y2={H} className="res-cross" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="res-trend-cap muted tiny">
        {hi !== null ? (
          <>
            {new Date(times[hi]).toLocaleTimeString()} · <b>{Math.round(values[hi])}%</b>
          </>
        ) : (
          caption
        )}
      </div>
    </div>
  );
}

function Meter({ label, pct, right, warn = 80, crit = 92, mono = false }: { label: string; pct: number; right: string; warn?: number; crit?: number; mono?: boolean }) {
  const sev = sevOf(pct, warn, crit);
  return (
    <div className={`res-row sev-${sev}`}>
      <span className={`res-row-name ${mono ? 'mono' : ''}`} title={label}>
        {label}
      </span>
      <span className="res-meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="res-row-pct">{Math.round(pct)}%</span>
      <span className="res-row-right muted small">{right}</span>
    </div>
  );
}

/** Plain-language findings from one sample (no model involved). */
function analyze(d: ResourceSnapshot, t: Dict): { sev: Sev; text: string }[] {
  const out: { sev: Sev; text: string }[] = [];
  for (const k of d.disks) {
    const p = (k.used / k.total) * 100;
    if (p >= 85) out.push({ sev: p >= 95 ? 'critical' : 'warning', text: fmt(t.fDisk, { m: k.mount, p: Math.round(p), f: bytes(k.free) }) });
  }
  const memPct = (d.memory.used / d.memory.total) * 100;
  if (memPct >= 85) out.push({ sev: memPct >= 95 ? 'critical' : 'warning', text: fmt(t.fMem, { p: Math.round(memPct) }) });
  if ((d.memory.swapUsed ?? 0) > 256 * 2 ** 20) out.push({ sev: memPct >= 85 ? 'warning' : 'normal', text: fmt(t.fSwap, { s: bytes(d.memory.swapUsed!) }) });
  const recent = d.history.slice(-12).map((h) => h.cpu);
  const cpuAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : d.cpu.percent;
  if (cpuAvg >= 80) out.push({ sev: cpuAvg >= 95 ? 'critical' : 'warning', text: fmt(t.fCpu, { p: Math.round(cpuAvg) }) });
  for (const g of d.gpus) {
    const memP = g.memTotal ? Math.round((g.memUsed / g.memTotal) * 100) : 0;
    if (g.util >= 50 || memP >= 50) out.push({ sev: memP >= 95 ? 'warning' : 'normal', text: fmt(t.fGpuBusy, { i: g.index, u: Math.round(g.util), m: memP }) });
    if ((g.tempC ?? 0) >= 83) out.push({ sev: (g.tempC ?? 0) >= 90 ? 'critical' : 'warning', text: fmt(t.fGpuHot, { i: g.index, t: g.tempC! }) });
  }
  const agents = d.processes.filter((p) => p.agent);
  if (agents.length) {
    out.push({ sev: 'normal', text: fmt(t.fAgents, { c: Math.round(sum(agents.map((p) => p.cpu))), r: bytes(sum(agents.map((p) => p.rss))) }) });
  }
  const rank = { critical: 0, warning: 1, normal: 2 } as const;
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

const fullest = (d: ResourceSnapshot) => d.disks.reduce((a, b) => (b.used / b.total > a.used / a.total ? b : a));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function bytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
