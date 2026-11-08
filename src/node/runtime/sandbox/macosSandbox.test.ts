import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { AgentSandboxStartError, type AgentSandboxPolicy } from "./agentSandboxTargets";
import {
  SRT_RULES_TO_REMOVE,
  agentSandboxDenialsAfterExit,
  resetAgentSandboxRuntime,
  wrapWithPolicy,
} from "./macosSandbox";

// These run on every platform: srt is replaced by the wrap it returns on macOS, so CI on Linux
// checks how Xum reads and edits it. macosSandbox.darwin.test.ts runs the real sandbox-exec.

const SCRIPT = "echo 'hi'";
// srt's quoting of SCRIPT: single quotes, each ' written as '"'"'.
const QUOTED_SCRIPT = `'echo '"'"'hi'"'"''`;
const PROXY = "http://srt.x:secret@localhost:60811";

/** The layout of srt 0.0.81's macOS profile, cut to the parts Xum edits. */
const SRT_PROFILE = [
  "(version 1)",
  '(deny default (with message "CMD64_x_END__y_SBX"))',
  "",
  "; User preferences",
  "(allow user-preference-read)",
  "",
  "(allow mach-lookup",
  '  (global-name "com.apple.bsd.dirhelper")',
  '  (global-name "com.apple.securityd.xpc")',
  ")",
  "",
  "; Network",
  '(allow network-outbound (remote ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:60811"))',
  "",
  "; Specific mach-lookup permissions for security operations",
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
  "",
  "; File read",
  "(allow file-read*)",
].join("\n");

const ENV_WORDS = [
  "SANDBOX_RUNTIME=1",
  "TMPDIR=/tmp/claude",
  `HTTP_PROXY=${PROXY}`,
  `'GIT_CONFIG_PARAMETERS='"'"'http.proxyAuthMethod=basic'"'"''`,
].join(" ");

function srtCommand(options: { env?: string; profile?: string; script?: string } = {}): string {
  return `env ${options.env ?? ENV_WORDS} /usr/bin/sandbox-exec -p '${options.profile ?? SRT_PROFILE}' /bin/bash -c ${options.script ?? QUOTED_SCRIPT}`;
}

/** The error a promise rejects with, or undefined when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  );
}

function policy(overrides: Partial<AgentSandboxPolicy> = {}): AgentSandboxPolicy {
  return {
    writeRoots: ["/work"],
    gitCommonDirs: [],
    denyWrite: [],
    denyRead: [],
    allowRead: ["/work"],
    network: "allowlist",
    allowedHosts: ["github.com"],
    allowLocalBinding: true,
    ...overrides,
  };
}

describe("wrapWithPolicy", () => {
  let wrapArgv: ReturnType<typeof spyOn<typeof SandboxManager, "wrapWithSandboxArgv">>;
  let register: ReturnType<typeof spyOn<typeof SandboxManager, "registerCommandNetworkLists">>;
  let unregister: ReturnType<typeof spyOn<typeof SandboxManager, "unregisterCommandNetworkLists">>;

  const wrapsTo = (command: string) =>
    wrapArgv.mockResolvedValue({ argv: ["/bin/bash", "-c", command], env: {} });

  beforeEach(() => {
    spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    unregister = spyOn(SandboxManager, "unregisterCommandNetworkLists").mockImplementation(
      () => undefined
    );
    register = spyOn(SandboxManager, "registerCommandNetworkLists").mockImplementation(
      () => undefined
    );
    wrapArgv = spyOn(SandboxManager, "wrapWithSandboxArgv");
    wrapsTo(srtCommand());
  });

  afterEach(async () => {
    await resetAgentSandboxRuntime();
    mock.restore();
  });

  it("spawns sandbox-exec itself, without srt's keychain rules or its TMPDIR", async () => {
    const wrap = await wrapWithPolicy(policy(), SCRIPT, { bashPath: "/bin/bash" });

    expect(wrap.command).toBe("/usr/bin/sandbox-exec");
    const [flag, profile, ...command] = wrap.args;
    expect(flag).toBe("-p");
    expect(command).toEqual(["/bin/bash", "-c", SCRIPT]);
    for (const rule of SRT_RULES_TO_REMOVE) expect(profile).not.toContain(rule.trim());
    // The allow list goes through srt's proxy.
    expect(profile).toContain('(remote ip "localhost:60811")');
    expect(wrap.env).toEqual({
      SANDBOX_RUNTIME: "1",
      HTTP_PROXY: PROXY,
      GIT_CONFIG_PARAMETERS: "'http.proxyAuthMethod=basic'",
    });
    expect(register).toHaveBeenCalledWith(wrap.commandId, { allowedDomains: ["github.com"] });

    wrap.dispose();
    expect(unregister).toHaveBeenCalledWith(wrap.commandId);
  });

  it("opens any IP host in the open mode, with no proxy", async () => {
    const wrap = await wrapWithPolicy(policy({ network: "open" }), SCRIPT, {
      bashPath: "/bin/bash",
    });

    const profile = wrap.args[1];
    expect(profile).toContain('(allow network-outbound (remote ip "*:*"))');
    expect(profile).not.toContain("localhost:60811");
    expect(profile).toContain("; File read");
    expect(wrap.env).toEqual({ SANDBOX_RUNTIME: "1" });
    expect(register).not.toHaveBeenCalled();
  });

  it("keeps the valid hosts when srt refuses the list for one of them", async () => {
    register.mockImplementation((_commandId, lists) => {
      if (lists.allowedDomains?.includes("bad host")) throw new Error("invalid host");
    });

    const wrap = await wrapWithPolicy(
      policy({ allowedHosts: ["github.com", "bad host"] }),
      SCRIPT,
      {
        bashPath: "/bin/bash",
      }
    );

    expect(register).toHaveBeenLastCalledWith(wrap.commandId, { allowedDomains: ["github.com"] });
  });

  const twice = (rule: string) => SRT_PROFILE.replace(rule, `${rule}\n${rule}`);
  const wrapped = (command: string) => ["/bin/bash", "-c", command];
  const unexpectedWraps: Array<{
    name: string;
    argv: string[];
    network?: AgentSandboxPolicy["network"];
    reason: string;
  }> = [
    {
      name: "an argv of another shape",
      argv: ["/bin/bash", "-x", srtCommand()],
      reason: "argv shape",
    },
    {
      name: "no env prefix",
      argv: wrapped(srtCommand().slice("env ".length)),
      reason: "no env prefix",
    },
    { name: "an env -u", argv: wrapped(srtCommand({ env: "-u SECRET" })), reason: "env -u" },
    {
      name: "an env word that is no assignment",
      argv: wrapped(srtCommand({ env: "X" })),
      reason: "env argument",
    },
    {
      name: "sandbox-exec without its profile",
      argv: wrapped(`env A=1 /usr/bin/sandbox-exec /bin/bash -c ${QUOTED_SCRIPT}`),
      reason: "sandbox-exec arguments",
    },
    {
      name: "another command",
      argv: wrapped(srtCommand({ script: "'rm -rf ~'" })),
      reason: "wrapped command",
    },
    {
      name: "an unterminated quote",
      argv: wrapped(`${srtCommand()} '`),
      reason: "unterminated quote",
    },
    {
      name: "quoting srt does not write",
      argv: wrapped(srtCommand({ env: '"A=1"' })),
      reason: "not in srt's quoting",
    },
    {
      name: "a profile without a rule to remove",
      argv: wrapped(
        srtCommand({ profile: SRT_PROFILE.replace("(allow user-preference-read)", "") })
      ),
      reason: "no rule (allow user-preference-read) to remove",
    },
    {
      name: "a profile with a rule twice",
      argv: wrapped(srtCommand({ profile: twice("(allow user-preference-read)") })),
      reason: "still has (allow user-preference-read)",
    },
    {
      name: "an open-mode profile without a network block",
      argv: wrapped(srtCommand({ profile: SRT_PROFILE.replace("; Network", "; Net") })),
      network: "open",
      reason: "no network block",
    },
  ];

  it.each(unexpectedWraps)("fails closed on $name", async (wrapCase) => {
    wrapArgv.mockResolvedValue({ argv: wrapCase.argv, env: {} });

    const error = await rejectionOf(
      wrapWithPolicy(policy({ network: wrapCase.network ?? "allowlist" }), SCRIPT, {
        bashPath: "/bin/bash",
      })
    );

    expect(error).toBeInstanceOf(AgentSandboxStartError);
    expect(String(error)).toContain(wrapCase.reason);
  });

  it("fails closed when srt cannot start or wrap, but passes an abort through", async () => {
    spyOn(SandboxManager, "initialize").mockRejectedValueOnce(new Error("no proxy port"));
    expect(
      await rejectionOf(wrapWithPolicy(policy(), SCRIPT, { bashPath: "/bin/bash" }))
    ).toBeInstanceOf(AgentSandboxStartError);

    wrapArgv.mockRejectedValueOnce(new Error("bad config"));
    expect(
      await rejectionOf(wrapWithPolicy(policy(), SCRIPT, { bashPath: "/bin/bash" }))
    ).toBeInstanceOf(AgentSandboxStartError);

    const controller = new AbortController();
    controller.abort();
    const aborted = new Error("aborted");
    wrapArgv.mockRejectedValueOnce(aborted);
    expect(
      await rejectionOf(
        wrapWithPolicy(policy(), SCRIPT, { bashPath: "/bin/bash", abortSignal: controller.signal })
      )
    ).toBe(aborted);
  });
});

describe("agentSandboxDenialsAfterExit", () => {
  const store = SandboxManager.getSandboxViolationStore();
  // srt keys a command's violations by the base64 of its commandId (encodeSandboxedCommand).
  const deny = (commandId: string, line: string) =>
    store.addViolation({
      line,
      encodedCommand: Buffer.from(commandId).toString("base64"),
      timestamp: new Date(),
    });

  afterEach(() => store.clear());

  it("summarizes a command's denials and drops the ones every command logs", async () => {
    deny("cmd-a", "bash(12) deny(1) file-write-create /Users/me/.zshrc");
    deny("cmd-a", "bash(12) deny(1) file-write-create /Users/me/.zshrc");
    deny("cmd-a", "curl(13) deny(1) file-read-data /Users/me/Library/Preferences/x.plist");
    deny("cmd-a", "curl(13) deny(1) network-outbound example.com:443");
    deny("cmd-a", "security(14) deny(1) mach-lookup com.apple.SecurityServer");
    deny("cmd-a", "bash(12) deny(1) mach-lookup com.apple.cfprefsd.daemon");
    deny("cmd-a", "bash(12) deny(1) sysctl-read kern.osversion");
    deny("cmd-b", "bash(15) deny(1) file-write-create /Users/me/.bashrc");
    const expected = [
      "write /Users/me/.zshrc",
      "network example.com",
      "service com.apple.SecurityServer",
    ];

    expect(await agentSandboxDenialsAfterExit("cmd-a", false)).toEqual(expected);
    // A failed command whose denials are already read does not wait either.
    expect(await agentSandboxDenialsAfterExit("cmd-a", true)).toEqual(expected);
  });

  it("makes a failed command wait for its first denial and the rest of the burst", async () => {
    const denials = agentSandboxDenialsAfterExit("cmd-a", true);
    deny("cmd-b", "bash(15) deny(1) file-write-create /Users/me/.bashrc");
    deny("cmd-a", "bash(12) deny(1) file-write-create /Users/me/.zshrc");
    await new Promise((resolve) => setTimeout(resolve, 50));
    deny("cmd-a", "curl(13) deny(1) network-outbound example.com:443");

    expect(await denials).toEqual(["write /Users/me/.zshrc", "network example.com"]);
  });
});
