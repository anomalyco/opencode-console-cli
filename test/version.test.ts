import { describe, expect, it } from "bun:test"
import { devVersion, setVersion } from "../script/version"

describe("dev versions", () => {
  it("numbers a dev build as the next patch release's prerelease, with the run", () => {
    expect(devVersion("0.1.7", 142)).toBe("0.1.8-dev.142")
  })

  it("adds the run attempt when a run is retried, so a retry never republishes a version", () => {
    expect(devVersion("0.1.7", 142, 2)).toBe("0.1.8-dev.142.2")
  })

  it("refuses a package.json that already carries a prerelease", () => {
    expect(() => devVersion("0.1.8-dev.142", 143)).toThrow("not a stable x.y.z")
  })

  it("takes the release workflow's dev, beta and stable versions, and nothing else", () => {
    expect(["0.1.9-dev.142.2", "0.1.8-beta.7", "0.1.8"].map(setVersion)).toEqual([
      "0.1.9-dev.142.2",
      "0.1.8-beta.7",
      "0.1.8",
    ])
    expect(() => setVersion("0.1.8-rc.1")).toThrow("Not a version the release workflow publishes")
  })
})
