/**
 * The catalog that ships with Flect: dotlabs' templates, bundled as text
 * (`builtin.generated.ts`, from `examples/`). Until the catalog has its own
 * repo (RFC-0021 P2 → P5) this is what the dashboard lists.
 */

import { BUILTIN_INDEX, BUILTIN_TEMPLATES } from "./builtin.generated.js"
import { parseCatalogIndex } from "./catalog-index.js"
import { parseTemplate, type Problem, type Template } from "./template.js"

export interface CatalogApp {
  /** The id in the catalog index; what a URL names. */
  id: string
  template: Template
  warnings: Problem[]
}

/** Every template of the built-in catalog, in index order. Throws if one is invalid: that is a build bug. */
export function builtinCatalog(): CatalogApp[] {
  const index = parseCatalogIndex(BUILTIN_INDEX)
  if (!index.ok) throw new Error(`built-in catalog index: ${index.errors.map((e) => `${e.where}: ${e.message}`).join("; ")}`)
  return index.index.apps.map((entry) => {
    if (entry.source.kind !== "local") throw new Error(`built-in catalog: ${entry.id} is not bundled (${entry.source.kind} source)`)
    const text = BUILTIN_TEMPLATES[entry.source.dir]
    if (text === undefined) throw new Error(`built-in catalog: no bundled template for ${entry.id}`)
    const r = parseTemplate(text, `${entry.source.dir}/flect.toml`)
    if (!r.ok) throw new Error(`built-in catalog: ${entry.id}: ${r.errors.map((e) => `${e.where}: ${e.message}`).join("; ")}`)
    return { id: entry.id, template: r.template, warnings: r.warnings }
  })
}
