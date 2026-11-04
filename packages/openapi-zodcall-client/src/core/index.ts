import { Data, Effect, FileSystem, Path } from "effect";
import { parseOpenAPI } from "oas-truth";
import { format } from "oxfmt";

import { makeClientCode } from "../generator/index.js";
import type { GenerateOptions } from "../generator/index.js";

export class GenerateError extends Data.TaggedError("GenerateError")<{
  readonly message: string;
}> {}

/** Reads `input` (OpenAPI .yaml / .json or TypeSpec .tsp) and writes the zodcall client to `output`. */
export function generate(input: string, output: string, options: GenerateOptions = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const result = yield* Effect.promise(() => parseOpenAPI(input));
    if (!result.ok) return yield* new GenerateError({ message: result.error });
    if (!result.value.openapi?.startsWith("3")) {
      return yield* new GenerateError({ message: `${input}: only OpenAPI 3.x is supported` });
    }
    const formatted = yield* Effect.promise(() =>
      format("client.ts", makeClientCode(result.value, options), {}),
    );
    if (formatted.errors.length > 0) {
      const message = formatted.errors.map((error) => error.message).join("\n");
      return yield* new GenerateError({ message });
    }
    yield* fs.makeDirectory(path.dirname(output), { recursive: true });
    yield* fs.writeFileString(output, formatted.code);
    return `Generated ${output}`;
  });
}
