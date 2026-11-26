import { T, useGT } from "gt-react";
import type {
  Fleet,
  FleetAssignmentCursor,
  FleetAssignmentsResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { fleetEnvironment } from "../../state/fleets";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

const statuses = {
  preparing: "Preparing",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
} satisfies Record<NonNullable<FleetAssignmentsResult["assignments"][number]["status"]>, string>;
const progressLabels = {
  command: "Command",
  tool: "Tool use",
  thinking: "Thinking",
  plan: "Plan update",
  reply: "Reply",
} satisfies Record<
  NonNullable<FleetAssignmentsResult["assignments"][number]["progress"]>["kind"],
  string
>;
const finished = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function FleetAssignments({
  fleet,
  onOpenThread,
}: {
  fleet: Fleet;
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const [pages, setPages] = useState<readonly FleetAssignmentCursor[]>([]);
  const before = pages.at(-1);
  const query = useEnvironmentQuery(
    fleetEnvironment.assignments({
      environmentId: fleet.environmentId,
      input: { fleetId: fleet.id, ...(before === undefined ? {} : { before }) },
    }),
  );
  const next = query.data?.nextCursor;
  return (
    <section aria-label={gt("Assignments")} className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          <T>Assignments</T>
        </h3>
        <Button size="xs" variant="ghost-muted" disabled={query.isPending} onClick={query.refresh}>
          <T>Refresh assignments</T>
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.data === null && query.isPending ? (
        <p className="text-xs text-muted-foreground">
          <T>Loading assignments…</T>
        </p>
      ) : null}
      {query.data !== null && query.data.assignments.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          <T>No assignments on this page.</T>
        </p>
      ) : null}
      {query.data !== null && query.data.assignments.length > 0 ? (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto">
          {query.data.assignments.map((assignment) => {
            const { delivery, pendingInput, progress, status } = assignment;
            const statusLabel =
              pendingInput === "approval"
                ? "Needs approval"
                : pendingInput === "question"
                  ? "Needs an answer"
                  : status === null
                    ? "Run unavailable"
                    : statuses[status];
            const deliveryLabel =
              assignment.status !== null && finished.has(assignment.status) && delivery === null
                ? fleet.lifecycle === "retired"
                  ? "Fleet retired"
                  : query.data?.leaderAvailable
                    ? "Result pending"
                    : "Waiting for a leader chat"
                : null;
            return (
              <li key={assignment.messageId} className="space-y-1 py-2">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium">{assignment.workerName}</span>
                  <span className="shrink-0 text-muted-foreground">{statusLabel}</span>
                </div>
                {assignment.taskPreview ? (
                  <p className="line-clamp-2 text-xs break-words">{assignment.taskPreview}</p>
                ) : null}
                {progress ? (
                  <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span>{progress.title ?? progressLabels[progress.kind]}</span>
                    <time dateTime={progress.at}>
                      <T>Last activity</T> {dateFormat.format(new Date(progress.at))}
                    </time>
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-1">
                  <time
                    dateTime={assignment.assignedAt}
                    className="mr-1 text-xs text-muted-foreground"
                  >
                    {dateFormat.format(new Date(assignment.assignedAt))}
                  </time>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => onOpenThread(assignment.workerChat)}
                  >
                    <T>Open worker chat</T>
                  </Button>
                  {delivery ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => onOpenThread(delivery.chat)}
                    >
                      <T>Open result chat</T>
                    </Button>
                  ) : null}
                  {deliveryLabel ? (
                    <span className="text-xs text-muted-foreground">{deliveryLabel}</span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {before !== undefined || next ? (
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={before === undefined}
            onClick={() => setPages(pages.slice(0, -1))}
          >
            <T>Newer</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!next}
            onClick={() => next && setPages([...pages, next])}
          >
            <T>Older</T>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
