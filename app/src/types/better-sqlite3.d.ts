declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  interface Statement {
    run(...parameters: unknown[]): RunResult;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  }
  class Database {
    constructor(filename: string, options?: Record<string, unknown>);
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(source: string): unknown;
    close(): void;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    backup(filename: string): Promise<{ totalPages: number; remainingPages: number }>;
    readonly open: boolean;
  }
  namespace Database {
    type Database = InstanceType<typeof import("better-sqlite3").default>;
  }
  export default Database;
}
