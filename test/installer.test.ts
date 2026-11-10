import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CliInstall } from "../src/install"
import { Signature } from "../src/update/signature"
import { archive, removeReleases, serveRelease } from "./support/release"

// The installer `curl | sh` runs (./install), run as a process against a stand-in release service over HTTP.
const cleanup: Array<() => unknown> = []
afterEach(() => {
  cleanup.splice(0).forEach((item) => item())
  removeReleases()
})
const installer = path.join(import.meta.dir, "../install")
const release = path.join(import.meta.dir, "../.github/release")

// A dev build, unsigned as dev builds are, that passes its self-test and says what setup was handed. Signed builds
// are checked against Anomaly's real keys, which only the VM end-to-end run can stand in for.
const binary = `#!/bin/sh
[ "$1" = self-test ] && { echo "opencode-console 0.1.9-dev.2 self-test ok"; exit 0; }
echo "ran $* with $OPENCODE_CONSOLE_RELEASE_SHA256"
`

function serve(bytes: { readonly bytes: Buffer; readonly sha256: string }, size?: number) {
  const served = serveRelease(
    { dev: { version: "0.1.9-dev.2", ...bytes, ...(size === undefined ? {} : { size }) } },
    CliInstall.serviceTarget(CliInstall.hostTarget() ?? "linux-x64"),
  )
  cleanup.push(served.stop)
  return served
}

async function install(args: string[], service: string) {
  const child = Bun.spawn(["sh", installer, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENCODE_CONSOLE_RELEASE_SERVICE: service },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

test("trusts the release key and macOS requirement the release workflow signs with", () => {
  const text = readFileSync(installer, "utf8")
  expect(text).toContain(`LINUX_SIGNING_KEY='${readFileSync(path.join(release, "linux-signing.pub"), "utf8").trim()}'`)
  expect(text).toContain(`MACOS_REQUIREMENT='${Signature.MACOS_REQUIREMENT}'`)
  for (const file of [path.join(import.meta.dir, "../install.ps1"), path.join(release, "verify-authenticode.ps1")])
    expect(readFileSync(file, "utf8")).toContain(`"${Signature.WINDOWS_SIGNER}"`)
})

test("downloads the channel's binary for this computer, checks it, and hands setup over to it", async () => {
  const bytes = archive(binary, "unsigned")
  const served = serve(bytes)

  const result = await install(["--channel", "dev", "setup", "claude-code"], served.service)

  expect(result.code).toBe(0)
  expect(result.stdout).toContain(`ran setup claude-code with ${bytes.sha256}`)
})

test("refuses a download whose size isn't the manifest's, running nothing", async () => {
  const bytes = archive(binary, "unsigned")
  const served = serve(bytes, bytes.bytes.length + 1)

  const result = await install(["--channel", "dev", "setup", "claude-code"], served.service)

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("size mismatch")
  expect(result.stdout).not.toContain("ran setup")
})

test("refuses a download whose SHA-256 isn't the manifest's, running nothing", async () => {
  const served = serve({ bytes: archive(binary, "unsigned").bytes, sha256: "0".repeat(64) })

  const result = await install(["--channel", "dev", "setup", "claude-code"], served.service)

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("checksum mismatch")
  expect(result.stdout).not.toContain("ran setup")
})

test("takes updates from a stand-in on this computer for dev builds only", async () => {
  const served = serve(archive(binary, "unsigned"))

  const result = await install(["setup", "claude-code"], served.service)

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("serves dev builds only")
})

test("never downloads from a release service other than Anomaly's", async () => {
  const result = await install(["--channel", "dev", "setup", "claude-code"], "https://evil.example/release")

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("must be https://anoma.ly/release")
})

test("refuses a pinned version that isn't a release version, before downloading anything", async () => {
  const result = await install(["--version", "0.1.8;id", "setup", "claude-code"], "https://anoma.ly/release")

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("isn't a release version")
})
