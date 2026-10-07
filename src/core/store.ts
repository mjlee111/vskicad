import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const DONE_MARKER = '.done';

/**
 * Owns export output directories under one root (the extension's global storage).
 * Layout: <root>/<sessionId>/<kind>-<key>/. Each preview panel gets its own session
 * directory, which is removed when the panel closes.
 */
export class OutputStore {
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  newSession(): string {
    const id = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.join(this.root, id), { recursive: true });
    return id;
  }

  /** Returns the output directory for a key and whether a completed export already exists there. */
  entry(session: string, kind: string, key: string): { dir: string; cached: boolean } {
    const dir = path.join(this.root, session, `${kind}-${key}`);
    return { dir, cached: fs.existsSync(path.join(dir, DONE_MARKER)) };
  }

  /** Clears a partially written directory before a fresh export. */
  reset(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  markDone(dir: string, meta: unknown): void {
    fs.writeFileSync(path.join(dir, DONE_MARKER), JSON.stringify(meta));
  }

  readMeta<T>(dir: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, DONE_MARKER), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** Removes other outputs of the same kind so only the latest export is kept. */
  pruneKind(session: string, kind: string, keepDir: string): void {
    const base = path.join(this.root, session);
    let names: string[] = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(base, n);
      if (n.startsWith(kind + '-') && path.resolve(p) !== path.resolve(keepDir)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }

  removeSession(session: string): void {
    fs.rmSync(path.join(this.root, session), { recursive: true, force: true });
  }

  /** Deletes session directories older than maxAgeMs, e.g. left behind by a crashed window. */
  purgeStale(maxAgeMs: number, activeSessions: Set<string>): number {
    let removed = 0;
    const now = Date.now();
    for (const n of fs.readdirSync(this.root)) {
      if (activeSessions.has(n)) continue;
      const p = path.join(this.root, n);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Ignore entries removed concurrently by another window.
      }
    }
    return removed;
  }
}

/** Deletes files in dir older than maxAgeMs (used for snapshot images). */
export function purgeOldFiles(dir: string, maxAgeMs: number): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Ignore entries removed concurrently by another window.
    }
  }
  return removed;
}
