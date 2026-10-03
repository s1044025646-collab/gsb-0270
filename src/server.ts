import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "./errors.js";
import { compareRuns } from "./compare.js";
import { matrixToPPM } from "./ppm.js";
import { Store } from "./store.js";
import { validateK, validateMatrix } from "./validation.js";

type Json = Record<string, unknown>;

async function readJson(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 50 * 1024 * 1024) {
      throw new AppError("PAYLOAD_TOO_LARGE", "请求体不能超过 50MB", 413);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Json;
  } catch {
    throw new AppError("INVALID_JSON", "请求体必须是 JSON 对象", 400);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  console.error(error);
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "内部错误" },
  });
}

function parseRunId(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError("INVALID_RUN_ID", "runId 必须是正整数", 400);
  }
  return parsed;
}

function parseImageVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError("INVALID_VERSION", "version 必须是正整数", 400);
  }
  return parsed;
}

export function createApp(store: Store): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathParts = url.pathname.split("/").filter(Boolean);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && url.pathname === "/images") {
        sendJson(response, 200, { images: store.listImages() });
        return;
      }

      if (method === "POST" && url.pathname === "/images") {
        const body = await readJson(request);
        const result = await store.importImage({
          imageId: typeof body.imageId === "string" ? body.imageId : undefined,
          name: typeof body.name === "string" ? body.name : undefined,
          matrix: body.matrix,
        });
        sendJson(response, 200, result);
        return;
      }

      if (method === "GET" && pathParts[0] === "images" && pathParts[1]) {
        const image = store.getImage(
          pathParts[1],
          parseImageVersion(url.searchParams.get("version") ?? undefined)
        );
        sendJson(response, 200, image);
        return;
      }

      if (method === "POST" && url.pathname === "/quantize") {
        const body = await readJson(request);
        const result = await store.quantizeSnapshot({
          name: typeof body.name === "string" ? body.name : undefined,
          matrix: body.matrix,
          k: body.k,
        });
        sendJson(response, 200, result);
        return;
      }

      if (
        method === "POST" &&
        pathParts[0] === "images" &&
        pathParts[1] &&
        pathParts[2] === "quantize"
      ) {
        const body = await readJson(request);
        const result = await store.quantizeStored(
          pathParts[1],
          body.k,
          parseImageVersion(url.searchParams.get("version") ?? undefined)
        );
        sendJson(response, 200, result);
        return;
      }

      if (method === "GET" && pathParts[0] === "runs" && pathParts[1]) {
        sendJson(response, 200, store.getRun(parseRunId(pathParts[1])));
        return;
      }

      if (
        method === "GET" &&
        pathParts[0] === "runs" &&
        pathParts[2] === "steps"
      ) {
        sendJson(response, 200, {
          runId: parseRunId(pathParts[1]),
          steps: store.getSteps(parseRunId(pathParts[1])),
        });
        return;
      }

      if (
        method === "GET" &&
        pathParts[0] === "runs" &&
        pathParts[2] === "pixel"
      ) {
        const runId = parseRunId(pathParts[1]);
        const row = Number(url.searchParams.get("row"));
        const column = Number(url.searchParams.get("column"));
        sendJson(response, 200, store.getPixel(runId, row, column));
        return;
      }

      if (
        method === "GET" &&
        pathParts[0] === "runs" &&
        pathParts[2] === "export.ppm"
      ) {
        const run = store.getRun(parseRunId(pathParts[1]));
        const ppm = matrixToPPM(run.reconstructed);
        response.writeHead(200, { "content-type": "image/x-portable-pixmap" });
        response.end(ppm);
        return;
      }

      if (method === "POST" && url.pathname === "/compare") {
        const body = await readJson(request);
        const first = store.getRun(parseRunId(String(body.firstRunId)));
        const second = store.getRun(parseRunId(String(body.secondRunId)));
        sendJson(response, 200, compareRuns(first, second));
        return;
      }

      if (method === "POST" && url.pathname === "/validate") {
        const body = await readJson(request);
        const matrix = validateMatrix(body.matrix);
        const k = body.k === undefined ? undefined : validateK(body.k);
        sendJson(response, 200, { ok: true, rows: matrix.length, k });
        return;
      }

      sendJson(response, 404, {
        error: { code: "ROUTE_NOT_FOUND", message: "找不到 API 路由" },
      });
    } catch (error) {
      sendError(response, error);
    }
  });
}

export async function listenOnFreePort(
  server: Server,
  preferredPort?: number
): Promise<number> {
  const port = preferredPort ?? 0;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法获取监听端口");
  }
  return address.port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databasePath = process.env.DATABASE_PATH ?? resolve("data/palette.sqlite");
  const configuredPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  if (configuredPort !== undefined && (!Number.isSafeInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535)) {
    throw new Error("PORT 必须是 0 到 65535 的整数");
  }
  const store = new Store(databasePath);
  const server = createApp(store);
  const port = await listenOnFreePort(server, configuredPort);
  console.log(`RGB 调色板服务已启动: http://127.0.0.1:${port}`);
  console.log(`SQLite: ${databasePath}`);
}
