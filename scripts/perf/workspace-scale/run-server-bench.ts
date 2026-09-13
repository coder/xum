import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { z } from "zod";
import type { AppRouter } from "../../../src/node/orpc/router";
import { isWorkspaceArchived } from "../../../src/common/utils/archive";
import {
  benchArgs,
  copyFixture,
  isolatedEnv,
  measure,
  outputDir,
  printTable,
  readFixture,
  repoRoot,
  summarize,
  writeResults,
} from "./common";

const StartupSchema = z.object({
  totalMs: z.number(),
  stepDurationsMs: z.record(z.string(), z.number()),
});

export function parseStartup(line: string) {
  const marker = "[startup] ServiceContainer.initialize completed";
  const index = line.indexOf(marker);
  if (index < 0) return undefined;
  return StartupSchema.parse(JSON.parse(line.slice(line.indexOf("{", index))));
}

async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve()))
  );
  if (!address || typeof address === "string") throw new Error("No TCP port allocated");
  return address.port;
}

async function rss(pid: number) {
  // Linux /proc reports the server alone, not this client's heap or child utility processes.
  const status = await readFile("/proc/" + pid + "/status", "utf8");
  const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
  if (!kb) throw new Error("Server RSS unavailable (Linux /proc required)");
  return Number(kb) * 1024;
}

async function runOnce(template: string, label: string, repetition: number) {
  await using fixture = await copyFixture(template);
  const { workspaces, source } = await readFixture(fixture.root);
  const workspace = workspaces.findLast(
    (entry) =>
      !isWorkspaceArchived(entry.archivedAt, entry.unarchivedAt) && !entry.parentWorkspaceId
  );
  if (!workspace?.id) throw new Error("Fixture needs an active root workspace");
  const workspaceId = workspace.id;
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const start = performance.now();
  const child = spawn(
    "node",
    ["dist/cli/index.js", "server", "--host", "127.0.0.1", "--port", String(port), "--no-auth"],
    {
      cwd: repoRoot,
      env: isolatedEnv(fixture.root),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const exited = once(child, "close");
  let output = "";
  let startup: z.infer<typeof StartupSchema> | undefined;
  let housekeepingMs: number | undefined;
  const capture = (chunk: string) => {
    output += chunk;
    if (
      housekeepingMs == null &&
      output.includes("[startup] ServiceContainer.initialize completed")
    ) {
      housekeepingMs = performance.now() - start;
    }
  };
  child.stdout.setEncoding("utf8").on("data", capture);
  child.stderr.setEncoding("utf8").on("data", capture);
  let result;
  try {
    let healthMs: number | undefined;
    while (healthMs == null || housekeepingMs == null || !startup) {
      if (child.exitCode != null || child.signalCode != null)
        throw new Error("Server exited: " + output.slice(-4000));
      if (performance.now() - start > 180_000)
        throw new Error("Startup timed out: " + output.slice(-4000));
      if (healthMs == null) {
        try {
          const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          if (response.status === 200) healthMs = performance.now() - start;
        } catch {
          /* Tolerate failed health probes until the startup deadline. */
        }
      }
      if (housekeepingMs != null && !startup) {
        // Read the file sink's JSON-serialized startup payload; console output may span lines.
        const logfile = await readFile(join(fixture.root, "logs", "mux.log"), "utf8");
        for (const line of logfile.split("\n").slice(0, -1)) {
          startup = parseStartup(line) ?? startup;
        }
      }
      if (healthMs == null || housekeepingMs == null || !startup) await delay(10);
    }
    if (!startup || !child.pid) throw new Error("Missing startup measurement");
    const rssStartupBytes = await rss(child.pid);
    const client: RouterClient<AppRouter> = createORPCClient(
      new RPCLink({
        origin,
        url: "/orpc",
        fetch: (request, init) => fetch(request, { ...init, signal: AbortSignal.timeout(120_000) }),
      })
    );
    const calls: Record<string, Awaited<ReturnType<typeof measure>>[]> = {};
    const operations = {
      activityBootstrap: () => client.workspace.activity.list(),
      workspaceList: () => client.workspace.list(),
      archivedList: () => client.workspace.list({ archived: true }),
      projectsList: () => client.projects.list(),
      workspaceGetInfo: async () => {
        const result = await client.workspace.getInfo({ workspaceId });
        if (!result) throw new Error("Single-workspace read returned null");
        return result;
      },
      workspaceHeartbeat: async () => {
        const result = await client.workspace.heartbeat.get({ workspaceId });
        return result;
      },
    };
    for (const [name, operation] of Object.entries(operations))
      calls[name] = [await measure(operation)];
    calls.updateTitle = [];
    for (let i = 0; i < 10; i++) {
      calls.updateTitle.push(
        await measure(async () => {
          const result = await client.workspace.updateTitle({
            workspaceId,
            title: "Benchmark title " + i,
          });
          if (!result.success) throw new Error(String(result.error));
          return result;
        })
      );
    }
    const rssAfterCallsBytes = await rss(child.pid);
    result = {
      healthMs,
      housekeepingMs,
      initializeTotalMs: startup.totalMs,
      stepDurationsMs: startup.stepDurationsMs,
      rssStartupBytes,
      rssAfterCallsBytes,
      configBytes: Buffer.byteLength(source),
      calls,
    };
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, label + ".run-" + repetition + ".log"), output);
  }
  if (child.exitCode !== 0)
    throw new Error("Server did not shut down cleanly: " + child.signalCode);
  return result;
}

if (import.meta.main) {
  const args = benchArgs(3);
  await access(join(repoRoot, "dist/cli/index.js")).catch(() => {
    throw new Error("Build the baseline first: make build-main");
  });
  const fixture = await readFixture(args.root);
  const runs: Awaited<ReturnType<typeof runOnce>>[] = [];
  for (let i = 0; i < args.repetitions; i++) {
    console.log(args.label + ": server repetition " + (i + 1) + "/" + args.repetitions);
    runs.push(await runOnce(args.root, args.label, i + 1));
  }
  const metrics = Object.fromEntries(
    (
      [
        "healthMs",
        "housekeepingMs",
        "initializeTotalMs",
        "rssStartupBytes",
        "rssAfterCallsBytes",
      ] as const
    ).map((name) => [name, summarize(runs.map((run) => run[name]))])
  );
  const calls = Object.fromEntries(
    Object.keys(runs[0].calls).map((name) => {
      const samples = runs.flatMap((run) => run.calls[name]);
      return [
        name,
        {
          ms: summarize(samples.map((sample) => sample.ms)),
          bytes: summarize(samples.map((sample) => sample.bytes)),
        },
      ];
    })
  );
  const steps = Object.fromEntries(
    Object.keys(runs[0].stepDurationsMs).map((name) => [
      name,
      summarize(runs.map((run) => run.stepDurationsMs[name])),
    ])
  );
  console.log("\n### " + args.label + " server");
  printTable(
    Object.entries(metrics).map(([name, stats]) => [
      name,
      stats,
      name.endsWith("Bytes") ? "bytes" : "ms",
    ])
  );
  printTable(
    Object.entries(calls).flatMap(([name, stats]) => [
      [name, stats.ms, "ms"],
      [name + " payload", stats.bytes, "JSON bytes"],
    ])
  );
  printTable(Object.entries(steps).map(([name, stats]) => [name, stats, "ms"]));
  await writeResults(args.label, {
    fixture: fixture.options,
    repetitions: args.repetitions,
    configBytes: runs[0].configBytes,
    metrics,
    calls,
    steps,
    runs,
  });
}
