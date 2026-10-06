import fs from 'node:fs';
import path from 'node:path';
import type { TaskInfo } from '../shared/types';
import { dataDir } from './config';

/** how many archived conversations are remembered (oldest forgotten first) */
const MAX_ARCHIVED = 2000;

/** Conversations that can be archived: nothing running and nothing waiting for you. */
export const isInactive = (t: Pick<TaskInfo, 'state'>) => t.state === 'idle' || t.state === 'done' || t.state === 'failed';

/**
 * Conversations put away with "Archive inactive": task id → the updatedAt it
 * was archived at. One that moves on afterwards (a new message, a run) no
 * longer matches its stamp and is back in the list by itself. Kept in
 * ~/.vibeportal/archived.json, so the phone and the desktop share it.
 */
export class TaskArchive {
  private file = path.join(dataDir(), 'archived.json');
  private map?: Record<string, string>;

  private load(): Record<string, string> {
    if (this.map) return this.map;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.map = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
    } catch {
      this.map = {};
    }
    return this.map!;
  }

  private save() {
    const m = this.load();
    const keys = Object.keys(m);
    if (keys.length > MAX_ARCHIVED) for (const k of keys.slice(0, keys.length - MAX_ARCHIVED)) delete m[k];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(m), { mode: 0o600 });
    } catch (e) {
      console.warn('[archive] could not save', (e as Error).message);
    }
  }

  /** Marks the tasks that are archived (and haven't moved on since). */
  mark(tasks: TaskInfo[]): TaskInfo[] {
    const m = this.load();
    return tasks.map((t) => (m[t.id] && m[t.id] === t.updatedAt && isInactive(t) ? { ...t, archived: true } : t));
  }

  /** Archives these tasks (only the inactive ones); returns how many. */
  archive(tasks: TaskInfo[]): number {
    const m = this.load();
    let n = 0;
    for (const t of tasks) {
      if (!isInactive(t)) continue;
      // re-insert so the newest archive is the last one forgotten
      delete m[t.id];
      m[t.id] = t.updatedAt;
      n++;
    }
    if (n) this.save();
    return n;
  }

  /** Brings these tasks back (all of them without ids); returns how many. */
  restore(ids?: string[]): number {
    const m = this.load();
    const drop = ids ?? Object.keys(m);
    let n = 0;
    for (const id of drop) if (id in m && delete m[id]) n++;
    if (n) this.save();
    return n;
  }
}
