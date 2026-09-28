import * as path from "path";
import * as fsPromises from "fs/promises";

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import * as disposableExec from "@/node/utils/disposableExec";

import { MAX_FILE_SIZE } from "./fileCommon";
import { TestTempDir } from "./testHelpers";
import {
  assertValidSkillId,
  fetchSkillContent,
  searchSkillsCatalog,
  tryParseSource,
} from "./skillsCatalogFetch";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  void result.catch(noop);
  return {
    result,
    get promise() {
      return result;
    },
    child: {},
    [Symbol.dispose]: noop,
  } as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status });
}

function notFoundResponse(): Response {
  return textResponse("Not Found", 404);
}

function createOversizedSkillMarkdown(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Oversized skill",
    "---",
    "",
    "x".repeat(MAX_FILE_SIZE + 1_024),
  ].join("\n");
}

afterEach(() => {
  mock.restore();
});

describe("tryParseSource", () => {
  it("returns owner/repo for valid source string", () => {
    expect(tryParseSource("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null when source is missing slash", () => {
    expect(tryParseSource("invalid")).toBeNull();
  });

  it("returns null when source has extra path segments", () => {
    expect(tryParseSource("a/b/c")).toBeNull();
  });

  it("returns null for empty source", () => {
    expect(tryParseSource("")).toBeNull();
  });
});

describe("searchSkillsCatalog", () => {
  it("constructs correct URL and returns parsed response", async () => {
    const response = {
      query: "lint",
      searchType: "skills",
      skills: [
        {
          skillId: "lint",
          name: "Lint",
          installs: 10,
          source: "owner/repo",
        },
      ],
      count: 1,
    };

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(response));

    const result = await searchSkillsCatalog("lint", 5);

    expect(result).toEqual(response);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/search");
    expect(parsedUrl.searchParams.get("q")).toBe("lint");
    expect(parsedUrl.searchParams.get("limit")).toBe("5");
  });

  it("throws on non-200 response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(searchSkillsCatalog("lint", 5)).rejects.toThrow(
      "Skills catalog search failed with status 500"
    );
  });
});

describe("fetchSkillContent", () => {
  let execSpy: ReturnType<typeof spyOn<typeof disposableExec, "execFileAsync">> | null = null;

  afterEach(() => {
    execSpy?.mockRestore();
    execSpy = null;
  });

  it("finds skill by exact directory name", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-exact");
    const skillDir = path.join(tempDir.path, "skills", "my-skill");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: Test skill\n---\nBody\n"
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("clone")) {
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    const result = await fetchSkillContent("owner", "repo", "my-skill");

    expect(result.content).toBe("---\nname: my-skill\ndescription: Test skill\n---\nBody\n");
    expect(result.path).toBe("skills/my-skill/SKILL.md");
    expect(result.branch).toBe("main");

    expect(notFoundResponse().status).toBe(404);

    mkdtempSpy.mockRestore();
  });

  it("normalizes Windows-style relative paths to POSIX separators", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-windows-relative");
    const skillDir = path.join(tempDir.path, "skills", "my-skill");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: Test skill\n---\nBody\n"
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("clone")) {
        return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    const relativeSpy = spyOn(path, "relative").mockReturnValue("skills\\my-skill\\SKILL.md");

    const result = await fetchSkillContent("owner", "repo", "my-skill");

    expect(result.path).toBe("skills/my-skill/SKILL.md");
    expect(relativeSpy).toHaveBeenCalled();

    relativeSpy.mockRestore();
    mkdtempSpy.mockRestore();
  });

  it("finds skill by frontmatter name when directory differs", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-frontmatter");
    const skillDir = path.join(tempDir.path, "skills", "actual-dir");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: requested-skill\ndescription: Test skill\n---\nBody\n"
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    const result = await fetchSkillContent("owner", "repo", "requested-skill");

    expect(result.content).toBe("---\nname: requested-skill\ndescription: Test skill\n---\nBody\n");
    expect(result.path).toBe("skills/actual-dir/SKILL.md");
    expect(result.branch).toBe("main");

    mkdtempSpy.mockRestore();
  });

  it("skips oversized direct candidate and finds valid scanned match", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-oversized-direct");

    const oversizedSkillPath = path.join(tempDir.path, "skills", "my-skill", "SKILL.md");
    await fsPromises.mkdir(path.dirname(oversizedSkillPath), { recursive: true });
    await fsPromises.writeFile(oversizedSkillPath, createOversizedSkillMarkdown("my-skill"));

    const validSkillPath = path.join(tempDir.path, "skills", "other-dir", "SKILL.md");
    await fsPromises.mkdir(path.dirname(validSkillPath), { recursive: true });
    await fsPromises.writeFile(
      validSkillPath,
      "---\nname: my-skill\ndescription: Valid scanned match\n---\nBody\n"
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    const readFileSpy = spyOn(fsPromises, "readFile");

    const result = await fetchSkillContent("owner", "repo", "my-skill");

    expect(result.path).toBe("skills/other-dir/SKILL.md");
    expect(result.content).toContain("name: my-skill");
    expect(readFileSpy).not.toHaveBeenCalledWith(oversizedSkillPath, "utf-8");

    readFileSpy.mockRestore();
    mkdtempSpy.mockRestore();
  });

  it("skips oversized scan candidate", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-oversized-scan");

    const oversizedSkillPath = path.join(tempDir.path, "skills", "big-dir", "SKILL.md");
    await fsPromises.mkdir(path.dirname(oversizedSkillPath), { recursive: true });
    await fsPromises.writeFile(oversizedSkillPath, createOversizedSkillMarkdown("target-skill"));

    const validSkillPath = path.join(tempDir.path, "skills", "good-dir", "SKILL.md");
    await fsPromises.mkdir(path.dirname(validSkillPath), { recursive: true });
    await fsPromises.writeFile(
      validSkillPath,
      "---\nname: target-skill\ndescription: Valid scanned match\n---\nBody\n"
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    const readFileSpy = spyOn(fsPromises, "readFile");

    const result = await fetchSkillContent("owner", "repo", "target-skill");

    expect(result.path).toBe("skills/good-dir/SKILL.md");
    expect(result.content).toContain("name: target-skill");
    expect(readFileSpy).not.toHaveBeenCalledWith(oversizedSkillPath, "utf-8");

    readFileSpy.mockRestore();
    mkdtempSpy.mockRestore();
  });

  it("throws when only oversized candidates exist", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-only-oversized");

    const oversizedSkillPath = path.join(tempDir.path, "skills", "only-skill", "SKILL.md");
    await fsPromises.mkdir(path.dirname(oversizedSkillPath), { recursive: true });
    await fsPromises.writeFile(oversizedSkillPath, createOversizedSkillMarkdown("only-skill"));

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "only-skill")).rejects.toThrow(
      "Could not find SKILL.md for skill 'only-skill' in owner/repo"
    );

    mkdtempSpy.mockRestore();
  });

  it("throws when skill not found in clone", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-not-found");
    await fsPromises.mkdir(path.join(tempDir.path, "skills"), { recursive: true });

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "missing")).rejects.toThrow(
      "Could not find SKILL.md for skill 'missing' in owner/repo"
    );

    mkdtempSpy.mockRestore();
  });

  it("throws clear error when git is unavailable", async () => {
    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation(() => {
      return createMockExecResult(Promise.reject(new Error("spawn git ENOENT")));
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "skill")).rejects.toThrow("git is required");
  });

  it("throws clear error when clone fails", async () => {
    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("clone")) {
        return createMockExecResult(Promise.reject(new Error("fatal: repository not found")));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue("/tmp/mux-skill-fake");

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "skill")).rejects.toThrow(
      "Failed to clone owner/repo"
    );

    mkdtempSpy.mockRestore();
  });

  it("rejects path traversal in skillId", async () => {
    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "../escape")).rejects.toThrow(
      /Invalid skillId/
    );
  });

  it("does not false-match body-only name: lines", async () => {
    using tempDir = new TestTempDir();

    // Create a skill whose frontmatter name differs but body has name: target-skill
    const skillDir = path.join(tempDir.path, "skills", "some-dir");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: different-skill",
        "description: A test skill",
        "---",
        "",
        "name: target-skill",
        "This body line should not match.",
      ].join("\n")
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    // Mock mkdtemp to return our controlled temp dir
    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "target-skill")).rejects.toThrow(
      /Could not find/i
    );

    mkdtempSpy.mockRestore();
  });

  it("rejects direct path when frontmatter name mismatches", async () => {
    using tempDir = new TestTempDir();

    // Create a skill at skills/my-skill/SKILL.md but with mismatched frontmatter name
    const skillDir = path.join(tempDir.path, "skills", "my-skill");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: actually-different",
        "description: A test skill",
        "---",
        "",
        "Skill content here.",
      ].join("\n")
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "my-skill")).rejects.toThrow(/Could not find/i);

    mkdtempSpy.mockRestore();
  });

  it("rejects symlinked SKILL.md in direct path", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-symlink-direct");

    // Create a real file outside the skills directory
    const externalFile = path.join(tempDir.path, "external-secret.txt");
    await fsPromises.writeFile(externalFile, "secret content");

    // Create skill directory with SKILL.md as a symlink to the external file
    const skillDir = path.join(tempDir.path, "skills", "my-skill");
    await fsPromises.mkdir(skillDir, { recursive: true });
    await fsPromises.symlink(externalFile, path.join(skillDir, "SKILL.md"));

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "my-skill")).rejects.toThrow(/Could not find/i);

    mkdtempSpy.mockRestore();
  });

  it("skips symlinked candidate in scan and still finds valid match", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-symlink-scan");

    // Create a malicious symlink candidate
    const externalFile = path.join(tempDir.path, "external-secret.txt");
    await fsPromises.writeFile(externalFile, "secret content");
    const evilDir = path.join(tempDir.path, "skills", "evil-skill");
    await fsPromises.mkdir(evilDir, { recursive: true });
    await fsPromises.symlink(externalFile, path.join(evilDir, "SKILL.md"));

    // Create a legitimate skill that should still be found via scan
    const goodDir = path.join(tempDir.path, "skills", "actual-dir");
    await fsPromises.mkdir(goodDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(goodDir, "SKILL.md"),
      "---\nname: target-skill\ndescription: Legit skill\n---\nBody\n"
    );

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // Should find the legit skill via scan, skipping the symlinked one
    const result = await fetchSkillContent("owner", "repo", "target-skill");
    expect(result.content).toContain("name: target-skill");
    expect(result.path).toBe("skills/actual-dir/SKILL.md");

    mkdtempSpy.mockRestore();
  });

  it("rejects symlinked directory escape in scan", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-symlink-dir-escape");

    // Create an external directory with a SKILL.md that would match
    const externalDir = path.join(tempDir.path, "outside");
    await fsPromises.mkdir(externalDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: target-skill\ndescription: External\n---\nExternal body\n"
    );

    // Create skills root with a symlink directory pointing outside
    const skillsDir = path.join(tempDir.path, "skills");
    await fsPromises.mkdir(skillsDir, { recursive: true });
    await fsPromises.symlink(externalDir, path.join(skillsDir, "evil-dir"));

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(tempDir.path);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "target-skill")).rejects.toThrow(
      /Could not find/i
    );

    mkdtempSpy.mockRestore();
  });
  it("rejects symlinked skills root directory", async () => {
    using tempDir = new TestTempDir("test-fetch-skill-symlink-root");

    // Create an external directory with a matching skill
    const externalSkillsRoot = path.join(tempDir.path, "external-skills");
    const externalSkillDir = path.join(externalSkillsRoot, "my-skill");
    await fsPromises.mkdir(externalSkillDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: External skill\n---\nExternal body\n"
    );

    // Create clone dir and symlink skills -> external
    const cloneDir = path.join(tempDir.path, "clone");
    await fsPromises.mkdir(cloneDir, { recursive: true });
    await fsPromises.symlink(externalSkillsRoot, path.join(cloneDir, "skills"));

    execSpy = spyOn(disposableExec, "execFileAsync");
    execSpy.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("--version")) {
        return createMockExecResult(
          Promise.resolve({ stdout: "git version 2.40.0\n", stderr: "" })
        );
      }

      if (args.includes("rev-parse")) {
        return createMockExecResult(Promise.resolve({ stdout: "main\n", stderr: "" }));
      }

      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    const mkdtempSpy = spyOn(fsPromises, "mkdtemp");
    mkdtempSpy.mockResolvedValue(cloneDir);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
    await expect(fetchSkillContent("owner", "repo", "my-skill")).rejects.toThrow(
      /Unsafe catalog skills root/
    );

    mkdtempSpy.mockRestore();
  });
});

describe("assertValidSkillId", () => {
  it("accepts valid kebab-case skill names", () => {
    expect(() => assertValidSkillId("my-skill")).not.toThrow();
    expect(() => assertValidSkillId("skill123")).not.toThrow();
    expect(() => assertValidSkillId("a")).not.toThrow();
  });

  it("rejects path traversal attempts", () => {
    expect(() => assertValidSkillId("../escape")).toThrow(/Invalid skillId/);
    expect(() => assertValidSkillId("../../etc/passwd")).toThrow(/Invalid skillId/);
    expect(() => assertValidSkillId("/tmp/absolute")).toThrow(/Invalid skillId/);
  });

  it("rejects invalid formats", () => {
    expect(() => assertValidSkillId("Bad_Name")).toThrow(/Invalid skillId/);
    expect(() => assertValidSkillId("UPPER")).toThrow(/Invalid skillId/);
    expect(() => assertValidSkillId("")).toThrow(/Invalid skillId/);
    expect(() => assertValidSkillId("-leading")).toThrow(/Invalid skillId/);
    expect(() => assertValidSkillId("trailing-")).toThrow(/Invalid skillId/);
  });
});
