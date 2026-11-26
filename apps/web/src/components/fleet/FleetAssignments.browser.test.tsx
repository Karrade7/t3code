import {
  EnvironmentId,
  FleetId,
  MessageId,
  ProjectId,
  ThreadId,
  type FleetAssignmentsResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useEnvironmentQuery } from "../../state/query";
import { FleetAssignments } from "./FleetAssignments";

vi.mock("../../state/query", { spy: true });

it("shows a held result alongside completed history and opens the actual recipient chat", async () => {
  const environmentId = EnvironmentId.make("test-server");
  const assignedAt = "2026-01-01T00:00:00.000Z";
  const workerChat = { environmentId, threadId: ThreadId.make("worker") };
  const resultChat = { environmentId, threadId: ThreadId.make("former-leader") };
  const data = {
    assignments: [
      {
        messageId: MessageId.make("running"),
        assignedAt,
        workerName: "Build worker",
        workerChat,
        taskPreview: "Run the next build",
        status: "running",
        pendingInput: "approval",
        progress: { kind: "command", title: null, at: assignedAt },
        delivery: null,
      },
      {
        messageId: MessageId.make("held"),
        assignedAt,
        workerName: "Build worker",
        workerChat,
        taskPreview: "Run the tests",
        status: "completed",
        delivery: null,
      },
      {
        messageId: MessageId.make("delivered"),
        assignedAt,
        workerName: "Review worker",
        workerChat,
        taskPreview: "Review the build output",
        status: "completed",
        delivery: { date: assignedAt, chat: resultChat },
      },
    ],
    leaderAvailable: false,
    nextCursor: null,
  } satisfies FleetAssignmentsResult;
  vi.mocked(useEnvironmentQuery).mockReturnValue({
    data,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
    isSuccess: true,
    refresh: vi.fn(),
  });
  const open = vi.fn();
  await using screen = await render(
    <FleetAssignments
      fleet={{
        id: FleetId.make("fleet"),
        projectId: ProjectId.make("project"),
        environmentId,
        name: "Build fleet",
        lifecycle: "active",
        revision: 1,
        coordinatorEpoch: 1,
        roles: [],
        createdAt: assignedAt,
        updatedAt: assignedAt,
      }}
      onOpenThread={open}
    />,
    { router: false },
  );

  await expect.element(screen.getByText("Needs approval", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Command", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(/Last activity/)).toBeVisible();
  await expect
    .element(screen.getByText("Waiting for a leader chat", { exact: true }))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Open result chat" }));
  expect(open).toHaveBeenCalledWith(resultChat);
});
