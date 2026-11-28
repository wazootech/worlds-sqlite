/**
 * sql-core purity gate: fails when any module under src/sql-core imports
 * outside the shared plan-layer allowlist. sql-core must stay driver-free so
 * every SQLite-family backend (node:sqlite, LibSQL/Turso, D1) can execute its
 * plans through its own connection driver.
 *
 * Allowed dependency surface: intra-package relatives, the shared Worlds SDK,
 * the SPARQL engine's data model, and RDF/JS types. Anything else — drivers
 * like node:sqlite or @libsql/client, extensions like sqlite-vec — is a
 * violation.
 */

import { readdir, readFile } from "node:fs/promises";
import process from "node:process";

const ALLOWED_SPECIFIER_PATTERNS = [
  /^\.\/|^@\//,
  /^@worlds\/sdk/,
  /^@wazoo\/sparql-engine/,
  /^@rdfjs\/types$/,
];

/** TestOnlySpecifierPatterns are allowed in `*.test.ts` files and nowhere else. */
const TEST_ONLY_SPECIFIER_PATTERNS = [/^@std\/assert$/, /^node:test$/];

/** ImportSpecifierPattern matches static, bare and dynamic module specifiers. */
const IMPORT_SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["']/g;

async function collectSqlCoreFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectSqlCoreFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

const sqlCoreFiles = await collectSqlCoreFiles("src/sql-core");
const violations: string[] = [];

for (const file of sqlCoreFiles) {
  const source = await readFile(file, "utf8");
  const patterns = file.endsWith(".test.ts")
    ? [...ALLOWED_SPECIFIER_PATTERNS, ...TEST_ONLY_SPECIFIER_PATTERNS]
    : ALLOWED_SPECIFIER_PATTERNS;
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1]!;
    const allowed = patterns.some((pattern) => pattern.test(specifier));
    if (!allowed) {
      violations.push(`${file}: disallowed import "${specifier}"`);
    }
  }
}

if (violations.length > 0) {
  console.error("sql-core purity violations:");
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error(
    "\nsql-core must stay driver-free: emit inert {sql, args} plans only.",
  );
  process.exit(1);
}

console.log(
  `sql-core purity OK (${sqlCoreFiles.length} files, allowlisted imports only)`,
);
