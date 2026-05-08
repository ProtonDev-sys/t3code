import { describe, expect, it } from "vitest";

import { readHashParams, removeHashParam, setHashParam } from "./urlHashParams";

describe("url hash params", () => {
  it("reads legacy params-only hashes", () => {
    const params = readHashParams("#token=pairing-token&mode=desktop");

    expect(params.get("token")).toBe("pairing-token");
    expect(params.get("mode")).toBe("desktop");
  });

  it("reads query params from route hashes", () => {
    const params = readHashParams("#/?token=pairing-token&t3DesktopLabel=Local+environment");

    expect(params.get("token")).toBe("pairing-token");
    expect(params.get("t3DesktopLabel")).toBe("Local environment");
  });

  it("removes params without damaging a hash route", () => {
    expect(removeHashParam("#/?token=pairing-token&mode=desktop", "token")).toBe("/?mode=desktop");
    expect(removeHashParam("#/?token=pairing-token", "token")).toBe("/");
  });

  it("sets params while preserving route hashes and legacy hash-only links", () => {
    expect(setHashParam("#/pair", "token", "pairing-token")).toBe("/pair?token=pairing-token");
    expect(setHashParam("", "token", "pairing-token")).toBe("token=pairing-token");
  });
});
