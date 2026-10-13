/** A reference clip: a `Blob`/`File`, raw bytes, or `{ data, filename, contentType }`.
 * In Node, `await fileFromPath("ref.wav")` reads a file from disk. */
export type FileInput =
  | Blob
  | Uint8Array
  | ArrayBuffer
  | { data: Blob | Uint8Array | ArrayBuffer; filename?: string; contentType?: string };

const TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
};

function guessType(name: string): string {
  return TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** Normalise a file input to a Blob and filename. The Blob can be reused on retries. */
export function toBlob(file: FileInput): { blob: Blob; filename: string } {
  if (typeof Blob !== "undefined" && file instanceof Blob) {
    const name = (file as { name?: unknown }).name;
    return { blob: file, filename: typeof name === "string" && name ? name : "audio.wav" };
  }
  if (file instanceof Uint8Array || file instanceof ArrayBuffer) {
    return { blob: new Blob([file as BlobPart]), filename: "audio.wav" };
  }
  const { data, filename = "audio.wav" } = file as Exclude<
    FileInput,
    Blob | Uint8Array | ArrayBuffer
  >;
  const contentType = (file as { contentType?: string }).contentType ?? guessType(filename);
  // Keep a Blob's own type; give untyped data the one guessed from the filename.
  const blob =
    data instanceof Blob && data.type ? data : new Blob([data as BlobPart], { type: contentType });
  return { blob, filename };
}

/** Node only: read a file from disk into a {@link FileInput}. */
export async function fileFromPath(path: string): Promise<FileInput> {
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");
  const data = await readFile(path);
  const filename = basename(path);
  return { data: new Uint8Array(data), filename, contentType: guessType(filename) };
}
