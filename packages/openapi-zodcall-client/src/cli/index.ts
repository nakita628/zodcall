import { Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";

import manifest from "../../package.json" with { type: "json" };
import { DEFAULT_CONFIG_FILE, readConfig } from "../config/index.js";
import { generate } from "../core/index.js";

const COMMAND_NAME = "openapi-zodcall-client";

const commandLine = {
  input: Argument.File("input", { mustExist: true }).pipe(
    Argument.withDescription("OpenAPI (.yaml, .yml, .json) or TypeSpec (.tsp) document"),
    Argument.optional,
  ),
  output: Flag.String("output").pipe(
    Flag.withAlias("o"),
    Flag.withDescription("TypeScript file the client is written to"),
    Flag.withMetavar("output.ts"),
    Flag.optional,
  ),
  config: Flag.String("config").pipe(
    Flag.withAlias("c"),
    Flag.withDescription(`Config file to run (default: ./${DEFAULT_CONFIG_FILE})`),
    Flag.withMetavar("file"),
    Flag.optional,
  ),
} as const;

function usage(message: string) {
  return new CliError.ShowHelp({
    commandPath: [COMMAND_NAME],
    errors: [new CliError.UserError({ cause: new Error(message), userMessage: message })],
  });
}

function run(args: Command.Command.Config.Infer<typeof commandLine>) {
  return Effect.gen(function* () {
    const input = Option.getOrUndefined(args.input);
    const output = Option.getOrUndefined(args.output);
    const configPath = Option.getOrUndefined(args.config);
    if (configPath !== undefined && (input !== undefined || output !== undefined)) {
      return yield* usage("--config cannot be combined with <input> or --output.");
    }
    if (input !== undefined && output === undefined) {
      return yield* usage("<input> requires -o <output.ts>.");
    }
    if (input === undefined && output !== undefined) {
      return yield* usage("-o <output.ts> requires an <input> document.");
    }
    if (input !== undefined && output !== undefined) {
      return yield* Console.log(yield* generate(input, output));
    }
    const config = yield* readConfig(configPath ?? DEFAULT_CONFIG_FILE);
    return yield* Console.log(yield* generate(config.input, config.output, config));
  }).pipe(
    Effect.mapError((error) =>
      CliError.isCliError(error)
        ? error
        : new CliError.UserError({ cause: error, userMessage: error.message }),
    ),
  );
}

const command = Command.make(COMMAND_NAME, commandLine, run).pipe(
  Command.withDescription(manifest.description),
  Command.withExamples([
    {
      command: `${COMMAND_NAME} openapi.yaml -o src/client.ts`,
      description: "Generate a zodcall client",
    },
    { command: COMMAND_NAME, description: `Generate from ./${DEFAULT_CONFIG_FILE}` },
    {
      command: `${COMMAND_NAME} -c config/client.config.ts`,
      description: "Generate from another config file",
    },
  ]),
);

export function openapiZodcallClient() {
  return Command.run(command, { version: manifest.version });
}

/** Runs the command with explicit arguments (without the program name). */
export function runCli(args: readonly string[]) {
  return Command.runWith(command, { version: manifest.version })(args);
}
