# Security

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability
reporting](https://github.com/anomalyco/opencode-console-cli/security/advisories/new). Please don't open a public issue.
We'll reply with next steps and keep you posted until it's fixed. If you haven't heard back within 6 business days,
email security@anoma.ly.

We don't accept AI-generated reports.

Never attach a real `credential.json`, an access or refresh token, an `OPENCODE_API_KEY`, or a gateway token
(`ocgw_…`) to a report. Describe where it came from instead, and revoke anything you think leaked.

## What the CLI protects

`opencode-console` runs on a developer's machine as their own user. It enforces a workspace's policies on the agents
it's set up for: Claude Code, Codex and Hermes Agent through their hooks, Pi and DeepSeek Harness through in-process
plugins. A hook that can't reach a decision fails closed and blocks the tool call.

It isn't a sandbox. A process running as the same user can edit the agent's settings, remove the hooks or run tools
without the agent. Reports that need that access are out of scope unless the CLI itself makes it easier.

In scope:

- A tool call a workspace policy denies that the hooks or plugins allow.
- Credentials written where they shouldn't be: into agent config files, logs, or files readable by other users.
  Credentials live in the CLI's own data directory, with `0600` files in `0700` directories.
- An update that installs or runs a build Anomaly didn't sign, or a stable or beta build that accepts a release service
  other than `https://anoma.ly/release`.
- A Slack, GitHub or MCP event that can make an agent act as if the user had asked.
