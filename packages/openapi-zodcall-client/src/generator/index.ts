import { makeAdapter, makeSchemaDeclarations, schemaImportLine } from "oas-truth";
import type {
  Content,
  Media,
  OpenAPI,
  Operation,
  Parameter,
  PathItem,
  Reference,
  Schema,
} from "oas-truth";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "query"] as const;

const PARAMETER_TYPES = { path: "Path", query: "Query", header: "Header" } as const;

const zod = makeAdapter("zod");

export type GenerateOptions = {
  /** Export `type XSchema = z.infer<typeof XSchema>` next to each component schema. Default: false */
  readonly exportTypes?: boolean;
  /** Make component schemas `.readonly()`. Default: false */
  readonly readonly?: boolean;
};

/**
 * Generates a TypeScript module for zodcall from a bundled OpenAPI document:
 * every `components.schemas` as a zod schema, `api` (the `makeApi` definition)
 * and `createClient`.
 */
export function makeClientCode(openAPI: OpenAPI, options: GenerateOptions = {}) {
  const schemaOptions = {
    exportTypes: options.exportTypes === true,
    readonly: options.readonly === true,
  };
  const declarations = makeSchemaDeclarations(
    openAPI.components?.schemas ?? {},
    zod,
    schemaOptions,
  );
  const plainImport = schemaImportLine(zod, schemaOptions);
  const cyclic = declarations.some((declaration) => declaration.importLine !== plainImport);
  const imports = [
    'import { makeApi, Zodcall } from "zodcall";',
    'import type { ZodcallOptions } from "zodcall";',
    schemaImportLine(zod, schemaOptions, cyclic),
  ];
  const aliases = new Set<string>();
  const endpoints = Object.entries(openAPI.paths ?? {}).flatMap(([path, item]) => {
    const pathItem = resolve<PathItem>(openAPI, item);
    if (pathItem === undefined) return [];
    return METHODS.flatMap((method) => {
      const operation = pathItem[method];
      if (operation === undefined) return [];
      return [makeEndpoint(openAPI, method, path, pathItem, operation, aliases)];
    });
  });
  // one blank line between statements: the formatter keeps blank lines, it does not add them
  return [
    imports.join("\n"),
    ...declarations.map((declaration) => `${declaration.code};`),
    `export const api = makeApi([${endpoints.join(",")}]);`,
    "export function createClient(baseURL: string, options?: ZodcallOptions) {\n  return new Zodcall(baseURL, api, options);\n}\n",
  ].join("\n\n");
}

function makeEndpoint(
  openAPI: OpenAPI,
  method: (typeof METHODS)[number],
  path: string,
  pathItem: PathItem,
  operation: Operation,
  aliases: Set<string>,
) {
  const fields: string[] = [
    `method: ${JSON.stringify(method)}`,
    `path: ${JSON.stringify(path.replaceAll(/\{([^}]+)\}/gu, ":$1"))}`,
  ];
  const alias = operation.operationId === undefined ? "" : toAlias(operation.operationId, aliases);
  if (alias !== "") fields.push(`alias: ${JSON.stringify(alias)}`);
  const description = operation.summary ?? operation.description;
  if (description !== undefined) fields.push(`description: ${JSON.stringify(description)}`);

  const parameters = makeParameters(openAPI, pathItem, operation);
  const body = resolve(openAPI, operation.requestBody);
  const bodyMedia = body?.content === undefined ? undefined : pickMedia(openAPI, body.content);
  if (bodyMedia !== undefined) {
    if (bodyMedia.format !== "json") {
      fields.push(`requestFormat: ${JSON.stringify(bodyMedia.format)}`);
    }
    const schema = bodyMedia.schema === undefined ? "z.unknown()" : toSchema(bodyMedia.schema);
    parameters.push(
      `{ name: "body", type: "Body", schema: ${body?.required === true ? schema : optional(schema)} }`,
    );
  }
  if (parameters.length > 0) fields.push(`parameters: [${parameters.join(",")}]`);

  const statuses = Object.keys(operation.responses);
  const success = statuses.filter((status) => /^2\d\d$/u.test(status)).sort()[0];
  fields.push(`response: ${makeResponse(openAPI, operation, success)}`);
  if (success !== undefined && success !== "200") fields.push(`status: ${success}`);

  const errors = statuses
    .filter(
      (status) => status === "default" || (/^\d{3}$/u.test(status) && !status.startsWith("2")),
    )
    .map((status) => {
      const code = status === "default" ? '"default"' : status;
      return `{ status: ${code}, schema: ${makeResponse(openAPI, operation, status)} }`;
    });
  if (errors.length > 0) fields.push(`errors: [${errors.join(",")}]`);

  return `{${fields.join(",")}}`;
}

/** Path-level parameters overridden by the operation's, cookies left out (zodcall does not send them). */
function makeParameters(openAPI: OpenAPI, pathItem: PathItem, operation: Operation) {
  const merged = new Map<string, Parameter>();
  for (const value of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = resolve<Parameter>(openAPI, value);
    if (parameter !== undefined) merged.set(`${parameter.in} ${parameter.name}`, parameter);
  }
  return [...merged.values()].flatMap((parameter) => {
    if (parameter.in === "cookie") return [];
    const media =
      parameter.content === undefined ? undefined : pickMedia(openAPI, parameter.content);
    const source = parameter.schema ?? media?.schema;
    const schema = source === undefined ? "z.string()" : toSchema(source);
    const required = parameter.in === "path" || parameter.required === true;
    const fields = [
      `name: ${JSON.stringify(parameter.name)}`,
      ...(parameter.description === undefined
        ? []
        : [`description: ${JSON.stringify(parameter.description)}`]),
      `type: "${PARAMETER_TYPES[parameter.in]}"`,
      `schema: ${required ? schema : optional(schema)}`,
    ];
    return [`{${fields.join(",")}}`];
  });
}

function makeResponse(openAPI: OpenAPI, operation: Operation, status: string | undefined) {
  if (status === undefined) return "z.unknown()";
  const response = resolve(openAPI, operation.responses[status]);
  if (response?.content === undefined || Object.keys(response.content).length === 0) {
    return "z.void()";
  }
  const media = pickMedia(openAPI, response.content);
  if (media?.schema === undefined) return media?.format === "text" ? "z.string()" : "z.unknown()";
  return toSchema(media.schema);
}

type Format = "json" | "form-data" | "form-url" | "text" | "binary";

/** The media type zodcall handles best: JSON first, then forms, text and binary. */
function pickMedia(openAPI: OpenAPI, content: Content | Record<string, Media | Reference>) {
  const entries = Object.entries(content).map(([type, value]) => ({
    format: toFormat(type),
    schema: resolve<Media>(openAPI, value)?.schema as Schema | undefined,
  }));
  const order: readonly Format[] = ["json", "form-data", "form-url", "text", "binary"];
  return entries.sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format))[0];
}

function toFormat(mediaType: string): Format {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json" || type.endsWith("+json") || type === "*/*") return "json";
  if (type === "multipart/form-data") return "form-data";
  if (type === "application/x-www-form-urlencoded") return "form-url";
  if (type.startsWith("text/")) return "text";
  return "binary";
}

function toSchema(schema: Schema) {
  return zod.toExpression(schema);
}

function optional(schema: string) {
  return schema.endsWith(".exactOptional()") ? schema : `${schema}.exactOptional()`;
}

/** `list-pets`, `pets.list` → `listPets`, `petsList`; a taken alias gets a numeric suffix. */
function toAlias(operationId: string, aliases: Set<string>) {
  const words = operationId.split(/[^A-Za-z0-9_$]+/u).filter((word) => word !== "");
  const joined = words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
  const base = /^[0-9]/u.test(joined) ? `_${joined}` : joined;
  if (base === "") return "";
  let alias = base;
  for (let index = 2; aliases.has(alias); index++) alias = `${base}${index}`;
  aliases.add(alias);
  return alias;
}

/** Follows local `$ref`s (`#/components/parameters/Limit`, ...) to the object they point at. */
function resolve<T>(openAPI: OpenAPI, value: T | Reference | undefined): T | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 32; depth++) {
    if (!isReference(current)) return current as T | undefined;
    const ref = current.$ref;
    if (!ref.startsWith("#/")) return undefined;
    current = ref
      .slice(2)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>(
        (node, key) =>
          typeof node === "object" && node !== null
            ? (node as Record<string, unknown>)[key]
            : undefined,
        openAPI,
      );
  }
  return undefined;
}

function isReference(value: unknown): value is { readonly $ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === "string"
  );
}
