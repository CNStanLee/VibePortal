import type { Rarity, SeedColor } from '../../shared/farm';

/*
 * Pixel plants for the crab farm, drawn like the crab: 16×16 ASCII maps.
 * a / A / L = the seed's color (base / shade / light); the rest is fixed.
 */

const COLORS: Record<Exclude<SeedColor, 'rainbow'>, string> = {
  red: '#e5484d',
  orange: '#f28c28',
  yellow: '#f5cf3a',
  pink: '#f27fb2',
  purple: '#9b6cf0',
  blue: '#4a90f0',
  white: '#f3f1ea',
  black: '#3b3550',
  gold: '#f0b429',
};
const RAINBOW = ['#e5484d', '#f28c28', '#f5cf3a', '#5bbf5f', '#4a90f0', '#9b6cf0'];

const FIXED: Record<string, string> = {
  g: '#5fae4e', // leaf
  G: '#3e8a3a',
  c: '#6fbf73', // cactus
  C: '#3f8f4f',
  y: '#ffd84d', // flower heart
  Y: '#e0a92e',
  w: '#ffffff',
  b: '#9a6a3c', // wood / stem
  B: '#6b4226',
  T: '#f3ead7', // mushroom stem
  t: '#d8cbb0',
  s: '#d5dae4', // silver
  S: '#9aa3b5',
  r: '#a3a9b8', // rock
  R: '#767d8c',
  k: 'var(--ink-pixel)',
};

const ART: Record<string, string[]> = {
  tulip: [
    '................',
    '................',
    '.....L.aa.a.....',
    '.....LaaaaA.....',
    '.....LaaaaA.....',
    '.....aaaaaA.....',
    '......aaaA......',
    '.......gG.......',
    '.......gG.......',
    '..gg...gG.......',
    '..ggg..gG...gg..',
    '...ggg.gG..ggg..',
    '....ggggG.ggg...',
    '......ggGggg....',
    '.......gG.......',
    '.......gG.......',
  ],
  daisy: [
    '................',
    '......aLa.......',
    '...aa.aLa.aa....',
    '...aLaaLaaLa....',
    '....aaayyaa.....',
    '.aaaaayyyyaaaa..',
    '.aLLaayyyYaLLa..',
    '....aaayYaa.....',
    '...aLaaAaaLa....',
    '...aa.aAa.aa....',
    '.......g........',
    '.......g...gg...',
    '..gg...g..ggg...',
    '..ggg..g.gg.....',
    '....gggggg......',
    '.......g........',
  ],
  mushroom: [
    '................',
    '................',
    '................',
    '......aaaa......',
    '....aaLLaaaa....',
    '...aaLwwaaawa...',
    '..aaaawwaaaaaa..',
    '..aawaaaaawwaa..',
    '.aaaaaaaaawwaaa.',
    '.AAAAAAAAAAAAAA.',
    '......TTTt......',
    '......TTTt......',
    '.....TTTTt......',
    '.....TTTTt......',
    '..g..TTTTt..g...',
    '.gg.gTTTTtg.gg..',
  ],
  sunflower: [
    '.....a.a.a......',
    '....aaaaaaa.....',
    '...aaBBBBBaa....',
    '..aaBbBbBbBaa...',
    '...aBBbBbBBa....',
    '..aaBbBbBbBaa...',
    '...aaBBBBBaa....',
    '....aaaaaaa.....',
    '.....a.g.a......',
    '.......g........',
    '..ggg..g........',
    '.ggGGg.g..ggg...',
    '..gggggg.gGGgg..',
    '.......gggggg...',
    '.......g........',
    '.......g........',
  ],
  cactus: [
    '................',
    '......a.a.......',
    '.....aaLaa......',
    '......aAa.......',
    '......cCc.......',
    '.....ccCcc......',
    '.....cwCcc..cc..',
    '.cc..ccCcw.cCc..',
    '.cCc.ccCcc.cCc..',
    '.cCc.cwCcc.ccc..',
    '.ccccccCcccccc..',
    '..cccccCcccc....',
    '.....ccCcc......',
    '.....cwCcc......',
    '.....ccCcc......',
    '.....ccCcc......',
  ],
  strawberry: [
    '................',
    '................',
    '......g..g......',
    '.....gGggGg.....',
    '....ggGGGGgg....',
    '...aaaggggaaa...',
    '..aaLaaaaaaaaa..',
    '..aLyaaayaaaya..',
    '..aaaaaaaaaaaa..',
    '..aayaaaayaaaA..',
    '...aaaayaaaaA...',
    '...aaaaaaayaA...',
    '....ayaaaaaA....',
    '.....aaaayA.....',
    '......aaAA......',
    '.......AA.......',
  ],
  rose: [
    '................',
    '......aaaa......',
    '....aaLLaaaa....',
    '...aaLaaAaLaa...',
    '...aLaAAaaaAa...',
    '...aaAaaLAaAa...',
    '....aaAAAaaa....',
    '.....aaaaaa.....',
    '......gGgg......',
    '.......gG.......',
    '..gg...gG..gg...',
    '.gGGg..gG.gGGg..',
    '..gggg.gGgggg...',
    '......ggG.......',
    '.......gG.......',
    '.......gG.......',
  ],
  lotus: [
    '................',
    '.......L........',
    '......aLa.......',
    '..a...aLa...a...',
    '..aa.aaLaa.aa...',
    '..aLaaaLaaaLa...',
    '...aLaaLaaLa....',
    '.a..aaaLaaa..a..',
    '.aaa.aaaaa.aaa..',
    '..aaaaayaaaaa...',
    '...aaayyyaaa....',
    '....AAAAAAA.....',
    '..ggggggggggg...',
    '.gGGGGGGGGGGGg..',
    '..ggggggggggg...',
    '................',
  ],
  crystal: [
    '................',
    '.......L........',
    '......LaA.......',
    '..L...LaA...L...',
    '..LA..LaA..LA...',
    '..LaA.LaA.LaA...',
    '..LaA.LaA.LaA...',
    '...LaALaALaA....',
    '...LaALaALaA....',
    '....LaLaALA.....',
    '.....LLaAA......',
    '......sSs.......',
    '..gg..sSs.......',
    '..ggg.sSs..gg...',
    '....ggsSsggg....',
    '......sSs.......',
  ],
  coral: [
    '................',
    '..L.....L....L..',
    '..a..L..a...La..',
    '..aa.a..aa..a...',
    '...a.aa.a..aa.L.',
    '.L.aaa..a.aa..a.',
    '.a..aa.aa.a..aa.',
    '.aa..aaa.aa.aa..',
    '..aa..aa.aaaa...',
    '...aaa.aaaa.....',
    '.....aaaaa......',
    '......aAa.......',
    '......aAa.......',
    '....rrRaArrr....',
    '..rrrRRRRRRrr...',
    '.rrRRRRRRRRRRr..',
  ],
  crabclaw: [
    '.L.L.......L.L..',
    '.a.a.......a.a..',
    '.aaa.......aaa..',
    '.AaA..L.L..AaA..',
    '..A...a.a...A...',
    '..cc..aaa..cc...',
    '...cc.AaA.cc....',
    '....cc.A.cc.....',
    '.....ccccc......',
    '......cCc.......',
    '....cc.C.cc.....',
    '...cC..C..Cc....',
    '.......C........',
    '......cCc.......',
    '.....ccCcc......',
    '......cCc.......',
  ],
  startree: [
    '.......a........',
    '.......a........',
    '......aLa.......',
    '..aaaaaLaaaaa...',
    '....aaaLaaa.....',
    '.....aaaaa......',
    '....aa...aa.....',
    '...a.......a....',
    '.......bB.......',
    '..gg...bB...a...',
    '.gGGg..bB..aLa..',
    '..ggggbbB...a...',
    '...a...bBgg.....',
    '..aLa..bBGGg....',
    '...a...bBgg.....',
    '......bbBB......',
  ],
};

const STAGES: string[][] = [
  // a seed in a little mound
  ['................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '.......aA.......', '.....bbbbbb.....'],
  // sprout
  ['................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '................', '......g..g......', '.....gGggGg.....', '......ggGg......', '........G.......', '........G.......'],
  // a bud showing its color
  ['................', '................', '................', '................', '................', '................', '.......aA.......', '.......aA.......', '........G.......', '...gg...G..gg...', '..gGGg..G.gGGg..', '...gggg.G.ggg...', '......ggGgg.....', '........G.......', '........G.......', '........G.......'],
];

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  const r = mix(n >> 16);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function paint(color: SeedColor, ch: string, row: number): string | undefined {
  if (ch === 'a' || ch === 'A' || ch === 'L') {
    const base = color === 'rainbow' ? RAINBOW[row % RAINBOW.length] : COLORS[color];
    return ch === 'a' ? base : ch === 'A' ? shade(base, color === 'black' ? 0.25 : -0.25) : shade(base, 0.45);
  }
  return FIXED[ch];
}

/** One plant: species art when ripe (stage 3), otherwise its seed / sprout / bud. */
export function PlantSprite({ species, color, stage = 3, size = 48, className = '' }: { species: string; color: SeedColor; stage?: 0 | 1 | 2 | 3; size?: number; className?: string }) {
  const rows = stage === 3 ? ART[species] ?? ART.tulip : STAGES[stage];
  const rects = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const fill = paint(color, rows[y][x], y);
      if (fill) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={fill} />);
    }
  }
  return (
    <svg className={`plant c-${color} ${className}`} width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      {rects}
    </svg>
  );
}

/** A seed packet: the plant on the front, framed in its quality. */
export function SeedPacket({ species, color, rarity, size = 44 }: { species: string; color: SeedColor; rarity: Rarity; size?: number }) {
  return (
    <span className={`seed-packet r-${rarity}`} style={{ width: size, height: size * 1.2 }}>
      <PlantSprite species={species} color={color} size={size * 0.8} />
    </span>
  );
}

export const colorSwatch = (c: SeedColor) => (c === 'rainbow' ? `linear-gradient(90deg, ${RAINBOW.join(', ')})` : COLORS[c]);
