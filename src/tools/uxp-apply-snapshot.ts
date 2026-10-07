type JsonSchemaObject = { type?: string | string[]; properties?: Record<string, unknown>; items?: JsonSchemaObject; sourceKey?: string; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; minItems?: number; maxItems?: number; uniqueItems?: boolean };
type ToolResult = { success: boolean; data?: unknown; error?: string };
type ApplyGuard = { schema: JsonSchemaObject; sourceKey?: string; sourceValue?: (record: Record<string, unknown>) => unknown };

function camelKey(snakeKey: string): string {
  return snakeKey.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * Build the snake_case expected_snapshot an apply schema accepts from the camelCase
 * snapshot the UXP panel returns on inspect. Keys come from the apply schema itself,
 * so the inspect output and the apply contract cannot drift apart. Returns null when a
 * required value is missing, so a caller never receives a snapshot apply would reject.
 */
export function applySnapshotFrom(value: unknown, schema: JsonSchemaObject): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    if (!schema.items) return null;
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) return null;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return null;
    if (schema.items.type && !schema.items.properties) {
      return value.every((item) => matchesSchemaValue(item, schema.items!))
        ? value as unknown as Record<string, unknown> : null;
    }
    const mapped = value.map((item) => applySnapshotFrom(item, schema.items!));
    return mapped.some((item) => item === null) ? null : (mapped as unknown as Record<string, unknown>);
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    const sourceKey = (propertySchema as JsonSchemaObject | undefined)?.sourceKey;
    const aliased = sourceKey ? readPath(record, sourceKey) : undefined;
    const source = sourceKey && aliased !== undefined ? aliased
      : record[camelKey(key)] !== undefined ? record[camelKey(key)] : record[key];
    if (source === undefined) return null;
    const nested = propertySchema as JsonSchemaObject;
    if (nested && typeof nested === "object" && nested.properties) {
      const child = applySnapshotFrom(source, nested);
      if (!child) return null;
      snapshot[key] = child;
    } else {
      if (!matchesSchemaValue(source, nested)) return null;
      snapshot[key] = source;
    }
  }
  return snapshot;
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}

/** Attach expected_snapshot to a successful inspect result so apply can take it verbatim. */
export async function withApplySnapshot(
  result: Promise<ToolResult>,
  schema: JsonSchemaObject,
  targetKey = "expected_snapshot",
  sourceKey?: string,
): Promise<ToolResult> {
  return withApplyGuards(result, { [targetKey]: { schema, sourceKey: sourceKey ?? "" } });
}

/** Attach every apply guard described by its schema, using the panel's inspect fields as sources. */
export async function withApplyGuards(
  result: Promise<ToolResult>,
  guards: Record<string, ApplyGuard>,
): Promise<ToolResult> {
  const settled = await result;
  if (!settled.success || !settled.data || typeof settled.data !== "object") return settled;
  const data = settled.data as Record<string, unknown>;
  const panelResult = data.result;
  if (!panelResult || typeof panelResult !== "object" || Array.isArray(panelResult)) return settled;
  const record = panelResult as Record<string, unknown>;
  const expected: Record<string, unknown> = {};
  for (const [targetKey, guard] of Object.entries(guards)) {
    const source = guard.sourceValue ? guard.sourceValue(record) : guard.sourceKey ? readPath(record, guard.sourceKey) : record;
    const value = applyValueFrom(source, guard.schema);
    if (value === undefined) continue;
    expected[targetKey] = value;
  }
  return { ...settled, data: { ...data, ...expected } };
}

function applyValueFrom(value: unknown, schema: JsonSchemaObject): unknown | undefined {
  if (schema.properties) return applySnapshotFrom(value, schema) ?? undefined;
  if (schema.items && Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) return undefined;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return undefined;
    const mapped = value.map((item) => applyValueFrom(item, schema.items!));
    return mapped.some((item) => item === undefined) ? undefined : mapped;
  }
  return matchesSchemaValue(value, schema) ? value : undefined;
}

function matchesSchemaValue(value: unknown, schema: JsonSchemaObject): boolean {
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (!types.length) return true;
  const matchesType = types.some((type) => type === "string" ? typeof value === "string"
    : type === "null" ? value === null
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
        : type === "boolean" ? typeof value === "boolean"
          : type === "array" ? Array.isArray(value)
            : type === "object" ? !!value && typeof value === "object" && !Array.isArray(value) : false);
  if (!matchesType) return false;
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) return false;
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (Array.isArray(value) && ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems))) return false;
  if (Array.isArray(value) && schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
  return true;
}
