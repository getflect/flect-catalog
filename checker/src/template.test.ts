import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { imageProblem, parseTemplate, type TemplateResult } from "./template.js"

const examples = join(import.meta.dirname, "../examples/apps")
const example = (id: string) => readFileSync(join(examples, id, "flect.toml"), "utf8")

const base = `
[app]
name = "demo"

[catalog]
title    = "Demo"
tagline  = "A demo."
category = "app"

[services.web]
image  = "ghcr.io/acme/demo:1.0.0"
port   = 3000
public = true
`

/** The messages of a failed result, as "where: message". */
const errorsOf = (r: TemplateResult) => (r.ok ? [] : r.errors.map((e) => `${e.where}: ${e.message}`))
const warningsOf = (r: TemplateResult) => r.warnings.map((w) => `${w.where}: ${w.message}`)

describe("the example templates", () => {
  it("nginx: one public service checked on /", () => {
    const r = parseTemplate(example("static"))
    expect(errorsOf(r)).toEqual([])
    expect(r.ok && r.template.services[0]).toMatchObject({ key: "web", image: "nginx:1.27-alpine", port: 80, public: true, health: { path: "/" } })
  })

  it("papyra: an input in a var, and a volume that warns until volumes land", () => {
    const r = parseTemplate(example("papyra"))
    expect(errorsOf(r)).toEqual([])
    if (!r.ok) return
    expect(r.template.inputs).toEqual([{ name: "TZ", description: "Time zone for dates in notes", default: "UTC" }])
    expect(r.template.services[0]!.vars["TZ"]).toBe("{inputs.TZ}")
    expect(r.template.services[0]!.volumes).toEqual([{ path: "/data", sizeBytes: 1024 ** 3 }])
    expect(warningsOf(r)).toEqual([expect.stringContaining("[services.web].volumes: kept on the node the app runs on, and not backed up yet")])
  })

  it("n8n: a database created on install and a secret generated on install", () => {
    const r = parseTemplate(example("n8n"))
    expect(errorsOf(r)).toEqual([])
    expect(warningsOf(r)).toEqual([])
    if (!r.ok) return
    expect(r.template.resources).toEqual([{ binding: "DB", kind: "database" }])
    expect(r.template.secrets).toEqual([{ name: "N8N_ENCRYPTION_KEY", generate: "hex:32", note: "Changing it locks every stored credential." }])
    expect(r.template.services[0]!.vars["WEBHOOK_URL"]).toBe("{app.url}")
  })
})

describe("a template is portable (RFC-0021 §1)", () => {
  it("is a template only with a [catalog] table", () => {
    const r = parseTemplate(base.replace(/\[catalog\][\s\S]*?\n\n/, ""))
    expect(errorsOf(r)).toContain("[catalog]: missing: a template has a [catalog] table (title, tagline, category)")
  })

  it("has no scope and no domain: the installer chooses them", () => {
    const r = parseTemplate(base.replace('name = "demo"', 'name = "demo"\nscope = "acme/web/prod"\ndomain = "demo.acme.com"'))
    expect(errorsOf(r)).toEqual([
      "[app].scope: a template has no scope: the installer chooses it",
      "[app].domain: a template has no domain: the installer chooses it, or uses the generated host",
    ])
  })

  it("names resources by binding, never by id", () => {
    const r = parseTemplate(`${base}\nuses = ["DB"]\n\n[[databases]]\nbinding = "DB"\nid = "res_k7f3a2"\n`)
    expect(errorsOf(r)).toEqual(["[[databases]] DB.id: a template has no ids: install creates the resource"])
  })

  it("keeps RFC-0019's rules: uses names a resource, calls names a service", () => {
    const r = parseTemplate(`${base}uses = ["CACHE"]\ncalls = ["api", "web"]\n`)
    expect(errorsOf(r)).toEqual([
      '[services.web].uses: "CACHE" is not a resource of this template',
      '[services.web].calls: "api" is not a service of this template',
      "[services.web].calls: calls itself",
    ])
  })
})

describe("inputs and secrets (§2, §3)", () => {
  it("refuses a placeholder for an input that does not exist", () => {
    const r = parseTemplate(`${base}\n[services.web.vars]\nURL = "{inputs.URL}"\nNAME = "{app.title}"\n`)
    expect(errorsOf(r)).toEqual([
      "[services.web].vars.URL: {inputs.URL}: no [inputs.URL]",
      "[services.web].vars.NAME: {app.title}: only {app.url} and {app.name}",
    ])
  })

  it("leaves other braces alone: a JSON value is not a placeholder", () => {
    const r = parseTemplate(`${base}\n[services.web.vars]\nOPTS = '{"a": 1}'\n`)
    expect(errorsOf(r)).toEqual([])
  })

  it("checks a default against the input's own pattern", () => {
    const r = parseTemplate(`${base}\n[inputs.PORT]\ndefault = "abc"\npattern = "[0-9]+"\n`)
    expect(errorsOf(r)).toContain("[inputs.PORT].default: does not match its own pattern")
  })

  it("generates hex, base64 or a password, within bounds", () => {
    const r = parseTemplate(`${base}secrets = ["A", "B", "C"]\n\n[secrets.A]\ngenerate = "hex:8"\n[secrets.B]\ngenerate = "uuid"\n[secrets.C]\ngenerate = "password:24"\n`)
    expect(errorsOf(r)).toEqual([
      "[secrets.A].generate: hex wants 16–128 (got 8)",
      '[secrets.B].generate: "hex:<bytes>", "base64:<bytes>" or "password:<length>"',
    ])
  })

  it("a service lists only declared secrets, and a name is a var or a secret, not both", () => {
    const r = parseTemplate(`${base}secrets = ["KEY", "UNDECLARED"]\n\n[services.web.vars]\nKEY = "x"\n\n[secrets.KEY]\ngenerate = "hex:32"\n`)
    expect(errorsOf(r)).toEqual([
      '[services.web].secrets: "UNDECLARED" has no [secrets.UNDECLARED]',
      '[services.web]: "KEY" is both a var and a secret',
    ])
  })

  it("warns about what is declared and never used, and a var that reads like a secret", () => {
    const r = parseTemplate(`${base}\n[services.web.vars]\nAPI_KEY = "abc"\n\n[inputs.UNUSED]\ndefault = "x"\n\n[secrets.SPARE]\ngenerate = "hex:32"\n`)
    expect(errorsOf(r)).toEqual([])
    expect(warningsOf(r)).toEqual([
      "[services.web].vars.API_KEY: reads like a secret; declare it in [secrets] so its value is never in the file",
      "[inputs.UNUSED]: not used by any var",
      "[secrets.SPARE]: no service lists it in secrets",
    ])
  })
})

describe("pinned images (§5)", () => {
  it.each([
    ["nginx", 'no tag: pin a version, e.g. "nginx:1.2.3"'],
    ["nginx:latest", '"latest" moves; pin a version or a digest'],
    ["ghcr.io/acme/app:main", '"main" moves; pin a version or a digest'],
    ["registry.local:5000/app", 'no tag: pin a version, e.g. "registry.local:5000/app:1.2.3"'],
    ["nginx@sha256:abc", "a digest is @sha256: and 64 hex characters"],
  ])("refuses %s", (image, problem) => {
    expect(imageProblem(image)).toBe(problem)
  })

  it.each(["nginx:1.27-alpine", "registry.local:5000/app:2.0", `nginx@sha256:${"a".repeat(64)}`, "lyfie/papyra:v1.1.1"])("accepts %s", (image) => {
    expect(imageProblem(image)).toBeUndefined()
  })
})

describe("a closed schema (§6)", () => {
  it("refuses fields it does not know, a fixed port and a name override", () => {
    const r = parseTemplate(`${base}staticPort = 3401\nname = "other"\nprivileged = true\n\n[catalog.extra]\nx = 1\n`)
    expect(errorsOf(r)).toEqual(
      expect.arrayContaining([
        "[services.web].name: not in a template: the deployed name is <app>-<service>",
        "[services.web].staticPort: a fixed host port is not allowed in a template",
        "[services.web].privileged: not a field of a template",
        "[catalog].extra: not a field of a template",
      ]),
    )
  })

  it("allows one public service, and an exposed path only beside one", () => {
    const two = parseTemplate(`${base}\n[services.api]\nimage = "a:1"\nport = 1\npublic = true\n`)
    expect(errorsOf(two)).toEqual(["[services]: only one service may be public (it owns the domain)"])
    const lone = parseTemplate(base.replace("public = true", 'expose = "/v1/api"'))
    expect(errorsOf(lone)).toEqual(["[services]: an exposed path needs a public service: it is mounted on that service's host"])
  })

  it("reports every problem at once, not the first", () => {
    const r = parseTemplate(`[app]\nscope = "x"\n\n[catalog]\ncategory = "game"\n\n[services.web]\nimage = "x"\n`)
    expect(errorsOf(r)).toEqual([
      "[app].scope: a template has no scope: the installer chooses it",
      "[app].name: required: the app's default name",
      "[catalog].title: required",
      "[catalog].tagline: required",
      '[catalog].category: one of starter, app, data, worker (got "game")',
      '[services.web].image: no tag: pin a version, e.g. "x:1.2.3"',
      "[services.web].port: required",
    ])
  })

  it("says so when the text is not TOML", () => {
    const r = parseTemplate("[app\nname=")
    expect(r.ok).toBe(false)
    expect(errorsOf(r)[0]).toMatch(/^flect\.toml: not valid TOML/)
  })
})

describe("volumes (RFC-0022)", () => {
  it("take a path, or a path with a size and an owner", () => {
    const r = parseTemplate(`${base}volumes = ["/data", { path = "/repos", size = "10GiB", owner = "1000:1000" }]\n`)
    expect(errorsOf(r)).toEqual([])
    expect(r.ok && r.template.services[0]!.volumes).toEqual([
      { path: "/data", sizeBytes: 1024 ** 3 },
      { path: "/repos", sizeBytes: 10 * 1024 ** 3, owner: { uid: 1000, gid: 1000 } },
    ])
  })

  it("refuse a size, an owner or a field they do not know, and a path twice", () => {
    const r = parseTemplate(`${base}volumes = [{ path = "/a", size = "lots" }, { path = "/b", owner = "root" }, { path = "/c", mode = "0777" }, "/d", "/d"]\n`)
    expect(errorsOf(r)).toEqual([
      '[services.web].volumes: size is bytes or a size such as "10GiB" (got "lots")',
      '[services.web].volumes: owner is "uid:gid", e.g. "1000:1000" (got "root")',
      "[services.web].volumes: not a field of a volume: mode",
      '[services.web].volumes: "/d" twice',
    ])
  })

  it("are absolute directories, not /", () => {
    const r = parseTemplate(`${base}volumes = ["data", "/"]\n`)
    expect(errorsOf(r)).toEqual([
      '[services.web].volumes: an absolute directory in the container, not "/" (got "data")',
      '[services.web].volumes: an absolute directory in the container, not "/" (got "/")',
    ])
  })

  it("make a service run as one instance", () => {
    const r = parseTemplate(`${base}replicas = 2\nvolumes = ["/data"]\n`)
    expect(errorsOf(r)).toEqual(["[services.web].replicas: a service with a volume runs as one instance"])
  })
})
