type JsonSchemaObject = { properties?: Record<string, unknown> };
type ToolResult = { success: boolean; data?: unknown; error?: string };

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
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    const source = record[camelKey(key)] !== undefined ? record[camelKey(key)] : record[key];
    if (source === undefined) return null;
    const nested = propertySchema as JsonSchemaObject;
    if (nested && typeof nested === "object" && nested.properties) {
      const child = applySnapshotFrom(source, nested);
      if (!child) return null;
      snapshot[key] = child;
    } else {
      snapshot[key] = source;
    }
  }
  return snapshot;
}

/** Attach expected_snapshot to a successful inspect result so apply can take it verbatim. */
export async function withApplySnapshot(result: Promise<ToolResult>, schema: JsonSchemaObject): Promise<ToolResult> {
  const settled = await result;
  if (!settled.success || !settled.data || typeof settled.data !== "object") return settled;
  const data = settled.data as Record<string, unknown>;
  const expected = applySnapshotFrom(data.result, schema);
  return expected ? { ...settled, data: { ...data, expected_snapshot: expected } } : settled;
}
