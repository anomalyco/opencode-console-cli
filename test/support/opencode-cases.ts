import os from "node:os"
import path from "node:path"
import type { ShellParse } from "@opencode/core/shell/parse"
import type { ConfigPolicy } from "@opencode/schema/config/policy"

// OpenCode's own test vectors, so the CLI is held to the decisions OpenCode makes. Ported from @opencode/core's tests in
// anomalyco/opencode, `test/config/policy.test.ts` (tool.use), `shell-parse-compatibility.test.ts` and
// `shell-parse-parity.test.ts` (ShellParse); keep them in step when bumping `@opencode/core`.

const tool = (effect: ConfigPolicy.Effect, resource: string): ConfigPolicy.Info => ({
  action: "tool.use",
  resource,
  effect,
})
/** Organization `tool.use` statements and the permission checks they decide. */
export const toolPolicyCases: ReadonlyArray<{
  readonly name: string
  readonly policies: ConfigPolicy.Info[]
  readonly checks: ReadonlyArray<readonly [action: string, resources: string[], effect: ConfigPolicy.Effect]>
}> = [
  {
    name: "the last matching statement decides",
    policies: [tool("deny", "shell:*"), tool("allow", "shell:git *"), tool("deny", "shell:git push *")],
    checks: [
      ["shell", ["git status"], "allow"],
      ["shell", ["git push origin main"], "deny"],
      ["shell", ["ls"], "deny"],
      ["edit", ["notes.md"], "allow"],
    ],
  },
  {
    name: "statements match action:resource, and a trailing ' *' also matches no arguments",
    policies: [tool("deny", "shell:git push *")],
    checks: [
      ["shell", ["git push"], "deny"],
      ["shell", ["git push origin main"], "deny"],
      // Compound commands check several resources; any denied resource denies the operation.
      ["shell", ["git status", "git push"], "deny"],
      ["shell", ["git status"], "allow"],
      ["edit", ["git push"], "allow"],
    ],
  },
  {
    name: "a later allow lifts an earlier broad deny",
    policies: [tool("deny", "shell:*"), tool("allow", "shell:git status *")],
    checks: [
      ["shell", ["git status --short"], "allow"],
      ["shell", ["rm -rf /"], "deny"],
    ],
  },
  {
    name: "a bare wildcard denies every permission",
    policies: [tool("deny", "*")],
    checks: [
      ["question", ["*"], "deny"],
      ["read", ["/tmp/notes.txt"], "deny"],
      ["github_delete_repository", ["*"], "deny"],
    ],
  },
  {
    name: "external directories match their directory glob",
    policies: [tool("deny", "external_directory:*"), tool("allow", "external_directory:/tmp/*")],
    checks: [
      ["external_directory", ["/tmp/*"], "allow"],
      ["external_directory", ["/etc/*"], "deny"],
      ["read", ["src/index.ts"], "allow"],
    ],
  },
]

/** `[shell, command, env, expected scan]`: the resources and directories ShellParse extracts. */
export const compatibilityCases: Array<[string, string, Record<string, string>, ShellParse.Result]> = [
  ["bash", "echo $((1+1))", {}, { commands: [{ resource: "echo $((1+1))", save: "echo *" }], directories: [] }],
  [
    "bash",
    "echo $((1 + $(printf hidden)))",
    {},
    {
      commands: [
        { resource: "echo $((1 + $(printf hidden)))", save: "echo *" },
        { resource: "printf hidden", save: "printf *" },
      ],
      directories: [],
    },
  ],
  ["bash", "cd ~/project", {}, { commands: [], directories: [path.join(os.homedir(), "project")] }],
  ["bash", "cd src&&cd..", {}, { commands: [{ resource: "cd..", save: "cd.. *" }], directories: ["src"] }],
  [
    "bash",
    "cd src && cd .. && git status",
    {},
    { commands: [{ resource: "git status", save: "git status *" }], directories: ["src", ".."] },
  ],
  ["zsh", "git status", {}, { commands: [{ resource: "git status", save: "git status *" }], directories: [] }],
  ["fish", "git status", {}, { commands: [{ resource: "git status", save: "git status *" }], directories: [] }],
  [
    "bash",
    "git status",
    { BASH_ENV: "/startup" },
    { commands: [{ resource: "git status", save: "git status *" }], directories: [] },
  ],
  [
    "bash",
    "git status",
    { "BASH_FUNC_cd%%": "() { :; }" },
    { commands: [{ resource: "git status", save: "git status *" }], directories: [] },
  ],
  [
    "bash",
    "cd $HOME; pwd",
    { HOME: "/session-home" },
    {
      commands: [
        { resource: "cd $HOME", save: "cd *" },
        { resource: "pwd", save: "pwd *" },
      ],
      directories: [],
    },
  ],
  [
    "bash",
    "cd; pwd",
    { HOME: "/session-home" },
    {
      commands: [
        { resource: "cd", save: "cd *" },
        { resource: "pwd", save: "pwd *" },
      ],
      directories: [],
    },
  ],
  [
    "bash",
    'target=/outside; cd "$target"; pwd',
    {},
    {
      commands: [
        { resource: 'cd "$target"', save: "cd *" },
        { resource: "pwd", save: "pwd *" },
      ],
      directories: [],
    },
  ],
  [
    "bash",
    "cd 'src dir' && git status",
    {},
    { commands: [{ resource: "git status", save: "git status *" }], directories: ["src dir"] },
  ],
  ["bash", 'cd "src dir"; cd escaped\\ space', {}, { commands: [], directories: ["src dir", "escaped space"] }],
  [
    "bash",
    "cd '$HOME'; cd '~/outside'",
    {},
    { commands: [], directories: ["$HOME", path.join(os.homedir(), "outside")] },
  ],
  ["bash", 'g""it status', {}, { commands: [{ resource: 'g""it status', save: 'g""it *' }], directories: [] }],
  ["bash", 'npm "run" test', {}, { commands: [{ resource: 'npm "run" test', save: 'npm "run" *' }], directories: [] }],
  ["bash", "git '*'", {}, { commands: [{ resource: "git '*'", save: "git '*' *" }], directories: [] }],
  [
    "bash",
    "FOO=bar git status",
    {},
    { commands: [{ resource: "FOO=bar git status", save: "git status *" }], directories: [] },
  ],
  [
    "bash",
    "HOME=/outside; cd; pwd",
    {},
    {
      commands: [
        { resource: "cd", save: "cd *" },
        { resource: "pwd", save: "pwd *" },
      ],
      directories: [],
    },
  ],
  ["bash", "CDPATH=/outside cd child", {}, { commands: [], directories: ["child"] }],
  [
    "bash",
    "cd child; pwd",
    { CDPATH: "/outside" },
    { commands: [{ resource: "pwd", save: "pwd *" }], directories: ["child"] },
  ],
  ["bash", "cd /workspace > output", {}, { commands: [], directories: ["/workspace"] }],
  [
    "bash",
    "export X=value; unset X; git status",
    {},
    { commands: [{ resource: "git status", save: "git status *" }], directories: [] },
  ],
  [
    "bash",
    "printf ok && git status > output",
    {},
    {
      commands: [
        { resource: "printf ok", save: "printf *" },
        { resource: "git status > output", save: "git status *" },
      ],
      directories: [],
    },
  ],
  [
    "bash",
    "printf ok | cat < input > output",
    {},
    {
      commands: [
        { resource: "printf ok", save: "printf *" },
        { resource: "cat < input > output", save: "cat *" },
      ],
      directories: [],
    },
  ],
  [
    "bash",
    "cd -- -/../../../etc; pwd",
    {},
    { commands: [{ resource: "pwd", save: "pwd *" }], directories: ["-/../../../etc"] },
  ],
  [
    "bash",
    "cd -; pushd; popd; pwd",
    {},
    {
      commands: [
        { resource: "cd -", save: "cd *" },
        { resource: "pushd", save: "pushd *" },
        { resource: "popd", save: "popd *" },
        { resource: "pwd", save: "pwd *" },
      ],
      directories: [],
    },
  ],
  [
    "bash",
    "command cd /outside; builtin cd /elsewhere",
    {},
    {
      commands: [
        { resource: "command cd /outside", save: "command *" },
        { resource: "builtin cd /elsewhere", save: "builtin *" },
      ],
      directories: ["/outside", "/elsewhere"],
    },
  ],
  [
    "pwsh",
    "Get-ChildItem | ForEach-Object { Write-Output $_ }",
    {},
    {
      commands: [
        { resource: "Get-ChildItem", save: "Get-ChildItem *" },
        { resource: "ForEach-Object { Write-Output $_ }", save: "ForEach-Object *" },
        { resource: "Write-Output $_", save: "Write-Output *" },
      ],
      directories: [],
    },
  ],
  [
    "pwsh",
    "ForEach-Object { Remove-Item victim }",
    {},
    { commands: [{ resource: "Remove-Item victim", save: "Remove-Item *" }], directories: [] },
  ],
  [
    "pwsh",
    "Set-Location -LiteralPath '../outside'; Get-ChildItem",
    {},
    { commands: [{ resource: "Get-ChildItem", save: "Get-ChildItem *" }], directories: ["../outside"] },
  ],
  ["pwsh", "Set-Location -LiteralPath:/outside", {}, { commands: [], directories: ["/outside"] }],
  ["pwsh", "Set-Location -LiteralPath:'/outside path'", {}, { commands: [], directories: ["/outside path"] }],
  ["pwsh", 'Set-Location -PATH:"../outside path"', {}, { commands: [], directories: ["../outside path"] }],
  [
    "pwsh",
    "Set-Location $HOME; Set-Location $PWD; Set-Location $target",
    { HOME: "/session-home" },
    {
      commands: [{ resource: "Set-Location $target", save: "Set-Location *" }],
      directories: [process.platform === "win32" ? os.homedir() : "/session-home", "/workspace"],
    },
  ],
  [
    "pwsh",
    "Set-Item Env:T /outside; Set-Location $env:T",
    { T: "/workspace" },
    { commands: [{ resource: "Set-Item Env:T /outside", save: "Set-Item *" }], directories: ["/workspace"] },
  ],
  [
    "pwsh",
    "sl /outside; Microsoft.PowerShell.Management\\Set-Location /outside",
    {},
    {
      commands: [
        { resource: "sl /outside", save: "sl *" },
        {
          resource: "Microsoft.PowerShell.Management\\Set-Location /outside",
          save: "Microsoft.PowerShell.Management\\Set-Location *",
        },
      ],
      directories: [],
    },
  ],
]

/** `[shell, command, reason]`: commands the portable scanner cannot analyze. */
export const malformedCases = [
  ["bash", 'echo "unterminated', "unterminated-quote"],
  ["bash", "printf done &&", "invalid-structure"],
  ["bash", "cat >", "invalid-redirect"],
  ["bash", ">", "invalid-redirect"],
  ["bash", "FOO=bar >", "invalid-redirect"],
  ["bash", "echo \\", "unterminated-escape"],
  ["pwsh", 'Write-Output "unterminated', "unterminated-quote"],
  ["pwsh", "git 12>bar", "invalid-redirect"],
  ["pwsh", "Write-Output `", "unterminated-escape"],
] as const
