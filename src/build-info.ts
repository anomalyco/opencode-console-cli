export * as BuildInfo from "./build-info"

declare global {
  // Baked into compiled binaries by `script/compile.ts`; undefined in the npm bundle and a source checkout.
  /** The binary's platform as its npm package names it: `darwin-arm64`, `linux-x64-baseline-musl`, `windows-x64`… */
  var __OPENCODE_CONSOLE_TARGET__: string | undefined
  /** The single-file Pi extension, which a binary writes beside itself for Pi to load. */
  var __OPENCODE_CONSOLE_PI_EXTENSION__: string | undefined
  /** The single-file DeepSeek Harness plugin, which a binary writes beside itself for DeepSeek Harness to load. */
  var __OPENCODE_CONSOLE_DSH_PLUGIN__: string | undefined
}

/** The npm-style target this binary was compiled for, or undefined outside a compiled binary. */
export const target = () => globalThis.__OPENCODE_CONSOLE_TARGET__

/** The extension and plugin a compiled binary carries, by the file name each is installed as. */
export const embedded = (): Readonly<Record<string, string>> => ({
  ...(globalThis.__OPENCODE_CONSOLE_PI_EXTENSION__
    ? { "pi-extension.js": globalThis.__OPENCODE_CONSOLE_PI_EXTENSION__ }
    : {}),
  ...(globalThis.__OPENCODE_CONSOLE_DSH_PLUGIN__
    ? { "dsh-plugin.js": globalThis.__OPENCODE_CONSOLE_DSH_PLUGIN__ }
    : {}),
})

/** A compiled binary runs its entry point from Bun's embedded filesystem. */
export const compiled = (entry = process.argv[1] ?? "") => /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(entry)
