# @getflect/catalog

The rules of this catalog (Flect RFC-0021, RFC-0022 for volumes): parse and
validate a template `flect.toml` and the catalog's `flect-catalog.toml`. CI
runs it on every pull request; the Flect broker and dashboard use the same
code (pinned to a commit of this directory), so a template means the same
thing everywhere.

It is not published to npm. It ships TypeScript source; `tsx` runs it here.

## Check a catalog or a template

```bash
cd checker && npm ci
npm run check -- ..                   # this catalog
npm run check -- ../apps/papyra       # one template
npm run check -- .. --fetch           # also fetch github: sources
```

Every problem is listed, not just the first; the exit status is 1 on any
error. Warnings (an unused input, for example) do not fail the check.

## Changing the rules

A change here reaches CI once it is on `main` (pull requests are checked with
`main`'s rules, not their own). The platform picks it up when Flect moves its
pin to the new commit, so the broker and CI agree.

`examples/` is the test fixture and Flect's built-in copy of the catalog. After
refreshing it from the repo root, run `npm run gen:builtin`.

## In code

```ts
import { parseTemplate, parseCatalogIndex, parseSource } from "@getflect/catalog"

const r = parseTemplate(text)
if (!r.ok) for (const e of r.errors) console.error(`${e.where}: ${e.message}`)
```
