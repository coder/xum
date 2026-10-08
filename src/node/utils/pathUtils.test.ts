import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expandTilde,
  validateProjectPath,
  isGitRepository,
  stripTrailingSlashes,
} from "./pathUtils";

describe("pathUtils", () => {
  describe("expandTilde", () => {
    it("should expand ~ to home directory", () => {
      const result = expandTilde("~/Documents");
      const expected = path.join(os.homedir(), "Documents");
      expect(result).toBe(expected);
    });

    it("should expand ~/ to home directory with trailing path", () => {
      const result = expandTilde("~/Projects/my-app");
      const expected = path.join(os.homedir(), "Projects", "my-app");
      expect(result).toBe(expected);
    });

    it("should return path unchanged if it doesn't start with ~", () => {
      const testPath = "/absolute/path/to/project";
      const result = expandTilde(testPath);
      expect(result).toBe(testPath);
    });

    it("should handle ~ alone (home directory)", () => {
      const result = expandTilde("~");
      expect(result).toBe(os.homedir());
    });

    it("should handle relative paths without tilde", () => {
      const relativePath = "relative/path";
      const result = expandTilde(relativePath);
      expect(result).toBe(relativePath);
    });

    it("should handle empty string", () => {
      const result = expandTilde("");
      expect(result).toBe("");
    });
  });

  describe("stripTrailingSlashes", () => {
    it("strips trailing separators from ordinary paths as before", () => {
      expect(stripTrailingSlashes("/home/user/project/")).toBe("/home/user/project");
      expect(stripTrailingSlashes("/home/user/project//")).toBe("/home/user/project");
      expect(stripTrailingSlashes("/home/user/project")).toBe("/home/user/project");
      expect(stripTrailingSlashes("C:\\Users\\project\\")).toBe("C:\\Users\\project");
      expect(stripTrailingSlashes("")).toBe("");
    });

    // #5917: "/" normalized to "", an invalid project key that the next config load dropped.
    it("keeps the filesystem root, which has no trailing slash to strip", () => {
      expect(stripTrailingSlashes("/")).toBe("/");
      expect(stripTrailingSlashes("//")).toBe("/");
      expect(stripTrailingSlashes("\\")).toBe("\\");
    });
  });

  describe("validateProjectPath", () => {
    // #5917: "/" used to fail only by accident ("" did not exist). Refuse it explicitly.
    it("refuses the filesystem root", async () => {
      for (const root of ["/", "//", "/tmp/.."]) {
        expect(await validateProjectPath(root)).toEqual({
          valid: false,
          error: "A project cannot be the filesystem root",
        });
      }
    });

    let tempDir: string;

    beforeEach(() => {
      // Create a temporary directory for testing
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-path-test-"));
    });

    afterEach(() => {
      // Clean up temporary directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should return success for existing git directory", async () => {
      // Create .git directory
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(tempDir, ".git"));
      const result = await validateProjectPath(tempDir);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
      expect(result.error).toBeUndefined();
    });

    it("should expand tilde and validate", async () => {
      // Create a test directory in home with .git
      const testDir = path.join(os.homedir(), `mux-test-git-${Date.now()}`);
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(testDir, { recursive: true });
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(testDir, ".git"));

      const result = await validateProjectPath(`~/${path.basename(testDir)}`);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(testDir);
      expect(result.error).toBeUndefined();

      // Cleanup
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it("should return error for non-existent path", async () => {
      const nonExistentPath = "/this/path/definitely/does/not/exist/mux-test-12345";
      const result = await validateProjectPath(nonExistentPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return error for file path (not directory)", async () => {
      const filePath = path.join(tempDir, "test-file.txt");
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.writeFileSync(filePath, "test content");

      const result = await validateProjectPath(filePath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not a directory");
    });

    it("should handle tilde path to non-existent directory", async () => {
      const nonExistentTildePath = "~/this-directory-should-not-exist-mux-test-12345";
      const result = await validateProjectPath(nonExistentTildePath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    it("should return normalized absolute path", async () => {
      const pathWithDots = path.join(tempDir, "..", path.basename(tempDir));
      // Add .git directory for validation
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(tempDir, ".git"));
      const result = await validateProjectPath(pathWithDots);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
    });

    it("should accept directory without .git (non-git repos are valid)", async () => {
      const result = await validateProjectPath(tempDir);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
    });

    it("should accept directory with .git", async () => {
      const gitDir = path.join(tempDir, ".git");
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(gitDir);

      const result = await validateProjectPath(tempDir);
      expect(result.valid).toBe(true);
      expect(result.expandedPath).toBe(tempDir);
    });

    it("should strip trailing slashes from path", async () => {
      // Create .git directory for validation
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(tempDir, ".git"));

      // Test with single trailing slash
      const resultSingle = await validateProjectPath(`${tempDir}/`);
      expect(resultSingle.valid).toBe(true);
      expect(resultSingle.expandedPath).toBe(tempDir);
      expect(resultSingle.expandedPath).not.toMatch(/[/\\]$/);

      // Test with multiple trailing slashes
      const resultMultiple = await validateProjectPath(`${tempDir}//`);
      expect(resultMultiple.valid).toBe(true);
      expect(resultMultiple.expandedPath).toBe(tempDir);
      expect(resultMultiple.expandedPath).not.toMatch(/[/\\]$/);
    });
  });

  describe("isGitRepository", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-git-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should return false for non-git directory", async () => {
      const result = await isGitRepository(tempDir);
      expect(result).toBe(false);
    });

    it("should return true for git directory", async () => {
      // eslint-disable-next-line local/no-sync-fs-methods -- Test setup only
      fs.mkdirSync(path.join(tempDir, ".git"));
      const result = await isGitRepository(tempDir);
      expect(result).toBe(true);
    });
  });
});
