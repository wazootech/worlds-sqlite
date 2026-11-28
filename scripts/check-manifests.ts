/**
 * check-manifests keeps package.json (what Bun installs and tests against) in
 * lockstep with jsr.json (what `jsr publish` ships): the same export map and
 * the same dependency ranges, with each `jsr:` dependency spelled as its
 * `npm:@jsr/<scope>__<name>` alias in package.json. Every jsr.json import must
 * be a package.json dependency or devDependency; every package.json
 * dependency (not devDependency) must be a jsr.json import.
 *
 * Usage: `bun scripts/check-manifests.ts [repoDir]` (defaults to the current
 * directory). This is the canonical copy for the wazootech repos: copy it into a
 * repo's `scripts/` unchanged. Handles devDependencies, an npm alias whose key
 * differs from the package name, and subpath imports that ride on a base import.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const dir = resolve(process.argv[2] ?? ".");
const read = (name: string) =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    exports?: unknown;
    imports?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
const jsr = read("jsr.json");
const pkg = read("package.json");

const problems: string[] = [];
const fail = (message: string) => problems.push(message);

/** expectedPackageSpec maps a jsr.json import specifier to package.json's. */
function expectedPackageSpec(alias: string, spec: string): string {
  if (spec.startsWith("npm:")) {
    const body = spec.slice("npm:".length);
    const split = body.lastIndexOf("@");
    // An alias key that differs from the package name keeps its npm: prefix.
    return body.slice(0, split) === alias ? body.slice(split + 1) : spec;
  }
  const [, scope, name, range] =
    /^jsr:@([^/]+)\/([^@]+)@(.+)$/.exec(spec) ?? [];
  return `npm:@jsr/${scope}__${name}@${range}`;
}

if (JSON.stringify(jsr.exports) !== JSON.stringify(pkg.exports)) {
  fail("exports differ between jsr.json and package.json");
}

const deps = pkg.dependencies ?? {};
const devDeps = pkg.devDependencies ?? {};
const imports = jsr.imports ?? {};
for (const [alias, spec] of Object.entries(imports)) {
  if (alias === "@/") continue;
  // A subpath entry (`@pkg/sub` -> `jsr:@pkg@range/sub`) rides on its base
  // alias: package.json cannot spell it, the npm alias exposes the subpath.
  const sub = /^jsr:(@[^/]+\/[^@]+@[^/]+)\/.+$/.exec(spec);
  if (sub) {
    const base = Object.entries(imports).find(([, s]) => s === `jsr:${sub[1]}`);
    if (!base || !alias.startsWith(`${base[0]}/`)) {
      fail(`"${alias}": subpath import has no matching base import`);
    }
    continue;
  }
  const declared = deps[alias] ?? devDeps[alias];
  if (declared === undefined) {
    fail(`jsr.json imports "${alias}" but package.json does not depend on it`);
  } else if (declared !== expectedPackageSpec(alias, spec)) {
    fail(`"${alias}": jsr.json ${spec} vs package.json ${declared}`);
  }
}
for (const alias of Object.keys(deps)) {
  if (!(alias in imports)) {
    fail(`package.json depends on "${alias}" but jsr.json does not import it`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log("package.json and jsr.json agree on exports and dependencies.");
