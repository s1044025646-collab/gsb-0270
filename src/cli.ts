#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import * as service from "./service.js";
import { QuantError } from "./constants.js";
import { toPPM } from "./ppm.js";
import { gradient, colorBlocks } from "./demo.js";
import { RGB } from "./validate.js";
import { getImage } from "./db.js";

function print(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function fail(err: unknown): never {
  if (err instanceof QuantError) {
    console.error(`错误 [${err.code}] ${err.message}`);
  } else {
    console.error("错误:", (err as Error).message);
  }
  process.exit(1);
}

function readMatrixFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseFlags(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        m.set(key, next);
        i++;
      } else {
        m.set(key, "true");
      }
    }
  }
  return m;
}

const usage = `RGB 调色板量化 CLI

用法:
  rq import --file matrix.json            导入像素矩阵
  rq quantize --image ID --k K            量化（K 为 1..16）
  rq steps --image ID --k K               查看分裂步骤
  rq pixel --image ID --k K --row R --col C   查询某像素原色与替代色
  rq compare --image ID --k1 A --k2 B     比较两个 K
  rq export --image ID --k K [--format json|ppm|ppm-original] [--out file]
  rq demo                                 演示渐变图与色块图差异

环境:
  PORT        HTTP 服务端口（npm start，默认自动选择空闲端口）
`;

function run() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  try {
    switch (cmd) {
      case "import": {
        const file = flags.get("file");
        if (!file) throw new QuantError("E_ARG", "需要 --file");
        print(service.importImage(readMatrixFile(file)));
        break;
      }
      case "quantize":
        print(
          service.runQuantize(Number(flags.get("image")), Number(flags.get("k")))
        );
        break;
      case "steps":
        print(
          service.getSteps(Number(flags.get("image")), Number(flags.get("k")))
        );
        break;
      case "pixel":
        print(
          service.getPixel(
            Number(flags.get("image")),
            Number(flags.get("k")),
            Number(flags.get("row")),
            Number(flags.get("col"))
          )
        );
        break;
      case "compare":
        print(
          service.compareK(
            Number(flags.get("image")),
            Number(flags.get("k1")),
            Number(flags.get("k2"))
          )
        );
        break;
      case "export": {
        const imageId = Number(flags.get("image"));
        const k = Number(flags.get("k"));
        const format = flags.get("format") ?? "json";
        const result = service.exportResult(imageId, k);
        if (format === "json") {
          const text = JSON.stringify(result, null, 2);
          if (flags.get("out")) writeFileSync(flags.get("out")!, text);
          else console.log(text);
        } else if (format === "ppm" || format === "ppm-original") {
          const rows: RGB[][] =
            format === "ppm" ? result.rebuilt : readOriginal(imageId);
          const buf = toPPM(rows);
          const out = flags.get("out") ?? `image_${imageId}_k${k}_${format}.ppm`;
          writeFileSync(out, buf);
          console.log(`已写入 ${out}`);
        } else {
          throw new QuantError("E_ARG", `未知格式 ${format}`);
        }
        break;
      }
      case "demo":
        demo();
        break;
      default:
        console.log(usage);
        if (cmd) process.exit(1);
    }
  } catch (err) {
    fail(err);
  }
}

function readOriginal(imageId: number): RGB[][] {
  const rec = getImage(imageId);
  if (!rec) throw new QuantError("E_NOT_FOUND", `图像 ${imageId} 不存在`);
  return JSON.parse(rec.matrix_json) as RGB[][];
}

function summarize(name: string, matrix: RGB[][], k: number) {
  const imp = service.importImage(matrix);
  const r = service.runQuantize(imp.imageId, k);
  console.log(`\n== ${name} (K=${k}) ==`);
  console.log(`像素数=${imp.pixelCount}, 唯一色=${imp.uniqueColors}, 实际色=${r.actualColors}`);
  console.log(`每通道 MSE(R,G,B)=[${r.channelMSE.map((v) => v.toFixed(2)).join(", ")}]`);
  console.log(`最大单像素平方距离=${r.maxPixelSqDist}`);
  console.log(`调色板=${JSON.stringify(r.palette)}`);
  console.log(`分裂次数=${r.steps.length}`);
  return { imp, r };
}

function demo() {
  console.log("演示 1：平滑渐变图（颜色连续，K 增加误差总体下降）");
  const g = gradient(16, 16);
  let prev = Infinity;
  for (const k of [1, 2, 4, 8, 16]) {
    const { r } = summarize("渐变图", g, k);
    const total = r.channelMSE.reduce((a, b) => a + b, 0);
    console.log(`总 MSE=${total.toFixed(2)}（较上一 K 变化 ${(total - prev).toFixed(2)}）`);
    prev = total;
  }

  console.log("\n演示 2：权重不均色块图（启发式不保证每项严格单调）");
  const blocks = colorBlocks();
  for (const k of [1, 2, 3, 4, 5]) summarize("色块图", blocks, k);
  const c2 = service.runQuantize(service.importImage(blocks).imageId, 2);
  const c3 = service.runQuantize(service.importImage(blocks).imageId, 3);
  console.log(
    `\n非单调性说明：K=2 最大像素平方距离=${c2.maxPixelSqDist}, K=3=${c3.maxPixelSqDist}。`
  );
  console.log(
    "median-cut 以盒内权重中点切分，代表色随分箱改变，个别像素/单通道误差可能上升，"
  );
  console.log("因此不保证 K 增加时每一项误差都严格单调，仅在整体趋势上通常改善。");
}

run();
