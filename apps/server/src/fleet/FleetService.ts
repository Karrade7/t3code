import {
  Fleet,
  FleetAssignmentsResult,
  type FleetAssignmentsInput,
  type EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  FleetCommandError,
  FleetMutation,
  FleetStorageError,
  type FleetId,
  type ScopedThreadRef,
  type FleetSnapshot,
  type FleetError,
  type FleetListInput,
  type FleetListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { planFleetCommand } from "./FleetCommands.ts";

export class FleetService extends Context.Service<
  FleetService,
  {
    readonly read: (input: {
      readonly fleetId?: FleetId;
      readonly threadId?: ThreadId;
      readonly threadEnvironmentId?: EnvironmentId;
    }) => Effect.Effect<FleetSnapshot | null, FleetStorageError>;
    readonly mutateAsLeader: (
      caller: ScopedThreadRef,
      input: FleetMutation,
    ) => Effect.Effect<Fleet, FleetError>;
    readonly assignments: (
      input: FleetAssignmentsInput,
    ) => Effect.Effect<FleetAssignmentsResult, FleetStorageError>;
    readonly requestCompletionWake: (input: {
      readonly messageId: MessageId;
      readonly leaderThreadId: ThreadId;
    }) => Effect.Effect<boolean, FleetStorageError>;
    readonly assignmentsAsLeader: (
      caller: ScopedThreadRef,
      input: Omit<FleetAssignmentsInput, "fleetId">,
    ) => Effect.Effect<FleetAssignmentsResult | null, FleetStorageError>;
    readonly list: (input: FleetListInput) => Effect.Effect<FleetListResult, FleetStorageError>;
    readonly mutate: (input: FleetMutation) => Effect.Effect<Fleet, FleetError>;
  }
>()("t3/fleet/FleetService") {}

const FleetJson = Schema.fromJsonString(Fleet);
const decodeFleet = Schema.decodeUnknownEffect(FleetJson);
const decodeAssignments = Schema.decodeUnknownEffect(FleetAssignmentsResult);
const encodeFleet = Schema.encodeEffect(FleetJson);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(FleetMutation));
const decodeCommand = Schema.decodeEffect(FleetMutation);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const list = Effect.fn("FleetService.list")(
    function* (input: FleetListInput) {
      const limit = input.limit ?? 50;
      const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM fleet_registry
      WHERE project_id = ${input.projectId}
        AND fleet_id > ${input.afterId ?? ""}
      ORDER BY fleet_id LIMIT ${limit + 1}
    `;
      const fleets = yield* Effect.forEach(rows.slice(0, limit), (row) =>
        decodeFleet(row.payload_json),
      );
      return { fleets, nextCursor: rows.length > limit ? fleets.at(-1)!.id : null };
    },
    Effect.mapError((cause) => new FleetStorageError({ operation: "read", cause })),
  );

  const assignments = Effect.fn("FleetService.assignments")(
    function* ({ fleetId, before, limit = 20 }: FleetAssignmentsInput) {
      const environmentId = yield* identity.getEnvironmentId;
      const [leader] =
        yield* sql`SELECT thread_id FROM fleet_current_leaders WHERE fleet_id = ${fleetId}`;
      const rows = yield* sql<{
        readonly message_id: string;
        readonly assigned_at: string;
        readonly worker_name: string;
        readonly worker_thread_id: string;
        readonly worker_run_id: string;
        readonly task_preview: string | null;
        readonly status: string | null;
        readonly pending_input: string | null;
        readonly progress_kind: string | null;
        readonly progress_title: string | null;
        readonly progress_at: string | null;
        readonly delivered_at: string | null;
        readonly delivered_to_thread_id: string | null;
      }>`
        SELECT a.message_id, a.assigned_at, a.worker_name, a.worker_thread_id, a.worker_run_id, run.status,
               substr(json_extract(message.payload_json, '$.text'), 1, 160) AS task_preview,
               a.delivered_at, a.delivered_to_thread_id,
               (SELECT CASE WHEN req.kind IN ('user_input', 'mcp-elicitation') THEN 'question'
                            ELSE 'approval' END
                FROM orchestration_v2_projection_runtime_requests req
                JOIN orchestration_v2_projection_nodes node ON node.node_id = req.node_id
                WHERE req.thread_id = a.worker_thread_id AND node.run_id = a.worker_run_id
                  AND req.status = 'pending' AND req.kind NOT IN ('dynamic_tool_call', 'auth_refresh')
                  AND run.status IN ('running', 'waiting')
                ORDER BY req.created_at LIMIT 1) AS pending_input,
               CASE activity.type WHEN 'command_execution' THEN 'command' WHEN 'reasoning' THEN 'thinking'
                    WHEN 'plan' THEN 'plan' WHEN 'assistant_message' THEN 'reply'
                    WHEN 'dynamic_tool' THEN 'tool' WHEN 'tool_call' THEN 'tool' END AS progress_kind,
               CASE WHEN activity.type IN ('dynamic_tool', 'tool_call')
                    THEN substr(json_extract(activity.payload_json, '$.title'), 1, 120) END AS progress_title,
               activity.updated_at AS progress_at
        FROM fleet_assignments a
        LEFT JOIN orchestration_v2_projection_runs run ON run.run_id = a.worker_run_id
        LEFT JOIN orchestration_v2_projection_messages message ON message.message_id = a.message_id
        LEFT JOIN orchestration_v2_projection_turn_items activity ON activity.turn_item_id = (
          SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
          WHERE item.run_id = a.worker_run_id
            AND run.status IN ('starting', 'running', 'waiting', 'interrupted', 'failed')
            AND item.type IN ('command_execution', 'dynamic_tool', 'tool_call', 'reasoning', 'plan', 'assistant_message')
          ORDER BY item.ordinal DESC LIMIT 1
        )
        WHERE a.fleet_id = ${fleetId}
          ${before === undefined ? sql` ` : sql`AND (a.assigned_at, a.message_id) < (${before.assignedAt}, ${before.messageId})`}
        ORDER BY a.assigned_at DESC, a.message_id DESC LIMIT ${limit + 1}
      `;
      const last = rows.length > limit ? rows[limit - 1] : undefined;
      return yield* decodeAssignments({
        leaderAvailable: leader !== undefined,
        assignments: rows.slice(0, limit).map((row) => ({
          messageId: MessageId.make(row.message_id),
          assignedAt: row.assigned_at,
          workerName: row.worker_name,
          workerChat: { environmentId, threadId: ThreadId.make(row.worker_thread_id) },
          workerRunId: RunId.make(row.worker_run_id),
          taskPreview: row.task_preview ?? "",
          status: row.status,
          ...(row.pending_input === null ? {} : { pendingInput: row.pending_input }),
          ...(row.progress_kind === null || row.progress_at === null
            ? {}
            : {
                progress: {
                  kind: row.progress_kind,
                  title: row.progress_title,
                  at: row.progress_at,
                },
              }),
          delivery:
            row.delivered_at === null || row.delivered_to_thread_id === null
              ? null
              : {
                  date: row.delivered_at,
                  chat: { environmentId, threadId: ThreadId.make(row.delivered_to_thread_id) },
                },
        })),
        nextCursor:
          last === undefined ? null : { assignedAt: last.assigned_at, messageId: last.message_id },
      });
    },
    Effect.mapError((cause) => new FleetStorageError({ operation: "read", cause })),
  );

  const requestCompletionWake = Effect.fn("FleetService.requestCompletionWake")(
    function* (input: { readonly messageId: MessageId; readonly leaderThreadId: ThreadId }) {
      const rows = yield* sql`
        UPDATE fleet_assignments SET wake_requested = 1
        WHERE message_id = ${input.messageId} AND leader_thread_id = ${input.leaderThreadId}
        RETURNING message_id
      `;
      return rows.length === 1;
    },
    Effect.mapError((cause) => new FleetStorageError({ operation: "mutate", cause })),
  );

  const assignmentsAsLeader = Effect.fn("FleetService.assignmentsAsLeader")(function* (
    caller: ScopedThreadRef,
    input: Omit<FleetAssignmentsInput, "fleetId">,
  ) {
    if (caller.environmentId !== (yield* identity.getEnvironmentId)) return null;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [leader] = yield* sql<{ readonly fleet_id: FleetId }>`
        SELECT fleet_id FROM fleet_current_leaders WHERE thread_id = ${caller.threadId}
      `;
          if (leader === undefined) return null;
          return yield* assignments({ ...input, fleetId: leader.fleet_id });
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new FleetStorageError({ operation: "read", cause })),
        }),
      );
  });

  const read = Effect.fn("FleetService.read")(
    function* (input: {
      readonly fleetId?: FleetId;
      readonly threadId?: ThreadId;
      readonly threadEnvironmentId?: EnvironmentId;
    }) {
      if (input.fleetId === undefined && input.threadId === undefined) return null;
      const environmentId = yield* identity.getEnvironmentId;
      const callerEnvironmentId = input.threadEnvironmentId ?? environmentId;
      const rows =
        input.fleetId !== undefined
          ? yield* sql<{
              readonly payload_json: string;
            }>`SELECT payload_json FROM fleet_registry WHERE fleet_id = ${input.fleetId}`
          : yield* sql<{ readonly payload_json: string }>`
            SELECT DISTINCT f.payload_json FROM fleet_registry f,
              json_each(f.payload_json, '$.roles') r,
              json_each(r.value, '$.incarnations') i
            WHERE json_extract(i.value, '$.threadId') = ${input.threadId!}
              AND json_extract(i.value, '$.environmentId') = ${callerEnvironmentId}
            ORDER BY EXISTS (
              SELECT 1 FROM fleet_thread_bindings b
              WHERE b.fleet_id = f.fleet_id AND b.thread_id = ${input.threadId!}
                AND ${callerEnvironmentId} = ${environmentId}
            ) DESC, json_extract(f.payload_json, '$.updatedAt') DESC LIMIT 1
          `;
      if (rows[0] === undefined) return null;
      const fleet = yield* decodeFleet(rows[0].payload_json);
      const matchesCaller = (session: Fleet["roles"][number]["incarnations"][number]) =>
        session.environmentId === callerEnvironmentId && session.threadId === input.threadId;
      const callerRole =
        fleet.roles.find((role) =>
          role.incarnations.some(
            (session) =>
              matchesCaller(session) &&
              session.generation === role.currentGeneration &&
              session.releasedAt === null,
          ),
        ) ?? fleet.roles.find((role) => role.incarnations.some(matchesCaller));
      const isCurrentAttachment =
        callerRole?.incarnations.some(
          (session) =>
            session.generation === callerRole.currentGeneration &&
            session.releasedAt === null &&
            session.environmentId === callerEnvironmentId &&
            session.threadId === input.threadId,
        ) ?? false;
      const sessions = yield* Effect.forEach(fleet.roles, (role) =>
        Effect.gen(function* () {
          if (role.lifecycle !== "active") return { roleId: role.id, state: role.lifecycle };
          const session = role.incarnations.find(
            (entry) => entry.generation === role.currentGeneration && entry.releasedAt === null,
          );
          if (session === undefined) return { roleId: role.id, state: "no session" };
          if (session.environmentId !== environmentId)
            return { roleId: role.id, state: "remote; inspect on execution server" };
          const [thread] = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${session.threadId} AND deleted_at IS NULL AND archived_at IS NULL`;
          if (thread === undefined) return { roleId: role.id, state: "unavailable" };
          const [run] = yield* sql<{
            readonly status: string;
          }>`SELECT status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${session.threadId} ORDER BY ordinal DESC LIMIT 1`;
          return {
            roleId: role.id,
            state:
              run === undefined || ["completed", "cancelled", "rolled_back"].includes(run.status)
                ? "idle"
                : run.status,
          };
        }),
      );
      return { fleet, callerRoleId: callerRole?.id ?? null, isCurrentAttachment, sessions };
    },
    Effect.mapError((cause) => new FleetStorageError({ operation: "read", cause })),
  );

  const mutate = Effect.fn("FleetService.mutate")(
    function* (input: FleetMutation) {
      const command = yield* decodeCommand(input);
      const commandJson = yield* encodeCommand(command);
      const environmentId = yield* identity.getEnvironmentId;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [receipt] = yield* sql<{
            readonly command_json: string;
            readonly result_json: string;
          }>`
        SELECT command_json, result_json FROM fleet_command_history WHERE command_id = ${command.commandId}
      `;
          if (receipt !== undefined) {
            if (receipt.command_json !== commandJson)
              return yield* new FleetCommandError({
                fleetId: command.fleetId,
                reason: "command_conflict",
              });
            return yield* decodeFleet(receipt.result_json);
          }
          const [row] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM fleet_registry WHERE fleet_id = ${command.fleetId}
      `;
          const current = row === undefined ? undefined : yield* decodeFleet(row.payload_json);
          const now = DateTime.formatIso(yield* DateTime.now);
          const planned = planFleetCommand(command, current, environmentId, now);
          if (Result.isFailure(planned)) return yield* planned.failure;
          const next = planned.success;
          const [project] = yield* sql`
        SELECT project_id FROM projection_projects
        WHERE project_id = ${next.projectId} AND deleted_at IS NULL
      `;
          if (project === undefined)
            return yield* new FleetCommandError({
              fleetId: command.fleetId,
              reason: "project_unavailable",
            });

          if (command.type === "role.attach" || command.type === "role.release") {
            const role = current?.roles.find((candidate) => candidate.id === command.roleId);
            const attachment = role?.incarnations.find(
              (candidate) => candidate.generation === role.currentGeneration,
            );
            const threadId =
              command.type === "role.attach" ? command.threadId : attachment?.threadId;
            const [thread] = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId ?? ""} AND deleted_at IS NULL AND archived_at IS NULL
        `;
            if (command.type === "role.attach" && thread === undefined)
              return yield* new FleetCommandError({
                fleetId: command.fleetId,
                reason: "thread_unavailable",
              });
            const [busy] = yield* sql`
          SELECT run_id FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId ?? ""}
            AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting') LIMIT 1
        `;
            if (busy !== undefined)
              return yield* new FleetCommandError({
                fleetId: command.fleetId,
                reason: "thread_busy",
              });
            if (command.type === "role.attach") {
              const [bound] =
                yield* sql`SELECT thread_id FROM fleet_thread_bindings WHERE thread_id = ${command.threadId}`;
              if (bound !== undefined)
                return yield* new FleetCommandError({
                  fleetId: command.fleetId,
                  reason: "attachment_exists",
                });
              yield* sql`
            INSERT INTO fleet_thread_bindings (thread_id, fleet_id, role_id)
            VALUES (${command.threadId}, ${command.fleetId}, ${command.roleId})
          `;
            } else {
              yield* sql`DELETE FROM fleet_thread_bindings WHERE fleet_id = ${command.fleetId} AND role_id = ${command.roleId}`;
            }
          }

          const resultJson = yield* encodeFleet(next);
          if (command.type === "create") {
            yield* sql`
          INSERT INTO fleet_registry (fleet_id, project_id, revision, payload_json)
          VALUES (${next.id}, ${next.projectId}, ${next.revision}, ${resultJson})
        `;
          } else {
            const changed = yield* sql`
          UPDATE fleet_registry SET revision = ${next.revision}, payload_json = ${resultJson}
          WHERE fleet_id = ${next.id} AND revision = ${command.expectedRevision}
          RETURNING fleet_id
        `;
            if (changed.length !== 1)
              return yield* new FleetCommandError({
                fleetId: command.fleetId,
                reason: "stale_revision",
              });
          }
          yield* sql`
        INSERT INTO fleet_command_history (command_id, fleet_id, revision, command_json, result_json, created_at)
        VALUES (${command.commandId}, ${next.id}, ${next.revision}, ${commandJson}, ${resultJson}, ${now})
      `;
          return next;
        }),
      );
    },
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(new FleetStorageError({ operation: "mutate", cause })),
      SchemaError: (cause) => Effect.fail(new FleetStorageError({ operation: "mutate", cause })),
    }),
  );

  const mutateAsLeader = Effect.fn("FleetService.mutateAsLeader")(function* (
    caller: ScopedThreadRef,
    input: FleetMutation,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const snapshot = yield* read({
            fleetId: input.fleetId,
            threadId: caller.threadId,
            threadEnvironmentId: caller.environmentId,
          });
          const role = snapshot?.fleet.roles.find(
            (candidate) => candidate.id === snapshot.callerRoleId,
          );
          if (!snapshot?.isCurrentAttachment || role?.kind !== "coordinator") {
            return yield* new FleetCommandError({
              fleetId: input.fleetId,
              reason: "leader_required",
            });
          }
          return yield* mutate(input);
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(new FleetStorageError({ operation: "mutate", cause })),
        }),
      );
  });

  return FleetService.of({
    list,
    assignments,
    assignmentsAsLeader,
    requestCompletionWake,
    read,
    mutate,
    mutateAsLeader,
  });
});

export const layer = Layer.effect(FleetService, make);
