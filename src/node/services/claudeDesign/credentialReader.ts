import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES,
  CLAUDE_DESIGN_READ_TIMEOUT_MS,
} from "@/common/constants/claudeDesign";
import type { ClaudeDesignSource } from "@/common/orpc/schemas/claudeDesign";

// Security framework's fail-UI mode is essential: the security CLI can prompt
// during a background tool call. Arguments are data, never interpolated code.
// JXA exposes CF constants (kSec*, kCFBooleanTrue) and CF out-params as opaque
// refs: used directly as dictionary keys they all collapse into ONE entry, so
// SecItemCopyMatching fails with errSecParam (-50) on every call. Cast each ref
// to its toll-free-bridged object first, and assert the query kept all keys.
const KEYCHAIN_READER = `
ObjC.import('Foundation');
ObjC.import('Security');
function run(argv) {
  const cf = (ref) => ObjC.castRefToObject(ref);
  const query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey(cf($.kSecClassGenericPassword), cf($.kSecClass));
  query.setObjectForKey($(argv[0]), cf($.kSecAttrService));
  query.setObjectForKey($(argv[1]), cf($.kSecAttrAccount));
  query.setObjectForKey(cf($.kCFBooleanTrue), cf($.kSecReturnData));
  query.setObjectForKey(cf($.kSecMatchLimitOne), cf($.kSecMatchLimit));
  query.setObjectForKey(cf($.kSecUseAuthenticationUIFail), cf($.kSecUseAuthenticationUI));
  // JXA bridges NSUInteger properties as strings, hence Number().
  if (Number(query.count) !== 6) throw new Error('Malformed Keychain query');
  const result = Ref();
  const status = $.SecItemCopyMatching(query, result);
  if (status !== 0) throw new Error('Credential access unavailable');
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(cf(result[0]), $.NSUTF8StringEncoding));
}`;

// Fail closed on ACLs permitting anyone except the current account, SYSTEM,
// and administrators. Never chmod/rewrite a shared Claude credential file.
const CHECK_WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:XUM_DESIGN_CREDENTIAL_PATH
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $me) { exit 1 }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($me, 'S-1-5-18', 'S-1-5-32-544')) { exit 1 }
}
`;

/** Captures output privately; child errors can contain stdout, so never expose them. */
function capture(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: CLAUDE_DESIGN_READ_TIMEOUT_MS,
        maxBuffer: CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES,
        windowsHide: true,
        env,
        signal,
      },
      (error, stdout) => {
        if (error) reject(new Error("Claude credentials unavailable"));
        else resolve(stdout);
      }
    );
  });
}

export async function readClaudeCredentialSource(
  source: ClaudeDesignSource,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  if (source.type === "keychain") {
    if (process.platform !== "darwin") throw new Error("Keychain requires macOS");
    return capture(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", KEYCHAIN_READER, source.service, source.account],
      undefined,
      signal
    );
  }
  if (!path.isAbsolute(source.path)) throw new Error("Select an absolute backend file path");
  const before = await fs.lstat(source.path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Not a regular credential file");
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error("Windows credential permissions unavailable");
    await capture(
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", CHECK_WINDOWS_ACL],
      { ...process.env, XUM_DESIGN_CREDENTIAL_PATH: source.path },
      signal
    );
  }
  const file = await fs.open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES
    ) {
      throw new Error("Invalid credential file");
    }
    if (
      process.platform !== "win32" &&
      (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    ) {
      throw new Error("Credential file must be private to its owner");
    }
    const buffer = Buffer.alloc(CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, count, buffer.length - count, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count > CLAUDE_DESIGN_MAX_CREDENTIAL_BYTES) throw new Error("Credential file too large");
    return buffer.toString("utf8", 0, count);
  } finally {
    await file.close();
  }
}
