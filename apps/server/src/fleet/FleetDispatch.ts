import {
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  ThreadId,
  type FleetRole,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { readCaller } from "../mcp/threadAccess.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as FleetService from "./FleetService.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const unavailable = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const incarnation = (role: FleetRole) =>
  role.incarnations.find(
    (entry) => entry.generation === role.currentGeneration && entry.releasedAt === null,
  );
const roleThreadId = (fleetId: string, roleId: string, generation: number) =>
  ThreadId.make(["fleet", fleetId, roleId, String(generation)].map(encodeURIComponent).join(":"));

export const assignFleetWork = Effect.fn("FleetDispatch.assignFleetWork")(function* (input: {
  readonly worker: string;
  readonly task: string;
  readonly clientRequestId: string;
  readonly worktreeBase?: string | undefined;
  readonly wakeLeader?: boolean | undefined;
}) {
  const { scope, caller, limits, threads } = yield* readCaller();
  const here = yield* McpInvocationContext.requireThreadScope(scope, "t3_fleet_assign");
  if (caller === undefined)
    return yield* invalid("Assign fleet work from the current leader chat.");
  const fleets = yield* FleetService.FleetService;
  const orchestration = yield* OrchestratorMcpService.OrchestratorMcpService;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const origin = { environmentId: here.environmentId, threadId: here.thread.threadId };
  const snapshot = yield* fleets
    .read({ threadId: origin.threadId })
    .pipe(Effect.mapError(unavailable));
  if (
    snapshot === null ||
    !snapshot.isCurrentAttachment ||
    !snapshot.fleet.roles.some(
      (role) =>
        role.id === snapshot.callerRoleId &&
        role.kind === "coordinator" &&
        role.lifecycle === "active",
    )
  )
    return yield* invalid("Assign fleet work from the current active leader chat.");
  const { fleet } = snapshot;
  if (fleet.lifecycle !== "active")
    return yield* invalid("Resume the fleet before assigning work.");
  const workers = fleet.roles.filter((role) => role.kind === "worker");
  const exactId = workers.find((role) => role.id === input.worker);
  const matches =
    exactId === undefined
      ? workers.filter((role) => role.name.toLowerCase() === input.worker.toLowerCase())
      : [exactId];
  if (matches.length !== 1)
    return yield* invalid(
      matches.length === 0
        ? "Worker not found. Read the fleet roster."
        : "Several workers use that name. Pass the worker ID from the roster.",
    );
  const worker = matches[0]!;
  if (worker.lifecycle !== "active")
    return yield* invalid(`The worker ${worker.name} is ${worker.lifecycle}.`);
  const current = incarnation(worker);
  if (current !== undefined && current.environmentId !== origin.environmentId)
    return yield* invalid("This fleet assignment tool supports local worker chats only.");
  const generation = current?.generation ?? (worker.incarnations.at(-1)?.generation ?? 0) + 1;
  const ownedThreadId = roleThreadId(fleet.id, worker.id, generation);
  const target = current?.threadId ?? ownedThreadId;
  const workspaceCommandId = CommandId.make(
    `fleet-worktree:${ownedThreadId}:${encodeURIComponent(input.clientRequestId)}`,
  );
  const workspaceStrategy =
    input.worktreeBase === undefined
      ? undefined
      : { type: "worktree" as const, baseRef: input.worktreeBase };
  if (workspaceStrategy !== undefined) {
    if (current !== undefined && current.threadId !== ownedThreadId) {
      return yield* invalid(
        "An attached worker keeps its current workspace. Disconnect its chat at a clean point before creating a new worktree.",
      );
    }
    yield* launches
      .checkWorktreeBase({
        projectId: fleet.projectId,
        workspaceStrategy,
        commandId: workspaceCommandId,
      })
      .pipe(Effect.mapError(unavailable));
  }
  if (current === undefined) {
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`fleet-open:${target}`),
        threadId: target,
        projectId: fleet.projectId,
        title: `${worker.name} · v${generation}`,
        modelSelection: caller.modelSelection,
        ...limits,
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(unavailable));
    const attached = yield* fleets
      .mutateAsLeader(origin, {
        type: "role.attach",
        commandId: CommandId.make(`fleet-attach:${target}:${fleet.revision}`),
        fleetId: fleet.id,
        expectedRevision: fleet.revision,
        roleId: worker.id,
        environmentId: origin.environmentId,
        threadId: target,
      })
      .pipe(Effect.mapError(unavailable));
    if (incarnation(attached.roles.find((role) => role.id === worker.id)!)?.threadId !== target)
      return yield* invalid("The worker attachment changed. Refresh the fleet roster.");
  }
  const requestWake = Effect.fn("FleetDispatch.requestWake")(function* (messageId: MessageId) {
    if (input.wakeLeader !== true) return;
    const accepted = yield* fleets
      .requestCompletionWake({ messageId, leaderThreadId: origin.threadId })
      .pipe(Effect.mapError(unavailable));
    if (!accepted)
      return yield* invalid(
        "The assignment was sent but its completion wake could not be registered. Read assignment history before retrying.",
      );
  });
  const sendKey = `fleet:${fleet.id}:${worker.id}:${input.clientRequestId}`;
  if (workspaceStrategy === undefined) {
    const sent = yield* orchestration.sendToThread(here, {
      threadId: target,
      message: input.task,
      mode: "queue",
      clientRequestId: sendKey,
    });
    yield* requestWake(sent.messageId);
    return sent;
  }
  const messageId = MessageId.make(`fleet-task:${workspaceCommandId}`);
  const launched = yield* launches
    .launch({
      commandId: workspaceCommandId,
      threadId: target,
      reuseExistingThread: true,
      projectId: fleet.projectId,
      title: `${worker.name} · v${generation}`,
      modelSelection: caller.modelSelection,
      ...limits,
      workspaceStrategy,
      createdBy: "agent",
      creationSource: "mcp",
      initialMessage: {
        messageId,
        senderThreadId: origin.threadId,
        text: input.task,
        attachments: [],
      },
    })
    .pipe(Effect.mapError(unavailable));
  const run = launched.projection.runs.find((candidate) => candidate.userMessageId === messageId);
  if (run === undefined)
    return yield* invalid("The worker launch did not record an assignment run.");
  yield* requestWake(messageId);
  return {
    threadId: target,
    link: formatThreadLink({ environmentId: origin.environmentId, threadId: target }, worker.name),
    messageId,
    runId: run.id,
    status: run.status,
    delivery: "queued" as const,
  };
});
