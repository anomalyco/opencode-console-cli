export * as ConsoleClient from "./console-client"

import { Cause, Clock, Data, Duration, Effect, Option, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import {
  CodexModels,
  ConfigDocument,
  Device,
  Instructions,
  ModelsDocument,
  Org,
  SkillBundle,
  Skills,
  SsoRequiredBody,
  Stats,
  Token,
  TokenError,
  UnauthorizedBody,
  User,
  clientID,
  codexModelsPath,
  instructionsSkillsHeader,
  pluginHeader,
  watchSessionHeader,
  watchesHeader,
} from "./contract"

export {
  clientID,
  CodexModels,
  codexModelsPath,
  instructionsSkillsHeader,
  ModelsDocument,
  pluginHeader,
  SkillBundle,
  watchSessionHeader,
  watchesHeader,
}

/** The Console a sign-in or key uses when none is named. */
export const defaultServer = "https://opencode.ai/console"

/** A device sign-in's tokens and the member and workspace it acts as. */
export const OAuth = Schema.Struct({
  type: Schema.Literal("oauth"),
  server: Schema.String,
  access: Schema.String,
  refresh: Schema.String,
  /** When the access token expires, in epoch milliseconds. */
  expires: Schema.Number,
  accountID: Schema.String,
  email: Schema.optional(Schema.String),
  orgID: Schema.optional(Schema.String),
  orgName: Schema.optional(Schema.String),
})
export type OAuth = typeof OAuth.Type

/** A personal or service-account key from `OPENCODE_API_KEY`. */
export interface Key {
  readonly type: "key"
  readonly server: string
  readonly key: string
}

export type Credential = OAuth | Key

export const signedOutMessage = "Signed out of OpenCode Console. Run `npx @opencode/console login` to sign in again"
export const ssoMessage = (organization: string | undefined) =>
  `Sign in with SSO again to use ${organization ?? "your OpenCode Console workspace"}`

/** The workspace enforces SSO and the member's SSO session is missing or expired. */
export class SsoRequired extends Data.TaggedError("ConsoleClient.SsoRequired")<{
  readonly organization: string | undefined
  readonly url: string
}> {
  override get message() {
    return ssoMessage(this.organization)
  }
}

/** The session or refresh token was revoked or expired; only a new sign-in recovers. */
export class SignedOut extends Data.TaggedError("ConsoleClient.SignedOut")<{}> {
  override get message() {
    return signedOutMessage
  }
}

export class DeviceSignInFailed extends Data.TaggedError("ConsoleClient.DeviceSignInFailed")<{
  readonly message: string
}> {}

/** Authenticates a Console request as the credential's member, in the workspace the sign-in chose. */
export function headers(credential: Credential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.type === "oauth" ? credential.access : credential.key}`,
    ...(credential.type === "oauth" && credential.orgID ? { "x-org-id": credential.orgID } : {}),
  }
}

const deviceErrors: Record<string, string> = {
  access_denied: "The sign-in was denied in the browser",
  expired_token: "The code expired before it was approved. Start the sign-in again",
}

/**
 * Starts a device sign-in scoped to the workspace the member picks. `callback` polls until the member approves it in
 * the browser, then resolves to the stored form of the sign-in.
 */
export const authorize = Effect.fn("ConsoleClient.authorize")(function* (server: string) {
  const http = yield* HttpClient.HttpClient
  const device = yield* post(`${server}/auth/device/code`, { client_id: clientID, supports_org_scope: true }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Device)),
  )
  // The member approves wherever this link points, so it must be the Console the code came from: a server that relays
  // another Console's device codes could otherwise have the member approve a sign-in for it.
  const origin = new URL(server).origin
  const url = URL.parse(device.verification_uri_complete, `${server}/`)
  if (!url || url.origin !== origin || URL.parse(device.verification_uri, `${server}/`)?.origin !== origin)
    return yield* new DeviceSignInFailed({
      message: `${server} sent a sign-in link to another site (${device.verification_uri_complete}), so the sign-in stopped`,
    })
  return {
    url: url.href,
    code: device.user_code,
    callback: poll(server, device.device_code, Duration.seconds(device.interval)).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    ),
  }
})

/** Rotates a device sign-in's tokens. The refresh token works once, so callers must never refresh concurrently. */
export const refresh = Effect.fn("ConsoleClient.refresh")(function* (credential: OAuth) {
  const response = yield* post(`${credential.server}/auth/device/token`, {
    grant_type: "refresh_token",
    refresh_token: credential.refresh,
    client_id: clientID,
  })
  if (response.status === 400) {
    const body = yield* HttpClientResponse.schemaBodyJson(TokenError)(response).pipe(Effect.option)
    if (Option.isSome(body) && body.value.error === "invalid_grant") return yield* new SignedOut()
  }
  const token = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Token)),
  )
  const now = yield* Clock.currentTimeMillis
  const orgID = token.org_id ?? credential.orgID
  return OAuth.make({
    ...credential,
    access: token.access_token,
    refresh: token.refresh_token,
    expires: now + token.expires_in * 1000,
    ...(orgID === undefined ? {} : { orgID }),
  })
})

/** Ends a device sign-in's whole session (RFC 7009). The Console answers success even for unknown tokens. */
export const revoke = Effect.fn("ConsoleClient.revoke")(function* (credential: OAuth) {
  const response = yield* post(`${credential.server}/auth/oauth/revoke`, {
    token: credential.refresh,
    token_type_hint: "refresh_token",
    client_id: clientID,
  }).pipe(Effect.timeout(Duration.seconds(5)))
  yield* HttpClientResponse.filterStatusOk(response)
})

/**
 * The credential's workspace config as the Console sent it (`GET /api/v2/config`), and whether its answer said the
 * caller may keep event watches and read instructions and skills. Fields are read one at a time where they're used, so
 * one a newer Console changed can't hide the others. Any answer other than a config fails, a 404 included: the Console
 * serves every active workspace a config, so a missing one is never "no policies".
 */
export const fetchConfig = Effect.fn("ConsoleClient.fetchConfig")(function* (credential: Credential) {
  return yield* request(credential, "/api/v2/config", (response) =>
    HttpClientResponse.schemaBodyJson(ConfigDocument)(response).pipe(
      Effect.map((config) => ({
        config,
        watches: response.headers[watchesHeader] === "1",
        instructionsSkills: response.headers[instructionsSkillsHeader] === "1",
      })),
    ),
  )
})

/**
 * Every model the credential's member may use, by the provider ID config gives each (`GET /api/v1/models`): the
 * workspace's OpenCode models, OpenCode Go's with a subscription, and its own connections'.
 */
export const fetchModels = Effect.fn("ConsoleClient.fetchModels")(function* (credential: Credential) {
  return yield* fetchJson(credential, "/api/v1/models", ModelsDocument)
})

/**
 * The models the credential's member can run from Codex (`GET /api/v2/codex/models`), Codex's default first, read
 * only for the fields setup uses.
 */
export const fetchCodexModels = Effect.fn("ConsoleClient.fetchCodexModels")(function* (credential: Credential) {
  return yield* fetchJson(credential, codexModelsPath, CodexModels)
})

/**
 * The workspace instructions the credential's member loads (`GET /api/v2/instructions`). A workspace that serves none
 * answers 404, which is none.
 */
export const fetchInstructions = Effect.fn("ConsoleClient.fetchInstructions")(function* (credential: Credential) {
  return yield* fetchJson(credential, "/api/v2/instructions", Instructions).pipe(
    Effect.catchIf(missing, () => Effect.succeed({ instructions: [] })),
  )
})

/**
 * The skills the credential's member may use, each at the version its download serves (`GET /api/v2/skills`). A
 * workspace that serves none answers 404, which is none.
 */
export const fetchSkills = Effect.fn("ConsoleClient.fetchSkills")(function* (credential: Credential) {
  return yield* fetchJson(credential, "/api/v2/skills", Skills).pipe(
    Effect.catchIf(missing, () => Effect.succeed({ skills: [] })),
  )
})

/**
 * Where the credential's member sends usage metadata from a harness that keeps its own sign-in, with the headers that
 * authenticate it (`GET /api/v2/stats`). A caller the Console gives none, such as one that isn't a member, gets 404,
 * which is undefined.
 */
export const fetchStats = Effect.fn("ConsoleClient.fetchStats")(function* (credential: Credential) {
  return yield* fetchJson(credential, "/api/v2/stats", Stats).pipe(
    Effect.catchIf(missing, () => Effect.succeed(undefined)),
  )
})

/** One skill's files, SKILL.md first: text inline and stored files by digest. */
export const fetchSkill = Effect.fn("ConsoleClient.fetchSkill")(function* (credential: Credential, slug: string) {
  return yield* fetchJson(credential, `/api/v2/skills/${encodeURIComponent(slug)}?format=v2`, SkillBundle)
})

/**
 * A skill's stored file, by its digest. A file can be 5 MiB and several download at once, so the download fails only
 * once the Console stops sending it for 10 seconds, rather than when it takes longer than 10 seconds in all.
 */
export const fetchSkillBlob = Effect.fn("ConsoleClient.fetchSkillBlob")(function* (
  credential: Credential,
  slug: string,
  sha256: string,
) {
  return yield* respond(
    credential,
    `/api/v2/skills/${encodeURIComponent(slug)}/blobs/${encodeURIComponent(sha256)}`,
  ).pipe(
    Effect.timeout(STALL),
    Effect.flatMap((ok) =>
      ok.stream.pipe(
        Stream.timeoutOrElse({
          duration: STALL,
          orElse: () => Stream.fail(new Cause.TimeoutError("OpenCode Console stopped sending a skill file")),
        }),
        Stream.mkUint8Array,
      ),
    ),
    Effect.scoped,
  )
})

function fetchJson<S extends Schema.Top>(credential: Credential, path: string, schema: S) {
  return request(credential, path, HttpClientResponse.schemaBodyJson(schema))
}

function missing(error: unknown) {
  return error instanceof HttpClientError.HttpClientError && error.response?.status === 404
}

/** How long a Console request may wait for its answer, or a download for its next bytes. */
const STALL = Duration.seconds(10)

// A JSON answer is small, so the whole request, its body included, gets `STALL`.
function request<A, E, R>(
  credential: Credential,
  path: string,
  read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
) {
  return respond(credential, path).pipe(
    Effect.flatMap(read),
    // Scoped so a response whose body is never read (errors) is released here.
    Effect.scoped,
    Effect.timeout(STALL),
  )
}

// A successful answer to `GET path`; anything else that isn't about the sign-in is an HTTP error.
function respond(credential: Credential, path: string) {
  return Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClient.withScope(http)
      .execute(
        HttpClientRequest.get(`${credential.server}${path}`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders(headers(credential)),
        ),
      )
      .pipe(
        Effect.tap((response) => refusal(credential, response)),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
      ),
  )
}

/**
 * Fails as what it is when the Console refused `response` over the sign-in: a session it revoked or that expired
 * (`SignedOut`), or a workspace whose SSO session expired (`SsoRequired`). Any other answer passes.
 */
export const refusal = Effect.fnUntraced(function* (
  credential: Credential,
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status === 401) {
    const body = yield* HttpClientResponse.schemaBodyJson(UnauthorizedBody)(response).pipe(Effect.option)
    if (Option.isSome(body)) return yield* new SignedOut()
  }
  if (response.status === 403) {
    const body = yield* HttpClientResponse.schemaBodyJson(SsoRequiredBody)(response).pipe(Effect.option)
    if (Option.isSome(body))
      return yield* new SsoRequired({
        organization: credential.type === "oauth" ? credential.orgName : undefined,
        url: ssoUrl(credential.server, body.value.connectionId),
      })
  }
})

/**
 * `input` as a Console base URL: an origin and path without a trailing slash. Tokens and keys go to it, so it must be
 * HTTPS, except on this machine.
 */
export function normalizeServer(input: string) {
  const url = URL.parse(input)
  if (!url) return undefined
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

// The Console only redirects to paths under its own base path after SSO. Without a connection, its sign-in page finds
// the workspace's SSO from the member's email.
function ssoUrl(server: string, connectionID: string | undefined) {
  const redirectTo = encodeURIComponent(`${new URL(server).pathname.replace(/\/+$/, "")}/`)
  if (!connectionID) return `${server}/login?next=${redirectTo}`
  return `${server}/auth/sso/${encodeURIComponent(connectionID)}/start?redirectTo=${redirectTo}`
}

function poll(
  server: string,
  deviceCode: string,
  interval: Duration.Duration,
): Effect.Effect<
  OAuth,
  DeviceSignInFailed | HttpClientError.HttpClientError | Schema.SchemaError,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    yield* Effect.sleep(interval)
    const response = yield* post(`${server}/auth/device/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientID,
    })
    const result = yield* HttpClientResponse.schemaBodyJson(Schema.Union([Token, TokenError]))(response)
    if ("access_token" in result) return yield* signedIn(server, result)
    if (result.error === "authorization_pending") return yield* poll(server, deviceCode, interval)
    if (result.error === "slow_down")
      return yield* poll(server, deviceCode, Duration.sum(interval, Duration.seconds(5)))
    return yield* new DeviceSignInFailed({
      message: deviceErrors[result.error] ?? `The Console refused the sign-in (${result.error})`,
    })
  })
}

// The member and workspace the new tokens act as, so status can name them and a config is never reused across them.
const signedIn = Effect.fnUntraced(function* (server: string, token: typeof Token.Type) {
  const [user, orgs] = yield* Effect.all(
    [
      get(`${server}/api/user`, token.access_token, User),
      get(`${server}/api/orgs`, token.access_token, Schema.Array(Org)),
    ],
    { concurrency: 2 },
  )
  const org = token.org_id == null ? undefined : orgs.find((item) => item.id === token.org_id)
  if (token.org_id != null && !org)
    return yield* new DeviceSignInFailed({ message: `The workspace ${token.org_id} wasn't found after signing in` })
  const now = yield* Clock.currentTimeMillis
  return OAuth.make({
    type: "oauth",
    server,
    access: token.access_token,
    refresh: token.refresh_token,
    expires: now + token.expires_in * 1000,
    accountID: user.id,
    email: user.email,
    ...(org ? { orgID: org.id, orgName: org.name } : {}),
  })
})

function get<S extends Schema.Top>(url: string, token: string, schema: S) {
  return Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClient.filterStatusOk(http).execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(token)),
    ),
  ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)))
}

// Tokens and codes in the body must reach only the Console, so a redirect is answered as the error it is.
function post(url: string, body: Record<string, string | boolean>) {
  return Effect.flatMap(HttpClient.HttpClient, (http) =>
    http.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bodyJsonUnsafe(body)),
    ),
  ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
}
