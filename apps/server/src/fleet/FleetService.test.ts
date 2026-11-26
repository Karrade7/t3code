import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  FleetId,
  FleetRoleId,
  ProjectId,
  ThreadId,
  type FleetMutation,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as FleetService from "./FleetService.ts";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("project");
const fleetId = FleetId.make("fleet");
const coordinatorRoleId = FleetRoleId.make("coordinator");
const roleId = FleetRoleId.make("worker");
const threadId = ThreadId.make("thread");

const dependencies = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
);
const layer = FleetService.layer.pipe(Layer.provideMerge(dependencies));
const create: FleetMutation = {
  type: "create",
  commandId: CommandId.make("create"),
  fleetId,
  projectId,
  name: "Integration fleet",
  coordinatorRoleId,
};
const worker: FleetMutation = {
  type: "worker.create",
  commandId: CommandId.make("worker"),
  fleetId,
  expectedRevision: 1,
  roleId,
  name: "SPL integrator",
  remit: "Integrate SPL changes and retain evidence.",
};

const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Project', '/project', '[]', '2026-11-14', '2026-11-14')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json
    ) VALUES (${threadId}, ${projectId}, 'Integration', 'codex', 'full-access', 'default', '2026-11-14', '2026-11-14', '{}')
  `;
  return yield* FleetService.FleetService;
});

it.effect("reopens a persisted roster and its command receipts after the database closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filename = path.join(directory, "fleet.sqlite");
    const open = () =>
      FleetService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            NodeSqliteClient.layer({ filename }),
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
        ),
      );
    const saved = yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* setup;
        yield* service.mutate(create);
        return yield* service.mutate(worker);
      }).pipe(Effect.provide(open())),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* FleetService.FleetService;
        assert.deepEqual((yield* service.list({ projectId })).fleets, [saved]);
        assert.deepEqual(yield* service.mutate(worker), saved);
      }).pipe(Effect.provide(open())),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls back bindings and roster updates when recording the receipt fails", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    yield* service.mutate(worker);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TRIGGER reject_fleet_receipt BEFORE INSERT ON fleet_command_history
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END
    `;
    const attach = {
      type: "role.attach",
      commandId: CommandId.make("attach"),
      fleetId,
      roleId,
      environmentId,
      threadId,
      expectedRevision: 2,
    } as const;
    const error = yield* service.mutate(attach).pipe(Effect.flip);
    assert.equal(error._tag, "FleetStorageError");
    assert.deepEqual(yield* sql`SELECT thread_id FROM fleet_thread_bindings`, []);
    assert.equal((yield* service.list({ projectId })).fleets[0]?.revision, 2);
    yield* sql`DROP TRIGGER reject_fleet_receipt`;
    assert.equal((yield* service.mutate(attach)).roles[1]?.currentGeneration, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("admits only one concurrent mutation at the same revision", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    const outcomes = yield* Effect.all(
      [
        service.mutate(worker).pipe(Effect.result),
        service
          .mutate({
            ...worker,
            commandId: CommandId.make("competitor"),
            roleId: FleetRoleId.make("competitor"),
          })
          .pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(outcomes.filter(Result.isSuccess).length, 1);
    const rejected = outcomes.find(Result.isFailure);
    assert.equal(rejected?.failure._tag, "FleetCommandError");
    if (rejected?.failure._tag === "FleetCommandError")
      assert.equal(rejected.failure.reason, "stale_revision");
    assert.equal((yield* service.list({ projectId })).fleets[0]?.roles.length, 2);
  }).pipe(Effect.provide(layer)),
);

it.effect("persists multiple fleets and workers without sessions and pages by project", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    const saved = yield* service.mutate(worker);
    assert.equal(saved.roles[1]?.currentGeneration, null);
    yield* service.mutate({
      ...create,
      commandId: CommandId.make("other"),
      fleetId: FleetId.make("fleet-two"),
    });
    const first = yield* service.list({ projectId, limit: 1 });
    assert.deepEqual(first.fleets, [saved]);
    assert.equal(first.nextCursor, fleetId);
    const second = yield* service.list({ projectId, afterId: first.nextCursor!, limit: 1 });
    assert.equal(second.fleets[0]?.id, "fleet-two");
    assert.equal(second.nextCursor, null);
    assert.deepEqual((yield* service.list({ projectId: ProjectId.make("unrelated") })).fleets, []);
    const reconstructed = yield* FleetService.FleetService.pipe(Effect.provide(FleetService.layer));
    assert.deepEqual((yield* reconstructed.list({ projectId })).fleets[0], saved);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "replays original receipts and refuses command reuse or stale writes without changing history",
  () =>
    Effect.gen(function* () {
      const service = yield* setup;
      const initial = yield* service.mutate(create);
      yield* service.mutate(worker);
      assert.deepEqual(yield* service.mutate(create), initial);
      assert.deepEqual(
        yield* service.mutate({
          coordinatorRoleId,
          name: "Integration fleet",
          projectId,
          fleetId,
          commandId: CommandId.make("create"),
          type: "create",
        }),
        initial,
      );
      const conflict = yield* service
        .mutate({ ...create, name: "Changed payload" })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "FleetCommandError");
      if (conflict._tag === "FleetCommandError") assert.equal(conflict.reason, "command_conflict");
      const stale = yield* service
        .mutate({
          ...worker,
          commandId: CommandId.make("stale"),
          roleId: FleetRoleId.make("other"),
        })
        .pipe(Effect.flip);
      if (stale._tag === "FleetCommandError") assert.equal(stale.reason, "stale_revision");
      else assert.fail("Expected stale revision rejection");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT command_id FROM fleet_command_history`;
      assert.equal(rows.length, 2);
      assert.equal((yield* service.list({ projectId })).fleets[0]?.revision, 2);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "preserves worker identity and history across release and new conversation attachment",
  () =>
    Effect.gen(function* () {
      const service = yield* setup;
      yield* service.mutate(create);
      yield* service.mutate(worker);
      const attach: FleetMutation = {
        type: "role.attach",
        commandId: CommandId.make("attach"),
        fleetId,
        roleId,
        environmentId,
        threadId,
        expectedRevision: 2,
      };
      const attached = yield* service.mutate(attach);
      assert.equal(attached.roles[1]?.currentGeneration, 1);
      const released = yield* service.mutate({
        type: "role.release",
        commandId: CommandId.make("release"),
        fleetId,
        roleId,
        expectedRevision: 3,
      });
      assert.equal(released.roles[1]?.currentGeneration, null);
      assert.isNotNull(released.roles[1]?.incarnations[0]?.releasedAt);
      const rebound = yield* service.mutate({
        ...attach,
        commandId: CommandId.make("reattach"),
        expectedRevision: 4,
      });
      assert.equal(rebound.roles[1]?.id, roleId);
      assert.equal(rebound.roles[1]?.currentGeneration, 2);
      assert.equal(rebound.roles[1]?.incarnations.length, 2);
      assert.equal(rebound.coordinatorEpoch, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("releasing the coordinator advances ownership epoch without changing workers", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    const saved = yield* service.mutate(worker);
    const attached = yield* service.mutate({
      type: "role.attach",
      commandId: CommandId.make("attach"),
      fleetId,
      roleId: coordinatorRoleId,
      environmentId,
      threadId,
      expectedRevision: 2,
    });
    assert.equal(attached.coordinatorEpoch, 1);
    const released = yield* service.mutate({
      type: "role.release",
      commandId: CommandId.make("release"),
      fleetId,
      roleId: coordinatorRoleId,
      expectedRevision: 3,
    });
    assert.equal(released.coordinatorEpoch, 2);
    assert.deepEqual(released.roles[1], saved.roles[1]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses remote, missing, busy and multiply attached conversations", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    yield* service.mutate(worker);
    const attach = {
      type: "role.attach",
      commandId: CommandId.make("attach"),
      fleetId,
      roleId,
      environmentId,
      threadId,
      expectedRevision: 2,
    } as const;
    for (const [input, reason] of [
      [{ ...attach, environmentId: EnvironmentId.make("remote") }, "wrong_environment"],
      [{ ...attach, threadId: ThreadId.make("missing") }, "thread_unavailable"],
    ] as const) {
      const error = yield* service.mutate(input).pipe(Effect.flip);
      if (error._tag === "FleetCommandError") assert.equal(error.reason, reason);
      else assert.fail("Expected attachment rejection");
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run', ${threadId}, 1, 'codex', 'running', '2026-11-14', '{}')
    `;
    const busy = yield* service.mutate(attach).pipe(Effect.flip);
    if (busy._tag === "FleetCommandError") assert.equal(busy.reason, "thread_busy");
    else assert.fail("Expected busy thread rejection");
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run'`;
    yield* service.mutate(attach);
    const duplicate = yield* service
      .mutate({
        ...attach,
        commandId: CommandId.make("duplicate"),
        roleId: coordinatorRoleId,
        expectedRevision: 3,
      })
      .pipe(Effect.flip);
    if (duplicate._tag === "FleetCommandError") assert.equal(duplicate.reason, "attachment_exists");
    else assert.fail("Expected exclusive attachment rejection");
    assert.equal((yield* service.list({ projectId })).fleets[0]?.revision, 3);
  }).pipe(Effect.provide(layer)),
);

it.effect("requires release before retirement and keeps retired roles in the roster", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    yield* service.mutate(worker);
    yield* service.mutate({
      type: "role.attach",
      commandId: CommandId.make("attach"),
      fleetId,
      roleId,
      environmentId,
      threadId,
      expectedRevision: 2,
    });
    const retire = {
      type: "role.lifecycle.set",
      commandId: CommandId.make("retire"),
      fleetId,
      roleId,
      lifecycle: "retired",
      expectedRevision: 3,
    } as const;
    const refused = yield* service.mutate(retire).pipe(Effect.flip);
    if (refused._tag === "FleetCommandError") assert.equal(refused.reason, "attachments_present");
    else assert.fail("Expected retirement guard");
    yield* service.mutate({
      type: "role.release",
      commandId: CommandId.make("release"),
      fleetId,
      roleId,
      expectedRevision: 3,
    });
    const retired = yield* service.mutate({ ...retire, expectedRevision: 4 });
    assert.equal(retired.roles[1]?.lifecycle, "retired");
    const revived = yield* service
      .mutate({
        ...retire,
        commandId: CommandId.make("revive"),
        lifecycle: "active",
        expectedRevision: 5,
      })
      .pipe(Effect.flip);
    if (revived._tag === "FleetCommandError") assert.equal(revived.reason, "retired");
    else assert.fail("Expected terminal retirement");
  }).pipe(Effect.provide(layer)),
);

it.effect("reads durable workers without sessions and retains retired roles in the roster", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    yield* service.mutate(worker);
    yield* service.mutate({
      type: "role.lifecycle.set",
      commandId: CommandId.make("retire"),
      fleetId,
      expectedRevision: 2,
      roleId,
      lifecycle: "retired",
    });
    const snapshot = yield* service.read({ fleetId });
    assert.equal(snapshot?.fleet.roles.length, 2);
    assert.deepEqual(
      snapshot?.sessions.map((entry) => entry.state),
      ["no session", "retired"],
    );
    assert.isNull(yield* service.read({ threadId }));
  }).pipe(Effect.provide(layer)),
);

it.effect("only the currently attached leader may mutate, including after a release", () =>
  Effect.gen(function* () {
    const service = yield* setup;
    yield* service.mutate(create);
    yield* service.mutate({
      type: "role.attach",
      commandId: CommandId.make("leader-attach"),
      fleetId,
      expectedRevision: 1,
      roleId: coordinatorRoleId,
      environmentId,
      threadId,
    });
    const snapshot = yield* service.read({ threadId });
    assert.equal(snapshot?.callerRoleId, coordinatorRoleId);
    assert.isTrue(snapshot?.isCurrentAttachment);
    yield* service.mutateAsLeader({ environmentId, threadId }, { ...worker, expectedRevision: 2 });
    const refused = yield* Effect.result(
      service.mutateAsLeader(
        { environmentId, threadId: ThreadId.make("unrelated") },
        {
          ...worker,
          commandId: CommandId.make("intruder"),
          expectedRevision: 3,
        },
      ),
    );
    assert.isTrue(Result.isFailure(refused));
    if (Result.isFailure(refused))
      assert.equal(
        refused.failure._tag === "FleetCommandError" && refused.failure.reason,
        "leader_required",
      );
    yield* service.mutate({
      type: "role.release",
      commandId: CommandId.make("leader-release"),
      fleetId,
      expectedRevision: 3,
      roleId: coordinatorRoleId,
    });
    const wrongServer = yield* service.read({
      threadId,
      threadEnvironmentId: EnvironmentId.make("remote"),
    });
    assert.isNull(wrongServer);
    const former = yield* service.read({ threadId });
    assert.equal(former?.callerRoleId, coordinatorRoleId);
    assert.isFalse(former?.isCurrentAttachment);
    const stale = yield* Effect.result(
      service.mutateAsLeader(
        { environmentId, threadId },
        {
          ...worker,
          commandId: CommandId.make("former-leader"),
          expectedRevision: 4,
        },
      ),
    );
    assert.isTrue(Result.isFailure(stale));
    yield* service.mutate({
      type: "role.attach",
      commandId: CommandId.make("reuse-as-worker"),
      fleetId,
      expectedRevision: 4,
      roleId,
      environmentId,
      threadId,
    });
    const reassigned = yield* service.read({ threadId });
    assert.equal(reassigned?.callerRoleId, roleId);
    assert.isTrue(reassigned?.isCurrentAttachment);
  }).pipe(Effect.provide(layer)),
);
