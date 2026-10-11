import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Existing parser reuse predates the layer rule. Neither exception authorizes
// additional edges; moving these pure parsers is a separate focused refactor.
const exceptions = new Map([
  ["src/ai/editorial-review.ts->src/tools/dialogue-analysis.ts", "Pure dialogue normalization/parser reuse"],
  ["src/ai/edl-export.ts->src/tools/interchange-analysis.ts", "Pure CMX parser reuse"],
]);
function files(directory) { return readdirSync(directory,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? files(resolve(directory,entry.name)) : entry.name.endsWith(".ts") ? [resolve(directory,entry.name)] : []); }
export function violationsFor(source, imports) {
  return imports.flatMap(target => {
    const edge = `${source}->${target}`;
    if (exceptions.has(edge)) return [];
    const pure = source.startsWith("src/ai/");
    const security = source.startsWith("src/security/");
    if (pure && (/^src\/(bridge|tools|server|http-server)/.test(target) || ["node:fs","node:fs/promises","node:child_process","node:net","node:http","node:https"].includes(target))) return [edge];
    if (security && /^src\/(tools|server|http-server)/.test(target)) return [edge];
    return [];
  });
}
export function checkDependencyBoundaries() {
  const violations = [];
  for (const file of files(resolve(root,"src"))) {
    const source = relative(root,file).split(sep).join("/");
    const text = readFileSync(file,"utf8");
    const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(match => match[1]).map(target => target.startsWith(".") ? relative(root,resolve(dirname(file),target.replace(/\.js$/,".ts"))).split(sep).join("/") : target);
    violations.push(...violationsFor(source,imports));
  }
  if (violations.length) throw new Error(`Dependency boundary violations:\n${violations.join("\n")}`);
  return { checked:true, exceptionCount:exceptions.size };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = checkDependencyBoundaries(); process.stdout.write(`Dependency boundaries passed (${result.exceptionCount} explicit legacy parser edges).\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode=1; }
}
