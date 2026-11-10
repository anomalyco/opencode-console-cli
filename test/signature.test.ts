import { afterEach, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Signature } from "../src/update/signature"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const release = path.join(import.meta.dir, "../.github/release")

// The release workflow signs and checks with these files; the updater trusts the copies in its source.
test("trusts the Linux release key the release workflow signs with", () => {
  expect(Signature.LINUX_SIGNING_KEY).toBe(readFileSync(path.join(release, "linux-signing.pub"), "utf8"))
})

test("holds macOS binaries to the code-signing requirement the release workflow checks", () => {
  expect(Signature.MACOS_REQUIREMENT).toBe(readFileSync(path.join(release, "macos-requirement.txt"), "utf8").trim())
})

// An ad-hoc signature, as `bun build --compile` leaves a binary, under the identifier `sign-macos.sh` gives it.
function adHoc() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-codesign-"))
  roots.push(root)
  const file = path.join(root, "opencode-console")
  copyFileSync("/usr/bin/true", file)
  const signed = Bun.spawnSync([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    "anomaly.opencode-console",
    file,
  ])
  if (signed.exitCode !== 0) throw new Error(signed.stderr.toString())
  return file
}

test.skipIf(process.platform !== "darwin")("never takes an ad-hoc signed macOS binary for Anomaly's", async () => {
  const file = adHoc()

  await expect(Signature.verifyMacos(file, 'identifier "anomaly.opencode-console"')).resolves.toBeUndefined()
  await expect(Signature.verifyMacos(file)).rejects.toThrow("isn't Anomaly's notarized Developer ID")
})

test.skipIf(process.platform !== "darwin")(
  "checks a stable macOS update's signature, and leaves a dev build's",
  async () => {
    const file = adHoc()

    await expect(Signature.check(file, { channel: "stable", platform: "darwin" })).rejects.toThrow()
    await expect(Signature.check(file, { channel: "dev", platform: "darwin" })).resolves.toBeUndefined()
  },
)

// Off Windows there's no Windows PowerShell to ask, which is the failure a broken one gives too.
test.skipIf(process.platform === "win32")(
  "refuses a stable Windows update whose Authenticode it can't check, and leaves a dev build's",
  async () => {
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), "opencode-console-authenticode-")),
      "opencode-console.exe",
    )
    roots.push(path.dirname(file))
    copyFileSync("/bin/sh", file)

    await expect(Signature.check(file, { channel: "stable", platform: "win32" })).rejects.toThrow("Authenticode")
    await expect(Signature.check(file, { channel: "dev", platform: "win32" })).resolves.toBeUndefined()
  },
)
