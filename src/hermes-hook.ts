export * as HermesHook from "./hermes-hook"

import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { parse } from "yaml"
import { CodexHook } from "./codex-hook"
import type { PolicyEvaluator } from "./policy-evaluator"
import { SettingsFile } from "./settings-file"

/**
 * What setup's Hermes plugin (`<HERMES_HOME>/plugins/opencode-console`) pipes to `hook hermes`: the plugin hook that
 * fired (hermes-agent.nousresearch.com/docs/user-guide/features/hooks, "Plugin Hooks"), the session, and the tool call
 * or the turn's user message. Every Hermes session runs in one gateway process whose own directory is the install's, so
 * the plugin reads the directories from Hermes: the session's project (`ctx.session_cwd()`), the directory the task's
 * file tools resolve relative paths against (`_authoritative_workspace_root`, which follows a `cd`), the terminal's
 * (`get_session_cwd`), and the home `~` stands for (`get_subprocess_home`). It also names the Hermes home it runs for,
 * and with each turn the skills `skills.auto_load` puts in the system prompt, where `pre_llm_call` doesn't see them.
 */
const Event = Schema.Struct({
  hook_event_name: Schema.Literals(["pre_tool_call", "pre_llm_call"]),
  session_id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String),
  shell_cwd: Schema.optional(Schema.String),
  home_dir: Schema.optional(Schema.String),
  home: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(Schema.Unknown),
  /** The turn's message as Hermes sends `pre_llm_call` it: text, or a multimodal turn's content parts. */
  user_message: Schema.optional(Schema.Unknown),
  loaded_skills: Schema.optional(Schema.Array(Schema.String)),
})
export type Event = typeof Event.Type

export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Event))

/** A hook input this can't turn into checks, which the hook refuses rather than let through unchecked. */
export class Unreadable extends Error {}

export interface Where {
  /** The session's project directory, which paths outside of need `external_directory`. */
  readonly directory: string
  /** Where the task's file tools resolve relative paths, after any `cd`; the project directory by default. */
  readonly base?: string | undefined
  /** Where the task's terminal runs a command that names no `workdir`; `base` by default. */
  readonly shell?: string | undefined
  /** The directory `~` stands for; the user's home by default. */
  readonly home?: string | undefined
  /** The workspace's MCP servers, by the names setup gave Hermes. */
  readonly servers: readonly string[]
  /**
   * The folders skills live in: setup's for the workspace's, and the profile's own `<HERMES_HOME>/skills`. Reading a
   * file in a skill's folder there loads that skill.
   */
  readonly skills?: readonly string[] | undefined
}

/**
 * The checks a Hermes tool call needs, in OpenCode's permission vocabulary, all of which must allow it. Hermes's tools
 * (`toolsets.py`, `tools/*.py` in NousResearch/hermes-agent) map to the permission OpenCode's own tool asks for, with
 * paths named as Hermes names them (`~` is the home, relative paths follow the task's `cd`):
 * - `terminal` → `shell` where it runs, plus `edit` on the files a V4A patch in the command names; `write_file` and
 *   `patch` (its `path`, and in V4A mode every file the patch names) → `edit`; `read_file` → `read`, except a file in
 *   a skill's folder, which is that skill's `skill` check; `search_files` → `glob` (its `files` target) or `grep`,
 *   where it searches;
 * - `web_search` and `x_search` → `websearch`; `web_extract` → `webfetch` on each URL; `vision_analyze`,
 *   `video_analyze` and `desktop_preview` → `webfetch` for a URL (a bare domain in `desktop_preview` included), `read`
 *   for a file (`file://` URLs included);
 * - `execute_code`, `browser_exec` and `computer_use` run code or drive the machine where no scanner reads, so they're
 *   checked as a shell command that can't be analyzed and as reading, editing and fetching anything; `process_manage`
 *   writing to a running process is such a command too; `browser_cdp` and `drive_preview` drive a browser, which can
 *   fetch anything (`browser_cdp` also reads the files it uploads and writes downloads);
 * - `skill_view` and the skills `skill_manage`, `cronjob_manage` and `kanban_create` name → `skill`; a cron job's
 *   script or monitor script is a command no scanner reads, and its monitor URL a `webfetch`; `delegate_task` →
 *   `subagent` on each task's role (`general` by default); `clarify` → `question`;
 * - `mcp__<server>__<tool>` → its server's `mcp.use` and the tool's `<server>_<tool>`; `connectors__<app>__<tool>`
 *   and `manage_connections`' targets → `mcp.use` on the app. Any other tool, and those of the above that have no
 *   OpenCode counterpart, are also checked by their lowercased name.
 */
export function checks(event: Event, where: Where): PolicyEvaluator.Input[] {
  if (event.hook_event_name === "pre_llm_call") {
    const skills = [...new Set([...promptSkills(event.user_message, where.skills), ...(event.loaded_skills ?? [])])]
    return skills.length === 0 ? [] : [check(where, "skill", skills)]
  }
  const tool = event.tool_name
  if (!tool) throw new Unreadable("The hook input names no tool")
  const input = SettingsFile.record(event.tool_input)
  const optional = (name: string) => SettingsFile.text(input[name])
  const field = (name: string) => {
    const value = optional(name)
    if (value === undefined) throw new Unreadable(`${tool}'s input has no ${name}`)
    return value
  }
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : []
  const at = (file: string) => local(where, where.base ?? where.directory, file)
  const named = check(where, tool.toLowerCase(), ["*"])
  // Anything that can fetch any URL, read any file or edit any file.
  const any = (action: "read" | "edit" | "webfetch") => check(where, `${action}:`, ["*"], { truncated: true })
  // Code no scanner reads can run any command and reach any file or URL.
  const opaque = (code: string | undefined) => [
    check(where, "shell", [code ?? ""], { opaque: true }),
    any("read"),
    any("edit"),
    any("webfetch"),
  ]
  if (tool.startsWith("mcp__")) return mcpChecks(tool, where)
  if (tool.startsWith("connectors__")) {
    const parts = tool.split("__")
    const app = parts[1]
    const rest = parts.slice(2).join("__")
    if (parts.length < 3 || !app || !rest) throw new Unreadable(`Can't tell which app ${tool} belongs to`)
    return [check(where, "mcp.use", [app], { folded: true }), check(where, `${app}_${rest}`, ["*"], { folded: true })]
  }
  switch (tool) {
    case "terminal": {
      const command = field("command")
      const workdir = optional("workdir")
      const shell = where.shell ?? where.base ?? where.directory
      const cwd = workdir === undefined ? shell : local(where, shell, workdir)
      const edited = command.includes("*** Begin Patch")
        ? CodexHook.patchFiles(command, cwd, (file) => local(where, cwd, file))
        : []
      return [
        check(where, "shell", [command], cwd === where.directory ? {} : { path: cwd }),
        ...(edited.length === 0 ? [] : [check(where, "edit", edited)]),
      ]
    }
    case "process_manage": {
      const action = optional("action")
      // Writing to a background process's stdin runs whatever that shell reads.
      return action === "write" || action === "submit"
        ? [check(where, "shell", [optional("data") ?? ""], { opaque: true }), named]
        : [named]
    }
    case "execute_code":
    case "browser_exec":
      return [...opaque(optional("code")), named]
    case "computer_use":
      return [...opaque(undefined), named]
    case "browser_cdp": {
      const method = field("method")
      const params = SettingsFile.record(input.params)
      const url = SettingsFile.text(params.url)
      return [
        url === undefined ? any("webfetch") : check(where, "webfetch", [url]),
        // A file input set from local files uploads them; a download path is where the browser writes.
        ...(method === "DOM.setFileInputFiles" ? [check(where, "read", strings(params.files).map(at))] : []),
        ...(method.endsWith("setDownloadBehavior") ? [any("edit")] : []),
        named,
      ].filter((item) => item.resources.length > 0)
    }
    case "drive_preview":
      return [any("webfetch"), named]
    case "read_file":
      return [read(where, at(field("path")))]
    case "write_file":
      return [check(where, "edit", [at(field("path"))])]
    case "patch": {
      const file = optional("path")
      if (optional("mode") !== "patch") return [check(where, "edit", [at(field("path"))])]
      // Hermes checks `path` beside every file the patch names.
      const edited = [
        ...(file === undefined ? [] : [at(file)]),
        ...CodexHook.patchFiles(optional("patch") ?? "", where.base ?? where.directory, at),
      ]
      if (edited.length === 0) throw new Unreadable("The patch names no file")
      return [check(where, "edit", [...new Set(edited)])]
    }
    case "search_files": {
      const kind = optional("target") === "files" || optional("target") === "find" ? "glob" : "grep"
      return [check(where, kind, [field("pattern")], { path: at(optional("path") ?? ".") })]
    }
    case "web_search":
      return [check(where, "websearch", [field("query")])]
    case "x_search":
      return [check(where, "websearch", [field("query")]), named]
    case "web_extract": {
      const urls = strings(input.urls)
      if (urls.length === 0) throw new Unreadable("web_extract's input has no urls")
      return [check(where, "webfetch", urls)]
    }
    case "vision_analyze":
      return media(where, field("image_url"))
    case "video_analyze":
      return media(where, field("video_url"))
    case "desktop_preview": {
      const url = optional("url")
      return [...(url === undefined ? [] : preview(where, url)), named]
    }
    case "skill_view":
      return [check(where, "skill", [field("name").replace(/^plugin:/, "")])]
    case "skill_manage": {
      const operations = Array.isArray(input.operations) ? input.operations : []
      const skills = [...operations.map((item) => SettingsFile.record(item).name), input.name].filter(
        (name): name is string => typeof name === "string" && name !== "",
      )
      return [...(skills.length === 0 ? [] : [check(where, "skill", [...new Set(skills)])]), named]
    }
    case "cronjob_manage": {
      const skills = [...new Set([...strings(input.skills), ...strings([input.skill])])]
      const workdir = optional("workdir")
      // A job runs its scripts unattended where no scanner reads them; `monitor` is a URL or a script
      // (`tools/cronjob_job_args.py`, `_split_monitor_arg`), with `monitor_script` and `monitor_url` its older names.
      const monitor = optional("monitor")
      const url = monitor !== undefined && /^https?:\/\//i.test(monitor) ? monitor : optional("monitor_url")
      const scripts = [
        optional("script"),
        monitor !== undefined && url !== monitor ? monitor : optional("monitor_script"),
      ].flatMap((script) => script ?? [])
      return [
        check(where, tool, [optional("action") ?? "*"], workdir === undefined ? {} : { directories: [at(workdir)] }),
        ...(skills.length === 0 ? [] : [check(where, "skill", skills)]),
        ...scripts.map((script) => check(where, "shell", [script], { opaque: true })),
        ...(url === undefined ? [] : [check(where, "webfetch", [url])]),
      ]
    }
    case "kanban_create": {
      const skills = strings(input.skills)
      return [...(skills.length === 0 ? [] : [check(where, "skill", skills)]), named]
    }
    case "delegate_task": {
      const action = optional("action")
      if (action !== undefined && action !== "spawn") return [check(where, tool, [action])]
      const tasks = Array.isArray(input.tasks) ? input.tasks.map((item) => SettingsFile.record(item)) : []
      const roles = (tasks.length === 0 ? [input] : tasks).map(
        (task) => SettingsFile.text(task.role)?.trim().toLowerCase() || "general",
      )
      const directories = tasks.flatMap((task) => SettingsFile.text(task.workdir) ?? []).map(at)
      return [check(where, "subagent", [...new Set(roles)], directories.length === 0 ? {} : { directories })]
    }
    case "clarify":
      return [check(where, "question", ["*"])]
    case "desktop_project": {
      const project = optional("path")
      return [
        check(where, tool, [optional("action") ?? "*"], project === undefined ? {} : { directories: [at(project)] }),
      ]
    }
    case "manage_connections": {
      // Each target is a name, or `{ name, mcp }` for an MCP server; Hermes lowercases them (`tools/connectors/targets.py`).
      const apps = (Array.isArray(input.connectors) ? input.connectors : [input.connectors]).flatMap((item) => {
        const name = typeof item === "string" ? item : SettingsFile.record(item).name
        return typeof name === "string" && name.trim() !== "" ? [name.trim().toLowerCase()] : []
      })
      return [...(apps.length === 0 ? [] : [check(where, "mcp.use", [...new Set(apps)], { folded: true })]), named]
    }
    default:
      // Hermes's other tools have no OpenCode counterpart; a rule naming one, or every tool, still applies.
      return [named]
  }
}

function check(where: Where, action: string, resources: readonly string[], extra: Partial<PolicyEvaluator.Input> = {}) {
  return { action, resources, directory: where.directory, ...extra }
}

/**
 * A path as Hermes's file tools name it (`tools/file_tools_paths.py`): `~` and `~/…` are the home, and anything
 * relative is under `base`. Another user's home (`~name`) isn't known here, so it's refused.
 */
function local(where: Where, base: string, file: string) {
  const home = where.home ?? os.homedir()
  if (file === "~") return home
  if (/^~[\\/]/.test(file)) return path.join(home, file.slice(2))
  if (file.startsWith("~")) throw new Unreadable(`Can't tell where ${file} is`)
  return path.resolve(base, file)
}

// Reading a file in a skill's folder loads that skill.
function read(where: Where, file: string) {
  const skill = skillOf(where.skills ?? [], file)
  return skill ? check(where, "skill", [skill]) : check(where, "read", [file])
}

/**
 * The skill a file belongs to: the nearest folder above it, inside one of `roots`, that holds a `SKILL.md`, by the
 * `name` its frontmatter gives, else by the folder's name, as Hermes names skills.
 */
export function skillOf(roots: readonly string[], file: string) {
  return roots.flatMap((root) => {
    const relative = path.relative(root, file)
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return []
    const folders = relative
      .split(path.sep)
      .slice(0, -1)
      .map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1)))
      .toReversed()
    // A path naming the folder itself, with no file in it, is the folder.
    const candidates = existsSync(path.join(file, "SKILL.md")) ? [file, ...folders] : folders
    const folder = candidates.find((item) => existsSync(path.join(item, "SKILL.md")))
    return folder ? [skillName(folder)] : []
  })[0]
}

function skillName(folder: string) {
  const frontmatter = (readText(path.join(folder, "SKILL.md")) ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  const data = SettingsFile.record(
    frontmatter === undefined
      ? undefined
      : Effect.runSync(Effect.try(() => parse(frontmatter)).pipe(Effect.orElseSucceed(() => undefined))),
  )
  return SettingsFile.text(typeof data.name === "string" ? data.name.trim() : undefined) ?? path.basename(folder)
}

function readText(file: string) {
  return Effect.runSync(Effect.try(() => readFileSync(file, "utf8")).pipe(Effect.orElseSucceed(() => undefined)))
}

/**
 * An image or video Hermes's vision tools read (`tools/image_source.py`): an http(s) URL is fetched, a `data:` URL is
 * inline, any other scheme is refused by Hermes and checked as a fetch, and anything else, a `file://` URL with the
 * prefix taken off, is a file.
 */
function media(where: Where, value: string): PolicyEvaluator.Input[] {
  const source = value.trim()
  if (source.startsWith("data:")) return []
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source) && !/^file:\/\//i.test(source))
    return [check(where, "webfetch", [source])]
  return [read(where, local(where, where.base ?? where.directory, source.replace(/^file:\/\//i, "")))]
}

/**
 * What `desktop_preview` opens (`tools/open_preview_tool.py`, `_normalize_target` and `_local_fs_path`): a URL with a
 * scheme is fetched, except a `file:` URL, which is its file; a path is read; a bare host or domain is fetched as
 * Hermes completes it (`localhost:3000` as `http://localhost:3000`, `example.com` as `https://example.com`).
 */
function preview(where: Where, raw: string): PolicyEvaluator.Input[] {
  const target = raw
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
  const base = where.base ?? where.directory
  if (target === "") return []
  if (target.includes("://")) {
    const url = URL.parse(target)
    if (url?.protocol !== "file:") return [check(where, "webfetch", [target])]
    const file = decodeURIComponent(url.pathname)
    return [
      read(where, url.host === "" || url.host === "localhost" ? local(where, base, file) : `//${url.host}${file}`),
    ]
  }
  if (/^(?:\/|\.\/|\.\.\/|~|file:)/.test(target)) return [read(where, local(where, base, target))]
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(target))
    return [check(where, "webfetch", [`http://${target}`])]
  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(target)) return [check(where, "webfetch", [`https://${target}`])]
  return [read(where, local(where, base, target))]
}

/**
 * An MCP tool's checks. Hermes names it `mcp__<server>__<tool>` with every character but letters, digits and `_` as `_`,
 * and clamps a name past 64 characters to 55 of them, `_` and 8 hex digits of its SHA-256
 * (`tools/mcp_tool_schema.py`, `mcp_prefixed_tool_name`). A workspace server is matched by its name, the longest
 * first since a name can hold `__`; another is split at the first `__`, with `-` and `_` alike. A clamped tool name
 * isn't known, so it's denied while any rule could deny one of that server's tools. The utility tools
 * (`list_resources`, `read_resource`, `list_prompts`, `get_prompt`) are the server's too.
 */
function mcpChecks(tool: string, where: Where): PolicyEvaluator.Input[] {
  const known = where.servers
    .filter((server) => tool.startsWith(`mcp__${sanitize(server)}__`))
    .toSorted((left, right) => right.length - left.length)[0]
  const split = tool.match(/^mcp__(.+?)__(.+)$/)
  const server = known ?? split?.[1]
  if (!server) throw new Unreadable(`Can't tell which MCP server ${tool} belongs to`)
  const rest = known ? tool.slice(`mcp__${sanitize(known)}__`.length) : split![2]!
  const clamped = tool.length === 64 && /_[0-9a-f]{8}$/.test(tool)
  return [
    check(where, "mcp.use", [server], known ? {} : { folded: true }),
    clamped
      ? check(where, `${server}_`, ["*"], { truncated: true, folded: true })
      : check(where, `${server}_${rest}`, ["*"], { folded: true }),
  ]
}

function sanitize(name: string) {
  return name.replace(/[^A-Za-z0-9_]/g, "_")
}

/**
 * The skills a turn's message loads, as Hermes writes them into it before `pre_llm_call` (`agent/skill_commands.py`):
 * `/name` (`The user has invoked the "<name>" skill`), stacked `/a /b` and `/bundle` (`Skills loaded: a, b`), the
 * gateway's channel skills (`The "<name>" skill is auto-loaded`), and any skill's folder the message names
 * (`[Skill directory: <folder>]`). Text that only quotes one of these can only add a check.
 */
export function promptSkills(message: unknown, skills: readonly string[] = []) {
  const texts =
    typeof message === "string"
      ? [message]
      : Array.isArray(message)
        ? message.flatMap((part) => SettingsFile.text(SettingsFile.record(part).text) ?? [])
        : []
  const names = texts.flatMap((text) => [
    // A bundle's header names what was typed (`the "/a /b" stacked skill bundle`); its skills are in `Skills loaded`.
    ...Array.from(text.matchAll(/\[IMPORTANT: The user has invoked the "([^"]+)" skill,/g), (match) => match[1]!),
    ...Array.from(text.matchAll(/\[IMPORTANT: The "([^"]+)" skill is auto-loaded/g), (match) => match[1]!),
    ...Array.from(text.matchAll(/^Skills loaded: (.+)$/gm), (match) =>
      match[1]!.split(",").map((name) => name.trim()),
    ).flat(),
    ...Array.from(text.matchAll(/\[Skill directory: ([^\]\n]+)\]/g), (match) =>
      skillOf(skills, path.join(match[1]!.trim(), "SKILL.md")),
    ).flatMap((name) => name ?? []),
  ])
  return [...new Set(names.filter((name) => name !== ""))]
}
