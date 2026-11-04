import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import * as zm from "zod/mini";
import {
  Zodcall,
  ZodcallError,
  ZodcallHttpError,
  isErrorFromAlias,
  isErrorFromPath,
  makeApi,
  problemDetails,
  ProblemTypes,
  type ZodcallPlugin,
} from "../src";
import { startServer } from "./server";

const user = z.object({ id: z.number(), name: z.string() });

const received = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.any()),
  body: z.string(),
});

const api = makeApi([
  {
    method: "get",
    path: "/users",
    alias: "getUsers",
    response: z.array(user),
  },
  {
    method: "get",
    path: "/users/:id",
    alias: "getUser",
    response: user,
    errors: [
      {
        status: 404,
        schema: z.object({ code: z.literal("NOT_FOUND"), message: z.string() }),
      },
      { status: "default", schema: z.object({ message: z.string() }) },
    ],
  },
  {
    method: "post",
    path: "/users",
    alias: "createUser",
    parameters: [{ name: "body", type: "Body", schema: z.object({ name: z.string() }) }],
    response: user,
  },
  {
    method: "query",
    path: "/users/search",
    alias: "searchUsers",
    parameters: [{ name: "body", type: "Body", schema: z.object({ name: z.string() }) }],
    response: z.array(user),
  },
  {
    method: "query",
    path: "/echo/query",
    alias: "echoQuery",
    parameters: [
      { name: "body", type: "Body", schema: z.object({ q: z.string() }) },
      { name: "limit", type: "Query", schema: z.number() },
    ],
    response: received,
  },
  {
    method: "get",
    path: "/echo/:id/items/:itemId",
    alias: "echoGet",
    parameters: [
      { name: "q", type: "Query", schema: z.string() },
      { name: "tags", type: "Query", schema: z.array(z.string()).exactOptional() },
      {
        name: "page",
        type: "Query",
        schema: z
          .number()
          .transform((n) => n - 1)
          .exactOptional(),
      },
      { name: "x-api-key", type: "Header", schema: z.string() },
    ],
    response: received,
  },
  {
    method: "post",
    path: "/echo/form",
    alias: "echoForm",
    requestFormat: "form-url",
    parameters: [
      {
        name: "body",
        type: "Body",
        schema: z.object({ user: z.string(), password: z.string() }),
      },
    ],
    response: received,
  },
  {
    method: "post",
    path: "/echo/multipart",
    alias: "echoMultipart",
    requestFormat: "form-data",
    parameters: [
      {
        name: "body",
        type: "Body",
        schema: z.object({ file: z.instanceof(Blob), label: z.string() }),
      },
    ],
    response: received,
  },
  {
    method: "post",
    path: "/echo/text",
    requestFormat: "text",
    parameters: [{ name: "body", type: "Body", schema: z.string() }],
    response: received,
  },
  {
    method: "get",
    path: "/echo/defaults",
    parameters: [
      { name: "limit", type: "Query", schema: z.number().default(42) },
      { name: "cursor", type: "Query", schema: z.string().exactOptional() },
      { name: "legacy", type: "Query", schema: z.string().optional() },
    ],
    response: received,
  },
  { method: "get", path: "/text", response: z.string() },
  { method: "get", path: "/no-content", response: z.undefined() },
  { method: "get", path: "/invalid", response: user },
  { method: "get", path: "/slow", response: z.object({ ok: z.boolean() }) },
  {
    method: "get",
    path: "/error/:status",
    response: z.unknown(),
    errors: [{ status: "default", schema: z.object({ message: z.string() }) }],
  },
  {
    method: "post",
    path: "/accounts/:accountId/transfers/:transferId",
    alias: "transfer",
    response: z.object({ ok: z.boolean() }),
    errors: [
      {
        status: 403,
        schema: problemDetails({
          type: z.literal("https://example.com/errors/insufficient-funds"),
          balance: z.number(),
        }),
      },
      { status: "default", schema: problemDetails() },
    ],
  },
  {
    method: "get",
    path: "/users/:id/transformed",
    response: z.object({ name: z.string().transform((s) => s.toUpperCase()) }),
  },
]);

let server: Awaited<ReturnType<typeof startServer>>;
let client: ReturnType<typeof createClient>;

const createClient = (options?: ConstructorParameters<typeof Zodcall>[2]) =>
  new Zodcall(server.url, api, options);

beforeAll(async () => {
  server = await startServer();
  client = createClient();
});

afterAll(async () => {
  await server.close();
});

describe("constructor", () => {
  it("throws without api", () => {
    // @ts-expect-error
    expect(() => new Zodcall()).toThrow("Zodcall: missing api description");
    // @ts-expect-error
    expect(() => new Zodcall(undefined, [])).toThrow("Zodcall: missing base url");
    // @ts-expect-error
    expect(() => new Zodcall("http://x", {})).toThrow("Zodcall: api must be an array");
  });

  it("throws on duplicate paths/aliases", () => {
    expect(
      () =>
        new Zodcall([
          { method: "get", path: "/a", response: z.string() },
          { method: "get", path: "/a", response: z.string() },
        ]),
    ).toThrow("Zodcall: Duplicate path 'get /a'");
    expect(
      () =>
        new Zodcall([
          { method: "get", path: "/a", alias: "x", response: z.string() },
          { method: "get", path: "/b", alias: "x", response: z.string() },
        ]),
    ).toThrow("Zodcall: Duplicate alias 'x'");
  });

  it("throws when an alias conflicts with a client member", () => {
    expect(
      () => new Zodcall([{ method: "get", path: "/a", alias: "request", response: z.string() }]),
    ).toThrow("Zodcall: alias 'request' conflicts with a client member");
  });

  it("exposes baseURL and api", () => {
    expect(client.baseURL).toBe(server.url);
    expect(client.api).toBe(api);
  });
});

describe("requests", () => {
  it("get", async () => {
    await expect(client.get("/users")).resolves.toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
  });

  it("get with path params via alias", async () => {
    await expect(client.getUser({ params: { id: 7 } })).resolves.toEqual({
      id: 7,
      name: "user7",
    });
  });

  it("post json body", async () => {
    await expect(client.createUser({ name: "carol" })).resolves.toEqual({
      id: 3,
      name: "carol",
    });
    await expect(client.post("/users", { name: "dave" })).resolves.toEqual({
      id: 3,
      name: "dave",
    });
  });

  it("query sends the body with the QUERY method", async () => {
    await expect(client.searchUsers({ name: "li" })).resolves.toEqual([{ id: 1, name: "alice" }]);
    await expect(client.query("/users/search", { name: "b" })).resolves.toEqual([
      { id: 2, name: "bob" },
    ]);
    const res = await client.echoQuery({ q: "zodcall" }, { queries: { limit: 10 } });
    expect(res.method).toBe("QUERY");
    expect(res.url).toBe("/echo/query?limit=10");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ q: "zodcall" });
  });

  it("validates query bodies", async () => {
    // @ts-expect-error name must be a string
    await expect(client.searchUsers({ name: 1 })).rejects.toBeInstanceOf(ZodcallError);
  });

  it("serializes path params, queries and headers", async () => {
    const res = await client.echoGet({
      params: { id: "a b", itemId: 2 },
      queries: { q: "hello", tags: ["x", "y"], page: 3 },
      headers: { "x-api-key": "secret" },
    });
    expect(res.method).toBe("GET");
    expect(res.url).toBe("/echo/a%20b/items/2?q=hello&tags=x&tags=y&page=2");
    expect(res.headers["x-api-key"]).toBe("secret");
  });

  it("sends form-url bodies", async () => {
    const res = await client.echoForm({ user: "u", password: "p&w" });
    expect(res.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(res.body).toBe("user=u&password=p%26w");
  });

  it("sends multipart bodies", async () => {
    const res = await client.echoMultipart({
      file: new Blob(["file-content"], { type: "text/plain" }),
      label: "my file",
    });
    expect(res.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(res.body).toContain("file-content");
    expect(res.body).toContain("my file");
  });

  it("sends text bodies", async () => {
    const res = await client.post("/echo/text", "raw text");
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toBe("raw text");
  });

  it("reads text responses", async () => {
    await expect(client.get("/text")).resolves.toBe("hello");
  });

  it("handles 204 responses", async () => {
    await expect(client.get("/no-content")).resolves.toBeUndefined();
  });

  it("returns the full response with requestRaw", async () => {
    const res = await client.requestRaw({ method: "get", url: "/users/:id", params: { id: 1 } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.data).toEqual({ id: 1, name: "user1" });
    expect(res.raw).toBeInstanceOf(Response);
  });

  it("merges default init headers", async () => {
    const c = createClient({ init: { headers: { authorization: "Bearer t" } } });
    const res = await c.post("/echo/text", "x");
    expect(res.headers.authorization).toBe("Bearer t");
  });

  it("uses a custom fetch", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: 9, name: "mock" }]), {
          headers: { "content-type": "application/json" },
        }),
    );
    const c = new Zodcall("https://example.com/api/", api, { fetch: fetchMock });
    await expect(c.getUsers()).resolves.toEqual([{ id: 9, name: "mock" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/users",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("supports a custom query serializer", async () => {
    const c = createClient({
      querySerializer: (q) => `custom=${Object.keys(q).join(",")}`,
    });
    const res = await c.echoGet({
      params: { id: 1, itemId: 2 },
      queries: { q: "a" },
      headers: { "x-api-key": "k" },
    });
    expect(res.url).toBe("/echo/1/items/2?custom=q");
  });

  it("times out", async () => {
    await expect(client.get("/slow", { timeout: 20 })).rejects.toMatchObject({
      type: ProblemTypes.timeout,
      title: "Request timeout",
      instance: `${server.url}/slow`,
    });
  });

  it("can be aborted with a signal", async () => {
    const controller = new AbortController();
    const promise = client.get("/slow", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      type: ProblemTypes.aborted,
      title: "Request aborted",
    });
  });

  it("wraps network errors", async () => {
    const c = new Zodcall("http://127.0.0.1:1", api);
    const error = await c.getUsers().catch((e) => e);
    expect(error).toBeInstanceOf(ZodcallError);
    expect(error.type).toBe(ProblemTypes.network);
    expect(error.title).toBe("Network error");
    expect(error.cause).toBeInstanceOf(TypeError);
  });
});

describe("validation", () => {
  it("rejects invalid parameters", async () => {
    // @ts-expect-error
    const error = await client.createUser({ name: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(ZodcallError);
    expect(error.toJSON()).toEqual({
      type: ProblemTypes.requestValidation,
      title: "Invalid request parameter",
      detail: "Invalid Body parameter 'body'",
      parameter: { name: "body", in: "body" },
      errors: [
        {
          pointer: "#/name",
          detail: "Invalid input: expected string, received number",
          code: "invalid_type",
        },
      ],
    });
    expect(error.data).toEqual({ name: 1 });
  });

  it("prefixes non body parameter pointers with the parameter name", async () => {
    const error = await client
      .echoGet({
        params: { id: 1, itemId: 2 },
        // @ts-expect-error
        queries: { q: 1 },
        headers: { "x-api-key": "k" },
      })
      .catch((e) => e);
    expect(error.type).toBe(ProblemTypes.requestValidation);
    expect(error.extensions.parameter).toEqual({ name: "q", in: "query" });
    expect(error.errors[0].pointer).toBe("#/q");
  });

  it("rejects invalid responses", async () => {
    const error = await client.get("/invalid").catch((e) => e);
    expect(error).toBeInstanceOf(ZodcallError);
    expect(error.type).toBe(ProblemTypes.responseValidation);
    expect(error.title).toBe("Invalid response");
    expect(error.status).toBeUndefined();
    expect(error.detail).toBe("Response from endpoint 'get /invalid' does not match the schema");
    expect(error.extensions.responseStatus).toBe(200);
    expect(error.errors.map((e: { pointer: string }) => e.pointer)).toEqual(["#/id", "#/name"]);
    expect(error.data).toEqual({ id: "not-a-number", name: 1 });
  });

  it("skips validation when disabled", async () => {
    const c = createClient({ validate: false });
    await expect(c.get("/invalid")).resolves.toEqual({ id: "not-a-number", name: 1 });
  });

  it("transforms parameters", async () => {
    const res = await client.echoGet({
      params: { id: 1, itemId: 2 },
      queries: { q: "a", page: 10 },
      headers: { "x-api-key": "k" },
    });
    expect(res.url).toContain("page=9");
  });

  it("sends defaults only when sendDefaults is enabled", async () => {
    const c1 = createClient();
    expect((await c1.get("/echo/defaults")).url).toBe("/echo/defaults");
    const c2 = createClient({ sendDefaults: true });
    expect((await c2.get("/echo/defaults")).url).toBe("/echo/defaults?limit=42");
  });

  it("leaves omitted exactOptional parameters out, and rejects them when set to undefined", async () => {
    const c = createClient({ sendDefaults: true });
    await expect(c.get("/echo/defaults", { queries: { cursor: "abc" } })).resolves.toMatchObject({
      url: "/echo/defaults?cursor=abc&limit=42",
    });
    // @ts-expect-error exactOptional: omit the key instead of setting it to undefined
    const error = await c.get("/echo/defaults", { queries: { cursor: undefined } }).catch((e) => e);
    expect(error).toBeInstanceOf(ZodcallError);
    expect(error.extensions).toEqual({ parameter: { name: "cursor", in: "query" } });
    // `.optional()` still accepts an explicit undefined
    await expect(
      c.get("/echo/defaults", { queries: { legacy: undefined } }),
    ).resolves.toMatchObject({ url: "/echo/defaults?limit=42" });
  });

  it("works with zod/mini schemas", async () => {
    const c = new Zodcall(server.url, [
      {
        method: "get",
        path: "/users/:id",
        alias: "getUser",
        parameters: [{ name: "fields", type: "Query", schema: zm.exactOptional(zm.string()) }],
        response: zm.object({ id: zm.number(), name: zm.string() }),
      },
    ]);
    await expect(c.getUser({ params: { id: 5 } })).resolves.toEqual({
      id: 5,
      name: "user5",
    });
  });
});

describe("errors", () => {
  it("throws ZodcallHttpError on non 2xx", async () => {
    const error = await client.getUser({ params: { id: "404" } }).catch((e) => e);
    expect(error).toBeInstanceOf(ZodcallHttpError);
    expect(error.status).toBe(404);
    expect(error.response.data).toEqual({ code: "NOT_FOUND", message: "no user" });
    // non problem+json bodies are mapped to an `about:blank` problem
    expect(error.toJSON()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Request 'get /users/:id' failed with status 404",
    });
  });

  it("adopts RFC 9457 problem details sent by the server", async () => {
    const error = await client
      .transfer(undefined, { params: { accountId: 12345, transferId: 67890 } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ZodcallHttpError);
    expect(error.toJSON()).toEqual({
      type: "https://example.com/errors/insufficient-funds",
      title: "残高が不足しています",
      status: 403,
      detail: "残高は30ポイントですが、50ポイント必要です",
      instance: "/accounts/12345/transfers/67890",
      balance: 30,
    });
    expect(error.response.headers.get("content-type")).toBe("application/problem+json");
    expect(JSON.parse(JSON.stringify(error))).toEqual(error.toJSON());

    if (isErrorFromAlias(api, "transfer", error) && error.response.status === 403) {
      expect(error.response.data.balance).toBe(30);
    } else {
      expect.unreachable();
    }
  });

  it("narrows errors with isErrorFromAlias / isErrorFromPath", async () => {
    const error = await client.getUser({ params: { id: "404" } }).catch((e) => e);
    expect(isErrorFromAlias(api, "getUser", error)).toBe(true);
    expect(isErrorFromPath(api, "get", "/users/:id", error)).toBe(true);
    expect(isErrorFromPath(api, "get", "/users", error)).toBe(false);
    if (isErrorFromAlias(api, "getUser", error) && error.response.status === 404) {
      expect(error.response.data.code).toBe("NOT_FOUND");
    }

    const error500 = await client.getUser({ params: { id: "500" } }).catch((e) => e);
    expect(isErrorFromAlias(api, "getUser", error500)).toBe(true);
    expect(isErrorFromAlias(api, "getUser", new Error("x"))).toBe(false);
  });
});

describe("plugins", () => {
  it("intercepts requests and responses", async () => {
    const c = createClient();
    const plugin: ZodcallPlugin = {
      name: "auth",
      request: async (_, config) => ({
        ...config,
        headers: { ...config.headers, authorization: "Bearer plugin" },
      }),
      response: async (_, __, response) => response,
    };
    c.use(plugin);
    const res = await c.post("/echo/text", "x");
    expect(res.headers.authorization).toBe("Bearer plugin");
    c.eject("auth");
    const res2 = await c.post("/echo/text", "x");
    expect(res2.headers.authorization).toBeUndefined();
  });

  it("registers endpoint plugins by alias and path", async () => {
    const c = createClient();
    const transform = (suffix: string): ZodcallPlugin => ({
      response: async (_, __, response) => ({
        ...response,
        data: (({ name, ...rest }) => ({ ...rest, name: `${name}${suffix}` }))(
          user.parse(response.data),
        ),
      }),
    });
    const id = c.use("getUser", transform("!"));
    c.use("get", "/users/:id", transform("?"));
    await expect(c.getUser({ params: { id: 1 } })).resolves.toEqual({
      id: 1,
      name: "user1?!",
    });
    c.eject(id);
    await expect(c.getUser({ params: { id: 1 } })).resolves.toEqual({
      id: 1,
      name: "user1?",
    });
    // @ts-expect-error
    expect(() => c.use("unknown", transform(""))).toThrow(
      "Zodcall: no alias 'unknown' found to register plugin",
    );
  });

  it("recovers from errors with an error plugin", async () => {
    const c = createClient();
    c.use({
      error: async (_, config, error) => {
        if (error instanceof ZodcallHttpError && error.status === 404) {
          return { ...error.response, data: { id: 0, name: "fallback" } };
        }
        throw error;
      },
    });
    await expect(c.getUser({ params: { id: "404" } })).resolves.toEqual({
      id: 0,
      name: "fallback",
    });
  });
});
