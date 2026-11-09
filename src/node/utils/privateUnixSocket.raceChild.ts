/**
 * Child for privateUnixSocket.test.ts: starts like a backend on the socket path in argv[2]. It
 * prints one line, "bound" or "refused: <why>", and a bound child holds the socket until stdin closes.
 */
import * as net from "node:net";
import { withPrivateUnixSocketPath } from "./privateUnixSocket";

async function main(socketPath: string): Promise<void> {
  const server = net.createServer();
  try {
    await withPrivateUnixSocketPath(
      socketPath,
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => resolve());
        })
    );
  } catch (error) {
    console.log(`refused: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log("bound");
  process.stdin.resume();
  process.stdin.on("end", () => server.close(() => process.exit(0)));
}

void main(process.argv[2]);
