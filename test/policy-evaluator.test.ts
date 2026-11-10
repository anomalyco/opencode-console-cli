import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ConfigPolicy } from "@opencode/schema/config/policy"
import { Effect } from "effect"
import { PolicyEvaluator } from "../src/policy-evaluator"
import { compatibilityCases, malformedCases, toolPolicyCases } from "./support/opencode-cases"

const acme = (...policies: ConfigPolicy.Info[]) => ({ organization: "Acme", policies })
const deny = (action: ConfigPolicy.Action, resource: string): ConfigPolicy.Info => ({
  action,
  resource,
  effect: "deny",
})
const allow = (action: ConfigPolicy.Action, resource: string): ConfigPolicy.Info => ({
  action,
  resource,
  effect: "allow",
})
const blocked: PolicyEvaluator.Decision = { effect: "deny", message: "Blocked by Acme's policy" }
const allowed: PolicyEvaluator.Decision = { effect: "allow" }
const check = (workspace: PolicyEvaluator.Workspace, input: PolicyEvaluator.Input) =>
  Effect.runPromise(PolicyEvaluator.check(workspace, input))

const directories: string[] = []
const directory = (prefix: string) => {
  const created = mkdtempSync(path.join(os.tmpdir(), prefix))
  directories.push(created)
  return created
}
afterEach(() => directories.splice(0).forEach((item) => rmSync(item, { recursive: true, force: true })))

// OpenCode's policy plugin decides these same checks in @opencode/core's test/config/policy.test.ts (anomalyco/opencode).
test.each(
  toolPolicyCases.flatMap((item) =>
    item.checks.map(
      ([action, resources, effect]) =>
        [item.name, action, resources, item.policies, effect === "deny" ? blocked : allowed] as const,
    ),
  ),
)("decides tool.use like OpenCode, %s: %s %j", async (_, action, resources, policies, expected) => {
  expect(await check(acme(...policies), { action, resources })).toEqual(expected)
})

// ShellParse's own vectors: every command it extracts is checked, so denying any one of them denies the line.
const scanned = compatibilityCases.filter(([, , env, expected]) => !Object.keys(env).length && expected.commands.length)

test.each(
  scanned.flatMap(([shell, command, , expected]) => expected.commands.map((item) => [shell, command, item.resource])),
)("denies a %s command when one command ShellParse extracts is denied: %s (%s)", async (shell, command, resource) => {
  expect(
    await check(acme(deny("tool.use", `shell:${resource}`)), { action: "shell", resources: [command], shell }),
  ).toEqual(blocked)
})

test.each(scanned.map(([shell, command]) => [shell, command]))(
  "allows a %s command no statement matches: %s",
  async (shell, command) => {
    expect(
      await check(acme(deny("tool.use", "shell:opencode-unmatched *")), {
        action: "shell",
        resources: [command],
        shell,
      }),
    ).toEqual(allowed)
  },
)

test("has enough of ShellParse's vectors to mean something", () => {
  expect(scanned.length).toBeGreaterThan(20)
})

test.each(malformedCases.map(([shell, command]) => [shell, command]))(
  "fails closed on a %s command the scanner can't analyze while a shell rule could apply: %s",
  async (shell, command) => {
    const input = { action: "shell", resources: [command], shell }
    expect(await check(acme(deny("tool.use", "shell:rm *")), input)).toEqual(blocked)
    expect(await check(acme(deny("tool.use", "*")), input)).toEqual(blocked)
    // The command might change into a directory the policy keeps it out of.
    expect(await check(acme(deny("tool.use", "external_directory:/etc/*")), input)).toEqual(blocked)
  },
)

test.each(malformedCases.map(([shell, command]) => [shell, command]))(
  "runs a %s command it can't analyze when no statement could deny a shell command: %s",
  async (shell, command) => {
    const input = { action: "shell", resources: [command], shell }
    expect(await check(acme(deny("tool.use", "edit:*.env"), deny("mcp.use", "*")), input)).toEqual(allowed)
    expect(await check(acme(), input)).toEqual(allowed)
  },
)

test("runs a command it can't analyze when later allows lift every shell rule", async () => {
  const workspace = acme(deny("tool.use", "*"), allow("tool.use", "shell:*"), allow("tool.use", "external_directory:*"))

  expect(await check(workspace, { action: "shell", resources: ['echo "unterminated'], shell: "bash" })).toEqual(allowed)
  expect(await check(workspace, { action: "webfetch", resources: ["https://x.test"] })).toEqual(blocked)
})

test("blocks a compound command when one part is denied", async () => {
  const workspace = acme(deny("tool.use", "shell:rm *"))
  const shell = (command: string) => check(workspace, { action: "shell", resources: [command], shell: "bash" })

  expect(await shell("echo ok && rm -rf ./probe")).toEqual(blocked)
  expect(await shell("echo $(rm -rf ./probe)")).toEqual(blocked)
  expect(await shell("echo rm -rf")).toEqual(allowed)
})

test("scans with the shell the harness names, so zsh-only expansion is caught", async () => {
  expect(
    await check(acme(deny("tool.use", "shell:rm *")), {
      action: "shell",
      resources: ["echo ${(e):-\\$(rm -rf ./probe)}"],
      shell: "zsh",
    }),
  ).toEqual(blocked)
})

test("checks directories a command changes into outside the working directory", async () => {
  const workspace = acme(deny("tool.use", "external_directory:*"), allow("tool.use", "external_directory:/tmp/*"))
  const shell = (command: string) =>
    check(workspace, { action: "shell", resources: [command], directory: "/repo", shell: "bash" })

  expect(await shell("cd /etc && cat passwd")).toEqual(blocked)
  expect(await shell("cd ../other && ls")).toEqual(blocked)
  expect(await shell("cd /tmp && ls")).toEqual(allowed)
  expect(await shell("cd src && ls")).toEqual(allowed)
})

test("names the workspace in a denial only when the sign-in knows it", async () => {
  expect(
    await check({ policies: [deny("tool.use", "shell:*")] }, { action: "shell", resources: ["ls"], shell: "bash" }),
  ).toEqual({ effect: "deny", message: "Blocked by your organization's policy" })
})

test("denies everything while a signed-in workspace's policy is unknown", async () => {
  expect(
    await check({ organization: "Acme", policies: undefined }, { action: "read", resources: ["notes.md"] }),
  ).toEqual({ effect: "deny", message: "Blocked until Acme's policy loads from OpenCode Console" })
})

test("says why when a signed-in workspace's policy is unknown because the sign-in needs the member", async () => {
  const workspace = {
    organization: "Acme",
    policies: undefined,
    status: { message: "Sign in with SSO again to use Acme", url: "https://console.test/sso" },
  }

  expect(await check(workspace, { action: "read", resources: ["notes.md"] })).toEqual({
    effect: "deny",
    message: "Sign in with SSO again to use Acme: https://console.test/sso",
  })
})

test("decides policy actions per resource with the last match", async () => {
  const workspace = acme(
    deny("websearch.use", "*"),
    allow("websearch.use", "exa"),
    deny("mcp.use", "github"),
    deny("skill.use", "deploy*"),
  )
  const decide = (action: string, resources: string[]) => check(workspace, { action, resources })

  expect(await decide("websearch.use", ["exa"])).toEqual(allowed)
  expect(await decide("websearch.use", ["opencode"])).toEqual(blocked)
  expect(await decide("mcp.use", ["linear"])).toEqual(allowed)
  expect(await decide("mcp.use", ["linear", "github"])).toEqual(blocked)
  expect(await decide("skill.use", ["deploy-prod"])).toEqual(blocked)
  // A tool named like a policy action is still only a tool.use check.
  expect(await decide("mcp", ["github"])).toEqual(allowed)
})

test("refuses a raw tool.use check, whose input it can't parse", async () => {
  const decision = await check(acme(deny("tool.use", "shell:rm *")), {
    action: "tool.use",
    resources: ["shell:echo ok && rm -rf /"],
  })

  expect(decision.effect).toBe("deny")
})

test("checks a skill against both skill.use and the skill tool", async () => {
  const skill = (policy: ConfigPolicy.Info) => check(acme(policy), { action: "skill", resources: ["deploy"] })

  expect(await skill(deny("skill.use", "deploy"))).toEqual(blocked)
  expect(await skill(deny("tool.use", "skill:deploy"))).toEqual(blocked)
  expect(await skill(deny("skill.use", "release"))).toEqual(allowed)
})

test("names files inside the working directory relative to it", async () => {
  const workspace = acme(deny("tool.use", "edit:*.env"), deny("tool.use", "read:secrets/*"))
  const file = (action: string, resource: string) =>
    check(workspace, { action, resources: [resource], directory: "/repo" })

  expect(await file("edit", "/repo/.env")).toEqual(blocked)
  expect(await file("edit", "config/prod.env")).toEqual(blocked)
  expect(await file("read", "/repo/secrets/key.pem")).toEqual(blocked)
  expect(await file("read", "/repo/src/secrets/key.pem")).toEqual(allowed)
  expect(await file("edit", "/repo/src/index.ts")).toEqual(allowed)
})

test("decides write and patch by edit rules, as OpenCode's write and patch tools ask for edit", async () => {
  const workspace = acme(deny("tool.use", "edit:*.env"), deny("tool.use", "external_directory:/etc/*"))
  const file = (action: string, resource: string) =>
    check(workspace, { action, resources: [resource], directory: "/repo" })

  expect(await file("write", "/repo/.env")).toEqual(blocked)
  expect(await file("patch", "config/prod.env")).toEqual(blocked)
  expect(await file("write", "/etc/new.conf")).toEqual(blocked)
  expect(await file("patch", "/repo/src/index.ts")).toEqual(allowed)
})

test("refuses a check that names no resources", async () => {
  expect(await check(acme(), { action: "shell", resources: [] })).toEqual({
    effect: "deny",
    message: "Nothing to check: the request names no resources",
  })
})

test("decides a path under a file, which can't exist, as a file", async () => {
  expect(
    await check(acme(deny("tool.use", "external_directory:/etc/hosts/*")), {
      action: "read",
      resources: ["/etc/hosts/x"],
      directory: "/repo",
    }),
  ).toEqual(blocked)
})

test("keeps a file whose name starts with two dots inside the project", async () => {
  expect(
    await check(acme(deny("tool.use", "edit:..env")), {
      action: "edit",
      resources: ["/repo/..env"],
      directory: "/repo",
    }),
  ).toEqual(blocked)
})

test("checks the containing directory of files outside the working directory", async () => {
  const workspace = acme(deny("tool.use", "external_directory:/etc/*"))
  const read = (resource: string) => check(workspace, { action: "read", resources: [resource], directory: "/repo" })

  expect(await read("/etc/hosts")).toEqual(blocked)
  expect(await read("../outside/notes.md")).toEqual(allowed)
  expect(await read("/repo/notes.md")).toEqual(allowed)
})

test("expands ~ to the home directory, as OpenCode's file tools and ShellParse do", async () => {
  const workspace = acme(deny("tool.use", `external_directory:${os.homedir()}/.ssh/*`))

  expect(await check(workspace, { action: "read", resources: ["~/.ssh/id_rsa"], directory: "/repo" })).toEqual(blocked)
  expect(
    await check(workspace, { action: "shell", resources: ["cd ~/.ssh && ls"], directory: "/repo", shell: "bash" }),
  ).toEqual(blocked)
})

test("reads ~ alone as the home directory", async () => {
  expect(
    await check(acme(deny("tool.use", `external_directory:${os.homedir()}/*`)), {
      action: "read",
      resources: ["~"],
      directory: "/repo",
    }),
  ).toEqual(blocked)
})

test("checks a directory read outside the project as that directory", async () => {
  const outside = directory("opencode-console-outside-")
  const read = (...policies: ConfigPolicy.Info[]) =>
    check(acme(...policies), { action: "read", resources: [outside], directory: "/repo" })

  expect(await read(deny("tool.use", `external_directory:${outside}/*`))).toEqual(blocked)
  expect(
    await read(deny("tool.use", "external_directory:*"), allow("tool.use", `external_directory:${outside}/*`)),
  ).toEqual(allowed)
})

test("treats the whole repository as inside the project when run from a subdirectory", async () => {
  const repo = directory("opencode-console-repo-")
  mkdirSync(path.join(repo, ".git"))
  mkdirSync(path.join(repo, "packages", "web"), { recursive: true })
  const inside = path.join(repo, "packages", "web")

  expect(
    await check(acme(deny("tool.use", "external_directory:*")), {
      action: "read",
      resources: ["../../README.md"],
      directory: inside,
    }),
  ).toEqual(allowed)
  expect(
    await check(acme(deny("tool.use", "external_directory:*")), {
      action: "shell",
      resources: ["cd .. && ls"],
      directory: inside,
      shell: "bash",
    }),
  ).toEqual(allowed)
  expect(
    await check(acme(deny("tool.use", "read:../../README.md")), {
      action: "read",
      resources: [path.join(repo, "README.md")],
      directory: inside,
    }),
  ).toEqual(blocked)
})

test("checks where a command runs and where a search looks", async () => {
  const outside = directory("opencode-console-outside-")
  const workspace = acme(deny("tool.use", `external_directory:${outside}/*`))
  const at = (action: string, resources: string[], where: string) =>
    check(workspace, { action, resources, directory: "/repo", path: where, shell: "bash" })

  expect(await at("shell", ["ls"], outside)).toEqual(blocked)
  expect(await at("glob", ["*.ts"], outside)).toEqual(blocked)
  expect(await at("grep", ["secret"], outside)).toEqual(blocked)
  expect(await at("glob", ["*.ts"], "/repo/src")).toEqual(allowed)
})
