export * as WorkspaceModels from "./workspace-models"

import type { ConsoleClient } from "./console-client"
import { SettingsFile } from "./settings-file"

/** A model a member may run a coding agent on, from `GET /api/v1/models`. */
export interface Listed {
  /** The provider ID config gives it: `opencode`, `opencode-go` or `console-<slug>`. */
  readonly provider: string
  readonly providerName: string | undefined
  readonly id: string
  /** Its models.dev v2 entry, with `api` naming the Console URL that serves it. */
  readonly entry: Record<string, unknown>
}

/**
 * The chat models a member may run an agent on, OpenCode's own first, then Go's, then the workspace's connections':
 * models that take tools (`capabilities.tools.supported`) and answer in text without audio (`modalities.output`).
 * Moderation and audio models a provider lists as chat models drop out here, even when they also answer in text.
 */
export function list(document: ConsoleClient.ModelsDocument): Listed[] {
  return Object.entries(document)
    .toSorted(([left], [right]) => rank(left) - rank(right))
    .flatMap(([provider, item]) =>
      Object.entries(item.models).flatMap(([id, entry]) =>
        agentic(entry) ? [{ provider, providerName: item.name, id, entry }] : [],
      ),
    )
}

/**
 * The newest Claude model of the first family that has one, from the first provider with one (OpenCode's, then Go's,
 * then the workspace's connections), else the first model listed, so a default always names a model the member may use.
 */
export function newest(listed: readonly Listed[], ...families: string[]) {
  const pick = (family: string) =>
    listed
      .filter((model) => model.id.toLowerCase().includes("claude") && model.id.toLowerCase().includes(family))
      .toSorted(
        (left, right) => rank(left.provider) - rank(right.provider) || released(right).localeCompare(released(left)),
      )[0]
  return families.map(pick).find((model) => model !== undefined) ?? listed[0]
}

/** The gateway's root, from any model's base URL: Zen's and Go's protocol paths, or a connection's. */
export function inferenceRoot(listed: readonly Listed[]) {
  return listed
    .flatMap((model) => Object.values(SettingsFile.record(model.entry.api)))
    .flatMap((api) => SettingsFile.text(SettingsFile.record(api).base_url) ?? [])
    .map(
      (baseURL) =>
        baseURL.match(/^(https?:\/\/.+?)\/(?:go\/)?(?:anthropic\/v1|openai\/v1|google\/v1beta|v1)\/?$/)?.[1] ??
        baseURL.match(/^(https?:\/\/.+?)\/custom\/[^/]+(?:\/.*)?$/)?.[1],
    )
    .find((item) => item !== undefined)
}

function agentic(entry: Record<string, unknown>) {
  const tools = SettingsFile.record(SettingsFile.record(entry.capabilities).tools).supported
  const output = SettingsFile.record(entry.modalities).output
  return (
    (entry.type ?? "chat") === "chat" &&
    tools !== false &&
    (!Array.isArray(output) || (output.includes("text") && !output.includes("audio")))
  )
}

function released(model: Listed) {
  return SettingsFile.text(model.entry.release_date) ?? ""
}

// OpenCode's own models first, then Go's, then the workspace's connections.
function rank(provider: string) {
  return provider === "opencode" ? 0 : provider === "opencode-go" ? 1 : 2
}
