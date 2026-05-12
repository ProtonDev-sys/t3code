import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { collectUint8StreamText } from "./collectUint8StreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamText", () => {
  it.effect("collects text and byte count from Uint8Array chunks", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("hello "), encoder.encode("world")),
      });

      expect(result).toEqual({
        text: "hello world",
        bytes: 11,
        truncated: false,
      });
    }),
  );

  it.effect("truncates by byte count while still draining the stream", () =>
    Effect.gen(function* () {
      const consumed: string[] = [];
      const stream = Stream.fromIterable(["abc", "def", "ghi"]).pipe(
        Stream.mapEffect((chunk) =>
          Effect.sync(() => {
            consumed.push(chunk);
            return encoder.encode(chunk);
          }),
        ),
      );

      const result = yield* collectUint8StreamText({
        stream,
        maxBytes: 4,
        truncatedMarker: "[truncated]",
      });

      expect(result).toEqual({
        text: "abcd[truncated]",
        bytes: 4,
        truncated: true,
      });
      expect(consumed).toEqual(["abc", "def", "ghi"]);
    }),
  );

  it.effect("does not emit replacement characters when truncating a multibyte code point", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("ok \u20ac done")),
        maxBytes: 5,
        truncatedMarker: "[truncated]",
      });

      expect(result).toEqual({
        text: "ok [truncated]",
        bytes: 5,
        truncated: true,
      });
    }),
  );
});
