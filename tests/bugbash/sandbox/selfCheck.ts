/**
 * The bug-bash sandbox self-check (#5714, plan PR D2): runs inside a sandbox container as the
 * `self-check` job of launch.ts (`make bug-bash-sandbox-check`). It inspects the container it
 * runs in, not the flags that were meant to make it, and writes one JSON line per check to
 * `<output>/checks.jsonl` (exported to the host). It exits 0 only when every check passes.
 *
 * Proxy checks go through the job's forwarder (inContainer.ts) to the host fake upstream. The
 * host driver (selfCheckRun.ts) then confirms that the fake upstream saw exactly the allowed
 * call: a refusal response alone does not prove that nothing reached the upstream.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PROXY_BASE_URL, PROXY_SOCKET } from "./inContainer";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
const read = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return `<${(error as NodeJS.ErrnoException).code ?? "error"}>`;
  }
};
const status = (field: string) =>
  new RegExp(`^${field}:\\s*(.*)$`, "m").exec(read("/proc/self/status"))?.[1] ?? "";

/** The errno of a write attempt, or "written" (and the file is removed again). */
function tryWrite(file: string): string {
  try {
    fs.writeFileSync(file, "x", { flag: "wx" });
    fs.rmSync(file);
    return "written";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "error";
  }
}

/** One call through the forwarder: the HTTP status, or the error. */
async function proxyCall(body: object, headers: Record<string, string> = {}, route = "/messages") {
  try {
    const response = await fetch(`${PROXY_BASE_URL}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    await response.text();
    return response.status;
  } catch (error) {
    return `error ${String(error)}`;
  }
}

const output = process.argv[2];
if (!output) throw new Error("usage: bun sandbox/selfCheck.ts <output folder>");

// Identity and privileges.
const uid = process.getuid!();
check(
  "uid is the launcher's and not root",
  uid !== 0 && String(uid) === process.env.BUGBASH_HOST_UID,
  `uid ${uid}`
);
check("no capabilities", /^0+$/.test(status("CapEff")), `CapEff ${status("CapEff")}`);
check("no new privileges", status("NoNewPrivs") === "1", `NoNewPrivs ${status("NoNewPrivs")}`);
check("seccomp filter", status("Seccomp") === "2", `Seccomp ${status("Seccomp")}`);
const boot = read("/proc/sys/kernel/random/boot_id").trim();
check(
  "same kernel as the launcher",
  boot !== "" && boot === process.env.BUGBASH_HOST_BOOT,
  "boot ID"
);

// Filesystem.
for (const target of ["/", "/repo/src", "/repo/node_modules", "/repo/dist"])
  check(
    `read-only ${target}`,
    tryWrite(path.join(target, ".selfcheck-write")) === "EROFS",
    tryWrite(path.join(target, ".selfcheck-write"))
  );
const home = fs.readdirSync("/home/bugbash");
check(
  "empty writable home",
  home.length === 0 && tryWrite("/home/bugbash/.selfcheck") === "written",
  `${home.length} entries`
);
// No host home under /home (any host user's name): only the image's node user and the tmpfs home.
const homes = fs.readdirSync("/home").sort().join(",");
check("no host home under /home", homes === "bugbash,node", homes);
for (const host of ["/var/run/docker.sock", "/run/docker.sock", "/root/.docker"])
  check(`no ${host}`, !fs.existsSync(host), fs.existsSync(host) ? "present" : "absent");
const socket = fs.lstatSync(PROXY_SOCKET, { throwIfNoEntry: false });
check("the proxy is a unix socket", socket?.isSocket() === true, socket ? "socket" : "missing");
check(
  "the proxy mount is read-only",
  tryWrite(path.join(path.dirname(PROXY_SOCKET), ".x")) === "EROFS",
  "write attempt"
);

// Network. The probes run in node (the app and e2e run in node): Bun 1.3.12 reports a missing
// route as ECONNREFUSED, which would hide the difference (measured in this image).
const devices = fs.readdirSync("/sys/class/net");
check("loopback only", devices.join() === "lo", devices.join());
const routes = read("/proc/net/route").trim().split("\n").slice(1);
check("no IPv4 route", routes.length === 0, `${routes.length} routes`);
const probe = spawnSync(
  "node",
  [
    "-e",
    `const net = require("net"), dns = require("dns").promises;
     const connect = (host, port) => new Promise((done) => {
       const s = net.connect({ host, port });
       const t = setTimeout(() => { s.destroy(); done("timeout"); }, 3000);
       s.once("connect", () => { clearTimeout(t); s.destroy(); done("connected"); });
       s.once("error", (e) => { clearTimeout(t); done(e.code || "error"); });
     });
     (async () => console.log(JSON.stringify({
       loopback: await connect("127.0.0.1", 1),
       bridge: await connect("172.17.0.1", 2375),
       internet: await connect("1.1.1.1", 443),
       dns: await dns.lookup("example.com").then(() => "resolved", (e) => e.code || "error"),
     })))();`,
  ],
  { encoding: "utf8", timeout: 20_000 }
);
const codes = (() => {
  try {
    return JSON.parse(probe.stdout) as Record<string, string>;
  } catch {
    return {} as Record<string, string>;
  }
})();
check(
  "closed loopback port refuses",
  codes.loopback === "ECONNREFUSED",
  codes.loopback ?? probe.stderr
);
check(
  "no route to the Docker bridge",
  codes.bridge === "ENETUNREACH",
  `172.17.0.1: ${codes.bridge}`
);
check("no route to the internet", codes.internet === "ENETUNREACH", `1.1.1.1: ${codes.internet}`);
check("no DNS", codes.dns === "EAI_AGAIN" || codes.dns === "ENOTFOUND", codes.dns ?? "no answer");

// Environment: no host credentials or host paths by name.
const leaked = Object.keys(process.env).filter((name) =>
  /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|GITHUB|AWS|CODER|DOCKER_HOST/.test(name)
);
check("no credential env names", leaked.length === 0, leaked.join(",") || "none");

// The proxy: one allowed call, then the refusal cases. Each forbidden body carries a marker the
// host's fake upstream must never see.
const model = (process.env.BUGBASH_MODEL ?? "").split(":")[1] ?? "";
const base = { model, max_tokens: 10, messages: [{ role: "user", content: "selfcheck-allowed" }] };
check("allowed call passes", (await proxyCall(base)) === 200, "selfcheck-allowed");
const forbidden: [string, object, Record<string, string>?, string?][] = [
  [
    "P1 another route",
    { ...base, messages: [{ role: "user", content: "selfcheck-forbidden-route" }] },
    {},
    "/models",
  ],
  [
    "P2 an unknown beta",
    { ...base, messages: [{ role: "user", content: "selfcheck-forbidden-beta" }] },
    { "anthropic-beta": "computer-use-2025-01-24" },
  ],
  [
    "P3 another model",
    {
      ...base,
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "selfcheck-forbidden-model" }],
    },
  ],
  [
    "P4 a server tool",
    {
      ...base,
      messages: [{ role: "user", content: "selfcheck-forbidden-tool" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    },
  ],
  [
    "P4 mcp_servers",
    {
      ...base,
      messages: [{ role: "user", content: "selfcheck-forbidden-mcp" }],
      mcp_servers: [{ type: "url", url: "http://example.com", name: "x" }],
    },
  ],
  [
    "P5 a URL image",
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "selfcheck-forbidden-url" },
            { type: "image", source: { type: "url", url: "http://example.com/x.png" } },
          ],
        },
      ],
    },
  ],
];
for (const [name, body, headers, route] of forbidden) {
  const result = await proxyCall(body, headers, route);
  check(
    `refuses ${name}`,
    typeof result === "number" && result >= 400 && result < 500,
    String(result)
  );
}

// S3 in the actual app server: start the seeded app the way a model-driven job does (startApp.ts,
// with this job's env), then read the server process's own environ.
async function appSwitchesCheck() {
  const port = await new Promise<number>((done) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: p } = server.address() as net.AddressInfo;
      server.close(() => done(p));
    });
  });
  const app = spawn("bun", ["startApp.ts", "--port", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, BUGBASH_APP_LOG: "/tmp/selfcheck-app.log" },
  });
  // Subscribed at once: an app that dies during startup must end the check, not hang it.
  const exited = new Promise((done) => app.once("exit", done));
  const gone = () => app.exitCode != null || app.signalCode != null;
  try {
    let healthy = false;
    for (let i = 0; i < 120 && !healthy && !gone(); i++) {
      await new Promise((done) => setTimeout(done, 1_000));
      healthy = await fetch(`http://127.0.0.1:${port}/health`).then(
        (r) => r.ok,
        () => false
      );
    }
    const server = fs
      .readdirSync("/proc")
      .filter((pid) => /^\d+$/.test(pid))
      .find((pid) =>
        read(`/proc/${pid}/cmdline`)
          .split("\0")
          .join(" ")
          .includes(`dist/cli/index.js server --host 127.0.0.1 --port ${port}`)
      );
    const env = server ? read(`/proc/${server}/environ`).split("\0") : [];
    const off = [
      "XUM_DISABLE_AGENT_TOOLS",
      "XUM_DISABLE_TERMINALS",
      "XUM_DISABLE_PROJECT_AUTOMATION",
    ].filter((name) => !env.includes(`${name}=1`));
    check(
      "the app server has every kill switch",
      healthy && server != null && off.length === 0,
      !healthy
        ? gone()
          ? `app exited during startup (${app.exitCode ?? app.signalCode})`
          : "app did not start"
        : server == null
          ? "no server process"
          : off.length
            ? `missing ${off.join(",")}`
            : "all three"
    );
  } finally {
    if (!gone()) app.kill("SIGTERM");
    await exited;
  }
}
await appSwitchesCheck();

fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, "checks.jsonl"),
  checks.map((c) => JSON.stringify(c)).join("\n") + "\n"
);
for (const c of checks)
  console.error(`self-check ${c.ok ? "pass" : "FAIL"}: ${c.name} (${c.detail})`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
