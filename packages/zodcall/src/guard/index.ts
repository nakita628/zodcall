import { safeParse } from "zod/v4/core";
import type { ZodcallError, ZodcallHttpError } from "../client";
import type {
  Aliases,
  BodyMethod,
  Method,
  ProblemDetails,
  ProblemFieldError,
  ZodcallEndpointDefinition,
  ZodcallEndpointDefinitions,
  ZodcallMatchingErrorsByAlias,
  ZodcallMatchingErrorsByPath,
  ZodcallOptions,
  ZodcallPathsByMethod,
} from "../types";
import {
  BODY_METHODS,
  findEndpoint,
  findEndpointByAlias,
  findEndpointErrors,
  METHODS,
  pathMatchesUrl,
  toZod,
} from "../utils";

/*
 * Type guards (`value is T`). They only depend on `types` and `utils`: errors are recognized
 * by their name and members rather than with `instanceof`, so this module does not import the
 * client at runtime (and errors coming from another realm are recognized too).
 */

/* -------------------------------------------------------------------------- */
/*                                Http methods                                */
/* -------------------------------------------------------------------------- */

/**
 * whether a string is a supported http method
 */
export function isMethod(value: string): value is Method {
  return METHODS.has(value);
}

/**
 * whether a method sends a request body (`post`, `put`, `patch`, `delete`, `query`)
 */
export function isBodyMethod(method: Method): method is BodyMethod {
  return BODY_METHODS.has(method);
}

/* -------------------------------------------------------------------------- */
/*                              Client arguments                              */
/* -------------------------------------------------------------------------- */

/**
 * whether a constructor argument is the api description (and not the base url or the options)
 */
export function isApi<Api extends ZodcallEndpointDefinitions>(
  value: Api | ZodcallOptions | string | undefined,
): value is Api {
  return Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/*                                   Bodies                                   */
/* -------------------------------------------------------------------------- */

/**
 * whether a body can be passed to fetch as is (no JSON serialization)
 */
export function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

/**
 * whether a value is a plain object (not an array, not a `FormData`)
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof FormData)
  );
}

/* -------------------------------------------------------------------------- */
/*                              Problem Details                               */
/* -------------------------------------------------------------------------- */

/**
 * check if a value looks like a Problem Details object
 */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = "type" in value ? value.type : undefined;
  const title = "title" in value ? value.title : undefined;
  const status = "status" in value ? value.status : undefined;
  const detail = "detail" in value ? value.detail : undefined;
  const instance = "instance" in value ? value.instance : undefined;
  return (
    (type === undefined || typeof type === "string") &&
    (title === undefined || typeof title === "string") &&
    (status === undefined || typeof status === "number") &&
    (detail === undefined || typeof detail === "string") &&
    (instance === undefined || typeof instance === "string") &&
    (typeof type === "string" || typeof title === "string")
  );
}

/**
 * check if a value is a Problem Details field error (`{ pointer, detail, code? }`)
 */
export function isProblemFieldError(value: unknown): value is ProblemFieldError {
  return (
    typeof value === "object" &&
    value !== null &&
    "pointer" in value &&
    typeof value.pointer === "string" &&
    "detail" in value &&
    typeof value.detail === "string" &&
    (!("code" in value) || value.code === undefined || typeof value.code === "string")
  );
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/**
 * check if an error is a `ZodcallError` (any request problem)
 */
export function isZodcallError(error: unknown): error is ZodcallError {
  return (
    typeof error === "object" &&
    error !== null &&
    error instanceof Error &&
    error.name.startsWith("Zodcall") &&
    "type" in error &&
    "title" in error &&
    "extensions" in error
  );
}

/**
 * check if an error is a `ZodcallHttpError`
 */
export function isHttpError(error: unknown): error is ZodcallHttpError {
  return isZodcallError(error) && error.name === "ZodcallHttpError" && "response" in error;
}

function isDefinedError(error: unknown, endpoint: ZodcallEndpointDefinition | undefined): boolean {
  if (!endpoint || !isHttpError(error)) return false;
  const { config, response } = error;
  if (!config || config.method !== endpoint.method || !pathMatchesUrl(endpoint.path, config.url)) {
    return false;
  }
  const endpointErrors = findEndpointErrors(endpoint, response.status);
  if (!endpointErrors) return false;
  return endpointErrors.some((desc) => safeParse(toZod(desc.schema), response.data).success);
}

/**
 * check if the error is matching the endpoint errors definitions
 * @param api - the api definition
 * @param method - http method of the endpoint
 * @param path - path of the endpoint
 * @param error - the error to check
 * @returns - if true, the error type is narrowed to the matching endpoint errors
 */
export function isErrorFromPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
>(
  api: Api,
  method: M,
  path: Path,
  error: unknown,
): error is ZodcallMatchingErrorsByPath<Api, M, Path> {
  return isDefinedError(error, findEndpoint(api, method, path));
}

/**
 * check if the error is matching the endpoint errors definitions
 * @param api - the api definition
 * @param alias - alias of the endpoint
 * @param error - the error to check
 * @returns - if true, the error type is narrowed to the matching endpoint errors
 */
export function isErrorFromAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
>(api: Api, alias: Alias, error: unknown): error is ZodcallMatchingErrorsByAlias<Api, Alias> {
  return isDefinedError(error, findEndpointByAlias(api, alias));
}
