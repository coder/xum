import { toXumDaytonaHost } from "@/common/constants/daytona";
import type { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { retireSshConnections } from "@/node/runtime/transports";
import { sleepWithAbort } from "@/node/utils/abort";
import { DaytonaAccount } from "./daytonaAccount";
import type { DaytonaClient } from "./daytonaClient";
import { DaytonaReadiness } from "./daytonaReadiness";
import { DaytonaSandboxes } from "./daytonaSandboxes";
import { DaytonaSsh, type DaytonaSshWriter } from "./daytonaSsh";

export interface DaytonaServiceOptions {
  credentialsStore: DaytonaCredentialsStore;
  /** Xum data root; holds the installation identity used for the `xum.instance` label. */
  rootDir: string;
  /** Defaults to a writer for the real `~/.ssh/config`; tests pass one aimed at a temp dir. */
  sshConfigWriter?: DaytonaSshWriter;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to retiring the pooled OpenSSH and ssh2 connections of the sandbox's alias. */
  retireSshConnections?: (sandboxId: string) => Promise<void>;
}

/**
 * Daytona access shared by the runtime, the reconciler and the `daytona` oRPC namespace, wired
 * as one instance per Xum backend: callers use the part they need.
 */
export class DaytonaService {
  readonly account: DaytonaAccount;
  readonly readiness: DaytonaReadiness;
  readonly ssh: DaytonaSsh;
  readonly sandboxes: DaytonaSandboxes;

  constructor(options: DaytonaServiceOptions) {
    const now = options.now ?? Date.now;
    this.account = new DaytonaAccount({
      credentialsStore: options.credentialsStore,
      fetch: options.fetch,
      onSettingsChange: (previousClient) => this.forgetAccount(previousClient),
    });
    this.readiness = new DaytonaReadiness(now);
    this.ssh = new DaytonaSsh({
      account: this.account,
      readiness: this.readiness,
      sshConfigWriter:
        options.sshConfigWriter ?? new DaytonaSshConfigWriter({ xumHome: options.rootDir }),
      retireSshConnections:
        options.retireSshConnections ??
        ((sandboxId) => retireSshConnections({ host: toXumDaytonaHost(sandboxId) })),
      now,
    });
    this.sandboxes = new DaytonaSandboxes({
      account: this.account,
      ssh: this.ssh,
      readiness: this.readiness,
      rootDir: options.rootDir,
      now,
      sleep: options.sleep ?? sleepWithAbort,
    });
  }

  private async forgetAccount(previousClient: DaytonaClient | undefined): Promise<void> {
    this.readiness.invalidateAll();
    await this.ssh.forgetAccount(previousClient);
  }
}
