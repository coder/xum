import { describe, expect, test } from "bun:test";
import { CoderSSHRuntime } from "./CoderSSHRuntime";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
import { DockerRuntime } from "./DockerRuntime";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { LocalRuntime } from "./LocalRuntime";
import { MultiProjectRuntime } from "./multiProjectRuntime";
import { RemoteRuntime } from "./RemoteRuntime";
import { isLocalBaseRuntime, isRemoteRuntime, type Runtime } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import { ShellRemoteRuntime, TestRemoteRuntime } from "./testRemoteRuntime";
import { WorktreeRuntime } from "./WorktreeRuntime";
import { ExecPathMappingRuntime } from "@/node/services/testExecPathMappingRuntime";
import {
  RemotePathMappedRuntime,
  TrueRemotePathMappedRuntime,
} from "@/node/services/tools/testHelpers";

// Agent-loop files branch on Runtime.location instead of instanceof (local/no-host-imports), so
// location must give today's instanceof answer for every runtime class. Object.create builds an
// instance without a constructor (no worktree, container or SSH host needed) and still reads the
// prototype getters, as the Object.create doubles in tests do.
const classes: Array<[string, abstract new (...args: never[]) => Runtime]> = [
  ["LocalRuntime", LocalRuntime],
  ["WorktreeRuntime", WorktreeRuntime],
  ["DevcontainerRuntime", DevcontainerRuntime],
  ["SSHRuntime", SSHRuntime],
  ["CoderSSHRuntime", CoderSSHRuntime],
  ["DockerRuntime", DockerRuntime],
  ["TestRemoteRuntime", TestRemoteRuntime],
  ["ShellRemoteRuntime", ShellRemoteRuntime],
  ["ExecPathMappingRuntime", ExecPathMappingRuntime],
  ["MultiProjectRuntime", MultiProjectRuntime],
  ["RemotePathMappedRuntime", RemotePathMappedRuntime],
  ["TrueRemotePathMappedRuntime", TrueRemotePathMappedRuntime],
];

describe("Runtime.location", () => {
  test.each(classes)("%s gives the instanceof answers", (_name, RuntimeClass) => {
    const runtime = Object.create(RuntimeClass.prototype as object) as Runtime;
    expect({
      local: isLocalBaseRuntime(runtime),
      devcontainer: runtime.location === "devcontainer",
      remote: isRemoteRuntime(runtime),
    }).toEqual({
      local: runtime instanceof LocalBaseRuntime,
      devcontainer: runtime instanceof DevcontainerRuntime,
      remote: runtime instanceof RemoteRuntime,
    });
  });

  test("a runtime without location takes neither branch", () => {
    expect([isLocalBaseRuntime(undefined), isRemoteRuntime(undefined)]).toEqual([false, false]);
  });
});
