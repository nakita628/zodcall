import type { OpenAPI } from "oas-truth";
import { format } from "oxfmt";
import { describe, expect, it } from "vite-plus/test";

import { makeClientCode } from "./index.js";
import type { GenerateOptions } from "./index.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` as const });

const json = (schema: object) => ({ "application/json": { schema } });

const problem = { "application/problem+json": { schema: ref("Problem") } };

const openAPI: OpenAPI = {
  openapi: "3.1.0",
  info: { title: "Petstore", version: "1.0.0" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "tag", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "ok", content: json({ type: "array", items: ref("Pet") }) },
        },
      },
      post: {
        operationId: "createPet",
        requestBody: { required: true, content: json(ref("NewPet")) },
        responses: {
          "201": { description: "created", content: json(ref("Pet")) },
          default: { description: "error", content: problem },
        },
      },
    },
    "/pets/{petId}": {
      parameters: [{ name: "petId", in: "path", required: true, schema: { type: "integer" } }],
      get: {
        operationId: "getPet",
        parameters: [{ name: "x-request-id", in: "header", schema: { type: "string" } }],
        responses: {
          "200": { description: "ok", content: json(ref("Pet")) },
          "404": { description: "not found", content: problem },
        },
      },
      delete: { responses: { "204": { description: "deleted" } } },
    },
  },
  components: {
    schemas: {
      NewPet: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, tag: { type: "string" } },
      },
      Pet: {
        allOf: [
          ref("NewPet"),
          { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        ],
      },
      Problem: {
        type: "object",
        properties: { title: { type: "string" }, status: { type: "integer" } },
      },
    },
  },
};

async function generate(document: OpenAPI, options?: GenerateOptions) {
  return (await format("client.ts", makeClientCode(document, options), {})).code;
}

describe("makeClientCode", () => {
  it("generates schemas, api and createClient", async () => {
    expect(await generate(openAPI)).toBe(`import { makeApi, Zodcall } from "zodcall";
import type { ZodcallOptions } from "zodcall";
import * as z from "zod";

export const NewPetSchema = z.object({ name: z.string(), tag: z.string().exactOptional() });

export const PetSchema = z.intersection(NewPetSchema, z.object({ id: z.int() }));

export const ProblemSchema = z.object({
  title: z.string().exactOptional(),
  status: z.int().exactOptional(),
});

export const api = makeApi([
  {
    method: "get",
    path: "/pets",
    alias: "listPets",
    parameters: [
      { name: "limit", type: "Query", schema: z.int().exactOptional() },
      { name: "tag", type: "Query", schema: z.string() },
    ],
    response: z.array(PetSchema),
  },
  {
    method: "post",
    path: "/pets",
    alias: "createPet",
    parameters: [{ name: "body", type: "Body", schema: NewPetSchema }],
    response: PetSchema,
    status: 201,
    errors: [{ status: "default", schema: ProblemSchema }],
  },
  {
    method: "get",
    path: "/pets/:petId",
    alias: "getPet",
    parameters: [
      { name: "petId", type: "Path", schema: z.int() },
      { name: "x-request-id", type: "Header", schema: z.string().exactOptional() },
    ],
    response: PetSchema,
    errors: [{ status: 404, schema: ProblemSchema }],
  },
  {
    method: "delete",
    path: "/pets/:petId",
    parameters: [{ name: "petId", type: "Path", schema: z.int() }],
    response: z.void(),
    status: 204,
  },
]);

export function createClient(baseURL: string, options?: ZodcallOptions) {
  return new Zodcall(baseURL, api, options);
}
`);
  });

  it("exports z.infer types and readonly schemas when asked", async () => {
    expect(await generate(openAPI, { exportTypes: true, readonly: true }))
      .toBe(`import { makeApi, Zodcall } from "zodcall";
import type { ZodcallOptions } from "zodcall";
import * as z from "zod";

export const NewPetSchema = z
  .object({ name: z.string(), tag: z.string().exactOptional() })
  .readonly();

export type NewPetSchema = z.infer<typeof NewPetSchema>;

export const PetSchema = z.intersection(NewPetSchema, z.object({ id: z.int() }).readonly());

export type PetSchema = z.infer<typeof PetSchema>;

export const ProblemSchema = z
  .object({ title: z.string().exactOptional(), status: z.int().exactOptional() })
  .readonly();

export type ProblemSchema = z.infer<typeof ProblemSchema>;

export const api = makeApi([
  {
    method: "get",
    path: "/pets",
    alias: "listPets",
    parameters: [
      { name: "limit", type: "Query", schema: z.int().exactOptional() },
      { name: "tag", type: "Query", schema: z.string() },
    ],
    response: z.array(PetSchema),
  },
  {
    method: "post",
    path: "/pets",
    alias: "createPet",
    parameters: [{ name: "body", type: "Body", schema: NewPetSchema }],
    response: PetSchema,
    status: 201,
    errors: [{ status: "default", schema: ProblemSchema }],
  },
  {
    method: "get",
    path: "/pets/:petId",
    alias: "getPet",
    parameters: [
      { name: "petId", type: "Path", schema: z.int() },
      { name: "x-request-id", type: "Header", schema: z.string().exactOptional() },
    ],
    response: PetSchema,
    errors: [{ status: 404, schema: ProblemSchema }],
  },
  {
    method: "delete",
    path: "/pets/:petId",
    parameters: [{ name: "petId", type: "Path", schema: z.int() }],
    response: z.void(),
    status: 204,
  },
]);

export function createClient(baseURL: string, options?: ZodcallOptions) {
  return new Zodcall(baseURL, api, options);
}
`);
  });

  it("generates an empty api without components", async () => {
    expect(
      await generate({ openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {} }),
    ).toBe(
      `import { makeApi, Zodcall } from "zodcall";
import type { ZodcallOptions } from "zodcall";
import * as z from "zod";

export const api = makeApi([]);

export function createClient(baseURL: string, options?: ZodcallOptions) {
  return new Zodcall(baseURL, api, options);
}
`,
    );
  });

  it("derives aliases from operationId", async () => {
    const operation = { responses: { "204": { description: "ok" } } };
    const code = await generate({
      openapi: "3.1.0",
      info: { title: "x", version: "1" },
      paths: {
        "/a": { get: { ...operation, operationId: "list-pets" } },
        "/b": { get: { ...operation, operationId: "listPets" } },
        "/c": { get: { ...operation, operationId: "pets.list" } },
        "/d": { get: { ...operation, operationId: "2fa-verify" } },
      },
    });
    expect([...code.matchAll(/alias: "(\w+)"/gu)].map((match) => match[1])).toStrictEqual([
      "listPets",
      "listPets2",
      "petsList",
      "_2faVerify",
    ]);
  });
});
