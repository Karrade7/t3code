import { EnvironmentId, FleetId, FleetRoleId, ProjectId, type Fleet } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { FleetProject } from "./FleetSidebar";
import { useFleetActions } from "./useFleetActions";

vi.mock("../../state/query", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("./useFleetActions", { spy: true });

it("keeps fleet controls beside the server label and opens management while collapsed", async () => {
  const project = {
    id: ProjectId.make("project"),
    environmentId: EnvironmentId.make("local"),
    title: "Test project",
    workspaceRoot: "/projects/test",
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    scripts: [],
  };
  const fleet: Fleet = {
    id: FleetId.make("fleet"),
    projectId: project.id,
    environmentId: project.environmentId,
    name: "Fleet testing leader",
    lifecycle: "active",
    revision: 1,
    coordinatorEpoch: 0,
    roles: [
      {
        id: FleetRoleId.make("leader"),
        kind: "coordinator",
        name: "Fleet testing leader",
        remit: "Lead tests",
        lifecycle: "active",
        currentGeneration: null,
        incarnations: [],
      },
    ],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  const refresh = vi.fn();
  const openChat = vi.fn(async () => {});
  vi.mocked(useEnvironmentQuery).mockReturnValue({
    data: { fleets: [fleet], nextCursor: null },
    refresh,
    isPending: false,
    error: null,
    failure: null,
    dataUpdatedAt: 0,
    isSuccess: true,
  });
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useFleetActions).mockReturnValue({
    openChat,
    apply: vi.fn(async () => null),
    busy: false,
    error: null,
  });
  await using screen = await render(
    <FleetProject
      project={project}
      threads={[]}
      supported
      activeThread={null}
      environmentLabel="Test server"
      onOpenThread={vi.fn()}
    />,
    { router: false },
  );
  await userEvent.click(screen.getByRole("button", { name: "Fleet testing leader", exact: true }));
  expect(openChat).toHaveBeenCalledWith(fleet, fleet.roles[0]);
  await userEvent.click(screen.getByRole("button", { name: /Test project.*Test server/ }));
  await expect
    .element(screen.getByRole("button", { name: "Fleet testing leader", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Refresh fleets in Test project" }));
  expect(refresh).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("button", { name: "Manage fleets in Test project" }));
  await expect
    .element(page.getByRole("dialog", { name: "Manage fleets · Test project" }))
    .toBeVisible();
});
