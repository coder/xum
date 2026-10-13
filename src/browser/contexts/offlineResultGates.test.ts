import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * A handler that answers "offline" with a result (`{ success: false }`) or an error must check
 * the live client (`useLiveAPI()`), not `useAPI().api`. While Xum reconnects, useAPI() can keep
 * the last client: a gate on it lets the call through, and the call fails with
 * ConnectionLostError instead of the handler's own offline result.
 *
 * The check follows the gated name to its declaration, whatever it is called: `{ api } =
 * useAPI()`, `{ api: client } = useAPI()`, `useAPI().api`, or `state.api` with
 * `state = useAPI()`.
 */
function missingCheckName(expression: ts.Expression): ts.Identifier | null {
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return ts.isIdentifier(expression.operand) ? expression.operand : null;
  }
  const isNullCheck =
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) &&
    (expression.right.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(expression.right) && expression.right.text === "undefined"));
  return isNullCheck && ts.isIdentifier(expression.left) ? expression.left : null;
}

const isUseAPICall = (node: ts.Expression | undefined): boolean =>
  node != null &&
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "useAPI";

/** The declaration of `name` that is visible at `from`, searching the enclosing blocks. */
function findDeclaration(name: string, from: ts.Node): ts.VariableDeclaration | null {
  for (let scope: ts.Node | undefined = from.parent; scope != null; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaredNames(declaration).has(name)) return declaration;
      }
    }
  }
  return null;
}

/** Local name -> the property it reads (`{ api: client }` gives client -> api). */
function declaredNames(declaration: ts.VariableDeclaration): Map<string, string | null> {
  const names = new Map<string, string | null>();
  if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, null);
  if (ts.isObjectBindingPattern(declaration.name)) {
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property = element.propertyName ?? element.name;
      names.set(element.name.text, ts.isIdentifier(property) ? property.text : null);
    }
  }
  return names;
}

/** Whether `name` (declared at `declaration`) is the client from useAPI(). */
function isUseAPIClient(name: string, declaration: ts.VariableDeclaration): boolean {
  const init = declaration.initializer;
  if (ts.isObjectBindingPattern(declaration.name)) {
    return isUseAPICall(init) && declaredNames(declaration).get(name) === "api";
  }
  // `useAPI().api`, or `state.api` where `state = useAPI()`.
  if (init == null || !ts.isPropertyAccessExpression(init) || init.name.text !== "api") {
    return false;
  }
  if (isUseAPICall(init.expression)) return true;
  if (!ts.isIdentifier(init.expression)) return false;
  const holder = findDeclaration(init.expression.text, declaration);
  return holder != null && ts.isIdentifier(holder.name) && isUseAPICall(holder.initializer);
}

function isUseAPIClientCheck(expression: ts.Expression): boolean {
  const name = missingCheckName(expression);
  if (name == null) return false;
  const declaration = findDeclaration(name.text, expression);
  return declaration != null && isUseAPIClient(name.text, declaration);
}

function isOfflineResult(statement: ts.Statement | undefined, source: ts.SourceFile): boolean {
  if (statement == null) return false;
  if (ts.isThrowStatement(statement)) return true;
  return (
    ts.isReturnStatement(statement) &&
    statement.expression != null &&
    /success:\s*false/.test(statement.expression.getText(source))
  );
}

function findOldGates(file: string, text: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && isUseAPIClientCheck(node.expression)) {
      const then = node.thenStatement;
      if (isOfflineResult(ts.isBlock(then) ? then.statements[0] : then, source)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push(`${file}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function findOldGatesInRenderer(): string[] {
  const files = execFileSync("git", ["ls-files", "src/browser"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|stories)\./.test(file));
  return files.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return text.includes("useAPI") ? findOldGates(file, text) : [];
  });
}

describe("offline result gates", () => {
  test("check the live client, not useAPI().api", () => {
    expect(findOldGatesInRenderer()).toEqual([]);
  });

  // The scanner itself: it follows each name to where the client comes from.
  test.each([
    ["const { api } = useAPI();", "api", true],
    ["const { api: client } = useAPI();", "client", true],
    ["const client = useAPI().api;", "client", true],
    ["const state = useAPI(); const client = state.api;", "client", true],
    ["const api = useLiveAPI();", "api", false],
    ["const { api } = props;", "api", false],
  ])("%s, then a gate on %s: old gate %p", (declaration, name, old) => {
    const text = [
      "function useX() {",
      `  ${declaration}`,
      "  const run = () => {",
      `    if (!${name}) return { success: false, error: "offline" };`,
      "  };",
      "}",
    ].join("\n");
    expect(findOldGates("x.tsx", text)).toEqual(old ? ["x.tsx:4"] : []);
  });
});
