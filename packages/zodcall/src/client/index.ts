import { safeParseAsync } from "zod/v4/core";
import { checkApi } from "../api";
import {
  isApi,
  isBodyMethod,
  isMethod,
  isPlainObject,
  isProblemDetails,
  isProblemFieldError,
  isRawBody,
  isZodcallError,
} from "../guard";
import { issuesToFieldErrors, serializeQueries, toFormData } from "../helper";
import type {
  Aliases,
  AnyZodcallMethodOptions,
  FetchLike,
  Method,
  ProblemDetails,
  ProblemFieldError,
  ResponseType,
  ZodcallArgsForEndpoint,
  ZodcallBodyArgForEndpoint,
  ZodcallConstructor,
  ZodcallEndpointDefinitionByPath,
  ZodcallEndpointDefinitions,
  ZodcallErrorOptions,
  ZodcallOptions,
  ZodcallPathsByMethod,
  ZodcallPlugin,
  ZodcallProblemInit,
  ZodcallRequestConfig,
  ZodcallRequestConfigForEndpoint,
  ZodcallResponse,
  ZodcallResponseForEndpoint,
} from "../types";
import { findEndpoint, isJsonContentType, joinURL, replacePathParams, toZod } from "../utils";

/*
 * The runtime client: errors, fetch handling, plugins and the Zodcall class.
 */

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/**
 * problem `type` URIs used by zodcall for client side problems
 */
export const ProblemTypes = {
  /** default type when the server does not provide one (RFC 9457 §4.2.1) */
  blank: "about:blank",
  /** fetch failed (DNS, connection refused, CORS, ...) */
  network: "urn:zodcall:problem:network-error",
  /** request exceeded the configured `timeout` */
  timeout: "urn:zodcall:problem:timeout",
  /** request aborted through an `AbortSignal` */
  aborted: "urn:zodcall:problem:aborted",
  /** a request parameter does not match its schema */
  requestValidation: "urn:zodcall:problem:request-validation",
  /** the response does not match the endpoint schema */
  responseValidation: "urn:zodcall:problem:response-validation",
  /** the response body could not be read / parsed */
  invalidResponseBody: "urn:zodcall:problem:invalid-response-body",
  /** the request config is invalid (unknown endpoint, bad body, ...) */
  invalidRequest: "urn:zodcall:problem:invalid-request",
} as const;

const PROBLEM_MEMBERS = new Set(["type", "title", "status", "detail", "instance"]);

/**
 * Error thrown by zodcall for every failed request.
 * It carries RFC 9457 Problem Details members and serializes to
 * `application/problem+json` compatible JSON with `toJSON()`.
 */
export class ZodcallError extends Error {
  override readonly name: string = "ZodcallError";
  /** problem type URI */
  readonly type: string;
  /** short summary of the problem type */
  readonly title: string;
  /** HTTP status code, if any */
  declare readonly status?: number;
  /** explanation of this occurrence */
  declare readonly detail?: string;
  /** identifier of this occurrence */
  declare readonly instance?: string;
  /** field level errors */
  declare readonly errors?: ProblemFieldError[];
  /** additional extension members */
  readonly extensions: Record<string, unknown>;
  /** the request config */
  declare readonly config?: ZodcallRequestConfig;
  /** the value that caused the problem (parameter, response body, ...) */
  declare readonly data?: unknown;

  constructor(problem: ZodcallProblemInit, options: ZodcallErrorOptions = {}) {
    super(
      problem.detail ? `${problem.title}: ${problem.detail}` : problem.title,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.type = problem.type ?? ProblemTypes.blank;
    this.title = problem.title;
    // absent members stay absent (not `undefined`), as `exactOptionalPropertyTypes` promises
    if (problem.status !== undefined) this.status = problem.status;
    if (problem.detail !== undefined) this.detail = problem.detail;
    if (problem.instance !== undefined) this.instance = problem.instance;
    if (problem.errors !== undefined) this.errors = problem.errors;
    this.extensions = problem.extensions ?? {};
    if (options.config !== undefined) this.config = options.config;
    if ("data" in options) this.data = options.data;
  }

  /**
   * get the Problem Details representation of this error
   */
  toProblemDetails(): ProblemDetails {
    const problem: ProblemDetails = {
      ...this.extensions,
      type: this.type,
      title: this.title,
    };
    if (this.status !== undefined) problem.status = this.status;
    if (this.detail !== undefined) problem.detail = this.detail;
    if (this.instance !== undefined) problem.instance = this.instance;
    if (this.errors !== undefined) problem.errors = this.errors;
    return problem;
  }

  toJSON(): ProblemDetails {
    return this.toProblemDetails();
  }
}

/**
 * Error thrown when the server responds with a non 2xx status code.
 * When the server answers with Problem Details (`application/problem+json`),
 * its members (`type`, `title`, `detail`, `instance`, extensions) are adopted.
 */
export class ZodcallHttpError<T = unknown> extends ZodcallError {
  override readonly name: string = "ZodcallHttpError";
  declare readonly status: number;

  constructor(
    config: ZodcallRequestConfig,
    public readonly response: ZodcallResponse<T>,
  ) {
    const body = response.data;
    const problem = isProblemDetails(body) ? body : undefined;
    const extensions: Record<string, unknown> = {};
    if (problem) {
      for (const [key, value] of Object.entries(problem)) {
        if (!PROBLEM_MEMBERS.has(key) && key !== "errors") extensions[key] = value;
      }
    }
    super(
      {
        type: problem?.type ?? ProblemTypes.blank,
        // RFC 9457 §4.2.1: with `about:blank`, title should be the status phrase
        title: problem?.title ?? (response.statusText || `HTTP ${response.status}`),
        status: response.status,
        detail:
          problem?.detail ??
          `Request '${config.method} ${config.url}' failed with status ${response.status}`,
        ...(problem?.instance === undefined ? {} : { instance: problem.instance }),
        ...(Array.isArray(problem?.errors)
          ? { errors: problem.errors.filter(isProblemFieldError) }
          : {}),
        extensions,
      },
      { config, data: body },
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Fetch                                    */
/* -------------------------------------------------------------------------- */

/**
 * read the response body according to the `responseType` (`auto`: from the content-type)
 */
async function readBody(
  response: Response,
  method: Method,
  responseType: ResponseType = "auto",
): Promise<unknown> {
  switch (responseType) {
    case "text":
      return response.text();
    case "blob":
      return response.blob();
    case "arrayBuffer":
      return response.arrayBuffer();
    case "formData":
      return response.formData();
    case "stream":
      return response.body;
  }
  if (
    method === "head" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304 ||
    !response.body
  ) {
    return undefined;
  }
  const contentType = response.headers.get("content-type");
  if (responseType === "json" || isJsonContentType(contentType)) {
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  }
  if (
    !contentType ||
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded")
  ) {
    return response.text();
  }
  return response.blob();
}

/**
 * combine the user signal and the timeout signal
 */
function combineSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => !!s);
  if (defined.length <= 1) return defined[0];
  return AbortSignal.any(defined);
}

function errorName(error: unknown): unknown {
  return typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
}

/**
 * wrap an error thrown by fetch into a `ZodcallError`
 */
function toFetchError(error: unknown, config: ZodcallRequestConfig, url: string): ZodcallError {
  if (isZodcallError(error)) return error;
  const name = errorName(error);
  const request = `'${config.method} ${config.url}'`;
  if (name === "TimeoutError") {
    return new ZodcallError(
      {
        type: ProblemTypes.timeout,
        title: "Request timeout",
        detail: `Request ${request} timed out`,
        instance: url,
      },
      { config, cause: error },
    );
  }
  if (name === "AbortError") {
    return new ZodcallError(
      {
        type: ProblemTypes.aborted,
        title: "Request aborted",
        detail: `Request ${request} was aborted`,
        instance: url,
      },
      { config, cause: error },
    );
  }
  return new ZodcallError(
    {
      type: ProblemTypes.network,
      title: "Network error",
      detail: `Request ${request} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      instance: url,
    },
    { config, cause: error },
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Plugins                                   */
/* -------------------------------------------------------------------------- */

export type PluginId = {
  key: string;
  value: number;
};

/**
 * A list of plugins that can be used by the Zodcall client.
 */
export class ZodcallPlugins {
  public readonly key: string;
  private plugins: Array<ZodcallPlugin | undefined> = [];

  /**
   * @param method - http method of the endpoint where the plugins are registered
   * @param path - path of the endpoint where the plugins are registered
   */
  constructor(method: Method | "any", path: string) {
    this.key = `${method}-${path}`;
  }

  /**
   * Get the index of a plugin by name
   * @returns the index of the plugin if found, -1 otherwise
   */
  indexOf(name: string): number {
    return this.plugins.findIndex((p) => p?.name === name);
  }

  /**
   * register a plugin
   * if the plugin has a name it will be replaced if it already exists
   * @returns unique id of the plugin
   */
  use(plugin: ZodcallPlugin): PluginId {
    if (plugin.name) {
      const id = this.indexOf(plugin.name);
      if (id !== -1) {
        this.plugins[id] = plugin;
        return { key: this.key, value: id };
      }
    }
    this.plugins.push(plugin);
    return { key: this.key, value: this.plugins.length - 1 };
  }

  /**
   * unregister a plugin
   */
  eject(plugin: PluginId | string): void {
    if (typeof plugin === "string") {
      const id = this.indexOf(plugin);
      if (id === -1) {
        throw new Error(`Plugin with name '${plugin}' not found`);
      }
      this.plugins[id] = undefined;
    } else {
      if (plugin.key !== this.key) {
        throw new Error(
          `Plugin with key '${plugin.key}' is not registered for endpoint '${this.key}'`,
        );
      }
      this.plugins[plugin.value] = undefined;
    }
  }

  /**
   * Intercept the request config by applying all plugins in registration order
   */
  async interceptRequest(
    api: ZodcallEndpointDefinitions,
    config: ZodcallRequestConfig,
  ): Promise<ZodcallRequestConfig> {
    let pluginConfig = config;
    for (const plugin of this.plugins) {
      if (plugin?.request) {
        pluginConfig = await plugin.request(api, pluginConfig);
      }
    }
    return pluginConfig;
  }

  /**
   * Intercept the response by applying all plugins in reverse registration order
   */
  interceptResponse(
    api: ZodcallEndpointDefinitions,
    config: ZodcallRequestConfig,
    response: Promise<ZodcallResponse>,
  ): Promise<ZodcallResponse> {
    let pluginResponse = response;
    for (let index = this.plugins.length - 1; index >= 0; index--) {
      const plugin = this.plugins[index];
      if (plugin) {
        pluginResponse = pluginResponse.then(
          plugin.response ? (res) => plugin.response!(api, config, res) : undefined,
          plugin.error ? (err) => plugin.error!(api, config, err) : undefined,
        );
      }
    }
    return pluginResponse;
  }

  /**
   * Get the number of plugins registered
   */
  count(): number {
    return this.plugins.reduce((count, plugin) => (plugin ? count + 1 : count), 0);
  }
}

/**
 * plugin that sets a header on every request
 * @param key - header name
 * @param value - header value
 */
export function headerPlugin(key: string, value: string): ZodcallPlugin {
  return {
    request: async (_, config) => ({
      ...config,
      headers: {
        ...config.headers,
        [key]: value,
      },
    }),
  };
}

const formData: ZodcallPlugin = {
  name: "form-data",
  request: async (_, config) => {
    if (config.body instanceof FormData) return config;
    if (!isPlainObject(config.body)) {
      throw new ZodcallError(
        {
          type: ProblemTypes.invalidRequest,
          title: "Invalid request",
          detail: "multipart/form-data body must be an object",
        },
        { config, data: config.body },
      );
    }
    // content-type (with boundary) is set by fetch itself
    return { ...config, body: toFormData(config.body) };
  },
};

/**
 * form-data plugin used internally for endpoints with `requestFormat: "form-data"`
 */
export function formDataPlugin(): ZodcallPlugin {
  return formData;
}

const formURL: ZodcallPlugin = {
  name: "form-url",
  request: async (_, config) => {
    if (config.body instanceof URLSearchParams) {
      return {
        ...config,
        headers: {
          ...config.headers,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      };
    }
    if (typeof config.body !== "object" || config.body === null || Array.isArray(config.body)) {
      throw new ZodcallError(
        {
          type: ProblemTypes.invalidRequest,
          title: "Invalid request",
          detail: "application/x-www-form-urlencoded body must be an object",
        },
        { config, data: config.body },
      );
    }
    return {
      ...config,
      body: serializeQueries(config.body),
      headers: {
        ...config.headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
  },
};

/**
 * form-url plugin used internally for endpoints with `requestFormat: "form-url"`
 */
export function formURLPlugin(): ZodcallPlugin {
  return formURL;
}

type Options = Required<Pick<ZodcallOptions, "validate" | "transform" | "sendDefaults">>;

function shouldResponse(option: string | boolean) {
  return [true, "response", "all"].includes(option);
}

function shouldRequest(option: string | boolean) {
  return [true, "request", "all"].includes(option);
}

const PARAMETER_LOCATION = {
  Query: "query",
  Body: "body",
  Header: "header",
  Path: "path",
} as const;

function endpointNotFound(config: { method: string; url: string }) {
  return {
    type: ProblemTypes.invalidRequest,
    title: "Invalid request",
    detail: `No endpoint found for '${config.method} ${config.url}'`,
  };
}

/**
 * Zod validation plugin used internally by Zodcall.
 * By default zodcall validates both parameters and responses.
 */
export function zodValidationPlugin({ validate, transform, sendDefaults }: Options): ZodcallPlugin {
  return {
    name: "zod-validation",
    ...(shouldRequest(validate) ? { request: validateRequest } : {}),
    ...(shouldResponse(validate) ? { response: validateResponse } : {}),
  };

  async function validateRequest(
    api: ZodcallEndpointDefinitions,
    config: ZodcallRequestConfig,
  ): Promise<ZodcallRequestConfig> {
    const endpoint = findEndpoint(api, config.method, config.url);
    if (!endpoint) {
      throw new ZodcallError(endpointNotFound(config), { config });
    }
    const { parameters } = endpoint;
    if (!parameters) return config;

    const queries: Record<string, unknown> = { ...config.queries };
    const headers: Record<string, unknown> = { ...config.headers };
    const params: Record<string, unknown> = { ...config.params };
    const conf = { ...config, queries, headers, params };
    const paramsOf = {
      Query: (name: string) => conf.queries[name],
      Body: () => conf.body,
      Header: (name: string) => conf.headers[name],
      Path: (name: string) => conf.params[name],
    };
    // a parameter is given when its key is present, whatever its value:
    // an `.exactOptional()` parameter set to `undefined` is rejected, an omitted one is not
    const hasParam = {
      Query: (name: string) => Object.hasOwn(conf.queries, name),
      Body: () => conf.body !== undefined,
      Header: (name: string) => Object.hasOwn(conf.headers, name),
      Path: (name: string) => Object.hasOwn(conf.params, name),
    };
    const setParamsOf = {
      Query: (name: string, value: unknown) => (conf.queries[name] = value),
      Body: (_: string, value: unknown) => (conf.body = value),
      Header: (name: string, value: unknown) => (conf.headers[name] = value),
      Path: (name: string, value: unknown) => (conf.params[name] = value),
    };
    const transformRequest = shouldRequest(transform);
    for (const { name, schema, type } of parameters) {
      const zodSchema = toZod(schema);
      // omitted: with `sendDefaults`, parse `undefined` to fill `.default()` values and
      // report missing required ones; optional ones stay omitted (`.exactOptional()`
      // would reject `undefined`)
      const given = hasParam[type](name) || (sendDefaults && zodSchema._zod.optin !== "optional");
      if (given) {
        const value = paramsOf[type](name);
        const parsed = await safeParseAsync(zodSchema, value);
        if (!parsed.success) {
          const location = PARAMETER_LOCATION[type];
          throw new ZodcallError(
            {
              type: ProblemTypes.requestValidation,
              title: "Invalid request parameter",
              detail: `Invalid ${type} parameter '${name}'`,
              // body pointers are relative to the body, others are prefixed with the parameter name
              errors: issuesToFieldErrors(parsed.error.issues, type === "Body" ? [] : [name]),
              extensions: { parameter: { name, in: location } },
            },
            { config, data: value, cause: parsed.error },
          );
        }
        if (transformRequest) {
          setParamsOf[type](name, parsed.data);
        }
      }
    }
    return conf;
  }

  async function validateResponse(
    api: ZodcallEndpointDefinitions,
    config: ZodcallRequestConfig,
    response: ZodcallResponse,
  ): Promise<ZodcallResponse> {
    const endpoint = findEndpoint(api, config.method, config.url);
    if (!endpoint) {
      throw new ZodcallError(endpointNotFound(config), { config });
    }
    if (config.responseType === "json" || isJsonContentType(response.headers.get("content-type"))) {
      const parsed = await safeParseAsync(toZod(endpoint.response), response.data);
      if (!parsed.success) {
        throw new ZodcallError(
          {
            type: ProblemTypes.responseValidation,
            title: "Invalid response",
            detail: `Response from endpoint '${endpoint.method} ${endpoint.path}' does not match the schema`,
            instance: response.url,
            errors: issuesToFieldErrors(parsed.error.issues),
            extensions: { responseStatus: response.status },
          },
          { config, data: response.data, cause: parsed.error },
        );
      }
      if (shouldResponse(transform)) {
        return { ...response, data: parsed.data };
      }
    }
    return response;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

type ResolvedOptions = ZodcallOptions &
  Required<Pick<ZodcallOptions, "validate" | "transform" | "sendDefaults">>;

type EndpointOf<
  Api extends ZodcallEndpointDefinitions,
  M extends Method,
  Path extends ZodcallPathsByMethod<Api, M>,
> = ZodcallEndpointDefinitionByPath<Api, M, Path>;

/**
 * Type-safe api client based on fetch and zod
 */
export class ZodcallClass<Api extends ZodcallEndpointDefinitions> {
  public readonly options: ResolvedOptions;
  public readonly api: Api;
  private readonly _baseURL: string | undefined;
  private readonly fetchFn: FetchLike;
  private readonly anyPlugins = new ZodcallPlugins("any", "any");
  private readonly endpointPlugins = new Map<string, ZodcallPlugins>([
    [this.anyPlugins.key, this.anyPlugins],
  ]);

  /**
   * @param baseURL - the base url to use - if omitted, paths are used as is (relative to the current origin in browsers)
   * @param api - the description of all the api endpoints
   * @param options - the options to setup the client API
   * @example
   *   const apiClient = new Zodcall("https://jsonplaceholder.typicode.com", [
   *     {
   *       method: "get",
   *       path: "/users/:id",
   *       alias: "getUser",
   *       response: z.object({ id: z.number(), name: z.string() }),
   *     },
   *   ]);
   */
  constructor(api: Api, options?: ZodcallOptions);
  constructor(baseURL: string, api: Api, options?: ZodcallOptions);
  constructor(arg1?: Api | string, arg2?: Api | ZodcallOptions, arg3?: ZodcallOptions) {
    let options: ZodcallOptions;
    if (!arg1) {
      if (Array.isArray(arg2)) {
        throw new Error("Zodcall: missing base url");
      }
      throw new Error("Zodcall: missing api description");
    }
    if (typeof arg1 === "string" && isApi(arg2)) {
      this._baseURL = arg1;
      this.api = arg2;
      options = arg3 || {};
    } else if (isApi(arg1) && !isApi(arg2)) {
      this.api = arg1;
      options = arg2 || {};
    } else {
      throw new Error("Zodcall: api must be an array");
    }

    checkApi(this.api);

    this.options = {
      validate: true,
      transform: true,
      sendDefaults: false,
      ...options,
    };

    // resolve fetch lazily so that it can be mocked/polyfilled after client creation
    this.fetchFn = this.options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    this.injectAliasEndpoints();
    this.initPlugins();
    if ([true, "all", "request", "response"].includes(this.options.validate)) {
      this.use(zodValidationPlugin(this.options));
    }
  }

  private initPlugins() {
    for (const endpoint of this.api) {
      const plugins = new ZodcallPlugins(endpoint.method, endpoint.path);
      switch (endpoint.requestFormat) {
        case "binary":
          plugins.use(headerPlugin("Content-Type", "application/octet-stream"));
          break;
        case "form-data":
          plugins.use(formDataPlugin());
          break;
        case "form-url":
          plugins.use(formURLPlugin());
          break;
        case "text":
          plugins.use(headerPlugin("Content-Type", "text/plain"));
          break;
      }
      this.endpointPlugins.set(`${endpoint.method}-${endpoint.path}`, plugins);
    }
  }

  private findAliasEndpointPlugins(alias: string) {
    const endpoint = this.api.find((endpoint) => endpoint.alias === alias);
    if (endpoint) {
      return this.endpointPlugins.get(`${endpoint.method}-${endpoint.path}`);
    }
    return undefined;
  }

  private findEndpointPlugins(method: Method, path: string) {
    return this.endpointPlugins.get(`${method}-${path}`);
  }

  /**
   * get the base url of the api
   */
  get baseURL(): string | undefined {
    return this._baseURL;
  }

  /**
   * register a plugin to intercept the requests or responses
   * @param plugin - the plugin to use
   * @returns an id to allow you to unregister the plugin
   */
  use(plugin: ZodcallPlugin): PluginId;
  use<Alias extends Aliases<Api>>(alias: Alias, plugin: ZodcallPlugin): PluginId;
  use<M extends Method, Path extends ZodcallPathsByMethod<Api, M>>(
    method: M,
    path: Path,
    plugin: ZodcallPlugin,
  ): PluginId;
  use(
    target: ZodcallPlugin | string,
    pathOrPlugin?: ZodcallPlugin | string,
    plugin?: ZodcallPlugin,
  ): PluginId {
    if (typeof target === "object") {
      return this.anyPlugins.use(target);
    } else if (typeof pathOrPlugin === "object") {
      const plugins = this.findAliasEndpointPlugins(target);
      if (!plugins) throw new Error(`Zodcall: no alias '${target}' found to register plugin`);
      return plugins.use(pathOrPlugin);
    } else if (typeof pathOrPlugin === "string" && typeof plugin === "object") {
      const plugins = isMethod(target) ? this.findEndpointPlugins(target, pathOrPlugin) : undefined;
      if (!plugins)
        throw new Error(
          `Zodcall: no endpoint '${target} ${pathOrPlugin}' found to register plugin`,
        );
      return plugins.use(plugin);
    }
    throw new Error("Zodcall: invalid plugin registration");
  }

  /**
   * unregister a plugin
   * if the plugin name is provided instead of the registration plugin id,
   * it will unregister the plugin with that name only for non endpoint plugins
   * @param plugin - id of the plugin to remove
   */
  eject(plugin: PluginId | string): void {
    if (typeof plugin === "string") {
      this.anyPlugins.eject(plugin);
      return;
    }
    this.endpointPlugins.get(plugin.key)?.eject(plugin);
  }

  private injectAliasEndpoints() {
    for (const endpoint of this.api) {
      if (!endpoint.alias) continue;
      if (endpoint.alias in this) {
        throw new Error(`Zodcall: alias '${endpoint.alias}' conflicts with a client member`);
      }
      const value = isBodyMethod(endpoint.method)
        ? (body: unknown, config?: AnyZodcallMethodOptions) =>
            this.call(endpoint.method, endpoint.path, config, body)
        : (config?: AnyZodcallMethodOptions) => this.call(endpoint.method, endpoint.path, config);
      Object.defineProperty(this, endpoint.alias, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }

  /**
   * build the final url (base url + path params + query string)
   */
  private buildURL(conf: ZodcallRequestConfig): string {
    const url = joinURL(this._baseURL, replacePathParams(conf));
    if (!conf.queries) return url;
    const serialize = this.options.querySerializer ?? serializeQueries;
    const search = serialize(conf.queries);
    if (!search) return url;
    return `${url}${url.includes("?") ? "&" : "?"}${search}`;
  }

  /**
   * send the request with fetch and parse the response
   */
  private async send(conf: ZodcallRequestConfig): Promise<ZodcallResponse> {
    const { headers: defaultHeaders, ...defaultInit } = this.options.init ?? {};
    const headers = new Headers(defaultHeaders);
    for (const [key, value] of Object.entries(conf.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value));
    }

    let body: BodyInit | undefined;
    if (conf.body !== undefined) {
      if (isRawBody(conf.body)) {
        body = conf.body;
      } else {
        body = JSON.stringify(conf.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }

    // everything zodcall does not handle itself is forwarded to fetch
    const {
      method: _method,
      url: _url,
      params: _params,
      queries: _queries,
      headers: _headers,
      body: _body,
      responseType: _responseType,
      timeout: _timeout,
      ...requestInit
    } = conf;
    const init: RequestInit = { ...defaultInit, ...requestInit };

    const timeout = conf.timeout ?? this.options.timeout;
    const signal = combineSignals([
      init.signal,
      timeout !== undefined ? AbortSignal.timeout(timeout) : undefined,
    ]);

    const url = this.buildURL(conf);
    let raw: Response;
    try {
      raw = await this.fetchFn(url, {
        ...init,
        method: conf.method.toUpperCase(),
        headers,
        body: body ?? null,
        signal: signal ?? null,
      });
    } catch (error) {
      throw toFetchError(error, conf, url);
    }

    let data: unknown;
    try {
      data = await readBody(raw, conf.method, conf.responseType);
    } catch (error) {
      // aborted / timed out while streaming the body
      if (signal?.aborted) throw toFetchError(signal.reason ?? error, conf, url);
      throw new ZodcallError(
        {
          type: ProblemTypes.invalidResponseBody,
          title: "Invalid response body",
          detail: `Unable to read the response body of '${conf.method} ${conf.url}': ${
            error instanceof Error ? error.message : String(error)
          }`,
          instance: url,
          extensions: { responseStatus: raw.status },
        },
        { config: conf, cause: error },
      );
    }

    const response: ZodcallResponse = {
      data,
      status: raw.status,
      statusText: raw.statusText,
      headers: raw.headers,
      url: raw.url || url,
      raw,
    };
    if (!raw.ok) {
      throw new ZodcallHttpError(conf, response);
    }
    return response;
  }

  /**
   * make a request to the api and get the full response (status, headers, ...)
   * @param config - the config to setup zodcall options and parameters
   * @returns response with data validated with the zod schema provided in the api description
   */
  requestRaw<M extends Method, Path extends ZodcallPathsByMethod<Api, M>>(
    config: ZodcallRequestConfigForEndpoint<EndpointOf<Api, M, Path>> & {
      method: M;
      url: Path;
    },
  ): Promise<ZodcallResponse<ZodcallResponseForEndpoint<EndpointOf<Api, M, Path>>>>;
  requestRaw(config: ZodcallRequestConfig): Promise<ZodcallResponse> {
    return this.execute(config);
  }

  /**
   * make a request to the api
   * @param config - the config to setup zodcall options and parameters
   * @returns response validated with the zod schema provided in the api description
   */
  request<M extends Method, Path extends ZodcallPathsByMethod<Api, M>>(
    config: ZodcallRequestConfigForEndpoint<EndpointOf<Api, M, Path>> & {
      method: M;
      url: Path;
    },
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, M, Path>>>;
  async request(config: ZodcallRequestConfig): Promise<unknown> {
    return (await this.execute(config)).data;
  }

  /**
   * run the plugins and send the request.
   * The typed public signatures (`request`, `get`, aliases, ...) all end up here.
   */
  private async execute(config: ZodcallRequestConfig): Promise<ZodcallResponse> {
    const endpointPlugin = this.findEndpointPlugins(config.method, config.url);
    let conf = await this.anyPlugins.interceptRequest(this.api, config);
    if (endpointPlugin) {
      conf = await endpointPlugin.interceptRequest(this.api, conf);
    }
    let response = this.send(conf);
    if (endpointPlugin) {
      response = endpointPlugin.interceptResponse(this.api, conf, response);
    }
    return this.anyPlugins.interceptResponse(this.api, conf, response);
  }

  private async call(
    method: Method,
    url: string,
    config: AnyZodcallMethodOptions | undefined,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.execute({
      ...config,
      method,
      url,
      ...(body === undefined ? {} : { body }),
    });
    return response.data;
  }

  /**
   * make a get request to the api
   * @param path - the path to api endpoint
   * @param config - the request options (params, queries, headers, fetch options)
   */
  get<Path extends ZodcallPathsByMethod<Api, "get">>(
    path: Path,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "get", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "get", Path>>>;
  get(path: string, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("get", path, config);
  }

  /**
   * make a head request to the api
   */
  head<Path extends ZodcallPathsByMethod<Api, "head">>(
    path: Path,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "head", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "head", Path>>>;
  head(path: string, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("head", path, config);
  }

  /**
   * make a query request (HTTP QUERY method) to the api.
   * Like `get` it is safe and idempotent, but the query is sent as request body.
   * @param path - the path to api endpoint
   * @param body - the query to send as body
   * @param config - the request options (params, queries, headers, fetch options)
   */
  query<Path extends ZodcallPathsByMethod<Api, "query">>(
    path: Path,
    body: ZodcallBodyArgForEndpoint<EndpointOf<Api, "query", Path>>,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "query", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "query", Path>>>;
  query(path: string, body: unknown, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("query", path, config, body);
  }

  /**
   * make a post request to the api
   * @param path - the path to api endpoint
   * @param body - the body to send
   * @param config - the request options (params, queries, headers, fetch options)
   */
  post<Path extends ZodcallPathsByMethod<Api, "post">>(
    path: Path,
    body: ZodcallBodyArgForEndpoint<EndpointOf<Api, "post", Path>>,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "post", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "post", Path>>>;
  post(path: string, body: unknown, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("post", path, config, body);
  }

  /**
   * make a put request to the api
   */
  put<Path extends ZodcallPathsByMethod<Api, "put">>(
    path: Path,
    body: ZodcallBodyArgForEndpoint<EndpointOf<Api, "put", Path>>,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "put", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "put", Path>>>;
  put(path: string, body: unknown, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("put", path, config, body);
  }

  /**
   * make a patch request to the api
   */
  patch<Path extends ZodcallPathsByMethod<Api, "patch">>(
    path: Path,
    body: ZodcallBodyArgForEndpoint<EndpointOf<Api, "patch", Path>>,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "patch", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "patch", Path>>>;
  patch(path: string, body: unknown, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("patch", path, config, body);
  }

  /**
   * make a delete request to the api
   */
  delete<Path extends ZodcallPathsByMethod<Api, "delete">>(
    path: Path,
    body: ZodcallBodyArgForEndpoint<EndpointOf<Api, "delete", Path>>,
    ...[config]: ZodcallArgsForEndpoint<EndpointOf<Api, "delete", Path>>
  ): Promise<ZodcallResponseForEndpoint<EndpointOf<Api, "delete", Path>>>;
  delete(path: string, body: unknown, config?: AnyZodcallMethodOptions): Promise<unknown> {
    return this.call("delete", path, config, body);
  }
}

// The only cast of the library: aliases are added to the instance at runtime
// (see `injectAliasEndpoints`), and a class can't declare members computed from `Api`.
export const Zodcall = ZodcallClass as ZodcallConstructor;
