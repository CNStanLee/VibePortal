import fs from 'node:fs';
import path from 'node:path';

/**
 * Incrementally tails JSONL files: each call to `read` only parses bytes appended
 * since the previous call. Log files from Claude Code / Codex can be tens of MB,
 * so re-parsing them on every poll is not an option.
 */
export class JsonlTailer {
  private offsets = new Map<string, { offset: number; ino: number }>();

  /** Returns true when the file was (re)started from scratch, e.g. after truncation. */
  read(file: string, onLine: (obj: any) => void, filter?: (line: string) => boolean): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      this.offsets.delete(file);
      return false;
    }
    let state = this.offsets.get(file);
    let restarted = false;
    if (!state || st.size < state.offset || st.ino !== state.ino) {
      state = { offset: 0, ino: st.ino };
      this.offsets.set(file, state);
      restarted = true;
    }
    if (st.size === state.offset) return restarted;

    const fd = fs.openSync(file, 'r');
    try {
      const CHUNK = 1 << 20;
      const buf = Buffer.alloc(CHUNK);
      let pos = state.offset;
      let pending = Buffer.alloc(0);
      // Only bytes up to the last complete line are consumed; a partially written
      // trailing line (or a split multi-byte character) is re-read next time.
      let consumed = state.offset;
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const chunk = Buffer.concat([pending, buf.subarray(0, n)]);
        const nl = chunk.lastIndexOf(0x0a);
        if (nl < 0) {
          pending = chunk;
          continue;
        }
        for (const line of chunk.toString('utf8', 0, nl).split('\n')) if (!filter || filter(line)) parseLine(line, onLine);
        pending = chunk.subarray(nl + 1);
        consumed = pos - pending.length;
      }
      state.offset = consumed;
    } finally {
      fs.closeSync(fd);
    }
    return restarted;
  }

  forget(file: string) {
    this.offsets.delete(file);
  }

  known(): string[] {
    return [...this.offsets.keys()];
  }
}

function parseLine(line: string, onLine: (obj: any) => void) {
  const s = line.trim();
  if (!s) return;
  try {
    onLine(JSON.parse(s));
  } catch {
    // partial or corrupt line — ignore
  }
}

/** Recursively lists *.jsonl files modified after `sinceMs`, up to `maxDepth` levels. */
export function findJsonl(root: string, sinceMs: number, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p);
        } catch {
          /* raced with deletion */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Lets the event loop breathe while chewing through large log directories. */
export const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export function localDate(ts: number | string | Date): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
