/**
 * Where a template lives (RFC-0021, The Catalog Index):
 *
 *   github:<owner>/<repo>@<ref>[#<dir>]   a template in a GitHub repo, at a pinned ref
 *   ./<dir>                                a template in the catalog repo itself
 *
 * A ref is a tag or a commit, never a branch: what was reviewed is what installs.
 * The template file is `<dir>/flect.toml`; `<dir>` defaults to the repo root.
 */

export type Source =
  | { kind: "github"; owner: string; repo: string; ref: string; dir: string }
  | { kind: "local"; dir: string }

const GITHUB = /^github:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)@([^#\s]+)(?:#(.+))?$/
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
/** Names that are branches by convention, not pins. */
const BRANCHES = new Set(["main", "master", "dev", "develop", "trunk", "HEAD", "latest"])

export class SourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SourceError"
  }
}

/** Parse a source string, or throw a SourceError that says what is wrong. */
export function parseSource(text: string): Source {
  const s = text.trim()
  if (s.startsWith("./")) {
    const dir = cleanDir(s.slice(2))
    return { kind: "local", dir }
  }
  const m = GITHUB.exec(s)
  if (!m) throw new SourceError(`"${text}": a source is github:<owner>/<repo>@<ref>[#<dir>] or ./<dir>`)
  const [, owner, repo, ref, dir] = m
  if (!OWNER.test(owner!)) throw new SourceError(`"${text}": "${owner}" is not a GitHub owner`)
  if (BRANCHES.has(ref!)) throw new SourceError(`"${text}": "${ref}" is a branch; pin a tag or a commit`)
  return { kind: "github", owner: owner!, repo: repo!, ref: ref!, dir: cleanDir(dir ?? "") }
}

/** The source as text again, normalised. */
export function formatSource(s: Source): string {
  if (s.kind === "local") return `./${s.dir}`
  return `github:${s.owner}/${s.repo}@${s.ref}${s.dir ? `#${s.dir}` : ""}`
}

/** Where the template file is fetched from (raw GitHub); undefined for a local source. */
export function templateUrl(s: Source): string | undefined {
  if (s.kind === "local") return undefined
  const path = s.dir ? `${s.dir}/flect.toml` : "flect.toml"
  return `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${encodeURIComponent(s.ref)}/${path}`
}

/** A relative directory with no way out of the repo. */
function cleanDir(dir: string): string {
  const parts = dir.split("/").filter((p) => p !== "" && p !== ".")
  if (parts.includes("..")) throw new SourceError(`"${dir}": a directory inside the repo, without ".."`)
  return parts.join("/")
}
