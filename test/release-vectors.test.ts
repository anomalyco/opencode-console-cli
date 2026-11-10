// The release protocol's test vectors (fixtures/release/). Every case must deep-equal what the release service's own
// implementation decides, and every version must parse exactly when the service accepts it.
import { expect, test } from "bun:test"
import path from "node:path"
import { decide, parseManifest, type ReleaseDecision } from "../src/update/release-service"

type DecisionCase = {
  readonly name: string
  readonly input: {
    readonly app: string
    readonly artifact: string
    readonly channel: string
    readonly manifest: string
    readonly install: {
      readonly version: string
      readonly target: string
      readonly distribution: string
      readonly rollout_bucket: number
      readonly sha256?: string
      readonly channel?: string
    }
  }
  readonly expect: ReleaseDecision
}
type Vectors = { readonly cases: readonly DecisionCase[] }
type Manifests = { readonly manifests: Readonly<Record<string, { readonly manifest: string }>> }
type Semver = { readonly valid: readonly string[]; readonly invalid: readonly string[] }

const directory = path.join(import.meta.dir, "fixtures", "release")
const decisions: Vectors = await Bun.file(path.join(directory, "decisions.json")).json()
const manifests: Manifests = await Bun.file(path.join(directory, "manifests.json")).json()
const semver: Semver = await Bun.file(path.join(directory, "semver.json")).json()

function manifestText(name: string) {
  const manifest = manifests.manifests[name]?.manifest
  if (manifest === undefined) throw new Error(`decisions.json names a manifest manifests.json doesn't have: ${name}`)
  return manifest
}

// A manifest with nothing to object to but its version, so the version rule is what accepts or rejects it.
function manifestWithVersion(version: string) {
  return {
    schema: 1,
    app: "opencode-console",
    artifact: "cli",
    channel: "stable",
    sequence: 1,
    published_at: "2026-11-01T00:00:00Z",
    release: {
      version,
      rollout_percent: 100,
      required: false,
      targets: {
        "macos-arm64": {
          url: "https://anoma.ly/release/opencode-console/files/0/opencode-console-0.0.0-macos-arm64.zip",
          size: 1,
          sha256: "0".repeat(64),
        },
      },
      distributions: [{ kind: "direct" }],
    },
  }
}

test("the copied vectors carry the protocol's cases", () => {
  expect(decisions.cases.length).toBeGreaterThan(20)
  expect(semver.valid.length).toBeGreaterThan(0)
  expect(semver.invalid.length).toBeGreaterThan(0)
})

decisions.cases.forEach((item) => {
  test(item.name, () => {
    expect(
      decide({
        app: item.input.app,
        artifact: item.input.artifact,
        channel: item.input.channel,
        manifest: manifestText(item.input.manifest),
        install: {
          version: item.input.install.version,
          target: item.input.install.target,
          distribution: item.input.install.distribution,
          rolloutBucket: item.input.install.rollout_bucket,
          ...(item.input.install.sha256 ? { sha256: item.input.install.sha256 } : {}),
          ...(item.input.install.channel ? { channel: item.input.install.channel } : {}),
        },
      }),
    ).toEqual(item.expect)
  })
})

test("every version the service accepts parses", () => {
  semver.valid.forEach((version) => {
    expect(parseManifest(manifestWithVersion(version)), version).toBeDefined()
  })
})

test("every version the service refuses is malformed", () => {
  semver.invalid.forEach((version) => {
    expect(parseManifest(manifestWithVersion(version)), version).toBeUndefined()
  })
})
