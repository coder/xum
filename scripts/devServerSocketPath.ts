/**
 * Prints the socket path that `make dev-server` gives the backend and Vite: `<folder>/<file name>`,
 * or a path in a fresh private folder next to `<folder>` when another account made `<folder>` first
 * (see chooseDevSocketPath). Run by make before anything is built, so it uses only built-ins.
 * Usage: bun scripts/devServerSocketPath.ts <folder> <file name>
 * Exits 1 with the reason on stderr when no safe folder exists.
 */
import * as path from "node:path";
import { chooseDevSocketPath } from "../src/node/utils/privateUnixSocketFolder";

const [folder, fileName] = process.argv.slice(2);
const uid = process.getuid?.();
if (!folder || !fileName || uid === undefined) {
  console.error("usage: bun scripts/devServerSocketPath.ts <folder> <file name> (not on Windows)");
  process.exit(1);
}

try {
  const choice = await chooseDevSocketPath(folder, fileName, uid);
  if (choice.fellBackFrom) {
    // Not on stdout: make reads the path from there. The user sees this on the terminal.
    console.error(
      `xum: ${choice.fellBackFrom.reason}\n` +
        `xum: so the dev-server socket is in ${path.dirname(choice.socketPath)} instead (a fresh folder only you can enter).`
    );
  }
  process.stdout.write(choice.socketPath);
} catch (error) {
  console.error(`xum: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
