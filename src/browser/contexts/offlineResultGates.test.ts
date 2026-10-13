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
 * Renderer code names the useAPI() client `api` and the live one `liveApi`, so a gate on `api`
 * is the old shape.
 */
function isApiMissingCheck(expression: ts.Expression): boolean {
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return ts.isIdentifier(expression.operand) && expression.operand.text === "api";
  }
  return (
    ts.isBinaryExpression(expression) &&
    ts.isIdentifier(expression.left) &&
    expression.left.text === "api" &&
    (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken)
  );
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

function findOldGates(): string[] {
  const files = execFileSync("git", ["ls-files", "src/browser"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|stories)\./.test(file));
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("api")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isIfStatement(node) && isApiMissingCheck(node.expression)) {
        const then = node.thenStatement;
        if (isOfflineResult(ts.isBlock(then) ? then.statements[0] : then, source)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          found.push(`${file}:${line}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("offline result gates", () => {
  test("check the live client, not useAPI().api", () => {
    expect(findOldGates()).toEqual([]);
  });
});
