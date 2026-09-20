// Catch a name used from one of our own modules but never imported.
//
// Metro does not do this. A missing import is not a bundle error -- it is
// a ReferenceError thrown at render time, on whichever screen happens to
// touch that line, which means it ships. This exact bug shipped once:
// a regex that rewrote `import { colors, ... } from "../theme"` across
// several files dropped `formatTimestamp` from PcrDetailScreen, and the
// saved-PCR detail view threw the moment anyone opened a filed report.
// Both bundles built clean and an unused-import audit passed, because the
// damage was in the other direction.
//
// Scope is deliberately narrow -- only names exported by our own modules,
// not every free identifier -- so it has no false positives and needs no
// parser. Run it after touching imports:
//
//   node mobile/tools/test_imports.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, "src")), join(ROOT, "App.js")];

/** Every `export function X` / `export const X` in one of our modules. */
function exportsOf(file) {
  const src = readFileSync(file, "utf8");
  return new Set(
    [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1])
  );
}

// The modules whose exports are shared widely enough to get mis-imported.
const OWNED = ["src/theme.js", "src/components/ui.js", "src/components/Logo.js"];
const owned = new Map();
for (const rel of OWNED) for (const name of exportsOf(join(ROOT, rel))) owned.set(name, rel);

let failures = 0;
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  if (OWNED.includes(rel)) continue;           // a module may use its own exports
  const src = readFileSync(file, "utf8");

  // Names this file brings in, from anywhere.
  const imported = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) imported.add(n);
    }
  }
  // ...and names it defines itself, which legitimately shadow an export.
  const local = new Set(
    [...src.matchAll(/(?:^|\s)(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  );

  for (const [name, from] of owned) {
    if (imported.has(name) || local.has(name)) continue;
    // A call `name(` or an element `<Name`, not a property access `x.name`.
    const used = new RegExp(`(?<![.\\w$])${name}\\s*\\(|<${name}[\\s/>]`).test(src);
    if (used) {
      console.error(`FAIL  ${rel}: uses \`${name}\` (exported by ${from}) but never imports it`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} missing import${failures === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log(`ok    ${files.length} files, no missing imports from ${OWNED.join(", ")}`);
