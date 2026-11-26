import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fleet_assignments ADD COLUMN wake_requested INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE fleet_assignments ADD COLUMN wake_enqueued_at TEXT`;
  yield* sql`ALTER TABLE fleet_assignments ADD COLUMN wake_retry_at TEXT`;
  yield* sql`
    CREATE INDEX fleet_assignments_wake_idx ON fleet_assignments(worker_run_id, wake_retry_at)
    WHERE wake_requested = 1 AND wake_enqueued_at IS NULL
  `;
});
