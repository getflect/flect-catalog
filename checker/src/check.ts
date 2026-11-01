/**
 * `flect-catalog check`: run RFC-0021's rules over a catalog or one template.
 * A catalog's CI runs it; so can a template author before publishing.
 *
 * Given a directory with `flect-catalog.toml`, it checks the index and every
 * template it lists. Local sources are read from disk; GitHub sources only
 * with `fetch`, so the check works offline by default.
 */

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { parseCatalogIndex } from "./catalog-index.js"
import { formatSource, templateUrl, type Source } from "./source.js"
import { parseTemplate, type Problem } from "./template.js"

export interface CheckedTemplate {
  /** The catalog id, or the file for a lone template. */
  label: string
  errors: Problem[]
  warnings: Problem[]
  /** Not checked: a GitHub source without `fetch`. */
  skipped?: string
}

export interface CheckReport {
  /** Problems with the index itself. */
  index: Problem[]
  templates: CheckedTemplate[]
}

export interface CheckOptions {
  /** Fetch GitHub sources over the network. */
  fetch?: typeof fetch | false
}

export const ok = (r: CheckReport): boolean => r.index.length === 0 && r.templates.every((t) => t.errors.length === 0)

/** Check a catalog directory, a template directory, or a template file. */
export async function check(path: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const isDir = (await stat(path)).isDirectory()
  if (isDir && (await exists(join(path, "flect-catalog.toml")))) return checkCatalog(path, opts)
  const file = isDir ? join(path, "flect.toml") : path
  return { index: [], templates: [checkTemplateText(await readFile(file, "utf8"), file, file)] }
}

async function checkCatalog(dir: string, opts: CheckOptions): Promise<CheckReport> {
  const parsed = parseCatalogIndex(await readFile(join(dir, "flect-catalog.toml"), "utf8"))
  if (!parsed.ok) return { index: parsed.errors, templates: [] }
  const templates: CheckedTemplate[] = []
  for (const entry of parsed.index.apps) templates.push(await checkEntry(dir, entry.id, entry.source, opts))
  return { index: [], templates }
}

async function checkEntry(dir: string, id: string, source: Source, opts: CheckOptions): Promise<CheckedTemplate> {
  if (source.kind === "local") {
    const file = join(dir, source.dir, "flect.toml")
    if (!(await exists(file))) return { label: id, errors: [{ where: formatSource(source), message: `no flect.toml at ${file}` }], warnings: [] }
    return checkTemplateText(await readFile(file, "utf8"), file, id)
  }
  const url = templateUrl(source)!
  if (!opts.fetch) return { label: id, errors: [], warnings: [], skipped: `${formatSource(source)} (pass --fetch to check it)` }
  const res = await opts.fetch(url).catch((e: unknown) => e as Error)
  if (res instanceof Error) return { label: id, errors: [{ where: url, message: `could not fetch: ${res.message}` }], warnings: [] }
  if (!res.ok) return { label: id, errors: [{ where: url, message: `could not fetch: HTTP ${res.status}` }], warnings: [] }
  return checkTemplateText(await res.text(), url, id)
}

function checkTemplateText(text: string, path: string, label: string): CheckedTemplate {
  const r = parseTemplate(text, path)
  return { label, errors: r.ok ? [] : r.errors, warnings: r.warnings }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false)
}

/** The report as lines for a terminal. */
export function formatReport(r: CheckReport): string {
  const lines: string[] = []
  for (const p of r.index) lines.push(`✗ flect-catalog.toml  ${p.where}: ${p.message}`)
  for (const t of r.templates) {
    if (t.skipped) lines.push(`- ${t.label}  skipped: ${t.skipped}`)
    else lines.push(`${t.errors.length === 0 ? "✓" : "✗"} ${t.label}`)
    for (const p of t.errors) lines.push(`    error    ${p.where}: ${p.message}`)
    for (const p of t.warnings) lines.push(`    warning  ${p.where}: ${p.message}`)
  }
  return lines.join("\n")
}
