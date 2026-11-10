export * as UpdateEnvironment from "./environment"

import os from "node:os"

// The environments updates run their subprocesses with. A hook inherits the agent's environment, which a project can
// set (Claude Code passes a project's `env` settings to hooks), so nothing an update starts may read it whole: TAR_OPTIONS
// changes what tar extracts, BUN_OPTIONS and NODE_OPTIONS what the CLI preloads, SystemRoot which tar.exe or
// powershell.exe runs.

type Env = Readonly<Record<string, string | undefined>>

/**
 * Windows' own directory. SystemRoot is the agent's to set, so only `<drive>:\Windows` is taken from it; a path a
 * project chose, such as its own checkout, falls back to `C:\Windows`.
 */
export function systemRoot(env: Env = process.env) {
  const named = env.SystemRoot
  return named !== undefined && /^[A-Za-z]:\\Windows$/i.test(named) ? named : "C:\\Windows"
}

/** A fixed environment for the system tools updates run (tar, codesign, Windows PowerShell): nothing of the parent's. */
export function tool(platform: NodeJS.Platform = process.platform, env: Env = process.env): Record<string, string> {
  if (platform !== "win32") return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }
  const root = systemRoot(env)
  const temporary = os.tmpdir()
  return {
    SystemRoot: root,
    windir: root,
    PATH: `${root}\\System32;${root};${root}\\System32\\WindowsPowerShell\\v1.0`,
    TEMP: temporary,
    TMP: temporary,
  }
}

/** What the CLI reads to find its own data, the Console, a proxy and the system's CAs. */
const KEPT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  // Where agents keep their settings, which `sync --refresh-agents` rewrites. Variables an agent sets only while it
  // runs a hook (HERMES_SAFE_MODE, CLAUDE_CODE_SIMPLE) and values setup writes into settings (ANTHROPIC_*, OTEL_*)
  // change neither.
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HERMES_HOME",
  "HERMES_DATA_DIR_SUFFIX",
  "DSH_HOME",
  "PI_CODING_AGENT_DIR",
])

/**
 * The environment of the CLI process an update starts on its own (`self-update`, and the restored build's
 * `sync --refresh-agents`): only what `KEPT` and `OPENCODE_*` name, with Windows' own SystemRoot.
 */
export function cli(platform: NodeJS.Platform = process.platform, env: Env = process.env): Record<string, string> {
  const kept = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && (KEPT.has(entry[0]) || entry[0].startsWith("OPENCODE_")),
  )
  const root = systemRoot(env)
  return {
    ...Object.fromEntries(kept),
    ...(platform === "win32" ? { SystemRoot: root, windir: root } : {}),
  }
}
