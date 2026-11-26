import { type Fleet, type FleetRole, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentThreadShell } from "./models.ts";

export function currentFleetConversation(role: FleetRole) {
  return (
    role.incarnations.find((incarnation) => incarnation.generation === role.currentGeneration) ??
    null
  );
}

export function fleetRoleStatus(
  role: FleetRole,
  thread: Pick<
    EnvironmentThreadShell,
    "deletedAt" | "archivedAt" | "hasPendingApprovals" | "hasPendingUserInput" | "latestRun"
  > | null,
) {
  if (role.lifecycle !== "active") return role.lifecycle;
  if (role.currentGeneration === null) return "no session";
  if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null)
    return "unavailable";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs you";
  if (thread.latestRun?.status === "failed") return "failed";
  if (thread.latestRun?.status === "interrupted") return "interrupted";
  if (
    thread.latestRun &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.latestRun.status)
  )
    return thread.latestRun.status === "waiting" ? "waiting" : "working";
  return "idle";
}

export function createFleetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:fleets:list",
    tag: WS_METHODS.fleetsList,
    staleTimeMs: 5_000,
    refreshIntervalMs: 15_000,
    execute: Effect.fn("fleets.listAll")(function* (input) {
      const fleets: Fleet[] = [];
      let page = yield* request(WS_METHODS.fleetsList, { projectId: input.projectId, limit: 100 });
      fleets.push(...page.fleets);
      while (page.nextCursor !== null) {
        page = yield* request(WS_METHODS.fleetsList, {
          projectId: input.projectId,
          limit: 100,
          afterId: page.nextCursor,
        });
        fleets.push(...page.fleets);
      }
      return { fleets, nextCursor: null };
    }),
  });
  const assignments = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:fleets:assignments",
    tag: WS_METHODS.fleetsAssignments,
    staleTimeMs: 2_000,
    refreshIntervalMs: 5_000,
    execute: (input) => request(WS_METHODS.fleetsAssignments, input),
  });
  return {
    list,
    assignments,
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fleets:mutate",
      tag: WS_METHODS.fleetsMutate,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.fleetId}`,
      },
      onSuccess: ({ environmentId }, registry, fleet) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId, input: { projectId: fleet.projectId } })),
        ),
    }),
  };
}
