import {
  CommandId,
  EventId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Notification,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

export const deliverReadyResults = Effect.fn("FleetResultDelivery.deliverReadyResults")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const engine = yield* Orchestrator.OrchestratorV2;
    const now = yield* DateTime.now;
    const attemptedAt = DateTime.formatIso(now);
    const ready = yield* sql<{
      readonly message_id: string;
      readonly leader_thread_id: string;
      readonly leader_run_id: string | null;
      readonly worker_name: string;
      readonly worker_run_id: string;
      readonly worker_thread_id: string;
      readonly delivered_at: string | null;
      readonly wake_due: number;
      readonly status: "completed" | "cancelled" | "interrupted" | "failed" | "rolled_back";
      readonly reply: string | null;
    }>`
    SELECT a.message_id, leader.thread_id AS leader_thread_id, a.worker_name, worker_run.status,
           a.worker_run_id, a.worker_thread_id, a.delivered_at,
           (a.wake_requested = 1 AND a.wake_enqueued_at IS NULL
             AND (a.wake_retry_at IS NULL OR a.wake_retry_at <= ${attemptedAt})) AS wake_due,
           (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = leader.thread_id ORDER BY ordinal DESC LIMIT 1) AS leader_run_id,
           (SELECT json_extract(m.payload_json, '$.text')
            FROM orchestration_v2_projection_messages m
            WHERE m.thread_id = a.worker_thread_id AND m.run_id = a.worker_run_id
              AND m.role = 'assistant' AND m.streaming = 0
              AND length(trim(json_extract(m.payload_json, '$.text'))) > 0
            ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS reply
    FROM fleet_assignments a
    JOIN orchestration_v2_projection_runs worker_run ON worker_run.run_id = a.worker_run_id
    JOIN fleet_current_leaders leader ON leader.fleet_id = a.fleet_id
    WHERE (a.delivered_at IS NULL OR (a.wake_requested = 1 AND a.wake_enqueued_at IS NULL
             AND (a.wake_retry_at IS NULL OR a.wake_retry_at <= ${attemptedAt})))
      AND worker_run.status IN ('completed', 'cancelled', 'interrupted', 'failed', 'rolled_back')
    ORDER BY worker_run.completed_at, a.message_id LIMIT 25
  `;
    yield* Effect.forEach(
      ready,
      (assignment) =>
        Effect.gen(function* () {
          const key = `fleet-result:${assignment.message_id}`;
          const threadId = ThreadId.make(assignment.leader_thread_id);
          const runId =
            assignment.leader_run_id === null ? null : RunId.make(assignment.leader_run_id);
          const outcome: OrchestrationV2Notification["outcome"] =
            assignment.status === "completed"
              ? "completed"
              : assignment.status === "failed"
                ? "failed"
                : "cancelled";
          const reply = assignment.reply?.trim();
          const detail =
            reply === undefined || reply === ""
              ? undefined
              : reply.length <= 16_000
                ? reply
                : `${reply.slice(0, 16_000)}\n\n[Result truncated. Open the worker chat for the full reply.]`;
          const assignmentMessageId = MessageId.make(assignment.message_id);
          const notification = {
            source: { kind: "system" as const },
            outcome,
            summary: `${assignment.worker_name}: assignment ${assignment.status}`,
            ...(detail === undefined ? {} : { detail }),
          };
          if (assignment.wake_due === 1) {
            const wakeKey = `fleet-wake:${encodeURIComponent(assignment.message_id)}:${encodeURIComponent(threadId)}`;
            const wake = yield* engine
              .dispatchFleetWake(
                {
                  type: "message.dispatch",
                  commandId: CommandId.make(wakeKey),
                  threadId,
                  messageId: MessageId.make(`message:${wakeKey}`),
                  text: `Resume the fleet assignment you asked to continue on completion. The worker ended as ${assignment.status}. Worker thread ${assignment.worker_thread_id}, run ${assignment.worker_run_id}. Read the exact run before deciding the next action.`,
                  notification,
                  attachments: [],
                  dispatchMode: { type: "queue_after_active" },
                  createdBy: "agent",
                  creationSource: "server",
                },
                assignmentMessageId,
              )
              .pipe(Effect.result);
            if (Result.isSuccess(wake)) return;
            const retryAt = DateTime.formatIso(DateTime.add(now, { seconds: 30 }));
            yield* sql`UPDATE fleet_assignments SET wake_retry_at = ${retryAt}
                       WHERE message_id = ${assignmentMessageId} AND wake_enqueued_at IS NULL`;
            yield* Effect.logWarning("Fleet leader wake failed", { threadId, cause: wake.failure });
          }
          if (assignment.delivered_at !== null) return;
          yield* sink.writeFleetResult({
            assignmentMessageId,
            event: {
              id: EventId.make(key),
              type: "turn-item.updated",
              threadId,
              ...(runId === null ? {} : { runId }),
              occurredAt: now,
              payload: {
                id: TurnItemId.make(key),
                threadId,
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "notification",
                ...notification,
              },
            },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Fleet result delivery failed", { cause }),
          ),
        ),
      { discard: true },
    );
  },
);

export const layer = Layer.effectDiscard(
  deliverReadyResults().pipe(
    Effect.catchCause((cause) => Effect.logWarning("Fleet result scan failed", { cause })),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  ),
);
