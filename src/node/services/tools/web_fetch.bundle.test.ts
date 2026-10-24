import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// These tests run the bundled module in a node child process: the Docker
// server runtime is node, and neither issue #3699's module-eval asset read
// nor happy-dom's subresource fetching reproduces under the bun test runner.
describe("web_fetch server bundle", () => {
  let tempDir: string;
  let bundlePath: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mux-web-fetch-bundle-"));
    bundlePath = join(tempDir, "web_fetch.bundle.js");

    const bundleResult = spawnSync(
      "bun",
      [
        "x",
        "esbuild",
        resolve("src/node/services/tools/web_fetch.ts"),
        "--bundle",
        "--platform=node",
        "--target=node22",
        "--format=cjs",
        `--outfile=${bundlePath}`,
        "--external:@lydell/node-pty",
        "--external:electron",
        "--external:ssh2",
        "--alias:jsonc-parser=jsonc-parser/lib/esm/main.js",
      ],
      { encoding: "utf8" }
    );
    expect(bundleResult.status, bundleResult.stderr).toBe(0);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads from outside the repository without runtime asset reads", () => {
    // Guards against module-eval-time runtime asset reads such as issue #3699's stylesheet failure.
    const loadResult = spawnSync(
      "node",
      [
        "-e",
        `const exports = require(${JSON.stringify(bundlePath)}); if (typeof exports.createWebFetchTool !== "function") process.exit(1);`,
      ],
      { cwd: tempDir, encoding: "utf8" }
    );
    expect(loadResult.status, loadResult.stderr).toBe(0);
  }, 30_000);

  it("does not fetch subresources from untrusted HTML while parsing", () => {
    // Subresources target loopback: the SSRF surface that
    // assertWebFetchTargetAllowed blocks for the top-level URL.
    const scriptPath = join(tempDir, "ssrf-check.cjs");
    writeFileSync(
      scriptPath,
      `
      const net = require("node:net");
      const { parseHtmlDocument } = require(${JSON.stringify(bundlePath)});

      const hits = [];
      const server = net.createServer((socket) => {
        socket.on("data", (data) => {
          const match = /^GET (\\S+)/.exec(data.toString());
          if (match) hits.push(match[1]);
        });
        socket.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const hostileHtml =
          '<!DOCTYPE html><html><head><title>Hostile Page</title>' +
          '<link rel="stylesheet" href="http://127.0.0.1:' + port + '/steal.css">' +
          '</head><body>' +
          '<iframe src="http://127.0.0.1:' + port + '/internal-admin"></iframe>' +
          '<script src="http://127.0.0.1:' + port + '/evil.js"><\\/script>' +
          '<article><h1>Cover story</h1><p>Plausible article text.</p></article>' +
          '</body></html>';
        const document = parseHtmlDocument(hostileHtml, "https://93.184.216.34/page");
        if (document.title !== "Hostile Page") {
          console.error("PARSE_BROKEN: title=" + document.title);
          process.exit(2);
        }
        // Subresource loads are asynchronous; give any leaked request time to arrive.
        setTimeout(() => {
          server.close();
          if (hits.length > 0) {
            console.error("SUBRESOURCE_FETCHED: " + hits.join(","));
            process.exit(1);
          }
          process.exit(0);
        }, 500);
      });
      `
    );

    const result = spawnSync("node", [scriptPath], { cwd: tempDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  // Runs `body` in a node child process with two loopback HTTP servers. Server A
  // redirects /redirect to server B. `body` gets the ports and must resolve after
  // it has given the document a chance to send requests. The process exits 1 if
  // either server saw a request. Only 127.0.0.1 appears in these tests.
  function runWithLoopbackServers(name: string, body: string) {
    const scriptPath = join(tempDir, `${name}.cjs`);
    writeFileSync(
      scriptPath,
      `
      const http = require("node:http");
      const { parseHtmlDocument } = require(${JSON.stringify(bundlePath)});

      const hits = [];
      const listen = (server) =>
        new Promise((resolveListen) =>
          server.listen(0, "127.0.0.1", () => resolveListen(server.address().port))
        );
      const serverB = http.createServer((req, res) => {
        hits.push("B " + req.url);
        res.end("b");
      });
      (async () => {
        const portB = await listen(serverB);
        const serverA = http.createServer((req, res) => {
          hits.push("A " + req.url);
          if (req.url === "/redirect") {
            res.writeHead(302, { location: "http://127.0.0.1:" + portB + "/after-redirect" });
            res.end();
            return;
          }
          res.end("a");
        });
        const portA = await listen(serverA);
        const run = async () => { ${body} };
        await run();
        serverA.close();
        serverB.close();
        if (hits.length > 0) {
          console.error("REQUEST_SENT: " + hits.join(","));
          process.exit(1);
        }
        process.exit(0);
      })().catch((error) => {
        console.error("SCRIPT_ERROR: " + (error && error.stack ? error.stack : error));
        process.exit(2);
      });
      `
    );
    // A sync XMLHttpRequest that reaches the network blocks this process's own
    // servers, so the child never exits: the timeout turns that hang into a failure.
    return spawnSync("node", [scriptPath], { cwd: tempDir, encoding: "utf8", timeout: 20_000 });
  }

  // Preload links are asynchronous: wait for happy-dom's own task queue, then
  // give any leaked request time to arrive.
  const parsePreloadPage = (href: string) => `
    const document = parseHtmlDocument(
      '<!DOCTYPE html><html><head><title>Preload Page</title>' +
        '<link rel="preload" as="fetch" href="${href}">' +
        '<link rel="modulepreload" href="${href}">' +
        '<link rel="prefetch" href="${href}">' +
        '</head><body><p>Text</p></body></html>',
      "http://127.0.0.1:" + portA + "/page"
    );
    if (document.title !== "Preload Page") throw new Error("parse broken: " + document.title);
    await document.defaultView.happyDOM.waitUntilComplete();
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  `;

  it("does not send requests for preload links while parsing", () => {
    const result = runWithLoopbackServers("preload", parsePreloadPage("/preloaded"));
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  it("does not send or follow redirects for preload links while parsing", () => {
    const result = runWithLoopbackServers("preload-redirect", parsePreloadPage("/redirect"));
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);

  it("refuses fetch and XMLHttpRequest from the parsed document's window", () => {
    // Parsing runs no scripts, so these calls stand in for any request type a
    // future happy-dom loader can send: the window must refuse all of them.
    const result = runWithLoopbackServers(
      "window-requests",
      `
      const document = parseHtmlDocument("<p>Text</p>", "http://127.0.0.1:" + portA + "/page");
      const window = document.defaultView;
      const response = await window.fetch("http://127.0.0.1:" + portA + "/redirect");
      if (response.ok) throw new Error("fetch was not refused: " + response.status);
      const syncRequest = new window.XMLHttpRequest();
      syncRequest.open("GET", "http://127.0.0.1:" + portA + "/sync", false);
      syncRequest.send();
      if (syncRequest.status === 200) throw new Error("sync XMLHttpRequest was not refused");
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      `
    );
    expect(result.status, result.stderr).toBe(0);
  }, 30_000);
});
