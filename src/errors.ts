export class RemoteHostError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteHostError";
  }
}

export class RemoteHostConfigurationError extends RemoteHostError {
  constructor(message: string) {
    super(message);
    this.name = "RemoteHostConfigurationError";
  }
}

export class RemoteHostConnectionError extends RemoteHostError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteHostConnectionError";
  }
}

export class RemoteHostTimeoutError extends RemoteHostConnectionError {
  constructor(message = "The RemoteHost API request timed out.", options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteHostTimeoutError";
  }
}

export class RemoteHostAPIError extends RemoteHostError {
  readonly status: number;
  /**
   * Machine-readable reason when the API sets one, for example `rate_limited`,
   * `limit_reached`, `plan_required`, or `snapshot_in_progress`. Null otherwise.
   * A refused credential is always 401 `invalid_credential`, with the same
   * message whatever the reason.
   */
  readonly code: string | null;
  readonly requestId: string | null;
  readonly headers: Headers;
  readonly body: unknown;

  constructor(response: Response, body: unknown) {
    super(readErrorMessage(body) ?? `${response.status} ${response.statusText}`.trim());
    this.name = "RemoteHostAPIError";
    this.status = response.status;
    this.code = readErrorCode(body);
    this.requestId = response.headers.get("x-request-id");
    this.headers = response.headers;
    this.body = body;
  }
}

function readErrorCode(body: unknown): string | null {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "code" in body.error &&
    typeof body.error.code === "string"
  ) {
    return body.error.code;
  }
  return null;
}

function readErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  if ("error" in body) {
    const error = body.error;
    if (typeof error === "string") {
      return error;
    }
    if (
      error &&
      typeof error === "object" &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message;
    }
  }

  if ("message" in body && typeof body.message === "string") {
    return body.message;
  }

  return null;
}
