/*
 * The farm's share card, as a self-contained SVG (no fonts or images to fetch):
 * served live for a GitHub profile README, and turned into a PNG in the browser
 * for sharing on LinkedIn, X or anywhere else.
 */
import type { Rarity } from './farm';
import { plantPixels, RAINBOW } from './farmArt';
import type { PublicFarm } from './farmSocial';

const RARITY_COLOR: Record<Rarity, string> = {
  common: '#9aa3b5',
  fine: '#4caf50',
  rare: '#4a90f0',
  epic: '#9b6cf0',
  legendary: '#f0b429',
  mythic: 'url(#aurora)',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

/** A plant's pixels as rects, merging runs of one color along a row (fewer elements). */
function plantRects(species: string, color: PublicFarm['best'][number]['color']): string {
  const px = plantPixels(species, color);
  let out = '';
  for (let i = 0; i < px.length;) {
    let j = i + 1;
    while (j < px.length && px[j].y === px[i].y && px[j].x === px[j - 1].x + 1 && px[j].fill === px[i].fill) j++;
    out += `<rect x="${px[i].x}" y="${px[i].y}" width="${j - i + 0.02}" height="1.02" fill="${px[i].fill}"/>`;
    i = j;
  }
  return out;
}

export function farmCardSvg(f: PublicFarm, lang: 'zh' | 'en' = 'en'): string {
  const W = 495;
  const H = 200;
  const L =
    lang === 'zh'
      ? { title: '的螃蟹农场', score: '分数', plants: '植物', dex: '图鉴', tokens: 'Tokens', empty: '还在等第一株植物…' }
      : { title: '’s crab farm', score: 'Score', plants: 'Plants', dex: 'Dex', tokens: 'Tokens', empty: 'Waiting for the first plant…' };
  const name = esc(f.profile.name.slice(0, 28));
  const handles = [f.profile.github && `github.com/${f.profile.github}`, f.profile.linkedin && f.profile.linkedin.replace(/^https:\/\/www\./, ''), f.profile.x && `@${f.profile.x}`]
    .filter(Boolean)
    .map((s) => esc(s as string))
    .join('  ·  ');
  const stats = [
    [L.score, String(f.score)],
    [L.plants, String(f.crops)],
    [L.dex, `${f.dex.found}/${f.dex.total}`],
    [L.tokens, compact(f.earnedTokens)],
  ];
  const best = f.best.slice(0, 8);
  const size = 44;
  const gap = (W - 40 - best.length * size) / Math.max(1, best.length - 1);
  const plants = best
    .map((c, i) => {
      const x = 20 + i * (size + Math.min(gap, 16));
      return `<g transform="translate(${x.toFixed(1)} 108)"><g transform="scale(${size / 16})" shape-rendering="crispEdges">${plantRects(c.species, c.color)}</g><rect x="4" y="${size + 3}" width="${size - 8}" height="3" rx="1.5" fill="${RARITY_COLOR[c.rarity]}"/></g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${name}${esc(L.title)}">
<defs><linearGradient id="aurora" x1="0" x2="1">${RAINBOW.map((c, i) => `<stop offset="${(i / (RAINBOW.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')}</linearGradient></defs>
<style>
.bg{fill:#fcfbf8;stroke:#e4e2dc}.t{fill:#1f1d1a;font:700 18px system-ui,-apple-system,'Segoe UI',sans-serif}.s{fill:#7d7a73;font:500 11px system-ui,-apple-system,'Segoe UI',sans-serif}.v{fill:#1f1d1a;font:700 16px system-ui,-apple-system,'Segoe UI',sans-serif}.k{fill:#7d7a73;font:500 10px system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.04em;text-transform:uppercase}.e{fill:#7d7a73;font:italic 12px system-ui,sans-serif}
@media (prefers-color-scheme: dark){.bg{fill:#161b22;stroke:#30363d}.t,.v{fill:#e6edf3}.s,.k,.e{fill:#8b949e}}
</style>
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12"/>
<text class="t" x="20" y="34">🦀 ${name}${esc(L.title)}</text>
<text class="s" x="${W - 20}" y="32" text-anchor="end">VibePortal</text>
${stats.map(([k, v], i) => `<text class="k" x="${20 + i * 116}" y="62">${esc(k)}</text><text class="v" x="${20 + i * 116}" y="82">${esc(v)}</text>`).join('')}
${best.length ? plants : `<text class="e" x="20" y="140">${esc(L.empty)}</text>`}
${handles ? `<text class="s" x="20" y="${H - 14}">${handles}</text>` : ''}
</svg>`;
}
