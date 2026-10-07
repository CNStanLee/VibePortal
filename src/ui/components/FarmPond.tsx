import { useEffect, useRef, useState } from 'react';
import type { FarmView, Rarity } from '../../shared/farm';
import { AD_REWARD, HOUSE_ADS, adOf } from '../../shared/farmAds';
import { BAIT_PACK, BAIT_PRICE, FISH, RODS, fishKind, fishPrice, rodOf, type Fish, type FishShape } from '../../shared/farmPond';
import type { FarmAction } from '../api';
import { fmt, useT } from '../i18n';
import { fmtTokens } from '../format';
import { Mascot } from './Mascots';

type Lang = 'zh' | 'en';
type Act = <R>(action: FarmAction, body: Record<string, unknown>) => Promise<R | undefined>;
const RARITY_ORDER: Rarity[] = ['common', 'fine', 'rare', 'epic', 'legendary', 'mythic'];

/** One fish, drawn flat: body, belly, fins, tail and an eye (the king crab is a crab). */
export function FishSprite({ species, size = 48, dim = false }: { species: string; size?: number; dim?: boolean }) {
  const k = fishKind(species);
  const fill = dim ? 'var(--axis)' : k.color;
  const body: Record<Exclude<FishShape, 'crab'>, { rx: number; ry: number }> = { slim: { rx: 13, ry: 6 }, long: { rx: 16, ry: 3.6 }, round: { rx: 10, ry: 8 } };
  if (k.shape === 'crab')
    return (
      <svg className="fish" width={size} height={size / 2} viewBox="0 0 40 20" aria-hidden>
        <ellipse cx="20" cy="12" rx="10" ry="6" fill={fill} />
        <circle cx="7" cy="7" r="4" fill={fill} />
        <circle cx="33" cy="7" r="4" fill={fill} />
        <path d="M11 15 L5 19 M14 17 L10 20 M29 15 L35 19 M26 17 L30 20" stroke={fill} strokeWidth="1.6" strokeLinecap="round" />
        {!dim && (
          <>
            <circle cx="17" cy="9" r="1.5" fill="#fff" />
            <circle cx="23" cy="9" r="1.5" fill="#fff" />
            <circle cx="17" cy="9" r="0.7" fill="#222" />
            <circle cx="23" cy="9" r="0.7" fill="#222" />
          </>
        )}
      </svg>
    );
  const { rx, ry } = body[k.shape];
  const cx = 18;
  const tail = cx + rx - 2;
  return (
    <svg className="fish" width={size} height={size / 2} viewBox="0 0 40 20" aria-hidden>
      <path d={`M${tail} 10 L39 ${10 - ry - 1} L37 10 L39 ${10 + ry + 1} Z`} fill={fill} />
      <path d={`M${cx - 3} ${10 - ry + 0.5} Q${cx + 2} ${10 - ry - 4} ${cx + 6} ${10 - ry + 1}`} fill={fill} />
      <ellipse cx={cx} cy="10" rx={rx} ry={ry} fill={fill} />
      {!dim && <ellipse cx={cx + 1} cy={10 + ry * 0.35} rx={rx * 0.75} ry={ry * 0.45} fill="#fff" opacity="0.25" />}
      {!dim && (
        <>
          <circle cx={cx - rx + 4} cy={10 - ry * 0.25} r="1.6" fill="#fff" />
          <circle cx={cx - rx + 4} cy={10 - ry * 0.25} r="0.8" fill="#222" />
        </>
      )}
    </svg>
  );
}

const fishName = (f: { species: string }, lang: Lang) => fishKind(f.species)[lang];

/**
 * The pond: cast, wait for the float to dip, reel in before the fish lets go. The
 * catch goes in the creel and sells for tokens; the shop sells better rods and bait.
 */
export function PondSection({ farm, act, busy, rarityName }: { farm: FarmView; act: Act; busy: boolean; rarityName: (r: Rarity) => string }) {
  const { t, lang } = useT();
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'bite' | 'reeling'>('idle');
  const [line, setLine] = useState<{ id: string; biteIn: number; window: number } | null>(null);
  const [outcome, setOutcome] = useState<{ kind: 'caught'; fish: Fish } | { kind: 'early' | 'late' } | null>(null);
  const [tab, setTab] = useState<'creel' | 'shop' | 'dex'>('creel');
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clear, []);

  const reelIn = async (l = line) => {
    if (!l) return;
    clear();
    setPhase('reeling');
    const r = await act<{ result: 'caught'; fish: Fish } | { result: 'early' | 'late' }>('reel', { castId: l.id });
    setLine(null);
    setPhase('idle');
    if (r) setOutcome(r.result === 'caught' ? { kind: 'caught', fish: r.fish } : { kind: r.result });
  };
  const castLine = async () => {
    setOutcome(null);
    const r = await act<{ id: string; biteIn: number; window: number }>('cast', {});
    if (!r) return;
    setLine(r);
    setPhase('waiting');
    clear();
    timers.current.push(
      window.setTimeout(() => {
        setPhase('bite');
        navigator.vibrate?.([60, 40, 60]);
      }, r.biteIn),
      // nobody reeled in: the fish lets go
      window.setTimeout(() => void reelIn(r), r.biteIn + r.window + 1200),
    );
  };

  const rod = rodOf(farm.rod);
  const creelValue = farm.fish.reduce((n, f) => n + fishPrice(f), 0);
  const noBait = farm.freeBaitLeft === 0 && farm.bait === 0;
  const sorted = [...farm.fish].sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || fishPrice(b) - fishPrice(a));
  const rareOdds = (r: (typeof RODS)[number]) => RARITY_ORDER.slice(2).reduce((n, q) => n + r.odds[q], 0);

  return (
    <section className="card farm-pond-card" aria-labelledby="h-pond">
      <header className="card-head">
        <h2 id="h-pond">🎣 {t.pondTitle}</h2>
        <span className="muted small">
          {rod[lang]} · 🪱 {fmt(t.pondBait, { n: farm.bait })} · {fmt(t.pondFree, { n: farm.freeBaitLeft })} · {fmt(t.pondCastsLeft, { n: farm.castsLeft })}
        </span>
      </header>
      <div className={`pond pond-${phase}`}>
        <div className="pond-bank" aria-hidden>
          <Mascot kind="crab" mood={phase === 'bite' ? 'alert' : outcome?.kind === 'caught' ? 'happy' : phase === 'waiting' ? 'working' : 'idle'} size={40} />
        </div>
        <svg className="pond-line" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden>
          {phase !== 'idle' && <path d="M14 18 Q40 8 62 34" />}
        </svg>
        {phase !== 'idle' && (
          <span className="pond-float" aria-hidden>
            {phase === 'bite' && <b className="pond-bang">!</b>}
          </span>
        )}
        <i className="pond-ripple r1" aria-hidden />
        <i className="pond-ripple r2" aria-hidden />
        {outcome?.kind === 'caught' && (
          <div className={`pond-catch r-${outcome.fish.rarity}`} key={outcome.fish.id}>
            <FishSprite species={outcome.fish.species} size={88} />
            <b className="r-name">
              {rarityName(outcome.fish.rarity)} · {fishName(outcome.fish, lang)}
            </b>
            <span className="tiny">
              {outcome.fish.kg} kg · 🪙 {fmtTokens(fishPrice(outcome.fish))}
            </span>
          </div>
        )}
        {outcome && outcome.kind !== 'caught' && <div className="pond-miss small">{outcome.kind === 'early' ? t.pondEarly : t.pondLate}</div>}
        <div className="pond-hint small">{phase === 'waiting' ? t.pondWaiting : phase === 'bite' ? t.pondBite : ''}</div>
      </div>
      <div className="pond-actions">
        {phase === 'idle' || phase === 'reeling' ? (
          <button className="btn primary" disabled={busy || phase === 'reeling' || farm.castsLeft === 0 || noBait} onClick={() => void castLine()}>
            🎣 {t.pondCast}
          </button>
        ) : (
          <button className={`btn ${phase === 'bite' ? 'primary pond-reel' : ''}`} onClick={() => void reelIn()}>
            🪝 {t.pondReel}
          </button>
        )}
        {farm.castsLeft === 0 ? <span className="muted small">{t.pondDone}</span> : noBait && <span className="muted small">{t.pondNoBait}</span>}
      </div>

      <div className="seg pond-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'creel'} onClick={() => setTab('creel')}>
          🧺 {t.pondCreel} <span className="muted">{farm.fish.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'shop'} onClick={() => setTab('shop')}>
          🏪 {t.pondShop}
        </button>
        <button role="tab" aria-selected={tab === 'dex'} onClick={() => setTab('dex')}>
          📖 {t.pondDex} <span className="muted">{Object.keys(farm.caught).length}/{FISH.length}</span>
        </button>
      </div>
      {tab === 'creel' ? (
        <div className="creel">
          {!sorted.length ? (
            <p className="muted small">{t.pondCreelEmpty}</p>
          ) : (
            <>
              <div className="creel-head small">
                <span>{fmt(t.pondCreelValue, { n: fmtTokens(creelValue) })}</span>
                <button className="btn primary" disabled={busy} onClick={() => void act('sell-fish', {})}>
                  💰 {fmt(t.pondSellAll, { n: fmtTokens(creelValue) })}
                </button>
              </div>
              <ul className="creel-list">
                {sorted.map((f) => (
                  <li key={f.id} className={`creel-fish r-${f.rarity}`}>
                    <FishSprite species={f.species} size={44} />
                    <span className="creel-name">
                      <b className="small">{fishName(f, lang)}</b>
                      <span className="tiny muted">
                        <span className="r-name">{rarityName(f.rarity)}</span> · {f.kg} kg
                      </span>
                    </span>
                    <button className="btn ghost" disabled={busy} onClick={() => void act('sell-fish', { ids: [f.id] })}>
                      🪙 {fmtTokens(fishPrice(f))}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : tab === 'shop' ? (
        <div className="farm-shop">
          <p className="muted tiny">{t.pondShopHelp}</p>
          <div className="shop-grid">
            {RODS.map((r) => {
              const owned = farm.rods.includes(r.id);
              const inHand = farm.rod === r.id;
              return (
                <div key={r.id} className={`shop-item ${inHand ? 'on' : ''}`}>
                  <b>🎣 {r[lang]}</b>
                  <span className="tiny muted">
                    {fmt(t.pondRodOdds, { n: +rareOdds(r).toFixed(2) })} · {fmt(t.pondRodBite, { a: r.bite[0], b: r.bite[1], w: r.window })}
                  </span>
                  <button className={`btn ${owned ? 'ghost' : 'primary'}`} disabled={busy || inHand || (!owned && farm.balance < r.price)} onClick={() => void act('rod', { rod: r.id })}>
                    {inHand ? t.pondInHand : owned ? t.pondTakeUp : `🪙 ${fmtTokens(r.price)}`}
                  </button>
                </div>
              );
            })}
            <div className="shop-item">
              <b>🪱 {fmt(t.pondBaitPack, { n: BAIT_PACK })}</b>
              <span className="tiny muted">{fmt(t.pondBaitHelp, { n: farm.bait })}</span>
              <button className="btn primary" disabled={busy || farm.balance < BAIT_PACK * BAIT_PRICE} onClick={() => void act('bait', { packs: 1 })}>
                🪙 {fmtTokens(BAIT_PACK * BAIT_PRICE)}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="fish-dex">
          {FISH.map((k) => {
            const n = farm.caught[k.id] ?? 0;
            return (
              <div key={k.id} className={`dex-item r-${k.rarity} ${n ? '' : 'unknown'}`} title={n ? `${k[lang]} ×${n}` : '???'}>
                <FishSprite species={k.id} size={56} dim={!n} />
                <b className="small">{n ? k[lang] : '???'}</b>
                <span className="r-name tiny">{rarityName(k.rarity)}</span>
                <span className="tiny muted">{n ? `×${n}` : `${k.kg[0]}–${k.kg[1]} kg`}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** A sponsored strip on the farm (VibePortal's own ads), changing now and then. */
export function AdBanner() {
  const { t, lang } = useT();
  const [i, setI] = useState(() => Math.floor(Math.random() * HOUSE_ADS.length));
  useEffect(() => {
    const id = window.setInterval(() => setI((x) => (x + 1) % HOUSE_ADS.length), 20_000);
    return () => clearInterval(id);
  }, []);
  const ad = HOUSE_ADS[i];
  const external = ad.href.startsWith('http');
  return (
    <a className="farm-ad-banner" href={ad.href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      <span className="ad-tag tiny">{t.adTag}</span>
      <span className="ad-icon" aria-hidden>
        {ad.icon}
      </span>
      <span className="ad-text">
        <b className="small">{ad[lang].title}</b>
        <span className="tiny muted">{ad[lang].body}</span>
      </span>
      <span className="ad-cta small">{ad[lang].cta} →</span>
    </a>
  );
}

/**
 * An ad you watch for tokens: it plays for its seconds (the clock stops while the
 * page is hidden), then the reward can be collected.
 */
export function AdPlayer({ ad, seconds, onClaim, onClose, busy }: { ad: string; seconds: number; onClaim: () => void; onClose: () => void; busy: boolean }) {
  const { t, lang } = useT();
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setLeft((x) => Math.max(0, x - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const a = adOf(ad);
  const external = a.href.startsWith('http');
  const done = left === 0;
  return (
    <div className="ad-player">
      <div className="ad-player-top tiny">
        <span className="ad-tag">{t.adTag}</span>
        <span className="muted">{done ? t.adDone : fmt(t.adLeft, { n: left })}</span>
      </div>
      <div className="ad-stage">
        <span className="ad-stage-icon" aria-hidden>
          {a.icon}
        </span>
        <h3>{a[lang].title}</h3>
        <p className="small">{a[lang].body}</p>
        <a className="btn" href={a.href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : { onClick: onClose })}>
          {a[lang].cta} →
        </a>
      </div>
      <div className="ad-progress" aria-hidden>
        <span style={{ width: `${(100 * (seconds - left)) / seconds}%` }} />
      </div>
      <div className="action-row">
        <button className="btn ghost" onClick={onClose}>
          {done ? t.close : t.adQuit}
        </button>
        <button className="btn primary" disabled={!done || busy} onClick={onClaim}>
          🪙 {fmt(t.adClaim, { n: fmtTokens(AD_REWARD) })}
        </button>
      </div>
    </div>
  );
}
