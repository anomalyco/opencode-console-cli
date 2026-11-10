import { expect, test } from "bun:test"
import { TomlFile } from "../src/toml-file"

test("sets a key inside the member's own table, keeping its comment and every other line", () => {
  const text = 'model = "o3"\n\n[features]\nhooks = false # off for now\nother = 1\n\n[tui]\nhooks = false\n'

  const edited = TomlFile.edit("config.toml", text, [{ type: "entry", path: ["features", "hooks"], value: true }])

  expect(edited).toBe('model = "o3"\n\n[features]\nhooks = true # off for now\nother = 1\n\n[tui]\nhooks = false\n')
})

test.each([
  ["a key on a line of its own under its table", "[features]\nhooks = false\n", true],
  ["a key another table sets", "[tui]\nhooks = false\n", false],
  ["a dotted key, which no table header names", "features.hooks = false\n", false],
  ["an inline table", "features = { hooks = false }\n", false],
])("says whether it can change %s in place", (_name, text, expected) => {
  expect(TomlFile.hasEntry(text, ["features", "hooks"])).toBe(expected)
})

test("removes a table whose quoted key holds a #, which reads as a comment only outside quotes", () => {
  const text = 'model = "o3"\n\n[hooks.state."/home/#ada/hooks.json:pre_tool_use:0:0"] # approved\ntrusted_hash = "x"\n'

  const edited = TomlFile.edit("config.toml", text, [
    { type: "remove", path: ["hooks", "state", "/home/#ada/hooks.json:pre_tool_use:0:0"] },
  ])

  expect(edited).toBe('model = "o3"\n')
})
