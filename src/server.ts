import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import * as service from "./service.js";
import { getImage } from "./db.js";
import { QuantError } from "./constants.js";
import { toPPM } from "./ppm.js";
import { RGB } from "./validate.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    params: string[],
    query: URLSearchParams
  ) => void | Promise<void>;
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024 * 1024) {
        reject(new QuantError("E_LIMIT", "请求体超过 256MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new QuantError("E_BAD_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/images$/,
    handler: (_req, res) => send(res, 200, { images: service.listImages() }),
  },
  {
    method: "POST",
    pattern: /^\/api\/images$/,
    handler: (_req, res, body) =>
      send(res, 200, service.importImage((body as { matrix?: unknown }).matrix)),
  },
  {
    method: "POST",
    pattern: /^\/api\/quantize$/,
    handler: (_req, res, body) => {
      const { imageId, k } = body as { imageId: unknown; k: unknown };
      send(res, 200, service.runQuantize(Number(imageId), k));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/images\/(\d+)\/steps$/,
    handler: (_req, res, _b, params, query) =>
      send(res, 200, service.getSteps(Number(params[0]), Number(query.get("k")))),
  },
  {
    method: "GET",
    pattern: /^\/api\/images\/(\d+)\/pixels$/,
    handler: (_req, res, _b, params, query) =>
      send(
        res,
        200,
        service.getPixel(
          Number(params[0]),
          Number(query.get("k")),
          Number(query.get("row")),
          Number(query.get("col"))
        )
      ),
  },
  {
    method: "GET",
    pattern: /^\/api\/images\/(\d+)\/compare$/,
    handler: (_req, res, _b, params, query) =>
      send(
        res,
        200,
        service.compareK(
          Number(params[0]),
          Number(query.get("k1")),
          Number(query.get("k2"))
        )
      ),
  },
  {
    method: "GET",
    pattern: /^\/api\/images\/(\d+)\/export$/,
    handler: (_req, res, _b, params, query) => {
      const imageId = Number(params[0]);
      const k = Number(query.get("k"));
      const format = query.get("format") ?? "json";
      const result = service.exportResult(imageId, k);
      if (format === "ppm") {
        const rec = getImage(imageId);
        const rows = JSON.parse(rec!.matrix_json) as RGB[][];
        const rebuilt = result.rebuilt;
        const buf = toPPM(rebuilt);
        res.writeHead(200, { "content-type": "image/x-portable-pixmap" });
        res.end(buf);
        return;
      }
      if (format === "ppm-original") {
        const rec = getImage(imageId);
        const rows = JSON.parse(rec!.matrix_json) as RGB[][];
        res.writeHead(200, { "content-type": "image/x-portable-pixmap" });
        res.end(toPPM(rows));
        return;
      }
      send(res, 200, result);
    },
  },
];

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body: unknown = {};
      if (req.method === "POST") body = await readBody(req);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.pattern);
        if (!m) continue;
        await route.handler(req, res, body, m.slice(1), url.searchParams);
        return;
      }
      send(res, 404, { code: "E_NOT_FOUND", message: "未知路由" });
    } catch (err) {
      if (err instanceof QuantError) {
        send(res, 400, { code: err.code, message: err.message });
      } else {
        send(res, 500, {
          code: "E_INTERNAL",
          message: (err as Error).message,
        });
      }
    }
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function main() {
  const requested = process.env.PORT ? Number(process.env.PORT) : 0;
  const port = requested ? requested : await freePort();
  const app = createApp();
  app.listen(port, "127.0.0.1", () => {
    const actual = (app.address() as { port: number }).port;
    const line = `服务已启动: http://127.0.0.1:${actual}`;
    console.log(line);
    try {
      writeFileSync("data/server.port", String(actual));
    } catch {
      /* 忽略端口文件写入失败 */
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
