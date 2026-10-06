/*
 * A 3×5 bitmap font drawn as SVG rects, for the labels under the pets. Latin
 * letters (upper-cased), digits and a little punctuation; anything else (e.g. a
 * Chinese repo name) falls back to regular text.
 */
/** 3 columns × 5 rows per glyph, row-major. */
const GLYPHS: Record<string, string> = {
  A: '.#.#.#####.##.#',
  B: '##.#.###.#.###.',
  C: '.###..#..#...##',
  D: '##.#.##.##.###.',
  E: '####..##.#..###',
  F: '####..##.#..#..',
  G: '.###..#.##.#.##',
  H: '#.##.#####.##.#',
  I: '###.#..#..#.###',
  J: '..#..#..##.#.#.',
  K: '#.##.###.#.##.#',
  L: '#..#..#..#..###',
  M: '#.########.##.#',
  N: '##.#.##.##.##.#',
  O: '.#.#.##.##.#.#.',
  P: '##.#.###.#..#..',
  Q: '.#.#.##.###..##',
  R: '##.#.###.#.##.#',
  S: '.###...#...###.',
  T: '###.#..#..#..#.',
  U: '#.##.##.##.####',
  V: '#.##.##.##.#.#.',
  W: '#.##.########.#',
  X: '#.##.#.#.#.##.#',
  Y: '#.##.#.#..#..#.',
  Z: '###..#.#.#..###',
  '0': '####.##.##.####',
  '1': '.#.##..#..#.###',
  '2': '##...#.#.#..###',
  '3': '##...#.#...###.',
  '4': '#.##.####..#..#',
  '5': '####..##...###.',
  '6': '.###..####.####',
  '7': '###..#.#..#..#.',
  '8': '####.#####.####',
  '9': '####.####..###.',
  '.': '.............#.',
  ',': '..........#.#..',
  '-': '......###......',
  _: '............###',
  '/': '..#..#.#.#..#..',
  ':': '....#.....#....',
  '!': '.#..#..#.....#.',
  '?': '##...#.#.....#.',
  '@': '.#.#.#####...##',
  '+': '....#.###.#....',
  '#': '#.#####.#####.#',
  '(': '.#.#..#..#...#.',
  ')': '.#...#..#..#.#.',
  "'": '.#..#..........',
  ' ': '...............',
};

export const pixelSupported = (s: string) => [...s.toUpperCase()].every((c) => c in GLYPHS || c === '…');

/**
 * Renders `text` in the pixel font. `dots` appends three blinking dots
 * ("Cooking..."). Height = 5 × scale px.
 */
export function PixelText({
  text,
  scale = 2,
  className,
  dots = false,
  wave = false,
  title,
}: {
  text: string;
  scale?: number;
  className?: string;
  dots?: boolean;
  /** letters hop one after another, like a spinner word */
  wave?: boolean;
  title?: string;
}) {
  const chars = [...text.toUpperCase().replace(/…/g, '...')];
  if (!pixelSupported(chars.join(''))) {
    return (
      <span className={`pixel-fallback ${className ?? ''}`} title={title} style={{ fontSize: scale * 5 + 1 }}>
        {text}
        {dots && <span className="pixel-dots-txt">…</span>}
      </span>
    );
  }
  const cols = chars.length * 4 + (dots ? 3 * 2 : 0) - 1;
  // one group per letter, so each can hop on its own beat
  const letters = chars.map((c, i) => {
    const g = GLYPHS[c] ?? GLYPHS[' '];
    const rects: React.ReactNode[] = [];
    for (let j = 0; j < 15; j++) if (g[j] === '#') rects.push(<rect key={j} x={i * 4 + (j % 3)} y={Math.floor(j / 3)} width={1} height={1} />);
    return (
      <g key={i} className={wave ? 'pixel-ch' : undefined} style={wave ? { animationDelay: `${i * 0.09}s` } : undefined}>
        {rects}
      </g>
    );
  });
  const x0 = chars.length * 4;
  return (
    <svg
      className={`pixel-text ${className ?? ''}`}
      width={cols * scale}
      height={6 * scale}
      viewBox={`0 -1 ${cols} 6`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={dots ? `${text}…` : text}
    >
      {title && <title>{title}</title>}
      <g fill="currentColor">{letters}</g>
      {dots && (
        <g fill="currentColor" className="pixel-dots">
          <rect x={x0} y={4} width={1} height={1} />
          <rect x={x0 + 2} y={4} width={1} height={1} />
          <rect x={x0 + 4} y={4} width={1} height={1} />
        </g>
      )}
    </svg>
  );
}
