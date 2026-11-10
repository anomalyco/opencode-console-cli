#!/usr/bin/env bun

// Stamps a build's version into package.json before `build.ts` or `compile.ts` runs, so the CLI names itself with it
// in `x-opencode-plugin` and its User-Agent: `bun script/version.ts dev <run> [<attempt>]` writes and prints
// `<next patch>-dev.<run>[.<attempt>]`, as anomalyco/browse's `.github/release/plan-release.sh` does. The Console grades
// connector versions as releases (`Client.enforces`), so `0.1.8-dev.142` counts from the 0.1.7 floors on and precedes
// 0.1.8; OpenCode's `0.0.0-dev-142` form would read as older than every floor.

const stable = /^(\d+)\.(\d+)\.(\d+)$/

/** The dev build of the release after `current`: `0.1.7` on run 142 is `0.1.8-dev.142`, and on its second attempt `0.1.8-dev.142.2`. */
export const devVersion = (current: string, run: number, attempt = 1) => {
  const release = current.match(stable)
  if (release === null) throw new Error(`package.json has version ${current}, not a stable x.y.z`)
  if (!Number.isSafeInteger(run) || run < 1) throw new Error(`Not a run number: ${run}`)
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`Not a run attempt: ${attempt}`)
  const version = `${release[1]}.${release[2]}.${Number(release[3]) + 1}-dev.${run}`
  return attempt === 1 ? version : `${version}.${attempt}`
}

/** A version the release workflow publishes: a release, or a dev or beta build of one with its run. */
const releasable = /^\d+\.\d+\.\d+(?:-(?:dev|beta)\.\d+(?:\.\d+)?)?$/

/** `set <version>`: the version `.github/release/plan-release.sh` chose, refused unless the workflow could publish it. */
export const setVersion = (version: string) => {
  if (!releasable.test(version)) throw new Error(`Not a version the release workflow publishes: ${version}`)
  return version
}

if (import.meta.main) {
  const [mode, value, attempt] = process.argv.slice(2)
  if ((mode !== "dev" && mode !== "set") || value === undefined)
    throw new Error("Usage: bun script/version.ts dev <run> [<attempt>] | set <version>")
  const file = Bun.file(new URL("../package.json", import.meta.url))
  const manifest = await file.json()
  manifest.version =
    mode === "set"
      ? setVersion(value)
      : devVersion(manifest.version, Number(value), attempt === undefined ? 1 : Number(attempt))
  await Bun.write(file, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(manifest.version)
}
