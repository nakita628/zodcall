# zodcall

Type-safe, fetch-based API client with [zod](https://zod.dev) validation.
Inspired by (and partially derived from) [Zodios](https://github.com/ecyrbe/zodios).

- Declare your API once: paths, parameters, bodies and responses are typed and validated
- Uses the platform `fetch`, no runtime dependencies
- Works with `zod` and `zod/mini` (v4)
- Errors are [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)

## Install

```bash
pnpm add zodcall zod
```

Requires Node 20.3+ (or any runtime with `fetch` and `AbortSignal.any`). Enabling
`exactOptionalPropertyTypes` in your `tsconfig.json` is recommended.

## Usage

```ts
import { Zodcall, makeApi } from "zodcall";
import { z } from "zod";

const user = z.object({ id: z.number(), name: z.string() });

const api = makeApi([
  {
    method: "get",
    path: "/users/:id",
    alias: "getUser",
    parameters: [{ name: "fields", type: "Query", schema: z.string().exactOptional() }],
    response: user,
  },
  {
    method: "post",
    path: "/users",
    alias: "createUser",
    parameters: [{ name: "body", type: "Body", schema: user.omit({ id: true }) }],
    response: user,
  },
]);

const client = new Zodcall("https://api.example.com", api);

await client.getUser({ params: { id: 1 } }); // { id: number; name: string }
await client.get("/users/:id", { params: { id: 1 }, queries: { fields: "name" } });
await client.createUser({ name: "alice" });
```

- Parameter `type` is `Path`, `Query`, `Header` or `Body`. Undeclared `:path` params are still required.
- `query` / `post` / `put` / `patch` / `delete` take the body as first argument.
- Parameters are validated before sending, JSON responses before returning.

## Optional parameters

Optionality comes from zod, and `.exactOptional()` is the intended way:

| schema                       | parameter type                |
| ---------------------------- | ----------------------------- |
| `z.number().exactOptional()` | `limit?: number`              |
| `z.number().optional()`      | `limit?: number \| undefined` |
| `z.number().default(10)`     | `limit?: number \| undefined` |

An omitted parameter is skipped; one explicitly set to `undefined` is validated (and rejected by
`.exactOptional()`).

## QUERY method

[HTTP QUERY](https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/) is supported:
a safe, idempotent request with a body. The server must accept the `QUERY` method.

```ts
const api = makeApi([
  {
    method: "query",
    path: "/users/search",
    alias: "searchUsers",
    parameters: [{ name: "body", type: "Body", schema: z.object({ name: z.string() }) }],
    response: z.array(user),
  },
]);

await client.searchUsers({ name: "al" });
```

## Errors

Every failure throws a `ZodcallError` with Problem Details members (`type`, `title`, `status`,
`detail`, `instance`, `errors`). Non 2xx responses throw a `ZodcallHttpError` with `response`.
Errors declared on an endpoint can be narrowed:

```ts
import { isErrorFromAlias, problemDetails } from "zodcall";

// in the endpoint definition: errors: [{ status: 404, schema: problemDetails() }]

try {
  await client.getUser({ params: { id: 1 } });
} catch (error) {
  if (isErrorFromAlias(api, "getUser", error)) {
    error.response.data.title; // typed
  }
}
```

## Options

```ts
new Zodcall(baseURL, api, {
  validate: true, // or "request" | "response" | false
  transform: true, // apply zod transforms
  sendDefaults: false, // send zod .default() values for omitted parameters
  fetch: customFetch,
  init: { headers: { authorization: "Bearer ..." } },
  timeout: 10_000,
});
```

Per call: typed `params` / `queries` / `headers`, any `RequestInit` option, `timeout` and
`responseType`. Use `client.requestRaw(...)` to get the status and headers.

Plugins intercept requests, responses and errors:

```ts
client.use({
  request: async (api, config) => ({ ...config, headers: { ...config.headers, "x-id": "1" } }),
});
```

## License

Distributed under the MIT License. See [LICENSE](https://github.com/nakita628/zodcall?tab=MIT-1-ov-file) for more information.
