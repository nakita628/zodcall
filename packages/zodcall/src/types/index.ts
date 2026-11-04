import type { ProblemTypes, ZodcallClass, ZodcallHttpError } from "../client";

/*
 * Type definitions only (no runtime code). Helper types that are not exported are internal.
 */

/* -------------------------------------------------------------------------- */
/*                                   Schema                                   */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural type of a zod schema (works with both `zod` and `zod/mini`).
 * Only `input`/`output` (and the optionality markers) are needed at the type level:
 * checking definitions against the full `$ZodType` is much more expensive for the compiler.
 */
export type AnySchema<Output = unknown, Input = unknown> = {
  readonly _zod: {
    readonly output: Output;
    readonly input: Input;
    /**
     * `"optional"` for `.exactOptional()` / `.optional()`, `"defaulted"` for `.default()`
     */
    readonly optin?: "optional" | "defaulted" | undefined;
    readonly optout?: "optional" | undefined;
  };
};

/*
 * `S["_zod"]["output"]` is a plain indexed access: cheaper than `z.output<S>` (a conditional type)
 */
type Output<S extends AnySchema> = S["_zod"]["output"];
type Input<S extends AnySchema> = S["_zod"]["input"];

type SchemaType<S extends AnySchema, Frontend extends boolean> = Frontend extends true
  ? Output<S>
  : Input<S>;

type InputType<S extends AnySchema, Frontend extends boolean> = Frontend extends true
  ? Input<S>
  : Output<S>;

/**
 * whether a parameter may be omitted, from zod's own optionality markers
 * (`optin` on the input side, `optout` on the output side), not from `undefined`
 * being accepted: `.exactOptional()` has no `undefined` in its type but is optional,
 * `z.string().or(z.undefined())` accepts `undefined` but must still be present.
 */
type IsOptional<S extends AnySchema, Frontend extends boolean> = Frontend extends true
  ? S["_zod"] extends { readonly optin: "optional" | "defaulted" }
    ? true
    : false
  : S["_zod"] extends { readonly optout: "optional" }
    ? true
    : false;

/* -------------------------------------------------------------------------- */
/*                               Utility types                                */
/* -------------------------------------------------------------------------- */

/**
 * Simplify a type by merging intersections if possible
 * @param T - type to simplify
 */
export type Simplify<T> = T extends unknown ? { [K in keyof T]: T[K] } : T;

/**
 * Merge two types into a single type
 * @param T - first type
 * @param U - second type
 */
export type Merge<T, U> = Simplify<T & U>;

/* -------------------------------------------------------------------------- */
/*                            Endpoint definitions                            */
/* -------------------------------------------------------------------------- */

export type MutationMethod = "post" | "put" | "patch" | "delete";

/**
 * methods whose client functions take the request body as first argument.
 * `query` (HTTP QUERY) is safe and idempotent like `get`, but carries a body.
 */
export type BodyMethod = MutationMethod | "query";

export type Method = "get" | "head" | "options" | BodyMethod;

export type RequestFormat =
  | "json" // default
  | "form-data" // for file uploads
  | "form-url" // for hiding query params in the body
  | "binary" // for binary data / file uploads
  | "text"; // for text data

/**
 * How the response body should be read.
 * - `auto` (default): infer from the `content-type` header
 */
export type ResponseType =
  | "auto"
  | "json"
  | "text"
  | "blob"
  | "arrayBuffer"
  | "formData"
  | "stream";

export type ZodcallParameterType = "Query" | "Body" | "Header" | "Path";

export type ZodcallEndpointParameter<T = unknown> = {
  /**
   * name of the parameter
   */
  name: string;
  /**
   * optional description of the parameter
   */
  description?: string;
  /**
   * type of the parameter: Query, Body, Header, Path
   */
  type: ZodcallParameterType;
  /**
   * zod schema of the parameter
   * you can use zod `transform` to transform the value of the parameter before sending it to the server
   */
  schema: AnySchema<T>;
};

export type ZodcallEndpointParameters = readonly ZodcallEndpointParameter[];

export type ZodcallEndpointError<T = unknown> = {
  /**
   * status code of the error
   * use 'default' to declare a default error
   */
  status: number | "default";
  /**
   * description of the error
   */
  description?: string;
  /**
   * schema of the error
   */
  schema: AnySchema<T>;
};

export type ZodcallEndpointErrors = readonly ZodcallEndpointError[];

/**
 * Endpoint definition that should be used to create a new instance of Zodcall
 */
export interface ZodcallEndpointDefinition<R = unknown> {
  /**
   * http method : get, head, options, post, put, patch, delete
   */
  method: Method;
  /**
   * path of the endpoint
   * @example
   * ```text
   * /posts/:postId/comments/:commentId
   * ```
   */
  path: string;
  /**
   * optional alias to call the endpoint easily
   * @example
   * ```text
   * getPostComments
   * ```
   */
  alias?: string;
  /**
   * optional description of the endpoint
   */
  description?: string;
  /**
   * optional request format of the endpoint: json, form-data, form-url, binary, text
   */
  requestFormat?: RequestFormat;
  /**
   * optionally mark the endpoint as immutable (e.g. a cacheable `post`)
   */
  immutable?: boolean;
  /**
   * optional parameters of the endpoint
   */
  parameters?: ZodcallEndpointParameters;
  /**
   * response of the endpoint
   * you can use zod `transform` to transform the value of the response before returning it
   */
  response: AnySchema<R>;
  /**
   * optional response status of the endpoint for success, default is 200
   */
  status?: number;
  /**
   * optional response description of the endpoint
   */
  responseDescription?: string;
  /**
   * optional errors of the endpoint
   */
  errors?: ZodcallEndpointErrors;
}

export type ZodcallEndpointDefinitions = readonly ZodcallEndpointDefinition[];

/* -------------------------------------------------------------------------- */
/*                                Lookup maps                                 */
/* -------------------------------------------------------------------------- */

/*
 * Type performance notes
 * ----------------------
 * Every lookup goes through maps built in a single pass over `Api[number]`
 * (`ZodcallEndpointMap`, `ZodcallAliasMap`). TypeScript caches type alias
 * instantiations, so the maps and the per-endpoint types (`*ForEndpoint`)
 * are computed once and then accessed like object properties - no recursive
 * tuple filtering, no deep `Narrow`, no deep `Readonly`.
 */

/**
 * `"<method> <path>"` -> endpoint
 */
export type ZodcallEndpointMap<Api extends ZodcallEndpointDefinitions> = {
  [E in Api[number] as `${E["method"]} ${E["path"]}`]: E;
};

type AliasKey<E> = E extends { alias: infer A extends string } ? A : never;

/**
 * alias -> endpoint
 */
export type ZodcallAliasMap<Api extends ZodcallEndpointDefinitions> = {
  [E in Api[number] as AliasKey<E>]: E;
};

/**
 * path -> endpoint, for a given method
 */
export type ZodcallPathMap<Api extends ZodcallEndpointDefinitions, M extends Method> = {
  [E in Extract<Api[number], { method: M }> as E["path"]]: E;
};

/**
 * union of the paths of a method
 * (computed with a distributive `Extract`: never use `keyof` on the `as` mapped maps,
 * TypeScript recomputes it on every use)
 */
export type ZodcallPathsByMethod<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
> = Extract<Api[number], { method: M }>["path"];

/**
 * O(1) property lookup without `keyof` (see `ZodcallPathsByMethod`)
 */
type Lookup<Map, K extends PropertyKey> = Map extends {
  readonly [Q in K]: infer V;
}
  ? V
  : never;

export type Aliases<Api extends ZodcallEndpointDefinitions> = AliasKey<Api[number]>;

/**
 * get the endpoint definition for a method and a path
 */
export type ZodcallEndpointDefinitionByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
> = Extract<Lookup<ZodcallPathMap<Api, M>, Path>, ZodcallEndpointDefinition>;

/**
 * get the endpoint definition for an alias
 */
export type ZodcallEndpointDefinitionByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
> = Extract<Lookup<ZodcallAliasMap<Api>, Alias>, ZodcallEndpointDefinition>;

/* -------------------------------------------------------------------------- */
/*                              Path parameters                               */
/* -------------------------------------------------------------------------- */

type WordChar =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "_";

/** read a parameter name (same rule as the runtime regexp `:([a-zA-Z_][a-zA-Z0-9_]*)`) */
type TakeName<S extends string, Acc extends string = ""> = S extends `${infer C}${infer Rest}`
  ? C extends WordChar
    ? TakeName<Rest, `${Acc}${C}`>
    : [Acc, S]
  : [Acc, ""];

/**
 * Extract path param names from a path
 * @example
 * ```ts
 * PathParamNames<"/users/:id/posts/:postId"> // "id" | "postId"
 * ```
 */
export type PathParamNames<Path> = Path extends `${string}:${infer Rest}`
  ? TakeName<Rest> extends [infer Name extends string, infer Tail extends string]
    ? (Name extends "" ? never : Name) | PathParamNames<Tail>
    : never
  : never;

type HeaderValue = string | number | boolean;

/* -------------------------------------------------------------------------- */
/*                                  Response                                  */
/* -------------------------------------------------------------------------- */

/**
 * Response object passed through plugins
 */
export type ZodcallResponse<T = unknown> = {
  /**
   * parsed body
   */
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  /**
   * final url of the request
   */
  url: string;
  /**
   * the underlying fetch `Response` (its body has already been consumed)
   */
  raw: Response;
};

/* -------------------------------------------------------------------------- */
/*                             Per endpoint types                             */
/* -------------------------------------------------------------------------- */

type ParameterList<E> = E extends {
  parameters: infer P extends ZodcallEndpointParameters;
}
  ? P[number]
  : never;

type ParametersOfType<E, T extends ZodcallParameterType> = Extract<ParameterList<E>, { type: T }>;

type ErrorList<E> = E extends { errors: infer L extends ZodcallEndpointErrors } ? L[number] : never;

/**
 * map parameter definitions to `{ [name]: type }` in a single pass, `never` if there are none.
 * With `exactOptionalPropertyTypes`, an `.exactOptional()` parameter maps to `name?: T`
 * (it can be omitted, but not set to `undefined`).
 */
type MapParameters<P extends ZodcallEndpointParameter, Frontend extends boolean> = [P] extends [
  never,
]
  ? never
  : {
      [
        Param in P as IsOptional<Param["schema"], Frontend> extends true ? never : Param["name"]
      ]: InputType<Param["schema"], Frontend>;
    } & {
      [
        Param in P as IsOptional<Param["schema"], Frontend> extends true ? Param["name"] : never
      ]?: InputType<Param["schema"], Frontend>;
    };

export type ZodcallResponseForEndpoint<
  Endpoint extends ZodcallEndpointDefinition,
  Frontend extends boolean = true,
> = SchemaType<Endpoint["response"], Frontend>;

export type BodySchemaForEndpoint<Endpoint extends ZodcallEndpointDefinition> = ParametersOfType<
  Endpoint,
  "Body"
>["schema"];

/**
 * body type of an endpoint (`never` if the endpoint has no body)
 */
export type ZodcallBodyForEndpoint<
  Endpoint extends ZodcallEndpointDefinition,
  Frontend extends boolean = true,
> = [BodySchemaForEndpoint<Endpoint>] extends [never]
  ? never
  : InputType<BodySchemaForEndpoint<Endpoint>, Frontend>;

/**
 * body argument of an endpoint (`undefined` if the endpoint has no body)
 */
export type ZodcallBodyArgForEndpoint<Endpoint extends ZodcallEndpointDefinition> = [
  BodySchemaForEndpoint<Endpoint>,
] extends [never]
  ? undefined
  : Input<BodySchemaForEndpoint<Endpoint>>;

type PathParamsOf<Path, Declared> = [Declared] extends [never]
  ? Path extends `${string}:${string}`
    ? { [K in PathParamNames<Path>]: HeaderValue }
    : never
  : Path extends `${string}:${string}`
    ? { [K in Exclude<PathParamNames<Path>, keyof Declared>]: HeaderValue } & Declared
    : Declared;

type EndpointPathParamsOf<
  Endpoint extends ZodcallEndpointDefinition,
  Frontend extends boolean = true,
> = PathParamsOf<Endpoint["path"], MapParameters<ParametersOfType<Endpoint, "Path">, Frontend>>;

export type ZodcallQueryParamsForEndpoint<
  Endpoint extends ZodcallEndpointDefinition,
  Frontend extends boolean = true,
> = Simplify<MapParameters<ParametersOfType<Endpoint, "Query">, Frontend>>;

export type ZodcallHeaderParamsForEndpoint<
  Endpoint extends ZodcallEndpointDefinition,
  Frontend extends boolean = true,
> = Simplify<MapParameters<ParametersOfType<Endpoint, "Header">, Frontend>>;

export type ZodcallPathParamsForEndpoint<
  Endpoint extends ZodcallEndpointDefinition,
  Frontend extends boolean = true,
> = Simplify<EndpointPathParamsOf<Endpoint, Frontend>>;

type ErrorSchemaForStatus<Errors extends ZodcallEndpointError, Status extends number> = [
  Extract<Errors, { status: Status }>,
] extends [never]
  ? Extract<Errors, { status: "default" }>["schema"]
  : Extract<Errors, { status: Status }>["schema"];

export type ZodcallErrorForEndpoint<
  Endpoint extends ZodcallEndpointDefinition,
  Status extends number,
  Frontend extends boolean = true,
> = SchemaType<ErrorSchemaForStatus<ErrorList<Endpoint>, Status>, Frontend>;

type HttpErrorStatus<Status> = Status extends "default" ? 0 & { error: Status } : Status;

type HttpErrorFor<D> = D extends {
  status: infer Status;
  schema: infer Schema extends AnySchema;
}
  ? Merge<
      Omit<ZodcallHttpError, "status" | "response">,
      {
        status: HttpErrorStatus<Status>;
        response: Merge<
          Omit<ZodcallResponse<Output<Schema>>, "status">,
          { status: HttpErrorStatus<Status> }
        >;
      }
    >
  : never;

/**
 * union of typed `ZodcallHttpError` matching the endpoint error definitions
 */
export type ZodcallMatchingErrorsForEndpoint<Endpoint extends ZodcallEndpointDefinition> =
  HttpErrorFor<ErrorList<Endpoint>>;

/* -------------------------------------------------------------------------- */
/*                              Request options                               */
/* -------------------------------------------------------------------------- */

/**
 * `RequestInit` options that can be forwarded to `fetch`
 * (`body`, `headers` and `method` are managed by zodcall)
 */
export type ZodcallRequestInit = Omit<RequestInit, "body" | "headers" | "method">;

/**
 * Options available on every request, whatever the endpoint
 */
export type ZodcallBaseRequestOptions = ZodcallRequestInit & {
  /**
   * extra headers to send
   */
  headers?: Record<string, HeaderValue>;
  /**
   * how to read the response body - default: `auto`
   */
  responseType?: ResponseType;
  /**
   * request timeout in milliseconds
   */
  timeout?: number;
};

/**
 * `{ [Key]: T }`, optional when every property of `T` is optional
 */
type Part<Key extends string, T> = {} extends T ? { [K in Key]?: T } : { [K in Key]: T };

type PathPart<
  Path,
  Declared extends ZodcallEndpointParameter,
  Kinds,
> = Path extends `${string}:${string}`
  ? "Path" extends Kinds
    ? Part<
        "params",
        { [K in Exclude<PathParamNames<Path>, Declared["name"]>]: HeaderValue } & MapParameters<
          Declared,
          true
        >
      >
    : { params: { [K in PathParamNames<Path>]: HeaderValue } }
  : "Path" extends Kinds
    ? Part<"params", MapParameters<Declared, true>>
    : {};

/**
 * typed part of the request options (params, queries, headers).
 * The parameter list and the set of its kinds are computed once,
 * absent kinds are skipped with a single `extends` check.
 */
type TypedOptions<Path, P extends ZodcallEndpointParameter, Kinds = P["type"]> = PathPart<
  Path,
  Extract<P, { type: "Path" }>,
  Kinds
> &
  ("Query" extends Kinds
    ? Part<"queries", MapParameters<Extract<P, { type: "Query" }>, true>>
    : {}) &
  ("Header" extends Kinds
    ? Part<"headers", MapParameters<Extract<P, { type: "Header" }>, true>>
    : {});

/**
 * request options of an endpoint (params, queries, headers + fetch options)
 */
type TypedOptionsForEndpoint<Endpoint extends ZodcallEndpointDefinition> =
  // distributive: keep path and parameters of the same endpoint together
  // (matters when TypeScript evaluates it with a union of endpoints during inference)
  Endpoint extends unknown ? TypedOptions<Endpoint["path"], ParameterList<Endpoint>> : never;

export type ZodcallRequestOptionsForEndpoint<Endpoint extends ZodcallEndpointDefinition> =
  TypedOptionsForEndpoint<Endpoint> & ZodcallBaseRequestOptions;

type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * rest arguments for the request options (optional when nothing is required)
 */
export type ZodcallConfigArgs<Config> = [RequiredKeys<Config>] extends [never]
  ? [config?: Config]
  : [config: Config];

export type ZodcallArgsForEndpoint<Endpoint extends ZodcallEndpointDefinition> =
  {} extends TypedOptionsForEndpoint<Endpoint>
    ? [config?: ZodcallRequestOptionsForEndpoint<Endpoint>]
    : [config: ZodcallRequestOptionsForEndpoint<Endpoint>];

/**
 * full request config (`method`, `url`, `body` + request options) of an endpoint
 */
export type ZodcallRequestConfigForEndpoint<Endpoint extends ZodcallEndpointDefinition> = Simplify<
  {
    method: Endpoint["method"];
    url: Endpoint["path"];
  } & ([BodySchemaForEndpoint<Endpoint>] extends [never]
    ? { body?: undefined }
    : { body: Input<BodySchemaForEndpoint<Endpoint>> }) &
    ZodcallRequestOptionsForEndpoint<Endpoint>
>;

export type AnyZodcallMethodOptions = Merge<
  ZodcallRequestInit,
  {
    params?: Record<string, unknown>;
    queries?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    responseType?: ResponseType;
    timeout?: number;
  }
>;

export type AnyZodcallRequestOptions = Merge<
  { method: Method; url: string; body?: unknown },
  AnyZodcallMethodOptions
>;

/**
 * request config as seen by plugins
 */
export type ZodcallRequestConfig = Readonly<AnyZodcallRequestOptions>;

/* -------------------------------------------------------------------------- */
/*                        By path / by alias accessors                        */
/* -------------------------------------------------------------------------- */

/*
 * Accessors: the per-endpoint types (`*ForEndpoint`) looked up by method + path or by alias.
 */

export type ZodcallResponseByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
  Frontend extends boolean = true,
> = ZodcallResponseForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>, Frontend>;

export type ZodcallResponseByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
  Frontend extends boolean = true,
> = ZodcallResponseForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>, Frontend>;

export type ZodcallErrorByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
  Status extends number,
  Frontend extends boolean = true,
> = ZodcallErrorForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>, Status, Frontend>;

export type ZodcallErrorByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
  Status extends number,
  Frontend extends boolean = true,
> = ZodcallErrorForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>, Status, Frontend>;

export type ZodcallMatchingErrorsByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
> = ZodcallMatchingErrorsForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>>;

export type ZodcallMatchingErrorsByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
> = ZodcallMatchingErrorsForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>>;

export type BodySchema<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
> = BodySchemaForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>>;

export type BodySchemaByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
> = BodySchemaForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>>;

export type ZodcallBodyByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
  Frontend extends boolean = true,
> = ZodcallBodyForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>, Frontend>;

export type ZodcallBodyByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
  Frontend extends boolean = true,
> = ZodcallBodyForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>, Frontend>;

export type ZodcallQueryParamsByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
  Frontend extends boolean = true,
> = ZodcallQueryParamsForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>, Frontend>;

export type ZodcallQueryParamsByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
  Frontend extends boolean = true,
> = ZodcallQueryParamsForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>, Frontend>;

export type ZodcallPathParamsByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
  Frontend extends boolean = true,
> = ZodcallPathParamsForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>, Frontend>;

export type ZodcallPathParamsByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
  Frontend extends boolean = true,
> = ZodcallPathParamsForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>, Frontend>;

export type ZodcallHeaderParamsByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
  Frontend extends boolean = true,
> = ZodcallHeaderParamsForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>, Frontend>;

export type ZodcallHeaderParamsByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
  Frontend extends boolean = true,
> = ZodcallHeaderParamsForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>, Frontend>;

/**
 * Get the request options for a given endpoint
 */
export type ZodcallRequestOptionsByPath<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
> = ZodcallRequestOptionsForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>>;

export type ZodcallRequestOptionsByAlias<
  Api extends ZodcallEndpointDefinitions,
  Alias extends Aliases<Api>,
> = ZodcallRequestOptionsForEndpoint<ZodcallEndpointDefinitionByAlias<Api, Alias>>;

export type ZodcallRequestOptions<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
> = ZodcallRequestConfigForEndpoint<ZodcallEndpointDefinitionByPath<Api, M, Path>>;

/* -------------------------------------------------------------------------- */
/*                                  Plugins                                   */
/* -------------------------------------------------------------------------- */

type ReadonlyConfig = ZodcallRequestConfig;

/**
 * Plugin that can be used to intercept zodcall requests and responses
 */
export type ZodcallPlugin = {
  /**
   * Optional name of the plugin
   * naming a plugin allows to remove it or replace it later
   */
  name?: string;
  /**
   * request interceptor to modify or inspect the request before it is sent
   */
  request?: (api: ZodcallEndpointDefinitions, config: ReadonlyConfig) => Promise<ReadonlyConfig>;
  /**
   * response interceptor to modify or inspect the response before it is returned
   */
  response?: (
    api: ZodcallEndpointDefinitions,
    config: ReadonlyConfig,
    response: ZodcallResponse,
  ) => Promise<ZodcallResponse>;
  /**
   * error interceptor for response errors (network errors, http errors, validation errors)
   * return a response to recover, or throw to propagate an error
   */
  error?: (
    api: ZodcallEndpointDefinitions,
    config: ReadonlyConfig,
    error: unknown,
  ) => Promise<ZodcallResponse>;
};

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

/**
 * function signature of an alias
 */
export type ZodcallAliasFunction<Endpoint extends ZodcallEndpointDefinition> =
  Endpoint["method"] extends BodyMethod
    ? (
        body: ZodcallBodyArgForEndpoint<Endpoint>,
        ...args: ZodcallArgsForEndpoint<Endpoint>
      ) => Promise<ZodcallResponseForEndpoint<Endpoint>>
    : (...args: ZodcallArgsForEndpoint<Endpoint>) => Promise<ZodcallResponseForEndpoint<Endpoint>>;

export type ZodcallAliases<Api extends ZodcallEndpointDefinitions> = {
  [E in Api[number] as AliasKey<E>]: ZodcallAliasFunction<E>;
};

/* -------------------------------------------------------------------------- */
/*                                   Options                                  */
/* -------------------------------------------------------------------------- */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * zodcall client options
 */
export type ZodcallOptions = {
  /**
   * Should zodcall validate parameters and response? Default: true
   */
  validate?: boolean | "request" | "response" | "all" | "none";
  /**
   * Should zodcall transform the request and response? Default: true
   */
  transform?: boolean | "request" | "response";
  /**
   * Should zod schema default values be used on parameters? Default: false
   * you usually want your backend to handle default values
   */
  sendDefaults?: boolean;
  /**
   * custom fetch implementation - Default: `globalThis.fetch`
   */
  fetch?: FetchLike;
  /**
   * default `RequestInit` applied to every request (headers, credentials, ...)
   */
  init?: ZodcallRequestInit & { headers?: HeadersInit };
  /**
   * default timeout in milliseconds for every request
   */
  timeout?: number;
  /**
   * custom query string serializer (without leading `?`)
   */
  querySerializer?: (queries: Record<string, unknown>) => string;
};

/**
 * a client instance: the client methods plus one function per endpoint alias
 */
export type ZodcallInstance<Api extends ZodcallEndpointDefinitions> = ZodcallClass<Api> &
  ZodcallAliases<Api>;

export type ZodcallConstructor = {
  new <const Api extends ZodcallEndpointDefinitions>(
    api: Api,
    options?: ZodcallOptions,
  ): ZodcallInstance<Api>;
  new <const Api extends ZodcallEndpointDefinitions>(
    baseURL: string,
    api: Api,
    options?: ZodcallOptions,
  ): ZodcallInstance<Api>;
};

/**
 * Get the Api description type from a zodcall client
 */
export type ApiOf<Z> = Z extends { readonly api: infer Api extends ZodcallEndpointDefinitions }
  ? Api
  : never;

/* -------------------------------------------------------------------------- */
/*                         RFC 9457 - Problem Details                         */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                     RFC 9457 - Problem Details for HTTP APIs               */
/* -------------------------------------------------------------------------- */

/**
 * Problem Details object (RFC 9457)
 * @see https://www.rfc-editor.org/rfc/rfc9457
 */
export type ProblemDetails = {
  /**
   * URI reference identifying the problem type - default: `about:blank`
   */
  type: string;
  /**
   * short, human-readable summary of the problem type
   */
  title: string;
  /**
   * HTTP status code (absent for client side problems: network, validation, ...)
   */
  status?: number;
  /**
   * human-readable explanation specific to this occurrence of the problem
   */
  detail?: string;
  /**
   * URI reference identifying the specific occurrence of the problem
   */
  instance?: string;
  /**
   * extension members
   */
  [extension: string]: unknown;
};

/**
 * field level error, used in the `errors` extension member
 */
export type ProblemFieldError = {
  /**
   * JSON pointer (RFC 6901) to the invalid value, prefixed with `#`
   */
  pointer: string;
  detail: string;
  code?: string;
};

export type ProblemType = (typeof ProblemTypes)[keyof typeof ProblemTypes];

export type ZodcallProblemInit = {
  type?: string;
  title: string;
  status?: number;
  detail?: string;
  instance?: string;
  /**
   * field level errors (validation)
   */
  errors?: ProblemFieldError[];
  /**
   * other extension members
   */
  extensions?: Record<string, unknown>;
};

export type ZodcallErrorOptions = {
  config?: ZodcallRequestConfig;
  data?: unknown;
  cause?: unknown;
};
