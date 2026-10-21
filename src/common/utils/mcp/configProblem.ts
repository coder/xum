import type { MCPConfigProblem } from "@/common/types/mcp";

/** One line for a problem in mcp.jsonc, for the Settings list, the log and refused writes. */
export function formatMcpConfigProblem(problem: MCPConfigProblem): string {
  const where =
    problem.line === null
      ? ""
      : `Line ${problem.line}${problem.column === null ? "" : `, column ${problem.column}`}: `;
  const server = problem.server === null ? "" : `server "${problem.server}": `;
  return `${where}${server}${problem.message}`;
}
