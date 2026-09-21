import type { Client } from "openapi-fetch";

import {
  RemoteHostAPIError,
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
