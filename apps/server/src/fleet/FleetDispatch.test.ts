import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  FleetId,
  FleetRoleId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type FleetSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { assignFleetWork } from "./FleetDispatch.ts";
import * as FleetService from "./FleetService.ts";

const environmentId = EnvironmentId.make("local");
const leader = ThreadId.make("leader");
const worker = ThreadId.make("author");
const coordinatorRoleId = FleetRoleId.make("leader-role");
const assignedAt = "2026-01-01T00:00:00.000Z";
const scope = {
  environmentId,
  issuedAt: 0,
  requestNamespace: "test-leader",
  capabilities: new Set(["orchestration"] as const),
  thread: {
    threadId: leader,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
} satisfies McpInvocationContext.McpInvocationScope;
const snapshot: FleetSnapshot = {
  callerRoleId: coordinatorRoleId,
  isCurrentAttachment: true,
  sessions: [],
  fleet: {
    id: FleetId.make("fleet"),
    name: "Local fleet",
    projectId: liveThreadShell(leader).projectId,
    environmentId,
    lifecycle: "active",
    revision: 2,
    coordinatorEpoch: 1,
    createdAt: assignedAt,
    updatedAt: assignedAt,
    roles: [
      {
        id: coordinatorRoleId,
        name: "Leader",
        kind: "coordinator",
        lifecycle: "active",
        remit: "",
        currentGeneration: 1,
        incarnations: [],
      },
      {
        id: FleetRoleId.make("author-role"),
        name: "Build author",
        kind: "worker",
        lifecycle: "active",
        remit: "",
        currentGeneration: 1,
        incarnations: [
          {
            threadId: worker,
            environmentId,
            generation: 1,
            attachedAt: assignedAt,
            releasedAt: null,
          },
        ],
      },
      {
        id: FleetRoleId.make("old-role"),
        name: "Old author",
        kind: "worker",
        lifecycle: "retired",
        remit: "",
        currentGeneration: null,
        incarnations: [],
      },
    ],
  },
};

const fixture = (binding: FleetSnapshot) => {
  const sends: Parameters<
    OrchestratorMcpService.OrchestratorMcpService["Service"]["sendToThread"]
  >[1][] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(FleetService.FleetService)({ read: () => Effect.succeed(binding) }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(leader)),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      sendToThread: (_scope, input) =>
        Effect.sync(() => {
          sends.push(input);
          return {
            threadId: input.threadId,
            messageId: MessageId.make("message"),
            runId: RunId.make("run"),
            status: "queued" as const,
            delivery: "queued" as const,
          };
        }),
    }),
  );
  return { layer, sends };
};

it.effect("queues successive assignments in the same named worker chat", () => {
  const { layer, sends } = fixture(snapshot);
  return Effect.gen(function* () {
    yield* assignFleetWork({
      worker: "Build Author",
      task: "Write a failing test",
      clientRequestId: "red",
    });
    yield* assignFleetWork({
      worker: "author-role",
      task: "Fix the test",
      clientRequestId: "green",
    });
    assert.deepEqual(
      sends.map(({ threadId, mode }) => [threadId, mode]),
      [
        [worker, "queue"],
        [worker, "queue"],
      ],
    );
    assert.notEqual(sends[0]?.clientRequestId, sends[1]?.clientRequestId);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses retired workers and requests from a former leader", () => {
  const current = fixture(snapshot);
  const former = fixture({ ...snapshot, isCurrentAttachment: false });
  return Effect.gen(function* () {
    const retired = yield* Effect.result(
      assignFleetWork({ worker: "Old author", task: "Continue work", clientRequestId: "old" }).pipe(
        Effect.provide(current.layer),
      ),
    );
    const noLongerLeader = yield* Effect.result(
      assignFleetWork({
        worker: "Build author",
        task: "Continue work",
        clientRequestId: "old",
      }).pipe(Effect.provide(former.layer)),
    );
    assert.isTrue(Result.isFailure(retired));
    assert.isTrue(Result.isFailure(noLongerLeader));
    assert.deepEqual([...current.sends, ...former.sends], []);
  });
});
