import { useGT } from "gt-react";
import {
  CommandId,
  type Fleet,
  type FleetMutation,
  type FleetRole,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { currentFleetConversation } from "@t3tools/client-runtime/state/fleets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useRef, useState } from "react";

import { newThreadId, randomUUID } from "../../lib/utils";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { fleetEnvironment } from "../../state/fleets";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

export function useFleetActions(
  project: EnvironmentProject,
  refresh: () => void,
  onOpenThread: (ref: ScopedThreadRef) => void,
) {
  const gt = useGT();
  const mutate = useAtomCommand(fleetEnvironment.mutate, { reportFailure: false });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opening = useRef(false);
  const apply = async (input: FleetMutation): Promise<Fleet | null> => {
    setBusy(true);
    setError(null);
    const result = await mutate({ environmentId: project.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not update the fleet."));
      refresh();
      return null;
    }
    return result.value;
  };
  const openChat = async (fleet: Fleet, role: FleetRole) => {
    const current = currentFleetConversation(role);
    if (current !== null) {
      onOpenThread(current);
      return;
    }
    if (opening.current) return;
    if (fleet.lifecycle !== "active" || role.lifecycle !== "active") {
      setError(gt("Resume this fleet and role before starting its chat."));
      return;
    }
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(project.environmentId);
    if (!config) {
      setError(gt("Connect this environment before starting a chat."));
      return;
    }
    const settings = resolveProjectSettings(config.settings, project.id, project).settings;
    const modelSelection =
      settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(config.providers, config.settings, project.id);
    if (!modelSelection) {
      setError(gt("Choose a default provider and model in project settings first."));
      return;
    }
    opening.current = true;
    setBusy(true);
    setError(null);
    const threadId = newThreadId();
    const result = await createThread({
      environmentId: project.environmentId,
      input: {
        threadId,
        projectId: project.id,
        title: role.kind === "coordinator" ? fleet.name : role.name,
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not create this chat."));
      setBusy(false);
      opening.current = false;
      return;
    }
    const attached = await apply({
      type: "role.attach",
      commandId: CommandId.make(randomUUID()),
      fleetId: fleet.id,
      expectedRevision: fleet.revision,
      roleId: role.id,
      environmentId: project.environmentId,
      threadId,
    });
    opening.current = false;
    if (attached) onOpenThread({ environmentId: project.environmentId, threadId });
    else
      setError(
        gt(
          "The chat was created, but the roster changed before it could be connected. Choose it from existing chats in role details; it remains in the project's chat list.",
        ),
      );
  };
  return { apply, openChat, busy, error };
}
