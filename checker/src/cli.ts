#!/usr/bin/env node
/**
 * flect-catalog check [path] [--fetch]
 *
 * Checks a catalog (a directory with flect-catalog.toml), a template directory
 * or a template file against RFC-0021. Exit 1 on any error; warnings do not fail.
 */

import { check, formatReport, ok } from "./check.js"

const USAGE = "usage: flect-catalog check [path] [--fetch]"

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd !== "check") {
    console.error(USAGE)
    return 2
  }
  const fetchRemote = rest.includes("--fetch")
  const paths = rest.filter((a) => !a.startsWith("--"))
  if (paths.length > 1) {
    console.error(USAGE)
    return 2
  }
  const report = await check(paths[0] ?? ".", { fetch: fetchRemote ? fetch : false })
  console.log(formatReport(report))
  return ok(report) ? 0 : 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  },
)
