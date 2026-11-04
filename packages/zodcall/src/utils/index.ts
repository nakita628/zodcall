import type { $ZodType } from "zod/v4/core";
import type {
  AnySchema,
  BodyMethod,
  Method,
  ZodcallEndpointDefinition,
  ZodcallEndpointDefinitions,
  ZodcallRequestConfig,
} from "../types";

/*
 * Internal runtime utilities, not part of the public API.
 */

/* -------------------------------------------------------------------------- */
/*                                Http methods                                */
/* -------------------------------------------------------------------------- */

/** methods whose client functions take the request body as first argument (see `BodyMethod`) */
export const BODY_METHODS: ReadonlySet<Method> = new Set<BodyMethod>([
  "post",
  "put",
  "patch",
  "delete",
  "query",
]);

/** every supported http method */
export const METHODS: ReadonlySet<string> = new Set<Method>([
  "get",
  "head",
  "options",
  ...BODY_METHODS,
]);

/* -------------------------------------------------------------------------- */
/*                                  Strings                                   */
/* -------------------------------------------------------------------------- */

/**
 * set first letter of a string to uppercase
 */
export function capitalize<T extends string>(str: T): Capitalize<T>;
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/* -------------------------------------------------------------------------- */
/*                                    URL                                     */
/* -------------------------------------------------------------------------- */

const paramsRegExp = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * replace `:param` placeholders of the url with their (uri encoded) values
 */
export function replacePathParams(config: Pick<ZodcallRequestConfig, "url" | "params">): string {
  const { params } = config;
  if (!params) return config.url;
  return config.url.replace(paramsRegExp, (match, key: string) =>
    key in params && params[key] !== undefined ? encodeURIComponent(String(params[key])) : match,
  );
}

/**
 * join a base url and a path
 */
export function joinURL(baseURL: string | undefined, path: string): string {
  if (!baseURL) return path;
  if (!path) return baseURL;
  return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function pathMatchesUrl(path: string, url: string): boolean {
  return new RegExp(`^${path.replace(paramsRegExp, () => "([^/]*)")}$`).test(url);
}

/* -------------------------------------------------------------------------- */
/*                              Endpoint lookup                               */
/* -------------------------------------------------------------------------- */

export function findEndpoint(
  api: ZodcallEndpointDefinitions,
  method: string,
  path: string,
): ZodcallEndpointDefinition | undefined {
  return api.find((e) => e.method === method && e.path === path);
}

export function findEndpointByAlias(
  api: ZodcallEndpointDefinitions,
  alias: string,
): ZodcallEndpointDefinition | undefined {
  return api.find((e) => e.alias === alias);
}

export function findEndpointErrors(endpoint: ZodcallEndpointDefinition, status: number) {
  const matchingErrors = endpoint.errors?.filter((error) => error.status === status);
  if (matchingErrors && matchingErrors.length > 0) return matchingErrors;
  return endpoint.errors?.filter((error) => error.status === "default");
}

/* -------------------------------------------------------------------------- */
/*                                Content type                                */
/* -------------------------------------------------------------------------- */

/**
 * whether a `content-type` is JSON (`application/json` or any `+json` type)
 */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/* -------------------------------------------------------------------------- */
/*                                    zod                                     */
/* -------------------------------------------------------------------------- */

/**
 * whether a structural schema is a real zod (or zod/mini) schema at runtime
 */
/**
 * whether a structural schema is a real zod (or zod/mini) schema at runtime
 */
function isZodType(schema: AnySchema): schema is AnySchema & $ZodType {
  return "def" in schema._zod && "run" in schema._zod;
}

/**
 * the type level schema type is structural (see `AnySchema`), runtime needs the real zod type
 */
export function toZod(schema: AnySchema): $ZodType {
  if (isZodType(schema)) return schema;
  throw new TypeError("Zodcall: schemas must be zod (or zod/mini) schemas");
}
