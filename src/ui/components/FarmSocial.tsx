import { useEffect, useMemo, useState } from 'react';
import { RARITIES, stageOf, type FarmView, type Rarity } from '../../shared/farm';
import { WATER_MINUTES, farmLink, publicFarm, type FarmProfile, type FarmSocialView, type FriendFarm, type PublicFarm, type Visitor } from '../../shared/farmSocial';
import { farmCardSvg } from '../../shared/farmCard';
import { api } from '../api';
import { demoPublicFarm, isDemo } from '../demo';
import { fmt, useT } from '../i18n';
import { fmtTokens, relTime } from '../format';
import { PlantSprite } from './FarmArt';

/**
 * The farm's social side: your farmer profile and share link / card, friends'
 * farms (with a leaderboard and watering), and who visited yours.
 */
export function FarmSocialSection({ farm }: { farm: FarmView }) {
  const { t } = useT();
  const [tab, setTab] = useState<'me' | 'friends' | 'visitors'>('me');
  const [social, setSocial] = useState<FarmSocialView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.farmSocial().then(setSocial, (e) => setError((e as Error).message));
  }, []);
  if (!social) return error ? <p className="action-msg small">{error}</p> : null;
  return (
    <section className="card farm-social">
      <header className="card-head">
        <h2>🤝 {t.socialTitle}</h2>
        <div className="seg" role="tablist">
          {(['me', 'friends', 'visitors'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {k === 'me' ? `👤 ${t.socialMe}` : k === 'friends' ? `👥 ${t.socialFriends} ${social.friends.length || ''}` : `👣 ${t.socialVisitors} ${social.visitors.length || ''}`}
            </button>
          ))}
        </div>
      </header>
      {tab === 'me' ? <MyFarm farm={farm} social={social} onChange={setSocial} /> : tab === 'friends' ? <Friends farm={farm} social={social} /> : <Visitors visitors={social.visitors} />}
    </section>
  );
}

/** The link others open: the public URL when there is one, else how this page was reached. */
function shareBase(social: FarmSocialView): string {
  return social.publicUrl ?? `${location.origin}${location.pathname}`;
}

function MyFarm({ farm, social, onChange }: { farm: FarmView; social: FarmSocialView; onChange: (s: FarmSocialView) => void }) {
  const { t, lang } = useT();
  const [p, setP] = useState<FarmProfile>(social.profile);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');
  const save = async (body: { profile?: FarmProfile; public?: boolean }) => {
    setMsg('');
    try {
      const s = await api.farmSocialUpdate(body);
      onChange(s);
      setP(s.profile);
      if (body.profile) setMsg(t.socialSaved);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const base = shareBase(social);
  const link = social.public && social.shareId ? farmLink(base, social.shareId) : undefined;
  const card = useMemo(() => publicFarm(social.shareId ?? 'preview', social.profile, farm, { waterToday: 0, visitors: [] }), [social, farm]);
  const text = fmt(t.socialShareText, { plants: card.crops, score: card.score, dex: `${card.dex.found}/${card.dex.total}`, tokens: fmtTokens(card.earnedTokens) });
  const badge =
    link && social.shareId ? `[![${social.profile.name}'s crab farm](${base.replace(/\/?$/, '/')}api/public/farm/${social.shareId}/card.svg${lang === 'zh' ? '?lang=zh' : ''})](${link})` : undefined;
  const copy = async (what: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt(t.socialCopy, value);
    }
  };
  const field = (k: keyof FarmProfile, label: string, ph = '') => (
    <label>
      <span className="muted tiny">{label}</span>
      <input value={p[k] ?? ''} placeholder={ph} onChange={(e) => setP({ ...p, [k]: e.target.value })} spellCheck={false} />
    </label>
  );
  return (
    <div className="social-me">
      <div className="social-profile">
        <Avatar github={p.github} size={56} />
        <form
          className="social-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ profile: p });
          }}
        >
          {field('name', t.socialName)}
          {field('bio', t.socialBio)}
          {field('github', t.socialGithub, 'octocat')}
          {field('linkedin', t.socialLinkedin, 'linkedin.com/in/…')}
          {field('x', t.socialX, '@…')}
          {field('website', t.socialWebsite, 'https://…')}
          <div className="social-form-foot">
            <ProfileLinks profile={social.profile} />
            <button className="btn primary">{t.socialSave}</button>
          </div>
        </form>
      </div>
      {msg && <p className="action-msg small">{msg}</p>}

      <div className="social-share">
        <label className="switch">
          <input type="checkbox" checked={social.public} onChange={(e) => void save({ public: e.target.checked })} />
          {t.socialPublic}
        </label>
        <p className="muted tiny">{fmt(t.socialPublicHelp, { m: WATER_MINUTES })}</p>
        {link && (
          <>
            <div className="social-link">
              <span className="muted tiny">{t.socialLink}</span>
              <code className="mono">{link}</code>
              <button className="btn ghost" onClick={() => void copy('link', link)}>
                {copied === 'link' ? `✓ ${t.socialCopied}` : t.socialCopy}
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  if (window.confirm(t.socialRotateAsk)) void api.farmSocialRotate().then(onChange);
                }}
              >
                ↻ {t.socialRotate}
              </button>
            </div>
            {!social.publicUrl && <p className="muted tiny">⚠ {t.socialNoPublicUrl}</p>}
          </>
        )}
        <div className="social-card-preview" dangerouslySetInnerHTML={{ __html: farmCardSvg(card, lang) }} />
        <div className="action-row">
          <button className="btn primary" onClick={() => void shareCard(card, lang, text, link)}>
            📤 {t.socialShareCard}
          </button>
          <button className="btn ghost" onClick={() => void downloadCard(card, lang)}>
            ⬇ {t.socialDownload}
          </button>
          <a className="btn ghost" href={`https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(link ? `${text}\n${link}` : text)}`} target="_blank" rel="noopener noreferrer">
            in {t.socialLinkedinPost}
          </a>
          <a className="btn ghost" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}${link ? `&url=${encodeURIComponent(link)}` : ''}`} target="_blank" rel="noopener noreferrer">
            𝕏 {t.socialXPost}
          </a>
        </div>
        <div className="social-readme">
          <span className="muted tiny">
            <b>{t.socialReadme}</b> · {badge ? t.socialReadmeHelp : t.socialReadmeOff}
          </span>
          {badge && (
            <div className="social-link">
              <code className="mono">{badge}</code>
              <button className="btn ghost" onClick={() => void copy('badge', badge)}>
                {copied === 'badge' ? `✓ ${t.socialCopied}` : t.socialCopy}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Friends({ farm, social }: { farm: FarmView; social: FarmSocialView }) {
  const { t, lang } = useT();
  const [list, setList] = useState<FriendFarm[] | null>(null);
  const [link, setLink] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (key: string, f: () => Promise<void>) => {
    setBusy(key);
    setMsg('');
    try {
      await f();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  useEffect(() => {
    void run('load', async () => setList(await api.farmFriends()));
  }, []);
  // you, on the same board
  const me: FriendFarm = { url: '', farm: publicFarm(social.shareId ?? 'me', social.profile, farm, { waterToday: 0, visitors: [] }) };
  const board = [...(list ?? []), me].sort((a, b) => (b.farm?.score ?? -1) - (a.farm?.score ?? -1));
  return (
    <div className="social-friends">
      <form
        className="social-add"
        onSubmit={(e) => {
          e.preventDefault();
          void run('add', async () => {
            setList(await api.farmFriendAdd(link.trim()));
            setLink('');
          });
        }}
      >
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t.socialAddFriend} aria-label={t.socialAddFriend} spellCheck={false} />
        <button className="btn primary" disabled={!link.trim() || !!busy}>
          + {t.socialAdd}
        </button>
      </form>
      {msg && <p className="action-msg small">{msg}</p>}
      {list === null ? (
        <div className="loading small">
          <div className="spinner" aria-hidden />
        </div>
      ) : (
        <>
          {!list.length && <p className="muted small">{t.socialNoFriends}</p>}
          <ol className="board">
            {board.map((f, i) => (
              <li key={f.url || 'me'} className={`board-row ${f.url ? '' : 'me'}`} style={{ animationDelay: `${i * 40}ms` }}>
                <span className="board-rank">{f.farm ? i + 1 : '–'}</span>
                <Avatar github={f.farm?.profile.github} size={36} />
                <div className="board-who">
                  <b>
                    {f.farm?.profile.name ?? new URL(f.url).host} {!f.url && <span className="muted">{t.socialYou}</span>}
                  </b>
                  {f.farm ? <ProfileLinks profile={f.farm.profile} /> : <span className="muted tiny">{t.socialUnreachable}</span>}
                </div>
                {f.farm && (
                  <>
                    <div className="board-plants" aria-hidden>
                      {f.farm.best.slice(0, 5).map((c, k) => (
                        <span key={k} className={`board-plant r-${c.rarity}`} title={c.species}>
                          <PlantSprite species={c.species} color={c.color} size={26} />
                        </span>
                      ))}
                    </div>
                    <div className="board-stats">
                      <b>{f.farm.score}</b>
                      <span className="muted tiny">
                        {t.socialScore} · {f.farm.crops} {t.socialPlants}
                        {f.farm.field.length ? ` · ${f.farm.field.length} ${t.socialGrowing}` : ''}
                      </span>
                    </div>
                  </>
                )}
                {f.url && (
                  <div className="board-actions">
                    {f.farm && f.farm.field.some((x) => x.readyAt > Date.now()) && (
                      <button
                        className="btn ghost"
                        disabled={!!busy}
                        onClick={() =>
                          void run(f.url, async () => {
                            const r = await api.farmFriendWater(f.url);
                            setList((l) => (l ?? []).map((x) => (x.url === f.url ? r.friend : x)));
                            setMsg(fmt(t.socialWatered, { m: WATER_MINUTES }));
                          })
                        }
                      >
                        💧 {busy === f.url ? '…' : t.socialWater}
                      </button>
                    )}
                    <a className="btn ghost" href={f.url} target="_blank" rel="noopener noreferrer">
                      ↗ {t.socialVisit}
                    </a>
                    <button
                      className="btn ghost"
                      title={t.socialRemove}
                      aria-label={t.socialRemove}
                      onClick={() => window.confirm(t.socialRemoveAsk) && void run('rm', async () => setList(await api.farmFriendRemove(f.url)))}
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="muted tiny">
        {lang === 'zh' ? '分数：普通 1 · 优良 2 · 稀有 5 · 史诗 12 · 传说 30 · 神话 100，变异 +1' : 'Score: common 1 · fine 2 · rare 5 · epic 12 · legendary 30 · mythic 100, +1 if mutated'}
      </p>
    </div>
  );
}

function Visitors({ visitors }: { visitors: Visitor[] }) {
  const { t, lang } = useT();
  if (!visitors.length) return <p className="muted small">{t.socialNoVisitors}</p>;
  return (
    <ul className="visitors">
      {visitors.map((v, i) => (
        <li key={i}>
          <Avatar github={v.github} size={28} />
          <b>{v.name}</b>
          {v.github && (
            <a className="muted tiny" href={`https://github.com/${v.github}`} target="_blank" rel="noopener noreferrer">
              @{v.github}
            </a>
          )}
          <span className="muted tiny">💧 {relTime(new Date(v.at).toISOString(), t, lang)}</span>
          {v.farm && (
            <a className="link small" href={v.farm} target="_blank" rel="noopener noreferrer">
              {t.socialVisitBack} ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Avatar({ github, size }: { github?: string; size: number }) {
  const [broken, setBroken] = useState(false);
  if (!github || broken || isDemo())
    return (
      <span className="avatar crab" style={{ width: size, height: size }} aria-hidden>
        <img src="./icon.svg" alt="" width={size * 0.7} height={size * 0.7} />
      </span>
    );
  return <img className="avatar" src={`https://github.com/${encodeURIComponent(github)}.png?size=${size * 2}`} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} />;
}

export function ProfileLinks({ profile }: { profile: FarmProfile }) {
  const links = [
    profile.github && { href: `https://github.com/${profile.github}`, label: 'GitHub', icon: <GithubMark /> },
    profile.linkedin && { href: profile.linkedin, label: 'LinkedIn', icon: <b className="li">in</b> },
    profile.x && { href: `https://x.com/${profile.x}`, label: 'X', icon: <b>𝕏</b> },
    profile.website && { href: profile.website, label: profile.website, icon: <span>🔗</span> },
  ].filter(Boolean) as { href: string; label: string; icon: React.ReactNode }[];
  if (!links.length) return null;
  return (
    <span className="profile-links">
      {links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer me" title={l.label} aria-label={l.label}>
          {l.icon}
        </a>
      ))}
    </span>
  );
}

function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// ── the share card as a picture ──────────────────────────────────────────────
async function cardBlob(card: PublicFarm, lang: 'zh' | 'en'): Promise<Blob> {
  const svg = farmCardSvg(card, lang);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = img.width * scale;
  c.height = img.height * scale;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not draw the card'))), 'image/png'));
}

async function downloadCard(card: PublicFarm, lang: 'zh' | 'en') {
  const url = URL.createObjectURL(await cardBlob(card, lang));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'vibeportal-farm.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** The phone's share sheet with the picture (LinkedIn, WeChat, …), else a download. */
async function shareCard(card: PublicFarm, lang: 'zh' | 'en', text: string, link?: string) {
  const file = new File([await cardBlob(card, lang)], 'vibeportal-farm.png', { type: 'image/png' });
  const data: ShareData = { files: [file], text, ...(link ? { url: link } : {}) };
  if (navigator.canShare?.(data)) {
    await navigator.share(data).catch(() => {});
    return;
  }
  await downloadCard(card, lang);
}

// ── someone else's farm, opened from its share link (no sign-in) ──────────────
export function FarmVisit({ id }: { id: string }) {
  const { t, lang, setLang } = useT();
  const [farm, setFarm] = useState<PublicFarm | null | undefined>(undefined);
  const [who, setWho] = useState(() => readVisitor());
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    isDemo()
      ? Promise.resolve(setFarm(demoPublicFarm()))
      : fetch(`api/public/farm/${id}`, { headers: { 'ngrok-skip-browser-warning': '1' } })
          .then((r) => (r.ok ? r.json() : null))
          .then(setFarm, () => setFarm(null));
  useEffect(() => {
    void load();
  }, [id]);
  useEffect(() => {
    if (farm) document.title = fmt(t.visitTitle, { name: farm.profile.name });
  }, [farm, t]);
  const water = async () => {
    setBusy(true);
    setMsg('');
    try {
      saveVisitor(who);
      const r = await fetch(`api/public/farm/${id}/water`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' }, body: JSON.stringify(who) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setMsg(fmt(t.visitThanks, { n: d.plants, m: d.minutes }));
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const langBtn = (
    <button className="btn ghost visit-lang" onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
      {lang === 'zh' ? 'EN' : '中'}
    </button>
  );
  if (farm === undefined)
    return (
      <div className="farm visit">
        <div className="loading">
          <div className="spinner" aria-hidden />
        </div>
      </div>
    );
  if (!farm)
    return (
      <div className="farm visit">
        {langBtn}
        <section className="card visit-none">
          <h2>🦀</h2>
          <p>{t.visitNone}</p>
          <GetOwn />
        </section>
      </div>
    );
  const now = Date.now();
  const skew = now - farm.now;
  return (
    <div className="farm visit">
      {langBtn}
      <section className="card visit-head">
        <Avatar github={farm.profile.github} size={72} />
        <div>
          <h1>{fmt(t.visitTitle, { name: farm.profile.name })}</h1>
          {farm.profile.bio && <p className="muted">{farm.profile.bio}</p>}
          <ProfileLinks profile={farm.profile} />
        </div>
        <div className="visit-stats">
          <span>
            <b>{farm.score}</b> <span className="muted tiny">{t.socialScore}</span>
          </span>
          <span>
            <b>{farm.crops}</b> <span className="muted tiny">{t.socialPlants}</span>
          </span>
          <span>
            <b>
              {farm.dex.found}/{farm.dex.total}
            </b>{' '}
            <span className="muted tiny">{t.farmDex}</span>
          </span>
          <span>
            <b>{fmtTokens(farm.earnedTokens)}</b> <span className="muted tiny">tokens</span>
          </span>
        </div>
      </section>

      <section className="card">
        <h2>{t.visitShowcase}</h2>
        <div className="visit-best">
          {farm.best.length ? (
            farm.best.map((c, i) => (
              <span key={i} className={`shelf r-${c.rarity}`} title={`${rarityLabel(c.rarity, lang)} · ${c.species}`}>
                <span className={`potted r-${c.rarity} ${c.mutated ? 'mut' : ''}`} style={{ width: 52 }}>
                  <PlantSprite species={c.species} color={c.color} size={52} className="sway" />
                  <span className="pot" />
                </span>
              </span>
            ))
          ) : (
            <p className="muted small">{t.farmShowcaseEmpty}</p>
          )}
        </div>
      </section>

      <section className="card">
        <h2>{t.visitField}</h2>
        <div className="farm-field visit-field">
          {Array.from({ length: 9 }, (_, i) => farm.field[i]).map((p, i) => {
            const stage = p ? stageOf({ plantedAt: p.plantedAt, readyAt: p.readyAt }, now - skew) : 0;
            return (
              <span key={i} className={`plot ${p ? `r-${p.rarity}` : 'empty'} ${p && stage === 3 ? 'ripe' : ''}`}>
                {p && <PlantSprite species={p.species} color={p.color} stage={stage} size={56} className={stage === 3 ? 'sway' : ''} />}
              </span>
            );
          })}
        </div>
        <div className="visit-water">
          <h3>💧 {t.visitWaterTitle}</h3>
          <p className="muted tiny">
            {fmt(t.visitWaterHelp, { m: WATER_MINUTES })} {fmt(t.visitWaters, { n: farm.waters.today, max: farm.waters.max })}
          </p>
          <form
            className="visit-form"
            onSubmit={(e) => {
              e.preventDefault();
              void water();
            }}
          >
            <input value={who.name} onChange={(e) => setWho({ ...who, name: e.target.value })} placeholder={t.visitYourName} aria-label={t.visitYourName} maxLength={40} />
            <input value={who.github} onChange={(e) => setWho({ ...who, github: e.target.value })} placeholder={t.visitYourGithub} aria-label={t.visitYourGithub} spellCheck={false} />
            <input value={who.farm} onChange={(e) => setWho({ ...who, farm: e.target.value })} placeholder={t.visitYourFarm} aria-label={t.visitYourFarm} spellCheck={false} />
            <button className="btn primary" disabled={busy || !who.name.trim() || !farm.field.some((x) => x.readyAt - skew > now)}>
              💧 {t.socialWater}
            </button>
          </form>
          {msg && <p className="action-msg small">{msg}</p>}
        </div>
      </section>

      {farm.visitors.length > 0 && (
        <section className="card">
          <h2>👣 {t.socialVisitors}</h2>
          <Visitors visitors={farm.visitors} />
        </section>
      )}
      <GetOwn />
    </div>
  );
}

function GetOwn() {
  const { t } = useT();
  return (
    <p className="visit-own muted small">
      <a href="https://github.com/CNStanLee/VibePortal" target="_blank" rel="noopener noreferrer">
        🦀 {t.visitGetOwn} ↗
      </a>
    </p>
  );
}

const rarityLabel = (r: Rarity, lang: 'zh' | 'en') =>
  (lang === 'zh' ? ['普通', '优良', '稀有', '史诗', '传说', '神话'] : ['Common', 'Fine', 'Rare', 'Epic', 'Legendary', 'Mythic'])[RARITIES.indexOf(r)];

const VISITOR_KEY = 'vp.visitor';
function readVisitor(): { name: string; github: string; farm: string } {
  try {
    const v = JSON.parse(localStorage.getItem(VISITOR_KEY) ?? '{}');
    return { name: String(v.name ?? ''), github: String(v.github ?? ''), farm: String(v.farm ?? '') };
  } catch {
    return { name: '', github: '', farm: '' };
  }
}
function saveVisitor(v: { name: string; github: string; farm: string }) {
  try {
    localStorage.setItem(VISITOR_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}
