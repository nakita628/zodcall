# zodcall

A monorepo for a type-safe, fetch-based API client with [zod](https://zod.dev) validation, and a CLI
that generates that client from OpenAPI.

| Package                                                       | What it does                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`zodcall`](./packages/zodcall)                               | The API client: declare endpoints once, get typed and validated calls over the platform `fetch` |
| [`openapi-zodcall-client`](./packages/openapi-zodcall-client) | A CLI that generates a `zodcall` client (zod schemas, `makeApi`, `createClient`) from OpenAPI   |

Each package has its own README with installation and usage. This file is about the repository.

## Quick start

```bash
npm install zodcall zod
npm install -D openapi-zodcall-client

npx openapi-zodcall-client openapi.yaml -o src/client.ts
```

```ts
import { createClient } from "./client";

const client = createClient("https://api.example.com");

await client.getPet({ params: { petId: 1 } });
```

Without the CLI, an API is declared by hand with `makeApi` (see [zodcall](./packages/zodcall)).

## Layout

```text
packages/zodcall                  the client library
packages/openapi-zodcall-client   the generator CLI (effect/cli, schemas by oas-truth)
vite.config.ts                   the formatting and lint options every package inherits
```

Dependencies are a [pnpm workspace](./pnpm-workspace.yaml) with a single `pnpm-lock.yaml`.

## Commands

```sh
pnpm install     # dependencies
pnpm build       # build every package
pnpm test        # test every package
pnpm typecheck   # tsc --noEmit in every package
pnpm check       # format, lint and type check (vp check)
pnpm fix         # the autofixable part of the above
```

## License

Distributed under the MIT License. See [LICENSE](./LICENSE) for more information.
