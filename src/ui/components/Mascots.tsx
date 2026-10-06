import type { PetMood } from '../../shared/types';

/*
 * Original mascots:
 *  - a pixel-art crab in Claude's terracotta, for Claude Code tasks
 *  - a pixel-art terminal robot whose screen is its face, for Codex tasks
 *  - a chibi "whale girl" (DeepSeek-style), an alternative skin for Codex
 *  - a milk frog (Amazon milk frog: milky skin, brown bands, golden eyes with
 *    cross-shaped pupils, sticky toe pads), another skin for Codex
 * Both change face and props with the mood; motion comes from CSS (styles.css, .mascot).
 */

// ── pixel crab ──────────────────────────────────────────────────────────────
// Each layer is a 24×20 ASCII map. Letters pick the palette entry; '.' is empty.
const CRAB_PALETTE: Record<string, string> = {
  o: 'var(--crab)',
  h: 'var(--crab-hi)',
  s: 'var(--crab-shade)',
  e: 'var(--ink-pixel)',
  w: '#ffffff',
  p: 'var(--crab-blush)',
  y: '#ffc94d',
  b: '#7cc4fa',
  k: 'var(--ink-pixel)',
  // scene props
  g: '#d5dae4', // laptop lid
  G: '#9aa3b5',
  l: 'var(--code-glow)', // floating code
  m: '#4b505c', // wok
  M: '#737a89',
  f: '#ff7a33', // flame
  r: '#fffdf5', // white rice
  R: '#e3dccb',
  c: '#3f6fd8', // rice bowl
  C: '#f4f7ff',
  d: '#a8703f', // wood: wok handle
  t: '#9cc56b', // green tea
  T: '#f6efe4', // cup
};

const CLAW_L = [
  'hh.hh...................',
  'oo.oo...................',
  'ooooo...................',
  'sooos...................',
  '.sss....................',
  '..o.....................',
  '..oo....................',
  '...oo...................',
];
const CLAW_R = CLAW_L.map((r) => r.split('').reverse().join(''));

const BODY = [
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
  '......hhhhhhhhhhhh......',
  '.....oooooooooooooo.....',
  '.....oooooooooooooo.....',
  '.....oooooooooooooo.....',
  '.....oooooooooooooo.....',
  '.....oooooooooooooo.....',
  '.....ssssssssssssss.....',
  '......ssssssssssss......',
];
const LEGS_A = [
  '......s.s......s.s......',
  '......s.s......s.s......',
  '.....s..s......s..s.....',
];
const LEGS_B = [
  '.......s.s....s.s.......',
  '.......s.s....s.s.......',
  '......s..s....s..s......',
];

const CRAB_FACES: Record<PetMood, string[]> = {
  idle: ['.........e....e.........', '.........e....e.........', '.......p........p.......'],
  working: ['........................', '.........e....e.........', '.......p........p.......', '...........kk...........'],
  waiting: ['........ew...ew.........', '........ee...ee.........', '.......p........p.......', '...........kk...........'],
  alert: ['........e......e........', '.........e....e.........', '........e......e........', '..........k..k..........'],
  sleeping: ['........................', '........eee..eee........', '.......p........p.......'],
  happy: ['.........e....e.........', '........e.e..e.e........', '.......p........p.......', '..........kkkk..........'],
};

const CRAB_PROPS: Partial<Record<PetMood, { rows: string[]; y: number; cls: string }>> = {
  waiting: { y: -6, cls: 'prop-pop', rows: ['....................yy..', '....................yy..', '....................yy..', '........................', '....................yy..'] },
  alert: { y: 4, cls: 'prop-drip', rows: ['......b.................', '.....bbb................'] },
  sleeping: { y: -5, cls: 'prop-float', rows: ['..................kkkk..', '....................k...', '...................k....', '..................kkkk..', '.....................kkk', '......................k.', '.....................kkk'] },
  happy: { y: -4, cls: 'prop-twinkle', rows: ['.y....................y.', 'yyy..................yyy', '.y....................y.'] },
};

function Pixels({ rows, x0 = 0, y0 = 0, className }: { rows: string[]; x0?: number; y0?: number; className?: string }) {
  const rects = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '.' || !CRAB_PALETTE[c]) continue;
      rects.push(<rect key={`${x}-${y}`} x={x + x0} y={y + y0} width={1.02} height={1.02} fill={CRAB_PALETTE[c]} />);
    }
  }
  return <g className={className}>{rects}</g>;
}

/**
 * Little scenes the crab acts out: what it is doing for the task (coding,
 * "cooking" a shell command, reading, searching, sipping tea while it waits),
 * or a snack break when nothing is going on.
 */
export type CrabScene = 'code' | 'cook' | 'read' | 'search' | 'rice' | 'tea';

interface Layer {
  rows: string[];
  x: number;
  y: number;
  cls?: string;
}

const CRAB_SCENES: Record<CrabScene, { layers: Layer[]; claws: number }> = {
  // laptop in front, code glyphs drifting up
  code: {
    claws: 5,
    layers: [
      { x: 6, y: 13, rows: ['kkkkkkkkkkkk', 'kggggggggggk', 'kggggGGggggk', 'kggggggggggk'] },
      { x: 3, y: 17, rows: ['kkkkkkkkkkkkkkkkkk', 'kGGGGGGGGGGGGGGGGk'] },
      { x: 15, y: -1, cls: 'sc-float', rows: ['.l...l.l.', 'l...l...l', '.l.l...l.'] },
      { x: 2, y: 0, cls: 'sc-float d2', rows: ['.l.lll', 'll.l.l', '.l.lll'] },
    ],
  },
  // a wok over a flame, tossing an egg
  cook: {
    claws: 4,
    layers: [
      { x: 4, y: 6, cls: 'sc-steam', rows: ['.w', 'w.', '.w'] },
      { x: 19, y: 5, cls: 'sc-steam d2', rows: ['w.', '.w', 'w.'] },
      { x: 12, y: 10, cls: 'sc-toss', rows: ['.ww.', 'wyyw', '.ww.'] },
      // handle on the left: the lower-right corner belongs to the quota bars
      { x: 0, y: 13, rows: ['...kkkkkkkkkkkkkkkkkk', 'dddkMMMMMMMMMMMMMMMMk', '....kmmmmmmmmmmmmmmk', '.....kkkkkkkkkkkkkk'] },
      { x: 5, y: 17, cls: 'sc-flame', rows: ['..y...y...y..', '.fyf.fyf.fyf.'] },
    ],
  },
  // reading glasses and a book
  read: {
    claws: 6,
    layers: [
      { x: 8, y: 8, rows: ['kkk..kkk', 'k.kkkk.k', 'k.k..k.k', 'kkk..kkk'] },
      { x: 9, y: 9, cls: 'sc-glint', rows: ['w....w'] },
      { x: 7, y: 13, cls: 'sc-book', rows: ['kkkkkkkkkk', 'kbbbbbbbbk', 'kbwwwwwwbk', 'kbbbbbbbbk', 'kbwwwwbbbk', 'kkkkkkkkkk'] },
    ],
  },
  // magnifying glass sweeping back and forth (drawn as vectors below)
  search: { claws: 2, layers: [] },
  // a heaped bowl of white rice; chopsticks are vectors below
  rice: {
    claws: 3,
    layers: [
      { x: 11, y: 12, cls: 'sc-chew', rows: ['kk'] },
      { x: 13, y: 12, cls: 'sc-grain', rows: ['r'] },
      { x: 6, y: 13, rows: ['...rrrrrr...', '.rrrrRrrRrr.', 'cccccccccccc', 'cCCCCCCCCCCc', '.cCCcCCcCCc.', '..cccccccc..', '....cccc....'] },
    ],
  },
  // a cup of green tea, steaming
  tea: {
    claws: 2,
    layers: [
      { x: 16, y: 7, cls: 'sc-steam', rows: ['.w.', 'w..', '.w.', '..w', '.w.'] },
      { x: 15, y: 13, rows: ['kkkkkk..', 'kttttkk.', 'kTTTTk.k', 'kTTTTkk.', '.kkkk...'] },
      { x: 14, y: 18, rows: ['kkkkkkkk'] },
    ],
  },
};

export function CrabSprite({ mood, size, scene }: { mood: PetMood; size: number; scene?: CrabScene }) {
  const sc = scene ? CRAB_SCENES[scene] : undefined;
  const prop = sc ? undefined : CRAB_PROPS[mood];
  const raised = mood === 'waiting' || mood === 'happy';
  const clawY = sc ? sc.claws : raised ? 0 : 2;
  return (
    <svg
      className={`mascot crab mood-${mood} ${scene ? `scene scene-${scene}` : ''}`}
      width={size * 1.2}
      height={size}
      viewBox="0 -6 24 26"
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Claude crab: ${scene ?? mood}`}
    >
      <ellipse className="mascot-shadow" cx="12" cy="19.6" rx="7.5" ry="0.8" />
      <g className="m-body">
        <Pixels rows={mood === 'working' ? LEGS_B : LEGS_A} y0={15} className="crab-legs" />
        <Pixels rows={CLAW_L} y0={clawY} className="crab-claw left" />
        <Pixels rows={CLAW_R} y0={clawY} className="crab-claw right" />
        <Pixels rows={BODY} />
        <Pixels rows={CRAB_FACES[mood]} y0={9} className={mood === 'sleeping' || mood === 'happy' ? '' : 'm-eyes'} />
        {sc?.layers.map((l, i) => <Pixels key={i} rows={l.rows} x0={l.x} y0={l.y} className={l.cls} />)}
        {scene === 'rice' && (
          <g className="sc-chop" stroke="#a8703f" strokeWidth="0.55" strokeLinecap="round" shapeRendering="auto">
            <path d="M21.6 4.6 L13.6 12.6" />
            <path d="M22.4 5.2 L14.4 13" />
          </g>
        )}
        {scene === 'search' && (
          <g className="sc-lens" shapeRendering="auto">
            <path d="M21 10.6 L23.4 13.4" stroke="var(--ink-pixel)" strokeWidth="1.1" strokeLinecap="round" />
            <circle cx="19.2" cy="8.6" r="2.5" fill="#bfe3ff" fillOpacity="0.45" stroke="var(--ink-pixel)" strokeWidth="0.8" />
            <path d="M18 7.6 Q18.6 6.9 19.5 6.9" fill="none" stroke="#fff" strokeWidth="0.5" strokeLinecap="round" />
          </g>
        )}
      </g>
      {prop && <Pixels rows={prop.rows} y0={prop.y} className={prop.cls} />}
    </svg>
  );
}

// ── whale girl ──────────────────────────────────────────────────────────────
const HAIR = 'url(#wgHair)';

export function WhaleGirlSprite({ mood, size }: { mood: PetMood; size: number }) {
  const id = 'wg';
  return (
    <svg className={`mascot whale mood-${mood}`} width={size * (120 / 140)} height={size} viewBox="0 0 120 140" role="img" aria-label={`Whale girl: ${mood}`}>
      <defs>
        <linearGradient id={`${id}Hair`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--whale-hair-hi)" />
          <stop offset="1" stopColor="var(--whale-hair)" />
        </linearGradient>
        <radialGradient id={`${id}Iris`} cx="50%" cy="35%" r="70%">
          <stop offset="0" stopColor="#1b2a8c" />
          <stop offset="0.6" stopColor="#3355e8" />
          <stop offset="1" stopColor="#7fb0ff" />
        </radialGradient>
      </defs>
      <ellipse className="mascot-shadow" cx="60" cy="135" rx="28" ry="3.5" />
      <g className="m-body">
        {/* twin tails ending in whale flukes */}
        <g fill={HAIR} stroke="var(--whale-line)" strokeWidth="1.6" strokeLinejoin="round">
          <path className="tail-l" d="M34 46 C18 56 12 76 18 92 L8 104 C13 109 20 107 23 102 C25 107 32 109 37 104 L28 92 C25 78 29 62 42 54 Z" />
          <path className="tail-r" d="M86 46 C102 56 108 76 102 92 L112 104 C107 109 100 107 97 102 C95 107 88 109 83 104 L92 92 C95 78 91 62 78 54 Z" />
        </g>
        {/* back hair */}
        <path d="M26 54 C24 26 42 14 60 14 C78 14 96 26 94 54 C96 70 92 82 86 88 L34 88 C28 82 24 70 26 54 Z" fill={HAIR} stroke="var(--whale-line)" strokeWidth="1.6" />
        {/* legs + shoes */}
        <g>
          <rect x="50" y="116" width="7" height="12" rx="3" fill="var(--whale-skin)" />
          <rect x="63" y="116" width="7" height="12" rx="3" fill="var(--whale-skin)" />
          <ellipse cx="53" cy="129" rx="6" ry="3.4" fill="var(--whale-deep)" />
          <ellipse cx="67" cy="129" rx="6" ry="3.4" fill="var(--whale-deep)" />
        </g>
        {/* arms */}
        <g className="arms" fill="var(--whale-skin)" stroke="var(--whale-line)" strokeWidth="1.2">
          <ellipse className="arm-l" cx="37" cy="100" rx="5" ry="10" transform="rotate(16 37 100)" />
          <ellipse className="arm-r" cx="83" cy="100" rx="5" ry="10" transform="rotate(-16 83 100)" />
        </g>
        {/* sailor dress */}
        <path d="M42 82 Q60 77 78 82 L88 118 Q60 125 32 118 Z" fill="var(--whale-dress)" stroke="var(--whale-line)" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M34 112 Q60 119 86 112 L88 118 Q60 125 32 118 Z" fill="var(--whale-blue)" />
        <path d="M43 82 L60 99 L77 82 Q60 87 43 82 Z" fill="var(--whale-blue)" stroke="var(--whale-line)" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M60 97 L51 92 L52 102 Z M60 97 L69 92 L68 102 Z" fill="#ff8a9a" stroke="var(--whale-line)" strokeWidth="1" strokeLinejoin="round" />
        <circle cx="60" cy="97" r="2.4" fill="#ff6f86" />
        {mood === 'working' && <Laptop />}
        {/* head */}
        <rect x="55" y="74" width="10" height="9" fill="var(--whale-skin)" />
        <path d="M32 52 C32 30 46 20 60 20 C74 20 88 30 88 52 C88 68 76 80 60 80 C44 80 32 68 32 52 Z" fill="var(--whale-skin)" stroke="var(--whale-line)" strokeWidth="1.4" />
        <WhaleFace mood={mood} />
        {/* bangs + side locks */}
        <g fill={HAIR} stroke="var(--whale-line)" strokeWidth="1.4" strokeLinejoin="round">
          <path d="M29 56 C26 30 42 15 60 15 C78 15 94 30 91 56 C88 49 85 45 83 40 C80 46 76 49 73 40 C70 47 66 49 62 37 C58 47 54 49 49 40 C46 47 42 49 39 41 C36 46 32 50 29 56 Z" />
          <path d="M31 50 C28 62 30 74 34 82 L39 79 C36 70 36 60 38 50 Z" />
          <path d="M89 50 C92 62 90 74 86 82 L81 79 C84 70 84 60 82 50 Z" />
        </g>
        <path d="M44 24 C50 20 56 19 62 19" fill="none" stroke="var(--whale-hair-gloss)" strokeWidth="2.4" strokeLinecap="round" opacity="0.8" />
        <path d="M60 16 C55 6 66 3 64 11" fill="none" stroke="var(--whale-hair)" strokeWidth="2.6" strokeLinecap="round" />
        {/* whale hair clip */}
        <g className="whale-clip" transform="translate(84 26) rotate(-12)">
          <path d="M-10 0 C-10 -7 2 -8 8 -3 L13 -7 C14 -3 14 1 12 4 L8 2 C2 7 -10 6 -10 0 Z" fill="var(--whale-blue)" stroke="var(--whale-line)" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M-9 1.5 C-5 5 3 5 7 2" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="-5" cy="-1.6" r="1.1" fill="var(--whale-line)" />
          {mood === 'happy' && (
            <g className="spout" fill="#9fd4ff">
              <circle cx="-4" cy="-12" r="1.6" />
              <circle cx="0" cy="-15" r="1.3" />
              <circle cx="-8" cy="-15" r="1.3" />
              <path d="M-4 -6 C-5 -9 -3 -10 -4 -12" stroke="#9fd4ff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
            </g>
          )}
        </g>
      </g>
      <WhaleProps mood={mood} />
    </svg>
  );
}

function Eye({ cx, mood }: { cx: number; mood: PetMood }) {
  const cy = 56;
  if (mood === 'sleeping')
    return <path d={`M${cx - 7} ${cy} Q${cx} ${cy + 6} ${cx + 7} ${cy}`} fill="none" stroke="var(--whale-line)" strokeWidth="2.4" strokeLinecap="round" />;
  if (mood === 'happy')
    return <path d={`M${cx - 7} ${cy + 3} Q${cx} ${cy - 6} ${cx + 7} ${cy + 3}`} fill="none" stroke="var(--whale-line)" strokeWidth="2.6" strokeLinecap="round" />;
  const big = mood === 'waiting';
  const rx = big ? 7.4 : 6.6;
  const ry = big ? 9 : 8.2;
  return (
    <g className="m-eyes" style={{ transformOrigin: `${cx}px ${cy}px` }}>
      <ellipse cx={cx} cy={cy + 1} rx={rx} ry={ry} fill="url(#wgIris)" />
      <ellipse cx={cx} cy={cy + 2} rx={rx * 0.45} ry={ry * 0.5} fill="#121a5c" />
      <circle cx={cx - 2.6} cy={cy - 3} r={big ? 2.8 : 2.3} fill="#fff" />
      <circle cx={cx + 2.4} cy={cy + 4.2} r="1.1" fill="#fff" opacity="0.9" />
      <path d={`M${cx - rx - 1.2} ${cy - ry + 3} Q${cx} ${cy - ry - 3.2} ${cx + rx + 1.2} ${cy - ry + 3}`} fill="none" stroke="var(--whale-line)" strokeWidth="2.4" strokeLinecap="round" />
      {mood === 'working' && <path d={`M${cx - rx} ${cy - 3} L${cx + rx} ${cy - 3}`} stroke="var(--whale-skin)" strokeWidth="4.5" />}
    </g>
  );
}

function WhaleFace({ mood }: { mood: PetMood }) {
  const brows =
    mood === 'alert' ? (
      <g stroke="var(--whale-line)" strokeWidth="1.6" strokeLinecap="round">
        <path d="M42 42 L52 45" />
        <path d="M78 42 L68 45" />
      </g>
    ) : null;
  const mouth = (() => {
    switch (mood) {
      case 'happy':
        return <path d="M54 68 Q60 76 66 68 Z" fill="#c2405a" stroke="var(--whale-line)" strokeWidth="1.2" strokeLinejoin="round" />;
      case 'waiting':
        return <ellipse cx="60" cy="70" rx="2.6" ry="3" fill="#c2405a" />;
      case 'alert':
        return <path d="M54 71 Q57 68 60 71 Q63 74 66 71" fill="none" stroke="var(--whale-line)" strokeWidth="1.6" strokeLinecap="round" />;
      case 'sleeping':
        return <ellipse cx="60" cy="70" rx="1.8" ry="1.4" fill="#c2405a" />;
      case 'working':
        return <path d="M56 70 L64 70" stroke="var(--whale-line)" strokeWidth="1.6" strokeLinecap="round" />;
      default:
        return <path d="M56 69 Q60 72.5 64 69" fill="none" stroke="var(--whale-line)" strokeWidth="1.6" strokeLinecap="round" />;
    }
  })();
  return (
    <g>
      <Eye cx={47} mood={mood} />
      <Eye cx={73} mood={mood} />
      {brows}
      <ellipse cx="41" cy="66" rx="5" ry="2.6" fill="#ff9fb0" opacity={mood === 'alert' ? 0.9 : 0.55} />
      <ellipse cx="79" cy="66" rx="5" ry="2.6" fill="#ff9fb0" opacity={mood === 'alert' ? 0.9 : 0.55} />
      {mouth}
    </g>
  );
}

function Laptop() {
  return (
    <g className="laptop">
      <path d="M40 104 L80 104 L84 114 L36 114 Z" fill="#c9cfdc" stroke="var(--whale-line)" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="43" y="88" width="34" height="17" rx="2" fill="#2b3350" stroke="var(--whale-line)" strokeWidth="1.2" />
      <g className="code-lines" stroke="#7fb0ff" strokeWidth="1.6" strokeLinecap="round">
        <path d="M47 93 L60 93" />
        <path d="M50 97 L70 97" stroke="#9be7a8" />
        <path d="M50 101 L64 101" />
      </g>
      <circle cx="60" cy="96" r="0" fill="#fff" />
    </g>
  );
}

function WhaleProps({ mood }: { mood: PetMood }) {
  switch (mood) {
    case 'waiting':
      return (
        <g className="prop-pop" transform="translate(104 18)">
          <circle r="11" fill="#ffc94d" stroke="var(--whale-line)" strokeWidth="1.2" />
          <rect x="-1.8" y="-7" width="3.6" height="9" rx="1.8" fill="#1a1a19" />
          <circle cy="5.5" r="2" fill="#1a1a19" />
        </g>
      );
    case 'alert':
      return <path className="prop-drip" d="M28 36 C28 36 22 44 22 48 A6 6 0 0 0 34 48 C34 44 28 36 28 36 Z" fill="#9fd4ff" stroke="var(--whale-line)" strokeWidth="1.2" />;
    case 'sleeping':
      return (
        <g className="prop-float" fill="var(--pet-prop)" fontWeight="800" fontFamily="system-ui, sans-serif">
          <text x="96" y="30" fontSize="16">Z</text>
          <text x="108" y="16" fontSize="11">z</text>
        </g>
      );
    case 'happy':
      return (
        <g className="prop-twinkle" fill="#ffc94d">
          <path d="M14 22 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" />
          <path d="M106 50 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2 Z" />
        </g>
      );
    default:
      return null;
  }
}


// ── Codex terminal buddy ────────────────────────────────────────────────────
// A round little robot whose head is a terminal screen; the face is drawn in
// screen glow and changes with the mood. Same footprint as the crab (1.2 : 1).

function BotFace({ mood }: { mood: PetMood }) {
  const glow = mood === 'alert' ? 'var(--bot-alert)' : mood === 'sleeping' ? 'var(--bot-dim)' : 'var(--bot-glow)';
  const eyes = (() => {
    switch (mood) {
      case 'happy':
        return (
          <g fill="none" stroke={glow} strokeWidth="3.2" strokeLinecap="round">
            <path d="M54 50 Q59 42 64 50" />
            <path d="M80 50 Q85 42 90 50" />
          </g>
        );
      case 'sleeping':
        return (
          <g fill="none" stroke={glow} strokeWidth="3" strokeLinecap="round">
            <path d="M54 47 Q59 52 64 47" />
            <path d="M80 47 Q85 52 90 47" />
          </g>
        );
      case 'alert':
        return (
          <g fill="none" stroke={glow} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M54 41 L62 46 L54 51" />
            <path d="M90 41 L82 46 L90 51" />
          </g>
        );
      case 'waiting':
        return (
          <g className="m-eyes">
            <circle cx="59" cy="46" r="6.5" fill={glow} />
            <circle cx="85" cy="46" r="6.5" fill={glow} />
            <circle cx="61.2" cy="43.6" r="2" fill="var(--bot-screen)" />
            <circle cx="87.2" cy="43.6" r="2" fill="var(--bot-screen)" />
          </g>
        );
      case 'working':
        // focused: eyes narrowed and glancing down at the work
        return (
          <g className="bot-scan" fill={glow}>
            <rect x="54" y="46" width="10" height="5" rx="2.5" />
            <rect x="80" y="46" width="10" height="5" rx="2.5" />
          </g>
        );
      default:
        return (
          <g className="m-eyes" fill={glow}>
            <rect x="55.5" y="39" width="7" height="12" rx="3.5" />
            <rect x="81.5" y="39" width="7" height="12" rx="3.5" />
          </g>
        );
    }
  })();
  const mouth = (() => {
    switch (mood) {
      case 'happy':
        return <path d="M64 56 Q72 66 80 56 Z" fill={glow} />;
      case 'waiting':
        return <circle cx="72" cy="59" r="2.6" fill="none" stroke={glow} strokeWidth="2.2" />;
      case 'alert':
        return <path d="M63 60 Q66.5 56 70 60 Q73.5 64 77 60 Q79 58 81 59" fill="none" stroke={glow} strokeWidth="2.2" strokeLinecap="round" />;
      case 'sleeping':
        return <path d="M69 59 L75 59" stroke={glow} strokeWidth="2" strokeLinecap="round" />;
      case 'working':
        return <rect className="bot-cursor" x="68" y="57" width="8" height="3" rx="1" fill={glow} />;
      default:
        return <path d="M66 56.5 Q72 61.5 78 56.5" fill="none" stroke={glow} strokeWidth="2.4" strokeLinecap="round" />;
    }
  })();
  return (
    <g>
      {eyes}
      {mouth}
      {mood !== 'sleeping' && (
        <g fill="var(--bot-blush)" opacity={mood === 'alert' ? 0.35 : 0.6}>
          <ellipse cx="50" cy="57" rx="4.2" ry="2.4" />
          <ellipse cx="94" cy="57" rx="4.2" ry="2.4" />
        </g>
      )}
    </g>
  );
}

function BotProps({ mood }: { mood: PetMood }) {
  switch (mood) {
    case 'waiting':
      return (
        <g className="prop-pop" transform="translate(122 20)">
          <circle r="10" fill="#ffc94d" stroke="var(--bot-line)" strokeWidth="1.6" />
          <rect x="-1.7" y="-6.5" width="3.4" height="8" rx="1.7" fill="var(--bot-line)" />
          <circle cy="5" r="1.9" fill="var(--bot-line)" />
        </g>
      );
    case 'alert':
      return <path className="prop-drip" d="M30 30 C30 30 24 38 24 42 A6 6 0 0 0 36 42 C36 38 30 30 30 30 Z" fill="#9fd4ff" stroke="var(--bot-line)" strokeWidth="1.4" />;
    case 'sleeping':
      return (
        <g className="prop-float" fill="var(--pet-prop)" fontWeight="800" fontFamily="system-ui, sans-serif">
          <text x="112" y="26" fontSize="16">Z</text>
          <text x="125" y="13" fontSize="11">z</text>
        </g>
      );
    case 'happy':
      return (
        <g className="prop-twinkle" fill="#ffc94d">
          <path d="M22 26 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" />
          <path d="M122 46 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2 Z" />
        </g>
      );
    case 'working':
      return (
        <g className="bot-glyphs" fill="var(--bot-glyph)" fontFamily="ui-monospace, Menlo, monospace" fontWeight="700">
          <text className="g1" x="112" y="34" fontSize="11">{'{ }'}</text>
          <text className="g2" x="14" y="40" fontSize="10">{'</>'}</text>
        </g>
      );
    default:
      return null;
  }
}

export function CodexBotSprite({ mood, size }: { mood: PetMood; size: number }) {
  const up = mood === 'waiting' || mood === 'happy';
  return (
    <svg className={`mascot bot mood-${mood}`} width={size * 1.2} height={size} viewBox="0 0 144 120" role="img" aria-label={`Codex bot: ${mood}`}>
      <ellipse className="mascot-shadow" cx="72" cy="113" rx="24" ry="3.4" />
      <g className="m-body">
        {/* feet */}
        <g fill="var(--bot-line)">
          <rect className="bot-foot l" x="56" y="98" width="13" height="10" rx="5" />
          <rect className="bot-foot r" x="75" y="98" width="13" height="10" rx="5" />
        </g>
        {/* arms: little rounded nubs, raised to wave when happy / calling */}
        <g fill="var(--bot-case)" stroke="var(--bot-line)" strokeWidth="2">
          {/* the group animates; the rect keeps its pose rotation */}
          <g className="bot-arm left">
            <rect x="38" y="78" width="12" height="20" rx="6" transform={up ? 'rotate(50 48 80)' : 'rotate(18 48 80)'} />
          </g>
          <g className="bot-arm right">
            <rect x="94" y="78" width="12" height="20" rx="6" transform={up ? 'rotate(-50 96 80)' : 'rotate(-18 96 80)'} />
          </g>
        </g>
        {/* body with a tiny terminal badge */}
        <rect x="50" y="72" width="44" height="30" rx="14" fill="var(--bot-case)" stroke="var(--bot-line)" strokeWidth="2.2" />
        <rect x="61" y="79" width="22" height="13" rx="4" fill="var(--bot-screen)" />
        {mood === 'working' ? (
          <g className="bot-badge-code" stroke="var(--bot-glow)" strokeWidth="1.6" strokeLinecap="round">
            <path className="c1" d="M64.5 83 L71 83" />
            <path className="c2" d="M66.5 86 L79 86" />
            <path className="c3" d="M64.5 89 L74 89" />
          </g>
        ) : (
          <g stroke="var(--bot-glow)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={mood === 'sleeping' ? 0.4 : 1}>
            <path d="M65 82.5 L68.5 85.5 L65 88.5" />
            <path className="bot-cursor" d="M71 89 L77 89" />
          </g>
        )}
        {/* antenna */}
        <path d="M72 22 L72 11" stroke="var(--bot-line)" strokeWidth="2.4" strokeLinecap="round" />
        <circle className="bot-bulb" cx="72" cy="9" r="5" fill="var(--bot-tip)" stroke="var(--bot-line)" strokeWidth="2" />
        {/* ear bolts */}
        <g fill="var(--bot-tip)" stroke="var(--bot-line)" strokeWidth="2">
          <rect x="29" y="38" width="9" height="18" rx="4.5" />
          <rect x="106" y="38" width="9" height="18" rx="4.5" />
        </g>
        {/* head: a rounded monitor; its screen is the face */}
        <rect x="35" y="21" width="74" height="54" rx="20" fill="var(--bot-case)" stroke="var(--bot-line)" strokeWidth="2.4" />
        <rect x="43" y="29" width="58" height="38" rx="13" fill="var(--bot-screen)" />
        <path d="M48 34 Q52 31 58 31" stroke="#fff" strokeOpacity="0.18" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <BotFace mood={mood} />
        {mood === 'sleeping' && <rect x="43" y="29" width="58" height="38" rx="13" fill="#000" opacity="0.25" />}
      </g>
      <BotProps mood={mood} />
    </svg>
  );
}

// ── milk frog ───────────────────────────────────────────────────────────────
// Same footprint as the crab and the bot (1.2 : 1). The face lives in the two
// eye domes on top of the head; the throat puffs out when it croaks.

const FROG_BODY = 'M28 74 C28 48 48 34 72 34 C96 34 116 48 116 74 C116 96 98 108 72 108 C46 108 28 96 28 74 Z';

function FrogEye({ cx, mood }: { cx: number; mood: PetMood }) {
  const cy = 38;
  const dome = <circle cx={cx} cy={cy} r="15" fill="var(--frog-skin)" stroke="var(--frog-line)" strokeWidth="2" />;
  if (mood === 'sleeping' || mood === 'happy')
    return (
      <g>
        {dome}
        <path
          d={mood === 'happy' ? `M${cx - 8} ${cy + 3} Q${cx} ${cy - 7} ${cx + 8} ${cy + 3}` : `M${cx - 8} ${cy} Q${cx} ${cy + 7} ${cx + 8} ${cy}`}
          fill="none"
          stroke="var(--frog-line)"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
      </g>
    );
  // the milk frog's cross-shaped pupil: wider when it calls you, a pinpoint when alarmed
  const p = mood === 'waiting' ? 1.35 : mood === 'alert' ? 0.6 : 1;
  return (
    <g>
      {dome}
      <g className="m-eyes">
        <circle cx={cx} cy={cy} r="11" fill="url(#frogIris)" />
        <path d={`M${cx - 9.5} ${cy} L${cx + 9.5} ${cy} M${cx} ${cy - 8} L${cx} ${cy + 8}`} stroke="var(--frog-line)" strokeWidth="1.2" strokeLinecap="round" opacity="0.55" />
        <ellipse cx={cx} cy={cy} rx={5.4 * p} ry={3.6 * p} fill="var(--frog-line)" />
        <circle cx={cx - 4} cy={cy - 4.5} r="2.6" fill="#fff" />
        <circle cx={cx + 4} cy={cy + 4} r="1.1" fill="#fff" opacity="0.85" />
      </g>
      {/* focused: the lids come halfway down */}
      {mood === 'working' && <path d={`M${cx - 14} ${cy - 1} A14 14 0 0 1 ${cx + 14} ${cy - 1} Z`} fill="var(--frog-shade)" stroke="var(--frog-line)" strokeWidth="1.6" strokeLinejoin="round" />}
    </g>
  );
}

function FrogMouth({ mood }: { mood: PetMood }) {
  switch (mood) {
    case 'happy':
      return <path d="M56 66 Q72 80 88 66 Z" fill="#d9536f" stroke="var(--frog-line)" strokeWidth="1.8" strokeLinejoin="round" />;
    case 'waiting':
      return <ellipse cx="72" cy="69" rx="4" ry="4.4" fill="#d9536f" stroke="var(--frog-line)" strokeWidth="1.6" />;
    case 'alert':
      return <path d="M58 70 Q62 66 66 70 Q70 74 74 70 Q78 66 82 70 Q84 72 86 71" fill="none" stroke="var(--frog-line)" strokeWidth="2" strokeLinecap="round" />;
    case 'sleeping':
      return <path d="M64 68 Q72 71 80 68" fill="none" stroke="var(--frog-line)" strokeWidth="2" strokeLinecap="round" />;
    case 'working':
      return <path d="M60 67 Q72 71 84 67" fill="none" stroke="var(--frog-line)" strokeWidth="2" strokeLinecap="round" />;
    default:
      return <path d="M50 64 Q72 78 94 64" fill="none" stroke="var(--frog-line)" strokeWidth="2.2" strokeLinecap="round" />;
  }
}

/** A foot with three round sticky toe pads. */
function FrogFoot({ x, y, flip = false }: { x: number; y: number; flip?: boolean }) {
  const d = flip ? -1 : 1;
  return (
    <g fill="var(--frog-skin)" stroke="var(--frog-line)" strokeWidth="1.6">
      <circle cx={x - 6 * d} cy={y} r="3.4" />
      <circle cx={x} cy={y + 1.5} r="3.4" />
      <circle cx={x + 6 * d} cy={y} r="3.4" />
    </g>
  );
}

export function MilkFrogSprite({ mood, size }: { mood: PetMood; size: number }) {
  const croak = mood === 'happy' || mood === 'waiting';
  return (
    <svg className={`mascot frog mood-${mood}`} width={size * 1.2} height={size} viewBox="0 0 144 120" role="img" aria-label={`Milk frog: ${mood}`}>
      <defs>
        <radialGradient id="frogIris" cx="45%" cy="40%" r="65%">
          <stop offset="0" stopColor="var(--frog-iris-hi)" />
          <stop offset="0.7" stopColor="var(--frog-iris)" />
          <stop offset="1" stopColor="var(--frog-iris-deep)" />
        </radialGradient>
        <clipPath id="frogBody">
          <path d={FROG_BODY} />
        </clipPath>
      </defs>
      <ellipse className="mascot-shadow" cx="72" cy="113" rx="34" ry="3.6" />
      <g className="m-body">
        {/* folded back legs */}
        <g fill="var(--frog-skin)" stroke="var(--frog-line)" strokeWidth="2">
          <ellipse className="frog-leg l" cx="34" cy="96" rx="15" ry="10" />
          <ellipse className="frog-leg r" cx="110" cy="96" rx="15" ry="10" />
        </g>
        <g fill="var(--frog-band)" opacity="0.85">
          <path d="M24 94 Q34 88 44 94 L42 98 Q34 93 26 98 Z" />
          <path d="M120 94 Q110 88 100 94 L102 98 Q110 93 118 98 Z" />
        </g>
        <FrogFoot x={26} y={106} />
        <FrogFoot x={118} y={106} flip />
        {/* body, its brown bands clipped to it */}
        <path d={FROG_BODY} fill="var(--frog-skin)" />
        <g clipPath="url(#frogBody)" fill="var(--frog-band)">
          <path d="M20 58 C34 52 40 62 52 56 C46 66 34 64 20 72 Z" />
          <path d="M124 58 C110 52 104 62 92 56 C98 66 110 64 124 72 Z" />
          <path d="M20 84 C32 78 42 88 50 84 C46 94 32 92 20 98 Z" />
          <path d="M124 84 C112 78 102 88 94 84 C98 94 112 92 124 98 Z" />
          <path d="M60 36 C66 42 78 42 84 36 C82 44 62 44 60 36 Z" />
        </g>
        <ellipse cx="72" cy="91" rx="22" ry="14" fill="var(--frog-belly)" />
        <path d={FROG_BODY} fill="none" stroke="var(--frog-line)" strokeWidth="2.2" />
        {/* throat sac: puffs out when it croaks */}
        {croak && <ellipse className="frog-sac" cx="72" cy="80" rx="12" ry="8" fill="#f6e7ef" stroke="var(--frog-line)" strokeWidth="1.6" />}
        <FrogEye cx={50} mood={mood} />
        <FrogEye cx={94} mood={mood} />
        {mood !== 'sleeping' && (
          <g fill="#ff9fb0" opacity={mood === 'alert' ? 0.85 : 0.55}>
            <ellipse cx="42" cy="66" rx="5.5" ry="3" />
            <ellipse cx="102" cy="66" rx="5.5" ry="3" />
          </g>
        )}
        <FrogMouth mood={mood} />
        {mood === 'working' && (
          <g transform="translate(12 -8)">
            <Laptop />
          </g>
        )}
        {/* front feet: on the keys when working */}
        <g className="frog-hands">
          <FrogFoot x={56} y={mood === 'working' ? 98 : 106} />
          <FrogFoot x={88} y={mood === 'working' ? 98 : 106} flip />
        </g>
      </g>
      <BotProps mood={mood} />
    </svg>
  );
}

export type MascotKind = 'crab' | 'bot' | 'whale' | 'frog';

export function Mascot({ kind, mood, size, scene }: { kind: MascotKind; mood: PetMood; size: number; scene?: CrabScene }) {
  if (kind === 'crab') return <CrabSprite mood={mood} size={size} scene={scene} />;
  if (kind === 'bot') return <CodexBotSprite mood={mood} size={size} />;
  if (kind === 'frog') return <MilkFrogSprite mood={mood} size={size} />;
  return <WhaleGirlSprite mood={mood} size={size} />;
}
