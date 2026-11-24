/**
 * Hosts that sandboxed agent commands may reach in the "allowlist" network mode when the user has
 * not edited the list: package registries and git hosts.
 */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
];
