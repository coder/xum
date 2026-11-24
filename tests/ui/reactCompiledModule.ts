import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "@babel/core";
import { reactCompilerConfig } from "@/vite/reactCompilerConfig";

/**
 * Babel's first transform wraps `Error.prepareStackTrace` and raises `Error.stackTraceLimit`, both
 * for the whole process, and never takes them back. Under Bun that wrapper breaks
 * `Error.captureStackTrace(plainObject)`: Bun's own `prepareStackTrace` refuses a first argument
 * that is not an Error, and undici's fetch() makes that call on every rejection, so a later test
 * file in the same process saw a TypeError with no cause instead of its own rejection. The unit
 * lane runs many files per process, so put both back after every transform.
 */
function keepErrorStackHooks<T>(run: () => T): T {
  const prepareStackTrace: unknown = Reflect.get(Error, "prepareStackTrace");
  const stackTraceLimit: unknown = Reflect.get(Error, "stackTraceLimit");
  try {
    return run();
  } finally {
    // Assign them back: on Bun, deleting or redefining `prepareStackTrace` leaves
    // captureStackTrace calling the hook with a plain object, which still throws.
    Reflect.set(Error, "prepareStackTrace", prepareStackTrace);
    Reflect.set(Error, "stackTraceLimit", stackTraceLimit);
  }
}

/**
 * Compiles one source module as production builds it: through React Compiler with the production
 * config from vite, as CommonJS. Every test that runs Babel goes through here, so none of them
 * leaves Babel's stack trace hooks behind (see keepErrorStackHooks).
 */
export function compileWithReactCompiler(modulePath: string): string {
  const compiled = keepErrorStackHooks(() =>
    transformSync(readFileSync(modulePath, "utf8"), {
      filename: modulePath,
      babelrc: false,
      configFile: false,
      // Same module output as the repo's Jest Babel config, from declared dependencies only.
      presets: [
        ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
        "@babel/preset-typescript",
        ["@babel/preset-react", { runtime: "automatic" }],
      ],
      plugins: [["babel-plugin-react-compiler", reactCompilerConfig]],
    })
  );
  assert(compiled?.code, `React Compiler produced no output for ${modulePath}`);
  return compiled.code;
}

/**
 * Loads one source module as production builds it: through React Compiler with the production
 * config from vite. Bun and Jest load sources without the compiler, so a plain test cannot see
 * what the compiler memoizes.
 *
 * The compiled module is evaluated with this file's require (Jest's or Bun's), with relative
 * imports resolved against the module's own folder. So it shares React, the stores and the
 * contexts with the test, and no global loader or config changes.
 */
export function loadReactCompiledModule(modulePath: string): Record<string, unknown> {
  const moduleExports: Record<string, unknown> = {};
  const compiledModule = { exports: moduleExports };
  // Evaluate the compiled source as a CommonJS module.
  const evaluate = vm.compileFunction(
    compileWithReactCompiler(modulePath),
    ["require", "module", "exports"],
    { filename: modulePath }
  );
  const requireFromModule = (id: string): unknown =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loads the module graph through Jest's registry
    require(id.startsWith(".") ? path.resolve(path.dirname(modulePath), id) : id);
  Reflect.apply(evaluate, undefined, [requireFromModule, compiledModule, moduleExports]);
  return compiledModule.exports;
}
