/**
 * Install-method fixtures for the bug bash (startApp.ts seed, charters.install-methods.txt).
 *
 * Local git repositories that Settings > Plugins installs from their absolute path: a Claude Code
 * plugin, a Claude Code marketplace, a plain skills repository, an Agent Plugin with skills, a
 * repository with one manifest per agent tool (multi-harness), a Claude Code plugin next to
 * another tool's plugin.json (claude-foreign-root), a small copy of Cursor's cursor-team-kit
 * (cursor-team-kit-mini) and a repository with both marketplace files (cursor-market).
 * Nothing here runs on install or review: the one MCP server stays disabled until the user turns
 * it on (and bin/server only exits 0), Claude hooks never run in Xum, and Xum never loads a Claude
 * plugin's hooks.js or workflows/ (both are inert anyway). Model-driven jobs also set
 * XUM_DISABLE_AGENT_TOOLS=1.
 *
 * Only local paths install here (the sandbox has no network), so Settings never offers the Skills
 * CLI choice, which takes only remote sources (skillsCliSource.ts). The marketplace's github entry
 * fails offline on purpose: its error must say why.
 */
import * as fs from "fs";
import * as path from "path";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 as SCHEMA_ID } from "../../src/node/services/agentPlugins/manifest";
import { commitFixture } from "./pluginHookFixtures";

/** relative path -> file content; `mode` marks the executable ones. */
type Files = Record<string, string>;

const skillMd = (name: string, description: string, body = "Follow these steps.\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

function claudeReviewKit(): Files {
  return {
    ".claude-plugin/plugin.json": JSON.stringify(
      {
        name: "claude-review-kit",
        version: "1.0.0",
        description: "Code review helpers in the Claude Code plugin format (bug-bash fixture)",
        author: { name: "Bug Bash" },
      },
      null,
      2
    ),
    "skills/lint-rules/SKILL.md": skillMd(
      "lint-rules",
      "Explains the lint rules of this project and how to fix each finding"
    ),
    "skills/test-plan/SKILL.md": skillMd(
      "test-plan",
      "Writes a short test plan for a change before you implement it"
    ),
    "commands/review.md":
      "---\ndescription: Review the current changes\nargument-hint: [focus]\n---\n" +
      "Review the current changes. Focus on: $ARGUMENTS\n",
    "agents/reviewer.md":
      "---\nname: reviewer\ndescription: Reviews code changes and lists problems by severity\n---\n" +
      "You review code changes. List each problem with its file and line.\n",
    ".mcp.json": JSON.stringify(
      {
        mcpServers: {
          "review-index": { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", args: ["--stdio"] },
        },
      },
      null,
      2
    ),
    // Inert: the server is off until the user enables it, and then it only exits.
    "bin/server": "#!/bin/sh\nexit 0\n",
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "echo formatted" }] },
        ],
      },
    }),
    // Xum never loads these for a Claude Code plugin; they would do nothing if it did.
    "hooks.js": "({});\n",
    "workflows/x.js": "// Must never load from a Claude Code plugin.\nexport default {};\n",
  };
}

function claudeMarket(): Files {
  return {
    ".claude-plugin/marketplace.json": JSON.stringify(
      {
        name: "bugbash-market",
        owner: { name: "Bug Bash Team" },
        metadata: { description: "A Claude Code marketplace for the bug bash" },
        plugins: [
          // Two root entries with different skill lists, like anthropics/skills.
          {
            name: "document-skills",
            description: "PDF and spreadsheet skills",
            source: "./",
            strict: false,
            skills: ["./skills/pdf", "./skills/xlsx"],
          },
          {
            name: "art-skills",
            description: "Drawing and color skills",
            source: "./",
            strict: false,
            skills: ["./skills/art"],
          },
          {
            name: "tools",
            description: "Formatting tools with their own plugin manifest",
            source: "./plugins/tools",
          },
          {
            name: "npm-tools",
            description: "Published on npm (Xum does not install it)",
            source: { source: "npm", package: "@bugbash/npm-tools" },
          },
          {
            name: "remote-kit",
            description: "Lives on GitHub (fails offline)",
            source: { source: "github", repo: "bugbash/remote-kit" },
          },
        ],
      },
      null,
      2
    ),
    "skills/pdf/SKILL.md": skillMd("pdf", "Reads and fills PDF forms"),
    "skills/xlsx/SKILL.md": skillMd("xlsx", "Reads and edits spreadsheets"),
    "skills/art/SKILL.md": skillMd("art", "Draws simple diagrams and picks colors"),
    "plugins/tools/.claude-plugin/plugin.json": JSON.stringify(
      { name: "tools", version: "1.0.0", description: "Formatting tools" },
      null,
      2
    ),
    "plugins/tools/skills/tool-tips/SKILL.md": skillMd(
      "tool-tips",
      "Tips for the formatting tools"
    ),
    "plugins/tools/commands/fmt.md":
      "---\ndescription: Format the given files\n---\nFormat $ARGUMENTS\n",
  };
}

function plainSkills(): Files {
  return {
    "README.md": "# Plain skills\n\nSKILL.md folders only, no plugin manifest.\n",
    "skills/changelog/SKILL.md": skillMd("changelog", "Writes a changelog entry for a change"),
    "skills/commit-message/SKILL.md": skillMd(
      "commit-message",
      "Writes a commit message from the staged diff"
    ),
    "skills/release-check/SKILL.md": skillMd(
      "release-check",
      "Checks that a release is ready to ship"
    ),
    // One catalog level below skills/.
    "skills/writing/plain-english/SKILL.md": skillMd(
      "plain-english",
      "Rewrites text in short, plain sentences"
    ),
    "skills/writing/doc-outline/SKILL.md": skillMd(
      "doc-outline",
      "Outlines a document before you write it"
    ),
    // Valid: metadata holds a nested map, like warpdotdev/common-skills merge-risk.
    "skills/merge-risk/SKILL.md":
      "---\nname: merge-risk\ndescription: Rates the risk of merging a pull request\n" +
      'metadata:\n  version: "1.0"\n  credits:\n    skill: pr\n    author: Bug Bash\n---\n' +
      "Follow these steps.\n",
    // Invalid: the description is longer than the 1024-character limit.
    "skills/writing/too-long/SKILL.md": skillMd(
      "too-long",
      "This description is far too long. ".repeat(40).trim()
    ),
  };
}

function agentPluginWithSkills(): Files {
  return {
    "plugin.json": JSON.stringify(
      {
        $schema: SCHEMA_ID,
        name: "agent-plugin-with-skills",
        version: "1.0.0",
        description: "An Agent Plugin that ships two skills (bug-bash fixture)",
      },
      null,
      2
    ),
    "skills/api-docs/SKILL.md": skillMd("api-docs", "Writes API reference docs from the code"),
    "skills/changelog-writer/SKILL.md": skillMd(
      "changelog-writer",
      "Writes release notes from merged changes"
    ),
  };
}

/**
 * The shape of DietrichGebert/ponytail: a root plugin.json with no `$schema` (another harness's
 * file), next to complete Codex and Claude Code manifests. Xum must install it through the Codex
 * manifest instead of failing on the root file.
 */
function multiHarness(): Files {
  const about = {
    name: "multi-harness",
    version: "2.0.0",
    description: "One repository with a manifest for each agent tool (bug-bash fixture)",
  };
  return {
    "plugin.json": JSON.stringify({ name: "multi-harness" }, null, 2),
    ".codex-plugin/plugin.json": JSON.stringify({ ...about, skills: "./skills/" }, null, 2),
    ".claude-plugin/plugin.json": JSON.stringify(about, null, 2),
    "skills/keep-it-small/SKILL.md": skillMd(
      "keep-it-small",
      "Picks the smallest change that fully solves the task"
    ),
    "skills/debt-ledger/SKILL.md": skillMd(
      "debt-ledger",
      "Lists the shortcuts in the code as a debt ledger"
    ),
  };
}

/**
 * A root plugin.json with no `$schema` next to a Claude Code manifest only: discovery loads the
 * Claude manifest, so Settings must offer "Claude Code plugin", not "Agent Plugin".
 */
function claudeForeignRoot(): Files {
  return {
    "plugin.json": JSON.stringify({ name: "claude-foreign-root" }, null, 2),
    ".claude-plugin/plugin.json": JSON.stringify(
      {
        name: "claude-foreign-root",
        version: "1.1.0",
        description: "A Claude Code plugin next to another tool's plugin.json (bug-bash fixture)",
      },
      null,
      2
    ),
    "skills/release-notes/SKILL.md": skillMd(
      "release-notes",
      "Writes release notes from the merged changes"
    ),
  };
}

/**
 * Skill folders in snake_case, as google/elephant-goldfish-model ships them: Claude Code and Codex
 * name a skill by its SKILL.md `name`, so `skills/egm_bootstrap` holds `egm-bootstrap`.
 */
function snakeCaseSkills(): Files {
  return {
    "plugin.json": JSON.stringify(
      {
        $schema: SCHEMA_ID,
        name: "snake-case-skills",
        version: "1.0.0",
        description: "An Agent Plugin whose skill folders use snake_case names (bug-bash fixture)",
      },
      null,
      2
    ),
    "skills/egm_bootstrap/SKILL.md": skillMd(
      "egm-bootstrap",
      "Writes a README.md for each folder of a repository subtree"
    ),
    "skills/egm_review_loop/SKILL.md": skillMd(
      "egm-review-loop",
      "Reviews a design document again until no reviewer finds a problem"
    ),
  };
}

/**
 * The parts of cursor/plugins' cursor-team-kit that the Cursor plugin RFC maps: two skills, a
 * `model: fast` background agent, a readonly agent, an always-apply rule and a glob rule.
 */
function cursorTeamKitMini(): Files {
  return {
    ".cursor-plugin/plugin.json": JSON.stringify({ name: "cursor-team-kit-mini" }, null, 2),
    "skills/alpha/SKILL.md": skillMd("alpha", "Plans a change before it is written"),
    "skills/beta/SKILL.md": skillMd("beta", "Checks a change after it is written"),
    "agents/ci-watcher.md":
      "---\nname: ci-watcher\ndescription: Watches CI for the current branch and reports the result\n" +
      "model: fast\nis_background: true\n---\nReport pass or fail for each check.\n",
    "agents/reviewer.md":
      "---\nname: reviewer\ndescription: Reviews a diff and lists problems by severity\n" +
      "readonly: true\n---\nList each problem with its file and line.\n",
    "rules/a.mdc": "---\ndescription: Rule A\nalwaysApply: true\n---\nKeep imports at the top.\n",
    "rules/b.mdc": '---\nglobs: "**/*.ts"\n---\nUse exhaustive switches.\n',
  };
}

/**
 * The shape of cursor/plugins: a Cursor and a Claude Code marketplace file that both list
 * `pstack`, each at its own folder. The two builds have different skills, so a repro can tell
 * which one was installed.
 */
function cursorMarket(): Files {
  const marketplace = (source: string) =>
    JSON.stringify(
      { name: "cursor-market", owner: { name: "Bug Bash" }, plugins: [{ name: "pstack", source }] },
      null,
      2
    );
  return {
    ".cursor-plugin/marketplace.json": marketplace("./pstack"),
    ".claude-plugin/marketplace.json": marketplace("./claude/pstack"),
    "pstack/.cursor-plugin/plugin.json": JSON.stringify(
      { name: "pstack", version: "1.0.0", description: "The Cursor build of pstack" },
      null,
      2
    ),
    "pstack/skills/plan-first/SKILL.md": skillMd(
      "plan-first",
      "Writes a short plan before any code changes"
    ),
    "claude/pstack/.claude-plugin/plugin.json": JSON.stringify(
      { name: "pstack", version: "1.0.0", description: "The Claude Code build of pstack" },
      null,
      2
    ),
    "claude/pstack/skills/claude-notes/SKILL.md": skillMd(
      "claude-notes",
      "Keeps notes the way Claude Code reads them"
    ),
  };
}

const EXECUTABLE = new Set(["claude-review-kit/bin/server"]);

export function installFixtures(): Record<string, Files> {
  return {
    "claude-review-kit": claudeReviewKit(),
    "claude-market": claudeMarket(),
    "plain-skills": plainSkills(),
    "agent-plugin-with-skills": agentPluginWithSkills(),
    "multi-harness": multiHarness(),
    "claude-foreign-root": claudeForeignRoot(),
    "snake-case-skills": snakeCaseSkills(),
    "cursor-team-kit-mini": cursorTeamKitMini(),
    "cursor-market": cursorMarket(),
  };
}

/** Writes each fixture as a one-commit git repository; returns name -> absolute path. */
export function writeInstallSources(root: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const paths = new Map<string, string>();
  for (const [name, files] of Object.entries(installFixtures())) {
    const dir = path.join(root, name);
    for (const [relPath, content] of Object.entries(files)) {
      const file = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, {
        mode: EXECUTABLE.has(`${name}/${relPath}`) ? 0o755 : 0o644,
      });
    }
    commitFixture(dir, env);
    paths.set(name, dir);
  }
  return paths;
}
