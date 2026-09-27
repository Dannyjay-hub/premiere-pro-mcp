import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getHelpersSource } from "../src/bridge/script-builder.js";

/**
 * ExtendScript parses chained conditionals left to right:
 *   t === 1 ? "clip" : t === 2 ? "bin" : "unknown"
 * returns "bin" in Premiere when t is 1 (verified live on Premiere Pro 25.2),
 * while Node returns "clip". Unit tests run generated scripts in Node, so they
 * cannot catch it. Any nested conditional in a generated ExtendScript template
 * must therefore be parenthesized (or written as if/else).
 */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function looksLikeExtendScript(text: string): boolean {
  // A chained conditional needs at least two "?"; skip parsing everything else.
  if ((text.match(/\?/g) ?? []).length < 2) return false;
  return /\bvar\b|__result\(|__error\(|\bapp\.(project|enableQE)|\bqe\./.test(text);
}

function templateText(node: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((span) => "__SUB__" + span.literal.text).join("");
}

export function findChainedTernaries(files: string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && looksLikeExtendScript(templateText(node))) {
        const es = ts.createSourceFile("generated.js", `function __wrap() {\n${templateText(node)}\n}`, ts.ScriptTarget.ES3, true);
        const templateLine = sf.getLineAndCharacterOfPosition(node.getStart()).line;
        const inner = (n: ts.Node): void => {
          if (ts.isConditionalExpression(n) && (ts.isConditionalExpression(n.whenTrue) || ts.isConditionalExpression(n.whenFalse))) {
            const line = templateLine + es.getLineAndCharacterOfPosition(n.getStart(es)).line;
            hits.push(`${file}:${line}: ${n.getText(es).replace(/\s+/g, " ").slice(0, 120)}`);
          }
          ts.forEachChild(n, inner);
        };
        inner(es);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("generated ExtendScript", () => {
  it("contains no unparenthesized chained ternaries", () => {
    expect(findChainedTernaries(sourceFiles("src"))).toEqual([]);
  }, 60_000);

  it("detects a chained ternary and accepts a parenthesized one", () => {
    const dir = join(process.cwd(), "tests", "fixtures");
    const hits = findChainedTernaries([join(dir, "chained-ternary-sample.ts")]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('t === 1 ? "clip" : t === 2 ? "bin" : "unknown"');
  });
});

describe("__projectItemKind / __projectItemTypeName", () => {
  const run = (expression: string, item: unknown) => runInNewContext(`${getHelpersSource()}\n${expression}`, { item });

  it("names every ProjectItemType and reports sequences separately", () => {
    expect(run("__projectItemTypeName(item)", { type: 1 })).toBe("clip");
    expect(run("__projectItemTypeName(item)", { type: 2 })).toBe("bin");
    expect(run("__projectItemTypeName(item)", { type: 3 })).toBe("root");
    expect(run("__projectItemTypeName(item)", { type: 4 })).toBe("file");
    expect(run("__projectItemTypeName(item)", { type: 9 })).toBe("unknown");
    expect(run("__projectItemKind(item)", { type: 1, isSequence: () => true })).toBe("sequence");
    expect(run("__projectItemKind(item)", { type: 1, isSequence: () => false })).toBe("clip");
    expect(run("__projectItemKind(item)", { type: 2, isSequence: () => true })).toBe("bin");
  });

  it("tolerates items whose accessors throw", () => {
    const throwing = { get type(): number { throw new Error("gone"); } };
    expect(run("__projectItemKind(item)", throwing)).toBe("unknown");
    expect(run("__projectItemKind(item)", { type: 1, isSequence: () => { throw new Error("x"); } })).toBe("clip");
  });
});
