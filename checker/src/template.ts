/**
 * A catalog template (RFC-0021): a flect.toml with a `[catalog]` table, no
 * scope and no resource ids, plus what an install needs — `[inputs.*]` to ask
 * and `[secrets.*]` to generate. Everything else is RFC-0019's services format.
 *
 * The schema is closed (RFC-0021 §6): a key this module does not know is an
 * error, so a community template cannot say anything an instance file cannot.
 * Every problem is collected, not just the first, so a catalog's CI reports
 * them all at once.
 */

import { parse, TomlError } from "smol-toml"

export type BindingKind = "database" | "kv" | "storage"
export type Category = "starter" | "app" | "data" | "worker"

export interface CatalogMeta {
  title: string
  tagline: string
  category: Category
  license?: string
  source?: string
  icon?: string
  maintainer?: string
  tags: string[]
}

export interface Input {
  name: string
  description?: string
  /** No default: the input is required. */
  default?: string
  pattern?: string
}

export interface SecretDecl {
  name: string
  /** `hex:<bytes>`, `base64:<bytes>` or `password:<length>`; absent: asked at install. */
  generate?: string
  note?: string
}

export interface ResourceNeed {
  binding: string
  kind: BindingKind
  migrationsDir?: string
}

export interface HealthDecl {
  path?: string
  intervalSec?: number
  timeoutSec?: number
}

export interface TemplateService {
  key: string
  image: string
  port: number
  public: boolean
  expose?: string
  replicas?: number
  cpuMhz?: number
  memoryMb?: number
  health?: HealthDecl | false
  uses: string[]
  calls: string[]
  secrets: string[]
  /** `[vars]` with this service's own on top; placeholders not expanded. */
  vars: Record<string, string>
  /** Directories that must survive restarts (RFC-0022). */
  volumes: VolumeDecl[]
}

/** A directory that survives restarts (RFC-0022): `"/data"` or `{ path, size, owner }`. */
export interface VolumeDecl {
  path: string
  /** What the app expects to need; counted against the plan. */
  sizeBytes: number
  /** uid:gid the directory is created for; absent: root. */
  owner?: { uid: number; gid: number }
}

/** RFC-0022: a volume with no size is 1 GiB. */
export const DEFAULT_VOLUME_BYTES = 1024 ** 3

const SIZE_UNITS: Record<string, number> = { "": 1, B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }

/** "10GiB", "512MiB" or a number of bytes; undefined when it is neither. */
export function parseSize(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : undefined
  if (typeof v !== "string") return undefined
  const m = /^(\d+)\s*(B|KiB|MiB|GiB|TiB)?$/.exec(v.trim())
  if (!m) return undefined
  const n = Number(m[1]) * SIZE_UNITS[m[2] ?? ""]!
  return n > 0 ? n : undefined
}

/** One entry of `volumes`, or why it is not one. */
export function parseVolume(v: unknown): { ok: true; volume: VolumeDecl } | { ok: false; message: string } {
  const raw: Record<string, unknown> | undefined =
    typeof v === "string" ? { path: v } : typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  if (!raw) return { ok: false, message: `a path such as "/data", or { path, size, owner }` }
  const extra = Object.keys(raw).filter((k) => !["path", "size", "owner"].includes(k))
  if (extra.length > 0) return { ok: false, message: `not a field of a volume: ${extra.join(", ")}` }
  const path = raw["path"]
  if (typeof path !== "string" || !path.startsWith("/") || path === "/" || path.split("/").includes("..")) {
    return { ok: false, message: `an absolute directory in the container, not "/" (got ${JSON.stringify(path)})` }
  }
  let sizeBytes = DEFAULT_VOLUME_BYTES
  if (raw["size"] !== undefined) {
    const n = parseSize(raw["size"])
    if (n === undefined) return { ok: false, message: `size is bytes or a size such as "10GiB" (got ${JSON.stringify(raw["size"])})` }
    sizeBytes = n
  }
  let owner: VolumeDecl["owner"]
  if (raw["owner"] !== undefined) {
    const m = typeof raw["owner"] === "string" ? /^(\d{1,10}):(\d{1,10})$/.exec(raw["owner"]) : null
    if (!m) return { ok: false, message: `owner is "uid:gid", e.g. "1000:1000" (got ${JSON.stringify(raw["owner"])})` }
    owner = { uid: Number(m[1]), gid: Number(m[2]) }
  }
  return { ok: true, volume: { path, sizeBytes, ...(owner ? { owner } : {}) } }
}

export interface Template {
  path: string
  name: string
  catalog: CatalogMeta
  inputs: Input[]
  secrets: SecretDecl[]
  resources: ResourceNeed[]
  services: TemplateService[]
}

/** One problem, with where it is. */
export interface Problem {
  where: string
  message: string
}

export type TemplateResult =
  | { ok: true; template: Template; warnings: Problem[] }
  | { ok: false; errors: Problem[]; warnings: Problem[] }

const CATEGORIES: Category[] = ["starter", "app", "data", "worker"]
const KINDS: Array<[string, BindingKind]> = [["databases", "database"], ["kv", "kv"], ["stores", "storage"]]
/** Tags that move: an install would not mean the same thing tomorrow (RFC-0021 §5). */
const MOVING_TAGS = new Set(["latest", "main", "master", "dev", "edge", "nightly"])
const NAME = /^[a-z0-9][a-z0-9-]*$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const PLACEHOLDER = /\{(inputs|app)\.([A-Za-z0-9_]+)\}/g
const HAS_PLACEHOLDER = /\{(inputs|app)\.[A-Za-z0-9_]+\}/
const APP_PLACEHOLDERS = new Set(["url", "name"])
const GENERATE = /^(hex|base64|password):(\d+)$/

/** Is this flect.toml a template? Only a template has a `[catalog]` table. */
export function isTemplateDoc(doc: Record<string, unknown>): boolean {
  return typeof doc["catalog"] === "object" && doc["catalog"] !== null && !Array.isArray(doc["catalog"])
}

/** Parse and validate a template. Never throws on a bad template: the problems are the answer. */
export function parseTemplate(text: string, path = "flect.toml"): TemplateResult {
  const errors: Problem[] = []
  const warnings: Problem[] = []
  const err = (where: string, message: string) => void errors.push({ where, message })
  const warn = (where: string, message: string) => void warnings.push({ where, message })

  let doc: Record<string, unknown>
  try {
    doc = parse(text) as Record<string, unknown>
  } catch (e) {
    const message = e instanceof TomlError ? e.message.split("\n")[0]! : String(e)
    return { ok: false, errors: [{ where: path, message: `not valid TOML: ${message}` }], warnings }
  }

  if (!isTemplateDoc(doc)) err("[catalog]", "missing: a template has a [catalog] table (title, tagline, category)")
  if (doc["apps"] !== undefined) err("[[apps]]", "the old format is not a template; use [services.<name>] (RFC-0019)")
  closed(doc, ["app", "catalog", "inputs", "secrets", "vars", "services", "databases", "kv", "stores"], "", err)

  // [app]
  const app = table(doc["app"], "[app]", err) ?? {}
  // scope and domain are known only to be refused with a reason below.
  closed(app, ["name", "region", "scope", "domain"], "[app]", err)
  if (app["scope"] !== undefined) err("[app].scope", "a template has no scope: the installer chooses it")
  if (app["domain"] !== undefined) err("[app].domain", "a template has no domain: the installer chooses it, or uses the generated host")
  const name = str(app["name"])
  if (!name) err("[app].name", "required: the app's default name")
  else if (!NAME.test(name)) err("[app].name", `lower-case letters, digits and "-" (got "${name}")`)
  if (app["region"] !== undefined && app["region"] !== "eu") err("[app].region", `only "eu" exists today`)

  // [catalog]
  const meta = table(doc["catalog"], "[catalog]", err) ?? {}
  closed(meta, ["title", "tagline", "category", "license", "source", "icon", "maintainer", "tags"], "[catalog]", err)
  for (const k of ["title", "tagline", "category"]) if (!str(meta[k])) err(`[catalog].${k}`, "required")
  const category = str(meta["category"])
  if (category && !CATEGORIES.includes(category as Category)) err("[catalog].category", `one of ${CATEGORIES.join(", ")} (got "${category}")`)
  for (const k of ["license", "source", "icon", "maintainer"]) if (meta[k] !== undefined && !str(meta[k])) err(`[catalog].${k}`, "must be a string")
  const source = str(meta["source"])
  if (source && !/^https:\/\//.test(source)) err("[catalog].source", "an https URL")
  const icon = str(meta["icon"])
  if (icon && (icon.startsWith("/") || icon.split("/").includes(".."))) err("[catalog].icon", "a path inside the template's directory")
  const tags = strings(meta["tags"], "[catalog].tags", err)

  // [inputs.*]
  const inputs: Input[] = []
  for (const [n, raw] of entries(doc["inputs"], "[inputs]", err)) {
    const where = `[inputs.${n}]`
    if (!ENV_NAME.test(n)) err(where, "an input name is UPPER_CASE letters, digits and _")
    const t = table(raw, where, err)
    if (!t) continue
    closed(t, ["description", "default", "pattern"], where, err)
    for (const k of ["description", "default", "pattern"]) if (t[k] !== undefined && !str(t[k])) err(`${where}.${k}`, "must be a string")
    const pattern = str(t["pattern"])
    if (pattern !== undefined) {
      try {
        const re = new RegExp(`^(?:${pattern})$`)
        const d = str(t["default"])
        if (d !== undefined && !re.test(d)) err(`${where}.default`, `does not match its own pattern`)
      } catch {
        err(`${where}.pattern`, "not a valid regular expression")
      }
    }
    inputs.push({ name: n, ...opt("description", str(t["description"])), ...opt("default", str(t["default"])), ...opt("pattern", pattern) })
  }

  // [secrets.*]
  const secrets: SecretDecl[] = []
  for (const [n, raw] of entries(doc["secrets"], "[secrets]", err)) {
    const where = `[secrets.${n}]`
    if (!ENV_NAME.test(n)) err(where, "a secret name is UPPER_CASE letters, digits and _")
    const t = table(raw, where, err)
    if (!t) continue
    closed(t, ["generate", "note"], where, err)
    const generate = str(t["generate"])
    if (t["generate"] !== undefined) {
      const m = generate ? GENERATE.exec(generate) : null
      if (!m) err(`${where}.generate`, `"hex:<bytes>", "base64:<bytes>" or "password:<length>"`)
      else {
        const n = Number(m[2])
        const [lo, hi] = m[1] === "password" ? [12, 128] : [16, 128]
        if (n < lo || n > hi) err(`${where}.generate`, `${m[1]} wants ${lo}–${hi} (got ${n})`)
      }
    }
    if (t["note"] !== undefined && !str(t["note"])) err(`${where}.note`, "must be a string")
    secrets.push({ name: n, ...opt("generate", generate), ...opt("note", str(t["note"])) })
  }
  for (const i of inputs) if (secrets.some((s) => s.name === i.name)) err(`[inputs.${i.name}]`, "is also a secret")

  // Resources: a binding, no id.
  const resources: ResourceNeed[] = []
  for (const [section, kind] of KINDS) {
    const list = doc[section]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      err(`[[${section}]]`, "must be an array of tables")
      continue
    }
    for (const [i, raw] of list.entries()) {
      const t = table(raw, `[[${section}]] #${i + 1}`, err)
      if (!t) continue
      const binding = str(t["binding"])
      const where = `[[${section}]] ${binding ?? `#${i + 1}`}`
      closed(t, ["binding", "migrations_dir", "id"], where, err)
      if (t["id"] !== undefined) err(`${where}.id`, "a template has no ids: install creates the resource")
      if (!binding) {
        err(where, `"binding" is required`)
        continue
      }
      if (!ENV_NAME.test(binding)) err(where, `a binding is UPPER_CASE letters, digits and _ (got "${binding}")`)
      if (resources.some((r) => r.binding === binding)) err(where, `two resources are named "${binding}"`)
      resources.push({ binding, kind, ...opt("migrationsDir", str(t["migrations_dir"])) })
    }
  }

  // Services.
  const shared = varsOf(doc["vars"], "[vars]", err)
  const svcTable = table(doc["services"], "[services]", err) ?? {}
  const keys = Object.keys(svcTable)
  if (keys.length === 0) err("[services]", "no services: add a [services.<name>]")
  const services: TemplateService[] = []
  for (const key of keys) {
    const where = `[services.${key}]`
    const s = table(svcTable[key], where, err)
    if (!s) continue
    if (!NAME.test(key)) err(where, `a service name is lower-case letters, digits and "-"`)
    if (s["name"] !== undefined) err(`${where}.name`, "not in a template: the deployed name is <app>-<service>")
    if (s["staticPort"] !== undefined) err(`${where}.staticPort`, "a fixed host port is not allowed in a template")
    closed(s, ["image", "port", "public", "expose", "replicas", "cpuMhz", "memoryMb", "health", "uses", "calls", "secrets", "vars", "volumes", "name", "staticPort"], where, err)

    const image = str(s["image"])
    if (!image) err(`${where}.image`, "required")
    else {
      const problem = imageProblem(image)
      if (problem) err(`${where}.image`, problem)
    }
    const port = s["port"]
    if (port === undefined) err(`${where}.port`, "required")
    else if (!isInt(port, 1, 65535)) err(`${where}.port`, "an integer 1–65535")
    if (s["public"] !== undefined && typeof s["public"] !== "boolean") err(`${where}.public`, "true or false")
    const expose = str(s["expose"])
    if (s["expose"] !== undefined && (!expose || !/^\/[A-Za-z0-9._~\/-]*$/.test(expose) || expose === "/")) err(`${where}.expose`, `a path such as "/v1/auth"`)
    if (s["public"] === true && expose) err(where, "public and expose are exclusive")
    const replicas = s["replicas"]
    if (replicas !== undefined && !isInt(replicas, 0, 10)) err(`${where}.replicas`, "an integer 0–10")
    if (s["cpuMhz"] !== undefined && !isInt(s["cpuMhz"], 50, 4000)) err(`${where}.cpuMhz`, "an integer 50–4000")
    if (s["memoryMb"] !== undefined && !isInt(s["memoryMb"], 32, 8192)) err(`${where}.memoryMb`, "an integer 32–8192")
    const health = s["health"] !== undefined ? healthOf(s["health"], `${where}.health`, err) : undefined

    const uses = strings(s["uses"], `${where}.uses`, err)
    for (const u of uses) if (!resources.some((r) => r.binding === u)) err(`${where}.uses`, `"${u}" is not a resource of this template`)
    const calls = strings(s["calls"], `${where}.calls`, err)
    for (const c of calls) {
      if (c === key) err(`${where}.calls`, "calls itself")
      else if (!keys.includes(c)) err(`${where}.calls`, `"${c}" is not a service of this template`)
    }
    const secretNames = strings(s["secrets"], `${where}.secrets`, err)
    for (const n of secretNames) if (!secrets.some((d) => d.name === n)) err(`${where}.secrets`, `"${n}" has no [secrets.${n}]`)
    const vars = { ...shared, ...varsOf(s["vars"], `${where}.vars`, err) }
    for (const n of secretNames) if (n in vars) err(where, `"${n}" is both a var and a secret`)
    for (const [k, v] of Object.entries(vars)) {
      for (const m of v.matchAll(PLACEHOLDER)) {
        const [whole, ns, ref] = m
        if (ns === "inputs" && !inputs.some((i) => i.name === ref)) err(`${where}.vars.${k}`, `${whole}: no [inputs.${ref}]`)
        if (ns === "app" && !APP_PLACEHOLDERS.has(ref!)) err(`${where}.vars.${k}`, `${whole}: only {app.url} and {app.name}`)
      }
      if (looksSecret(k) && !HAS_PLACEHOLDER.test(v)) warn(`${where}.vars.${k}`, "reads like a secret; declare it in [secrets] so its value is never in the file")
    }
    const volumes: VolumeDecl[] = []
    if (s["volumes"] !== undefined && !Array.isArray(s["volumes"])) err(`${where}.volumes`, "must be a list")
    for (const v of Array.isArray(s["volumes"]) ? (s["volumes"] as unknown[]) : []) {
      const r = parseVolume(v)
      if (!r.ok) err(`${where}.volumes`, r.message)
      else if (volumes.some((x) => x.path === r.volume.path)) err(`${where}.volumes`, `"${r.volume.path}" twice`)
      else volumes.push(r.volume)
    }
    if (volumes.length > 0) {
      warn(`${where}.volumes`, "kept on the node the app runs on, and not backed up yet (RFC-0022 D3)")
      if (typeof replicas === "number" && replicas > 1) err(`${where}.replicas`, "a service with a volume runs as one instance")
    }

    services.push({
      key,
      image: image ?? "",
      port: typeof port === "number" ? port : 0,
      public: s["public"] === true,
      ...opt("expose", expose),
      ...opt("replicas", typeof replicas === "number" ? replicas : undefined),
      ...opt("cpuMhz", typeof s["cpuMhz"] === "number" ? s["cpuMhz"] : undefined),
      ...opt("memoryMb", typeof s["memoryMb"] === "number" ? s["memoryMb"] : undefined),
      ...(health !== undefined ? { health } : {}),
      uses,
      calls,
      secrets: secretNames,
      vars,
      volumes,
    })
  }
  if (services.filter((s) => s.public).length > 1) err("[services]", "only one service may be public (it owns the domain)")
  if (services.some((s) => s.expose) && !services.some((s) => s.public)) {
    err("[services]", "an exposed path needs a public service: it is mounted on that service's host")
  }

  // Declared but never used: not wrong, likely a slip.
  for (const i of inputs) {
    if (!services.some((s) => Object.values(s.vars).some((v) => v.includes(`{inputs.${i.name}}`)))) warn(`[inputs.${i.name}]`, "not used by any var")
  }
  for (const d of secrets) if (!services.some((s) => s.secrets.includes(d.name))) warn(`[secrets.${d.name}]`, "no service lists it in secrets")
  for (const r of resources) if (!services.some((s) => s.uses.includes(r.binding))) warn(`resource ${r.binding}`, "no service uses it")

  if (errors.length > 0) return { ok: false, errors, warnings }
  return {
    ok: true,
    warnings,
    template: {
      path,
      name: name!,
      catalog: {
        title: str(meta["title"])!,
        tagline: str(meta["tagline"])!,
        category: category as Category,
        ...opt("license", str(meta["license"])),
        ...opt("source", source),
        ...opt("icon", icon),
        ...opt("maintainer", str(meta["maintainer"])),
        tags,
      },
      inputs,
      secrets,
      resources,
      services,
    },
  }
}

/** Why an image reference is not pinned, or undefined when it is (RFC-0021 §5). */
export function imageProblem(image: string): string | undefined {
  if (/\s/.test(image) || image.length === 0) return "not an image reference"
  if (image.includes("@sha256:")) return /@sha256:[0-9a-f]{64}$/.test(image) ? undefined : "a digest is @sha256: and 64 hex characters"
  const last = image.slice(image.lastIndexOf("/") + 1)
  const colon = last.lastIndexOf(":")
  if (colon < 0) return `no tag: pin a version, e.g. "${image}:1.2.3"`
  const tag = last.slice(colon + 1)
  if (!tag) return "empty tag"
  if (MOVING_TAGS.has(tag.toLowerCase())) return `"${tag}" moves; pin a version or a digest`
  return undefined
}

/** A name that reads like a secret: it belongs in [secrets], not vars. */
export function looksSecret(name: string): boolean {
  return /(_SECRET|_KEY|_TOKEN|_PASSWORD)$/.test(name) || /^(SECRET|PASSWORD|TOKEN)$/.test(name)
}

type Report = (where: string, message: string) => void

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const isInt = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi
const opt = <K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } => (v === undefined ? {} : ({ [k]: v } as { [P in K]?: V }))

function table(v: unknown, where: string, err: Report): Record<string, unknown> | undefined {
  if (v === undefined) return undefined
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    err(where, "must be a table")
    return undefined
  }
  return v as Record<string, unknown>
}

function entries(v: unknown, where: string, err: Report): Array<[string, unknown]> {
  const t = table(v, where, err)
  return t ? Object.entries(t) : []
}

/** The closed schema: any key not in `known` is refused (RFC-0021 §6). */
function closed(t: Record<string, unknown>, known: string[], where: string, err: Report): void {
  for (const k of Object.keys(t)) if (!known.includes(k)) err(where ? `${where}.${k}` : k, "not a field of a template")
}

function strings(v: unknown, where: string, err: Report): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    err(where, "must be a list of strings")
    return []
  }
  return [...new Set(v as string[])]
}

function varsOf(v: unknown, where: string, err: Report): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, x] of entries(v, where, err)) {
    if (typeof x !== "string") err(`${where}.${k}`, "must be a string")
    else out[k] = x
  }
  return out
}

/** `false` | "/path" | { path, interval, timeout }, as the CLI reads it. */
function healthOf(v: unknown, where: string, err: Report): HealthDecl | false | undefined {
  if (v === false) return false
  if (v === true) return {}
  if (typeof v !== "string" && (typeof v !== "object" || v === null || Array.isArray(v))) {
    err(where, "a path, a table, or false")
    return undefined
  }
  const raw = typeof v === "string" ? { path: v } : (v as Record<string, unknown>)
  closed(raw, ["path", "interval", "timeout"], where, err)
  const path = raw["path"]
  if (path !== undefined && (typeof path !== "string" || !path.startsWith("/"))) err(`${where}.path`, `must start with "/"`)
  const interval = duration(raw["interval"], `${where}.interval`, err)
  const timeout = duration(raw["timeout"], `${where}.timeout`, err)
  return {
    ...(typeof path === "string" ? { path } : {}),
    ...(interval !== undefined ? { intervalSec: interval } : {}),
    ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
  }
}

function duration(v: unknown, where: string, err: Report): number | undefined {
  if (v === undefined) return undefined
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v
  const m = typeof v === "string" ? /^(\d+)\s*(s|m)?$/.exec(v.trim()) : null
  if (!m) {
    err(where, `seconds or a duration like "30s"`)
    return undefined
  }
  return Number(m[1]) * (m[2] === "m" ? 60 : 1)
}
