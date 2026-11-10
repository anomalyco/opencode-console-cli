// End-to-end stand-ins for script/e2e/run.sh: a Console (test/support/console.ts's fake, over real HTTP)
// with the member signed in, and a release service speaking the release protocol, serving whatever build
// `<dir>/stable.current` names ("<version> <archive>"). Prints the two URLs, then serves until killed.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ConsoleStore } from "../../src/store"
import { fakeConsole, save, signIn } from "../../test/support/console"

const directory = process.argv[2]!
const console_ = fakeConsole({
  config: () => Response.json({ policies: [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }] }),
  models: () =>
    Response.json({
      opencode: {
        name: "Acme / OpenCode",
        models: {
          "claude-sonnet-4-6": {
            name: "Claude Sonnet 4.6",
            api: { anthropic: { base_url: "http://127.0.0.1/inference/anthropic/v1" } },
          },
        },
      },
    }),
})
const consoleServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => console_.handle(request) })
const consoleUrl = `http://127.0.0.1:${consoleServer.port}/console`
save(ConsoleStore.make(), signIn(console_, Number.MAX_SAFE_INTEGER, consoleUrl))

const release = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url)
    process.stdout.write(
      `release ${url.pathname} ${request.headers.get("user-agent")} ${request.headers.get("if-none-match") ?? "-"}\n`,
    )
    const listed = url.pathname.match(/^\/release\/opencode-console\/cli\/([a-z]+)\.json$/)
    const current = listed && path.join(directory, `${listed[1]}.current`)
    if (current) {
      if (!existsSync(current)) return new Response("not found", { status: 404 })
      const [version, file] = readFileSync(current, "utf8").trim().split(" ")
      const bytes = readFileSync(file!)
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const body = JSON.stringify({
        schema: 1,
        app: "opencode-console",
        artifact: "cli",
        channel: listed![1],
        sequence: 1,
        published_at: new Date(0).toISOString(),
        release: {
          version,
          rollout_percent: 100,
          required: false,
          targets: {
            "linux-x64": {
              url: `/release/opencode-console/files/${sha256}/${path.basename(file!)}`,
              size: bytes.length,
              sha256,
            },
          },
          distributions: [{ kind: "direct" }],
        },
      })
      const etag = `"${sha256.slice(0, 16)}"`
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 })
      return new Response(body, { headers: { etag, "content-type": "application/json" } })
    }
    const file = url.pathname.match(/^\/release\/opencode-console\/files\/[0-9a-f]{64}\/(.+)$/)?.[1]
    const found = file && path.join(directory, file)
    return found && existsSync(found) ? new Response(Bun.file(found)) : new Response("not found", { status: 404 })
  },
})
process.stdout.write(`CONSOLE=${consoleUrl}\nRELEASE=http://127.0.0.1:${release.port}/release\n`)
