import * as z from "zod";
import type { ProblemFieldError } from "../types";

/*
 * Helpers for users: Problem Details schemas, query string and form-data encoding.
 */

/* -------------------------------------------------------------------------- */
/*                         RFC 9457 - Problem Details                         */
/* -------------------------------------------------------------------------- */

/**
 * zod shape of the RFC 9457 Problem Details standard members
 */
export const problemDetailsShape = {
  type: z.string().exactOptional(),
  title: z.string().exactOptional(),
  status: z.number().int().exactOptional(),
  detail: z.string().exactOptional(),
  instance: z.string().exactOptional(),
};

/**
 * zod schema of an RFC 9457 Problem Details body, to declare endpoint errors
 * @param extensions - optional extension members
 * @example
 * ```ts
 * errors: [
 *   {
 *     status: 403,
 *     schema: problemDetails({
 *       type: z.literal("https://example.com/errors/insufficient-funds"),
 *       balance: z.number(),
 *     }),
 *   },
 *   { status: "default", schema: problemDetails() },
 * ]
 * ```
 */
export function problemDetails<Extensions extends z.ZodRawShape = {}>(extensions?: Extensions) {
  return z.looseObject({
    ...problemDetailsShape,
    ...extensions,
  });
}

function escapePointerToken(token: PropertyKey): string {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * convert zod issues into RFC 9457 `errors` extension entries
 * @param issues - zod issues
 * @param prefix - pointer prefix (e.g. the parameter name)
 */
export function issuesToFieldErrors(
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code?: string;
  }>,
  prefix: ReadonlyArray<PropertyKey> = [],
): ProblemFieldError[] {
  return issues.map((issue) => ({
    pointer: `#${[...prefix, ...issue.path]
      .map((token) => `/${escapePointerToken(token)}`)
      .join("")}`,
    detail: issue.message,
    ...(issue.code ? { code: issue.code } : {}),
  }));
}

/* -------------------------------------------------------------------------- */
/*                                Query string                                */
/* -------------------------------------------------------------------------- */

function serializeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

/**
 * default query serializer
 * - `undefined` and `null` values are skipped
 * - arrays are serialized as repeated keys (`?a=1&a=2`)
 * - dates are serialized as ISO strings, objects as JSON
 */
export function serializeQueries(queries: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(queries)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        search.append(key, serializeValue(item));
      }
    } else {
      search.append(key, serializeValue(value));
    }
  }
  return search.toString();
}

/* -------------------------------------------------------------------------- */
/*                                 Form data                                  */
/* -------------------------------------------------------------------------- */

function appendValue(formData: FormData, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (value instanceof Blob) {
    formData.append(key, value);
  } else if (Array.isArray(value)) {
    for (const item of value) appendValue(formData, key, item);
  } else if (value instanceof Date) {
    formData.append(key, value.toISOString());
  } else if (typeof value === "object") {
    formData.append(key, JSON.stringify(value));
  } else {
    formData.append(key, String(value));
  }
}

/**
 * convert an object into a `FormData`
 */
export function toFormData(data: Record<string, unknown>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(data)) {
    appendValue(formData, key, value);
  }
  return formData;
}
