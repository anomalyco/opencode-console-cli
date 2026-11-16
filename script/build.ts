#!/usr/bin/env bun

// Builds `dist/npm`, the Node bundle with its own package.json that publishes as `@opencode/console`.
// `script/compile.ts` builds the release binaries, which `setup` installs from npm where one fits the computer, and
// `script/pack.ts` packs them. `.github/workflows/release.yml` publishes all of them.
//
// The npm bundle also carries the Pi extension, `pi-extension.js`, which `setup pi` lists in Pi's settings and which
// makes the package a Pi package too (`pi install npm:@opencode/console`), and the DeepSeek Harness plugin,
// `dsh-plugin.js`, which `setup deepseek-harness` loads from DeepSeek Harness's home patch layer. Pi supplies its own
// packages to extensions (pi.dev/docs/latest/packages, "Declare dependencies"), so they stay out of the bundle as
// optional peers, which npx doesn't install.
//
// It also carries the Console wire contract as library subpaths, `@opencode/console/event-watch`, `/event-watch-tool`
// and `/contract`, which Console's server imports. They leave `effect` to the importer (an optional peer), so a Worker
// that bundles them shares its own Effect, while the CLI's own files keep every dependency inlined for npx.

import path from "node:path"
import { $ } from "bun"
import manifest from "../package.json" with { type: "json" }

// github.com/anomalyco/opencode/blob/dev/LICENSE, which covers @opencode/core, @opencode/schema and @opencode/util.
const OPENCODE_LICENSE = `MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const root = new URL("..", import.meta.url).pathname
/** The library subpaths, each `src/<name>.ts`. */
const LIBRARY = ["event-watch", "event-watch-tool", "contract"]

await $`rm -rf ${root}dist`
const bundle = await Bun.build({
  entrypoints: [`${root}src/index.ts`, `${root}src/pi-extension.ts`, `${root}src/dsh-plugin.ts`],
  outdir: `${root}dist/npm`,
  target: "node",
  format: "esm",
  minify: true,
  splitting: true,
  external: ["@earendil-works/*"],
  metafile: true,
})
if (!bundle.success) throw new AggregateError(bundle.logs, "Node bundle failed")
const library = await Bun.build({
  entrypoints: LIBRARY.map((name) => `${root}src/${name}.ts`),
  outdir: `${root}dist/npm`,
  target: "node",
  format: "esm",
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "contract-[hash].[ext]" },
  external: ["effect", "effect/*"],
})
if (!library.success) throw new AggregateError(library.logs, "Library build failed")
await $`bunx tsc -p ${root}tsconfig.types.json`
// The entry is the package's bin; its chunks load lazily, so each command reads only the code it runs.
const entry = Bun.file(`${root}dist/npm/index.js`)
await Bun.write(entry, `#!/usr/bin/env node\n${await entry.text()}`)
await $`chmod +x ${root}dist/npm/index.js`
await Bun.write(
  `${root}dist/npm/package.json`,
  JSON.stringify(
    {
      name: "@opencode/console",
      version: manifest.version,
      description:
        "Connect Claude Code, Pi, Codex, DeepSeek Harness and Hermes Agent to an OpenCode Console workspace and enforce its policies",
      keywords: [
        "opencode",
        "claude-code",
        "codex",
        "pi-package",
        "deepseek-harness",
        "hermes-agent",
        "coding-agent",
        "policy",
      ],
      homepage: "https://opencode.ai/console/integrations/claude-code",
      // npm's trusted publishing checks this against the repository that publishes.
      repository: {
        type: "git",
        url: "git+https://github.com/anomalyco/opencode-console-cli.git",
      },
      pi: { extensions: ["./pi-extension.js"] },
      peerDependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*", effect: "*" },
      peerDependenciesMeta: {
        "@earendil-works/pi-ai": { optional: true },
        "@earendil-works/pi-coding-agent": { optional: true },
        effect: { optional: true },
      },
      license: "MIT",
      type: "module",
      bin: { "opencode-console": "index.js" },
      exports: Object.fromEntries([
        ["./package.json", "./package.json"],
        // Agents load these by path; listed so `exports` doesn't hide them from one that resolves them by name.
        ...["index.js", "pi-extension.js", "dsh-plugin.js"].map((file) => [`./${file}`, `./${file}`]),
        ...LIBRARY.map((name) => [`./${name}`, { types: `./types/${name}.d.ts`, default: `./${name}.js` }]),
      ]),
      // Only the library subpaths are imported; the CLI's own files run for what they do.
      sideEffects: ["./index.js", "./pi-extension.js", "./dsh-plugin.js", "./chunk-*.js"],
      files: ["*.js", "types", "THIRD_PARTY_LICENSES.md"],
      engines: { node: ">=22" },
    },
    null,
    2,
  ),
)
await $`cp ${root}README.md ${root}LICENSE ${root}dist/npm/`
// The bundle inlines its dependencies, and their licenses ask for their notices to travel with the code.
const dependencies = [
  ...new Set(
    Object.keys(bundle.metafile?.inputs ?? {}).flatMap((input) => {
      const match = path.resolve(input).match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//)
      return match?.[1] ? [match[1]] : []
    }),
  ),
]
const notices = await Promise.all(
  dependencies.map(async (directory) => {
    const dependency = await Bun.file(`${directory}/package.json`).json()
    const license = [...new Bun.Glob("*").scanSync({ cwd: directory })].find((file) => /^licen[cs]e/i.test(file))
    const text = license ? (await Bun.file(`${directory}/${license}`).text()).trim() : undefined
    return { name: `${dependency.name}@${dependency.version}`, text }
  }),
)
// OpenCode's packages leave their license file out of npm, so they carry the notice of the repository they come from.
const opencode = notices.filter((notice) => !notice.text && notice.name.startsWith("@opencode/"))
const unlicensed = notices.filter((notice) => !notice.text && !notice.name.startsWith("@opencode/"))
if (unlicensed.length > 0)
  throw new Error(`No license file to copy for ${unlicensed.map((notice) => notice.name).join(", ")}`)
await Bun.write(
  `${root}dist/npm/THIRD_PARTY_LICENSES.md`,
  [
    "# Third-party licenses\n\n`@opencode/console` bundles these packages.\n",
    ...[
      ...notices.flatMap((notice) => (notice.text ? [`## ${notice.name}\n\n${notice.text}\n`] : [])),
      ...(opencode.length > 0
        ? [
            `## ${opencode
              .map((notice) => notice.name)
              .toSorted()
              .join(", ")}\n\n${OPENCODE_LICENSE}\n`,
          ]
        : []),
    ].toSorted((a, b) => a.localeCompare(b)),
  ].join("\n"),
)

console.log(`${root}dist/npm/index.js`)
