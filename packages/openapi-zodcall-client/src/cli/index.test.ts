import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { runCli } from "./index.js";

const document = `openapi: 3.1.0
info:
  title: Petstore
  version: 1.0.0
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: integer
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      required: [id]
      properties:
        id:
          type: integer
`;

const expected = `import { makeApi, Zodcall } from "zodcall";
import type { ZodcallOptions } from "zodcall";
import * as z from "zod";

export const PetSchema = z.object({ id: z.int() });

export const api = makeApi([
  {
    method: "get",
    path: "/pets/:petId",
    alias: "getPet",
    parameters: [{ name: "petId", type: "Path", schema: z.int() }],
    response: PetSchema,
  },
]);

export function createClient(baseURL: string, options?: ZodcallOptions) {
  return new Zodcall(baseURL, api, options);
}
`;

function run(args: readonly string[]) {
  return Effect.runPromise(runCli(args).pipe(Effect.provide(NodeServices.layer)));
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "openapi-zodcall-client-"));
  const input = join(dir, "openapi.yaml");
  await writeFile(input, document);
  return { dir, input };
}

describe("openapi-zodcall-client", () => {
  it("writes the client to -o", async () => {
    const { dir, input } = await setup();
    const output = join(dir, "src/client.ts");
    await run([input, "-o", output]);
    expect(await readFile(output, "utf8")).toBe(expected);
  });

  it("generates from a config file", async () => {
    const { dir, input } = await setup();
    const output = join(dir, "client.ts");
    const config = join(dir, "openapi-zodcall-client.config.ts");
    await writeFile(
      config,
      `export default ${JSON.stringify({ input, output, exportTypes: true, readonly: true })};\n`,
    );
    await run(["-c", config]);
    expect(await readFile(output, "utf8")).toBe(
      expected.replace(
        "export const PetSchema = z.object({ id: z.int() });\n",
        "export const PetSchema = z.object({ id: z.int() }).readonly();\n\nexport type PetSchema = z.infer<typeof PetSchema>;\n",
      ),
    );
  });

  it("rejects an invalid config", async () => {
    const { dir } = await setup();
    const config = join(dir, "openapi-zodcall-client.config.ts");
    await writeFile(config, `export default { input: "openapi.yaml", output: "client.js" };\n`);
    await expect(run(["-c", config])).rejects.toThrow(/ending in \.ts/u);
  });

  it("requires -o with <input>", async () => {
    const { input } = await setup();
    await expect(run([input])).rejects.toThrow();
  });
});
