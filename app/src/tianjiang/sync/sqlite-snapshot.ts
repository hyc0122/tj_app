import fs from "node:fs";
import Database from "better-sqlite3";

export interface SQLiteValidation {
  integrity: "ok";
  schemaVersion: number;
}

export async function createSQLiteSnapshot(source: string, destination: string): Promise<void> {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  validateSQLiteDatabase(destination);
}

export function validateSQLiteDatabase(filename: string, expectedSchemaVersion?: number): SQLiteValidation {
  const header = Buffer.alloc(16);
  const file = fs.openSync(filename, "r");
  try {
    if (fs.readSync(file, header, 0, header.length, 0) !== header.length ||
      header.toString("ascii") !== "SQLite format 3\u0000") {
      throw new Error("SQLite 文件头无效");
    }
  } finally {
    fs.closeSync(file);
  }
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = database.pragma("integrity_check") as Array<Record<string, string>>;
    if (!integrityRows.some((row) => Object.values(row).includes("ok"))) {
      throw new Error("SQLite integrity_check 失败");
    }
    const versionRows = database.pragma("user_version") as Array<Record<string, number>>;
    const schemaVersion = Number(Object.values(versionRows[0] ?? { user_version: 0 })[0]);
    if (expectedSchemaVersion !== undefined && schemaVersion !== expectedSchemaVersion) {
      throw new Error(`SQLite schema 版本不匹配: ${schemaVersion}`);
    }
    return { integrity: "ok", schemaVersion };
  } finally {
    database.close();
  }
}
