import type { MessageId, OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const recordFleetAssignments = Effect.fn("FleetAssignments.record")(function* (
  sql: SqlClient.SqlClient,
  events: readonly OrchestrationV2StoredEvent[],
) {
  for (const { event } of events) {
    if (event.type !== "message.updated") continue;
    const message = event.payload;
    if (
      message.role !== "user" ||
      message.createdBy !== "agent" ||
      message.creationSource !== "mcp" ||
      message.senderThreadId === undefined ||
      message.runId === null ||
      message.senderThreadId === message.threadId
    )
      continue;
    // The run's original input identifies an assignment; steering only joins existing work.
    yield* sql`
      INSERT INTO fleet_assignments (message_id, fleet_id, leader_thread_id, worker_thread_id, worker_run_id, worker_name, assigned_at)
      SELECT ${message.id}, fleet.fleet_id, leader.thread_id, worker.thread_id, run.run_id,
             json_extract(worker_role.value, '$.name'), run.requested_at
      FROM fleet_thread_bindings leader
      JOIN fleet_thread_bindings worker ON worker.fleet_id = leader.fleet_id
      JOIN fleet_registry fleet ON fleet.fleet_id = leader.fleet_id
      JOIN orchestration_v2_projection_runs run ON run.run_id = ${message.runId}
      JOIN json_each(fleet.payload_json, '$.roles') leader_role
        ON json_extract(leader_role.value, '$.id') = leader.role_id
      JOIN json_each(fleet.payload_json, '$.roles') worker_role
        ON json_extract(worker_role.value, '$.id') = worker.role_id
      WHERE leader.thread_id = ${message.senderThreadId} AND worker.thread_id = ${message.threadId}
        AND run.thread_id = worker.thread_id AND json_extract(run.payload_json, '$.userMessageId') = ${message.id}
        AND json_extract(fleet.payload_json, '$.lifecycle') = 'active'
        AND json_extract(leader_role.value, '$.kind') = 'coordinator'
        AND json_extract(leader_role.value, '$.lifecycle') = 'active'
        AND json_extract(worker_role.value, '$.kind') = 'worker'
        AND json_extract(worker_role.value, '$.lifecycle') = 'active'
      ON CONFLICT (message_id) DO NOTHING
    `;
  }
});

export const claimFleetResult = Effect.fn("FleetAssignments.claimResult")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly messageId: MessageId;
    readonly threadId: ThreadId;
    readonly deliveredAt: string;
  },
) {
  const claimed = yield* sql`
    UPDATE fleet_assignments
    SET delivered_at = ${input.deliveredAt}, delivered_to_thread_id = ${input.threadId}
    WHERE message_id = ${input.messageId} AND delivered_at IS NULL
      AND EXISTS (SELECT 1 FROM fleet_current_leaders leader
                  WHERE leader.fleet_id = fleet_assignments.fleet_id AND leader.thread_id = ${input.threadId})
    RETURNING message_id
  `;
  return claimed.length === 1;
});

/** Consume the wake in the transaction that queues the next leader turn. */
export const claimFleetWake = Effect.fn("FleetAssignments.claimWake")(function* (
  sql: SqlClient.SqlClient,
  input: { readonly messageId: MessageId; readonly threadId: ThreadId; readonly at: string },
) {
  const rows = yield* sql`
    UPDATE fleet_assignments
    SET wake_enqueued_at = ${input.at}, delivered_at = COALESCE(delivered_at, ${input.at}),
        delivered_to_thread_id = COALESCE(delivered_to_thread_id, ${input.threadId})
    WHERE message_id = ${input.messageId} AND wake_requested = 1 AND wake_enqueued_at IS NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run
                  WHERE run.run_id = fleet_assignments.worker_run_id
                    AND run.status IN ('completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'))
      AND EXISTS (SELECT 1 FROM fleet_current_leaders leader
                  WHERE leader.fleet_id = fleet_assignments.fleet_id AND leader.thread_id = ${input.threadId})
    RETURNING message_id
  `;
  return rows.length === 1;
});
