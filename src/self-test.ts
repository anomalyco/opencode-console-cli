export * as SelfTest from "./self-test"

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { version } from "../package.json" with { type: "json" }
import { BuildInfo } from "./build-info"
import { PolicyEvaluator } from "./policy-evaluator"

/**
 * What a build must do before it replaces the installed one, since every agent's policy hooks fail closed on it: decide
 * an allowed call and a compound command a policy denies part of, in bash and PowerShell, load every agent's hook and setup code, and, in a
 * binary, carry a Pi extension and a DeepSeek Harness plugin that load. Returns the problems found; none means it passed.
 */
export async function problems() {
  const workspace: PolicyEvaluator.Workspace = {
    organization: "Self-test",
    policies: [{ action: "tool.use", resource: "shell:rm *", effect: "deny" }],
  }
  const decisions = await Effect.runPromise(
    Effect.forEach(
      [
        { action: "read", resources: ["README.md"] },
        { action: "shell", resources: ["echo ok && rm -rf ./probe"], shell: "bash" },
        // Windows agents' commands go through the PowerShell scanner.
        { action: "shell", resources: ["Write-Output ok; rm -r ./probe"], shell: "pwsh" },
      ],
      (input) => PolicyEvaluator.check(workspace, input),
    ),
  ).then(
    (decided) => decided.map((decision) => decision.effect).join(","),
    (error: unknown) => `a failure: ${String(error)}`,
  )
  const policy = decisions === "allow,deny,deny" ? [] : [`policy decisions were ${decisions}, not allow,deny,deny`]
  const loaders: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["claude-code-hook", () => import("./claude-code-hook")],
    ["claude-code", () => import("./claude-code")],
    ["codex-hook", () => import("./codex-hook")],
    ["codex", () => import("./codex")],
    ["hermes-hook", () => import("./hermes-hook")],
    ["hermes", () => import("./hermes")],
    ["pi", () => import("./pi")],
    ["deepseek-harness", () => import("./deepseek-harness")],
  ]
  const modules = await Promise.all(
    loaders.map(([name, load]) =>
      load().then(
        (): string[] => [],
        (error: unknown) => [`${name} didn't load: ${String(error)}`],
      ),
    ),
  )
  return [...policy, ...modules.flat(), ...(BuildInfo.target() ? await embedded() : [])]
}

/** The `self-test` command: exit 0 with `self-test ok` when nothing's wrong, else each problem and exit 1. */
export async function run() {
  const found = await problems()
  if (found.length > 0) {
    process.stderr.write(found.map((problem) => `${problem}\n`).join(""))
    return 1
  }
  process.stdout.write(`opencode-console ${version} self-test ok\n`)
  return 0
}

// The DeepSeek Harness plugin bundles everything, so it loads as is; Pi supplies its own packages to the extension, so
// it's only checked for its entry point.
async function embedded() {
  const files = BuildInfo.embedded()
  const pi = files["pi-extension.js"]
  const dsh = files["dsh-plugin.js"]
  const directory = mkdtempSync(path.join(os.tmpdir(), "opencode-console-self-test-"))
  try {
    const plugin = dsh === undefined ? undefined : path.join(directory, "dsh-plugin.mjs")
    if (plugin !== undefined && dsh !== undefined) writeFileSync(plugin, dsh)
    const loaded = plugin === undefined ? undefined : await import(pathToFileURL(plugin).href).catch(() => undefined)
    return [
      ...(pi?.includes("export") ? [] : ["the binary carries no Pi extension"]),
      ...(loaded !== undefined && typeof loaded.apply === "function"
        ? []
        : ["the binary's DeepSeek Harness plugin doesn't load"]),
    ]
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
