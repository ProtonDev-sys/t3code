import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface CollectedUint8StreamText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

interface CollectState {
  chunks: Uint8Array[];
  readonly bytes: number;
  readonly truncated: boolean;
}

export const collectUint8StreamText = <E>(input: {
  readonly stream: Stream.Stream<Uint8Array, E>;
  readonly maxBytes?: number | undefined;
  readonly truncatedMarker?: string | null | undefined;
}): Effect.Effect<CollectedUint8StreamText, E> => {
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  const truncatedMarker = input.truncatedMarker ?? "";

  return input.stream.pipe(
    Stream.runFold(
      (): CollectState => ({
        chunks: [],
        bytes: 0,
        truncated: false,
      }),
      (state, chunk): CollectState => {
        if (state.truncated) {
          return state;
        }

        const remainingBytes = maxBytes - state.bytes;
        if (remainingBytes <= 0) {
          return { ...state, truncated: true };
        }

        const nextChunk =
          chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
        state.chunks.push(nextChunk);
        return {
          chunks: state.chunks,
          bytes: state.bytes + nextChunk.byteLength,
          truncated: chunk.byteLength > remainingBytes,
        };
      },
    ),
    Effect.map((state): CollectedUint8StreamText => {
      const bytes = Buffer.concat(state.chunks, state.bytes);
      const decodableBytes = state.truncated ? trimIncompleteUtf8Suffix(bytes) : bytes;
      const text = decodableBytes.toString("utf8");
      return {
        text: state.truncated && truncatedMarker.length > 0 ? `${text}${truncatedMarker}` : text,
        bytes: state.bytes,
        truncated: state.truncated,
      };
    }),
  );
};

function trimIncompleteUtf8Suffix(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    return bytes;
  }

  let continuationBytes = 0;
  for (let index = bytes.byteLength - 1; index >= 0 && continuationBytes < 3; index -= 1) {
    const byte = bytes[index] ?? 0;
    if ((byte & 0b1100_0000) !== 0b1000_0000) {
      const expectedLength = utf8SequenceLength(byte);
      if (expectedLength === 0) {
        return bytes.subarray(0, index);
      }
      return continuationBytes + 1 >= expectedLength ? bytes : bytes.subarray(0, index);
    }
    continuationBytes += 1;
  }

  return bytes.subarray(0, bytes.byteLength - continuationBytes);
}

function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0b1000_0000) === 0) {
    return 1;
  }
  if ((leadByte & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((leadByte & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((leadByte & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 0;
}
