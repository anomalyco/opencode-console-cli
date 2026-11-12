import { afterEach, expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

// The release signers unpack each build's tarball and repack it with a signature. A tarball is data a build job made,
// so a crafted one must fail the signer before it can make the signed tarball carry anything else, such as a file of
// the signing runner's named by a newline in a member name.
const release = path.join(import.meta.dir, "../.github/release")
const VERSION = "0.1.9"
const directories: string[] = []
afterEach(() => directories.splice(0).forEach((item) => rmSync(item, { recursive: true, force: true })))

function temporary() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "console-archive-"))
  directories.push(directory)
  return directory
}

/** The files npm pack puts in a linux-x64 tarball, with no directory entries. */
const FILES = ["package/LICENSE", "package/bin/opencode-console", "package/package.json"]

/** A linux-x64 build tarball of `entries` from `tree`, a directory holding `package/`. */
function tarball(tree: string, entries = FILES) {
  const binaries = temporary()
  const file = path.join(binaries, `opencode-console-linux-x64-${VERSION}.tgz`)
  const result = Bun.spawnSync(["tar", "-czf", file, "-C", tree, ...entries])
  expect(result.exitCode).toBe(0)
  return binaries
}

/** `package/` as script/pack.ts lays it out, with `license` deciding what stands at `package/LICENSE`. */
function tree(license: (file: string) => void = (file) => writeFileSync(file, "MIT\n")) {
  const root = temporary()
  mkdirSync(path.join(root, "package/bin"), { recursive: true })
  writeFileSync(
    path.join(root, "package/package.json"),
    `{"name":"@opencode/console-linux-x64","version":"${VERSION}"}\n`,
  )
  writeFileSync(path.join(root, "package/bin/opencode-console"), "binary")
  license(path.join(root, "package/LICENSE"))
  return root
}

/**
 * sign-linux.sh as a release runs it, from a copy of the script and lib.sh whose linux-signing.pub is a key made for
 * the test, since the script signs only with a key that matches linux-signing.pub.
 */
function sign(binaries: string) {
  const scripts = temporary()
  for (const file of ["sign-linux.sh", "lib.sh"]) copyFileSync(path.join(release, file), path.join(scripts, file))
  const key = path.join(temporary(), "key.pem")
  expect(Bun.spawnSync(["openssl", "genpkey", "-algorithm", "Ed25519", "-out", key]).exitCode).toBe(0)
  const pub = Bun.spawnSync(["openssl", "pkey", "-in", key, "-pubout", "-out", path.join(scripts, "linux-signing.pub")])
  expect(pub.exitCode).toBe(0)
  const out = path.join(temporary(), "signed")
  const result = Bun.spawnSync(["bash", path.join(scripts, "sign-linux.sh"), binaries, out], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CONSOLE_CLI_RELEASE_SIGNING_KEY: readFileSync(key, "utf8"),
      CONSOLE_TARGETS: "linux-x64",
      CONSOLE_VERSION: VERSION,
    },
  })
  const signed = path.join(out, `opencode-console-linux-x64-${VERSION}.tgz`)
  return { code: result.exitCode, stderr: result.stderr.toString(), signed: existsSync(signed) ? signed : undefined }
}

function listing(file: string) {
  return Bun.spawnSync(["tar", "-tzf", file]).stdout.toString().trim().split("\n")
}

test("signs a build tarball and repacks exactly its files and the signature", () => {
  const result = sign(tarball(tree()))
  expect(result.code).toBe(0)
  expect(listing(result.signed ?? "")).toEqual([
    "package/LICENSE",
    "package/bin/opencode-console",
    "package/bin/opencode-console.sig",
    "package/package.json",
  ])
})

test("refuses a tarball with a directory in place of package/LICENSE", () => {
  const result = sign(
    tarball(
      tree((file) => {
        mkdirSync(file)
        writeFileSync(path.join(file, "notes"), "not a license")
      }),
    ),
  )
  expect(result.code).not.toBe(0)
  expect(result.signed).toBeUndefined()
})

test("never packs a runner's file that a newline in a member name points at", () => {
  // Inside a directory at package/LICENSE: `a`, and `a\n<canary>`, which a list of names read back from the unpacked
  // tree would split into package/LICENSE/a and the canary's absolute path.
  const canary = path.join(temporary(), "runner-secret")
  writeFileSync(canary, "the runner's own file")
  const result = sign(
    tarball(
      tree((file) => {
        mkdirSync(file)
        writeFileSync(path.join(file, "a"), "")
        const injected = path.join(file, `a\n${canary}`)
        mkdirSync(path.dirname(injected), { recursive: true })
        writeFileSync(injected, "")
      }),
    ),
  )
  expect(result.code).not.toBe(0)
  expect(result.signed).toBeUndefined()
})

test("refuses a tarball with an extra member, a duplicate, or a link", () => {
  const extra = tree()
  writeFileSync(path.join(extra, "package/README.md"), "extra")
  expect(sign(tarball(extra, [...FILES, "package/README.md"])).code).not.toBe(0)

  const duplicate = tree()
  expect(sign(tarball(duplicate, [...FILES, "package/LICENSE"])).code).not.toBe(0)

  const linked = tree((file) => symlinkSync("/etc/hostname", file))
  expect(sign(tarball(linked)).code).not.toBe(0)
})

test("the Windows signer refuses a directory in place of package/LICENSE too", () => {
  const root = temporary()
  mkdirSync(path.join(root, "package/bin"), { recursive: true })
  mkdirSync(path.join(root, "package/LICENSE"))
  writeFileSync(path.join(root, "package/LICENSE/notes"), "")
  writeFileSync(path.join(root, "package/package.json"), "{}\n")
  writeFileSync(path.join(root, "package/bin/opencode-console.exe"), "binary")
  const binaries = temporary()
  for (const target of ["windows-x64", "windows-x64-baseline"])
    Bun.spawnSync([
      "tar",
      "-czf",
      path.join(binaries, `opencode-console-${target}-${VERSION}.tgz`),
      "-C",
      root,
      "package/LICENSE",
      "package/bin/opencode-console.exe",
      "package/package.json",
    ])
  const result = Bun.spawnSync(["bash", path.join(release, "windows-binaries.sh"), "unpack", binaries, temporary()], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CONSOLE_VERSION: VERSION },
  })
  expect(result.exitCode).not.toBe(0)
})

// ---- The release service's client: run only at the pinned SHA-256 ----------------------------------------------------

test("refuses a release service client that isn't the pinned one, before running it", async () => {
  const ran = path.join(temporary(), "ran")
  const server = Bun.serve({ port: 0, fetch: () => new Response(`#!/bin/sh\ntouch "${ran}"\n`) })
  try {
    const out = path.join(temporary(), "client.sh")
    // Async, so this process can serve the client while the script downloads it.
    const child = Bun.spawn(["bash", "-c", `. "${release}/lib.sh"; release_client "${out}" && bash "${out}"`], {
      env: { PATH: process.env.PATH, RELEASE_ORIGIN: `http://127.0.0.1:${server.port}` },
      stderr: "pipe",
    })
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain("not the pinned")
    expect(existsSync(ran)).toBe(false)
  } finally {
    await server.stop(true)
  }
})

// ---- The release tag: made at the run's commit once the release has published ----------------------------------------

const SHA = "a".repeat(40)
const OTHER = "b".repeat(40)

/** A stand-in `gh api` over a directory of refs and tag objects, as tag-release.sh calls it. */
function github() {
  const state = temporary()
  mkdirSync(path.join(state, "refs"))
  mkdirSync(path.join(state, "objects"))
  const bin = temporary()
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
state=${JSON.stringify(state)}
shift # api
method=GET
if [ "$1" = -X ]; then method=$2; shift 2; fi
route=$1; shift
declare -A field
while [ $# -gt 0 ]; do [ "$1" = -f ] && { field[\${2%%=*}]=\${2#*=}; shift 2; } || shift; done
case "$method $route" in
  "POST repos/"*/git/refs)
    [ -n "\${FAIL_CREATE:-}" ] && { echo '{"message":"Resource not accessible"}'; exit 1; }
    tag=\${field[ref]#refs/tags/}
    [ -e "$state/refs/$tag" ] && { echo '{"message":"Reference already exists"}'; exit 1; }
    printf '{"object":{"type":"commit","sha":"%s"}}' "\${field[sha]}" > "$state/refs/$tag" ;;
  "GET repos/"*/git/ref/tags/*) cat "$state/refs/\${route##*/git/ref/tags/}" 2>/dev/null || exit 1 ;;
  "GET repos/"*/git/tags/*) cat "$state/objects/\${route##*/git/tags/}" 2>/dev/null || exit 1 ;;
  *) echo "unexpected gh api $method $route" >&2; exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  const tag = (name: string, type: string, sha: string) =>
    writeFileSync(path.join(state, "refs", name), JSON.stringify({ object: { type, sha } }))
  const object = (sha: string, type: string, target: string) =>
    writeFileSync(path.join(state, "objects", sha), JSON.stringify({ object: { type, sha: target } }))
  const reserve = (env: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", path.join(release, "tag-release.sh")], {
      env: { PATH: `${bin}:${process.env.PATH}`, CONSOLE_VERSION: VERSION, SHA, GH_REPO: "acme/cli", ...env },
    })
  return { state, tag, object, reserve }
}

test("tags the version at the run's commit", () => {
  const gh = github()
  expect(gh.reserve().exitCode).toBe(0)
  expect(JSON.parse(readFileSync(path.join(gh.state, "refs", `v${VERSION}`), "utf8"))).toEqual({
    object: { type: "commit", sha: SHA },
  })
})

test("goes on when a rerun at the same commit finds the tag it made", () => {
  const gh = github()
  expect(gh.reserve().exitCode).toBe(0)
  expect(gh.reserve().exitCode).toBe(0)
})

test("fails when the tag already points at another commit", () => {
  const gh = github()
  gh.tag(`v${VERSION}`, "commit", OTHER)
  const result = gh.reserve()
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain(`already points at ${OTHER}`)
})

test("peels an annotated tag to its commit", () => {
  const same = github()
  same.tag(`v${VERSION}`, "tag", "c".repeat(40))
  same.object("c".repeat(40), "commit", SHA)
  expect(same.reserve().exitCode).toBe(0)

  const other = github()
  other.tag(`v${VERSION}`, "tag", "c".repeat(40))
  other.object("c".repeat(40), "tag", "d".repeat(40))
  other.object("d".repeat(40), "commit", OTHER)
  expect(other.reserve().exitCode).not.toBe(0)
})

test("fails when the API refuses to make the tag and there is none", () => {
  expect(github().reserve({ FAIL_CREATE: "1" }).exitCode).not.toBe(0)
})
