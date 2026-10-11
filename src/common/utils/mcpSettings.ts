/**
 * OpenAI MCP structured settings (`openai/settings`), shared by the backend
 * (validates what servers return) and the renderer (validates before send).
 *
 * Spec: https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#structured-settings
 * Server data is untrusted: every malformed property or layout item is dropped
 * with a warning, never fatal, so one bad field does not hide the others.
 */

export const MCP_SETTINGS_CAPABILITY = "openai/settings";
/** Request `_meta` key telling the server which Xum workspace the settings belong to. */
export const MCP_SETTINGS_WORKSPACE_META_KEY = "xum/workspaceId";

export interface MCPSettingsCapability {
  readTool: string;
  updateTool: string;
}

export type MCPSettingValue = string | number | boolean;

export type MCPSettingSchema = { title: string; description?: string } & (
  | { type: "boolean" }
  // No `pattern`: Xum never runs a server's regex (see parseSchema).
  | { type: "string"; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; multipleOf?: number }
);

export type MCPSettingsLayoutItem =
  | { kind: "property"; property: string }
  | { kind: "tool"; tool: string; description?: string };

export interface MCPSettingsGroup {
  title: string;
  items: MCPSettingsLayoutItem[];
}

export interface MCPSettingsSnapshot {
  properties: Record<string, MCPSettingSchema>;
  values: Record<string, MCPSettingValue>;
  /** Layout groups in order; properties no group lists go last, in "Other settings". */
  layout: MCPSettingsGroup[];
  warnings: string[];
  /** Schema properties dropped (unsupported schema or no valid value); the UI notes them. */
  droppedSettingCount: number;
}

const MAX_TEXT = 1024;
const MAX_VALUE_LENGTH = 4096;
// Collection bounds: the renderer mounts one control per setting, so a server must not be
// able to send an unbounded schema or layout. Excess entries are dropped with one warning.
export const MAX_MCP_SETTINGS = 100;
const MAX_LAYOUT_GROUPS = 20;
const MAX_GROUP_ITEMS = 100;
/** Options one Select can show; a setting with more is dropped (counted as not shown). */
export const MAX_MCP_SETTING_ENUM_OPTIONS = 100;
/** Longest setting name, in code points: names are React keys and cross IPC. Longer = dropped. */
export const MAX_MCP_SETTING_NAME = 128;
/** Settings tool timeout in the dialog's bulk read: one hung server must not hold back the rest. */
export const MCP_SETTINGS_READ_TIMEOUT_MS = 10_000;

/**
 * A settings error as sent to the renderer: at most MAX_TEXT UTF-16 units (about 1 KB), cut
 * on a code point. Server error text is untrusted and otherwise unbounded.
 */
export function boundMCPSettingsError(message: string): string {
  if (message.length <= MAX_TEXT) return message;
  const cut = message.slice(0, MAX_TEXT);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const isNonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;
/** An enum option: any bounded string, "" included (the spec allows it, e.g. for "none"). */
const isEnumOption = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TEXT;
/** JSON Schema string length counts Unicode code points, not UTF-16 units. */
const codePointLength = (value: string): number => [...value].length;
/** Longer than `max` code points; counts them only when the UTF-16 length cannot decide. */
const exceedsCodePoints = (value: string, max: number): boolean =>
  value.length > max && (value.length > 2 * max || codePointLength(value) > max);
const isLength = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Every non-blank tool name the capability advertises, also when the other member is
 * malformed (so the host still hides it from the model). The settings UI needs both.
 */
export function advertisedMCPSettingsToolNames(capabilities: unknown): string[] {
  if (!isRecord(capabilities)) return [];
  const names: string[] = [];
  for (const location of [capabilities.extensions, capabilities.experimental]) {
    const raw = isRecord(location) ? location[MCP_SETTINGS_CAPABILITY] : undefined;
    if (!isRecord(raw)) continue;
    for (const name of [raw.readTool, raw.updateTool]) if (isNonBlank(name)) names.push(name);
  }
  return names;
}

/** `capabilities.extensions` (2026-07-28+) or legacy `capabilities.experimental`. */
export function parseMCPSettingsCapability(
  capabilities: unknown
): MCPSettingsCapability | undefined {
  if (!isRecord(capabilities)) return undefined;
  for (const location of [capabilities.extensions, capabilities.experimental]) {
    const raw = isRecord(location) ? location[MCP_SETTINGS_CAPABILITY] : undefined;
    if (isRecord(raw) && isNonBlank(raw.readTool) && isNonBlank(raw.updateTool)) {
      return { readTool: raw.readTool, updateTool: raw.updateTool };
    }
  }
  return undefined;
}

function parseSchema(raw: unknown): MCPSettingSchema | undefined {
  if (!isRecord(raw) || !isNonBlank(raw.title)) return undefined;
  const base = {
    title: raw.title,
    ...(typeof raw.description === "string" && raw.description.length <= MAX_TEXT
      ? { description: raw.description }
      : {}),
  };
  if (raw.type === "boolean") return { ...base, type: "boolean" };
  if (raw.type === "string") {
    const enumValues = raw.enum;
    if (
      enumValues !== undefined &&
      !(
        Array.isArray(enumValues) &&
        enumValues.length <= MAX_MCP_SETTING_ENUM_OPTIONS &&
        enumValues.every(isEnumOption)
      )
    )
      return undefined;
    if ([raw.minLength, raw.maxLength].some((n) => n !== undefined && !isLength(n)))
      return undefined;
    // `pattern` is ignored on purpose. A server-chosen regex can backtrack for seconds on a
    // short value, and RegExp.test blocks the thread it runs on (main process or renderer), so
    // no timeout can stop it. The server validates its own values: a value that breaks its
    // pattern comes back as the update tool's error, which the settings UI shows.
    return {
      ...base,
      type: "string",
      ...(enumValues !== undefined ? { enum: enumValues } : {}),
      ...(isLength(raw.minLength) ? { minLength: raw.minLength } : {}),
      ...(isLength(raw.maxLength) ? { maxLength: raw.maxLength } : {}),
    };
  }
  if (raw.type === "number" || raw.type === "integer") {
    if ([raw.minimum, raw.maximum].some((n) => n !== undefined && !isFiniteNumber(n)))
      return undefined;
    if (raw.multipleOf !== undefined && !(isFiniteNumber(raw.multipleOf) && raw.multipleOf > 0))
      return undefined;
    return {
      ...base,
      type: raw.type,
      ...(isFiniteNumber(raw.minimum) ? { minimum: raw.minimum } : {}),
      ...(isFiniteNumber(raw.maximum) ? { maximum: raw.maximum } : {}),
      ...(isFiniteNumber(raw.multipleOf) ? { multipleOf: raw.multipleOf } : {}),
    };
  }
  return undefined;
}

/** Why `value` breaks `schema`, or null when it is valid. */
export function validateMCPSettingValue(schema: MCPSettingSchema, value: unknown): string | null {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "string": {
      if (typeof value !== "string" || exceedsCodePoints(value, MAX_VALUE_LENGTH))
        return `must be text of at most ${MAX_VALUE_LENGTH} characters`;
      if (schema.enum !== undefined && !schema.enum.includes(value))
        return `must be one of: ${schema.enum.join(", ")}`;
      if (schema.minLength !== undefined && codePointLength(value) < schema.minLength)
        return `must be at least ${schema.minLength} characters`;
      if (schema.maxLength !== undefined && codePointLength(value) > schema.maxLength)
        return `must be at most ${schema.maxLength} characters`;
      return null;
    }
    case "number":
    case "integer": {
      if (!isFiniteNumber(value)) return "must be a number";
      if (schema.type === "integer" && !Number.isInteger(value)) return "must be a whole number";
      if (schema.minimum !== undefined && value < schema.minimum)
        return `must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum)
        return `must be at most ${schema.maximum}`;
      // Tolerate float error: 0.3 is a multiple of 0.1.
      if (schema.multipleOf !== undefined) {
        // The quotient's float error grows with its magnitude (about 2e-6 at 1e10), so the
        // tolerance does too: 1e-9 absolute below 1e3, ~1e-12 relative above.
        const ratio = value / schema.multipleOf;
        if (Math.abs(ratio - Math.round(ratio)) > Math.max(1e-9, Math.abs(ratio) * 1e-12))
          return `must be a multiple of ${schema.multipleOf}`;
      }
      return null;
    }
  }
}

/** Keep only values that fit their property's schema (used for read and update results). */
export function filterMCPSettingValues(
  properties: Record<string, MCPSettingSchema>,
  raw: unknown,
  warnings: string[]
): Record<string, MCPSettingValue> {
  const values = Object.create(null) as Record<string, MCPSettingValue>;
  if (!isRecord(raw)) {
    warnings.push("'values' must be an object");
    return values;
  }
  for (const [name, schema] of Object.entries(properties)) {
    const value = raw[name];
    const error = validateMCPSettingValue(schema, value);
    if (error === null) values[name] = value as MCPSettingValue;
    else warnings.push(`Setting '${name}' has an invalid value (${error}); ignoring it`);
  }
  return values;
}

/** Validate a readTool `structuredContent` against the spec's SettingsReadResult. */
export function parseMCPSettingsReadResult(raw: unknown): MCPSettingsSnapshot | { error: string } {
  if (!isRecord(raw) || !isRecord(raw.schema) || raw.schema.type !== "object")
    return { error: "the settings read result has no object 'schema'" };
  if (!isRecord(raw.schema.properties))
    return { error: "the settings schema has no 'properties' object" };
  const warnings: string[] = [];
  // Null prototypes: a setting named "__proto__" must stay an own key, not hit the legacy setter.
  const properties = Object.create(null) as Record<string, MCPSettingSchema>;
  // A counting loop, not Object.entries: a server can declare any number of properties, and
  // only the first MAX_MCP_SETTINGS are parsed. The rest are only counted (as dropped).
  const declaredProperties = raw.schema.properties;
  let declared = 0;
  for (const name in declaredProperties) {
    if (!Object.hasOwn(declaredProperties, name) || ++declared > MAX_MCP_SETTINGS) continue;
    if (exceedsCodePoints(name, MAX_MCP_SETTING_NAME)) {
      warnings.push(
        `A setting name is longer than ${MAX_MCP_SETTING_NAME} characters; ignoring it`
      );
      continue;
    }
    const parsed = parseSchema(declaredProperties[name]);
    if (parsed !== undefined) properties[name] = parsed;
    else warnings.push(`Setting '${name}' has an unsupported schema; ignoring it`);
  }
  if (declared > MAX_MCP_SETTINGS)
    warnings.push(`Only the first ${MAX_MCP_SETTINGS} settings are shown; ignoring the rest`);
  const values = filterMCPSettingValues(properties, raw.values, warnings);
  // A property without a valid current value cannot be edited safely.
  for (const name of Object.keys(properties)) {
    if (!Object.hasOwn(values, name)) delete properties[name];
  }

  const layout: MCPSettingsGroup[] = [];
  const placed = new Set<string>();
  const groups: unknown[] = Array.isArray(raw.layout) ? raw.layout : [];
  if (groups.length > MAX_LAYOUT_GROUPS)
    warnings.push(`Only the first ${MAX_LAYOUT_GROUPS} layout groups are used; ignoring the rest`);
  for (const group of groups.slice(0, MAX_LAYOUT_GROUPS)) {
    if (!isRecord(group) || group.kind !== "group" || !isNonBlank(group.title)) {
      warnings.push("A settings layout group is malformed; ignoring it");
      continue;
    }
    const items: MCPSettingsLayoutItem[] = [];
    const rawItems: unknown[] = Array.isArray(group.items) ? group.items : [];
    if (rawItems.length > MAX_GROUP_ITEMS)
      warnings.push(`'${group.title}' lists more than ${MAX_GROUP_ITEMS} items; ignoring the rest`);
    for (const item of rawItems.slice(0, MAX_GROUP_ITEMS)) {
      if (isRecord(item) && item.kind === "property" && typeof item.property === "string") {
        // Own properties only: "toString" or "constructor" must not resolve through the prototype.
        if (Object.hasOwn(properties, item.property) && !placed.has(item.property)) {
          placed.add(item.property);
          items.push({ kind: "property", property: item.property });
        }
      } else if (isRecord(item) && item.kind === "tool" && isNonBlank(item.tool)) {
        items.push({
          kind: "tool",
          tool: item.tool,
          ...(typeof item.description === "string" && item.description.length <= MAX_TEXT
            ? { description: item.description }
            : {}),
        });
      } else warnings.push(`A layout item in '${group.title}' is malformed; ignoring it`);
    }
    if (items.length > 0) layout.push({ title: group.title, items });
  }
  const rest = Object.keys(properties).filter((name) => !placed.has(name));
  if (rest.length > 0)
    layout.push({
      title: "Other settings",
      items: rest.map((property) => ({ kind: "property", property })),
    });
  const droppedSettingCount = declared - Object.keys(properties).length;
  return { properties, values, layout, warnings, droppedSettingCount };
}
