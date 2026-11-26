import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE fleet_assignments (
      message_id TEXT PRIMARY KEY,
      fleet_id TEXT NOT NULL REFERENCES fleet_registry(fleet_id),
      leader_thread_id TEXT NOT NULL,
      worker_thread_id TEXT NOT NULL,
      worker_run_id TEXT NOT NULL,
      worker_name TEXT NOT NULL,
      delivered_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX fleet_assignments_pending_idx ON fleet_assignments(worker_run_id)
    WHERE delivered_at IS NULL
  `;
});
