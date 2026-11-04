import { describe, expectTypeOf, it } from "vite-plus/test";
import * as z from "zod";
import {
  type ApiOf,
  apiBuilder,
  makeCrudApi,
  mergeApis,
  type PathParamNames,
  prefixApi,
  isErrorFromAlias,
  makeApi,
  Zodcall,
  type ZodcallBodyByAlias,
  type ZodcallErrorByPath,
  type ZodcallPathParamsByPath,
  type ZodcallQueryParamsByAlias,
  type ZodcallResponseByAlias,
} from "../src";

const user = z.object({ id: z.number(), name: z.string() });

const api = makeApi([
  {
    method: "get",
    path: "/users",
    alias: "getUsers",
    parameters: [
      { name: "limit", type: "Query", schema: z.number().exactOptional() },
      { name: "q", type: "Query", schema: z.string() },
    ],
    response: z.array(user),
  },
  {
    method: "get",
    path: "/users/:id/posts/:postId",
    alias: "getPost",
    parameters: [{ name: "id", type: "Path", schema: z.number() }],
    response: z.object({ title: z.string() }),
    errors: [
      { status: 404, schema: z.object({ code: z.literal("NOT_FOUND") }) },
      { status: "default", schema: z.object({ message: z.string() }) },
    ],
  },
  {
    method: "post",
    path: "/users",
    alias: "createUser",
    parameters: [
      {
        name: "body",
        type: "Body",
        schema: z.object({ name: z.string(), age: z.coerce.number() }),
      },
    ],
    response: user.extend({ createdAt: z.string().transform((s) => new Date(s)) }),
  },
  {
    method: "delete",
    path: "/users/:id",
    alias: "deleteUser",
    response: z.void(),
  },
  {
    method: "query",
    path: "/users/search",
    alias: "searchUsers",
    parameters: [
      { name: "body", type: "Body", schema: z.object({ name: z.string() }) },
      { name: "limit", type: "Query", schema: z.number().exactOptional() },
    ],
    response: z.array(user),
  },
  {
    method: "get",
    path: "/health",
    alias: "health",
    response: z.object({ ok: z.boolean() }),
  },
]);

const client = new Zodcall("https://example.com", api);

describe("types", () => {
  it("infers responses", () => {
    expectTypeOf(client.get("/users", { queries: { q: "a" } })).resolves.toEqualTypeOf<
      { id: number; name: string }[]
    >();
    expectTypeOf(client.createUser).returns.resolves.toEqualTypeOf<{
      id: number;
      name: string;
      createdAt: Date;
    }>();
    expectTypeOf<ZodcallResponseByAlias<typeof api, "getPost">>().toEqualTypeOf<{
      title: string;
    }>();
  });

  it("infers bodies with zod input types", () => {
    expectTypeOf<ZodcallBodyByAlias<typeof api, "createUser">>().toEqualTypeOf<{
      name: string;
      age: unknown;
    }>();
  });

  it("infers path params from path and schemas", () => {
    expectTypeOf<
      ZodcallPathParamsByPath<typeof api, "get", "/users/:id/posts/:postId">
    >().toEqualTypeOf<{ postId: string | number | boolean; id: number }>();
  });

  it("infers query params", () => {
    expectTypeOf<ZodcallQueryParamsByAlias<typeof api, "getUsers">>().toEqualTypeOf<{
      q: string;
      limit?: number;
    }>();
  });

  it("derives optional parameters from zod's optionality, exactOptional first", () => {
    const optionality = makeApi([
      {
        method: "get",
        path: "/optionality",
        alias: "optionality",
        parameters: [
          { name: "exact", type: "Query", schema: z.number().exactOptional() },
          { name: "loose", type: "Query", schema: z.number().optional() },
          { name: "defaulted", type: "Query", schema: z.number().default(1) },
          { name: "nullable", type: "Query", schema: z.number().nullable() },
          { name: "maybeUndefined", type: "Query", schema: z.number().or(z.undefined()) },
        ],
        response: z.void(),
      },
    ]);
    expectTypeOf<ZodcallQueryParamsByAlias<typeof optionality, "optionality">>().toEqualTypeOf<{
      exact?: number;
      loose?: number | undefined;
      defaulted?: number | undefined;
      nullable: number | null;
      maybeUndefined: number | undefined;
    }>();
  });

  it("does not accept undefined for exactOptional parameters", () => {
    client.getUsers({ queries: { q: "a" } });
    client.getUsers({ queries: { q: "a", limit: 1 } });
    // @ts-expect-error omit the key instead
    client.getUsers({ queries: { q: "a", limit: undefined } });
  });

  it("supports the QUERY method with a body", () => {
    expectTypeOf(client.query("/users/search", { name: "a" })).resolves.toEqualTypeOf<
      { id: number; name: string }[]
    >();
    expectTypeOf(client.searchUsers).parameter(0).toEqualTypeOf<{ name: string }>();
    client.searchUsers({ name: "a" }, { queries: { limit: 1 } });
    // @ts-expect-error body is required
    client.query("/users/search");
    // @ts-expect-error body must match the schema
    client.searchUsers({ name: 1 });
    // @ts-expect-error query endpoints are not reachable with get
    client.get("/users/search");
  });

  it("requires config when params are required", () => {
    // @ts-expect-error queries.q is required
    client.getUsers();
    // @ts-expect-error params are required
    client.getPost();
    client.getPost({ params: { id: 1, postId: "a" } });
    // @ts-expect-error id must be a number
    client.getPost({ params: { id: "1", postId: "a" } });
    // @ts-expect-error unknown path
    client.get("/unknown");
    expectTypeOf(client).not.toHaveProperty("unknownAlias");
  });

  it("endpoints without parameters need no config", () => {
    expectTypeOf(client.health()).resolves.toEqualTypeOf<{ ok: boolean }>();
    expectTypeOf(client.get("/health")).resolves.toEqualTypeOf<{ ok: boolean }>();
    client.health({ timeout: 10, headers: { "x-trace": "1" } });
    client.deleteUser(undefined, { params: { id: 1 } });
  });

  it("allows fetch options", () => {
    client.getUsers({
      queries: { q: "a" },
      signal: new AbortController().signal,
      credentials: "include",
      headers: { authorization: "x" },
      timeout: 1000,
    });
  });

  it("infers errors", () => {
    expectTypeOf<
      ZodcallErrorByPath<typeof api, "get", "/users/:id/posts/:postId", 404>
    >().toEqualTypeOf<{ code: "NOT_FOUND" }>();
    expectTypeOf<
      ZodcallErrorByPath<typeof api, "get", "/users/:id/posts/:postId", 500>
    >().toEqualTypeOf<{ message: string }>();

    const error: unknown = null;
    if (isErrorFromAlias(api, "getPost", error)) {
      if (error.response.status === 404) {
        expectTypeOf(error.response.data).toEqualTypeOf<{ code: "NOT_FOUND" }>();
      }
    }
  });

  it("ApiOf extracts the api", () => {
    expectTypeOf<ApiOf<typeof client>>().toEqualTypeOf<typeof api>();
  });
});

describe("api helpers", () => {
  it("parses path params like the runtime regexp", () => {
    expectTypeOf<PathParamNames<"/a/:x-:y.json/b/:z_1?q=:not">>().toEqualTypeOf<
      "x" | "y" | "z_1" | "not"
    >();
    expectTypeOf<PathParamNames<"/no/params">>().toEqualTypeOf<never>();
  });

  it("apiBuilder keeps literal types", () => {
    const built = apiBuilder({ method: "get", path: "/a/:id", alias: "getA", response: z.string() })
      .addEndpoint({ method: "post", path: "/b", alias: "createB", response: z.number() })
      .build();
    const c = new Zodcall(built);
    expectTypeOf(c.getA({ params: { id: 1 } })).resolves.toEqualTypeOf<string>();
    expectTypeOf(c.createB(undefined)).resolves.toEqualTypeOf<number>();
  });

  it("mergeApis / prefixApi prefix paths", () => {
    const users = makeApi([{ method: "get", path: "/:id", alias: "getUser", response: user }]);
    const posts = makeApi([
      { method: "get", path: "/", alias: "getPosts", response: z.array(z.string()) },
    ]);
    const merged = mergeApis({ "/users": users, "/posts": posts });
    const c = new Zodcall(merged);
    expectTypeOf(c.get("/users/:id", { params: { id: 1 } })).resolves.toEqualTypeOf<{
      id: number;
      name: string;
    }>();
    expectTypeOf(c.get("/posts")).resolves.toEqualTypeOf<string[]>();
    const prefixed = new Zodcall(prefixApi("/v1", users));
    expectTypeOf(prefixed.getUser({ params: { id: 1 } })).resolves.toEqualTypeOf<{
      id: number;
      name: string;
    }>();
  });

  it("makeCrudApi generates aliases", () => {
    const c = new Zodcall(makeCrudApi("user", user));
    expectTypeOf(c.getUsers()).resolves.toEqualTypeOf<{ id: number; name: string }[]>();
    expectTypeOf(c.getUser({ params: { id: 1 } })).resolves.toEqualTypeOf<{
      id: number;
      name: string;
    }>();
  });
});
