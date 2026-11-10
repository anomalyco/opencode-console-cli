import { beforeAll, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { Schema } from "effect"
import { Contract } from "../src/contract"
import { EventWatch } from "../src/event-watch"

const root = path.join(import.meta.dir, "..")
const npm = path.join(root, "dist/npm")
const LIBRARY = ["event-watch", "event-watch-tool", "contract"]

/** An event as Console encodes one for the wire, every field set. */
const event = Schema.encodeSync(Schema.toCodecJson(EventWatch.WatchEvent))(
  Schema.decodeUnknownSync(EventWatch.WatchEvent)({
    id: "evt_1",
    watchID: "ew_01",
    sessionID: "ses_1",
    source: "github",
    routingKey: "github:acme/app#12",
    kind: "comment",
    actor: { id: "1", login: "octocat", bot: false, self: false },
    title: "acme/app#12",
    body: "Looks good",
    url: "https://github.com/acme/app/pull/12#issuecomment-1",
    status: null,
    terminal: false,
    occurredAt: new Date("2026-11-09T00:00:00Z"),
    eventName: "github.issue",
    data: { number: 12 },
  }),
)

test("the CLI's lenient wire schemas decode what Console's event schemas encode", () => {
  expect(Schema.decodeUnknownSync(Contract.WatchEvent)(event)).toMatchObject({
    id: "evt_1",
    actor: { login: "octocat", self: false },
  })
  expect(Schema.decodeUnknownSync(Contract.ServerMessage)({ type: "snapshot", events: [event] }).events).toHaveLength(1)
  const poll = Schema.encodeSync(Schema.toCodecJson(EventWatch.Poll))(
    Schema.decodeUnknownSync(Schema.toCodecJson(EventWatch.Poll))({ cursor: "1.2", events: [event] }),
  )
  expect(Schema.decodeUnknownSync(Contract.Poll)(poll).cursor).toBe("1.2")
})

test("a Slack target keeps Console's branded IDs", () => {
  expect(
    Schema.decodeUnknownSync(EventWatch.Target)({
      _tag: "SlackThread",
      channelID: "C01GENERAL",
      threadTs: "1762516800.000100",
    }),
  ).toMatchObject({ _tag: "SlackThread", channelID: "C01GENERAL", threadTs: "1762516800.000100" })
  expect(() =>
    Schema.decodeUnknownSync(EventWatch.Target)({
      _tag: "SlackThread",
      channelID: "C01GENERAL",
      threadTs: "1.1234567",
    }),
  ).toThrow()
})

beforeAll(async () => {
  await $`bun ${path.join(root, "script/build.ts")}`.quiet()
}, 60_000)

test("the npm package exports the contract subpaths, with types, leaving effect to the importer", async () => {
  const manifest = JSON.parse(readFileSync(path.join(npm, "package.json"), "utf8"))
  for (const name of LIBRARY) {
    const entry = manifest.exports[`./${name}`]
    expect(existsSync(path.join(npm, entry.default))).toBe(true)
    expect(existsSync(path.join(npm, entry.types))).toBe(true)
  }
  // The library files and their shared chunks import effect rather than carry a copy of it.
  const files = readdirSync(npm).filter((file) =>
    /^(event-watch|event-watch-tool|contract)(-[a-z0-9]+)?\.js$/.test(file),
  )
  const sources = files.map((file) => readFileSync(path.join(npm, file), "utf8"))
  const imports = sources.flatMap((source) => [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]))
  expect(imports).toContain("effect")
  expect(imports.filter((specifier) => !specifier?.startsWith("./") && specifier !== "effect")).toEqual([])
  expect(sources.reduce((total, source) => total + source.length, 0)).toBeLessThan(40_000)
  expect(manifest.peerDependenciesMeta.effect).toEqual({ optional: true })
  const watch = await import(path.join(npm, "event-watch.js"))
  expect(watch.LEASE_ENDED).toBe(4401)
  const contract = await import(path.join(npm, "contract.js"))
  expect(contract.pluginHeader).toBe("x-opencode-plugin")
})
