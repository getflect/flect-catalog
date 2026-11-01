import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { parseCatalogIndex } from "./catalog-index.js"
import { check, formatReport, ok } from "./check.js"
import { formatSource, parseSource, templateUrl } from "./source.js"

const examples = join(import.meta.dirname, "../examples")

describe("sources", () => {
  it("reads a GitHub source pinned to a ref, with an optional directory", () => {
    const s = parseSource("github:lyfie-org/papyra@v1.1.1#deploy/flect")
    expect(s).toEqual({ kind: "github", owner: "lyfie-org", repo: "papyra", ref: "v1.1.1", dir: "deploy/flect" })
    expect(templateUrl(s)).toBe("https://raw.githubusercontent.com/lyfie-org/papyra/v1.1.1/deploy/flect/flect.toml")
    expect(formatSource(s)).toBe("github:lyfie-org/papyra@v1.1.1#deploy/flect")
  })

  it("reads a path in the catalog repo", () => {
    expect(parseSource("./apps/papyra/")).toEqual({ kind: "local", dir: "apps/papyra" })
  })

  it.each([
    ["github:acme/app@main", '"main" is a branch; pin a tag or a commit'],
    ["github:acme/app", "a source is github:<owner>/<repo>@<ref>[#<dir>] or ./<dir>"],
    ["https://github.com/acme/app", "a source is github:<owner>/<repo>@<ref>[#<dir>] or ./<dir>"],
    ["./../other", "a directory inside the repo, without"],
    ["github:acme/app@v1#../../etc", "a directory inside the repo, without"],
  ])("refuses %s", (text, message) => {
    expect(() => parseSource(text)).toThrow(message)
  })
})

describe("the catalog index", () => {
  it("lists apps by id, each at a source", () => {
    const r = parseCatalogIndex(`[catalog]\nname = "acme"\n\n[[apps]]\nid = "notes"\nsource = "github:acme/notes@v2.3.0"\n`)
    expect(r).toEqual({ ok: true, index: { name: "acme", apps: [{ id: "notes", source: { kind: "github", owner: "acme", repo: "notes", ref: "v2.3.0", dir: "" } }] } })
  })

  it("refuses duplicate ids, a branch source and unknown fields, all at once", () => {
    const r = parseCatalogIndex(`[catalog]\nname = "acme"\nlogo = "x"\n\n[[apps]]\nid = "a"\nsource = "./a"\n[[apps]]\nid = "a"\nsource = "github:acme/a@main"\n`)
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.errors.map((e) => `${e.where}: ${e.message}`)).toEqual([
      "[catalog].logo: not a field of a catalog index",
      '[[apps]] a: two apps are named "a"',
      '[[apps]] a.source: "github:acme/a@main": "main" is a branch; pin a tag or a commit',
    ])
  })
})

describe("flect-catalog check", () => {
  it("passes the example catalog: three templates, papyra's volume only warns", async () => {
    const report = await check(examples)
    expect(ok(report)).toBe(true)
    expect(report.templates.map((t) => [t.label, t.errors.length, t.warnings.length])).toEqual([
      ["static", 0, 0],
      ["papyra", 0, 1],
      ["n8n", 0, 0],
    ])
    expect(formatReport(report)).toContain("✓ papyra\n    warning  [services.web].volumes: kept on the node the app runs on")
  })

  it("checks one template directory on its own", async () => {
    const report = await check(join(examples, "apps/static"))
    expect(ok(report)).toBe(true)
    expect(report.templates).toHaveLength(1)
  })

  it("fetches GitHub sources only when asked, from the pinned ref", async () => {
    const dir = join(import.meta.dirname, "../examples")
    const { mkdtemp, writeFile, cp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const tmp = await mkdtemp(join(tmpdir(), "catalog-"))
    await cp(join(dir, "apps"), join(tmp, "apps"), { recursive: true })
    await writeFile(join(tmp, "flect-catalog.toml"), `[catalog]\nname = "t"\n\n[[apps]]\nid = "remote"\nsource = "github:acme/remote@v1.0.0"\n`)

    const offline = await check(tmp)
    expect(offline.templates[0]).toMatchObject({ label: "remote", errors: [], skipped: "github:acme/remote@v1.0.0 (pass --fetch to check it)" })

    const fetchMock = vi.fn<typeof fetch>(async () => new Response("[app]\nname = \"remote\"\n"))
    const online = await check(tmp, { fetch: fetchMock })
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://raw.githubusercontent.com/acme/remote/v1.0.0/flect.toml")
    expect(ok(online)).toBe(false)
    expect(online.templates[0]!.errors[0]!.message).toContain("missing: a template has a [catalog] table")
  })
})
