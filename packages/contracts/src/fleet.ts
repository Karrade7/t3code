import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2.ts";

export const FleetId = TrimmedNonEmptyString.pipe(Schema.brand("FleetId"));
export type FleetId = typeof FleetId.Type;
export const FleetRoleId = TrimmedNonEmptyString.pipe(Schema.brand("FleetRoleId"));
export type FleetRoleId = typeof FleetRoleId.Type;

const FleetLifecycle = Schema.Literals(["active", "paused", "retired"]);
const FleetName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));

const FleetIncarnation = Schema.Struct({
  generation: PositiveInt,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  attachedAt: IsoDateTime,
  releasedAt: Schema.NullOr(IsoDateTime),
});

export const FleetRole = Schema.Struct({
  id: FleetRoleId,
  kind: Schema.Literals(["coordinator", "worker"]),
  name: FleetName,
  remit: Schema.String.check(Schema.isMaxLength(8000)),
  lifecycle: FleetLifecycle,
  currentGeneration: Schema.NullOr(PositiveInt),
  incarnations: Schema.Array(FleetIncarnation),
});
export type FleetRole = typeof FleetRole.Type;

export const Fleet = Schema.Struct({
  id: FleetId,
  projectId: ProjectId,
  environmentId: EnvironmentId,
  name: FleetName,
  lifecycle: FleetLifecycle,
  revision: PositiveInt,
  coordinatorEpoch: NonNegativeInt,
  roles: Schema.Array(FleetRole),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Fleet = typeof Fleet.Type;

const mutation = {
  commandId: CommandId,
  fleetId: FleetId,
  expectedRevision: PositiveInt,
};

export const FleetMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    commandId: CommandId,
    fleetId: FleetId,
    projectId: ProjectId,
    name: FleetName,
    coordinatorRoleId: FleetRoleId,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("worker.create"),
    roleId: FleetRoleId,
    name: FleetName,
    remit: Schema.String.check(Schema.isMaxLength(8000)),
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("lifecycle.set"),
    lifecycle: FleetLifecycle,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("role.lifecycle.set"),
    roleId: FleetRoleId,
    lifecycle: FleetLifecycle,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("role.attach"),
    roleId: FleetRoleId,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    ...mutation,
    type: Schema.Literal("role.release"),
    roleId: FleetRoleId,
  }),
]);
export type FleetMutation = typeof FleetMutation.Type;

export const FleetListInput = Schema.Struct({
  projectId: ProjectId,
  afterId: Schema.optionalKey(FleetId),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type FleetListInput = typeof FleetListInput.Type;
export const FleetListResult = Schema.Struct({
  fleets: Schema.Array(Fleet),
  nextCursor: Schema.NullOr(FleetId),
});
export type FleetListResult = typeof FleetListResult.Type;

const FleetAssignmentCursor = Schema.Struct({ assignedAt: IsoDateTime, messageId: MessageId });
export type FleetAssignmentCursor = typeof FleetAssignmentCursor.Type;

export const FleetAssignmentsInput = Schema.Struct({
  fleetId: FleetId,
  before: Schema.optionalKey(FleetAssignmentCursor),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(20))),
});
export type FleetAssignmentsInput = typeof FleetAssignmentsInput.Type;

export const FleetAssignmentsResult = Schema.Struct({
  assignments: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      assignedAt: IsoDateTime,
      workerName: FleetName,
      workerChat: ScopedThreadRef,
      workerRunId: Schema.optionalKey(RunId),
      taskPreview: Schema.String,
      status: Schema.NullOr(OrchestrationV2RunStatus),
      pendingInput: Schema.optionalKey(Schema.Literals(["question", "approval"])),
      progress: Schema.optionalKey(
        Schema.Struct({
          kind: Schema.Literals(["command", "tool", "thinking", "plan", "reply"]),
          title: Schema.NullOr(Schema.String),
          at: IsoDateTime,
        }),
      ),
      delivery: Schema.NullOr(Schema.Struct({ date: IsoDateTime, chat: ScopedThreadRef })),
    }),
  ),
  leaderAvailable: Schema.Boolean,
  nextCursor: Schema.NullOr(FleetAssignmentCursor),
});
export type FleetAssignmentsResult = typeof FleetAssignmentsResult.Type;

export const FleetSnapshot = Schema.Struct({
  fleet: Fleet,
  callerRoleId: Schema.NullOr(FleetRoleId),
  isCurrentAttachment: Schema.Boolean,
  sessions: Schema.Array(
    Schema.Struct({
      roleId: FleetRoleId,
      state: Schema.String,
    }),
  ),
});
export type FleetSnapshot = typeof FleetSnapshot.Type;

export class FleetCommandError extends Schema.TaggedError<FleetCommandError>()(
  "FleetCommandError",
  {
    fleetId: FleetId,
    reason: Schema.Literals([
      "not_found",
      "already_exists",
      "stale_revision",
      "command_conflict",
      "role_not_found",
      "role_exists",
      "retired",
      "paused",
      "attachment_exists",
      "attachment_missing",
      "attachments_present",
      "wrong_environment",
      "thread_unavailable",
      "thread_busy",
      "project_unavailable",
      "coordinator_required",
      "leader_required",
    ]),
  },
) {
  override get message(): string {
    const messages = {
      not_found: "This fleet no longer exists. Refresh the roster.",
      already_exists: "A fleet with this identity already exists.",
      stale_revision: "The roster changed. Refresh it and try again.",
      command_conflict: "This request identity was already used for a different change.",
      role_not_found: "This worker no longer exists. Refresh the roster.",
      role_exists: "A worker with this identity already exists.",
      retired: "Retired fleets and workers cannot receive new work or sessions.",
      paused: "Resume the fleet and worker before attaching a chat.",
      attachment_exists:
        "This role or chat is already attached. Release its current attachment first.",
      attachment_missing: "This role has no current chat to release.",
      attachments_present: "Release attached chats before retiring this worker or fleet.",
      wrong_environment: "A fleet can only attach chats from its own environment.",
      thread_unavailable: "This chat is missing or archived. Choose another chat.",
      thread_busy:
        "Wait for this chat's active work and questions to finish before changing its attachment.",
      project_unavailable: "The project for this fleet is no longer available.",
      coordinator_required: "Keep the leader role, or retire the whole fleet.",
      leader_required: "Only the currently attached fleet leader may manage this roster.",
    };
    return messages[this.reason];
  }
}

export class FleetStorageError extends Schema.TaggedError<FleetStorageError>()(
  "FleetStorageError",
  { operation: Schema.Literals(["read", "mutate"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Fleet storage operation '${this.operation}' failed.`;
  }
}

export const FleetError = Schema.Union([FleetCommandError, FleetStorageError]);
export type FleetError = typeof FleetError.Type;
