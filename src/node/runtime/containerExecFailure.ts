import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";

/**
 * Whether a failed `docker exec` / `devcontainer exec` never reached the
 * container (#4828): the container is stopped, paused or gone, or the daemon is
 * unreachable. Such a failure says nothing about the file a probe asked for, so
 * it must read as a transport failure, never as "missing".
 *
 * docker 27 exits 1 for all of these (not 125), so the CLI's own diagnostic
 * line is the only signal; each pattern is anchored at a line start so a probe's
 * own output cannot match mid-line. Deliberately excluded: exit 126 "OCI
 * runtime exec failed" (e.g. no bash in the image, which retrying cannot fix)
 * and podman's wording. Those still fail loudly as unreadable reads.
 */
const CONTAINER_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /^Error response from daemon: container \S+ is not running/im,
  /^Error response from daemon: container \S+ is paused/im,
  /^Error response from daemon: No such container:/m,
  /^Cannot connect to the Docker daemon/m,
  // The Docker client's prefix for other failed connections to the daemon, e.g.
  // Docker Desktop stopped on Windows ("… open //./pipe/docker_engine: The
  // system cannot find the file specified.").
  /^(?:docker: )?error during connect: /im,
  // devcontainer CLI when no container matches the workspace folder.
  /^(?:\[[^\]]*\] )?Error: Dev container not found\./m,
];

export function isContainerUnavailableExit(exitCode: number, stderr: string): boolean {
  // A probe that hit its own client-side deadline proved nothing about the file:
  // an unresponsive daemon or CLI reaches the 10 s probe deadlines first, often
  // with empty stderr. SSHRuntime treats its timeouts the same way (#4825).
  if (exitCode === EXIT_CODE_TIMEOUT) return true;
  return exitCode !== 0 && CONTAINER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}
