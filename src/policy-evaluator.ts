export * as PolicyEvaluator from "./policy-evaluator"

import { existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ConfigIntegration } from "@opencode/core/config/integration"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { ShellParse } from "@opencode/core/shell/parse"
import { Wildcard } from "@opencode/core/util/wildcard"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { IntegrationID } from "@opencode/schema/integration-id"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Result, Schema } from "effect"
import { ConsoleStore } from "./store"

/**
 * One check, in OpenCode's permission vocabulary. `action` is a policy action such as `mcp.use` or `skill.use`,
 * decided per resource, or a tool permission such as `shell`, `edit`, `read`, `glob` or `external_directory`, matched
 * against `tool.use` statements as `<action>:<resource>`.
 */
export interface Input {
  readonly action: string
  readonly resources: readonly string[]
  /**
   * The harness's working directory, defaulting to this process's. Paths resolve against it, and anything outside it
   * and its repository needs `external_directory`.
   */
  readonly directory?: string | undefined
  /** Where a `shell` command runs, or where `glob` and `grep` search, when that isn't the working directory. */
  readonly path?: string | undefined
  /**
   * Other directories the call works in, such as a subagent's or terminal's working directory, each of which needs
   * `external_directory` when it's outside the project.
   */
  readonly directories?: readonly string[] | undefined
  /** The shell a `shell` command runs in, such as `zsh` or `pwsh`. Defaults to `$SHELL`. */
  readonly shell?: string | undefined
  /**
   * The harness wrote `-` in the names as `_`, as Pi does in MCP tool names, so statements match with the two alike.
   * A name that could be either is checked as both, which can only deny more.
   */
  readonly folded?: boolean | undefined
  /**
   * The harness shortened the name, as Pi does past 64 characters, so only `action` is known as its start: denied while
   * any statement could deny a name that starts with it, with `-` and `_` alike when `folded` too.
   */
  readonly truncated?: boolean | undefined
  /**
   * A `shell` check whose code no scanner can read, such as a program the harness runs (DeepSeek Harness's `run_code`):
   * denied while any statement could deny a shell command or directory, as a command the scanner can't analyze is.
   */
  readonly opaque?: boolean | undefined
}

/**
 * The workspace a check runs for. `policies` is `undefined` while they are unknown, such as before the first fetch,
 * and `status` says why the sign-in needs the member, such as an expired SSO session.
 */
export interface Workspace {
  readonly organization?: string | undefined
  readonly policies: readonly ConfigPolicy.Info[] | undefined
  readonly status?: { readonly message: string; readonly url?: string | undefined } | undefined
}

export type Decision = { readonly effect: "allow" } | { readonly effect: "deny"; readonly message: string }

const allow: Decision = { effect: "allow" }
const isAction = Schema.is(ConfigPolicy.Action)

/**
 * Decides a check against a workspace's policy statements with OpenCode's semantics: statements apply in order, the
 * last match wins, nothing matching allows, and a denial names the workspace. Tool checks name files and directories
 * the way OpenCode's tools do, including the `external_directory` check for anything outside the project.
 *
 * A shell command the scanner can't analyze is denied while any statement could deny a shell command or directory,
 * since its parts can't be checked. A signed-in workspace whose policy hasn't loaded denies everything until it does.
 */
export const check = Effect.fn("PolicyEvaluator.check")(function* (workspace: Workspace, input: Input) {
  if (!workspace.policies) return pending(workspace)
  // A check that names nothing can't be decided, so a harness that sent the wrong shape is refused.
  if (input.resources.length === 0)
    return { effect: "deny" as const, message: "Nothing to check: the request names no resources" }
  if (workspace.policies.length === 0) return allow
  const statements = compile(workspace, workspace.policies)
  // `tool.use` resources carry the tool's raw input, which must be parsed before it can be checked.
  if (input.action === "tool.use")
    return { effect: "deny" as const, message: 'Check tool calls by tool name, such as "shell", not "tool.use"' }
  const folded = input.folded
    ? statements.map((policy) => ({ ...policy, resource: fold(policy.resource) }))
    : statements
  if (input.truncated) {
    const prefix = input.folded ? fold(input.action) : input.action
    return decide(folded.find((policy, index) => activeDeny(folded, policy, index, prefix)))
  }
  if (input.folded) {
    return isAction(input.action)
      ? decide(matching(folded, input.action, input.resources.map(fold)))
      : decide(denying(folded, fold(input.action), input.resources.map(fold)))
  }
  if (isAction(input.action)) return decide(matching(statements, input.action, input.resources))

  const location = locate(input.directory ?? process.cwd())
  const elsewhere = denying(
    statements,
    "external_directory",
    (input.directories ?? []).flatMap((directory) => target(location, directory, "directory").external ?? []),
  )
  if (elsewhere) return decide(elsewhere)
  if (input.action === "shell") return yield* shell(statements, location, input)
  // OpenCode's write and patch tools ask for the `edit` permission, so `edit:` rules decide them.
  const permission = input.action === "write" || input.action === "patch" ? "edit" : input.action
  if (permission === "read" || permission === "edit") {
    const targets = input.resources.map((resource) =>
      target(location, resource, permission === "edit" ? "file" : undefined),
    )
    return decide(
      denying(
        statements,
        "external_directory",
        targets.flatMap((item) => item.external ?? []),
      ) ??
        denying(
          statements,
          permission,
          targets.map((item) => item.resource),
        ),
    )
  }
  if (input.action === "glob" || input.action === "grep") {
    const searched = target(location, input.path ?? ".", input.action === "glob" ? "directory" : undefined)
    return decide(
      denying(statements, "external_directory", searched.external ? [searched.external] : []) ??
        denying(statements, input.action, input.resources),
    )
  }
  // A skill needs both its `skill.use` statement and the `skill` tool permission, as in OpenCode.
  if (input.action === "skill")
    return decide(matching(statements, "skill.use", input.resources) ?? denying(statements, "skill", input.resources))
  return decide(denying(statements, input.action, input.resources))
})

export type Statement = ReturnType<typeof ManagedPolicy.statements>[number]
type Location = { readonly directory: string; readonly root?: string }

/**
 * The workspace's policy statements, in the same order and with the same denial message as OpenCode builds from a
 * Console config document, or undefined while the policies are unknown.
 */
export function statements(workspace: Workspace) {
  return workspace.policies && compile(workspace, workspace.policies)
}

function compile(workspace: Workspace, policies: readonly ConfigPolicy.Info[]) {
  return ManagedPolicy.statements([
    ConfigIntegration.make({
      integrationID: IntegrationID.make("opencode"),
      connection: { type: "env", name: "OPENCODE_API_KEY" },
      ...(workspace.organization === undefined ? {} : { organization: workspace.organization }),
      info: { policies: [...policies] },
    }),
  ])
}

const shell = Effect.fnUntraced(function* (statements: Statement[], location: Location, input: Input) {
  if (input.opaque) return unanalyzable(statements)
  const cwd = target(location, input.path ?? ".", "directory")
  const scanned = yield* Effect.forEach(
    input.resources,
    (command) =>
      ShellParse.scan(
        command,
        input.shell ?? process.env.SHELL ?? (process.platform === "win32" ? "powershell" : "sh"),
        cwd.absolute,
      ).pipe(Effect.result),
    { concurrency: 1 },
  )
  if (scanned.some(Result.isFailure)) return unanalyzable(statements)
  const parsed = scanned.filter(Result.isSuccess).map((item) => item.success)
  const directories = parsed.flatMap((item) =>
    item.directories.map((entry) => target(location, resolvePath(cwd.absolute, entry), "directory")),
  )
  return decide(
    denying(
      statements,
      "external_directory",
      [cwd, ...directories].flatMap((item) => item.external ?? []),
    ) ??
      denying(
        statements,
        "shell",
        parsed.flatMap((item) => item.commands.map((command) => command.resource)),
      ),
  )
})

// Code that can't be checked part by part is denied while any statement could deny a shell command or directory.
function unanalyzable(statements: Statement[]) {
  return decide(
    statements.find((policy, index) =>
      ["shell:", "external_directory:"].some((prefix) => activeDeny(statements, policy, index, prefix)),
    ),
  )
}

/**
 * The `tool.use` statement denying a permission check, exactly as OpenCode's policy plugin decides one: the last
 * statement matching `<action>:<resource>` wins, and a check covering several resources, such as the commands of a
 * compound shell line, is denied when any one of them is.
 */
function denying(statements: Statement[], action: string, resources: readonly string[]) {
  return resources
    .map((resource) =>
      statements.findLast(
        (policy) => policy.action === "tool.use" && Wildcard.match(`${action}:${resource}`, policy.resource),
      ),
    )
    .find((policy) => policy?.effect === "deny")
}

function matching(statements: Statement[], action: ConfigPolicy.Action, resources: readonly string[]) {
  return resources
    .map((resource) => ManagedPolicy.match(statements, action, resource))
    .find((policy) => policy?.effect === "deny")
}

function decide(policy: { readonly effect: ConfigPolicy.Effect; readonly message: string } | undefined): Decision {
  return policy?.effect === "deny" ? { effect: "deny", message: policy.message } : allow
}

function pending(workspace: Workspace): Decision {
  if (workspace.status)
    return {
      effect: "deny",
      message: workspace.status.url ? `${workspace.status.message}: ${workspace.status.url}` : workspace.status.message,
    }
  return {
    effect: "deny",
    message: `Blocked until ${workspace.organization ?? "your workspace"}'s policy loads from OpenCode Console`,
  }
}

/** The working directory and the repository around it, which OpenCode also treats as inside the project. */
function locate(directory: string): Location {
  const absolute = path.resolve(directory)
  // The same markers and walk as OpenCode's `Project.root`, without its runtime dependencies.
  for (let current = absolute; ; current = path.dirname(current)) {
    if ([".git", ".hg"].some((marker) => existsSync(path.join(current, marker))))
      return { directory: absolute, root: current }
    if (path.dirname(current) === current) return { directory: absolute }
  }
}

/**
 * How OpenCode's `FileAccess.resolve` names a path: relative to the working directory inside the project, absolute
 * outside it, where its directory (the path itself when it is one) also needs `external_directory`.
 */
function target(location: Location, input: string, kind: "file" | "directory" | undefined) {
  const absolute = resolvePath(location.directory, input)
  const root = location.root
  const internal =
    FSUtil.contains(location.directory, absolute) ||
    (root !== undefined && root !== path.parse(root).root && FSUtil.contains(root, absolute))
  if (internal) return { absolute, resource: slash(path.relative(location.directory, absolute) || ".") }
  const directory =
    (kind ?? (isDirectory(absolute) ? "directory" : "file")) === "directory" ? absolute : path.dirname(absolute)
  return { absolute, resource: slash(absolute), external: slash(path.join(directory, "*")) }
}

// A path that is missing or can't be read is named as a file, as OpenCode names a missing one.
function isDirectory(file: string) {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isDirectory() === true
  } catch (error) {
    if (ConsoleStore.unreachable(error)) return false
    throw error
  }
}

// OpenCode's `FileAccess.resolvePath`: a leading `~` is the home directory, and Windows shell paths are normalized
// before lexical resolution. `@opencode/core/file-access` exports it, but importing that module loads OpenCode's whole
// permission and environment runtime on every check. The home directory is the OS's, as ShellParse expands it.
function resolvePath(directory: string, input: string) {
  const normalized = FSUtil.windowsPath(input)
  return path.resolve(
    directory,
    normalized === "~"
      ? os.homedir()
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(os.homedir(), normalized.slice(2))
        : normalized,
  )
}

/**
 * Whether the deny at `index` could match some resource starting with `prefix` and isn't lifted for all of them by a
 * later allow, as the Console writes an "only" rule: deny everything, then allow `shell:*`.
 */
function activeDeny(statements: Statement[], policy: Statement, index: number, prefix: string) {
  if (policy.action !== "tool.use" || policy.effect !== "deny" || !couldMatch(policy.resource, prefix)) return false
  return !statements
    .slice(index + 1)
    .some(
      (later) =>
        later.action === "tool.use" &&
        later.effect === "allow" &&
        (later.resource === "*" || caseless(later.resource) === caseless(`${prefix}*`)),
    )
}

/** Whether a resource pattern could match some resource starting with `prefix`. */
export function couldMatch(pattern: string, prefix: string) {
  const literal = caseless(pattern.split(/[*?]/, 1)[0] ?? "")
  return caseless(prefix).startsWith(literal) || literal.startsWith(caseless(prefix))
}

// `Wildcard.match` ignores case on Windows.
function caseless(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value
}

// `-` and `_` alike, for names a harness wrote with `_` in place of `-`.
function fold(value: string) {
  return value.replaceAll("-", "_")
}

function slash(value: string) {
  return value.replaceAll("\\", "/")
}
