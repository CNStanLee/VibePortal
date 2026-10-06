import type { Rarity, SeedColor } from '../../shared/farm';
import { plantPixels } from '../../shared/farmArt';

export { colorSwatch } from '../../shared/farmArt';

/** One plant: species art when ripe (stage 3), otherwise its seed / sprout / bud (pixel maps in shared/farmArt). */
export function PlantSprite({ species, color, stage = 3, size = 48, className = '' }: { species: string; color: SeedColor; stage?: 0 | 1 | 2 | 3; size?: number; className?: string }) {
  return (
    <svg className={`plant c-${color} ${className}`} width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden>
      {plantPixels(species, color, stage).map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1.02} height={1.02} fill={p.fill} />
      ))}
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
