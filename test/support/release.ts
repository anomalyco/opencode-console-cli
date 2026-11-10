import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { CliInstall } from "../../src/install"
import { Signature } from "../../src/update/signature"
import type { ConsoleStore } from "../../src/store"

const roots: string[] = []

/** Removes every directory these helpers made; tests call it from `afterEach`. */
export function removeReleases() {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
}

function directory(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

/**
 * A stand-in for a release binary: a shell script that prints its version, and answers `self-test` the way the real
 * one does, or fails it.
 */
export function script(version: string, selfTest: "passes" | "fails" = "passes", ran?: string) {
  return `#!/bin/sh
${
  ran === undefined
    ? ""
    : `echo "$*" >> ${JSON.stringify(ran)}
`
}case "$1" in
  --version) echo ${version} ;;
  self-test) ${selfTest === "passes" ? `echo "opencode-console ${version} self-test ok"` : "echo broken >&2; exit 1"} ;;
  *) echo "${version} $*" ;;
esac
`
}

/** A throwaway release key, standing in for Anomaly's: the updater under test trusts its public half. */
export const releaseKey = generateKeyPairSync("ed25519")
export const releaseKeys = {
  linux: releaseKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
  macos: Signature.MACOS_REQUIREMENT,
  windows: Signature.WINDOWS_SIGNER,
}

/** `sign-linux.sh`'s signature of `binary` by `key`. */
export const signatureOf = (binary: string, key: KeyObject = releaseKey.privateKey) =>
  sign(null, Buffer.from(Signature.linuxMessage(createHash("sha256").update(binary).digest("hex"))), key)

/**
 * A release archive the way `script/pack.ts` and `sign-linux.sh` lay it out: `package/bin/opencode-console`, mode
 * 0755, and its `.sig` by the test release key unless `signature` says otherwise.
 */
export function archive(
  binary: string,
  signature: Buffer | "unsigned" = signatureOf(binary),
  extra: Readonly<Record<string, string>> = {},
) {
  const root = directory("opencode-console-archive-")
  mkdirSync(path.join(root, "package", "bin"), { recursive: true })
  const file = path.join(root, "package", "bin", "opencode-console")
  writeFileSync(file, binary)
  chmodSync(file, 0o755)
  if (signature !== "unsigned") writeFileSync(`${file}.sig`, signature)
  Object.entries(extra).forEach(([name, text]) => writeFileSync(path.join(root, "package", name), text))
  writeFileSync(path.join(root, "package", "package.json"), "{}")
  const tarball = path.join(root, "release.tgz")
  const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", root, "package"])
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString())
  const bytes = readFileSync(tarball)
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}

export interface Release {
  readonly version: string
  readonly bytes: Buffer
  readonly sha256: string
  readonly rollout?: number
  readonly required?: boolean
  /** The size the manifest claims, when it should lie. */
  readonly size?: number
  /** The download URL the manifest names, when it should point elsewhere. */
  readonly url?: string
}

/**
 * A stand-in release service speaking the release protocol over real HTTP: `/release/opencode-console/cli/<channel>.json`
 * with an ETag, and each build's archive under `/release/opencode-console/files/<sha256>/`. Records every request.
 */
export function serveRelease(initial: Record<string, Release | undefined>, target = "linux-x64") {
  const channels = { ...initial }
  const requests: Array<{ readonly path: string; readonly headers: Headers }> = []
  const sequence = { value: 1 }
  const manifest = (channel: string, release: Release) =>
    JSON.stringify({
      schema: 1,
      app: "opencode-console",
      artifact: "cli",
      channel,
      sequence: sequence.value,
      published_at: "2026-11-09T00:00:00.000Z",
      release: {
        version: release.version,
        rollout_percent: release.rollout ?? 100,
        required: release.required ?? false,
        targets: {
          [target]: {
            url:
              release.url ??
              `/release/opencode-console/files/${release.sha256}/opencode-console-linux-x64-${release.version}.tgz`,
            size: release.size ?? release.bytes.length,
            sha256: release.sha256,
          },
        },
        distributions: [{ kind: "direct" }],
      },
    })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, headers: request.headers })
      const listed = url.pathname.match(/^\/release\/opencode-console\/cli\/([a-z]+)\.json$/)
      if (listed) {
        const release = channels[listed[1]!]
        if (!release) return new Response("not found", { status: 404 })
        const body = manifest(listed[1]!, release)
        const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`
        if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 })
        return new Response(body, { headers: { "content-type": "application/json", etag } })
      }
      const file = url.pathname.match(/^\/release\/opencode-console\/files\/([0-9a-f]{64})\//)
      const release = Object.values(channels).find((item) => item?.sha256 === file?.[1])
      return release ? new Response(new Uint8Array(release.bytes)) : new Response("not found", { status: 404 })
    },
  })
  return {
    service: `http://127.0.0.1:${server.port}/release`,
    requests,
    publish(channel: string, release: Release | undefined) {
      channels[channel] = release
      sequence.value += 1
    },
    stop: () => server.stop(true),
  }
}

/** An install `setup` made from a release binary: the binary in `<data>/cli` and its receipt. */
export function installRelease(
  store: ConsoleStore.Info,
  input: { readonly version: string; readonly sha256?: string; readonly selfTest?: "passes" | "fails" },
) {
  const cli = CliInstall.directory(store)
  mkdirSync(cli, { recursive: true })
  writeFileSync(CliInstall.binary(store), script(input.version, input.selfTest))
  chmodSync(CliInstall.binary(store), 0o755)
  writeFileSync(
    CliInstall.receiptFile(cli),
    JSON.stringify({
      method: "direct",
      version: input.version,
      channel: CliInstall.channelOf(input.version),
      target: "linux-x64",
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    }),
  )
  return CliInstall.binary(store)
}
