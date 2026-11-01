/**
 * Generate `src/builtin.generated.ts` from `examples/`: a copy of this repo's
 * index and every local template it lists, as text. Flect bundles the constant
 * and serves it until the broker has indexed the repo. `examples/` is refreshed
 * from the repo root by hand, never the other way round. Re-run after that:
 *   npm run gen:builtin (in checker/)
 * A test fails when the generated file and `examples/` disagree.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..", "examples")
const out = join(here, "..", "src", "builtin.generated.ts")

export function builtinSource() {
  const index = readFileSync(join(root, "flect-catalog.toml"), "utf8")
  // Only `./dir` sources are bundled; the index is parsed properly at runtime.
  const dirs = [...index.matchAll(/^\s*source\s*=\s*"\.\/([^"]+)"/gm)].map((m) => m[1].replace(/\/+$/, ""))
  const templates = Object.fromEntries(dirs.map((d) => [d, readFileSync(join(root, d, "flect.toml"), "utf8")]))
  return (
    `// AUTO-GENERATED from checker/examples — do not edit.\n` +
    `// Regenerate with: npm run gen:builtin (in checker/)\n` +
    `export const BUILTIN_INDEX = ${JSON.stringify(index)}\n` +
    `/** Template text by the directory its index source names. */\n` +
    `export const BUILTIN_TEMPLATES: Record<string, string> = ${JSON.stringify(templates, null, 2)}\n`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(out, builtinSource())
  console.log(`wrote ${out}`)
}
