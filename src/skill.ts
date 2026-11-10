export * as Skill from "./skill"

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { parse, stringify } from "yaml"
import { ConsoleClient } from "./console-client"
import { SettingsFile } from "./settings-file"

export type Info = { readonly slug: string; readonly version: string }
export type Bundle = {
  readonly slug: string
  readonly version: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string | Uint8Array }>
}

/**
 * Downloads the skills that need writing to `directory`: those whose version changed since `known` recorded it, and
 * those missing from it. A folder there that `known` doesn't name is the member's own skill, which stays.
 */
export const fetchChanged = Effect.fn("Skill.fetchChanged")(function* (
  credential: ConsoleClient.Credential,
  directory: string,
  wanted: readonly Info[],
  known: Readonly<Record<string, string>>,
) {
  return yield* Effect.forEach(
    wanted.filter((skill) => {
      const written = existsSync(path.join(directory, skill.slug))
      if (written && !(skill.slug in known)) return false
      return known[skill.slug] !== skill.version || !written
    }),
    (skill) =>
      Effect.gen(function* () {
        const bundle = yield* ConsoleClient.fetchSkill(credential, skill.slug)
        const files = yield* Effect.forEach(
          bundle.files,
          (file) =>
            file.kind === "text"
              ? Effect.succeed({ path: file.path, content: file.content as string | Uint8Array })
              : ConsoleClient.fetchSkillBlob(credential, skill.slug, file.sha256).pipe(
                  Effect.map((content) => ({ path: file.path, content: content as string | Uint8Array })),
                ),
          { concurrency: 4 },
        )
        return { slug: skill.slug, version: skill.version, files } satisfies Bundle
      }),
    { concurrency: 2 },
  )
})

/**
 * Brings `directory` up to date with the skills the member may use: deletes the ones `known` recorded that are no
 * longer offered, writes the downloaded `bundles`, and leaves a folder setup didn't write alone. Returns the versions
 * now written, and the slugs left alone as `/<slug>`.
 */
export function write(
  directory: string,
  wanted: readonly Info[],
  bundles: readonly Bundle[],
  known: Readonly<Record<string, string>>,
  options: { readonly named?: boolean } = {},
) {
  const skills: Record<string, string> = {}
  const skipped: string[] = []
  Object.keys(known)
    .filter((slug) => !wanted.some((skill) => skill.slug === slug))
    .forEach((slug) => rmSync(path.join(directory, slug), { recursive: true, force: true }))
  wanted.forEach((skill) => {
    const folder = path.join(directory, skill.slug)
    if (existsSync(folder) && !(skill.slug in known)) {
      skipped.push(`/${skill.slug}`)
      return
    }
    const bundle = bundles.find((item) => item.slug === skill.slug)
    if (bundle) writeSkill(folder, bundle.files, options.named ? skill.slug : undefined)
    skills[skill.slug] = bundle?.version ?? known[skill.slug] ?? skill.version
  })
  return { skills, skipped }
}

// Skills are written as Agent Skills harnesses read them: the folder names the command, and a skill OpenCode
// only runs when asked (`opencode/autoinvoke: false`) is one the model doesn't load on its own
// (`disable-model-invocation`).
function writeSkill(
  directory: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: string | Uint8Array }>,
  name: string | undefined,
) {
  const staging = `${directory}.${randomUUID()}.tmp`
  const retired = `${directory}.${randomUUID()}.old`
  mkdirSync(staging, { recursive: true })
  try {
    files.forEach((file) => {
      // Console checks skill paths when they're saved; one that isn't a plain relative path is skipped here anyway.
      const parts = file.path.split(/[\\/]/)
      if (file.path === "" || path.isAbsolute(file.path) || parts.some((part) => part === ".." || part === "")) return
      const content =
        file.path === "SKILL.md" && typeof file.content === "string"
          ? name === undefined
            ? markdown(file.content)
            : namedMarkdown(file.content, name)
          : file.content
      SettingsFile.writeFile(path.join(staging, file.path), content)
    })
    if (existsSync(directory)) renameSync(directory, retired)
    renameSync(staging, directory)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(retired, { recursive: true, force: true })
  }
}

function markdown(text: string) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return text
  const lines = match[1]!.split("\n")
  const manual = lines.some((line) => /^\s*"?opencode\/autoinvoke"?:\s*false\s*$/.test(line))
  const kept = lines.filter((line, index) => {
    if (line.startsWith("name:")) return false
    if (/^metadata:\s*$/.test(line)) return lines[index + 1]?.trim().startsWith('"opencode/autoinvoke"') !== true
    return !/^\s+"opencode\/autoinvoke":/.test(line)
  })
  const frontmatter = [...kept, ...(manual ? ["disable-model-invocation: true"] : [])]
  const body = text.slice(match[0].length)
  return frontmatter.length === 0 ? body.replace(/^\n/, "") : `---\n${frontmatter.join("\n")}\n---\n${body}`
}

/**
 * A skill's `SKILL.md` for a harness that names a skill by its frontmatter and requires a description, as DeepSeek
 * Harness does (`@deepseek-ai/dsh-skill-filesystem`, `parseSkillFile`): `name` is the slug, and a skill without a
 * description is described by its title, else its slug. A skill OpenCode only runs when asked is one the model
 * doesn't load on its own (`disable-model-invocation`).
 */
function namedMarkdown(text: string, slug: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const frontmatterText = match?.[1]
  // Frontmatter that isn't YAML is described by the slug alone, as one with no frontmatter is.
  const data = SettingsFile.record(
    frontmatterText === undefined
      ? undefined
      : Effect.runSync(Effect.try(() => parse(frontmatterText)).pipe(Effect.orElseSucceed(() => undefined))),
  )
  const metadata = SettingsFile.record(data.metadata)
  const manual = metadata["opencode/autoinvoke"] === false || data["opencode/autoinvoke"] === false
  delete metadata["opencode/autoinvoke"]
  const rest = Object.fromEntries(
    Object.entries(data).filter(([key]) => !["name", "description", "metadata", "opencode/autoinvoke"].includes(key)),
  )
  const trimmed = (value: unknown) => SettingsFile.text(typeof value === "string" ? value.trim() : undefined)
  const frontmatter = {
    name: slug,
    description: trimmed(data.description) ?? trimmed(data.name) ?? slug,
    ...rest,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(manual ? { "disable-model-invocation": true } : {}),
  }
  const body = match ? text.slice(match[0].length) : text
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`
}
