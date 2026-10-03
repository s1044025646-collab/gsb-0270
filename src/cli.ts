#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppError } from "./errors.js";
import { compareRuns } from "./compare.js";
import { matrixToPPM } from "./ppm.js";
import { Store } from "./store.js";
import { createApp, listenOnFreePort } from "./server.js";

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  const valueOptions = new Set([
    "--db",
    "--id",
    "--name",
    "--input",
    "--k",
    "--version",
    "--run",
    "--row",
    "--column",
    "--first",
    "--second",
    "--output",
    "--kind",
    "--port",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (valueOptions.has(token) && next !== undefined && !next.startsWith("--")) {
      args.set(token, next);
      index += 1;
    } else {
      args.set(token, "true");
    }
  }
  return args;
}

function required(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new AppError("MISSING_ARGUMENT", `缺少参数 ${name}`, 400);
  return value;
}

function readMatrix(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function integer(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError("INVALID_INTEGER", `${name} 必须是整数`, 400);
  }
  return parsed;
}

function makeDemo(name: "gradient" | "blocks"): unknown {
  if (name === "gradient") {
    return Array.from({ length: 16 }, (_unused, row) =>
      Array.from({ length: 16 }, (_unusedPixel, column) => [
        row * 17,
        column * 17,
        ((row + column) * 8) % 256,
      ])
    );
  }
  return Array.from({ length: 16 }, (_unused, row) =>
    Array.from({ length: 16 }, (_unusedPixel, column) => {
      if (row < 8 && column < 8) return [220, 30, 30];
      if (row < 8) return [30, 220, 40];
      if (column < 8) return [30, 70, 220];
      return [230, 220, 60];
    })
  );
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  const databasePath = resolve(args.get("--db") ?? "data/palette.sqlite");
  const store = new Store(databasePath);

  {
    switch (command) {
      case "import": {
        const imported = await store.importImage({
          imageId: args.get("--id"),
          name: args.get("--name"),
          matrix: readMatrix(required(args, "--input")),
        });
        console.log(JSON.stringify(imported, null, 2));
        break;
      }
      case "quantize": {
        let run;
        if (args.has("--input")) {
          run = await store.quantizeSnapshot({
            name: args.get("--name"),
            matrix: readMatrix(args.get("--input")!),
            k: integer(required(args, "--k"), "--k"),
          });
        } else {
          run = await store.quantizeStored(
            required(args, "--id"),
            integer(required(args, "--k"), "--k"),
            args.has("--version") ? integer(args.get("--version")!, "--version") : undefined
          );
        }
        console.log(JSON.stringify(run, null, 2));
        break;
      }
      case "images":
        console.log(JSON.stringify(store.listImages(), null, 2));
        break;
      case "run":
        console.log(
          JSON.stringify(store.getRun(integer(required(args, "--run"), "--run")), null, 2)
        );
        break;
      case "steps":
        console.log(
          JSON.stringify(
            store.getSteps(integer(required(args, "--run"), "--run")),
            null,
            2
          )
        );
        break;
      case "pixel": {
        const result = store.getPixel(
          integer(required(args, "--run"), "--run"),
          integer(required(args, "--row"), "--row"),
          integer(required(args, "--column"), "--column")
        );
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "compare": {
        const first = store.getRun(integer(required(args, "--first"), "--first"));
        const second = store.getRun(integer(required(args, "--second"), "--second"));
        console.log(JSON.stringify(compareRuns(first, second), null, 2));
        break;
      }
      case "export": {
        const run = store.getRun(integer(required(args, "--run"), "--run"));
        const output = required(args, "--output");
        if (output.toLowerCase().endsWith(".ppm")) {
          writeFileSync(resolve(output), matrixToPPM(run.reconstructed), "utf8");
        } else {
          writeFileSync(resolve(output), JSON.stringify(run, null, 2), "utf8");
        }
        console.log(`已导出 ${output}`);
        break;
      }
      case "demo": {
        const kind = args.get("--kind") === "blocks" ? "blocks" : "gradient";
        const k = integer(args.get("--k") ?? "4", "--k");
        const run = await store.quantizeSnapshot({
          name: kind,
          matrix: makeDemo(kind),
          k,
        });
        console.log(JSON.stringify(run.report, null, 2));
        break;
      }
      case "serve": {
        const portArgument = args.get("--port") ?? process.env.PORT;
        const port = portArgument ? integer(portArgument, "--port") : undefined;
        const server = createApp(store);
        const actualPort = await listenOnFreePort(server, port);
        console.log(`http://127.0.0.1:${actualPort}`);
        break;
      }
      default:
        console.log(`用法:
  npm run cli -- import --input matrix.json [--id demo] [--name 演示]
  npm run cli -- quantize --input matrix.json --k 4
  npm run cli -- quantize --id demo --k 4 [--version 1]
  npm run cli -- images
  npm run cli -- run --run 1
  npm run cli -- steps --run 1
  npm run cli -- pixel --run 1 --row 0 --column 0
  npm run cli -- compare --first 1 --second 2
  npm run cli -- export --run 1 --output result.json|result.ppm
  npm run cli -- demo --kind gradient|blocks --k 4
  npm run cli -- serve [--port 0]`);
        store.close();
        return;
    }
  }
  store.close();
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(JSON.stringify({ code: error.code, message: error.message }, null, 2));
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
