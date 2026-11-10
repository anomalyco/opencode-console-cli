#!/usr/bin/env bun

// Compiles the CLI into standalone executables with `bun build --compile`, every dependency bundled, one per platform
// the release service and npm (`@opencode/console-<target>`) ship:
//   bun script/compile.ts [target...]    e.g. linux-x64 darwin-arm64 windows-x64; no target: every target
// Output: dist-bin/console-<target>/bin/opencode-console (opencode-console.exe on Windows) and its package.json, which
// script/pack.ts packs. Each executable carries the single-file Pi extension and DeepSeek Harness plugin, which it writes
// beside itself for those agents to load, so every agent `setup` connects works from the binary alone.
// BUN_COMPILE_RELEASE (e.g. bun-v1.4.3) takes each target's Bun runtime from that GitHub release, checked against its
// SHASUMS256.txt, instead of letting Bun fetch it.
//
// Ported from anomalyco/browse cli/script/compile.ts (2b6194cf): the same targets, Bun runtime pinning and per-target
// package.json. Browse's patchright and extension-store plumbing is gone; the embedded extension and plugin are new.
import { $ } from "bun"
import { createHash } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { NativeArch } from "./native-arch"

const here = path.resolve(import.meta.dir, "..")
const outdir = path.join(here, "dist-bin")
const pkg = await Bun.file(path.join(here, "package.json")).json()
const version: string = pkg.version
const channel = version.includes("-dev.") ? "dev" : version.includes("-beta.") ? "beta" : "stable"

interface Target {
  readonly os: "linux" | "darwin" | "win32"
  readonly arch: "x64" | "arm64"
  readonly abi?: "musl"
  readonly avx2?: false
}

// The targets `CliInstall.hostTarget` picks from. Windows on ARM64 runs the x64 build.
export const targets: readonly Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

/** linux-x64-baseline-musl: the npm package's suffix, and Bun's target after `bun-`. */
export function targetName(item: Target) {
  return [item.os === "win32" ? "windows" : item.os, item.arch, item.avx2 === false ? "baseline" : undefined, item.abi]
    .filter(Boolean)
    .join("-")
}

if (import.meta.main) {
  const requested = process.argv.slice(2).map((arg) => arg.replace(/^bun-/, ""))
  const unknown = requested.filter((name) => !targets.some((item) => targetName(item) === name))
  if (unknown.length > 0)
    throw new Error(`Unknown target ${unknown.join(", ")}; one of ${targets.map(targetName).join(", ")}`)
  const selected = requested.length > 0 ? targets.filter((item) => requested.includes(targetName(item))) : targets

  // Pi supplies its own packages to extensions, so they stay out of the extension, as in the npm bundle.
  const piExtension = await single(path.join(here, "src/pi-extension.ts"), ["@earendil-works/*"])
  const dshPlugin = await single(path.join(here, "src/dsh-plugin.ts"), [])

  await rm(outdir, { recursive: true, force: true })
  for (const item of selected) {
    const target = targetName(item)
    const name = `console-${target}`
    const binary = path.join(outdir, name, "bin", item.os === "win32" ? "opencode-console.exe" : "opencode-console")
    const executablePath = await bunRuntime(item)
    const result = await Bun.build({
      entrypoints: [path.join(here, "src/index.ts")],
      tsconfig: path.join(here, "tsconfig.json"),
      format: "esm",
      minify: true,
      bytecode: true,
      sourcemap: "none",
      splitting: true,
      naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]" },
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
        target: compileTarget(`bun-${target}`),
        ...(executablePath ? { executablePath } : {}),
        outfile: binary,
        execArgv: [`--user-agent=opencode-console/${channel}/${version}/cli`, "--use-system-ca", "--"],
        windows: {},
      },
      define: {
        "globalThis.__OPENCODE_CONSOLE_TARGET__": JSON.stringify(target),
        "globalThis.__OPENCODE_CONSOLE_PI_EXTENSION__": JSON.stringify(piExtension),
        "globalThis.__OPENCODE_CONSOLE_DSH_PLUGIN__": JSON.stringify(dshPlugin),
      },
    })
    if (!result.success) throw new AggregateError(result.logs, `compile failed for ${target}`)
    await NativeArch.verify(binary, item.arch)

    await Bun.write(
      path.join(outdir, name, "package.json"),
      `${JSON.stringify(
        {
          name: `@opencode/${name}`,
          version,
          description: `The opencode-console binary for ${target}.`,
          license: "MIT",
          repository: {
            type: "git",
            url: "git+https://github.com/anomalyco/opencode-console-cli.git",
          },
          os: [item.os],
          cpu: [item.arch],
          ...(item.os === "linux" ? { libc: [item.abi ?? "glibc"] } : {}),
          publishConfig: { access: "public" },
        },
        null,
        2,
      )}\n`,
    )
    console.log(`${name}: ${path.relative(here, binary)} (${(Bun.file(binary).size / 1024 / 1024).toFixed(1)} MB)`)
  }
}

function compileTarget(value: string) {
  if (!isCompileTarget(value)) throw new Error(`Not a Bun compile target: ${value}`)
  return value
}

function isCompileTarget(value: string): value is Bun.Build.CompileTarget {
  return value.startsWith("bun-")
}

// One file with every dependency but `external` inlined, which an agent loads with Node from wherever it's written.
async function single(entry: string, external: string[]) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "esm",
    minify: true,
    splitting: false,
    external,
  })
  if (!result.success || result.outputs.length !== 1) throw new AggregateError(result.logs, `bundling ${entry} failed`)
  return result.outputs[0]!.text()
}

// Bun's runtime for a target from the pinned release, verified, as the executable to compile into (cross-compiling).
async function bunRuntime(item: Target) {
  const release = process.env.BUN_COMPILE_RELEASE?.trim()
  if (!release) return undefined
  const name = [
    "bun",
    item.os === "win32" ? "windows" : item.os,
    item.arch === "arm64" ? "aarch64" : item.arch,
    item.abi,
    item.avx2 === false ? "baseline" : undefined,
  ]
    .filter(Boolean)
    .join("-")
  const cache = path.join(here, ".cache", "bun", release)
  const executable = path.join(cache, name, item.os === "win32" ? "bun.exe" : "bun")
  if (await Bun.file(executable).exists()) return executable

  await mkdir(cache, { recursive: true })
  // Release downloads, not the API: no token and no API rate limit on shared runners.
  const base = `https://github.com/oven-sh/bun/releases/download/${encodeURIComponent(release)}`
  const [response, sums] = await Promise.all([fetch(`${base}/${name}.zip`), fetch(`${base}/SHASUMS256.txt`)])
  if (!response.ok) throw new Error(`Failed to download ${name} from Bun release ${release}: ${response.status}`)
  if (!sums.ok) throw new Error(`Failed to download Bun release ${release} checksums: ${sums.status}`)
  const expected = (await sums.text())
    .split("\n")
    .find((line) => line.trimEnd().endsWith(`  ${name}.zip`))
    ?.split(/\s+/)[0]
  if (!expected) throw new Error(`Missing checksum for ${name}.zip in Bun release ${release}`)
  // Streamed to disk: `Bun.write(file, response)` can hang if the Response is collected mid-download
  // (https://github.com/oven-sh/bun/issues/40278).
  const archive = path.join(cache, `${name}.zip`)
  const hash = createHash("sha256")
  const sink = Bun.file(archive).writer()
  for await (const chunk of response.body!) {
    hash.update(chunk)
    await sink.write(chunk)
  }
  await sink.end()
  if (hash.digest("hex") !== expected) {
    await rm(archive)
    throw new Error(`Checksum mismatch for ${name}.zip in Bun release ${release}`)
  }
  await $`unzip -oq ${archive} -d ${cache}`
  await rm(archive)
  return executable
}
