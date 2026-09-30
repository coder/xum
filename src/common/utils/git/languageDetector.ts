/**
 * Language detection utility for syntax highlighting in diffs
 * Maps file paths to Prism language identifiers using file extensions
 */

/**
 * Maps file extensions to Prism language identifiers
 * Comprehensive mapping covering common programming languages and formats
 */
const EXTENSION_TO_PRISM: Record<string, string> = {
  // JavaScript/TypeScript ecosystem
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",

  // Web technologies
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",

  // Backend languages
  ".py": "python",
  ".pyw": "python",
  ".java": "java",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".h": "c",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".sc": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".lua": "lua",
  ".pl": "perl",
  ".pm": "perl",
  ".r": "r",
  ".R": "r",

  // Shell/scripting
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",

  // Data/config formats
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".md": "markdown",
  ".markdown": "markdown",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",

  // Other languages
  ".vim": "vim",
  ".diff": "diff",
  ".patch": "diff",
  ".clj": "clojure",
  ".cljs": "clojurescript",
  ".coffee": "coffeescript",
  ".dart": "dart",
  ".elm": "elm",
  ".jl": "julia",
  ".nim": "nim",
  ".ml": "ocaml",
  ".re": "reason",
  ".sol": "solidity",
  ".zig": "zig",
};

/**
 * Maps special filenames to Prism language identifiers
 */
const FILENAME_TO_PRISM: Record<string, string> = {
  Dockerfile: "docker",
  "Dockerfile.dev": "docker",
  "Dockerfile.prod": "docker",
  "Dockerfile.test": "docker",
  Makefile: "makefile",
  GNUmakefile: "makefile",
  makefile: "makefile",
  Gemfile: "ruby",
  "Gemfile.lock": "ruby",
  Rakefile: "ruby",
  Vagrantfile: "ruby",
};

/**
 * Detects the programming language from a file path for syntax highlighting
 * @param filePath - Relative or absolute file path
 * @returns Prism language identifier (e.g., "typescript", "python") or "text" if unknown
 */
export function getLanguageFromPath(filePath: string): string {
  // Extract filename and extension
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1];
  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";

  // Check special filenames first (Dockerfile, Makefile, etc.)
  if (FILENAME_TO_PRISM[filename]) {
    return FILENAME_TO_PRISM[filename];
  }

  // Check extension mapping
  if (extension && EXTENSION_TO_PRISM[extension]) {
    return EXTENSION_TO_PRISM[extension];
  }

  // Unknown file type
  return "text";
}
