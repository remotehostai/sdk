import type { Client } from "openapi-fetch";

import {
  RemoteHostAPIError,
  RemoteHostConfigurationError,
  RemoteHostConnectionError,
  RemoteHostError,
  RemoteHostTimeoutError,
} from "./errors.js";
import type { paths } from "./generated/schema.js";

export type APIClient = Client<paths>;

type APIResult =
  | { data: unknown; error?: never; response: Response }
  | { data?: never; error: unknown; response: Response };

type SuccessData<T> = T extends { data: infer Data } ? Data : never;

export async function unwrap<Result extends APIResult>(
  request: Promise<Result>,
): Promise<SuccessData<Result>> {
  try {
    const result = await request;

    if (result.data !== undefined) {
      return result.data as SuccessData<Result>;
    }

    throw new RemoteHostAPIError(result.response, result.error);
  } catch (error) {
    if (error instanceof RemoteHostError) {
      throw error;
    }

    if (error instanceof Error && error.name === "TimeoutError") {
      throw new RemoteHostTimeoutError(undefined, { cause: error });
    }

    throw new RemoteHostConnectionError("Could not connect to the RemoteHost API.", {
      cause: error,
    });
  }
}

/**
 * unwrap() for an operation that answers 204 No Content. openapi-fetch
 * leaves `data` undefined on an empty success too, which unwrap() would read
 * as a failure, so success here is the response's status.
 */
export async function unwrapNoContent(
  request: Promise<{ data?: unknown; error?: unknown; response: Response }>,
): Promise<void> {
  await unwrap(
    request.then(
      (result): APIResult =>
        result.response.ok
          ? { data: null, response: result.response }
          : { error: result.error, response: result.response },
    ),
  );
}

/** The request's org, else the client's default, else a configuration error. */
export function requireOrgId(orgId: string | undefined, defaultOrgId: string | undefined): string {
  const resolved = orgId ?? defaultOrgId;
  if (!resolved) {
    throw new RemoteHostConfigurationError(
      "An orgId is required. Pass it to the client or this request.",
    );
  }
  return resolved;
}
