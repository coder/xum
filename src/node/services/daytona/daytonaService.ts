import type { DaytonaCredentialsStore } from "@/node/config/daytonaCredentialsStore";
import { DaytonaSshConfigWriter } from "@/node/runtime/daytonaSshConfig";
import { sleepWithAbort } from "@/node/utils/abort";
import { DaytonaAccount } from "./daytonaAccount";
import type { DaytonaClient } from "./daytonaClient";
import { DaytonaReadiness } from "./daytonaReadiness";
import { DaytonaSandboxes } from "./daytonaSandboxes";
import type { DaytonaSandboxIds } from "./daytonaSandboxIds";
import { DaytonaSsh, type DaytonaSshWriter } from "./daytonaSsh";

export interface DaytonaServiceOptions {
  credentialsStore: DaytonaCredentialsStore;
  /** Where the ids of created sandboxes are recorded: the workspace config in the app. */
  sandboxIds: DaytonaSandboxIds;
  /** Xum data root; holds the installation identity used for the `xum.instance` label. */
  rootDir: string;
  /** Defaults to a writer for the real `~/.ssh/config`; tests pass one aimed at a temp dir. */
  sshConfigWriter?: DaytonaSshWriter;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
      ids: options.sandboxIds,
      sshConfigWriter:
        options.sshConfigWriter ?? new DaytonaSshConfigWriter({ xumHome: options.rootDir }),
      now,
    });
    this.sandboxes = new DaytonaSandboxes({
      account: this.account,
      ssh: this.ssh,
      readiness: this.readiness,
      ids: options.sandboxIds,
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
