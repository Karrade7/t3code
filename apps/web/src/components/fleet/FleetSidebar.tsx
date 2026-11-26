import { T, useGT } from "gt-react";
import { randomUUID } from "../../lib/utils";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  FleetId,
  FleetRoleId,
  ThreadId,
  type Fleet,
  type FleetMutation,
  type FleetRole,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { currentFleetConversation, fleetRoleStatus } from "@t3tools/client-runtime/state/fleets";
import { useState } from "react";
import {
  MoreHorizontalIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  Settings2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { fleetEnvironment } from "../../state/fleets";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { FleetAssignments } from "./FleetAssignments";
import { useFleetActions } from "./useFleetActions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import {
  Combobox,
  ComboboxInput,
  ComboboxPopup,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "../ui/combobox";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

type ApplyMutation = (input: FleetMutation) => Promise<Fleet | null>;
type OpenChat = (fleet: Fleet, role: FleetRole) => Promise<void>;

interface FleetProjectProps {
  project: EnvironmentProject;
  threads: readonly EnvironmentThreadShell[];
  supported: boolean;
  assignmentsSupported?: boolean;
  activeThread: ScopedThreadRef | null;
  environmentLabel: string | null;
  onOpenThread: (ref: ScopedThreadRef) => void;
}

export function FleetProject({
  project,
  threads,
  supported,
  assignmentsSupported = false,
  activeThread,
  environmentLabel,
  onOpenThread,
}: FleetProjectProps) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(true);
  const [managerOpen, setManagerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addWorkerId, setAddWorkerId] = useState<string | null>(null);
  const [roleDetails, setRoleDetails] = useState<{ fleetId: string; roleId: string } | null>(null);
  const query = useEnvironmentQuery(
    supported
      ? fleetEnvironment.list({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );
  const fleets = query.data?.fleets ?? [];
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const actions = useFleetActions(project, query.refresh, (ref) => {
    setManagerOpen(false);
    setRoleDetails(null);
    onOpenThread(ref);
  });
  const disabled = !canOperate || actions.busy;
  const projectThreads = threads.filter(
    (thread) =>
      thread.projectId === project.id &&
      thread.environmentId === project.environmentId &&
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      thread.lineage.relationshipToParent !== "subagent" &&
      !thread.lineage.sideChat,
  );
  const rosterThreads = new Set(
    fleets.flatMap((fleet) =>
      fleet.roles.flatMap((role) => role.incarnations.map((incarnation) => incarnation.threadId)),
    ),
  );
  const otherThreads = projectThreads.filter((thread) => !rosterThreads.has(thread.id));
  const addWorkerFleet = fleets.find((fleet) => fleet.id === addWorkerId) ?? null;
  const detailFleet = fleets.find((fleet) => fleet.id === roleDetails?.fleetId) ?? null;
  const detailRole = detailFleet?.roles.find((role) => role.id === roleDetails?.roleId) ?? null;
  const manage = (fleet: Fleet) => {
    setSelectedId(fleet.id);
    setManagerOpen(true);
  };
  return (
    <section
      aria-label={gt("{project} fleet navigation", { project: project.title })}
      className="py-1"
    >
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm font-medium hover:bg-sidebar-row-hover"
        >
          <span aria-hidden>{expanded ? "▾" : "▸"}</span>
          <span className="min-w-0 flex-1 truncate">{project.title}</span>
          {environmentLabel ? (
            <span className="max-w-20 truncate text-xs text-muted-foreground">
              {environmentLabel}
            </span>
          ) : null}
        </button>
        {supported ? (
          <>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={gt("Manage fleets in {project}", { project: project.title })}
              title={gt("Manage fleets")}
              onClick={() => setManagerOpen(true)}
            >
              <Settings2Icon className="size-4" />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={gt("Refresh fleets in {project}", { project: project.title })}
              title={gt("Refresh fleets")}
              onClick={query.refresh}
              disabled={query.isPending}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
          </>
        ) : null}
      </div>
      <div className="ml-3 border-l border-border pl-2">
        {supported ? (
          <>
            {query.error || actions.error ? (
              <p role="alert" className="px-2 py-1 text-xs text-destructive">
                {actions.error ?? query.error}
              </p>
            ) : null}
            {expanded
              ? fleets.map((fleet) => (
                  <FleetTree
                    key={fleet.id}
                    fleet={fleet}
                    threads={threads}
                    activeThread={activeThread}
                    disabled={disabled}
                    openChat={actions.openChat}
                    onManage={() => manage(fleet)}
                    onAddWorker={() => setAddWorkerId(fleet.id)}
                    onRoleDetails={(role) => setRoleDetails({ fleetId: fleet.id, roleId: role.id })}
                  />
                ))
              : null}
            <Dialog open={managerOpen} onOpenChange={setManagerOpen}>
              <DialogPopup>
                <DialogHeader>
                  <DialogTitle>
                    <T>Manage fleets ·</T> {project.title}
                  </DialogTitle>
                  <DialogDescription>
                    <T>Select or search for a fleet. Enter a new name to create one.</T>
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  <FleetManager
                    key={selectedId ?? "new"}
                    project={project}
                    fleets={fleets}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    threads={threads}
                    disabled={disabled}
                    apply={actions.apply}
                    openChat={actions.openChat}
                    onOpenThread={(ref) => {
                      setManagerOpen(false);
                      onOpenThread(ref);
                    }}
                    onAddWorker={(fleet) => setAddWorkerId(fleet.id)}
                    error={actions.error}
                    assignmentsSupported={assignmentsSupported}
                  />
                </DialogPanel>
              </DialogPopup>
            </Dialog>
            <Dialog
              open={detailRole !== null}
              onOpenChange={(open) => {
                if (!open) setRoleDetails(null);
              }}
            >
              <DialogPopup>
                <DialogHeader>
                  <DialogTitle>
                    {detailRole?.kind === "coordinator" ? detailFleet?.name : detailRole?.name}
                  </DialogTitle>
                  <DialogDescription>
                    <T>Conversation settings and previous chats.</T>
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  {actions.error ? (
                    <p role="alert" className="text-sm text-destructive">
                      {actions.error}
                    </p>
                  ) : null}
                  {detailFleet && detailRole ? (
                    <FleetRoleEditor
                      key={detailRole.id}
                      fleet={detailFleet}
                      role={detailRole}
                      threads={threads}
                      disabled={disabled || detailFleet.lifecycle === "retired"}
                      apply={actions.apply}
                      onOpenThread={(ref) => {
                        setRoleDetails(null);
                        onOpenThread(ref);
                      }}
                    />
                  ) : null}
                </DialogPanel>
              </DialogPopup>
            </Dialog>
            <Dialog
              open={addWorkerFleet !== null}
              onOpenChange={(open) => {
                if (!open) setAddWorkerId(null);
              }}
            >
              <DialogPopup>
                <DialogHeader>
                  <DialogTitle>
                    <T>Add worker ·</T> {addWorkerFleet?.name}
                  </DialogTitle>
                  <DialogDescription>
                    <T>
                      Name the worker and describe its responsibilities. Its empty chat opens after
                      creation.
                    </T>
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  {addWorkerFleet ? (
                    <AddWorker
                      key={addWorkerFleet.id}
                      fleet={addWorkerFleet}
                      disabled={disabled}
                      apply={actions.apply}
                      openChat={actions.openChat}
                      onDone={() => setAddWorkerId(null)}
                      error={actions.error}
                    />
                  ) : null}
                </DialogPanel>
              </DialogPopup>
            </Dialog>
          </>
        ) : (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>Update this environment to use fleets.</T>
          </p>
        )}
        {expanded
          ? otherThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                aria-current={
                  activeThread?.threadId === thread.id &&
                  activeThread.environmentId === thread.environmentId
                    ? "page"
                    : undefined
                }
                onClick={() =>
                  onOpenThread({ environmentId: thread.environmentId, threadId: thread.id })
                }
                className="block w-full truncate rounded-md py-1.5 pr-2 pl-7 text-left text-sm hover:bg-sidebar-row-hover aria-[current=page]:bg-sidebar-row-hover"
              >
                {thread.title}
              </button>
            ))
          : null}
      </div>
    </section>
  );
}

function FleetTree({
  fleet,
  threads,
  activeThread,
  disabled,
  openChat,
  onManage,
  onAddWorker,
  onRoleDetails,
}: {
  fleet: Fleet;
  threads: readonly EnvironmentThreadShell[];
  activeThread: ScopedThreadRef | null;
  disabled: boolean;
  openChat: OpenChat;
  onManage: () => void;
  onAddWorker: () => void;
  onRoleDetails: (role: FleetRole) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const leader = fleet.roles.find((role) => role.kind === "coordinator");
  const workers = fleet.roles.filter(
    (role) => role.kind === "worker" && role.lifecycle !== "retired",
  );
  const retired = fleet.roles.filter(
    (role) => role.kind === "worker" && role.lifecycle === "retired",
  );
  const selected = (role: FleetRole) => {
    const binding = currentFleetConversation(role);
    return (
      binding !== null &&
      activeThread !== null &&
      binding.threadId === activeThread.threadId &&
      binding.environmentId === activeThread.environmentId
    );
  };
  const status = (role: FleetRole) => {
    const binding = currentFleetConversation(role);
    return fleetRoleStatus(
      role,
      binding
        ? (threads.find(
            (thread) =>
              thread.id === binding.threadId && thread.environmentId === binding.environmentId,
          ) ?? null)
        : null,
    );
  };
  return (
    <div className="py-1">
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <div
          className="flex items-center rounded-md hover:bg-sidebar-row-hover"
          onContextMenu={(event) => {
            event.preventDefault();
            setAnchor({ x: event.clientX, y: event.clientY });
            setMenuOpen(true);
          }}
        >
          {workers.length ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${fleet.name} workers`}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </Button>
          ) : (
            <span className="w-6 shrink-0" />
          )}
          <button
            type="button"
            aria-current={leader && selected(leader) ? "page" : undefined}
            onClick={() => {
              if (leader) void openChat(fleet, leader);
            }}
            disabled={disabled && !leader?.currentGeneration}
            className="min-w-0 flex-1 truncate rounded-md py-1.5 text-left text-sm aria-[current=page]:bg-sidebar-row-hover"
          >
            {fleet.name}
          </button>
          <MenuTrigger
            render={
              <Button variant="ghost-muted" size="icon-xs" aria-label={`${fleet.name} actions`} />
            }
            onClick={() => setAnchor(null)}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
        </div>
        <MenuPopup
          align="start"
          {...(anchor
            ? {
                anchor: {
                  getBoundingClientRect: () => ({
                    x: anchor.x,
                    y: anchor.y,
                    top: anchor.y,
                    bottom: anchor.y,
                    left: anchor.x,
                    right: anchor.x,
                    width: 0,
                    height: 0,
                    toJSON: () => ({}),
                  }),
                },
              }
            : {})}
        >
          <MenuItem disabled={disabled || fleet.lifecycle !== "active"} onClick={onAddWorker}>
            <T>Add worker chat…</T>
          </MenuItem>
          <MenuItem
            disabled={!leader || (disabled && !leader.currentGeneration)}
            onClick={() => {
              if (leader) void openChat(fleet, leader);
            }}
          >
            <T>Open leader chat</T>
          </MenuItem>
          <MenuItem onClick={onManage}>
            <T>Fleet details…</T>
          </MenuItem>
        </MenuPopup>
      </Menu>
      {expanded ? (
        <div className="ml-6 border-l border-border pl-2">
          {workers.map((role) => (
            <div key={role.id} className="flex items-center gap-1">
              <button
                type="button"
                aria-current={selected(role) ? "page" : undefined}
                disabled={disabled && role.currentGeneration === null}
                onClick={() => void openChat(fleet, role)}
                className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-row-hover aria-[current=page]:bg-sidebar-row-hover"
              >
                <span className="truncate">{role.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{status(role)}</span>
              </button>
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`${role.name} details`}
                onClick={() => onRoleDetails(role)}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {retired.length ? (
        <details className="ml-6">
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
            <T>Retired workers ·</T> {retired.length}
          </summary>
          {retired.map((role) => (
            <button
              key={role.id}
              type="button"
              className="block w-full truncate px-2 py-1 text-left text-xs text-muted-foreground"
              onClick={onManage}
            >
              {role.name}
            </button>
          ))}
        </details>
      ) : null}
    </div>
  );
}

export function FleetManager({
  project,
  fleets,
  selectedId,
  onSelect,
  threads,
  disabled,
  apply,
  openChat,
  onOpenThread,
  onAddWorker,
  error,
  assignmentsSupported = false,
}: {
  project: Pick<EnvironmentProject, "id">;
  fleets: readonly Fleet[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  threads: readonly EnvironmentThreadShell[];
  disabled: boolean;
  apply: ApplyMutation;
  openChat: OpenChat;
  onOpenThread: (ref: ScopedThreadRef) => void;
  onAddWorker: (fleet: Fleet) => void;
  error: string | null;
  assignmentsSupported?: boolean;
}) {
  const gt = useGT();
  const selected = fleets.find((fleet) => fleet.id === selectedId) ?? null;
  const [search, setSearch] = useState(selected?.name ?? "");
  const exact = fleets.find(
    (fleet) => fleet.name.trim().toLocaleLowerCase() === search.trim().toLocaleLowerCase(),
  );
  const shown = exact ?? (selected && selected.name === search ? selected : null);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Combobox
          items={fleets}
          value={shown}
          inputValue={search}
          onInputValueChange={(value, details) => {
            if (details.reason === "input-change" || details.reason === "clear-press")
              setSearch(value);
          }}
          onValueChange={(fleet) => {
            onSelect(fleet?.id ?? null);
            if (fleet) setSearch(fleet.name);
          }}
          itemToStringLabel={(fleet: Fleet) => fleet.name}
          itemToStringValue={(fleet: Fleet) => fleet.id}
          autoHighlight
        >
          <ComboboxInput
            aria-label={gt("Find or create fleet")}
            placeholder={gt("Find or name a fleet")}
            maxLength={160}
          />
          <ComboboxPopup>
            <ComboboxEmpty>
              <T>No matching fleet. Use New to create it.</T>
            </ComboboxEmpty>
            <ComboboxList>
              {(fleet: Fleet) => (
                <ComboboxItem key={fleet.id} value={fleet}>
                  {fleet.name}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
        <Button
          size="sm"
          disabled={disabled || !search.trim() || !!exact}
          onClick={() =>
            void apply({
              type: "create",
              commandId: CommandId.make(randomUUID()),
              fleetId: FleetId.make(randomUUID()),
              projectId: project.id,
              coordinatorRoleId: FleetRoleId.make(randomUUID()),
              name: search.trim(),
            }).then((fleet) => {
              if (fleet) {
                onSelect(fleet.id);
                setSearch(fleet.name);
                const leader = fleet.roles.find((role) => role.kind === "coordinator");
                if (leader) void openChat(fleet, leader);
              }
            })
          }
        >
          <T>New</T>
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {shown ? (
        <FleetEditor
          key={shown.id}
          fleet={shown}
          threads={threads}
          disabled={disabled}
          apply={apply}
          openChat={openChat}
          onOpenThread={onOpenThread}
          onAddWorker={() => onAddWorker(shown)}
          assignmentsSupported={assignmentsSupported}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          <T>Select a fleet to see its leader and workers.</T>
        </p>
      )}
    </div>
  );
}

function AddWorker({
  fleet,
  disabled,
  apply,
  openChat,
  onDone,
  error,
}: {
  fleet: Fleet;
  disabled: boolean;
  apply: ApplyMutation;
  openChat: OpenChat;
  onDone: () => void;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [remit, setRemit] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const roleId = FleetRoleId.make(randomUUID());
        void apply({
          type: "worker.create",
          commandId: CommandId.make(randomUUID()),
          fleetId: fleet.id,
          expectedRevision: fleet.revision,
          roleId,
          name: name.trim(),
          remit: remit.trim(),
        }).then(async (saved) => {
          if (!saved) return;
          const role = saved.roles.find((candidate) => candidate.id === roleId);
          onDone();
          if (role) await openChat(saved, role);
        });
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>
          <T>Worker name</T>
        </span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={160}
          required
          disabled={disabled}
        />
      </label>
      <label className="block space-y-1 text-sm">
        <span>
          <T>Responsibilities</T>
        </span>
        <Textarea
          value={remit}
          onChange={(event) => setRemit(event.target.value)}
          maxLength={8000}
          rows={3}
          disabled={disabled}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={disabled || !name.trim() || fleet.lifecycle !== "active"}>
        <T>Create worker chat</T>
      </Button>
    </form>
  );
}

function FleetEditor({
  fleet,
  threads,
  disabled,
  apply,
  openChat,
  onOpenThread,
  onAddWorker,
  assignmentsSupported,
}: {
  fleet: Fleet;
  threads: readonly EnvironmentThreadShell[];
  disabled: boolean;
  apply: ApplyMutation;
  openChat: OpenChat;
  onOpenThread: (ref: ScopedThreadRef) => void;
  onAddWorker: () => void;
  assignmentsSupported: boolean;
}) {
  const gt = useGT();
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const leader = fleet.roles.find((role) => role.kind === "coordinator");
  const retired = fleet.lifecycle === "retired";
  const details = fleet.roles.find((role) => role.id === detailsId) ?? null;
  const command = () => ({
    commandId: CommandId.make(randomUUID()),
    fleetId: fleet.id,
    expectedRevision: fleet.revision,
  });
  const row = (role: FleetRole) => {
    const binding = currentFleetConversation(role);
    const thread = binding
      ? (threads.find(
          (candidate) =>
            candidate.id === binding.threadId && candidate.environmentId === binding.environmentId,
        ) ?? null)
      : null;
    return (
      <div key={role.id} className="flex items-center gap-2 border-b border-border py-1">
        <button
          type="button"
          className="min-w-0 flex-1 truncate py-1 text-left text-sm"
          disabled={disabled && !binding}
          onClick={() => void openChat(fleet, role)}
        >
          {role.kind === "coordinator" ? fleet.name : role.name}
        </button>
        <span className="text-xs text-muted-foreground">{fleetRoleStatus(role, thread)}</span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${role.kind === "coordinator" ? fleet.name : role.name} details`}
          onClick={() => setDetailsId(role.id)}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </div>
    );
  };
  return (
    <section aria-label={`${fleet.name} roster`} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          disabled={disabled || retired || fleet.lifecycle !== "active"}
          onClick={onAddWorker}
        >
          <T>Add worker…</T>
        </Button>
        {!retired ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void apply({
                  ...command(),
                  type: "lifecycle.set",
                  lifecycle: fleet.lifecycle === "paused" ? "active" : "paused",
                })
              }
            >
              {fleet.lifecycle === "paused" ? gt("Resume fleet") : gt("Pause fleet")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || fleet.roles.some((role) => role.currentGeneration !== null)}
              onClick={() =>
                void apply({ ...command(), type: "lifecycle.set", lifecycle: "retired" })
              }
            >
              <T>Retire fleet</T>
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            <T>Retired</T>
          </span>
        )}
      </div>
      <div>
        {leader ? row(leader) : null}
        <div className="ml-4">{fleet.roles.filter((role) => role.kind === "worker").map(row)}</div>
      </div>
      <p className="text-xs text-muted-foreground">
        <T>
          Click a name to open its chat. Pausing prevents new chats; it does not stop a running
          chat. Retirement keeps its history.
        </T>
      </p>
      {assignmentsSupported ? <FleetAssignments fleet={fleet} onOpenThread={onOpenThread} /> : null}
      <Dialog
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {details?.kind === "coordinator" ? fleet.name : details?.name}
            </DialogTitle>
            <DialogDescription>
              <T>Conversation settings and previous chats.</T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {details ? (
              <FleetRoleEditor
                key={details.id}
                fleet={fleet}
                role={details}
                threads={threads}
                disabled={disabled || retired}
                apply={apply}
                onOpenThread={onOpenThread}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
function FleetRoleEditor({
  fleet,
  role,
  threads,
  disabled,
  apply,
  onOpenThread,
}: {
  fleet: Fleet;
  role: FleetRole;
  threads: readonly EnvironmentThreadShell[];
  disabled: boolean;
  apply: ApplyMutation;
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const [selected, setSelected] = useState<string | null>(null);
  const binding = currentFleetConversation(role);
  const thread = binding
    ? (threads.find(
        (candidate) =>
          candidate.environmentId === binding.environmentId && candidate.id === binding.threadId,
      ) ?? null)
    : null;
  const candidates = threads.filter(
    (candidate) =>
      candidate.environmentId === fleet.environmentId &&
      candidate.deletedAt === null &&
      candidate.archivedAt === null &&
      !candidate.lineage.relationshipToParent,
  );
  const retired = role.lifecycle === "retired";
  const status = fleetRoleStatus(role, thread);
  const command = () => ({
    commandId: CommandId.make(randomUUID()),
    fleetId: fleet.id,
    roleId: role.id,
    expectedRevision: fleet.revision,
  });
  return (
    <section
      aria-label={`${role.name} worker`}
      className="space-y-2 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h4 className="text-sm font-medium">
          {role.kind === "coordinator" ? fleet.name : role.name}
        </h4>
        <span className="text-xs text-muted-foreground">{status}</span>
      </div>
      {role.remit ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{role.remit}</p>
      ) : null}
      {binding ? (
        <>
          <p className="text-xs text-muted-foreground">
            <T>Generation</T> {binding.generation} ·{" "}
            {thread?.modelSelection.model ?? gt("Model unavailable")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              disabled={!thread || thread.deletedAt !== null || thread.archivedAt !== null}
              onClick={() => onOpenThread(binding)}
            >
              <T>Open chat</T>
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={
                disabled || status === "working" || status === "waiting" || status === "needs you"
              }
              onClick={() => void apply({ ...command(), type: "role.release" })}
            >
              <T>Disconnect current chat</T>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <T>
              Disconnect keeps this conversation in history. Click the role again to start a fresh
              chat.
            </T>
          </p>
        </>
      ) : !retired ? (
        <div className="space-y-2">
          <Select
            value={selected}
            onValueChange={setSelected}
            disabled={disabled || role.lifecycle !== "active" || fleet.lifecycle !== "active"}
          >
            <SelectTrigger size="sm" aria-label={gt("Chat for {role}", { role: role.name })}>
              <SelectValue placeholder={gt("Use an existing chat instead")} />
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="xs"
            variant="outline"
            disabled={
              disabled || !selected || role.lifecycle !== "active" || fleet.lifecycle !== "active"
            }
            onClick={() => {
              if (selected)
                void apply({
                  ...command(),
                  type: "role.attach",
                  environmentId: fleet.environmentId,
                  threadId: ThreadId.make(selected),
                }).then((ok) => {
                  if (ok) setSelected(null);
                });
            }}
          >
            <T>Use selected chat</T>
          </Button>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Click the worker name in the sidebar to create its chat. No agent runs until you
                send a message.
              </T>
            </p>
          ) : null}
        </div>
      ) : null}
      {!retired ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled}
            onClick={() =>
              void apply({
                ...command(),
                type: "role.lifecycle.set",
                lifecycle: role.lifecycle === "paused" ? "active" : "paused",
              })
            }
          >
            {role.lifecycle === "paused" ? gt("Resume role") : gt("Pause role")}
          </Button>
          {role.kind === "worker" ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled || binding !== null}
              onClick={() =>
                void apply({ ...command(), type: "role.lifecycle.set", lifecycle: "retired" })
              }
            >
              <T>Retire worker</T>
            </Button>
          ) : null}
        </div>
      ) : null}
      {role.incarnations.length ? (
        <details>
          <summary className="cursor-pointer py-1 text-xs text-muted-foreground">
            <T>Conversation history ·</T> {role.incarnations.length}
          </summary>
          <ul className="space-y-1">
            {role.incarnations.toReversed().map((incarnation) => (
              <li
                key={incarnation.generation}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span>
                  <T>Generation</T> {incarnation.generation} ·{" "}
                  {incarnation.releasedAt ? "released" : "current"}
                </span>
                <Button size="xs" variant="ghost-muted" onClick={() => onOpenThread(incarnation)}>
                  <T>Open generation</T> {incarnation.generation}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
