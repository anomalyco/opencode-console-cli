#!/usr/bin/env bun

// Packs every compiled binary in dist-bin/ (script/compile.ts) into its npm tarball, opencode-console-<target>-<version>.tgz,
// and checks it (checkBinaryTarball below):
//   bun script/pack.ts [--out <dir>]    default dist-bin/npm
// npm pack gives every entry a fixed mtime and normalizes modes, so the binary is made executable first: GitHub artifact
// downloads lose execute bits, and the install script runs package/bin/opencode-console straight from the tarball.
// Ported from anomalyco/browse cli/script/pack.ts (2b6194cf); browse's scripts/check-artifacts.ts checkBinaryTarball is
// inlined here because only the binary tarball applies.
import { $ } from "bun"
import { chmod, cp, mkdir, readdir, rm, utimes } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

const here = path.resolve(import.meta.dir, "..")
const dist = path.join(here, "dist-bin")
const { values } = parseArgs({ options: { out: { type: "string" } } })
const out = path.resolve(values.out ?? path.join(dist, "npm"))
const version: string = (await Bun.file(path.join(here, "package.json")).json()).version
const epoch = new Date("1980-01-01T00:00:00Z")

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const names = (await readdir(dist)).filter((name) => name.startsWith("console-")).sort()
if (names.length === 0) throw new Error(`No binaries in ${dist}; run script/compile.ts first`)

const problems: string[] = []
for (const name of names) {
  const directory = path.join(dist, name)
  const target = name.slice("console-".length)
  const binary = path.join(
    directory,
    "bin",
    target.startsWith("windows-") ? "opencode-console.exe" : "opencode-console",
  )
  const pkg = await Bun.file(path.join(directory, "package.json")).json()
  if (pkg.version !== version) throw new Error(`${name} is version ${pkg.version}, expected ${version}`)
  if (Bun.file(binary).size === 0) throw new Error(`Missing binary ${binary}`)
  await chmod(binary, 0o755)
  await utimes(binary, epoch, epoch)
  await cp(path.join(here, "LICENSE"), path.join(directory, "LICENSE"))
  const packed: { filename: string }[] = JSON.parse(
    await $`npm pack --json --ignore-scripts --pack-destination ${out}`.cwd(directory).quiet().text(),
  )
  const tarball = path.join(out, packed[0].filename.replace(/^@/, "").replace("/", "-"))
  problems.push(...(await checkBinaryTarball(tarball, version, target)))
  console.log(`${path.basename(tarball)} (${(Bun.file(tarball).size / 1024 / 1024).toFixed(1)} MB)`)
}
if (problems.length > 0) {
  problems.forEach((problem) => console.error(`✗ ${problem}`))
  process.exit(1)
}

/**
 * A platform package (script/compile.ts): @opencode/console-<target> at the release version with exactly
 * package/bin/opencode-console (opencode-console.exe on Windows, mode 755), package.json and LICENSE, the os/cpu/libc
 * npm installs by, and no install scripts. Linux tarballs may also carry the binary's signature, which release signing
 * adds later. The install script downloads the package from npm and runs package/bin/opencode-console.
 */
async function checkBinaryTarball(tarball: string, version: string, target: string): Promise<string[]> {
  const label = path.basename(tarball)
  const [os, arch, ...rest] = target.split("-")
  const musl = rest.includes("musl")
  const executable = `package/bin/${os === "windows" ? "opencode-console.exe" : "opencode-console"}`
  const problems: string[] = []
  const listing = (await $`tar -tvzf ${tarball}`.quiet().text()).split("\n").filter(Boolean)
  const entries = new Map(listing.map((line) => [line.slice(line.lastIndexOf(" ") + 1), line.slice(0, 10)]))
  const expected = ["package/package.json", "package/LICENSE", executable]
  const allowed = os === "linux" ? [...expected, "package/bin/opencode-console.sig"] : expected
  for (const name of entries.keys()) if (!allowed.includes(name)) problems.push(`${label}: unexpected entry ${name}`)
  for (const name of expected) if (!entries.has(name)) problems.push(`${label}: missing ${name}`)
  if (entries.has(executable) && entries.get(executable) !== "-rwxr-xr-x")
    problems.push(`${label}: ${executable} has mode ${entries.get(executable)}, expected -rwxr-xr-x`)
  if (problems.length > 0) return problems
  const pkg: {
    name?: string
    version?: string
    os?: string[]
    cpu?: string[]
    libc?: string[]
    bin?: unknown
    scripts?: Record<string, string>
    publishConfig?: Record<string, unknown>
  } = JSON.parse(await $`tar -xzOf ${tarball} package/package.json`.quiet().text())
  const want = {
    name: `@opencode/console-${target}`,
    version,
    os: [os === "windows" ? "win32" : os],
    cpu: [arch],
    libc: os === "linux" ? [musl ? "musl" : "glibc"] : undefined,
  }
  for (const key of ["name", "version", "os", "cpu", "libc"] as const)
    if (JSON.stringify(pkg[key]) !== JSON.stringify(want[key]))
      problems.push(`${label}: ${key} is ${JSON.stringify(pkg[key])}, expected ${JSON.stringify(want[key])}`)
  if (pkg.scripts && Object.keys(pkg.scripts).length > 0)
    problems.push(`${label}: has scripts; installs must not run code`)
  if (pkg.bin !== undefined) problems.push(`${label}: has bin; the install script runs package/bin directly`)
  if (Object.keys(pkg.publishConfig ?? {}).some((key) => key !== "access"))
    problems.push(`${label}: sets publishConfig beyond access`)
  const head = Buffer.from(await $`tar -xzOf ${tarball} ${executable} | head -c 4`.quiet().nothrow().arrayBuffer())
  const magic = os === "windows" ? "4d5a" : os === "darwin" ? "cffaedfe" : "7f454c46"
  if (!head.toString("hex").startsWith(magic)) problems.push(`${label}: ${executable} isn't a ${os} executable`)
  return problems
}
