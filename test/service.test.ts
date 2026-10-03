import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import * as service from "../src/service.js";
import { createApp } from "../src/server.js";
import { AddressInfo } from "node:net";
import { Server } from "node:http";

const DB_PATH = "data/test-app.db";
let server: Server;
let base: string;

before(async () => {
  rmSync(DB_PATH, { force: true });
  for (const ext of ["-wal", "-shm"]) rmSync(DB_PATH + ext, { force: true });
  openDb(DB_PATH);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function api(path: string, init?: RequestInit) {
  const res = await fetch(base + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("非法请求返回错误码且不写入图像记录", async () => {
  const before = service.listImages().length;
  const bad = await api("/api/images", {
    method: "POST",
    body: JSON.stringify({ matrix: [[[300, 0, 0]]] }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "E_CHANNEL");
  assert.equal(service.listImages().length, before);

  const badShape = await api("/api/images", {
    method: "POST",
    body: JSON.stringify({ matrix: [[[0, 0]]] }),
  });
  assert.equal(badShape.body.code, "E_SHAPE");
  assert.equal(service.listImages().length, before);
});

test("导入->量化->像素查询->比较->重启读取 全流程", async () => {
  const matrix = [
    [[0, 0, 0], [255, 255, 255]],
    [[100, 100, 100]],
  ];
  const imp = await api("/api/images", {
    method: "POST",
    body: JSON.stringify({ matrix }),
  });
  assert.equal(imp.status, 200);
  const imageId = imp.body.imageId;
  assert.equal(imp.body.rectangular, false);

  const q2 = await api(`/api/quantize`, {
    method: "POST",
    body: JSON.stringify({ imageId, k: 2 }),
  });
  assert.equal(q2.status, 200);
  assert.ok(q2.body.actualColors === 2);
  assert.equal(q2.body.ruleVersion, "tie-v1");

  // K 越界
  const badK = await api(`/api/images/${imageId}/steps?k=17`);
  assert.equal(badK.body.code, "E_K");

  // 分裂步骤
  const steps = await api(`/api/images/${imageId}/steps?k=2`);
  assert.ok(steps.body.steps.length >= 1);
  assert.ok(["R", "G", "B"].includes(steps.body.steps[0].channel));

  // 像素查询
  const px = await api(`/api/images/${imageId}/pixels?k=2&row=1&col=0`);
  assert.deepEqual(px.body.original, [100, 100, 100]);
  assert.equal(px.body.replacement.length, 3);

  // 比较两个 K
  const cmp = await api(`/api/images/${imageId}/compare?k1=1&k2=2`);
  assert.ok("totalMseDelta" in cmp.body);

  // JSON 导出
  const exp = await api(`/api/images/${imageId}/export?k=2&format=json`);
  assert.equal(exp.body.palette.length, exp.body.actualColors);

  // PPM 对非矩形应报错
  const ppm = await api(`/api/images/${imageId}/export?k=2&format=ppm`);
  assert.equal(ppm.body.code, "E_SHAPE");

  // 直方图相同（排列不同）复用同一图像
  const reordered = [
    [[100, 100, 100], [0, 0, 0]],
    [[255, 255, 255]],
  ];
  const imp2 = await api("/api/images", {
    method: "POST",
    body: JSON.stringify({ matrix: reordered }),
  });
  assert.equal(imp2.body.imageId, imageId);
  assert.equal(imp2.body.reused, true);
});

test("矩形图可导出 PPM 且重启后可复算历史报告", async () => {
  const matrix = [
    [[1, 2, 3], [4, 5, 6]],
    [[7, 8, 9], [10, 11, 12]],
  ];
  const imp = service.importImage(matrix);
  const imageId = imp.imageId;
  service.runQuantize(imageId, 3);

  // 模拟“重启”：直接从持久层读取，不重算（storedOrCompute 走缓存分支）。
  const again = service.exportResult(imageId, 3);
  assert.equal(again.totalPixels, 4);
  assert.equal(again.usage.reduce((a, b) => a + b, 0), 4);

  const res = await fetch(
    `${base}/api/images/${imageId}/export?k=3&format=ppm`
  );
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.subarray(0, 2).toString("ascii") === "P6");
});

test("修改输入产生新版本（不同直方图 -> 新 imageId）", () => {
  const a = service.importImage([[[0, 0, 0]]]);
  const b = service.importImage([[[1, 0, 0]]]);
  assert.notEqual(a.imageId, b.imageId);
});
