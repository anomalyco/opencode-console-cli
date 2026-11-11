import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/http"
import type { ConsoleClient } from "../../src/console-client"
import { ConsoleStore } from "../../src/store"

export const server = "https://console.test/console"

/**
 * An OpenCode Console answering the device sign-in, refresh, revoke, account, config, instruction, skill and stats
 * endpoints the CLI calls, with the wire shapes `src/contract.ts` reads, which Console's own tests check its real
 * responses against. Like the real Console, a refresh token works once, and reusing one revokes the whole sign-in, and
 * instructions and skills answer only the current access token.
 */
export function fakeConsole(
  input: {
    readonly config?: () => Response | Promise<Response>
    /** `GET /api/v1/models`: the caller's models by provider. */
    readonly models?: () => Response
    /** `GET /api/v2/codex/models`: the caller's models as Codex's catalog lists them. */
    readonly codexModels?: () => Response
    /** `GET /api/v2/instructions`: the instructions the caller loads. */
    readonly instructions?: () => Response
    /** `GET /api/v2/skills`: the skills the caller may use, each at its version. */
    readonly skills?: () => Response
    /**
     * Whether the config answer says the caller has instructions and skills (`x-opencode-instructions-skills`), as
     * Console says for a workspace with extensions on; it does unless a test says otherwise.
     */
    readonly instructionsSkills?: () => boolean
    /** `GET /api/v2/stats`: where the caller sends usage metadata; 404, collecting none, unless a test says. */
    readonly stats?: () => Response
    /** Skill bundles by slug (`GET /api/v2/skills/:slug`), and stored files by digest, sent at once or as streamed. */
    readonly bundles?: Record<string, unknown>
    readonly blobs?: Record<string, Uint8Array | ReadableStream<Uint8Array>>
    readonly revoke?: () => Response | undefined
    /** Where device approval links point: the Console's own `/console/device` unless a test says otherwise. */
    readonly verification?: string
    /** Holds each refresh's answer until it resolves; by default a short pause, so unserialized callers overlap. */
    readonly refreshing?: () => Promise<void>
    /**
     * The event watch routes, which answer 404 without it, as
     * they do for a workspace without event watches. `watches` are the member's live watches, `types` the event types
     * `GET /api/event-watches/types` lists; `poll` answers each `GET /api/event-watches/events`.
     */
    readonly watches?: {
      readonly watches?: ReadonlyArray<Record<string, unknown>>
      readonly types?: ReadonlyArray<Record<string, unknown>>
      readonly poll?: (cursor: string | null) => Response | Promise<Response>
      /** Answers every watch route instead, as Console does for a sign-in it ended or an expired SSO session. */
      readonly refuse?: () => Response
      /** Answers `POST /api/event-watches` instead of making the watch, as Console does for one it refuses. */
      readonly create?: () => Response
    }
  } = {},
) {
  const verification = input.verification ?? "/console/device"
  const state = {
    access: "access-1",
    refresh: "refresh-1",
    refreshes: 0,
    configs: 0,
    /** Set once a spent refresh token is sent again, which ends the sign-in. */
    revokedFamily: false,
    revoked: [] as string[],
    requests: [] as Array<{
      readonly url: string
      readonly headers: Headers
      readonly body: Record<string, unknown>
      readonly redirect: Request["redirect"]
    }>,
    config: input.config ?? (() => Response.json({})),
    watches: [...(input.watches?.watches ?? [])],
    /** Each `POST /api/event-watches` body, in order. */
    created: [] as Array<Record<string, unknown>>,
    /** Each watch ID `DELETE /api/event-watches/:id` stopped. */
    cancelled: [] as string[],
    /** The IDs of each `POST /api/event-watches/ack`, in order. */
    acked: inbox<ReadonlyArray<string>>(),
    /** The cursor each poll sent, `null` for none. */
    polls: inbox<string | null>(),
  }
  const issue = () => {
    const generation = state.refreshes + 1
    state.access = `access-${generation}`
    state.refresh = `refresh-${generation}`
    return Response.json({
      access_token: state.access,
      refresh_token: state.refresh,
      token_type: "Bearer",
      expires_in: 3600,
      org_id: "org_acme",
    })
  }
  const handle = async (request: Request): Promise<Response> => {
    const text = await request.text()
    const body: Record<string, unknown> = text ? JSON.parse(text) : {}
    state.requests.push({ url: request.url, headers: request.headers, body, redirect: request.redirect })
    const route = new URL(request.url).pathname.replace(/^\/console/, "")
    if (route === "/auth/device/code")
      return Response.json({
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: verification,
        verification_uri_complete: `${verification}?user_code=ABCD-EFGH&client_id=opencode-console-cli`,
        expires_in: 600,
        interval: 0,
      })
    if (route === "/auth/device/token") {
      if (body.grant_type !== "refresh_token") return issue()
      await (input.refreshing?.() ?? Bun.sleep(20))
      if (state.revokedFamily || body.client_id !== "opencode-console-cli")
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      if (body.refresh_token !== state.refresh) {
        state.revokedFamily = true
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      state.refreshes++
      return issue()
    }
    if (route === "/api/user") return Response.json({ id: "usr_ada", email: "ada@example.com", name: null })
    if (route === "/api/orgs") return Response.json([{ id: "org_acme", name: "Acme", avatarUrl: null, blocked: false }])
    if (route === "/auth/oauth/revoke") {
      const answer = input.revoke?.()
      if (answer) return answer
      state.revoked.push(String(body.token))
      return Response.json({})
    }
    if (route === "/api/v1/models") return input.models?.() ?? Response.json({})
    if (route === "/api/v2/codex/models") return input.codexModels?.() ?? Response.json({ models: [] })
    const contents = route === "/api/v2/instructions" || route === "/api/v2/stats" || route.startsWith("/api/v2/skills")
    if (contents && request.headers.get("authorization") !== `Bearer ${state.access}`)
      return Response.json({ _tag: "Unauthorized" }, { status: 401 })
    if (route === "/api/v2/stats") return input.stats?.() ?? Response.json({ _tag: "NotFound" }, { status: 404 })
    if (route === "/api/v2/instructions") return input.instructions?.() ?? Response.json({ instructions: [] })
    if (route === "/api/v2/skills") return input.skills?.() ?? Response.json({ skills: [] })
    const skill = route.match(/^\/api\/v2\/skills\/([^/]+)(?:\/blobs\/([^/]+))?$/)
    if (skill?.[2] !== undefined) {
      const blob = input.blobs?.[skill[2]]
      return blob ? new Response(blob) : new Response(null, { status: 404 })
    }
    if (skill?.[1] !== undefined) {
      const bundle = new URL(request.url).searchParams.get("format") === "v2" ? input.bundles?.[skill[1]] : undefined
      return bundle ? Response.json(bundle) : Response.json({ _tag: "NotFound" }, { status: 404 })
    }
    if (route.startsWith("/api/event-watches")) return watches(request, route, body)
    if (route === "/api/v2/config") {
      state.configs++
      if (state.revokedFamily) return Response.json({ _tag: "Unauthorized" }, { status: 401 })
      const answer = await state.config()
      if (!answer.ok || input.instructionsSkills?.() === false) return answer
      const headers = new Headers(answer.headers)
      headers.set("x-opencode-instructions-skills", "1")
      return new Response(answer.body, { status: answer.status, headers })
    }
    return new Response(null, { status: 404 })
  }
  const watches = (request: Request, route: string, body: Record<string, unknown>) => {
    if (!input.watches) return Response.json({ _tag: "NotFound" }, { status: 404 })
    if (input.watches.refuse) return input.watches.refuse()
    const poll = input.watches.poll
    if (route === "/api/event-watches/events" && poll) {
      const cursor = new URL(request.url).searchParams.get("cursor")
      state.polls.push(cursor)
      return poll(cursor)
    }
    if (route === "/api/event-watches/ack") {
      state.acked.push(Array.isArray(body.ids) ? body.ids.map(String) : [])
      return new Response(null, { status: 204 })
    }
    if (route === "/api/event-watches/types") return Response.json({ types: input.watches.types ?? [] })
    if (route === "/api/event-watches" && request.method === "GET") return Response.json({ watches: state.watches })
    if (route === "/api/event-watches" && request.method === "POST") {
      state.created.push(body)
      if (input.watches.create) return input.watches.create()
      // Another server's event type is keyed by a hash of it, as Console keys it.
      const watch = {
        id: `ew_${state.created.length}`,
        sessionID: body.sessionID,
        ...(typeof body.server === "string"
          ? {
              routingKey: "mcp:0123456789abcdef:0123456789abcdef0123456789abcdef0123456789abcdef",
              serverSlug: body.server,
              eventType: body.event,
              arguments: body.arguments,
            }
          : { routingKey: "github:acme/app#7" }),
        mode: "sliding",
        expiresAt: "2026-11-10T12:00:00.000Z",
        createdAt: "2026-11-07T12:00:00.000Z",
      }
      state.watches.push(watch)
      return Response.json(watch)
    }
    const id = route.match(/^\/api\/event-watches\/(ew_[^/]+)$/)?.[1]
    if (id !== undefined && request.method === "DELETE") {
      state.cancelled.push(id)
      state.watches = state.watches.filter((watch) => watch.id !== id)
      return new Response(null, { status: 204 })
    }
    return Response.json({ _tag: "NotFound" }, { status: 404 })
  }
  // Bun's `fetch` type also carries `preconnect`.
  const fetch = Object.assign(
    (request: string | URL | Request, init?: RequestInit) =>
      handle(request instanceof Request ? request : new Request(String(request), init)),
    { preconnect: () => {} },
  )
  return { state, fetch, handle }
}

export type FakeConsole = ReturnType<typeof fakeConsole>

/**
 * `fakeConsole` over real HTTP on this machine, with the event stream's WebSocket (`GET /api/event-watches/stream`):
 * each connection runs `stream.open` with its index, from 0, and `stream.close` with it once the client closes it, or
 * the upgrade answers 426 while `stream.refuse` holds, as a proxy that can't carry WebSockets does. Ack messages
 * sockets send land in `state.acked` too. `stop` ends it.
 */
export function serveConsole(
  input: Parameters<typeof fakeConsole>[0] = {},
  stream: {
    readonly refuse?: boolean
    readonly open?: (socket: { send: (frame: string) => void; close: (code: number) => void }, index: number) => void
    readonly close?: (index: number) => void
  } = {},
) {
  const console = fakeConsole(input)
  const upgrades = { count: 0 }
  const server = Bun.serve<number>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, bun) => {
      if (new URL(request.url).pathname !== "/console/api/event-watches/stream") return console.handle(request)
      if (stream.refuse) return new Response("Upgrade Required", { status: 426 })
      console.state.requests.push({ url: request.url, headers: request.headers, body: {}, redirect: request.redirect })
      return bun.upgrade(request, { data: upgrades.count++ }) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      open: (socket) => stream.open?.(socket, socket.data),
      close: (socket) => stream.close?.(socket.data),
      message: (_, message) => console.state.acked.push(JSON.parse(String(message)).ids),
    },
  })
  return {
    ...console,
    upgrades,
    url: `http://127.0.0.1:${server.port}/console`,
    stop: () => server.stop(true),
  }
}

/** Values a stand-in received, taken in order as they arrive. */
export function inbox<T extends {} | null>() {
  const items: T[] = []
  const listeners = new Set<() => void>()
  return {
    items,
    push: (item: T) => {
      items.push(item)
      listeners.forEach((listener) => listener())
    },
    /** The `index`th value received, from 0, once it arrives. */
    at: (index: number) =>
      new Promise<T>((resolve) => {
        const check = () => {
          const item = items[index]
          if (item === undefined) return
          listeners.delete(check)
          resolve(item)
        }
        listeners.add(check)
        check()
      }),
  }
}

/** Runs `effect` against `console` over the CLI's real HTTP client. */
export function against(console: FakeConsole) {
  return <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, console.fetch))
}

/** A stored device sign-in for Acme whose access token expires at `expires`. */
export function signIn(console: FakeConsole, expires: number, base = server): ConsoleClient.OAuth {
  return {
    type: "oauth",
    server: base,
    access: console.state.access,
    refresh: console.state.refresh,
    expires,
    accountID: "usr_ada",
    email: "ada@example.com",
    orgID: "org_acme",
    orgName: "Acme",
  }
}

/** A store in a fresh temporary directory, with no key in its environment unless `env` gives one. */
export function temporaryStore(env: ConsoleStore.Env = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "opencode-console-test-"))
  temporary.push(root)
  return ConsoleStore.make({ root, env })
}

const temporary: string[] = []

/** Removes every store `temporaryStore` made; tests call it from `afterEach`. */
export function removeStores() {
  temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
}

export function save(store: ConsoleStore.Info, credential: ConsoleClient.OAuth) {
  ConsoleStore.write(ConsoleStore.credentialFile(store), JSON.stringify(credential))
}

/** Waits in real time until `condition` holds, failing after `timeout` milliseconds. */
export async function until(condition: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}
