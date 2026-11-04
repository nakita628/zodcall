import { pathToFileURL } from "node:url";

import { Data, Effect, FileSystem, Path, Schema } from "effect";

export const DEFAULT_CONFIG_FILE = "openapi-zodcall-client.config.ts";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
}> {}

const ConfigSchema = Schema.Struct({
  /** OpenAPI (.yaml, .yml, .json) or TypeSpec (.tsp) document */
  input: Schema.String,
  /** TypeScript file the client is written to */
  output: Schema.String.pipe(
    Schema.refine((value: string): value is `${string}.ts` => value.endsWith(".ts"), {
      message: "output must be a TypeScript file path ending in .ts",
    }),
  ),
  /** Export `type XSchema = z.infer<typeof XSchema>` next to each component schema. Default: false */
  exportTypes: Schema.optionalKey(Schema.Boolean),
  /** Make component schemas `.readonly()`. Default: false */
  readonly: Schema.optionalKey(Schema.Boolean),
});

export type Config = typeof ConfigSchema.Type;

/** Types the default export of `openapi-zodcall-client.config.ts`. */
export function defineConfig(config: Config) {
  return config;
}

/** Imports a config file (Node runs `.ts` natively) and validates its default export. */
export function readConfig(configPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolute = path.resolve(configPath);
    if (!(yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new ConfigError({ message: `Config not found: ${absolute}` });
    }
    const module: unknown = yield* Effect.tryPromise({
      try: () => import(pathToFileURL(absolute).href),
      catch: (error) =>
        new ConfigError({ message: error instanceof Error ? error.message : String(error) }),
    });
    const config =
      typeof module === "object" && module !== null && "default" in module
        ? module.default
        : undefined;
    return yield* Schema.decodeUnknownEffect(ConfigSchema)(config).pipe(
      Effect.mapError((error) => new ConfigError({ message: `${absolute}: ${error.message}` })),
    );
  });
}
