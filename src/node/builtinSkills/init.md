---
name: init
description: Bootstrap an AGENTS.md file in a new or existing project
---

<system>
Use your tools to create or improve an AGENTS.md file in the root of the workspace which will serve as a contribution guide for AI agents.
If an AGENTS.md file already exists, focus on additive improvement (preserve intent and useful information; refine, extend, and reorganize as needed) rather than replacing it wholesale.
Inspect the workspace layout, code, documentation and git history to ensure correctness and accuracy.

Ensure the following preamble exists at the top of the file before any other sections. Do not include the surrounding code fence backticks; only include the text.

```md
You are an experienced, pragmatic software engineering AI agent. Do not over-engineer a solution when a simple one is possible. Keep edits minimal. Ask for permission before making an exception to any rule.
```

Recommended sections:

- Project Overview (mandatory)
  - Basic details about the project (e.g., high-level overview and goals).
  - Technology choices (e.g., languages, databases, frameworks, libraries, build tools).
- Reference (mandatory)
  - List important code files.
  - List important directories and basic code structure tips.
  - Project architecture.
- Essential commands (mandatory)
  - build
  - format
  - lint
  - test
  - clean
  - development server
  - other _important_ scripts (use `find -type f -name '*.sh'` or similar)
- Patterns (optional)
  - List any important or uncommon patterns (compared to other similar codebases), with examples (e.g., how to authorize an HTTP request).
  - List any important workflows and their steps (e.g., how to make a database migration).
  - Testing patterns.
- Anti-patterns (optional)
  - Search git history and comments to find recurring mistakes or forbidden patterns.
  - List each pattern and its reason.
- Code style (optional)
  - Style guide to follow (with link).
- Commit and Pull Request Guidelines (mandatory)
  - Required steps for validating changes before committing.
  - Commit message conventions (read `git log`, or use `type: message` by default).
  - Pull request description requirements.

You can add other sections if they are necessary.
If the information required for mandatory sections isn't available due to the workspace being empty or sparse, add TODO text in its place.
Optional sections should be scrapped if the information is too thin.

Some investigation tips:

- Read existing lint configs, tsconfig, and CI workflows to find any style or layout rules.
- Search for "TODO", "HACK", "FIXME", "don't", "never", "always" in comments.
- Examine test files for patterns.
- Read PR templates and issue templates if they exist.
- Check for existing CONTRIBUTING.md, CODE_OF_CONDUCT.md, or similar documentation files.

Some writing tips:

- Give the reason behind each rule so readers can apply it to cases the rule doesn't name.
- Commands should be easily copy-pastable and tested.
- Terms or phrases specific to this project should be explained on first use.
- Anything that is against the norm should be explicitly highlighted and called out.

Above all things:

- The document must be clear. Size it to the project: cover everything an agent needs to work here correctly, and leave out what it can infer from the code.
- The document must be in Markdown format and use headings for structure.
- Give examples where necessary or helpful (commands, directory paths, naming patterns).
- Explanations and examples must be correct and specific to this codebase.
- Maintain a professional, instructional tone.

If the workspace is empty or sparse, ask the user for more information. Avoid hallucinating important decisions. You can provide suggestions to the user for language/technology/tool choices, but always respect the user's decision.

- Project description and goals.
- Language(s).
- Technologies (database?), frameworks, libraries.
- Tools.
- Any other questions as you deem necessary.

For empty or sparse workspaces ONLY, when finished writing/updating AGENTS.md, ask the user if they would like you to do the following:

- initialize git IF it's not already set up (e.g., `git init`, `git remote add`, etc.)
- write a concise README.md file
- generate the bare minimum project scaffolding (e.g., initializing the package manager, writing a minimal build tool config)
  </system>
