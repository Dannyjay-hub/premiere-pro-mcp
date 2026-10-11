/** Close declared object properties, retaining deliberately open metadata maps. */
export function strictDeclaredObjects(value: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown, composed = false): unknown => {
    if (Array.isArray(node)) return node.map(child => walk(child, composed));
    if (!node || typeof node !== "object") return node;
    const input = node as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(input).map(([key, child]) => [key, walk(child, ["allOf", "anyOf", "oneOf"].includes(key))]));
    // Composed schemas may share properties across branches: closing a branch
    // independently would reject those legitimate shared fields.
    if (!composed && input.properties !== undefined && input.additionalProperties === undefined && input.patternProperties === undefined && input.allOf === undefined && input.oneOf === undefined && input.anyOf === undefined) result.additionalProperties = false;
    return result;
  };
  return walk(value) as Record<string, unknown>;
}

export function argumentDiagnostics(value: unknown, schema: Record<string, unknown>): string[] {
  const issues: string[] = [];
  let visited = 0;
  const walk = (item: unknown, node: unknown, pointer: string, depth: number) => {
    if (++visited > 300_000 || depth > 64) { if (!issues.includes("ARGUMENT_LIMIT: input exceeds bounded validation size")) issues.push("ARGUMENT_LIMIT: input exceeds bounded validation size"); return; }
    if (typeof item === "number" && !Number.isFinite(item)) issues.push(`INVALID_NUMBER: ${pointer || "/"} must be finite`);
    if (!node || typeof node !== "object" || !item || typeof item !== "object") return;
    const def = node as Record<string, unknown>;
    if (Array.isArray(item)) { for (let index = 0; index < item.length && visited <= 300_000; index++) walk(item[index], def.items, `${pointer}/${index}`, depth + 1); return; }
    const properties = def.properties as Record<string, unknown> | undefined;
    const keys = Object.keys(item);
    if (properties && def.additionalProperties === false) {
      const unexpected = keys.filter(key => !Object.hasOwn(properties, key) && !(def.patternProperties && Object.keys(def.patternProperties as object).some(pattern => new RegExp(pattern).test(key))));
      if (unexpected.length) issues.push(`UNKNOWN_ARGUMENT: unknown argument${unexpected.length > 1 ? "s" : ""} ${unexpected.slice(0,16).map(key => key.slice(0,128)).join(", ")}${unexpected.length > 16 ? ", ..." : ""}; this tool accepts: ${Object.keys(properties).join(", ") || "no arguments"}; location ${pointer || "/"}`.slice(0,4096));
    }
    for (const key of keys) walk((item as Record<string, unknown>)[key], properties?.[key] ?? def.additionalProperties, `${pointer}/${key}`, depth + 1);
  };
  walk(value, schema, "", 0);
  return issues.slice(0, 32);
}
