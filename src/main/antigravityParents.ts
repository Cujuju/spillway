import Database from 'better-sqlite3-multiple-ciphers';
import { stat } from 'node:fs/promises';
import { antigravitySummaryDbs, clientLogKey } from './clientLogPaths';

const SUMMARIES_PARENTS_SQL = `
SELECT conversation_id AS child, parent_conversation_id AS parent
FROM conversation_summaries
WHERE parent_conversation_id IS NOT NULL AND parent_conversation_id <> ''`;

const LEGACY_PARENTS_SQL = `
SELECT conversation_id AS child, parent_id AS parent
FROM conversation_parents
WHERE parent_id IS NOT NULL AND parent_id <> ''`;

const HAS_PARENTS_TABLE_SQL = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_parents'`;

interface CachedParents { stamp: string; parents: Map<string, string> }
const parentDbCache = new Map<string, CachedParents>();

async function fileStamp(file: string): Promise<string | null> {
  try {
    const main = await stat(file);
    const wal = await stat(`${file}-wal`).catch(() => null);
    return `${main.mtimeMs}:${main.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
  } catch {
    return null;
  }
}

/** Reads child→parent conversation IDs from one Antigravity summary DB, cached by DB + WAL mtime/size. */
export async function readAntigravityParents(dbFile: string): Promise<ReadonlyMap<string, string>> {
  const key = clientLogKey(dbFile);
  const stamp = await fileStamp(dbFile);
  if (!stamp) {
    parentDbCache.delete(key);
    return new Map();
  }
  const cached = parentDbCache.get(key);
  if (cached && cached.stamp === stamp) return cached.parents;
  const parents = new Map<string, string>();
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      for (const row of db.prepare(SUMMARIES_PARENTS_SQL).all() as { child: string; parent: string }[]) {
        if (row.child && row.parent && row.child !== row.parent) parents.set(row.child, row.parent);
      }
      if (db.prepare(HAS_PARENTS_TABLE_SQL).get()) {
        for (const row of db.prepare(LEGACY_PARENTS_SQL).all() as { child: string; parent: string }[]) {
          if (row.child && row.parent && row.child !== row.parent && !parents.has(row.child)) parents.set(row.child, row.parent);
        }
      }
    } finally {
      db.close();
    }
    parentDbCache.set(key, { stamp, parents });
  } catch {
    // Missing table or transient lock: leave uncached so the next poll retries.
    return new Map();
  }
  return parents;
}

/** Reads every Antigravity summary DB and returns `agy:<child>` → `agy:<parent>` mappings. */
export async function readAllAntigravityParents(): Promise<Map<string, string>> {
  const all = new Map<string, string>();
  for (const dbFile of antigravitySummaryDbs()) {
    for (const [child, parent] of await readAntigravityParents(dbFile)) {
      all.set(`agy:${child}`, `agy:${parent}`);
    }
  }
  return all;
}
