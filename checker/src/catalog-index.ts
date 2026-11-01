/**
 * A catalog's index (RFC-0021): `flect-catalog.toml` at the root of a git
 * repo, listing templates by id, each at a pinned source.
 *
 *   [catalog]
 *   name        = "dotlabs"
 *   description = "Apps tried on Flect by the dotlabs team."
 *
 *   [[apps]]
 *   id     = "papyra"
 *   source = "./apps/papyra"
 */

import { parse, TomlError } from "smol-toml"
import type { Problem } from "./template.js"
import { parseSource, SourceError, type Source } from "./source.js"

export interface CatalogEntry {
  id: string
  source: Source
}

export interface CatalogIndex {
  name: string
  description?: string
  apps: CatalogEntry[]
}

export type IndexResult = { ok: true; index: CatalogIndex } | { ok: false; errors: Problem[] }

const ID = /^[a-z0-9][a-z0-9-]*$/

export function parseCatalogIndex(text: string, path = "flect-catalog.toml"): IndexResult {
  const errors: Problem[] = []
  const err = (where: string, message: string) => void errors.push({ where, message })

  let doc: Record<string, unknown>
  try {
    doc = parse(text) as Record<string, unknown>
  } catch (e) {
    const message = e instanceof TomlError ? e.message.split("\n")[0]! : String(e)
    return { ok: false, errors: [{ where: path, message: `not valid TOML: ${message}` }] }
  }
  for (const k of Object.keys(doc)) if (k !== "catalog" && k !== "apps") err(k, "not a field of a catalog index")

  const meta = doc["catalog"]
  let name: string | undefined
  let description: string | undefined
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) err("[catalog]", "missing: name the catalog")
  else {
    const m = meta as Record<string, unknown>
    for (const k of Object.keys(m)) if (k !== "name" && k !== "description") err(`[catalog].${k}`, "not a field of a catalog index")
    name = typeof m["name"] === "string" && ID.test(m["name"]) ? m["name"] : undefined
    if (!name) err("[catalog].name", `required: lower-case letters, digits and "-"`)
    if (m["description"] !== undefined && typeof m["description"] !== "string") err("[catalog].description", "must be a string")
    else description = m["description"] as string | undefined
  }

  const apps: CatalogEntry[] = []
  const list = doc["apps"]
  if (list === undefined) err("[[apps]]", "no apps: add an [[apps]] entry")
  else if (!Array.isArray(list)) err("[[apps]]", "must be an array of tables")
  else {
    for (const [i, raw] of list.entries()) {
      const e = raw as Record<string, unknown>
      const id = typeof e["id"] === "string" ? e["id"] : undefined
      const where = `[[apps]] ${id ?? `#${i + 1}`}`
      for (const k of Object.keys(e)) if (k !== "id" && k !== "source") err(`${where}.${k}`, "not a field of a catalog entry")
      if (!id || !ID.test(id)) {
        err(where, `"id" is required: lower-case letters, digits and "-"`)
        continue
      }
      if (apps.some((a) => a.id === id)) err(where, `two apps are named "${id}"`)
      if (typeof e["source"] !== "string") {
        err(where, `"source" is required`)
        continue
      }
      try {
        apps.push({ id, source: parseSource(e["source"]) })
      } catch (x) {
        err(`${where}.source`, x instanceof SourceError ? x.message : String(x))
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, index: { name: name!, ...(description !== undefined ? { description } : {}), apps } }
}
