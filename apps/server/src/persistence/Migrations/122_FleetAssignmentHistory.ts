import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE fleet_assignments ADD COLUMN assigned_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`;
  yield* sql`ALTER TABLE fleet_assignments ADD COLUMN delivered_to_thread_id TEXT`;
  yield* sql`
    UPDATE fleet_assignments
    SET assigned_at = COALESCE((SELECT requested_at FROM orchestration_v2_projection_runs
                               WHERE run_id = fleet_assignments.worker_run_id), assigned_at),
        delivered_at = COALESCE(delivered_at, (SELECT updated_at FROM orchestration_v2_projection_turn_items
                                             WHERE turn_item_id = 'fleet-result:' || fleet_assignments.message_id)),
        delivered_to_thread_id = COALESCE((SELECT thread_id FROM orchestration_v2_projection_turn_items
                                         WHERE turn_item_id = 'fleet-result:' || fleet_assignments.message_id),
                                         CASE WHEN delivered_at IS NOT NULL THEN leader_thread_id END)
  `;
  yield* sql`
    CREATE INDEX fleet_assignments_history_idx
    ON fleet_assignments(fleet_id, assigned_at DESC, message_id DESC)
  `;
  yield* sql`
    CREATE VIEW fleet_current_leaders AS
    SELECT fleet.fleet_id, binding.thread_id
    FROM fleet_registry fleet
    JOIN json_each(fleet.payload_json, '$.roles') role
      ON json_extract(role.value, '$.kind') = 'coordinator'
     AND json_extract(role.value, '$.lifecycle') = 'active'
    JOIN fleet_thread_bindings binding ON binding.fleet_id = fleet.fleet_id
      AND binding.role_id = json_extract(role.value, '$.id')
    JOIN orchestration_v2_projection_threads thread ON thread.thread_id = binding.thread_id
      AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
    WHERE json_extract(fleet.payload_json, '$.lifecycle') <> 'retired'
  `;
});
