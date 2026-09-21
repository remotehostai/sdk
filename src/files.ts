import type { components } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { unwrap } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";

export type FilesystemEntry = components["schemas"]["FilesystemEntry"];
export type FileEncoding = "utf8" | "base64";

export type ListFilesResult = {
  path: string;
  truncated: boolean;
  entries: FilesystemEntry[];
};

export type ReadFileResult = {
  path: string;
  content: string;
  encoding: FileEncoding;
  size: number;
};

export type WriteFileResult = {
  path: string;
  size: number;
};

export class SandboxFiles {
  constructor(
    private readonly api: APIClient,
    private readonly sandboxId: string,
  ) {}

  /** List direct children of a directory. Relative paths resolve beneath `/code`. */
  list(path = "/code", options: RequestOptions = {}): Promise<ListFilesResult> {
    return unwrap(
      this.api.GET("/sandboxes/{sandboxId}/files", {
        params: { path: { sandboxId: this.sandboxId }, query: { path } },
        signal: requestSignal(options),
      }),
    );
  }

  /** Read a file with its transport encoding preserved. */
  read(path: string, options: RequestOptions = {}): Promise<ReadFileResult> {
    return unwrap(
      this.api.GET("/sandboxes/{sandboxId}/file", {
        params: { path: { sandboxId: this.sandboxId }, query: { path } },
        signal: requestSignal(options),
      }),
    );
  }

  /** Read a UTF-8 file, decoding a base64 response when necessary. */
  async readText(path: string, options: RequestOptions = {}): Promise<string> {
    const file = await this.read(path, options);
    return file.encoding === "base64"
      ? new TextDecoder().decode(base64ToBytes(file.content))
      : file.content;
  }

  /** Read a file as bytes. */
  async readBytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
    const file = await this.read(path, options);
    return file.encoding === "base64"
      ? base64ToBytes(file.content)
      : new TextEncoder().encode(file.content);
  }

  /** Write UTF-8 text or binary bytes. Individual writes are limited to 2 MiB. */
  write(
    path: string,
    content: string | Uint8Array,
    options: RequestOptions = {},
  ): Promise<WriteFileResult> {
    const body =
      typeof content === "string"
        ? { path, content, encoding: "utf8" as const }
        : { path, content: bytesToBase64(content), encoding: "base64" as const };

    return unwrap(
      this.api.PUT("/sandboxes/{sandboxId}/file", {
        params: { path: { sandboxId: this.sandboxId } },
        body,
        signal: requestSignal(options),
      }),
    );
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(value: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
