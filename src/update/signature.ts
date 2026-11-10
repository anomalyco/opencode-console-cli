export * as Signature from "./signature"

// Whether a downloaded release binary is one Anomaly signed, checked after its size and SHA-256 match the release
// service's manifest and before anything runs it (its self-test is the first run). Ported from anomalyco/hex
// (a65a5e37): `src/updater/macos.rs`'s code-signing requirement and `src/updater/linux.rs`'s ed25519 check, with the
// message and key layout of `.github/release/sign-linux.sh`.
//
//   macOS    `codesign --verify --strict -R=<requirement>`: a Developer ID from Anomaly's team, identified as
//            `anomaly.opencode-console`, and notarized
//   Linux    `package/bin/opencode-console.sig`: ed25519 by Anomaly's release key over the binary's SHA-256
//   Windows  Authenticode: Valid, by Anomaly's Artifact Signing certificate (Hex's `windows.rs` pins the same signer)
//
// Dev builds aren't signed, so a dev-channel install takes an unsigned binary; a signature it does carry must hold.
import { spawn } from "node:child_process"
import { createHash, createPublicKey, verify } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import type { CliInstall } from "../install"
import { UpdateEnvironment } from "./environment"

/**
 * Anomaly's ed25519 release key for Linux binaries, `.github/release/linux-signing.pub` (the
 * `CONSOLE_CLI_RELEASE_SIGNING_KEY` secret is its private half); a test keeps the two the same.
 */
export const LINUX_SIGNING_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAppH4owNdPd5Ktoj4LvYkz88BeykCWNB9mbZWveLvWt8=
-----END PUBLIC KEY-----
`

/**
 * What a macOS release binary's signature must satisfy, `.github/release/macos-requirement.txt`: Apple's Developer ID
 * chain, the identifier `sign-macos.sh` gives it, Anomaly's team, and a notarization ticket, which for a binary that
 * can't have one stapled is looked up online.
 */
export const MACOS_REQUIREMENT =
  'anchor apple generic and identifier "anomaly.opencode-console" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "5NZ4Q7NXJ4" and notarized'

/** The common name of the certificate Azure Artifact Signing issues Anomaly, as Hex's updater pins it. */
export const WINDOWS_SIGNER = "Anomaly Innovations, Inc https://anoma.ly/"

/** The bytes `sign-linux.sh` signs for a binary whose SHA-256 is `sha256`. */
export const linuxMessage = (sha256: string) => `anomaly.opencode-console.linux-artifact.v1\n${sha256}\n`

/** Throws unless a staged binary is one this install may run: see the top of this file. */
export type Verify = (
  binary: string,
  input: { readonly channel: CliInstall.Channel; readonly platform: NodeJS.Platform },
) => Promise<void>

/** The check against these keys; tests pass their own, releases use Anomaly's. */
export const verifier =
  (
    keys: { readonly linux: string; readonly macos: string; readonly windows: string } = {
      linux: LINUX_SIGNING_KEY,
      macos: MACOS_REQUIREMENT,
      windows: WINDOWS_SIGNER,
    },
  ): Verify =>
  async (binary, input) => {
    if (input.platform === "linux") return verifyLinux(binary, input.channel, keys.linux)
    if (input.channel === "dev") return
    if (input.platform === "darwin") return verifyMacos(binary, keys.macos)
    if (input.platform === "win32") return verifyWindows(binary, keys.windows)
  }

export const check = verifier()

/**
 * Linux: the `.sig` beside the binary, by `key`. It may hold up to four 64-byte signatures, any of which may hold, so a
 * release during a key rotation can carry the old key's and the new key's for installs on either. A dev build may come
 * unsigned.
 */
export function verifyLinux(binary: string, channel: CliInstall.Channel, key = LINUX_SIGNING_KEY) {
  const file = `${binary}.sig`
  if (!existsSync(file)) {
    if (channel === "dev") return
    throw new Error("the update isn't signed by Anomaly's release key")
  }
  const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex")
  const signature = readFileSync(file)
  const message = Buffer.from(linuxMessage(sha256))
  const trusted = createPublicKey(key)
  const valid =
    signature.length > 0 &&
    signature.length % 64 === 0 &&
    signature.length <= 256 &&
    Array.from({ length: signature.length / 64 }, (_, index) => signature.subarray(index * 64, index * 64 + 64)).some(
      (part) => verify(null, message, trusted, part),
    )
  if (!valid) throw new Error("the update's signature isn't Anomaly's release key's")
}

/** macOS: `codesign` against `requirement`, without running the binary. */
export function verifyMacos(binary: string, requirement = MACOS_REQUIREMENT) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, binary], {
      stdio: ["ignore", "ignore", "pipe"],
      env: UpdateEnvironment.tool(),
    })
    const errors: Buffer[] = []
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`couldn't check the update's code signature: ${error.message}`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      reject(
        new Error(
          `the update's code signature isn't Anomaly's notarized Developer ID: ${Buffer.concat(errors).toString("utf8").trim()}`,
        ),
      )
    })
  })
}

/**
 * Windows: Authenticode, through Windows PowerShell's own `Get-AuthenticodeSignature` (Hex's `windows.rs`): Valid, which
 * Windows decides from the chain and timestamp, and signed by `signer`.
 */
export function verifyWindows(binary: string, signer = WINDOWS_SIGNER) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      `${UpdateEnvironment.systemRoot()}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s = Get-AuthenticodeSignature -LiteralPath $env:OPENCODE_CONSOLE_UPDATE_FILE; [Console]::Out.Write(\"$($s.Status)`n\"); if ($s.SignerCertificate) { [Console]::Out.Write($s.SignerCertificate.GetNameInfo('SimpleName', $false)) }",
      ],
      // A fixed environment: nothing of the parent's PSModulePath, which from a PowerShell 7 parent breaks Windows
      // PowerShell's own security module, or anything else a project set.
      {
        env: { ...UpdateEnvironment.tool("win32"), OPENCODE_CONSOLE_UPDATE_FILE: binary },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    )
    const output: Buffer[] = []
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`couldn't check the update's Authenticode signature: ${error.message}`))
    })
    child.on("close", () => {
      clearTimeout(timer)
      const [status = "", name = ""] = Buffer.concat(output).toString("utf8").split("\n")
      if (status.trim() !== "Valid")
        return reject(new Error(`the update's Authenticode signature is ${status.trim() || "missing"}`))
      if (name.trim() !== signer)
        return reject(new Error(`the update is signed by ${JSON.stringify(name.trim())}, not Anomaly`))
      resolve()
    })
  })
}
