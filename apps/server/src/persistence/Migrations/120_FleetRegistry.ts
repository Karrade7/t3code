import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fleet_registry (
      fleet_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
    )
  `;
  yield* sql`CREATE INDEX fleet_registry_project_idx ON fleet_registry(project_id, fleet_id)`;
  yield* sql`
    CREATE TABLE fleet_thread_bindings (
      thread_id TEXT PRIMARY KEY,
      fleet_id TEXT NOT NULL REFERENCES fleet_registry(fleet_id),
      role_id TEXT NOT NULL,
      UNIQUE (fleet_id, role_id)
    )
  `;
  yield* sql`
    CREATE TABLE fleet_command_history (
      command_id TEXT PRIMARY KEY,
      fleet_id TEXT NOT NULL REFERENCES fleet_registry(fleet_id),
      revision INTEGER NOT NULL,
      command_json TEXT NOT NULL CHECK (json_valid(command_json)),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at TEXT NOT NULL,
      UNIQUE (fleet_id, revision)
    )
  `;
});
