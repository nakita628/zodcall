import { createServer, type IncomingMessage, type Server } from "node:http";
import { z } from "zod";

const searchBody = z.object({ name: z.string() });

export type Received = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

/**
 * Tiny echo-style test server.
 * Routes:
 * - GET  /users          -> list of users
 * - GET  /users/:id      -> user (404 with error body when id === "404")
 * - POST /users          -> echoes json body with id
 * - QUERY /users/search  -> users whose name contains the json body's `name`
 * - *    /echo/*         -> echoes the request (method, url, headers, body)
 * - GET  /text           -> text/plain response
 * - GET  /no-content     -> 204
 * - GET  /invalid        -> json that doesn't match the schema
 * - GET  /slow           -> waits 200ms
 * - GET  /error/:status  -> responds with given status and { message }
 */
export async function startServer() {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (url.pathname.startsWith("/echo")) {
      return json(200, {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      } satisfies Received);
    }
    if (req.method === "GET" && url.pathname === "/users") {
      return json(200, [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }
    const userMatch = url.pathname.match(/^\/users\/([^/]+)$/);
    if (req.method === "GET" && userMatch) {
      const id = decodeURIComponent(userMatch[1]!);
      if (id === "404") return json(404, { code: "NOT_FOUND", message: "no user" });
      if (id === "500") return json(500, { message: "boom" });
      return json(200, { id: Number(id), name: `user${id}` });
    }
    if (req.method === "POST" && url.pathname === "/users") {
      return json(201, { id: 3, ...JSON.parse(body) });
    }
    if (req.method === "QUERY" && url.pathname === "/users/search") {
      const { name } = searchBody.parse(JSON.parse(body));
      const users = [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ];
      return json(
        200,
        users.filter((u) => u.name.includes(name)),
      );
    }
    if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("hello");
    }
    if (url.pathname === "/no-content") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/invalid") {
      return json(200, { id: "not-a-number", name: 1 });
    }
    if (url.pathname === "/slow") {
      await new Promise((r) => setTimeout(r, 200));
      return json(200, { ok: true });
    }
    if (url.pathname === "/accounts/12345/transfers/67890") {
      res.writeHead(403, { "content-type": "application/problem+json" });
      return res.end(
        JSON.stringify({
          type: "https://example.com/errors/insufficient-funds",
          title: "残高が不足しています",
          status: 403,
          detail: "残高は30ポイントですが、50ポイント必要です",
          instance: "/accounts/12345/transfers/67890",
          balance: 30,
        }),
      );
    }
    const errorMatch = url.pathname.match(/^\/error\/(\d+)$/);
    if (errorMatch) {
      return json(Number(errorMatch[1]), { message: `error ${errorMatch[1]}` });
    }
    json(404, { message: "route not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server is not listening on a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
