import { expect, test } from "bun:test"
import { ClaudeCodeWatches } from "../src/claude-code-watches"

// Claude Code's `PostToolUse` input (code.claude.com/docs/en/hooks): Bash answers `{ stdout, stderr, … }`.
const afterTool = (tool_name: string, tool_input: Record<string, unknown>, tool_response: unknown) => ({
  hook_event_name: "PostToolUse",
  session_id: "ses_claude",
  tool_name,
  tool_input,
  tool_response,
})
const gateway = new Set(["github", "slack"])

test("watches the branch a Bash git push updated, which git reports on stderr", () => {
  const event = afterTool(
    "Bash",
    { command: "git push origin fix" },
    {
      stdout: "",
      stderr: "To github.com:Acme/App.git\n   1a2b3c4..5d6e7f8  fix -> fix\n",
      interrupted: false,
      isImage: false,
    },
  )

  expect<unknown>(ClaudeCodeWatches.targets(event, gateway)).toEqual([
    { target: { _tag: "GitHubBranch", repo: "acme/app", branch: "fix" } },
  ])
})

test("watches what a gateway server's GitHub write made, from the text blocks of its result", () => {
  const event = afterTool("mcp__github__create_pull_request", { owner: "acme", repo: "app", title: "Fix" }, [
    { type: "text", text: JSON.stringify({ number: 12, head: { sha: "a".repeat(40) } }) },
  ])

  expect<unknown>(ClaudeCodeWatches.targets(event, gateway)).toEqual([
    { target: { _tag: "GitHubIssue", repo: "acme/app", number: 12 } },
    { target: { _tag: "GitHubCommit", repo: "acme/app", sha: "a".repeat(40) } },
  ])
})

test("watches nothing a server outside the workspace's gateway wrote", () => {
  const event = afterTool("mcp__my_github__create_pull_request", { owner: "acme", repo: "app", title: "Fix" }, [
    { type: "text", text: JSON.stringify({ number: 12, head: { sha: "a".repeat(40) } }) },
  ])

  expect(ClaudeCodeWatches.targets(event, gateway)).toEqual([])
})
