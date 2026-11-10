import { afterEach, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { CliInstall } from "../src/install"
import { AutoUpdate } from "../src/update/auto-update"
import { ReleaseService } from "../src/update/release-service"
import { SelfUpdate } from "../src/update/self-update"
import { removeStores, temporaryStore } from "./support/console"
import { Signature } from "../src/update/signature"
import {
  archive,
  installRelease,
  releaseKeys,
  removeReleases,
  script,
  serveRelease,
  signatureOf,
} from "./support/release"

// Each update runs against a stand-in release service speaking the release protocol over real HTTP, and runs the downloaded
// build's real `self-test` (a shell script standing in for the binary). Only the new build's `sync --refresh-agents`
// is stood in for; cli.test.ts and the compiled binary's end-to-end run cover that.
const cleanup: Array<() => unknown> = []
afterEach(() => {
  cleanup.splice(0).forEach((item) => item())
  removeStores()
  removeReleases()
})

function release(channels: Parameters<typeof serveRelease>[0]) {
  const served = serveRelease(channels)
  cleanup.push(served.stop)
  return served
}

function update(store: ReturnType<typeof temporaryStore>, service: string, options: SelfUpdate.Options = {}) {
  const refreshed: string[][] = []
  return SelfUpdate.run(store, {
    // The service stands in on this computer, which only a dev build follows.
    version: "0.1.9-dev.1",
    // Linux's signature check, against the test release key.
    platform: "linux",
    verify: Signature.verifier(releaseKeys),
    env: { OPENCODE_CONSOLE_RELEASE_SERVICE: service },
    refresh: (command) => {
      refreshed.push([...command])
      return true
    },
    ...options,
  }).then((outcome) => ({ outcome, refreshed }))
}

test("installs the channel's current build, keeps the one it replaced, and has the new one refresh the agents", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const next = archive(script("0.1.9"))
  const served = release({ stable: { version: "0.1.9", ...next } })

  const { outcome, refreshed } = await update(store, served.service)

  expect(outcome).toEqual({ status: "installed", from: "0.1.8", to: "0.1.9", refreshed: true })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.9"))
  expect(readFileSync(path.join(CliInstall.previousDirectory(store), "opencode-console"), "utf8")).toBe(script("0.1.8"))
  expect(CliInstall.receipt(store)).toMatchObject({ version: "0.1.9", sha256: next.sha256 })
  expect(refreshed).toEqual([[live]])
  expect(served.requests.map((request) => request.headers.get("user-agent"))).toEqual([
    "opencode-console/stable/0.1.8/cli",
    "opencode-console/stable/0.1.8/cli",
  ])
})

test("never runs or installs a stable build Anomaly's key didn't sign, and backs the next attempt off", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const ran = path.join(store.data, "ran")
  const served = release({ stable: { version: "0.1.9", ...archive(script("0.1.9", "passes", ran), "unsigned") } })

  const { outcome } = await update(store, served.service)

  expect(outcome).toEqual({ status: "failed", message: "the update isn't signed by Anomaly's release key" })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
  expect(existsSync(ran)).toBe(false)
  expect(AutoUpdate.read(store).lastError).toMatchObject({ version: "0.1.9", attempts: 1 })
})

test("refuses a build signed by another key", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const other = generateKeyPairSync("ed25519").privateKey
  const binary = script("0.1.9")
  const served = release({ stable: { version: "0.1.9", ...archive(binary, signatureOf(binary, other)) } })

  expect((await update(store, served.service)).outcome).toEqual({
    status: "failed",
    message: "the update's signature isn't Anomaly's release key's",
  })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

test("refuses a binary carrying another build's signature", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const served = release({ stable: { version: "0.1.9", ...archive(script("0.1.9"), signatureOf(script("0.1.7"))) } })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "failed" })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

// Windows loads a DLL from beside an executable before System32's, so a genuine signed binary next to a planted one
// would run it in its self-test.
test("takes only the binary and its signature out of a release, nothing planted beside them", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const binary = `#!/bin/sh
[ -e "$(dirname "$0")/VERSION.dll" ] && exit 1
${script("0.1.9").replace("#!/bin/sh\n", "")}`
  const served = release({
    stable: { version: "0.1.9", ...archive(binary, signatureOf(binary), { "bin/VERSION.dll": "x" }) },
  })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.9" })
  expect(readFileSync(live, "utf8")).toBe(binary)
})

test("refuses a release whose binary is a link to something else", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-link-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, "package", "bin"), { recursive: true })
  symlinkSync("/bin/sh", path.join(root, "package", "bin", "opencode-console"))
  Bun.spawnSync(["tar", "-czf", path.join(root, "release.tgz"), "-C", root, "package"])
  const bytes = readFileSync(path.join(root, "release.tgz"))
  const served = release({
    stable: { version: "0.1.9", bytes, sha256: createHash("sha256").update(bytes).digest("hex") },
  })

  expect((await update(store, served.service)).outcome).toEqual({
    status: "failed",
    message: expect.stringContaining("isn't a file"),
  })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

// A release during a key rotation carries the old key's signature and the new one's.
test("takes a build carrying several signatures when one is by the release key", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  const binary = script("0.1.9")
  const other = generateKeyPairSync("ed25519").privateKey
  const served = release({
    stable: { version: "0.1.9", ...archive(binary, Buffer.concat([signatureOf(binary, other), signatureOf(binary)])) },
  })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.9" })
})

// Dev builds aren't signed; the dev channel is where releases are rehearsed.
test("takes an unsigned build on the dev channel", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.9-dev.1" })
  const served = release({ dev: { version: "0.1.9-dev.2", ...archive(script("0.1.9-dev.2"), "unsigned") } })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.9-dev.2" })
})

test("asks again with the manifest's ETag and downloads nothing when it hasn't changed", async () => {
  const store = temporaryStore()
  const current = archive(script("0.1.8"))
  installRelease(store, { version: "0.1.8", sha256: current.sha256 })
  const served = release({ stable: { version: "0.1.8", ...current } })
  await update(store, served.service)

  const { outcome } = await update(store, served.service)

  expect(outcome).toEqual({ status: "up-to-date", version: "0.1.8" })
  expect(served.requests.at(-1)?.headers.get("if-none-match")).toBe(AutoUpdate.read(store).etag ?? "missing")
  expect(served.requests.filter((request) => request.path.includes("/files/"))).toEqual([])
})

// The install's rollout bucket is drawn once and kept in the data directory; 99 is past every partial rollout.
test("waits out a partial rollout, but takes a required release at once", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  writeFileSync(path.join(store.data, "rollout-bucket"), "99\n")
  const next = archive(script("0.1.9"))
  const served = release({ stable: { version: "0.1.9", ...next, rollout: 50 } })

  expect((await update(store, served.service)).outcome).toEqual({
    status: "up-to-date",
    version: "0.1.8",
    detail: "0.1.9 is still rolling out",
  })
  served.publish("stable", { version: "0.1.9", ...next, rollout: 50, required: true })
  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.9" })
})

test("refuses a download whose SHA-256 isn't the manifest's, leaving the installed build", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const next = archive(script("0.1.9"))
  const served = release({ stable: { version: "0.1.9", bytes: next.bytes, sha256: "0".repeat(63) + "1" } })

  const { outcome, refreshed } = await update(store, served.service)

  expect(outcome).toMatchObject({ status: "failed" })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
  expect(refreshed).toEqual([])
})

test("refuses a download whose size isn't the manifest's", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const next = archive(script("0.1.9"))
  const served = release({ stable: { version: "0.1.9", ...next, size: next.bytes.length + 1 } })

  const { outcome } = await update(store, served.service)

  expect(outcome).toEqual({ status: "failed", message: expect.stringContaining("size mismatch") })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

test("keeps the installed build when the new one fails its self-test, and backs the next attempt off", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const served = release({ stable: { version: "0.1.9", ...archive(script("0.1.9", "fails")) } })

  const { outcome, refreshed } = await update(store, served.service, { now: () => 1_000 })

  expect(outcome).toEqual({
    status: "failed",
    message: "0.1.9 failed its self-test, so 0.1.8 stays installed",
  })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
  expect(CliInstall.receipt(store)?.version).toBe("0.1.8")
  expect(existsSync(CliInstall.previousDirectory(store))).toBe(false)
  expect(readdirSync(CliInstall.directory(store)).toSorted()).toEqual(["install.json", "opencode-console"])
  expect(refreshed).toEqual([])
  expect(AutoUpdate.read(store).lastError).toMatchObject({ version: "0.1.9", attempts: 1, at: 1_000 })
})

test("counts each failed attempt at the same build", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  const served = release({ stable: { version: "0.1.9", ...archive(script("0.1.9", "fails")) } })

  await update(store, served.service)
  await update(store, served.service)

  expect(AutoUpdate.read(store).lastError?.attempts).toBe(2)
})

test("doesn't install again a build that was rolled back after crashing", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const next = archive(script("0.1.9"))
  AutoUpdate.update(store, () => ({ blocked: [{ version: "0.1.9", sha256: next.sha256 }] }))
  const served = release({ stable: { version: "0.1.9", ...next } })

  const { outcome } = await update(store, served.service)

  expect(outcome).toEqual({ status: "blocked", version: "0.1.9" })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

test("installs a rolled-back build when the member runs update, and stops blocking it", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  const next = archive(script("0.1.9"))
  AutoUpdate.update(store, () => ({ blocked: [{ version: "0.1.9", sha256: next.sha256 }] }))
  const served = release({ stable: { version: "0.1.9", ...next } })

  expect((await update(store, served.service, { force: true })).outcome).toMatchObject({ status: "installed" })
  expect(AutoUpdate.read(store).blocked).toBeUndefined()
})

test("installs a different build of a blocked version, such as a rebuilt fix", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  AutoUpdate.update(store, () => ({ blocked: [{ version: "0.1.9", sha256: "f".repeat(64) }] }))
  const served = release({ stable: { version: "0.1.9", ...archive(script("0.1.9")) } })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.9" })
})

// The protocol never orders versions, so a promote back to an earlier build moves every install to it.
test("follows the channel back to an earlier build", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.9", sha256: "a".repeat(64) })
  const served = release({ stable: { version: "0.1.8", ...archive(script("0.1.8")) } })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.8" })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

test("follows the dev channel for a dev build", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8-dev.141" })
  const served = release({
    stable: { version: "0.1.7", ...archive(script("0.1.7")) },
    dev: { version: "0.1.8-dev.142", ...archive(script("0.1.8-dev.142")) },
  })

  expect((await update(store, served.service)).outcome).toMatchObject({ status: "installed", to: "0.1.8-dev.142" })
  expect(served.requests[0]?.path).toBe("/release/opencode-console/cli/dev.json")
})

test("only says what it would install when checking", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const served = release({ stable: { version: "0.1.9", ...archive(script("0.1.9")) } })

  expect((await update(store, served.service, { check: true })).outcome).toEqual({
    status: "available",
    from: "0.1.8",
    to: "0.1.9",
  })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

test("records a release service it can't reach, leaving the install as it was", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })

  const { outcome } = await update(store, "http://127.0.0.1:9/release")

  expect(outcome).toMatchObject({ status: "failed" })
  expect(AutoUpdate.read(store).failed).toBeString()
  expect(AutoUpdate.read(store).lastError).toBeUndefined()
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

test("never downloads from a host other than the release service's", async () => {
  const store = temporaryStore()
  const live = installRelease(store, { version: "0.1.8" })
  const next = archive(script("0.1.9"))
  const served = release({ stable: { version: "0.1.9", ...next, url: "//127.0.0.2/opencode-console.tgz" } })

  const { outcome } = await update(store, served.service)

  expect(outcome).toEqual({ status: "failed", message: "unexpected download URL //127.0.0.2/opencode-console.tgz" })
  expect(readFileSync(live, "utf8")).toBe(script("0.1.8"))
})

// A project's environment reaches hooks, so only a dev build follows a release service on this computer.
test("takes a release service on this computer only in a dev build", () => {
  expect(
    ReleaseService.releaseService({ OPENCODE_CONSOLE_RELEASE_SERVICE: "http://127.0.0.1:8080/release" }, "0.1.8"),
  ).toBe("https://anoma.ly/release")
  expect(
    ReleaseService.releaseService(
      { OPENCODE_CONSOLE_RELEASE_SERVICE: "http://127.0.0.1:8080/release" },
      "0.1.9-beta.1",
    ),
  ).toBe("https://anoma.ly/release")
  expect(
    ReleaseService.releaseService(
      { OPENCODE_CONSOLE_RELEASE_SERVICE: "http://127.0.0.1:8080/release" },
      "0.1.9-dev.142",
    ),
  ).toBe("http://127.0.0.1:8080/release")
})

test("ignores a release service that isn't Anomaly's in any build", () => {
  expect(
    ReleaseService.releaseService({ OPENCODE_CONSOLE_RELEASE_SERVICE: "https://evil.example/release" }, "0.1.8"),
  ).toBe("https://anoma.ly/release")
  expect(
    ReleaseService.releaseService(
      { OPENCODE_CONSOLE_RELEASE_SERVICE: "https://evil.example/release" },
      "0.1.9-dev.142",
    ),
  ).toBe("https://anoma.ly/release")
})

test("takes an npm registry on this computer only in a dev build", () => {
  expect(SelfUpdate.npmRegistry({ OPENCODE_CONSOLE_NPM_REGISTRY: "http://127.0.0.1:8080" }, "0.1.8")).toBe(
    "https://registry.npmjs.org",
  )
  expect(SelfUpdate.npmRegistry({ OPENCODE_CONSOLE_NPM_REGISTRY: "http://127.0.0.1:8080" }, "0.1.9-dev.142")).toBe(
    "http://127.0.0.1:8080",
  )
})

test("ignores an npm registry that isn't npm's in any build", () => {
  expect(SelfUpdate.npmRegistry({ OPENCODE_CONSOLE_NPM_REGISTRY: "https://evil.example" }, "0.1.8")).toBe(
    "https://registry.npmjs.org",
  )
  expect(SelfUpdate.npmRegistry({ OPENCODE_CONSOLE_NPM_REGISTRY: "https://evil.example" }, "0.1.9-dev.142")).toBe(
    "https://registry.npmjs.org",
  )
})

test("asks Anomaly's release service, not one on this computer, when a stable build updates", async () => {
  const store = temporaryStore()
  installRelease(store, { version: "0.1.8" })
  const asked: string[] = []

  await SelfUpdate.run(store, {
    version: "0.1.8",
    env: { OPENCODE_CONSOLE_RELEASE_SERVICE: "http://127.0.0.1:9/release" },
    fetch: Object.assign(
      async (input: string | URL | Request) => {
        asked.push(String(input))
        return new Response("not found", { status: 404 })
      },
      { preconnect: fetch.preconnect },
    ),
  })

  expect(asked).toEqual(["https://anoma.ly/release/opencode-console/cli/stable.json"])
})

test("asks npm itself for the Node bundle, whatever registry the environment names", async () => {
  const store = temporaryStore()
  const cli = CliInstall.directory(store)
  mkdirSync(cli, { recursive: true })
  writeFileSync(
    CliInstall.receiptFile(cli),
    JSON.stringify({ method: "npm-bundle", version: "0.1.8", channel: "stable", node: process.execPath }),
  )
  const asked: string[] = []

  await SelfUpdate.run(store, {
    env: { OPENCODE_CONSOLE_NPM_REGISTRY: "https://evil.example" },
    fetch: Object.assign(
      async (input: string | URL | Request) => {
        asked.push(String(input))
        return new Response("not found", { status: 404 })
      },
      { preconnect: fetch.preconnect },
    ),
  })

  expect(asked).toEqual(["https://registry.npmjs.org/@opencode%2fconsole"])
})

test("does nothing for a copy setup didn't install", async () => {
  const store = temporaryStore()
  expect((await update(store, "http://127.0.0.1:9/release")).outcome).toEqual({ status: "unmanaged" })
})

test("hands setup the channel's binary for this computer, verified and self-tested", async () => {
  const next = archive(script("0.1.9-dev.2"))
  const served = release({ dev: { version: "0.1.9-dev.2", ...next } })

  const staged = await SelfUpdate.stageForSetup({
    version: "0.1.9-dev.1",
    target: "linux-x64",
    env: { OPENCODE_CONSOLE_RELEASE_SERVICE: served.service },
    verify: Signature.verifier(releaseKeys),
  })
  cleanup.push(() => staged?.cleanup())

  expect(staged && { version: staged.version, sha256: staged.sha256 }).toEqual({
    version: "0.1.9-dev.2",
    sha256: next.sha256,
  })
  expect(readFileSync(staged!.binary, "utf8")).toBe(script("0.1.9-dev.2"))
})

test("leaves setup to the Node bundle where the release service has no build for this computer", async () => {
  const served = release({ dev: { version: "0.1.9-dev.2", ...archive(script("0.1.9-dev.2")) } })

  const staged = await SelfUpdate.stageForSetup({
    version: "0.1.9-dev.1",
    target: "linux-riscv64",
    env: { OPENCODE_CONSOLE_RELEASE_SERVICE: served.service },
  })

  expect(staged).toBeUndefined()
})

test("leaves setup to the Node bundle while the channel has no release", async () => {
  const served = release({})

  expect(
    await SelfUpdate.stageForSetup({
      version: "0.1.9-dev.1",
      target: "linux-x64",
      env: { OPENCODE_CONSOLE_RELEASE_SERVICE: served.service },
    }),
  ).toBeUndefined()
})

test("orders npm versions as npm does: dev below beta below the release, then by run", () => {
  expect(
    ["0.1.9", "0.1.9-dev.3", "0.1.8", "0.1.9-beta.1", "0.1.9-dev.12", "0.1.9-dev.12.2"].toSorted(
      SelfUpdate.compareVersions,
    ),
  ).toEqual(["0.1.8", "0.1.9-dev.3", "0.1.9-dev.12", "0.1.9-dev.12.2", "0.1.9-beta.1", "0.1.9"])
})

// The Node bundle, where no binary fits: npm's dist-tag, the tarball's SHA-512, then the same self-test and swap.
function serveNpm(versions: Record<string, Buffer>, tags: Record<string, string>, integrity?: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/@opencode%2fconsole")
        return Response.json({
          "dist-tags": tags,
          versions: Object.fromEntries(
            Object.entries(versions).map(([version, bytes]) => [
              version,
              {
                dist: {
                  tarball: `${url.origin}/console-${version}.tgz`,
                  integrity: integrity ?? `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                },
              },
            ]),
          ),
        })
      const version = url.pathname.match(/^\/console-(.+)\.tgz$/)?.[1]
      const bytes = version === undefined ? undefined : versions[version]
      return bytes ? new Response(new Uint8Array(bytes)) : new Response("not found", { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  return `http://127.0.0.1:${server.port}`
}

test("updates an npm bundle install to a newer dist-tag, verified by npm's SHA-512", async () => {
  const store = temporaryStore()
  const cli = CliInstall.directory(store)
  mkdirSync(cli, { recursive: true })
  writeFileSync(path.join(cli, "index.js"), "old")
  writeFileSync(
    CliInstall.receiptFile(cli),
    JSON.stringify({ method: "npm-bundle", version: "0.1.8", channel: "stable", node: process.execPath }),
  )
  const registry = serveNpm({ "0.1.9": tarball({ "index.js": "new" }) }, { latest: "0.1.9" })
  const tested: string[][] = []

  const { outcome } = await update(store, "http://127.0.0.1:9/release", {
    env: { OPENCODE_CONSOLE_NPM_REGISTRY: registry },
    selfTest: async (command) => {
      tested.push([...command])
      return readFileSync(command[1]!, "utf8") === "new"
    },
  })

  expect(outcome).toMatchObject({ status: "installed", from: "0.1.8", to: "0.1.9" })
  expect(readFileSync(path.join(cli, "index.js"), "utf8")).toBe("new")
  expect(CliInstall.receipt(store)?.version).toBe("0.1.9")
  expect(readFileSync(path.join(CliInstall.previousDirectory(store), "index.js"), "utf8")).toBe("old")
  expect(tested).toHaveLength(1)
})

test("refuses an npm tarball whose SHA-512 isn't the registry's", async () => {
  const store = temporaryStore()
  const cli = CliInstall.directory(store)
  mkdirSync(cli, { recursive: true })
  writeFileSync(path.join(cli, "index.js"), "old")
  writeFileSync(
    CliInstall.receiptFile(cli),
    JSON.stringify({ method: "npm-bundle", version: "0.1.8", channel: "stable", node: process.execPath }),
  )
  const registry = serveNpm({ "0.1.9": tarball({ "index.js": "new" }) }, { latest: "0.1.9" }, "sha512-AAAA")

  const { outcome } = await update(store, "http://127.0.0.1:9/release", {
    env: { OPENCODE_CONSOLE_NPM_REGISTRY: registry },
    selfTest: async () => true,
  })

  expect(outcome).toEqual({ status: "failed", message: "integrity mismatch for @opencode/console@0.1.9" })
  expect(readFileSync(path.join(cli, "index.js"), "utf8")).toBe("old")
})

function tarball(files: Record<string, string>) {
  const root = path.join(temporaryStore().data, "npm")
  mkdirSync(path.join(root, "package"), { recursive: true })
  Object.entries(files).forEach(([name, text]) => writeFileSync(path.join(root, "package", name), text))
  const file = path.join(root, "package.tgz")
  Bun.spawnSync(["tar", "-czf", file, "-C", root, "package"])
  return readFileSync(file)
}
