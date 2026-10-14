// negotiator ships no types. Only the API that src/node/orpc/server.ts uses is declared.
declare module "negotiator" {
  class Negotiator {
    constructor(request: { headers: Record<string, string | string[] | undefined> });
    encodings(available: readonly string[], options?: { preferred?: readonly string[] }): string[];
  }

  export = Negotiator;
}
