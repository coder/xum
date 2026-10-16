import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "@babel/core";
import { reactCompilerConfig } from "@/vite/reactCompilerConfig";

/**
 * Loads one source module as production builds it: through React Compiler with the production
 * config from vite. Bun and Jest load sources without the compiler, so a plain test cannot see
 * what the compiler memoizes.
 *
 * The compiled module is evaluated with this file's (Jest) require, with relative imports resolved
 * against the module's own folder. So it shares React, the stores and the contexts with the test,
 * and no global loader or config changes.
 */
export function loadReactCompiledModule(modulePath: string): Record<string, unknown> {
  const compiled = transformSync(readFileSync(modulePath, "utf8"), {
    filename: modulePath,
    babelrc: false,
    configFile: false,
    // Same module output as the repo's Jest Babel config, from declared dependencies only.
    presets: [
      ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
      "@babel/preset-typescript",
    ],
    plugins: [["babel-plugin-react-compiler", reactCompilerConfig]],
  });
  assert(compiled?.code, `React Compiler produced no output for ${modulePath}`);

  const moduleExports: Record<string, unknown> = {};
  const compiledModule = { exports: moduleExports };
  // Evaluate the compiled source as a CommonJS module.
  const evaluate = vm.compileFunction(compiled.code, ["require", "module", "exports"], {
    filename: modulePath,
  });
  const requireFromModule = (id: string): unknown =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loads the module graph through Jest's registry
    require(id.startsWith(".") ? path.resolve(path.dirname(modulePath), id) : id);
  Reflect.apply(evaluate, undefined, [requireFromModule, compiledModule, moduleExports]);
  return compiledModule.exports;
}
