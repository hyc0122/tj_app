import type { Knex } from "knex";

const EMPTY_GRAPH = JSON.stringify({ nodes: [], edges: [] });
const DEFAULT_VIEWPORT = JSON.stringify({ x: 0, y: 0, zoom: 1 });
const DEFAULT_PREFERENCES = JSON.stringify({
  wheelMode: "zoom",
  snapToGrid: true,
  gridSize: 16,
});

/** 仅项目库安装画布业务表；设备 outbox 不得进入会同步的 project.sqlite。 */
export async function migrateCanvasProjectSchema(
  database: Knex | Knex.Transaction,
): Promise<void> {
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_documents (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      graph_json TEXT NOT NULL,
      viewport_json TEXT NOT NULL,
      preferences_json TEXT NOT NULL,
      home_initialization_state TEXT NOT NULL CHECK (home_initialization_state IN ('pending','consumed','disabled')),
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_revisions (
      revision_uuid TEXT PRIMARY KEY,
      document_revision INTEGER NOT NULL UNIQUE,
      graph_json TEXT NOT NULL,
      viewport_json TEXT NOT NULL,
      preferences_json TEXT NOT NULL,
      snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('automatic','manual','restore')),
      payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
      document_sha256 TEXT NOT NULL,
      is_pinned INTEGER NOT NULL CHECK (is_pinned IN (0,1)),
      pin_reason TEXT,
      pinned_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK ((is_pinned = 1 AND pin_reason IS NOT NULL AND pinned_at IS NOT NULL)
        OR (is_pinned = 0 AND pin_reason IS NULL AND pinned_at IS NULL))
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_revision_pin_mutations (
      client_mutation_id TEXT PRIMARY KEY,
      revision_uuid TEXT NOT NULL REFERENCES canvas_revisions(revision_uuid),
      operation TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_document_mutations (
      client_mutation_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      applied_revision INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_assets (
      asset_uuid TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      md5 TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      metadata_json TEXT,
      lifecycle_state TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_asset_references (
      asset_uuid TEXT NOT NULL REFERENCES canvas_assets(asset_uuid),
      source_type TEXT NOT NULL,
      source_uuid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (asset_uuid, source_type, source_uuid)
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_asset_gc (
      gc_uuid TEXT PRIMARY KEY,
      asset_uuid TEXT NOT NULL REFERENCES canvas_assets(asset_uuid),
      expected_sha256 TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      next_attempt_at TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_asset_mutations (
      client_asset_mutation_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      asset_uuid TEXT NOT NULL,
      response_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_import_jobs (
      import_uuid TEXT PRIMARY KEY,
      origin_device_uuid TEXT NOT NULL,
      client_mutation_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      archive_sha256 TEXT NOT NULL,
      archive_size_bytes INTEGER NOT NULL,
      base_revision INTEGER NOT NULL,
      importer_schema_version INTEGER NOT NULL,
      staging_relative_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'receiving','awaiting_reupload','queued','validating','staged','applying',
        'committed','aborting','aborted','failed','recovery_required'
      )),
      lease_owner TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      applied_revision INTEGER,
      total_items INTEGER NOT NULL DEFAULT 0,
      validated_items INTEGER NOT NULL DEFAULT 0,
      moved_items INTEGER NOT NULL DEFAULT 0,
      staged_manifest_json TEXT,
      accepted_at TEXT,
      acceptance_response_json TEXT,
      terminal_response_json TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_import_items (
      import_uuid TEXT NOT NULL REFERENCES canvas_import_jobs(import_uuid),
      ordinal INTEGER NOT NULL,
      source_asset_key TEXT NOT NULL,
      asset_uuid TEXT NOT NULL,
      validated_entry_name TEXT NOT NULL,
      staging_relative_path TEXT NOT NULL,
      target_relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('staged','moved','ready')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (import_uuid, ordinal),
      UNIQUE (import_uuid, source_asset_key)
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_import_action_receipts (
      import_uuid TEXT NOT NULL REFERENCES canvas_import_jobs(import_uuid),
      action_type TEXT NOT NULL,
      client_action_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL,
      audit_uuid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (import_uuid, action_type, client_action_id)
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_conversations (
      conversation_uuid TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_messages (
      message_uuid TEXT PRIMARY KEY,
      conversation_uuid TEXT NOT NULL REFERENCES canvas_conversations(conversation_uuid),
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      mutation_plan_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_chat_requests (
      client_chat_request_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      provider_idempotency_key TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      deployment_key TEXT NOT NULL,
      credential_slot_id TEXT NOT NULL,
      model_catalog_version TEXT NOT NULL,
      can_query_by_client_key INTEGER NOT NULL,
      can_replay_same_idempotency_key INTEGER NOT NULL,
      submission_generation INTEGER NOT NULL,
      dispatch_started_at TEXT NOT NULL,
      remote_request_id TEXT,
      state TEXT NOT NULL,
      user_message_uuid TEXT,
      assistant_message_uuid TEXT,
      plan_uuid TEXT,
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_applied_plans (
      plan_uuid TEXT PRIMARY KEY,
      base_revision INTEGER NOT NULL,
      applied_revision INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_execution_confirmations (
      confirmation_uuid TEXT PRIMARY KEY,
      origin_device_uuid TEXT NOT NULL,
      document_revision INTEGER NOT NULL,
      request_digest TEXT NOT NULL,
      capability_registry_version TEXT NOT NULL,
      model_catalog_version TEXT NOT NULL,
      immutable_items_json TEXT NOT NULL,
      ordered_request_digests_json TEXT NOT NULL,
      first_batch_uuid TEXT,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_execution_batches (
      batch_uuid TEXT PRIMARY KEY,
      confirmation_uuid TEXT NOT NULL REFERENCES canvas_execution_confirmations(confirmation_uuid),
      client_request_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      origin_device_uuid TEXT NOT NULL,
      state TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_node_runs (
      run_uuid TEXT PRIMARY KEY,
      batch_uuid TEXT NOT NULL REFERENCES canvas_execution_batches(batch_uuid),
      node_uuid TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      run_generation INTEGER NOT NULL,
      normalized_parameters_json TEXT NOT NULL,
      task_uuid TEXT,
      attempt INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'draft','awaiting_confirmation','waiting_for_origin_device','queued','leased',
        'submitting','submitted','running','succeeded','failed','canceled',
        'outcome_unknown','result_ready_conflict'
      )),
      failure_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_execution_events (
      event_uuid TEXT PRIMARY KEY,
      run_uuid TEXT NOT NULL REFERENCES canvas_node_runs(run_uuid),
      provider_id TEXT NOT NULL,
      provider_event_id TEXT,
      payload_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      processed_at TEXT
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_execution_intents (
      intent_uuid TEXT PRIMARY KEY,
      run_uuid TEXT NOT NULL REFERENCES canvas_node_runs(run_uuid),
      origin_device_uuid TEXT NOT NULL,
      receipt_uuid TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await database.raw(`
    CREATE TABLE IF NOT EXISTS canvas_execution_cancel_receipts (
      run_uuid TEXT NOT NULL,
      client_action_id TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL,
      audit_uuid TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_uuid, client_action_id)
    )
  `);
  const existing = await database("canvas_documents").where({ id: 1 }).first().catch(() => undefined);
  if (!existing) {
    await database("canvas_documents").insert({
      id: 1,
      schema_version: 1,
      revision: 0,
      graph_json: EMPTY_GRAPH,
      viewport_json: DEFAULT_VIEWPORT,
      preferences_json: DEFAULT_PREFERENCES,
      home_initialization_state: "pending",
      updated_at: new Date().toISOString(),
    });
  }
}
