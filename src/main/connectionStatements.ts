import type { Db } from './activityDb';
import type Database from 'better-sqlite3-multiple-ciphers';

/** Fixed statement sets live exactly as long as their database connection. */
export function connectionStatements<T extends Record<string, string>>(sql: T) {
  type Statements = { [K in keyof T]: Database.Statement };
  const connections = new WeakMap<Db, Statements>();
  return (db: Db): Statements => {
    let statements = connections.get(db);
    if (!statements) {
      statements = Object.fromEntries(Object.entries(sql).map(([key, query]) => [key, db.prepare(query)])) as Statements;
      connections.set(db, statements);
    }
    return statements;
  };
}
