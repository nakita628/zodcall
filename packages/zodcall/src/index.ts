/*
 * Public API of zodcall.
 *
 * src/
 * ├── types/   type definitions only (no runtime code)
 * ├── utils/   internal runtime utilities (url, endpoint lookup, zod access) - not exported
 * ├── guard/   type guards (`value is T`)
 * ├── helper/  helpers for users (problemDetails, serializeQueries, toFormData)
 * ├── api/     define and compose api descriptions (makeApi, apiBuilder, mergeApis, ...)
 * ├── client/  the runtime client: Zodcall class, errors, fetch handling, plugins
 * └── index.ts
 *
 * Runtime dependencies only go one way: types <- utils <- guard <- helper / api <- client.
 */
export * from "./api";
export * from "./client";
export * from "./guard";
export * from "./helper";
export * from "./types";
