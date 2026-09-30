import type { ConfigOperation } from "@/common/config/schemas/configOperations";
import {
  deepClone,
  hasOwnRecordKey,
  isObjectRecord,
  parseArrayIndex,
} from "@/node/services/tools/shared/configToolUtils";
import type * as z from "zod";

const DENIED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

// Prevent sparse-array OOM: reject indices that would create unreasonably large arrays.
const MAX_MUTATION_ARRAY_INDEX = 10_000;

function parseBoundedArrayIndex(
  segment: string,
  path: readonly string[],
  untilInclusive?: number
): { ok: true; index: number } | { ok: false; error: string } {
  const parsed = parseArrayIndex(segment);
  if (parsed === null) {
    return {
      ok: false,
      error: `Expected numeric array index at ${formatPath(path, untilInclusive)}`,
    };
  }
  if (parsed > MAX_MUTATION_ARRAY_INDEX) {
    return {
      ok: false,
      error: `Array index ${parsed} exceeds maximum ${MAX_MUTATION_ARRAY_INDEX} at ${formatPath(path, untilInclusive)}`,
    };
  }
  return { ok: true, index: parsed };
}

export interface MutationSuccess<TDocument = unknown> {
  success: true;
  document: TDocument;
  appliedOps: number;
}

export interface MutationError {
  success: false;
  error: string;
  validationIssues?: z.ZodIssue[];
}

export type MutationResult<TDocument = unknown> = MutationSuccess<TDocument> | MutationError;

type MutableContainer = Record<string, unknown> | unknown[];

export interface MutationRootPolicy {
  rootContainer: "object" | "array";
}

export function normalizeMutationRoot(
  currentDocument: unknown,
  policy: MutationRootPolicy
): MutableContainer {
  if (policy.rootContainer === "array") {
    return Array.isArray(currentDocument) ? (currentDocument as unknown[]) : [];
  }

  // Object policy: arrays are NOT valid object roots despite being mutable containers.
  if (isObjectRecord(currentDocument)) {
    return currentDocument;
  }

  return {};
}

// Apply path operations first, then validate the entire document against the canonical
// schema so partial edits cannot persist an invalid config shape.
export function applyMutations<TSchema extends z.ZodTypeAny>(
  currentDocument: unknown,
  operations: readonly ConfigOperation[],
  schema: TSchema,
  policy: MutationRootPolicy
): MutationResult<z.infer<TSchema>> {
  const baseDocument = normalizeMutationRoot(currentDocument, policy);
  const clonedDocument = deepClone(baseDocument);

  for (const [index, operation] of operations.entries()) {
    const deniedSegment = operation.path.find((segment) => DENIED_PATH_SEGMENTS.has(segment));
    if (deniedSegment) {
      return {
        success: false,
        error: `Denied path segment "${deniedSegment}" in operation ${index}`,
      };
    }

    const opError =
      operation.op === "set"
        ? applySetOperation(clonedDocument, operation.path, operation.value)
        : applyDeleteOperation(clonedDocument, operation.path);

    if (opError) {
      return {
        success: false,
        error: `Mutation failed for operation ${index}: ${opError}`,
      };
    }
  }

  const parseResult = schema.safeParse(clonedDocument);
  if (!parseResult.success) {
    return {
      success: false,
      error: "Schema validation failed after applying operations",
      validationIssues: parseResult.error.issues,
    };
  }

  return {
    success: true,
    document: clonedDocument as z.infer<TSchema>,
    appliedOps: operations.length,
  };
}

function applySetOperation(
  root: MutableContainer,
  path: readonly string[],
  value: unknown
): string | null {
  let current: MutableContainer = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];

    if (Array.isArray(current)) {
      const boundedResult = parseBoundedArrayIndex(segment, path, index);
      if (!boundedResult.ok) {
        return boundedResult.error;
      }
      const arrayIndex = boundedResult.index;

      const existing = current[arrayIndex];
      if (existing === null || existing === undefined) {
        const nextContainer = createMissingContainer(current, nextSegment);
        current[arrayIndex] = nextContainer;
        current = nextContainer;
        continue;
      }

      if (!isMutableContainer(existing)) {
        return `Cannot traverse non-object value at ${formatPath(path, index)}`;
      }

      current = existing;
      continue;
    }

    const existing = hasOwnRecordKey(current, segment) ? current[segment] : undefined;
    if (existing === null || existing === undefined) {
      const nextContainer = createMissingContainer(current, nextSegment);
      current[segment] = nextContainer;
      current = nextContainer;
      continue;
    }

    if (!isMutableContainer(existing)) {
      return `Cannot traverse non-object value at ${formatPath(path, index)}`;
    }

    current = existing;
  }

  const leafSegment = path[path.length - 1];
  if (Array.isArray(current)) {
    const boundedResult = parseBoundedArrayIndex(leafSegment, path);
    if (!boundedResult.ok) {
      return boundedResult.error;
    }
    const leafIndex = boundedResult.index;

    current[leafIndex] = value;
    return null;
  }

  current[leafSegment] = value;
  return null;
}

function applyDeleteOperation(root: MutableContainer, path: readonly string[]): string | null {
  let current: MutableContainer = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];

    if (Array.isArray(current)) {
      const boundedResult = parseBoundedArrayIndex(segment, path, index);
      if (!boundedResult.ok) {
        return boundedResult.error;
      }
      const arrayIndex = boundedResult.index;

      if (arrayIndex >= current.length) {
        return null;
      }

      const next = current[arrayIndex];
      if (!isMutableContainer(next)) {
        return null;
      }

      current = next;
      continue;
    }

    if (!hasOwnRecordKey(current, segment)) {
      return null;
    }

    const next = current[segment];
    if (!isMutableContainer(next)) {
      return null;
    }

    current = next;
  }

  const leafSegment = path[path.length - 1];
  if (Array.isArray(current)) {
    const boundedResult = parseBoundedArrayIndex(leafSegment, path);
    if (!boundedResult.ok) {
      return boundedResult.error;
    }
    const leafIndex = boundedResult.index;

    if (leafIndex < current.length) {
      current.splice(leafIndex, 1);
    }

    return null;
  }

  delete current[leafSegment];
  return null;
}

// Create a missing intermediate container based on the parent's kind.
// Object parents always create object children (numeric-looking keys are valid record keys).
// Array parents infer child kind from the next segment shape.
function createMissingContainer(current: MutableContainer, nextSegment: string): MutableContainer {
  if (Array.isArray(current)) {
    return parseArrayIndex(nextSegment) === null ? {} : [];
  }

  return {};
}

function formatPath(path: readonly string[], untilInclusive?: number): string {
  const displayPath =
    untilInclusive === undefined ? path : path.slice(0, Math.max(untilInclusive + 1, 1));
  return displayPath.map((segment) => `[${segment}]`).join("");
}

function isMutableContainer(value: unknown): value is MutableContainer {
  return typeof value === "object" && value !== null;
}
