import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { Artifact } from "../src/artifact"
import { serveConsole } from "./support/console"

// `artifact share | pull | list | delete` run as their own process, as a harness's shell runs them, against a Console served
// over real HTTP whose artifact routes stand in for the Console API's.
const cleanup: Array<() => unknown> = []
afterEach(() => cleanup.splice(0).forEach((item) => item()))

function serve(input: Parameters<typeof serveConsole>[0] = { artifacts: {} }) {
  const console = serveConsole(input)
  cleanup.push(console.stop)
  return console
}

function directory() {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-artifact-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A folder named `demo` with the files given, by path. */
function folder(files: Record<string, string | Uint8Array>) {
  const root = path.join(directory(), "demo")
  Object.entries(files).forEach(([file, content]) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), content)
  })
  return root
}

async function cli(server: string, args: string[], cwd?: string) {
  const root = directory()
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: cwd ?? root,
    env: {
      ...process.env,
      OPENCODE_API_KEY: "key-1",
      OPENCODE_CONSOLE_SERVER: server,
      OPENCODE_CONSOLE_HARNESS: undefined,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    },
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

const digest = (text: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

test("shares a folder's files without its dotfiles, and prints the link", async () => {
  const console = serve()
  const dir = folder({
    "index.html": "<html><head><title> Launch plan </title></head></html>",
    "assets/app.css": "body {}",
    ".env": "SECRET=1",
    "assets/.cache/x": "cached",
  })

  const shared = await cli(console.url, ["artifact", "share", dir])

  expect([shared.code, shared.stdout]).toEqual([0, "Shared demo: https://console.test/wrk_test/artifacts/demo\n"])
  expect(console.state.published).toEqual([
    {
      title: "Launch plan",
      files: [
        { path: "assets/app.css", sha256: digest("body {}") },
        { path: "index.html", sha256: digest("<html><head><title> Launch plan </title></head></html>") },
      ],
    },
  ])
})

test("names the artifact as Console does, with one dash for each run of other characters", async () => {
  const console = serve()

  const shared = await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>" }), "--name", "A - B"])

  expect(shared.stdout).toBe("Shared a-b: https://console.test/wrk_test/artifacts/a-b\n")
})

test("uploads a file once however many paths hold it, and a re-share only the files that changed", async () => {
  const console = serve()
  const dir = folder({ "index.html": "<p>one</p>", "logo.svg": "<svg/>", "copy.svg": "<svg/>" })
  await cli(console.url, ["artifact", "share", dir])
  const first = console.state.uploads.length
  writeFileSync(path.join(dir, "index.html"), "<p>two</p>")

  const again = await cli(console.url, ["artifact", "share", dir, "--json"])

  expect([first, console.state.uploads.slice(first)]).toEqual([2, [digest("<p>two</p>")]])
  expect(JSON.parse(again.stdout)).toMatchObject({ slug: "demo", revision: 2, updated: true, files: 3, uploaded: 1 })
})

test("says a re-share updated the artifact, and when a session watches its comments", async () => {
  const console = serve({ artifacts: { watching: true } })
  const dir = folder({ "index.html": "<p>one</p>" })
  await cli(console.url, ["artifact", "share", dir])

  const again = await cli(console.url, ["artifact", "share", dir])

  expect(again.stdout).toBe(
    "Updated demo (revision 2): https://console.test/wrk_test/artifacts/demo\nA session is watching its comments\n",
  )
})

test("stops before sharing over a teammate's artifact, naming them, unless --replace says to", async () => {
  const console = serve({ artifacts: { owners: { plan: "grace@example.com" } } })
  const dir = folder({ "index.html": "<p>mine</p>" })

  const refused = await cli(console.url, ["artifact", "share", dir, "--name", "Plan"])
  const replaced = await cli(console.url, ["artifact", "share", dir, "--name", "Plan", "--replace"])

  expect([refused.code, refused.stderr]).toEqual([
    1,
    "plan belongs to grace@example.com; pick another --name or pass --replace\n",
  ])
  expect([replaced.code, console.state.published.map((body) => body.replace)]).toEqual([0, [true]])
})

test("--ttl sends how long the artifact lasts, in seconds", async () => {
  const console = serve()

  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>" }), "--ttl", "2w"])

  expect(console.state.published.map((body) => body.ttlSeconds)).toEqual([1_209_600])
})

test("refuses a --ttl over a year, or a folder without an index.html, before asking the Console anything", async () => {
  const console = serve()

  const pages = folder({ "page.html": "<p>hi</p>" })

  const ttl = await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>" }), "--ttl", "53w"])
  const index = await cli(console.url, ["artifact", "share", pages])

  expect([ttl.code, ttl.stderr]).toEqual([1, "--ttl takes 1h to 365d in hours, days or weeks, like 7d\n"])
  expect([index.code, index.stderr]).toEqual([1, `${pages} has no index.html\n`])
  expect(console.state.prepared).toEqual([])
})

test("refuses a folder of more than 500 files before asking the Console anything", async () => {
  const console = serve()
  const files = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`page-${index}.html`, "<p>hi</p>"]))

  const shared = await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>", ...files })])

  expect([shared.code, shared.stderr]).toEqual([1, "The folder has 501 files; keep a share to 500\n"])
  expect(console.state.prepared).toEqual([])
})

test("lists the workspace's artifacts", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<title>Launch plan</title>" })])

  const listed = await cli(console.url, ["artifact", "list"])
  const json = await cli(console.url, ["artifact", "list", "--json"])

  expect(listed.stdout).toBe(
    "demo  https://console.test/wrk_test/artifacts/demo · Launch plan · shared by ada@example.com · 2 open threads\n",
  )
  expect(JSON.parse(json.stdout)).toEqual({
    artifacts: [
      {
        id: "art_demo",
        slug: "demo",
        title: "Launch plan",
        url: "https://console.test/wrk_test/artifacts/demo",
        revision: 1,
        sharedBy: "ada@example.com",
        openThreads: 2,
        expiresAt: null,
        updatedAt: "2026-11-13T12:00:00.000Z",
        canDelete: true,
      },
    ],
  })
})

test("deletes an artifact, and says when there's none of that name", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>" })])

  const deleted = await cli(console.url, ["artifact", "delete", "demo", "--json"])
  const again = await cli(console.url, ["artifact", "delete", "demo"])

  expect([deleted.stdout, console.state.shared.size]).toEqual(['{"deleted":"demo"}\n', 0])
  expect([again.code, again.stderr]).toEqual([1, "No artifact named demo\n"])
})

test("says only the person who shared an artifact, or an owner or admin, can delete it", async () => {
  const console = serve({ artifacts: { owners: { plan: "grace@example.com" } } })

  const deleted = await cli(console.url, ["artifact", "delete", "plan"])

  expect([deleted.code, deleted.stderr]).toEqual([
    1,
    "Only the person who shared plan, or a workspace owner or admin, can delete it\n",
  ])
})

test("says when the workspace doesn't have artifacts", async () => {
  const console = serve({})

  const listed = await cli(console.url, ["artifact", "list"])

  expect([listed.code, listed.stderr]).toEqual([1, "Artifacts are off for this OpenCode Console workspace\n"])
})

test("notes the folder's git remote without its credentials, its branch and its commit", async () => {
  const console = serve()
  const dir = folder({ "index.html": "<p>hi</p>" })
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: dir })
      .stdout.toString()
      .trim()
  git("init", "--quiet", "--initial-branch=launch")
  git("remote", "add", "origin", "https://ada:ghp_secret@github.com/acme/app.git?token=1#top")
  git("commit", "--quiet", "--allow-empty", "--message", "first")

  await cli(console.url, ["artifact", "share", dir])

  expect(console.state.published.map((body) => body.source)).toEqual([
    { repo: "https://github.com/acme/app.git", branch: "launch", commitSha: git("rev-parse", "HEAD") },
  ])
})

test("keeps a scp-style remote without its user, and no local path at all", () => {
  expect(Artifact.remoteOf("git@github.com:acme/app.git")).toBe("github.com:acme/app.git")
  expect(Artifact.remoteOf("ada:token@github.com:acme/app.git")).toBe("github.com:acme/app.git")
  expect(Artifact.remoteOf("ssh://ada:token@github.com/acme/app.git")).toBe("ssh://github.com/acme/app.git")
  expect(Artifact.remoteOf("/srv/git/app.git")).toBeUndefined()
})

// The bytes a PNG might hold: not UTF-8, so the listing never carries them inline.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe])

test("pulls the latest revision into ./<name>, fetching only the files the listing doesn't carry inline", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>", "assets/logo.png": png })])
  const cwd = directory()

  const pulled = await cli(console.url, ["artifact", "pull", "demo"], cwd)

  const dir = path.join(cwd, "demo")
  expect([pulled.code, pulled.stdout.replace(/into .*\n/, "into <dir>\n")]).toEqual([
    0,
    "Pulled demo (revision 1) into <dir>\n  assets/logo.png\n  index.html\n",
  ])
  expect([readFileSync(path.join(dir, "index.html"), "utf8"), readFileSync(path.join(dir, "assets/logo.png"))]).toEqual(
    ["<p>hi</p>", Buffer.from(png)],
  )
  expect(console.state.downloads).toEqual([`${digest(png)}?revision=1`])
})

test("--revision pulls an earlier revision, and says when the artifact doesn't keep it", async () => {
  const console = serve()
  const dir = folder({ "index.html": "<p>one</p>" })
  await cli(console.url, ["artifact", "share", dir])
  writeFileSync(path.join(dir, "index.html"), "<p>two</p>")
  await cli(console.url, ["artifact", "share", dir])
  const target = path.join(directory(), "old")

  const pulled = await cli(console.url, ["artifact", "pull", "demo", target, "--revision", "1", "--json"])
  const gone = await cli(console.url, ["artifact", "pull", "demo", path.join(directory(), "x"), "--revision", "9"])

  expect(JSON.parse(pulled.stdout)).toEqual({ slug: "demo", revision: 1, dir: target, files: ["index.html"] })
  expect(readFileSync(path.join(target, "index.html"), "utf8")).toBe("<p>one</p>")
  expect([gone.code, gone.stderr]).toEqual([1, "demo has no revision 9\n"])
})

test("writes only into a new or empty folder unless --force, keeping the folder's other files", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>" })])
  const target = folder({ "notes.txt": "mine" })

  const refused = await cli(console.url, ["artifact", "pull", "demo", target])
  const forced = await cli(console.url, ["artifact", "pull", "demo", target, "--force"])

  expect([refused.code, refused.stderr]).toEqual([1, `${target} isn't empty; pass --force to write into it\n`])
  expect([forced.code, readdirSync(target).sort()]).toEqual([0, ["index.html", "notes.txt"]])
})

test("refuses a listed path that could land outside the folder, writing nothing", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>" })])
  const parent = directory()

  const runs = []
  for (const unsafe of ["../escape.html", "/tmp/escape.html", "a\\escape.html", "a/./escape.html"]) {
    console.state.revisions.set("demo", [[{ path: unsafe, sha256: digest("<p>hi</p>") }]])
    runs.push(await cli(console.url, ["artifact", "pull", "demo", path.join(parent, "out")]))
  }

  expect(runs.map((run) => run.code)).toEqual([1, 1, 1, 1])
  expect(runs.map((run) => run.stderr).every((stderr) => stderr.startsWith("Refusing to write"))).toBe(true)
  expect(readdirSync(parent)).toEqual([])
})

test("never writes through a symlink in the folder", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>", "assets/app.css": "body {}" })])
  const outside = folder({ "keep.html": "outside" })
  const linked = directory()
  symlinkSync(outside, path.join(linked, "assets"))
  const page = directory()
  symlinkSync(path.join(outside, "keep.html"), path.join(page, "index.html"))

  const throughFolder = await cli(console.url, ["artifact", "pull", "demo", linked, "--force"])
  const throughFile = await cli(console.url, ["artifact", "pull", "demo", page, "--force"])

  expect([throughFolder.code, throughFolder.stderr]).toEqual([
    1,
    `Refusing to write assets/app.css through the symlink ${path.join(linked, "assets")}\n`,
  ])
  expect([throughFile.code, throughFile.stderr]).toEqual([
    1,
    `Refusing to write index.html through the symlink ${path.join(page, "index.html")}\n`,
  ])
  expect([readdirSync(outside), readFileSync(path.join(outside, "keep.html"), "utf8")]).toEqual([
    ["keep.html"],
    "outside",
  ])
})

test("refuses a file whose bytes don't match the listing's SHA-256, writing nothing", async () => {
  const console = serve()
  await cli(console.url, ["artifact", "share", folder({ "index.html": "<p>hi</p>", "logo.png": png })])
  console.state.blobs.set(digest(png), new Uint8Array([1, 2, 3]))
  const target = path.join(directory(), "out")

  const pulled = await cli(console.url, ["artifact", "pull", "demo", target])

  expect([pulled.code, pulled.stderr, existsSync(target)]).toEqual([
    1,
    "logo.png doesn't match its SHA-256; nothing was written\n",
    false,
  ])
})
