import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";

/**
 * Whether a failed `docker exec` / `devcontainer exec` never reached the
 * container (#4828, #4985): the daemon refused the exec (container stopped,
 * paused, restarting or gone) or could not be reached. Such a failure says
 * nothing about the file a probe asked for, so it must read as a transport
 * failure, never as "missing".
 *
 * docker 27 exits 1 for all of these (not 125), so the Docker client's own
 * diagnostic line is the signal. The rules follow the client source
 * (moby/moby client/request.go, client/errors.go) instead of listing states:
 * - every non-2xx API response is reported as "Error response from daemon: …",
 *   so any daemon refusal of the exec counts, whatever the state wording;
 * - a failed connection is "Cannot connect to the Docker daemon …" (older
 *   clients), "failed to connect to the docker API at …" (newer clients) or
 *   "error during connect: …".
 * Each pattern is anchored at a line start so a probe's own output cannot match
 * mid-line (our probes are cat/stat/find/mv, which never print these).
 *
 * Never transport: permanent daemon refusals (see PERMANENT_REFUSALS) and exit 126/127, docker's "command cannot be invoked" / "not
 * found" statuses (e.g. no bash in the image, "OCI runtime exec failed"), which
 * retrying cannot fix, even when a daemon line accompanies them. They still
 * fail loudly as unreadable reads. Podman's wording is not covered.
 */
const CONTAINER_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /^(?:docker: )?Error response from daemon: /m,
  /^(?:docker: )?Cannot connect to the Docker daemon/m,
  /^(?:docker: )?failed to connect to the docker API at /m,
  /^(?:docker: )?error during connect: /im,
  // devcontainer CLI when no container matches the workspace folder.
  /^(?:\[[^\]]*\] )?Error: Dev container not found\./m,
];

/**
 * Refusals that only a configuration change fixes, so retrying is pointless:
 * an API version mismatch (moby daemon/server/middleware/version.go), an
 * authorization plugin denial (moby daemon/pkg/authorization/authz.go), and a
 * socket the user may not open (a connection line ending in the dial error
 * "permission denied"). They stay non-transport and fail loudly as unreadable
 * reads.
 */
const PERMANENT_REFUSALS: readonly RegExp[] = [
  /^(?:docker: )?Error response from daemon: (?:client version \S+ is too (?:new|old)\b|authorization denied by plugin )/m,
  /^(?:docker: )?(?:Cannot connect to the Docker daemon|failed to connect to the docker API at |error during connect: )[^\n]*permission denied/im,
];

/** docker exec statuses for a command that could not be invoked or was not found. */
const COMMAND_NOT_INVOKABLE_EXITS: ReadonlySet<number> = new Set([126, 127]);

export function isContainerUnavailableExit(exitCode: number, stderr: string): boolean {
  // A probe that hit its own client-side deadline proved nothing about the file:
  // an unresponsive daemon or CLI reaches the 10 s probe deadlines first, often
  // with empty stderr. SSHRuntime treats its timeouts the same way (#4825).
  if (exitCode === EXIT_CODE_TIMEOUT) return true;
  if (exitCode === 0 || COMMAND_NOT_INVOKABLE_EXITS.has(exitCode)) return false;
  if (PERMANENT_REFUSALS.some((pattern) => pattern.test(stderr))) return false;
  return CONTAINER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}
