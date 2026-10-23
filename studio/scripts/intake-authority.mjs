import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";

const studioRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = "src/lib/sav/intake";
const manifestPath = `${directory}/authority-manifest.json`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const message = "SAV_INTAKE_AUTHORITY_CHANGED: relever SAV_INTAKE_AUTHORITY_REVISION et mettre à jour les empreintes";
const normalized = value => value.split(path.sep).join("/");
const stable = value => JSON.stringify(value);

export function collectIntakeAuthoritySources(root = studioRoot) {
  root = realpathSync(root);
  const config = ts.parseConfigFileTextToJson("tsconfig.json", readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  const compiler = config.config?.compilerOptions ?? {};
  if (config.error || config.config?.extends || compiler.baseUrl !== undefined || compiler.rootDirs || compiler.moduleSuffixes || compiler.customConditions
    || compiler.paths && stable(compiler.paths) !== stable({ "@/*": ["./src/*"] })) throw Error("AUTHORITY_RESOLUTION_CONFIG_REJECTED");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const packages = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const sources = {}, external = new Set(), queue = [];
  const enqueue = filename => {
    const full = path.resolve(root, filename), relative = normalized(path.relative(root, full));
    if (relative === manifestPath) return; // Generated data is not its own source.
    if (relative.startsWith("../") || path.isAbsolute(relative) || realpathSync(full) !== full) throw Error(`AUTHORITY_SOURCE_OUTSIDE_ROOT:${filename}`);
    if (!Object.hasOwn(sources, relative)) { sources[relative] = hash(readFileSync(full)); queue.push(relative); }
  };
  const inventory = folder => {
    for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
      const filename = `${folder}/${entry.name}`;
      if (entry.isDirectory()) inventory(filename);
      else if (/\.[cm]?[jt]sx?$/.test(filename) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename)) enqueue(filename);
    }
  };
  inventory(directory);
  for (const filename of ["scripts/intake-authority.mjs", "next.config.ts", "tsconfig.json", "package.json", "package-lock.json"]) enqueue(filename);
  // SQL can change uniqueness/receipt guarantees without changing a TS import.
  if (existsSync(path.join(root, "drizzle"))) {
    for (const name of readdirSync(path.join(root, "drizzle"))) if (name.endsWith(".sql")) enqueue(`drizzle/${name}`);
    if (existsSync(path.join(root, "drizzle/meta/_journal.json"))) enqueue("drizzle/meta/_journal.json");
  }
  if (existsSync(path.join(root, "vendor"))) {
    for (const name of readdirSync(path.join(root, "vendor"))) enqueue(`vendor/${name}`);
  }
  const resolve = (from, specifier) => {
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!isBuiltin(specifier) && !packages.has(name)) throw Error(`AUTHORITY_EXTERNAL_IMPORT_REJECTED:${from}:${specifier}`);
      external.add(specifier); return;
    }
    const base = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(root, path.dirname(from), specifier);
    if (normalized(path.relative(root, base)) === manifestPath) return;
    const candidates = [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs", ".json", "/index.ts", "/index.tsx", "/index.js"].map(ext => base + ext)];
    if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.[cm]?js$/, ".ts"));
    if (existsSync(path.join(base, "package.json"))) throw Error(`AUTHORITY_LOCAL_PACKAGE_REJECTED:${from}:${specifier}`);
    const targets = candidates.filter(filename => existsSync(filename) && !statSync(filename).isDirectory());
    if (!targets.length) throw Error(`AUTHORITY_IMPORT_UNRESOLVED:${from}:${specifier}`);
    // Cover alternatives as well: no untracked .js/.ts or index substitution.
    for (const target of targets) enqueue(target);
  };
  for (let index = 0; index < queue.length; index++) {
    const filename = queue[index];
    if (!/\.[cm]?[jt]sx?$/.test(filename)) continue;
    const ast = ts.createSourceFile(filename, readFileSync(path.join(root, filename), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) resolve(filename, node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) resolve(filename, node.argument.literal.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) throw Error(`AUTHORITY_DYNAMIC_IMPORT_REJECTED:${filename}`);
        resolve(filename, node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), externalModules: [...external].sort() };
}
export function verifyIntakeAuthoritySources(root = studioRoot) {
  const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
  const actual = collectIntakeAuthoritySources(root);
  if (!/^sav-intake-authority-[a-z0-9.-]+$/.test(manifest.authorityRevision ?? "")
    || stable(actual.sources) !== stable(manifest.sources) || stable(actual.externalModules) !== stable(manifest.externalModules)) throw Error(message);
  return actual;
}

export function writeIntakeAuthorityManifest(revision, root = studioRoot) {
    const file = path.join(root, manifestPath);
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    if (!/^sav-intake-authority-[a-z0-9.-]+$/.test(revision ?? "") || previous?.authorityRevision === revision) throw Error(message);
    writeFileSync(file, JSON.stringify({ authorityRevision: revision, ...collectIntakeAuthoritySources(root) }, null, 2) + "\n", { flag: "w" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "--write" && process.argv.length === 4) writeIntakeAuthorityManifest(process.argv[3]);
  else if (process.argv.length === 2) verifyIntakeAuthoritySources();
  else throw Error("AUTHORITY_CHECK_ARGUMENTS_REJECTED");
}
