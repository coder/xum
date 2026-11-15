/** How many `~/.ssh/config` hosts are suggested under the SSH host field at once. */
const MAX_SUGGESTED_HOSTS = 4;

/** Splits "user@host" at its last "@"; a value with no "@" is all host. */
function splitUser(value: string): { user: string; host: string } {
  const at = value.lastIndexOf("@");
  return at === -1
    ? { user: "", host: value }
    : { user: value.slice(0, at + 1), host: value.slice(at + 1) };
}

/**
 * The config hosts to offer for what is typed in the host field: those containing the typed host
 * part (after any "user@"), hosts that start with it first, without the one already typed in
 * full. Each suggestion keeps a typed "user@" prefix, so picking one never drops the user.
 */
export function suggestSshHosts(configHosts: readonly string[], typed: string): string[] {
  const { user, host } = splitUser(typed.trim());
  const needle = host.toLowerCase();
  const matches = configHosts.filter((candidate) => {
    const name = candidate.toLowerCase();
    return name !== needle && name.includes(needle);
  });
  const startsWith = (candidate: string) => candidate.toLowerCase().startsWith(needle);
  return [...matches.filter(startsWith), ...matches.filter((candidate) => !startsWith(candidate))]
    .slice(0, MAX_SUGGESTED_HOSTS)
    .map((candidate) => `${user}${candidate}`);
}
