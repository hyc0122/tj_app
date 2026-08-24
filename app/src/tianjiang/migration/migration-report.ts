export interface MigrationTableReport {
  table: string;
  sourceRows: number;
  migratedRows: number;
  recoveryRows: number;
  excludedRows: number;
  classification: "account_mapping" | "profile" | "project_catalog" | "project_data" | "recovery";
}

export interface MigrationFileReport {
  sourceCount: number;
  sourceBytes: number;
  migratedCount: number;
  recoveryCount: number;
  aggregateMD5: string;
}

export interface MigrationReport {
  migrationId: string;
  sourceDatabase: string;
  sourceIntegrity: "ok";
  backupPath: string;
  reportPath: string;
  targetDataRoot: string;
  totalSourceRows: number;
  totalAccountPasswordsMigrated: 0;
  tables: MigrationTableReport[];
  files: MigrationFileReport;
  projectMappings: Record<string, string>;
  createdPaths: string[];
  completedAt: string;
}
