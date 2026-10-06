import { useEffect, useMemo, useRef, useState } from 'react';
import { MULTI_DRAW, PITY, RARITIES, RARITY_ODDS, SPECIES, allCrops, colorsFor, speciesOf, stageOf, type Crop, type FarmView, type Rarity, type Seed, type SeedColor } from '../../shared/farm';
import { api } from '../api';
import { fmt, useT } from '../i18n';
import { fmtDuration, fmtTokens } from '../format';
import { Mascot } from './Mascots';
import { PlantSprite, SeedPacket, colorSwatch } from './FarmArt';
import { FarmSocialSection } from './FarmSocial';

const RARITY_NAME: Record<Rarity, { zh: string; en: string }> = {
  common: { zh: '普通', en: 'Common' },
  fine: { zh: '优良', en: 'Fine' },
  rare: { zh: '稀有', en: 'Rare' },
  epic: { zh: '史诗', en: 'Epic' },
  legendary: { zh: '传说', en: 'Legendary' },
  mythic: { zh: '神话', en: 'Mythic' },
};
const COLOR_NAME: Record<SeedColor, { zh: string; en: string }> = {
  red: { zh: '赤红', en: 'Red' },
  orange: { zh: '橙', en: 'Orange' },
  yellow: { zh: '明黄', en: 'Yellow' },
  pink: { zh: '粉', en: 'Pink' },
  purple: { zh: '紫', en: 'Purple' },
  blue: { zh: '湛蓝', en: 'Blue' },
  white: { zh: '雪白', en: 'White' },
  black: { zh: '墨色', en: 'Ink' },
  gold: { zh: '鎏金', en: 'Gold' },
  rainbow: { zh: '虹彩', en: 'Rainbow' },
};

type Lang = 'zh' | 'en';
const plantName = (x: { species: string; color: SeedColor }, lang: Lang) =>
  lang === 'zh' ? `${COLOR_NAME[x.color].zh}${speciesOf(x.species).zh}` : `${COLOR_NAME[x.color].en} ${speciesOf(x.species).en}`;
const rank = (r: Rarity) => RARITIES.indexOf(r);
/** 55%, 4.5%, 0.1% */
const oddsPct = (n: number) => `${+n.toFixed(2)}%`;
/** a grow time in whole units: 25m, 1h 45m, 3d */
function growLabel(min: number, lang: Lang): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const parts = lang === 'zh' ? [d && `${d}天`, h && `${h}小时`, m && `${m}分钟`] : [d && `${d}d`, h && `${h}h`, m && `${m}m`];
  return parts.filter(Boolean).join(lang === 'zh' ? '' : ' ');
}

/**
 * The crab farm: the tokens you burn buy seed draws, seeds grow into pixel
 * plants, and the plants sit in a showcase (or wait in the storehouse). Purely
 * for looks.
 */
export function FarmPage() {
  const { t, lang } = useT();
  const [farm, setFarm] = useState<FarmView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [picking, setPicking] = useState<number | null>(null);
  const [reveal, setReveal] = useState<Seed[] | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [shown, setShown] = useState<Crop | null>(null);
  const [fresh, setFresh] = useState<Crop[] | null>(null);
  const [view, setView] = useState<'showcase' | 'store' | 'dex'>('showcase');

  const load = () =>
    api
      .farm()
      .then((f) => {
        setFarm(f);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    const poll = window.setInterval(load, 60_000);
    const tick = window.setInterval(() => setNow(Date.now()), 5000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  const act = async <R,>(action: Parameters<typeof api.farmAct>[0], body: Record<string, unknown>): Promise<R | undefined> => {
    setBusy(true);
    setError('');
    try {
      const r = await api.farmAct<R>(action, body);
      setFarm(r.farm);
      setNow(Date.now());
      return r.result;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDraw = async (count: number) => {
    const seeds = await act<Seed[]>('draw', { count });
    if (!seeds) return;
    setReveal(seeds);
    setSpinning(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  };
  const plantSeed = async (plot: number, seedId: string) => {
    setPicking(null);
    await act('plant', { plot, seedId });
  };
  const harvestAll = async (plots: number[]) => {
    const got: Crop[] = [];
    for (const plot of plots) {
      const c = await act<Crop>('harvest', { plot });
      if (c) got.push(c);
    }
    if (got.length) setFresh(got);
  };

  if (!farm) {
    return <div className="farm">{error ? <p className="action-msg">{error}</p> : <div className="loading"><div className="spinner" aria-hidden /></div>}</div>;
  }

  const shownStored = !!shown && farm.stored.some((c) => c.id === shown.id);
  const ripe = farm.plots.flatMap((p, i) => (p.seed && stageOf(p, now) === 3 ? [i] : []));
  const firstEmpty = farm.plots.findIndex((p) => !p.seed);
  const toNext = farm.tokensPerDraw - (farm.balance % farm.tokensPerDraw);
  const pct = ((farm.balance % farm.tokensPerDraw) / farm.tokensPerDraw) * 100;

  return (
    <div className="farm">
      <section className="card farm-hero">
        <div className="farm-hero-text">
          <h2>🦀 {t.farmTitle}</h2>
          <p className="muted small">{t.farmTagline}</p>
        </div>
        <div className="farm-wallet">
          <div className="farm-wallet-row">
            <span className="farm-big">{farm.drawsAvailable}</span>
            <span className="muted small">{t.farmDraws}</span>
          </div>
          <div className="farm-next" title={fmt(t.farmNextHelp, { n: fmtTokens(toNext) })}>
            <span className="farm-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="muted tiny">{fmt(t.farmNext, { n: fmtTokens(toNext) })}</span>
          </div>
          <div className="muted tiny">
            {fmt(t.farmEarned, { n: fmtTokens(farm.earnedTokens), per: fmtTokens(farm.tokensPerDraw) })}
          </div>
        </div>
        <div className="farm-draw-btns">
          <button className="btn primary" disabled={busy || farm.drawsAvailable < 1} onClick={() => void doDraw(1)}>
            🎰 {t.farmDraw1}
          </button>
          <button className="btn primary farm-ten" disabled={busy || farm.drawsAvailable < MULTI_DRAW} onClick={() => void doDraw(MULTI_DRAW)}>
            ✨ {t.farmDraw10}
          </button>
        </div>
        <details className="farm-odds">
          <summary className="muted tiny">{t.farmOdds}</summary>
          <ul>
            {RARITIES.map((r) => (
              <li key={r} className={`r-${r}`}>
                <b>{RARITY_NAME[r][lang]}</b> {oddsPct(RARITY_ODDS[r])} · {SPECIES.filter((s) => s.rarity === r).map((s) => s[lang]).join(' / ')}
              </li>
            ))}
          </ul>
          <p className="muted tiny">{fmt(t.farmOddsNote, { pity: PITY - farm.pity })}</p>
        </details>
        {error && <p className="action-msg small">{error}</p>}
      </section>

      <section className="card farm-field-card">
        <header className="card-head">
          <h2>{t.farmField}</h2>
          {ripe.length > 0 && (
            <button className="btn primary" disabled={busy} onClick={() => void harvestAll(ripe)}>
              🧺 {fmt(t.farmHarvestAll, { n: ripe.length })}
            </button>
          )}
        </header>
        <div className="farm-field">
          <div className="farm-crab" aria-hidden>
            <Mascot kind="crab" mood={ripe.length ? 'happy' : 'idle'} size={34} />
          </div>
          {farm.plots.map((p, i) => {
            const stage = p.seed ? stageOf(p, now) : 0;
            const left = p.readyAt ? p.readyAt - now : 0;
            return (
              <button
                key={i}
                className={`plot ${p.seed ? `r-${p.seed.rarity}` : 'empty'} ${p.seed && stage === 3 ? 'ripe' : ''}`}
                disabled={busy}
                onClick={() => {
                  if (!p.seed) return farm.seeds.length ? setPicking(i) : undefined;
                  if (stage === 3) return void harvestAll([i]);
                  if (window.confirm(t.farmUprootAsk)) void act('uproot', { plot: i });
                }}
                title={p.seed ? `${RARITY_NAME[p.seed.rarity][lang]} · ${plantName(p.seed, lang)}` : farm.seeds.length ? t.farmPlantHere : t.farmNoSeeds}
              >
                {p.seed ? (
                  <>
                    <PlantSprite species={p.seed.species} color={p.seed.color} stage={stage} size={56} className={stage === 3 ? 'sway' : ''} />
                    <span className="plot-tag">{stage === 3 ? t.farmRipe : fmtDuration(left, lang)}</span>
                  </>
                ) : (
                  <span className="plot-empty">{farm.seeds.length ? '+' : ''}</span>
                )}
              </button>
            );
          })}
        </div>
        <SeedBag seeds={farm.seeds} lang={lang} onPick={firstEmpty >= 0 ? (s) => void plantSeed(firstEmpty, s.id) : undefined} />
      </section>

      <section className="card">
        <header className="card-head">
          <div className="seg" role="tablist">
            <button role="tab" aria-selected={view === 'showcase'} onClick={() => setView('showcase')}>
              🏺 {t.farmShowcase} <span className="muted">{farm.crops.length}</span>
            </button>
            <button role="tab" aria-selected={view === 'store'} onClick={() => setView('store')}>
              📦 {t.farmStore} <span className="muted">{farm.stored.length}</span>
            </button>
            <button role="tab" aria-selected={view === 'dex'} onClick={() => setView('dex')}>
              📖 {t.farmDex}
            </button>
          </div>
        </header>
        {view === 'showcase' ? (
          <Showcase crops={farm.crops} empty={t.farmShowcaseEmpty} lang={lang} onOpen={setShown} />
        ) : view === 'store' ? (
          <Showcase crops={farm.stored} empty={t.farmStoreEmpty} lang={lang} onOpen={setShown} />
        ) : (
          <Dex crops={allCrops(farm)} lang={lang} />
        )}
      </section>

      <FarmSocialSection farm={farm} />

      {picking !== null && (
        <Modal onClose={() => setPicking(null)} label={t.farmPickSeed}>
          <h3>{t.farmPickSeed}</h3>
          <SeedBag seeds={farm.seeds} lang={lang} onPick={(s) => void plantSeed(picking, s.id)} big />
        </Modal>
      )}
      {reveal && spinning && (
        <Modal onClose={() => setSpinning(false)} label={t.farmSpinning}>
          <Spin seeds={reveal} lang={lang} onDone={() => setSpinning(false)} />
        </Modal>
      )}
      {reveal && !spinning && (
        <Modal onClose={() => setReveal(null)} label={t.farmGot}>
          <h3>{t.farmGot}</h3>
          <div className={`reveal ${reveal.length > 1 ? 'ten' : ''}`}>
            {[...reveal]
              .map((s, i) => ({ s, i }))
              .map(({ s, i }) => (
                <div key={s.id} className={`reveal-card r-${s.rarity}`} style={{ animationDelay: `${i * 110}ms` }}>
                  <SeedPacket species={s.species} color={s.color} rarity={s.rarity} size={reveal.length > 1 ? 46 : 84} />
                  <b className="r-name">{RARITY_NAME[s.rarity][lang]}</b>
                  <span className="tiny">{plantName(s, lang)}</span>
                </div>
              ))}
          </div>
          <button className="btn primary" onClick={() => setReveal(null)}>
            {t.farmKeep}
          </button>
        </Modal>
      )}
      {fresh && (
        <Modal onClose={() => setFresh(null)} label={t.farmHarvested}>
          <h3>🧺 {t.farmHarvested}</h3>
          <div className="reveal">
            {fresh.map((c, i) => (
              <div key={c.id} className={`reveal-card r-${c.rarity}`} style={{ animationDelay: `${i * 110}ms` }}>
                <Potted crop={c} size={fresh.length > 1 ? 56 : 96} />
                <b className="r-name">{RARITY_NAME[c.rarity][lang]}</b>
                <span className="tiny">{plantName(c, lang)}</span>
                {c.mutated && <span className="mutated">✨ {t.farmMutated}</span>}
              </div>
            ))}
          </div>
          <button className="btn primary" onClick={() => setFresh(null)}>
            {t.farmToShowcase}
          </button>
        </Modal>
      )}
      {shown && (
        <Modal onClose={() => setShown(null)} label={plantName(shown, lang)}>
          <div className={`crop-detail r-${shown.rarity}`}>
            <Potted crop={shown} size={128} />
            <h3>{plantName(shown, lang)}</h3>
            <p>
              <b className="r-name">{RARITY_NAME[shown.rarity][lang]}</b>
              {shown.mutated && <span className="mutated"> · ✨ {t.farmMutated}</span>}
            </p>
            <p className="muted tiny">{fmt(t.farmHarvestedOn, { d: new Date(shown.harvestedAt).toLocaleString() })}</p>
            <div className="action-row">
              <button className="btn ghost" onClick={() => setShown(null)}>
                {t.close}
              </button>
              {shownStored ? (
                <>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      if (!window.confirm(t.farmDiscardAsk)) return;
                      void act('discard', { cropId: shown.id });
                      setShown(null);
                    }}
                  >
                    👋 {t.farmDiscard}
                  </button>
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() => {
                      void act('display', { cropId: shown.id });
                      setShown(null);
                    }}
                  >
                    🏺 {t.farmToDisplay}
                  </button>
                </>
              ) : (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    void act('store', { cropId: shown.id });
                    setShown(null);
                  }}
                >
                  📦 {t.farmToStore}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── the draw: a CS:GO-style case opening ──────────────────────────────────────
/** packets on a reel, and where on it the drawn seed sits (more packets run on past it) */
const REEL = { one: { len: 56, win: 48, cell: 100, packet: 64, ms: 5600 }, ten: { len: 36, win: 29, cell: 50, packet: 32, ms: 3400 } };
/** the reel's filler odds: the good stuff turns up more often than in the real draw, to tease */
const TEASE: Record<Rarity, number> = { common: 38, fine: 28, rare: 17, epic: 10, legendary: 5, mythic: 2 };
const MUTE_KEY = 'vp.farm.mute';
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

function fillerSeed(rarity?: Rarity): Seed {
  let x = Math.random() * 100;
  const r = rarity ?? RARITIES.find((q) => (x -= TEASE[q]) < 0) ?? 'common';
  return { id: '', species: pick(SPECIES.filter((s) => s.rarity === r)).id, color: pick(colorsFor(r)), rarity: r };
}

function reelFor(win: Seed, len: number, at: number): Seed[] {
  const items = Array.from({ length: len }, () => fillerSeed());
  items[at] = win;
  // a near miss: something better right next to what you got
  if (rank(win.rarity) < rank('legendary') && Math.random() < 0.55) {
    const better = RARITIES[Math.min(rank(win.rarity) + 1 + Math.floor(Math.random() * 2), rank('legendary'))];
    items[at + (Math.random() < 0.5 ? -1 : 1)] = fillerSeed(better);
  }
  return items;
}

/**
 * The seeds you drew, one reel each: packets race past the marker, slow down
 * and stop on yours (with a tick per packet, like opening a case). A ten-draw
 * spins ten small reels that stop one after another.
 */
function Spin({ seeds, lang, onDone }: { seeds: Seed[]; lang: Lang; onDone: () => void }) {
  const { t } = useT();
  const cfg = seeds.length > 1 ? REEL.ten : REEL.one;
  const reels = useMemo(() => seeds.map((s) => reelFor(s, cfg.len, cfg.win)), [seeds, cfg]);
  const box = useRef<HTMLDivElement>(null);
  const tracks = useRef<(HTMLDivElement | null)[]>([]);
  const [landed, setLanded] = useState(0);
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1');
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const view = box.current?.clientWidth ?? 320;
    const centre = cfg.win * cfg.cell + cfg.cell / 2 - view / 2;
    // stop somewhere on the packet, not dead centre, then ease onto it
    const ends = seeds.map(() => centre + (Math.random() - 0.5) * cfg.cell * 0.8);
    const durs = seeds.map((_, i) => cfg.ms + i * 240);
    const timers: number[] = [];
    let frame = 0;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        tracks.current.forEach((el, i) => {
          if (!el) return;
          el.style.transition = `transform ${durs[i]}ms cubic-bezier(0.12, 0.6, 0.12, 1)`;
          el.style.transform = `translateX(${-ends[i]}px)`;
        });
        frame = requestAnimationFrame(follow);
      });
    });
    durs.forEach((d, i) =>
      timers.push(
        window.setTimeout(() => {
          const el = tracks.current[i];
          if (el) {
            el.style.transition = 'transform 400ms ease-in-out';
            el.style.transform = `translateX(${-centre}px)`;
          }
          setLanded(i + 1);
          if (rank(seeds[i].rarity) >= rank('legendary')) navigator.vibrate?.(80);
        }, d),
      ),
    );
    const last = durs[durs.length - 1];
    timers.push(window.setTimeout(() => done.current(), last + (seeds.length > 1 ? 1000 : 1500)));

    // a tick each time a packet crosses the marker, following the last (slowest) reel
    let audio: AudioContext | undefined;
    let passed = -1;
    let lastTick = 0;
    const tick = () => {
      if (mutedRef.current) return;
      try {
        audio ??= new AudioContext();
        void audio.resume().catch(() => {});
        const o = audio.createOscillator();
        const g = audio.createGain();
        const at = audio.currentTime;
        o.type = 'triangle';
        o.frequency.setValueAtTime(1400, at);
        o.frequency.exponentialRampToValueAtTime(700, at + 0.03);
        g.gain.setValueAtTime(0.06, at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
        o.connect(g).connect(audio.destination);
        o.start(at);
        o.stop(at + 0.05);
      } catch {
        /* no audio here */
      }
    };
    const started = performance.now();
    function follow(now: number) {
      const el = tracks.current[seeds.length - 1];
      if (!el || now - started > last + 200) return;
      const x = -new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
      const at = Math.floor((x + view / 2) / cfg.cell);
      if (at !== passed) {
        if (passed >= 0 && now - lastTick > 30) {
          tick();
          lastTick = now;
        }
        passed = at;
      }
      frame = requestAnimationFrame(follow);
    }
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      void audio?.close().catch(() => {});
    };
  }, [seeds, cfg]);

  return (
    <div className={`spin ${seeds.length > 1 ? 'ten' : 'one'}`} style={{ '--cell': `${cfg.cell}px` } as React.CSSProperties}>
      <h3>🎰 {t.farmSpinning}</h3>
      <div className="spin-box" ref={box}>
        {reels.map((items, i) => (
          <div key={i} className={`spin-row ${landed > i ? `landed r-${seeds[i].rarity}` : ''}`}>
            <div className="spin-track" ref={(el) => void (tracks.current[i] = el)}>
              {items.map((s, j) => (
                <div key={j} className={`spin-item r-${s.rarity} ${j === cfg.win ? 'win' : ''}`}>
                  <SeedPacket species={s.species} color={s.color} rarity={s.rarity} size={cfg.packet} />
                </div>
              ))}
            </div>
          </div>
        ))}
        <i className="spin-marker" aria-hidden />
      </div>
      {seeds.length === 1 && (
        <p className={`spin-name ${landed ? `on r-${seeds[0].rarity}` : ''}`}>
          <b className="r-name">{RARITY_NAME[seeds[0].rarity][lang]}</b> · {plantName(seeds[0], lang)}
        </p>
      )}
      <div className="action-row">
        <button
          className="btn ghost"
          aria-pressed={!muted}
          title={muted ? t.farmSoundOn : t.farmSoundOff}
          onClick={() => {
            localStorage.setItem(MUTE_KEY, muted ? '0' : '1');
            setMuted(!muted);
          }}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button className="btn ghost" onClick={onDone}>
          ⏭ {t.farmSkip}
        </button>
      </div>
    </div>
  );
}

/** Seeds grouped by kind, best first. */
function SeedBag({ seeds, lang, onPick, big = false }: { seeds: Seed[]; lang: Lang; onPick?: (s: Seed) => void; big?: boolean }) {
  const { t } = useT();
  const groups = useMemo(() => {
    const m = new Map<string, Seed[]>();
    for (const s of seeds) {
      const k = `${s.rarity}|${s.species}|${s.color}`;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.values()].sort((a, b) => rank(b[0].rarity) - rank(a[0].rarity) || a[0].species.localeCompare(b[0].species));
  }, [seeds]);
  return (
    <div className="seed-bag">
      {!big && (
        <div className="ctx-label">
          🎒 {t.farmBag} · {seeds.length} {onPick ? `· ${t.farmTapToPlant}` : seeds.length ? `· ${t.farmFieldFull}` : ''}
        </div>
      )}
      {!groups.length && <p className="muted small">{t.farmBagEmpty}</p>}
      <div className={`seed-grid ${big ? 'big' : ''}`}>
        {groups.map((g) => {
          const s = g[0];
          return (
            <button key={s.id} className={`seed r-${s.rarity}`} disabled={!onPick} onClick={() => onPick?.(s)} title={`${RARITY_NAME[s.rarity][lang]} · ${plantName(s, lang)}`}>
              <SeedPacket species={s.species} color={s.color} rarity={s.rarity} size={big ? 48 : 36} />
              {g.length > 1 && <span className="count">×{g.length}</span>}
              {big && <span className="tiny">{plantName(s, lang)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Potted({ crop, size }: { crop: Crop; size: number }) {
  return (
    <span className={`potted r-${crop.rarity} ${crop.mutated ? 'mut' : ''}`} style={{ width: size }}>
      <PlantSprite species={crop.species} color={crop.color} size={size} className="sway" />
      <span className="pot" />
    </span>
  );
}

/** The showcase, or the storehouse: plants on shelves, best first. */
function Showcase({ crops, empty, lang, onOpen }: { crops: Crop[]; empty: string; lang: Lang; onOpen: (c: Crop) => void }) {
  const { t } = useT();
  const sorted = useMemo(() => [...crops].sort((a, b) => rank(b.rarity) - rank(a.rarity) || b.harvestedAt - a.harvestedAt), [crops]);
  if (!sorted.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="showcase">
      {sorted.map((c) => (
        <button key={c.id} className={`shelf r-${c.rarity}`} onClick={() => onOpen(c)} title={`${RARITY_NAME[c.rarity][lang]} · ${plantName(c, lang)}`}>
          <Potted crop={c} size={52} />
        </button>
      ))}
    </div>
  );
}

/** Which species and colors you have grown so far. */
function Dex({ crops, lang }: { crops: Crop[]; lang: Lang }) {
  const { t } = useT();
  const total = SPECIES.reduce((n, s) => n + colorsFor(s.rarity).length, 0);
  const found = new Set(crops.map((c) => `${c.species}|${c.color}`));
  return (
    <>
      <p className="muted small">{fmt(t.farmDexProgress, { n: found.size, total })}</p>
      <div className="dex">
        {SPECIES.map((s) => {
          const colors = colorsFor(s.rarity);
          const got = colors.filter((c) => found.has(`${s.id}|${c}`));
          return (
            <div key={s.id} className={`dex-item r-${s.rarity} ${got.length ? '' : 'unknown'}`}>
              <PlantSprite species={s.id} color={got[0] ?? 'white'} size={48} />
              <b className="small">{got.length ? s[lang] : '???'}</b>
              <span className="r-name tiny">{RARITY_NAME[s.rarity][lang]}</span>
              <span className="dex-grow tiny muted" title={t.farmGrowTime}>
                ⏱ {growLabel(s.grow, lang)}
              </span>
              <span className="dex-colors">
                {colors.map((c) => (
                  <i key={c} className={found.has(`${s.id}|${c}`) ? 'on' : ''} style={{ background: colorSwatch(c) }} title={COLOR_NAME[c][lang]} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Modal({ children, onClose, label }: { children: React.ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal farm-modal" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}
