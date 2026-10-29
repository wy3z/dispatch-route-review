import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const dependencies = {
  access: [],
  engineers: [],
  work: ["engineers"],
  routing: ["work", "engineers"],
  map: ["work", "engineers", "routing"],
  dispatch: ["work", "engineers", "routing", "map"],
};
const publicFile = /^modules\/[^/]+\/(contracts|domain|presentation|client|server|worker)\.ts$/;
const owner = (file) => file.match(/^modules\/([^/]+)\//)?.[1];
const worker = (file) => /^modules\/work\/worker(?:\/|\.ts$)/.test(file);
const server = (file) => /^(platform|workflows)\//.test(file) || /^modules\/[^/]+\/server(?:\/|\.ts$)/.test(file) || worker(file);

/** Check resolved imports, including re-exports and dynamic imports. Type-only edges never load a runtime. */
export function checkBoundaries(sources) {
  const errors = new Set();
  const graph = new Map();
  const clientRoots = [];
  const pureRoots = [];
  const resolveImport = (from, specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
    const base = specifier.startsWith("@/")
      ? specifier.slice(2)
      : posix.normalize(posix.join(posix.dirname(from), specifier));
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`]
      .find((candidate) => sources.has(candidate)) ?? base;
  };

  for (const [from, source] of sources) {
    if (!/\.(?:tsx?|mjs)$/.test(from)) continue;
    const file = ts.createSourceFile(from, source, ts.ScriptTarget.Latest, true);
    const edges = [];
    graph.set(from, edges);
    if (file.statements.some((node) => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client")) clientRoots.push(from);
    if (/^modules\/[^/]+\/(domain|presentation)\.ts$/.test(from) || /^shared\/[^/]+\.ts$/.test(from)) pureRoots.push(from);

    function edge(specifier, typeOnly) {
      const to = resolveImport(from, specifier);
      if (!to) {
        if (!typeOnly) edges.push(specifier);
        return;
      }
      if (!sources.has(to)) errors.add(`${from}: unresolved import ${specifier}`);
      const a = owner(from), b = owner(to);
      if (b && a !== b && !publicFile.test(to)) errors.add(`${from}: use a public entry point, not ${to}`);
      if (a && b && a !== b && !dependencies[a]?.includes(b)) errors.add(`${from}: ${a} must not depend on ${b}`);
      if (/^(shared|platform)\//.test(from) && /^(modules|workflows|app)\//.test(to)) errors.add(`${from}: foundational code must not import ${to}`);
      if (a && /^(app|workflows)\//.test(to)) errors.add(`${from}: module must not import its composition layer ${to}`);
      if (from.startsWith("app/api/") && to.startsWith("platform/")) errors.add(`${from}: persistence belongs behind a module operation`);
      if (!typeOnly) edges.push(to);
    }

    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly = Boolean(clause?.isTypeOnly || (!clause?.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every((item) => item.isTypeOnly)));
        edge(node.moduleSpecifier.text, typeOnly);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const named = node.exportClause;
        edge(node.moduleSpecifier.text, Boolean(node.isTypeOnly || (named && ts.isNamedExports(named) && named.elements.length && named.elements.every((item) => item.isTypeOnly))));
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        edge(node.argument.literal.text, true);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) edge(argument.text, false);
        else errors.add(`${from}: dynamic module paths cannot be boundary-checked`);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  function reachable(root, forbidden, label) {
    const seen = new Set();
    function visit(file, trail) {
      if (seen.has(file)) return;
      seen.add(file);
      if (file !== root && forbidden(file)) {
        errors.add(`${label}: ${[...trail, file].join(" -> ")}`);
        return;
      }
      for (const next of graph.get(file) ?? []) visit(next, [...trail, file]);
    }
    visit(root, []);
  }
  const serverDependency = (file) => server(file) || file === "pg" || file.startsWith("node:") || ["next/headers", "next/server"].includes(file);
  for (const root of clientRoots) reachable(root, serverDependency, "Client reaches server code");
  for (const root of pureRoots) reachable(root, (file) => serverDependency(file) || clientRoots.includes(file) || file === "react" || file.startsWith("react/"), "Pure model reaches runtime code");
  for (const root of graph.keys()) {
    if (root === "proxy.ts" || root.startsWith("app/") || (root.startsWith("scripts/") && root !== "scripts/cache-worker.ts")) reachable(root, worker, "Only the cache worker may load Autotask code");
  }

  const done = new Set(), active = new Set();
  function detectCycles(file, trail) {
    if (active.has(file)) {
      errors.add(`Runtime import cycle: ${[...trail.slice(trail.indexOf(file)), file].join(" -> ")}`);
      return;
    }
    if (done.has(file) || !graph.has(file)) return;
    active.add(file);
    for (const next of graph.get(file)) detectCycles(next, [...trail, file]);
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) detectCycles(file, []);
  return [...errors].sort();
}

function readSources(root, folder, sources) {
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    const file = posix.join(folder, entry.name);
    if (entry.isDirectory()) readSources(root, file, sources);
    else if (/\.(?:tsx?|mjs|css)$/.test(file) && file !== "scripts/check-boundaries.mjs") sources.set(file, readFileSync(join(root, file), "utf8"));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = new Map();
  for (const folder of ["app", "modules", "shared", "platform", "workflows", "scripts"]) readSources(root, folder, sources);
  sources.set("proxy.ts", readFileSync(join(root, "proxy.ts"), "utf8"));
  const errors = checkBoundaries(sources);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Module and runtime boundaries passed.");
}
