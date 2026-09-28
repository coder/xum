// React Compiler configuration, shared by vite.config.ts and
// scripts/check_react_compiler_coverage.ts so the coverage guard audits exactly
// what the build compiles.
// See: https://react.dev/learn/react-compiler
export const reactCompilerConfig = {
  target: "18", // Target React 18 (requires react-compiler-runtime package)
} as const;
