import { useMemo, useRef, useState } from 'react';
import type { SkillGraph, SkillInfo } from '../../shared/types';
import { api } from '../api';
import { fmt, useT } from '../i18n';
import { relTime } from '../format';

type Lang = 'zh' | 'en';
interface Topic {
  id: string;
  parent?: string;
  name: string;
  summary: string;
}
interface Node {
  skill: SkillInfo;
  topic: string;
  summary: string;
}
interface Link {
  from: string;
  to: string;
  kind: 'depends' | 'related';
  note?: string;
}
interface MapData {
  topics: Topic[];
  nodes: Node[];
  links: Link[];
  organized: boolean;
}

const firstSentence = (s: string) => (/^.{0,110}?[.。!！?？](\s|$)/.exec(s)?.[0] ?? s.slice(0, 110)).trim();

/**
 * The map for the skills on show: the model's topics, summaries and links when
 * it has organized them, else a plain grouping by where the skills live.
 */
function buildMap(skills: SkillInfo[], graph: SkillGraph | null, lang: Lang, t: { srcLibrary: string; mapOther: string }): MapData {
  const byId = new Set(skills.map((s) => s.id));
  if (graph) {
    const placed = new Map(graph.skills.map((s) => [s.id, s]));
    const nodes: Node[] = skills.map((skill) => {
      const g = placed.get(skill.id);
      return { skill, topic: g?.topic ?? 'new', summary: g ? g.summary[lang] : firstSentence(skill.description) };
    });
    const topics: Topic[] = graph.topics.map((x) => ({ id: x.id, parent: x.parent, name: x.name[lang], summary: x.summary[lang] }));
    if (nodes.some((n) => n.topic === 'new')) topics.push({ id: 'new', name: t.mapOther, summary: '' });
    const links = graph.links.filter((l) => byId.has(l.from) && byId.has(l.to)).map((l) => ({ from: l.from, to: l.to, kind: l.kind, note: l.note?.[lang] }));
    return { topics, nodes, links, organized: true };
  }
  // not organized yet: one topic per place the skills come from
  const where = (s: SkillInfo) => (s.source === 'library' ? 'library' : s.source === 'project' ? `p:${s.project ?? ''}` : s.source);
  const names: Record<string, string> = { library: t.srcLibrary, claude: 'Claude Code', codex: 'Codex', agents: '.agents' };
  const topics = new Map<string, Topic>();
  const nodes = skills.map((skill) => {
    const id = where(skill);
    if (!topics.has(id)) topics.set(id, { id, name: names[id] ?? skill.project?.split(/[/\\]/).pop() ?? id, summary: '' });
    return { skill, topic: id, summary: firstSentence(skill.description) };
  });
  return { topics: [...topics.values()], nodes, links: [], organized: false };
}

/** Top-level topic of a topic (sub-topics fold into their parent on the graph). */
const rootOf = (topics: Topic[], id: string) => topics.find((x) => x.id === id)?.parent ?? id;

const W = 820;
const H = 560;
/** spacing of the sunflower spiral in a cluster of n skills, and the cluster's radius */
const stepFor = (n: number) => Math.max(24, Math.min(34, 190 / Math.sqrt(n + 1)));
const radiusFor = (n: number) => Math.max(34, stepFor(n) * Math.sqrt(n) + 20);

/**
 * The skills as a knowledge map: a tree of topics (with a line about each topic
 * and skill) and a graph of clusters, with what builds on what. Click a skill to
 * open it; hover to see what it is linked to; scroll / drag to zoom and pan.
 */
export function SkillMap({
  skills,
  graph,
  onGraph,
  selected,
  onSelect,
  query,
}: {
  skills: SkillInfo[];
  graph: SkillGraph | null;
  onGraph: (g: SkillGraph) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  query: string;
}) {
  const { t, lang } = useT();
  const map = useMemo(() => buildMap(skills, graph, lang, t), [skills, graph, lang, t]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const fresh = graph ? skills.filter((s) => !graph.skillIds.includes(s.id)).length : 0;

  const organize = async () => {
    setBusy(true);
    setMsg('');
    try {
      onGraph(await api.organizeSkills());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── layout: a cluster per top-level topic around a circle, skills in a sunflower spiral inside it
  const layout = useMemo(() => {
    const roots = map.topics.filter((x) => !x.parent && map.nodes.some((n) => rootOf(map.topics, n.topic) === x.id));
    const k = roots.length;
    const R = k > 1 ? Math.min(W, H) * 0.34 : 0;
    const centre = new Map(roots.map((x, i) => [x.id, { x: W / 2 + R * 1.25 * Math.cos((2 * Math.PI * i) / k - Math.PI / 2), y: H / 2 + R * Math.sin((2 * Math.PI * i) / k - Math.PI / 2) }]));
    const pos = new Map<string, { x: number; y: number }>();
    for (const r of roots) {
      const c = centre.get(r.id)!;
      const members = map.nodes.filter((n) => rootOf(map.topics, n.topic) === r.id);
      const step = stepFor(members.length);
      members.forEach((n, j) => {
        const a = j * 2.39996;
        const d = step * Math.sqrt(j + 0.8);
        pos.set(n.skill.id, { x: c.x + d * Math.cos(a), y: c.y + d * Math.sin(a) });
      });
    }
    // how the topics hang together: links between skills of different topics, counted
    const between = new Map<string, { a: string; b: string; n: number; depends: number }>();
    for (const l of map.links) {
      const a = rootOf(map.topics, map.nodes.find((n) => n.skill.id === l.from)!.topic);
      const b = rootOf(map.topics, map.nodes.find((n) => n.skill.id === l.to)!.topic);
      if (a === b) continue;
      const key = [a, b].sort().join('~');
      const e = between.get(key) ?? { a, b, n: 0, depends: 0 };
      e.n++;
      if (l.kind === 'depends') e.depends++;
      between.set(key, e);
    }
    return { roots, centre, pos, between: [...between.values()] };
  }, [map]);

  // what is lit: the hovered / selected skill and its neighbours, a focused topic, or search matches
  const active = hover ?? selected;
  const near = useMemo(() => {
    if (!active) return null;
    const s = new Set([active]);
    for (const l of map.links) {
      if (l.from === active) s.add(l.to);
      if (l.to === active) s.add(l.from);
    }
    return s;
  }, [active, map.links]);
  const q = query.trim().toLowerCase();
  const lit = (n: Node) =>
    (!near || near.has(n.skill.id)) &&
    (!focus || rootOf(map.topics, n.topic) === focus) &&
    (!q || n.skill.name.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q));
  const showLabels = map.nodes.length <= 36;

  // ── zoom and pan
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const toSvg = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((cx - r.left) / r.width) * W, y: ((cy - r.top) / r.height) * H };
  };
  const zoom = (f: number, at = { x: W / 2, y: H / 2 }) =>
    setView((v) => {
      const k = Math.max(0.5, Math.min(4, v.k * f));
      return { k, x: at.x - ((at.x - v.x) * k) / v.k, y: at.y - ((at.y - v.y) * k) / v.k };
    });

  const neighbours = (id: string) => ({
    needs: map.links.filter((l) => l.kind === 'depends' && l.from === id).map((l) => l.to),
    usedBy: map.links.filter((l) => l.kind === 'depends' && l.to === id).map((l) => l.from),
    related: map.links.filter((l) => l.kind === 'related' && (l.from === id || l.to === id)).map((l) => (l.from === id ? l.to : l.from)),
  });
  const nameOf = (id: string) => map.nodes.find((n) => n.skill.id === id)?.skill.name ?? id;
  const hovered = hover ? map.nodes.find((n) => n.skill.id === hover) : undefined;

  const children = (parent?: string) => map.topics.filter((x) => (x.parent ?? undefined) === parent && (map.nodes.some((n) => n.topic === x.id) || map.topics.some((c) => c.parent === x.id)));
  const toggle = (id: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const topicRow = (x: Topic, depth: number): React.ReactNode => {
    const members = map.nodes.filter((n) => n.topic === x.id);
    const subs = children(x.id);
    const open = !closed.has(x.id);
    const count = map.nodes.filter((n) => n.topic === x.id || map.topics.find((s) => s.id === n.topic)?.parent === x.id).length;
    return (
      <li key={x.id} className={`map-topic depth-${depth} ${focus === x.id ? 'focus' : ''}`}>
        <button className="map-topic-head" onClick={() => toggle(x.id)} aria-expanded={open}>
          <span className="map-caret">{open ? '▾' : '▸'}</span>
          <b>{x.name}</b> <span className="muted tiny">{count}</span>
          {!x.parent && (
            <span
              className="map-focus link tiny"
              role="button"
              tabIndex={0}
              title={t.mapFocus}
              onClick={(e) => {
                e.stopPropagation();
                setFocus(focus === x.id ? null : x.id);
              }}
            >
              {focus === x.id ? '◉' : '○'}
            </span>
          )}
        </button>
        {x.summary && <div className="map-summary muted tiny">{x.summary}</div>}
        {open && (
          <ul>
            {subs.map((s) => topicRow(s, depth + 1))}
            {members.map((n) => {
              const nb = neighbours(n.skill.id);
              return (
                <li key={n.skill.id}>
                  <button
                    className={`map-skill ${selected === n.skill.id ? 'on' : ''} ${lit(n) ? '' : 'dim'}`}
                    onClick={() => onSelect(n.skill.id)}
                    onMouseEnter={() => setHover(n.skill.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <span className="map-skill-name">{n.skill.name}</span>
                    <span className="map-summary">{n.summary}</span>
                    {(nb.needs.length > 0 || nb.usedBy.length > 0) && (
                      <span className="map-deps tiny">
                        {nb.needs.length > 0 && <span>↳ {fmt(t.mapNeeds, { s: nb.needs.map(nameOf).join(', ') })}</span>}
                        {nb.usedBy.length > 0 && <span>↰ {fmt(t.mapUsedBy, { s: nb.usedBy.map(nameOf).join(', ') })}</span>}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className="card skill-map">
      <header className="map-bar">
        <button className="btn primary" disabled={busy || !skills.length} onClick={() => void organize()} title={t.mapOrganizeHelp}>
          ✨ {busy ? t.mapOrganizing : graph ? t.mapReorganize : t.mapOrganize}
        </button>
        <span className="muted tiny">
          {graph ? fmt(t.mapOrganized, { model: graph.model, when: relTime(graph.generatedAt, t, lang) }) : t.mapNotYet}
          {fresh > 0 && ` · ${fmt(t.mapFresh, { n: fresh })}`}
        </span>
      </header>
      {msg && <p className="action-msg small">{msg}</p>}
      <div className="map-body">
        <ul className="map-tree" aria-label={t.mapTree}>
          {children(undefined).map((x) => topicRow(x, 0))}
        </ul>
        <div className="map-graph">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={t.mapGraph}
            onWheel={(e) => {
              e.preventDefault();
              zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, toSvg(e.clientX, e.clientY));
            }}
            onPointerDown={(e) => {
              if ((e.target as Element).closest('.map-node, .map-cluster')) return;
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              const p = toSvg(e.clientX, e.clientY);
              pan.current = { x: p.x, y: p.y, vx: view.x, vy: view.y };
            }}
            onPointerMove={(e) => {
              if (!pan.current) return;
              const p = toSvg(e.clientX, e.clientY);
              setView((v) => ({ ...v, x: pan.current!.vx + p.x - pan.current!.x, y: pan.current!.vy + p.y - pan.current!.y }));
            }}
            onPointerUp={() => (pan.current = null)}
          >
            <defs>
              <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 Z" fill="var(--map-dep)" />
              </marker>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {/* topics that hang together: a band per pair, thicker with more links */}
              {layout.between.map((e) => {
                const a = layout.centre.get(e.a)!;
                const b = layout.centre.get(e.b)!;
                const on = !focus || focus === e.a || focus === e.b;
                return (
                  <line key={`${e.a}~${e.b}`} className={`map-band ${e.depends ? 'dep' : ''} ${on ? '' : 'dim'}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={Math.min(18, 3 + e.n * 2)}>
                    <title>{`${map.topics.find((x) => x.id === e.a)?.name} ↔ ${map.topics.find((x) => x.id === e.b)?.name}: ${e.n}`}</title>
                  </line>
                );
              })}
              {layout.roots.map((r) => {
                const c = layout.centre.get(r.id)!;
                const n = map.nodes.filter((x) => rootOf(map.topics, x.topic) === r.id).length;
                const rad = radiusFor(n);
                return (
                  <g key={r.id} className={`map-cluster ${!focus || focus === r.id ? '' : 'dim'}`} onClick={() => setFocus(focus === r.id ? null : r.id)}>
                    <circle cx={c.x} cy={c.y} r={rad} />
                    <text x={c.x} y={c.y - rad - 8} textAnchor="middle" className="map-cluster-name">
                      {r.name}
                    </text>
                  </g>
                );
              })}
              {map.links.map((l) => {
                const a = layout.pos.get(l.from);
                const b = layout.pos.get(l.to);
                if (!a || !b) return null;
                const on = near ? near.has(l.from) && near.has(l.to) && (l.from === active || l.to === active) : false;
                // bend each link a little, so links between the same clusters don't stack
                const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.15;
                const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.15;
                return (
                  <path
                    key={`${l.from}-${l.to}-${l.kind}`}
                    className={`map-link ${l.kind} ${on ? 'on' : ''} ${near && !on ? 'dim' : ''}`}
                    d={`M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`}
                    markerEnd={l.kind === 'depends' ? 'url(#map-arrow)' : undefined}
                  >
                    {l.note && <title>{l.note}</title>}
                  </path>
                );
              })}
              {map.nodes.map((n) => {
                const p = layout.pos.get(n.skill.id);
                if (!p) return null;
                const on = selected === n.skill.id || hover === n.skill.id;
                const deg = map.links.filter((l) => l.from === n.skill.id || l.to === n.skill.id).length;
                return (
                  <g
                    key={n.skill.id}
                    className={`map-node src-${n.skill.source} ${on ? 'on' : ''} ${lit(n) ? '' : 'dim'}`}
                    transform={`translate(${p.x} ${p.y})`}
                    onClick={() => onSelect(n.skill.id)}
                    onMouseEnter={() => setHover(n.skill.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <circle r={5 + Math.min(5, deg)} />
                    {(showLabels || on || (near?.has(n.skill.id) ?? false)) && (
                      <text y={-9 - Math.min(5, deg)} textAnchor="middle">
                        {n.skill.name}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          <div className="map-zoom">
            <button className="icon-btn" onClick={() => zoom(1.25)} aria-label="zoom in">
              +
            </button>
            <button className="icon-btn" onClick={() => zoom(0.8)} aria-label="zoom out">
              −
            </button>
            <button className="icon-btn" onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label="reset">
              ⟲
            </button>
          </div>
          {hovered && (
            <div className="map-tip">
              <b>{hovered.skill.name}</b>
              <span>{hovered.summary}</span>
            </div>
          )}
          <div className="map-legend muted tiny">
            <span>
              <i className="lg-dep" /> {t.mapDepends}
            </span>
            <span>
              <i className="lg-rel" /> {t.mapRelated}
            </span>
            <span>{t.mapHint}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
