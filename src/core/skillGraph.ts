import fs from 'node:fs';
import path from 'node:path';
import type { L10n, SkillGraph, SkillInfo } from '../shared/types';
import { dataDir } from './config';

/** skills sent to the model at most (the rest stay out of the map) */
const MAX_SKILLS = 160;

/** Skills worth mapping: no copies VibePortal installed, the user's own before synced / system ones. */
export function mappable(skills: SkillInfo[]): SkillInfo[] {
  const rank = (s: SkillInfo) => (s.source === 'library' ? 0 : s.managed ? 3 : s.source === 'project' ? 2 : 1);
  return skills
    .filter((s) => !s.installedCopy)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS);
}

/** The instruction for the model; skills go by short keys (s1, s2, …) to keep it small. */
export function graphPrompt(skills: SkillInfo[]): string {
  const lines = skills.map((s, i) => `s${i + 1}\t${s.name}\t${s.description.replace(/\s+/g, ' ').slice(0, 220)}`);
  return [
    'You organize a developer\'s coding-agent skills into a knowledge map.',
    'Skills (key, name, description), one per line:',
    lines.join('\n'),
    [
      'Group them into a tree of 3-9 top-level topics (a topic may have sub-topics via "parent"; at most two levels).',
      'Give every topic and every skill a one-sentence summary (under 60 characters in English, under 30 characters in Chinese) in both English ("en") and Simplified Chinese ("zh").',
      'Add links between skills: "depends" when one builds on or needs the other first (from = the one that needs it), "related" when they are often used together. Only links that are clearly true; each with a short note in both languages.',
      'Reply with ONLY this JSON, no prose, no code fences:',
      '{"topics":[{"id":"t1","parent":null,"name":{"en":"","zh":""},"summary":{"en":"","zh":""}}],',
      '"skills":[{"key":"s1","topic":"t1","summary":{"en":"","zh":""}}],',
      '"links":[{"from":"s1","to":"s2","kind":"depends","note":{"en":"","zh":""}}]}',
      'Every skill key must appear exactly once in "skills".',
    ].join('\n'),
  ].join('\n\n');
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max) : '');
const l10n = (v: any, max: number, fallback = ''): L10n => {
  const en = str(v?.en, max) || str(v?.zh, max) || fallback;
  return { en, zh: str(v?.zh, max) || en };
};

/**
 * The model's reply turned into a graph that only refers to real skills and
 * topics: unknown keys are dropped, skills it left out land in an "Other" topic.
 */
export function parseGraph(reply: string, skills: SkillInfo[], model: string, now = new Date()): SkillGraph {
  let text = reply;
  try {
    text = JSON.parse(reply).result ?? reply;
  } catch {
    /* the bare reply */
  }
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('the model did not reply with a map');
  let raw: any;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    throw new Error('the model replied with broken JSON — try again');
  }
  const byKey = new Map(skills.map((s, i) => [`s${i + 1}`, s]));
  const topics: SkillGraph['topics'] = [];
  const topicIds = new Set<string>();
  for (const t of Array.isArray(raw?.topics) ? raw.topics : []) {
    const id = str(t?.id, 24);
    if (!id || topicIds.has(id)) continue;
    topicIds.add(id);
    topics.push({ id, ...(str(t?.parent, 24) ? { parent: str(t.parent, 24) } : {}), name: l10n(t?.name, 40, id), summary: l10n(t?.summary, 120) });
  }
  // a parent must exist and be top-level (two levels at most)
  for (const t of topics) if (t.parent && (!topicIds.has(t.parent) || t.parent === t.id || topics.find((x) => x.id === t.parent)?.parent)) delete t.parent;
  const placed = new Map<string, SkillGraph['skills'][number]>();
  for (const s of Array.isArray(raw?.skills) ? raw.skills : []) {
    const skill = byKey.get(str(s?.key, 8));
    if (!skill || placed.has(skill.id)) continue;
    const topic = topicIds.has(str(s?.topic, 24)) ? str(s.topic, 24) : 'other';
    placed.set(skill.id, { id: skill.id, topic, summary: l10n(s?.summary, 120, skill.description.slice(0, 120)) });
  }
  for (const skill of skills) if (!placed.has(skill.id)) placed.set(skill.id, { id: skill.id, topic: 'other', summary: { en: skill.description.slice(0, 120), zh: skill.description.slice(0, 120) } });
  if ([...placed.values()].some((s) => s.topic === 'other') && !topicIds.has('other'))
    topics.push({ id: 'other', name: { en: 'Other', zh: '其他' }, summary: { en: 'Skills that fit no topic yet', zh: '暂时没有归类的技能' } });
  const links: SkillGraph['links'] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(raw?.links) ? raw.links : []) {
    const from = byKey.get(str(l?.from, 8));
    const to = byKey.get(str(l?.to, 8));
    if (!from || !to || from.id === to.id) continue;
    const kind = l?.kind === 'depends' ? 'depends' : 'related';
    const k = kind === 'related' ? [from.id, to.id].sort().join('~') : `${from.id}>${to.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const note = l?.note ? l10n(l.note, 120) : undefined;
    links.push({ from: from.id, to: to.id, kind, ...(note?.en ? { note } : {}) });
  }
  // only topics that hold something (directly or through a sub-topic)
  const used = new Set([...placed.values()].map((s) => s.topic));
  for (const t of topics) if (t.parent && used.has(t.id)) used.add(t.parent);
  return {
    generatedAt: now.toISOString(),
    model,
    skillIds: skills.map((s) => s.id),
    topics: topics.filter((t) => used.has(t.id)),
    skills: [...placed.values()],
    links: links.slice(0, 400),
  };
}

/** The last map, in ~/.vibeportal/skill-graph.json. */
export class SkillGraphStore {
  private file = path.join(dataDir(), 'skill-graph.json');
  private running?: Promise<SkillGraph>;

  get(): SkillGraph | null {
    try {
      const g = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return g && Array.isArray(g.topics) && Array.isArray(g.skills) ? g : null;
    } catch {
      return null;
    }
  }

  /** Organizes the skills with `ask` (one map at a time: a second click waits for the first). */
  organize(skills: SkillInfo[], ask: (prompt: string) => Promise<string>, model: string): Promise<SkillGraph> {
    this.running ??= (async () => {
      const list = mappable(skills);
      if (!list.length) throw Object.assign(new Error('no skills to organize yet'), { status: 400 });
      const graph = parseGraph(await ask(graphPrompt(list)), list, model);
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(graph), { mode: 0o600 });
      return graph;
    })().finally(() => (this.running = undefined));
    return this.running;
  }
}
