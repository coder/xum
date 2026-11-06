import { ContainerManager } from "@/node/multiProject/containerManager";
import { MultiProjectRuntime } from "./multiProjectRuntime";
import type { Runtime } from "./Runtime";

export function multiProjectOf(...runtimes: Runtime[]): MultiProjectRuntime {
  return new MultiProjectRuntime(
    new ContainerManager("/host/src"),
    runtimes.map((runtime, index) => ({
      projectPath: `/host/p${index}`,
      projectName: `p${index}`,
      runtime,
    })),
    "ws"
  );
}
