/**
 * Clone URL without scheme and `.git` ("github.com/foo/grill"), so a monorepo
 * folder appended to it reads as a path, not as an invalid `….git/pstack` URL.
 * Shared by Settings and the description of a generated plugin.json.
 */
export function displayRepoUrl(url: string): string {
  return url
    .replace(/^https:\/\//, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "");
}
