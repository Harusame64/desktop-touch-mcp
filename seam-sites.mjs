// Enumerate the advice-producing call sites and say which presenter each one reaches.
// AST, not grep: the point of the exercise is that a spelling sweep finds the spellings
// it already knows (see the guard cell's own history).
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? ".";
const SEAM = new Set(["failCode", "failWith", "failArgs", "toToolFailure", "buildFailureEnvelope", "toFailureEnvelope"]);
const KEYS = new Set(["suggest", "try_next", "tryNext"]);

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})(join(ROOT, "src"));

const rows = [];
for (const f of files.sort()) {
  const src = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const line = (n) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const calleeName = (e) =>
    ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : "(expr)";
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      // Any advice key ANYWHERE inside an argument, not only at its top level.
      // win2's cross-check found the hole: `...(suggest ? { suggest } : {})` nests the
      // object literal inside a spread inside another object literal, and a scan of
      // `arg.properties` never reaches it. Depth is the point of using an AST at all.
      for (const arg of node.arguments) {
        const seek = (n) => {
          if (ts.isObjectLiteralExpression(n)) {
            for (const prop of n.properties) {
              const key =
                prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
                  ? prop.name.text
                  : null;
              if (key !== null && KEYS.has(key)) {
                rows.push([`${relative(ROOT, f)}:${line(prop)}`, name, SEAM.has(name) ? "seam" : "OTHER"]);
              }
            }
          }
          ts.forEachChild(n, seek);
        };
        seek(arg);
      }
      // buildFailureEnvelope(cause, tryNext, …) — advice is positional there
      if (name === "buildFailureEnvelope" && node.arguments.length >= 2) {
        rows.push([`${relative(ROOT, f)}:${line(node)}`, name, "seam"]);
      }
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (key !== null && KEYS.has(key)) {
        // an advice key in an object that is NOT a call argument: a returned literal
        let p = node.parent;
        while (p && !ts.isCallExpression(p) && !ts.isSourceFile(p)) p = p.parent;
        if (!p || ts.isSourceFile(p)) rows.push([`${relative(ROOT, f)}:${line(node)}`, "(object literal)", "OTHER"]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}
const seen = new Set();
const uniq = rows.filter(([loc]) => (seen.has(loc) ? false : (seen.add(loc), true)));
console.error(`sites: ${uniq.length}  seam: ${uniq.filter((r) => r[2] === "seam").length}  other: ${uniq.filter((r) => r[2] === "OTHER").length}`);
for (const [loc, name, kind] of uniq) console.log(`${loc}\t${name}\t${kind}`);
