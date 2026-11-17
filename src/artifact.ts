export * as Artifact from "./artifact"

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { Data, Effect, Option } from "effect"
import { HttpClientResponse } from "effect/http"
import { ConsoleClient } from "./console-client"
import { Contract } from "./contract"
import { ConsoleCredentials } from "./credentials"
import type { ConsoleStore } from "./store"

// Publishes a local folder to the workspace's artifacts in three steps, as OpenCode's Console plugin does:
// `POST /api/artifacts/prepare` answers which files the Console doesn't have yet, each of those goes up as
// `PUT /api/artifacts/blobs/:sha256`, and `PUT /api/artifacts/:slug` publishes the manifest. A re-share uploads only
// the files that changed. The wire shapes are in `contract.ts`.

const UPLOADS = 4
// Console's limits and slug rules (`packages/schema/src/artifact.ts`), checked here so a share it would refuse stops
// before any upload.
const MAX_SLUG = 54
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_BYTES = 100 * 1024 * 1024
const MAX_FILES = 500
const MIN_TTL_SECONDS = 3600
const MAX_TTL_SECONDS = 365 * 86_400

/** What stopped a command, in words for the person or agent that ran it. */
export class Failed extends Data.TaggedError("Artifact.Failed")<{ readonly message: string }> {}

/** The folder's files to share: it needs an index.html, dotfiles are skipped, and Console's limits hold. */
export function collect(folder: string, name?: string) {
  const root = path.resolve(folder)
  if (!existsSync(path.join(root, "index.html"))) throw new Failed({ message: `${root} has no index.html` })
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !file.split("/").some((part) => part.startsWith(".")))
    .sort()
  if (paths.length > MAX_FILES)
    throw new Failed({ message: `The folder has ${paths.length} files; keep a share to ${MAX_FILES}` })
  const sizes = paths.map((file) => statSync(path.join(root, file)).size)
  const big = paths.find((_, index) => sizes[index]! > MAX_FILE_BYTES)
  if (big) throw new Failed({ message: `${big} is over 25 MB, the per-file limit` })
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total > MAX_BYTES)
    throw new Failed({ message: `The folder is ${(total / 1024 / 1024).toFixed(1)} MB; keep a share under 100 MB` })
  const files = paths.map((file) => {
    const bytes = readFileSync(path.join(root, file))
    return { path: file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
  })
  const title = readFileSync(path.join(root, "index.html"), "utf8")
    .match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
    ?.slice(0, 200)
    .trim()
  return { slug: slugify(name ?? path.basename(root)), title: title || undefined, files }
}

// Lowercase letters, digits and single dashes, as Console names an artifact.
function slugify(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "")
  if (!slug) throw new Failed({ message: "Pass --name with letters, digits and dashes" })
  return slug
}

/** `12h`, `7d` or `2w`, in seconds, up to the year Console keeps an artifact at most. */
function ttlSeconds(ttl: string) {
  const match = /^(\d+)([hdw])$/.exec(ttl)
  const seconds = match ? Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "d" ? 86_400 : 604_800) : 0
  if (seconds < MIN_TTL_SECONDS || seconds > MAX_TTL_SECONDS)
    throw new Failed({ message: "--ttl takes 1h to 365d in hours, days or weeks, like 7d" })
  return seconds
}

/**
 * Shares `folder` as the workspace artifact `name` (the folder's name by default), uploading only the files the Console
 * doesn't have yet. Sharing over someone else's artifact of the same name needs `replace`.
 */
export const share = Effect.fnUntraced(function* (
  store: ConsoleStore.Info,
  folder: string,
  options: { readonly name?: string | undefined; readonly ttl?: string | undefined; readonly replace?: boolean } = {},
) {
  const collected = yield* attempt(() => ({
    ...collect(folder, options.name),
    ttl: options.ttl === undefined ? undefined : ttlSeconds(options.ttl),
  }))
  const credential = yield* signedIn(store)
  const replace = options.replace ? { replace: true } : {}
  const prepared = yield* call(
    credential,
    "POST",
    "/api/artifacts/prepare",
    {
      slug: collected.slug,
      files: collected.files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.length })),
      ...replace,
    } satisfies typeof Contract.ArtifactPrepare.Type,
    collected.slug,
  ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Contract.ArtifactPrepared)), Effect.scoped)
  const missing = new Set(prepared.missing)
  // Two files with the same bytes upload once.
  const uploads = [...new Map(collected.files.map((file) => [file.sha256, file])).values()].filter((file) =>
    missing.has(file.sha256),
  )
  yield* Effect.forEach(
    uploads,
    (file) =>
      call(credential, "PUT", `/api/artifacts/blobs/${file.sha256}`, file.bytes, collected.slug).pipe(Effect.scoped),
    { concurrency: UPLOADS, discard: true },
  )
  const published = yield* call(
    credential,
    "PUT",
    `/api/artifacts/${collected.slug}`,
    {
      ...(collected.title ? { title: collected.title } : {}),
      files: collected.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      ...(collected.ttl === undefined ? {} : { ttlSeconds: collected.ttl }),
      ...replace,
    } satisfies typeof Contract.ArtifactPublish.Type,
    collected.slug,
  ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Contract.ArtifactPublished)), Effect.scoped)
  return { ...published, files: collected.files.length, uploaded: uploads.length }
})

/** The workspace's live artifacts. */
export const list = Effect.fnUntraced(function* (store: ConsoleStore.Info) {
  const listed = yield* call(yield* signedIn(store), "GET", "/api/artifacts").pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Contract.ArtifactList)),
    Effect.scoped,
  )
  return listed.artifacts
})

/** Deletes the artifact `name`, which its creator and the workspace's owners and admins may do. */
export const remove = Effect.fnUntraced(function* (store: ConsoleStore.Info, name: string) {
  const slug = yield* attempt(() => slugify(name))
  yield* call(yield* signedIn(store), "DELETE", `/api/artifacts/${slug}`, undefined, slug).pipe(Effect.scoped)
  return { deleted: slug }
})

// A folder that can't be read, or input the Console would refuse anyway, stops the command before any request.
function attempt<A>(body: () => A) {
  return Effect.try({
    try: body,
    catch: (error) =>
      error instanceof Failed ? error : new Failed({ message: error instanceof Error ? error.message : String(error) }),
  })
}

const signedIn = Effect.fnUntraced(function* (store: ConsoleStore.Info) {
  const credential = yield* ConsoleCredentials.fresh(store)
  if (!credential)
    return yield* new Failed({ message: "Not signed in. Run `npx @opencode/console login` or set OPENCODE_API_KEY." })
  return credential
})

// The response when the Console took the request, otherwise what it said. `slug` names the artifact a 404 or 409 is
// about.
function call(
  credential: ConsoleClient.Credential,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  slug?: string,
) {
  return ConsoleClient.send(credential, method, path, body).pipe(
    Effect.flatMap((response) => (response.status < 300 ? Effect.succeed(response) : refused(response, method, slug))),
  )
}

function refused(response: HttpClientResponse.HttpClientResponse, method: string, slug: string | undefined) {
  return HttpClientResponse.schemaBodyJson(Contract.ArtifactProblem)(response).pipe(
    Effect.option,
    Effect.flatMap((problem) => {
      const body = Option.getOrUndefined(problem)
      const message =
        body?._tag === "ArtifactOwned"
          ? `${slug} belongs to ${body.owner}; pick another --name or pass --replace`
          : body?._tag === "ArtifactMissing"
            ? "OpenCode Console no longer has some of the files it just took; share again"
            : (body?.message ??
              (response.status === 403 && method === "DELETE"
                ? `Only the person who shared ${slug}, or a workspace owner or admin, can delete it`
                : response.status !== 404
                  ? `OpenCode Console answered ${response.status}`
                  : method === "DELETE"
                    ? `No artifact named ${slug}`
                    : "Artifacts are off for this OpenCode Console workspace"))
      return Effect.fail(new Failed({ message }))
    }),
  )
}
