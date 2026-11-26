import { EnvironmentId, FleetId, ProjectId, type Fleet } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FleetManager } from "./FleetSidebar";

function setup() {
  const project = { id: ProjectId.make("project") };
  const fleets: Fleet[] = ["Development", "Operations"].map((name) => ({
    id: FleetId.make(name),
    projectId: project.id,
    environmentId: EnvironmentId.make("local"),
    name,
    lifecycle: "active",
    revision: 1,
    coordinatorEpoch: 0,
    roles: [],
    createdAt: "2026-11-25T00:00:00Z",
    updatedAt: "2026-11-25T00:00:00Z",
  }));
  return {
    project,
    fleets,
    selectedId: null,
    onSelect: vi.fn(),
    threads: [],
    disabled: false,
    apply: vi.fn(async () => null),
    openChat: vi.fn(async () => {}),
    onOpenThread: vi.fn(),
    onAddWorker: vi.fn(),
    error: null,
  };
}

it("filters fleets and disables New for the selected existing fleet", async () => {
  const props = setup();
  await using screen = await render(<FleetManager {...props} />, {
    // This picker has no navigation; callbacks record selection.
    router: false,
  });
  await userEvent.fill(screen.getByRole("combobox", { name: "Find or create fleet" }), "dev");
  await expect.element(page.getByRole("option", { name: "Development" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "Operations" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: "Development" }));
  await expect.element(screen.getByRole("button", { name: "New", exact: true })).toBeDisabled();
  expect(props.onSelect).toHaveBeenCalledWith("Development");
  await expect.element(screen.getByRole("region", { name: "Development roster" })).toBeVisible();
  await expect
    .element(screen.getByRole("region", { name: "Operations roster" }))
    .not.toBeInTheDocument();
});

it("retains an unmatched typed name when Escape and button focus close the dropdown", async () => {
  const props = setup();
  await using screen = await render(<FleetManager {...props} />, {
    // The regression is input focus and popup dismissal, independent of routing.
    router: false,
  });
  const input = screen.getByRole("combobox", { name: "Find or create fleet" });
  await userEvent.fill(input, "New product team");
  await userEvent.keyboard("{Escape}");
  await expect.element(input).toHaveValue("New product team");
  await userEvent.click(screen.getByRole("button", { name: "New", exact: true }));
  expect(props.apply).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "create",
      name: "New product team",
      projectId: props.project.id,
    }),
  );
});
