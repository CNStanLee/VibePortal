import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './config';
import type { SkillDetail, SkillInfo, SkillSource } from '../shared/types';

const MAX_SKILL_BYTES = 2 << 20; // per skill folder
const MAX_FILES = 200;
const META = '.vibeportal.json';
const INSTALLED_MARK = '.vibeportal-installed';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

interface Meta {
  origin?: string;
  archivedAt?: string;
  cwd?: string;
  agent?: 'claude' | 'codex';
  manual?: boolean;
}

/**
 * Skills (folders with a SKILL.md) from every place the agents read them, plus
 * VibePortal's own library. Name / description come from the SKILL.md
 * frontmatter — nothing is summarised by a model. Skills that tasks write are
 * copied into the library automatically so they can be reused later.
 */
export class SkillStore {
  private cache?: { at: number; skills: SkillInfo[] };
  /** SKILL.md files seen at the first scan, so only later changes are auto-archived */
  private baseline?: Map<string, number>;
  private pending = new Map<string, { cwd?: string; agent?: 'claude' | 'codex' }>();

  constructor(private dirs: () => { claudeDir: string; codexDir: string; projects: string[] }) {}

  libraryDir(): string {
    return path.join(dataDir(), 'skills');
  }

  /** All skills, newest first. Cached briefly: scanning project folders isn't free. */
  list(force = false): SkillInfo[] {
    if (!force && this.cache && Date.now() - this.cache.at < 15_000) return this.cache.skills;
    const out: SkillInfo[] = [];
    const seen = new Set<string>();
    const add = (file: string, source: SkillSource, extra: Partial<SkillInfo> = {}) => {
      const real = safeReal(file);
      if (!real || seen.has(real)) return;
      seen.add(real);
      const info = readSkill(real, source, extra);
      if (info) out.push(info);
    };
    const d = this.dirs();
    for (const f of findSkills(this.libraryDir(), 2)) add(f, 'library', readMeta(path.dirname(f)));
    for (const f of findSkills(path.join(d.claudeDir, 'skills'), 4)) add(f, 'claude', { managed: f.includes(`${path.sep}synced${path.sep}`) || undefined });
    for (const f of findSkills(path.join(d.codexDir, 'skills'), 3)) add(f, 'codex', { managed: f.includes(`${path.sep}.system${path.sep}`) || undefined });
    for (const f of findSkills(path.join(os.homedir(), '.agents', 'skills'), 2)) add(f, 'agents');
    for (const p of d.projects) {
      for (const sub of ['.claude/skills', '.agents/skills', '.codex/skills']) {
        for (const f of findSkills(path.join(p, sub), 2)) add(f, 'project', { project: p });
      }
    }
    // installed copies point back at their library entry
    const lib = new Map(out.filter((s) => s.source === 'library').map((s) => [s.slug, s]));
    for (const s of out) {
      if ((s.source === 'claude' || s.source === 'codex') && fs.existsSync(path.join(s.dir, INSTALLED_MARK))) {
        const l = lib.get(path.basename(s.dir));
        if (l) l.installed = [...(l.installed ?? []), s.source];
        s.installedCopy = true;
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.cache = { at: Date.now(), skills: out };
    return out;
  }

  get(id: string): SkillDetail | undefined {
    const s = this.list().find((x) => x.id === id);
    if (!s) return undefined;
    let body = '';
    try {
      body = fs.readFileSync(s.path, 'utf8').slice(0, 200_000);
    } catch {
      /* gone */
    }
    return { ...s, body, files: listFiles(s.dir).map((f) => path.relative(s.dir, f)).slice(0, 100) };
  }

  /** A skill that a task wrote (Write / Edit / apply_patch on a SKILL.md). Archived at the next `flush`. */
  noteWrite(file: string, ctx: { cwd?: string; agent?: 'claude' | 'codex' } = {}) {
    if (path.basename(file) !== 'SKILL.md' || !path.isAbsolute(file)) return;
    if (file.startsWith(this.libraryDir() + path.sep)) return;
    this.pending.set(file, ctx);
  }

  /**
   * Archives skills written by tasks, and skills that appeared or changed in
   * the user / project skill folders since VibePortal started.
   */
  flush() {
    const skills = this.list(true);
    const now = new Map(skills.filter((s) => s.source !== 'library' && !s.managed && !s.installedCopy).map((s) => [s.path, Date.parse(s.updatedAt)]));
    if (!this.baseline) this.baseline = now;
    else {
      for (const [file, mtime] of now) {
        const before = this.baseline.get(file);
        if (before === undefined || mtime > before) this.pending.set(file, this.pending.get(file) ?? {});
      }
      this.baseline = now;
    }
    let changed = false;
    for (const [file, ctx] of this.pending) {
      this.pending.delete(file);
      try {
        if (this.archive(path.dirname(file), ctx)) changed = true;
      } catch (e) {
        console.warn('[skills] archive failed', file, (e as Error).message);
      }
    }
    if (changed) this.cache = undefined;
  }

  /** Copies a skill folder into the library (same origin → updated in place). */
  archive(dir: string, ctx: { cwd?: string; agent?: 'claude' | 'codex' } = {}): string | undefined {
    const src = safeReal(path.join(dir, 'SKILL.md'));
    if (!src) return undefined;
    const files = listFiles(dir);
    const size = files.reduce((n, f) => n + (fs.statSync(f).size || 0), 0);
    if (files.length > MAX_FILES || size > MAX_SKILL_BYTES) return undefined;
    const fm = frontmatter(fs.readFileSync(src, 'utf8'));
    const base = slugify(fm.name || path.basename(dir));
    const lib = this.libraryDir();
    // reuse the entry archived from the same folder, else find a free name
    let slug = base;
    for (let i = 2; fs.existsSync(path.join(lib, slug)); i++) {
      if (readMeta(path.join(lib, slug)).origin === dir) break;
      slug = `${base}-${i}`;
    }
    const dest = path.join(lib, slug);
    fs.rmSync(dest, { recursive: true, force: true });
    for (const f of files) {
      const to = path.join(dest, path.relative(dir, f));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f, to);
    }
    const meta: Meta = { origin: dir, archivedAt: new Date().toISOString(), cwd: ctx.cwd, agent: ctx.agent };
    fs.writeFileSync(path.join(dest, META), JSON.stringify(meta, null, 2));
    return slug;
  }

  create(input: { name: unknown; description: unknown; body: unknown }): SkillInfo {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 64) : '';
    const description = typeof input.description === 'string' ? oneLine(input.description).slice(0, 500) : '';
    const body = typeof input.body === 'string' ? input.body.slice(0, 200_000) : '';
    if (!name) throw httpError(400, 'name is required');
    if (!description) throw httpError(400, 'description is required (agents use it to decide when the skill applies)');
    const slug = slugify(name);
    const dest = path.join(this.libraryDir(), slug);
    if (fs.existsSync(dest)) throw httpError(409, `a skill named "${slug}" already exists`);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n\n${body.trim()}\n`);
    fs.writeFileSync(path.join(dest, META), JSON.stringify({ manual: true, archivedAt: new Date().toISOString() } satisfies Meta, null, 2));
    this.cache = undefined;
    return this.list().find((s) => s.dir === safeReal(dest))!;
  }

  /** Replaces SKILL.md of a library skill (installed copies are refreshed too). */
  update(id: string, content: unknown) {
    const s = this.library(id);
    if (typeof content !== 'string' || !content.trim()) throw httpError(400, 'content is required');
    if (!frontmatter(content).name) throw httpError(400, 'SKILL.md needs a frontmatter block with a name');
    fs.writeFileSync(s.path, content.slice(0, 200_000));
    for (const target of s.installed ?? []) this.install(id, target);
    this.cache = undefined;
  }

  remove(id: string) {
    const s = this.library(id);
    for (const target of s.installed ?? []) this.uninstall(id, target);
    fs.rmSync(s.dir, { recursive: true, force: true });
    this.cache = undefined;
  }

  /** Makes a library skill available to every Claude Code / Codex session. */
  install(id: string, target: 'claude' | 'codex') {
    const s = this.library(id);
    const dest = this.installDir(target, s.slug);
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, INSTALLED_MARK))) {
      throw httpError(409, `${dest} already exists and wasn't installed by VibePortal`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    for (const f of listFiles(s.dir)) {
      if (path.basename(f) === META) continue;
      const to = path.join(dest, path.relative(s.dir, f));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f, to);
    }
    fs.writeFileSync(path.join(dest, INSTALLED_MARK), `installed from ${s.dir}\n`);
    this.cache = undefined;
  }

  uninstall(id: string, target: 'claude' | 'codex') {
    const s = this.library(id);
    const dest = this.installDir(target, s.slug);
    if (!fs.existsSync(path.join(dest, INSTALLED_MARK))) throw httpError(404, 'not installed by VibePortal');
    fs.rmSync(dest, { recursive: true, force: true });
    this.cache = undefined;
  }

  /** Text prepended to a task prompt so the agent reads the chosen skills itself. */
  promptFor(ids: unknown): string {
    if (!Array.isArray(ids) || !ids.length) return '';
    const all = this.list();
    const picked = ids.slice(0, 10).map((id) => all.find((s) => s.id === id));
    if (picked.some((s) => !s)) throw httpError(400, 'unknown skill');
    const lines = picked.map((s) => `- ${s!.name}: ${s!.path}`);
    return `Use these skills for this task — read each SKILL.md before you start and follow it:\n${lines.join('\n')}\n\n`;
  }

  private library(id: string): SkillInfo {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw httpError(404, 'skill not found');
    if (s.source !== 'library') throw httpError(400, 'only skills in the VibePortal library can be changed here');
    return s;
  }

  private installDir(target: 'claude' | 'codex', slug: string): string {
    if (!SLUG_RE.test(slug)) throw httpError(400, 'invalid skill name');
    const d = this.dirs();
    return path.join(target === 'claude' ? d.claudeDir : d.codexDir, 'skills', slug);
  }
}

function readSkill(file: string, source: SkillSource, extra: Partial<SkillInfo>): SkillInfo | undefined {
  let text: string;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, 16_384));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return undefined;
  }
  const dir = path.dirname(file);
  const fm = frontmatter(text);
  const meta = source === 'library' ? readMeta(dir) : {};
  return {
    id: crypto.createHash('sha1').update(file).digest('hex').slice(0, 12),
    slug: path.basename(dir),
    name: fm.name || path.basename(dir),
    description: fm.description || firstLine(text),
    source,
    path: file,
    dir,
    updatedAt: st.mtime.toISOString(),
    origin: meta.origin,
    archivedAt: meta.archivedAt,
    manual: meta.manual,
    ...extra,
  } as SkillInfo;
}

/** name / description from a SKILL.md frontmatter block (single-line, quoted or folded values). */
export function frontmatter(text: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      // folded / literal block: the indented lines that follow
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    out[kv[1]] = unquote(v);
  }
  return out;
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1).replace(/''/g, "'");
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

function yamlScalar(s: string): string {
  return /^[\w .,()/-]+$/.test(s) && !/^\s|\s$/.test(s) ? s : JSON.stringify(s);
}

function firstLine(text: string): string {
  const body = text.replace(/^---[\s\S]*?---/, '');
  return (
    body
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean)
      ?.slice(0, 200) ?? ''
  );
}

function findSkills(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(path.join(dir, 'SKILL.md'));
      return; // a skill's own sub-folders are its resources
    }
    if (d >= depth) return;
    for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules') walk(path.join(dir, e.name), d + 1);
  };
  walk(root, 0);
  return out;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length > MAX_FILES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    /* unreadable */
  }
  return out;
}

function readMeta(dir: string): Meta {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
  } catch {
    return {};
  }
}

function safeReal(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64);
  return SLUG_RE.test(slug) ? slug : `skill-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 8)}`;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });
