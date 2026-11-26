import { createFleetEnvironmentAtoms } from "@t3tools/client-runtime/state/fleets";
import { connectionAtomRuntime } from "../connection/runtime";

export const fleetEnvironment = createFleetEnvironmentAtoms(connectionAtomRuntime);
