import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  FleetId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { deliverReadyResults } from "./FleetResultDelivery.ts";
import * as FleetService from "./FleetService.ts";

const environmentId = EnvironmentId.make("test-server");
const fleetId = FleetId.make("fleet");
const layer = Layer.merge(RuntimeLayer.layerEventSink, FleetService.layer).pipe(
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Layer.mock(Orchestrator.OrchestratorV2)({})),
  Layer.provideMerge(Sqlite.layerMemory),
);
const leader = ThreadId.make("leader");
const successor = ThreadId.make("successor");
const worker = ThreadId.make("worker");
const workerRun = RunId.make("worker-run");
const task = MessageId.make("task-message");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const time = DateTime.formatIso(now);

it.effect("holds a finished result through rollover and publishes it once to the successor", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const fleets = yield* FleetService.FleetService;
    yield* sql`
      INSERT INTO fleet_registry (fleet_id, project_id, revision, payload_json) VALUES ('fleet', 'project', 1,
        '{"lifecycle":"active","roles":[{"id":"lead","kind":"coordinator","lifecycle":"active"},{"id":"work","kind":"worker","lifecycle":"active","name":"Build worker"}]}')
    `;
    yield* sql`INSERT INTO fleet_thread_bindings (thread_id, fleet_id, role_id) VALUES (${leader}, 'fleet', 'lead'), (${worker}, 'fleet', 'work')`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${leader}, 'project', 'Leader', 'codex', 'full-access', 'default', ${time}, ${time}, '{}'),
             (${successor}, 'project', 'Successor', 'codex', 'full-access', 'default', ${time}, ${time}, '{}'),
             (${worker}, 'project', 'Worker', 'codex', 'full-access', 'default', ${time}, ${time}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('leader-run', ${leader}, 1, 'codex', 'completed', ${time}, '{}'),
             (${workerRun}, ${worker}, 1, 'codex', 'running', ${time}, json_object('userMessageId', ${task}))
    `;
    yield* sink.write({
      events: [
        {
          id: EventId.make("assignment-event"),
          type: "message.updated",
          threadId: worker,
          runId: workerRun,
          occurredAt: now,
          payload: {
            id: task,
            threadId: worker,
            runId: workerRun,
            nodeId: null,
            role: "user",
            text: "Run the build",
            attachments: [],
            createdBy: "agent",
            creationSource: "mcp",
            senderThreadId: leader,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,root_node_id,kind,status,payload_json)
      VALUES ('worker-node', ${worker}, ${workerRun}, 'worker-node', 'task', 'running', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
      VALUES ('worker-request', ${worker}, 'worker-node', 'permission', 'pending', ${time}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
      VALUES ('worker-progress', ${worker}, ${workerRun}, 1, 'command_execution', 'running', ${time}, '{}')
    `;
    const history = fleets.assignments({ fleetId });
    const readAsLeader = (threadId: ThreadId) =>
      fleets.assignmentsAsLeader({ environmentId, threadId }, { limit: 1 });
    assert.deepEqual(yield* history, {
      leaderAvailable: true,
      assignments: [
        {
          messageId: task,
          assignedAt: time,
          workerName: "Build worker",
          workerRunId: workerRun,
          workerChat: { environmentId, threadId: worker },
          taskPreview: "Run the build",
          status: "running",
          pendingInput: "approval",
          progress: { kind: "command", title: null, at: time },
          delivery: null,
        },
      ],
      nextCursor: null,
    });
    assert.deepEqual(yield* readAsLeader(leader), yield* history);
    assert.isNull(yield* readAsLeader(worker));
    assert.isNull(
      yield* fleets.assignmentsAsLeader(
        { environmentId: EnvironmentId.make("another-server"), threadId: leader },
        {},
      ),
    );
    yield* deliverReadyResults();
    const notifications = sql`SELECT thread_id, json_extract(payload_json, '$.detail') AS reply FROM orchestration_v2_projection_turn_items WHERE type='notification'`;
    assert.deepEqual(yield* notifications, []);
    yield* sql`DELETE FROM fleet_thread_bindings WHERE thread_id=${leader}`;
    yield* sink.write({
      events: [
        {
          id: EventId.make("result-event"),
          type: "message.updated",
          threadId: worker,
          runId: workerRun,
          occurredAt: now,
          payload: {
            id: MessageId.make("reply"),
            threadId: worker,
            runId: workerRun,
            nodeId: null,
            role: "assistant",
            text: "Build passed.",
            attachments: [],
            createdBy: "agent",
            creationSource: "provider",
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed', completed_at=${time} WHERE run_id=${workerRun}`;
    yield* deliverReadyResults();
    assert.deepEqual(yield* notifications, []);
    const held = yield* history;
    assert.isFalse(held.leaderAvailable);
    assert.equal(held.assignments[0]?.status, "completed");
    assert.isNull(held.assignments[0]?.delivery);

    yield* sql`INSERT INTO fleet_thread_bindings (thread_id, fleet_id, role_id) VALUES (${successor}, ${fleetId}, 'lead')`;
    yield* Effect.all([deliverReadyResults(), deliverReadyResults()], { concurrency: "unbounded" });
    assert.deepEqual(yield* notifications, [{ thread_id: successor, reply: "Build passed." }]);
    assert.deepEqual(
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_runs WHERE thread_id IN (${leader}, ${successor})`,
      [{ thread_id: leader }],
    );
    const delivered = yield* history;
    assert.equal(delivered.assignments[0]?.delivery?.chat.threadId, successor);
    assert.isNull(yield* readAsLeader(leader));
    assert.deepEqual(yield* readAsLeader(successor), delivered);

    yield* sql`UPDATE fleet_thread_bindings SET thread_id=${leader} WHERE thread_id=${successor}`;
    yield* deliverReadyResults();
    assert.deepEqual(yield* notifications, [{ thread_id: successor, reply: "Build passed." }]);
    assert.deepEqual((yield* history).assignments[0]?.delivery, delivered.assignments[0]?.delivery);

    const interruptedRun = RunId.make("interrupted-run");
    const interruptedMessage = MessageId.make("interrupted-task-message");
    const later = "2026-01-02T00:00:00Z";
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${interruptedRun}, ${worker}, 2, 'codex', 'interrupted', ${later}, '{}')
    `;
    yield* sql`
      INSERT INTO fleet_assignments (message_id, fleet_id, leader_thread_id, worker_thread_id, worker_run_id, worker_name, assigned_at)
      VALUES (${interruptedMessage}, ${fleetId}, ${leader}, ${worker}, ${interruptedRun}, 'Build worker', ${later})
    `;
    const first = yield* readAsLeader(leader);
    assert.equal(first?.assignments[0]?.workerRunId, interruptedRun);
    assert.equal(first?.assignments[0]?.status, "interrupted");
    assert.deepEqual(first?.nextCursor, { assignedAt: later, messageId: interruptedMessage });
    const older = yield* fleets.assignmentsAsLeader(
      { environmentId, threadId: leader },
      { before: { assignedAt: later, messageId: interruptedMessage }, limit: 1 },
    );
    assert.deepEqual(older, delivered);

    assert.isFalse(
      yield* fleets.requestCompletionWake({
        messageId: interruptedMessage,
        leaderThreadId: worker,
      }),
    );
    assert.isTrue(
      yield* fleets.requestCompletionWake({
        messageId: interruptedMessage,
        leaderThreadId: leader,
      }),
    );
    const commitWake = (threadId: ThreadId) =>
      sink.commitCommand({
        commandId: CommandId.make("wake-interrupted-worker"),
        commandType: "message.dispatch",
        threadId,
        acceptedAt: now,
        fleetWakeAssignment: interruptedMessage,
        effects: [],
        events: [
          {
            id: EventId.make("wake-event"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("wake-item"),
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: null,
              startedAt: now,
              updatedAt: now,
              completedAt: now,
              type: "notification",
              source: { kind: "system" },
              outcome: "cancelled",
              summary: "Worker was interrupted",
            },
          },
        ],
      });
    const wrongLeader = yield* commitWake(successor).pipe(Effect.result);
    assert.isTrue(Result.isFailure(wrongLeader));
    assert.isTrue((yield* commitWake(leader)).committed);
    assert.isFalse((yield* commitWake(leader)).committed);
    assert.equal((yield* readAsLeader(leader))?.assignments[0]?.delivery?.chat.threadId, leader);
  }).pipe(Effect.provide(layer)),
);
