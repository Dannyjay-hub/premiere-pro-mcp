// Fixture for tests/extendscript-chained-ternary.test.ts. Not imported by src.
export const chained = `
  var t = item.type;
  return __result({ kind: t === 1 ? "clip" : t === 2 ? "bin" : "unknown" });
`;
export const parenthesized = `
  var t = item.type;
  return __result({ kind: t === 1 ? "clip" : (t === 2 ? "bin" : "unknown") });
`;
