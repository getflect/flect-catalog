import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { builtinCatalog } from "./builtin.js"

describe("the built-in catalog", () => {
  it("is what examples/ says: regenerate with `npm run gen:builtin (in checker/)`", async () => {
    const script = join(import.meta.dirname, "../scripts/gen-builtin.mjs")
    const { builtinSource } = (await import(script as string)) as { builtinSource: () => string }
    expect(readFileSync(join(import.meta.dirname, "builtin.generated.ts"), "utf8")).toBe(builtinSource())
  })

  it("lists every template in index order, each valid", () => {
    const apps = builtinCatalog()
    expect(apps.map((a) => a.id)).toEqual(["static", "papyra", "n8n"])
    expect(apps.find((a) => a.id === "papyra")!.template.services[0]!.image).toBe("lyfie/papyra:v1.1.1")
  })
})
