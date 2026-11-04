import * as z from "zod";
import type {
  AnySchema,
  ZodcallEndpointDefinition,
  ZodcallEndpointDefinitions,
  ZodcallEndpointError,
  ZodcallEndpointParameter,
} from "../types";
import { capitalize, toZod } from "../utils";

/*
 * Define and compose api descriptions.
 */

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * `{ a: schemaA, b: schemaB }` -> parameter definitions of the given type
 */
/**
 * Flatten a tuple type one level
 * @example
 * ```ts
 * type T0 = TupleFlat<[1, 2, [3, 4], 5]>; // T0 = [1, 2, 3, 4, 5]
 * ```
 */
type TupleFlat<T, Acc extends unknown[] = []> = T extends readonly [infer Head, ...infer Tail]
  ? Head extends readonly unknown[]
    ? TupleFlat<Tail, [...Acc, ...Head]>
    : TupleFlat<Tail, [...Acc, Head]>
  : Acc;

/**
 * trick to combine multiple unions of objects into a single object
 */
type UnionToIntersection<union> = (union extends any ? (k: union) => void : never) extends (
  k: infer intersection,
) => void
  ? intersection
  : never;

type GetUnionLast<Union> =
  UnionToIntersection<Union extends any ? () => Union : never> extends () => infer Last
    ? Last
    : never;

/**
 * Convert union to tuple (only used by `mergeApis`)
 */
type UnionToTuple<Union, Tuple extends unknown[] = []> = [Union] extends [never]
  ? Tuple
  : UnionToTuple<Exclude<Union, GetUnionLast<Union>>, [GetUnionLast<Union>, ...Tuple]>;

type ObjectToQueryParameters<
  Type extends "Query" | "Path" | "Header",
  T extends Record<string, AnySchema>,
  Keys = UnionToTuple<keyof T>,
> = {
  [Index in keyof Keys]: {
    name: Keys[Index];
    type: Type;
    description?: string;
    schema: T[Extract<Keys[Index], keyof T>];
  };
};

type CleanPath<Path extends string> = Path extends `${infer PClean}/` ? PClean : Path;
type MapApiPath<Path extends string, Api, Acc extends unknown[] = []> = Api extends readonly [
  infer Head,
  ...infer Tail,
]
  ? MapApiPath<
      Path,
      Tail,
      [
        ...Acc,
        {
          [K in keyof Head]: K extends "path"
            ? Head[K] extends string
              ? CleanPath<`${Path}${Head[K]}`>
              : Head[K]
            : Head[K];
        },
      ]
    >
  : Acc;
type MergeApis<
  Apis extends Record<string, ZodcallEndpointDefinitions>,
  MergedPathApis = UnionToTuple<
    {
      [K in keyof Apis]: K extends string ? MapApiPath<K, Apis[K]> : never;
    }[keyof Apis]
  >,
> = TupleFlat<MergedPathApis>;

/* -------------------------------------------------------------------------- */
/*                                Definitions                                 */
/* -------------------------------------------------------------------------- */

/**
 * check api for non unique paths
 * @param api - api to check
 * @return - nothing
 * @throws - error if api has non unique paths
 */
export function checkApi<T extends ZodcallEndpointDefinitions>(api: T) {
  // check if no duplicate path
  const paths = new Set<string>();
  for (let endpoint of api) {
    const fullpath = `${endpoint.method} ${endpoint.path}`;
    if (paths.has(fullpath)) {
      throw new Error(`Zodcall: Duplicate path '${fullpath}'`);
    }
    paths.add(fullpath);
  }
  // check if no duplicate alias
  const aliases = new Set<string>();
  for (let endpoint of api) {
    if (endpoint.alias) {
      if (aliases.has(endpoint.alias)) {
        throw new Error(`Zodcall: Duplicate alias '${endpoint.alias}'`);
      }
      aliases.add(endpoint.alias);
    }
  }
  // check if no duplicate body in parameters
  for (let endpoint of api) {
    if (endpoint.parameters) {
      const bodyParams = endpoint.parameters.filter((p) => p.type === "Body");
      if (bodyParams.length > 1) {
        throw new Error(`Zodcall: Multiple body parameters in endpoint '${endpoint.path}'`);
      }
    }
  }
}
/**
 * Simple helper to split your api definitions into multiple files
 * Mandatory to be used when declaring your endpoint definitions outside zodios constructor
 * to enable type inferrence and autocompletion
 * @param api - api definitions
 * @returns the api definitions
 */
export function makeApi<const Api extends ZodcallEndpointDefinitions>(api: Api): Api {
  checkApi(api);
  return api;
}
/**
 * Simple helper to split your parameter definitions into multiple files
 * Mandatory to be used when declaring parameters appart from your endpoint definitions
 * to enable type inferrence and autocompletion
 * @param params - api parameter definitions
 * @returns the api parameter definitions
 */
export function makeParameters<
  const ParameterDescriptions extends readonly ZodcallEndpointParameter[],
>(params: ParameterDescriptions): ParameterDescriptions {
  return params;
}

/**
 * Simple helper to split your error definitions into multiple files
 * Mandatory to be used when declaring errors appart from your endpoint definitions
 * to enable type inferrence and autocompletion
 * @param errors - api error definitions
 * @returns the error definitions
 */
export function makeErrors<const ErrorDescription extends readonly ZodcallEndpointError[]>(
  errors: ErrorDescription,
): ErrorDescription {
  return errors;
}
/**
 * Simple helper to split your error definitions into multiple files
 * Mandatory to be used when declaring errors appart from your endpoint definitions
 * to enable type inferrence and autocompletion
 * @param endpoint - api endpoint definition
 * @returns the endpoint definition
 */
export function makeEndpoint<const T extends ZodcallEndpointDefinition<any>>(endpoint: T): T {
  return endpoint;
}

/* -------------------------------------------------------------------------- */
/*                                  Builders                                  */
/* -------------------------------------------------------------------------- */

function describe(schema: AnySchema): string | undefined {
  if ("description" in schema && typeof schema.description === "string") {
    return schema.description;
  }
  return z.globalRegistry.get(toZod(schema))?.description;
}

/**
 * add the schema description to a parameter, only when the schema has one
 */
function withDescription<P extends { schema: AnySchema }>(param: P): P & { description?: string } {
  const description = describe(param.schema);
  return description === undefined ? param : { ...param, description };
}

export function parametersBuilder() {
  return new ParametersBuilder<[]>([]);
}
class ParametersBuilder<T extends readonly ZodcallEndpointParameter[]> {
  constructor(private params: T) {}
  addParameter<
    Name extends string,
    Type extends "Path" | "Query" | "Body" | "Header",
    Schema extends AnySchema,
  >(name: Name, type: Type, schema: Schema) {
    return new ParametersBuilder<
      [...T, { name: Name; type: Type; description?: string; schema: Schema }]
    >([...this.params, withDescription({ name, type, schema })]);
  }
  addParameters<
    Type extends "Query" | "Path" | "Header",
    Schemas extends Record<string, AnySchema>,
  >(
    type: Type,
    schemas: Schemas,
  ): ParametersBuilder<
    [...T, ...Extract<ObjectToQueryParameters<Type, Schemas>, ZodcallEndpointParameter[]>]
  >;
  addParameters(
    type: "Query" | "Path" | "Header",
    schemas: Record<string, AnySchema>,
  ): ParametersBuilder<readonly ZodcallEndpointParameter[]> {
    const parameters = Object.entries(schemas).map(([name, schema]) =>
      withDescription({ name, type, schema }),
    );
    return new ParametersBuilder([...this.params, ...parameters]);
  }
  addBody<Schema extends AnySchema>(schema: Schema) {
    return this.addParameter("body", "Body", schema);
  }
  addQuery<Name extends string, Schema extends AnySchema>(name: Name, schema: Schema) {
    return this.addParameter(name, "Query", schema);
  }
  addPath<Name extends string, Schema extends AnySchema>(name: Name, schema: Schema) {
    return this.addParameter(name, "Path", schema);
  }
  addHeader<Name extends string, Schema extends AnySchema>(name: Name, schema: Schema) {
    return this.addParameter(name, "Header", schema);
  }
  addQueries<Schemas extends Record<string, AnySchema>>(schemas: Schemas) {
    return this.addParameters("Query", schemas);
  }
  addPaths<Schemas extends Record<string, AnySchema>>(schemas: Schemas) {
    return this.addParameters("Path", schemas);
  }
  addHeaders<Schemas extends Record<string, AnySchema>>(schemas: Schemas) {
    return this.addParameters("Header", schemas);
  }
  build() {
    return this.params;
  }
}

export class Builder<T extends ZodcallEndpointDefinitions> {
  constructor(private readonly api: T) {}
  addEndpoint<const E extends ZodcallEndpointDefinition>(endpoint: E): Builder<readonly [...T, E]> {
    return new Builder<readonly [...T, E]>([...this.api, endpoint]);
  }
  build(): T {
    checkApi(this.api);
    return this.api;
  }
}
/**
 * Advanced helper to build your api definitions
 * compared to `makeApi()` you'll have better autocompletion experience and better error messages,
 * @param endpoint
 * @returns - a builder to build your api definitions
 */
export function apiBuilder(): Builder<[]>;
export function apiBuilder<const T extends ZodcallEndpointDefinition<any>>(
  endpoint: T,
): Builder<readonly [T]>;
export function apiBuilder(
  endpoint?: ZodcallEndpointDefinition,
): Builder<readonly ZodcallEndpointDefinition[]> {
  return new Builder(endpoint ? [endpoint] : []);
}

/* -------------------------------------------------------------------------- */
/*                                    CRUD                                    */
/* -------------------------------------------------------------------------- */

/**
 * Helper to generate a basic CRUD api for a given resource
 * @param resource - the resource to generate the api for
 * @param schema - the schema of the resource
 * @returns - the api definitions
 */
export function makeCrudApi<T extends string, S extends z.ZodObject<z.ZodRawShape>>(
  resource: T,
  schema: S,
) {
  const capitalizedResource = capitalize(resource);
  return makeApi([
    {
      method: "get",
      path: `/${resource}s`,
      alias: `get${capitalizedResource}s`,
      description: `Get all ${resource}s`,
      response: z.array(schema),
    },
    {
      method: "get",
      path: `/${resource}s/:id`,
      alias: `get${capitalizedResource}`,
      description: `Get a ${resource}`,
      response: schema,
    },
    {
      method: "post",
      path: `/${resource}s`,
      alias: `create${capitalizedResource}`,
      description: `Create a ${resource}`,
      parameters: [
        {
          name: "body",
          type: "Body",
          description: "The object to create",
          schema: schema.partial(),
        },
      ],
      response: schema,
    },
    {
      method: "put",
      path: `/${resource}s/:id`,
      alias: `update${capitalizedResource}`,
      description: `Update a ${resource}`,
      parameters: [
        {
          name: "body",
          type: "Body",
          description: "The object to update",
          schema: schema,
        },
      ],
      response: schema,
    },
    {
      method: "patch",
      path: `/${resource}s/:id`,
      alias: `patch${capitalizedResource}`,
      description: `Patch a ${resource}`,
      parameters: [
        {
          name: "body",
          type: "Body",
          description: "The object to patch",
          schema: schema.partial(),
        },
      ],
      response: schema,
    },
    {
      method: "delete",
      path: `/${resource}s/:id`,
      alias: `delete${capitalizedResource}`,
      description: `Delete a ${resource}`,
      response: schema,
    },
  ]);
}

/* -------------------------------------------------------------------------- */
/*                                  Compose                                   */
/* -------------------------------------------------------------------------- */

function cleanPath(path: string) {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
function prefixPaths(prefix: string, api: ZodcallEndpointDefinitions): ZodcallEndpointDefinition[] {
  return api.map((endpoint) => ({
    ...endpoint,
    path: cleanPath(`${prefix}${endpoint.path}`),
  }));
}
/**
 * prefix all paths of an api with a given prefix
 * @param prefix - the prefix to add
 * @param api - the api to prefix
 * @returns the prefixed api
 */
export function prefixApi<Prefix extends string, Api extends ZodcallEndpointDefinitions>(
  prefix: Prefix,
  api: Api,
): MapApiPath<Prefix, Api>;
export function prefixApi(prefix: string, api: ZodcallEndpointDefinitions): readonly unknown[] {
  return prefixPaths(prefix, api);
}
/**
 * Merge multiple apis into one in a route friendly way
 * @param apis - the apis to merge
 * @returns the merged api
 *
 * @example
 * ```ts
 * const api = mergeApis({
 *   "/users": usersApi,
 *   "/posts": postsApi,
 * });
 * ```
 */
export function mergeApis<Apis extends Record<string, ZodcallEndpointDefinitions>>(
  apis: Apis,
): MergeApis<Apis>;
export function mergeApis(apis: Record<string, ZodcallEndpointDefinitions>): readonly unknown[] {
  return Object.entries(apis).flatMap(([prefix, api]) => prefixPaths(prefix, api));
}
