import {
  type EnvironmentId,
  type Fleet,
  FleetCommandError,
  type FleetMutation,
  type FleetRole,
} from "@t3tools/contracts";
import * as Result from "effect/Result";

export function planFleetCommand(
  command: FleetMutation,
  current: Fleet | undefined,
  environmentId: EnvironmentId,
  now: string,
): Result.Result<Fleet, FleetCommandError> {
  const refuse = (reason: FleetCommandError["reason"]) =>
    Result.fail(new FleetCommandError({ fleetId: command.fleetId, reason }));
  if (command.type === "create") {
    if (current !== undefined) return refuse("already_exists");
    return Result.succeed({
      id: command.fleetId,
      projectId: command.projectId,
      environmentId,
      name: command.name,
      lifecycle: "active",
      revision: 1,
      coordinatorEpoch: 0,
      roles: [
        {
          id: command.coordinatorRoleId,
          kind: "coordinator",
          name: command.name,
          remit: "Coordinate this fleet's workers and decisions.",
          lifecycle: "active",
          currentGeneration: null,
          incarnations: [],
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }
  if (current === undefined) return refuse("not_found");
  if (current.environmentId !== environmentId) return refuse("wrong_environment");
  if (current.revision !== command.expectedRevision) return refuse("stale_revision");
  if (current.lifecycle === "retired") return refuse("retired");
  const next = { ...current, revision: current.revision + 1, updatedAt: now };
  switch (command.type) {
    case "worker.create":
      if (current.roles.some((role) => role.id === command.roleId)) return refuse("role_exists");
      return Result.succeed({
        ...next,
        roles: [
          ...current.roles,
          {
            id: command.roleId,
            kind: "worker",
            name: command.name,
            remit: command.remit,
            lifecycle: "active",
            currentGeneration: null,
            incarnations: [],
          },
        ],
      });
    case "lifecycle.set":
      if (
        command.lifecycle === "retired" &&
        current.roles.some((role) => role.currentGeneration !== null)
      )
        return refuse("attachments_present");
      return Result.succeed({
        ...next,
        lifecycle: command.lifecycle,
        roles:
          command.lifecycle === "retired"
            ? current.roles.map((role) => ({ ...role, lifecycle: "retired" as const }))
            : current.roles,
      });
    default: {
      const role = current.roles.find((candidate) => candidate.id === command.roleId);
      if (role === undefined) return refuse("role_not_found");
      if (role.lifecycle === "retired") return refuse("retired");
      let updated: FleetRole;
      let coordinatorEpoch = current.coordinatorEpoch;
      switch (command.type) {
        case "role.lifecycle.set":
          if (role.kind === "coordinator" && command.lifecycle === "retired")
            return refuse("coordinator_required");
          if (command.lifecycle === "retired" && role.currentGeneration !== null)
            return refuse("attachments_present");
          updated = { ...role, lifecycle: command.lifecycle };
          break;
        case "role.attach": {
          if (current.lifecycle !== "active" || role.lifecycle !== "active")
            return refuse("paused");
          if (command.environmentId !== environmentId) return refuse("wrong_environment");
          if (role.currentGeneration !== null) return refuse("attachment_exists");
          const generation = (role.incarnations.at(-1)?.generation ?? 0) + 1;
          updated = {
            ...role,
            currentGeneration: generation,
            incarnations: [
              ...role.incarnations,
              {
                generation,
                environmentId,
                threadId: command.threadId,
                attachedAt: now,
                releasedAt: null,
              },
            ],
          };
          if (role.kind === "coordinator") coordinatorEpoch++;
          break;
        }
        case "role.release":
          if (role.currentGeneration === null) return refuse("attachment_missing");
          updated = {
            ...role,
            currentGeneration: null,
            incarnations: role.incarnations.map((incarnation) =>
              incarnation.generation === role.currentGeneration
                ? { ...incarnation, releasedAt: now }
                : incarnation,
            ),
          };
          if (role.kind === "coordinator") coordinatorEpoch++;
          break;
      }
      return Result.succeed({
        ...next,
        coordinatorEpoch,
        roles: current.roles.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      });
    }
  }
}
