import type { components } from "./generated/schema.js";
import type { APIClient } from "./internal.js";
import { unwrap } from "./internal.js";
import type { RequestOptions } from "./request-options.js";
import { requestSignal } from "./request-options.js";

export type Preview = components["schemas"]["Preview"];
export type PreviewLink = components["schemas"]["PreviewLink"];
type CreatePreviewBody = components["schemas"]["CreatePreviewBody"];
type PreviewTarget = { port: number; target?: string } | { port?: number; target: string };
export type CreatePreviewOptions = Omit<CreatePreviewBody, "port" | "target"> &
  PreviewTarget &
  RequestOptions;

export class SandboxPreviews {
  constructor(
    private readonly api: APIClient,
    private readonly sandboxId: string,
  ) {}

  /** Create a team preview or a revocable public preview URL. */
  async create(options: CreatePreviewOptions): Promise<Preview> {
    const { signal: _signal, timeoutMs: _timeoutMs, ...body } = options;
    const data = await unwrap(
      this.api.POST("/sandboxes/{sandboxId}/previews", {
        params: { path: { sandboxId: this.sandboxId } },
        body,
        signal: requestSignal(options),
      }),
    );
    return data.preview;
  }

  /** List persistent public preview links. Stateless team preview URLs are not returned. */
  async list(options: RequestOptions = {}): Promise<PreviewLink[]> {
    const data = await unwrap(
      this.api.GET("/sandboxes/{sandboxId}/previews", {
        params: { path: { sandboxId: this.sandboxId } },
        signal: requestSignal(options),
      }),
    );
    return data.previewLinks;
  }

  /** Revoke a public preview link immediately. */
  async revoke(linkId: string, options: RequestOptions = {}): Promise<void> {
    await unwrap(
      this.api.DELETE("/sandboxes/{sandboxId}/previews/{linkId}", {
        params: { path: { sandboxId: this.sandboxId, linkId } },
        signal: requestSignal(options),
      }),
    );
  }
}
