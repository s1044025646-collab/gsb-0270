import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import { quantize } from "../src/quantize.js";
import { Store } from "../src/store.js";
import { validateMatrix } from "../src/validation.js";
import type { Rgb, RgbMatrix } from "../src/types.js";

function independentlyVerify(result: ReturnType<typeof quantize>, source: RgbMatrix) {
  let pixelCount = 0;
  const errors = [0, 0, 0];
  let totalUsage = 0;
  let maxDistance = -1;

  source.forEach((row, rowIndex) => {
    row.forEach((pixel, columnIndex) => {
      pixelCount += 1;
      const paletteIndex = result.indices[rowIndex][columnIndex];
      assert.ok(paletteIndex >= 0 && paletteIndex < result.report.palette.length);
      const replacement = result.report.palette[paletteIndex];
      assert.deepEqual(result.reconstructed[rowIndex][columnIndex], replacement);
      totalUsage += 1;
      let distance = 0;
      pixel.forEach((channel, channelIndex) => {
        const channelError = channel - replacement[channelIndex];
        errors[channelIndex] += channelError * channelError;
        distance += channelError * channelError;
      });
      maxDistance = Math.max(maxDistance, distance);
    });
  });

  assert.deepEqual(errors, result.report.channelSquareError);
  assert.equal(maxDistance, result.report.maxPixelSquareDistance);
  assert.equal(
    result.report.usageCounts.reduce((sum, count) => sum + count, 0),
    pixelCount
  );
  assert.equal(totalUsage, pixelCount);
}

test("单色图在 K=1 时返回唯一颜色且无误差", () => {
  const matrix: RgbMatrix = [
    [[12, 34, 56], [12, 34, 56]],
    [[12, 34, 56], [12, 34, 56]],
  ];
  const result = quantize(matrix, 1);
  assert.equal(result.report.actualColorCount, 1);
  assert.deepEqual(result.report.palette, [[12, 34, 56]]);
  assert.deepEqual(result.report.channelSquareError, [0, 0, 0]);
  independentlyVerify(result, matrix);
});

test("K 大于唯一颜色数时只生成唯一颜色数", () => {
  const matrix: RgbMatrix = [[[1, 2, 3]], [[4, 5, 6]]];
  const result = quantize(matrix, 16);
  assert.equal(result.report.actualColorCount, 2);
  assert.equal(result.steps.length, 1);
  independentlyVerify(result, matrix);
});

test("手算第一次加权分裂和半入代表色", () => {
  const matrix: RgbMatrix = [
    [[0, 0, 0]],
    [[0, 0, 0]],
    [[0, 0, 0]],
    [[0, 0, 0]],
    [[0, 0, 0]],
    [[1, 0, 0]],
    ...Array.from({ length: 6 }, () => [[10, 0, 0]] as Rgb[]),
  ];
  const result = quantize(matrix, 2);
  const split = result.steps[0];
  assert.equal(split.channel, 0);
  assert.equal(split.parentWeight, 12);
  assert.equal(split.leftWeight, 6);
  assert.equal(split.rightWeight, 6);
  assert.equal(split.cutBoundary.belowOrEqual, 1);
  assert.equal(split.cutBoundary.aboveOrEqual, 10);
  const halfUpMatrix: RgbMatrix = [[[0, 0, 0]], [[1, 0, 0]]];
  assert.deepEqual(quantize(halfUpMatrix, 1).report.palette, [[1, 0, 0]]);
  independentlyVerify(result, matrix);
});

test("R 和 G 同跨度时固定选择 R 通道", () => {
  const matrix: RgbMatrix = [
    [[0, 0, 0], [0, 10, 0]],
    [[10, 0, 0], [10, 10, 0]],
  ];
  const result = quantize(matrix, 2);
  assert.equal(result.steps[0].channel, 0);
  independentlyVerify(result, matrix);
});

test("权重明显不均时按累计频数而不是颜色数切半", () => {
  const matrix: RgbMatrix = [
    [[0, 0, 0]],
    [[6, 0, 0]],
    ...Array.from({ length: 10 }, () => [[7, 0, 0]] as Rgb[]),
    [[10, 0, 0]],
  ];
  const result = quantize(matrix, 2);
  assert.deepEqual(result.steps[0].cutBoundary, {
    belowOrEqual: 6,
    aboveOrEqual: 7,
  });
  assert.equal(result.steps[0].leftWeight, 2);
  assert.equal(result.steps[0].rightWeight, 11);
  independentlyVerify(result, matrix);
});

test("最终最近色相等时选择较小调色板索引", () => {
  const matrix: RgbMatrix = [
    [[0, 0, 0], [0, 10, 0]],
    [[10, 0, 0], [10, 10, 0]],
    [[5, 0, 0]],
  ];
  const result = quantize(matrix, 2);
  assert.deepEqual(result.report.palette, [[0, 5, 0], [8, 3, 0]]);
  const tieResult = quantize(
    [
      [[0, 0, 0]],
      ...Array.from({ length: 10 }, () => [[0, 0, 0]] as Rgb[]),
      [[5, 0, 0]],
      ...Array.from({ length: 9 }, () => [[10, 0, 0]] as Rgb[]),
    ] as RgbMatrix,
    2
  );
  assert.deepEqual(tieResult.report.palette, [[0, 0, 0], [10, 0, 0]]);
  assert.equal(tieResult.indices[2][0], 0);
  independentlyVerify(result, matrix);
});

test("接受非矩形矩阵并逐像素校验", () => {
  const matrix = validateMatrix([
    [[1, 2, 3]],
    [[4, 5, 6], [7, 8, 9]],
  ]);
  const result = quantize(matrix, 2);
  assert.equal(result.report.pixelCount, 3);
  assert.equal(result.indices[0].length, 1);
  assert.equal(result.indices[1].length, 2);
  independentlyVerify(result, matrix);
});

test("像素顺序变化但直方图相同时调色板一致", () => {
  const first: RgbMatrix = [
    [[0, 0, 0], [10, 0, 0], [10, 0, 0]],
    [[0, 10, 0], [10, 10, 0]],
  ];
  const second: RgbMatrix = [
    [[10, 10, 0], [0, 0, 0]],
    [[10, 0, 0], [0, 10, 0], [10, 0, 0]],
  ];
  const firstResult = quantize(first, 3);
  const secondResult = quantize(second, 3);
  assert.deepEqual(firstResult.report.palette, secondResult.report.palette);
  assert.deepEqual(firstResult.steps, secondResult.steps);
});

test("SQLite 保存结果且非法请求不留下成功记录", async () => {
  const path = "data/test-palette.sqlite";
  rmSync(path, { force: true });
  const store = new Store(path);

  await assert.rejects(
    () => store.quantizeSnapshot({ matrix: [[[256, 0, 0]]], k: 2 }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CHANNEL"
  );
  await assert.rejects(
    () => store.quantizeSnapshot({ matrix: [[[0, 0, 0]]], k: 17 }),
    (error: unknown) => (error as { code?: string }).code === "K_OUT_OF_RANGE"
  );
  assert.deepEqual(store.listImages(), []);

  const run = await store.quantizeSnapshot({
    name: "persist",
    matrix: [[[0, 0, 0]], [[10, 10, 10]]],
    k: 2,
  });
  store.close();

  const reopened = new Store(path);
  const loaded = reopened.getRun(run.runId);
  assert.deepEqual(loaded.report.palette, run.report.palette);
  reopened.close();
});

test("修改输入产生新版本且可读取历史报告", async () => {
  const path = "data/test-versions.sqlite";
  rmSync(path, { force: true });
  const store = new Store(path);
  const first = await store.quantizeSnapshot({
    name: "versioned",
    matrix: [[[1, 2, 3]]],
    k: 1,
  });
  const changed = await store.importImage({
    imageId: first.imageId,
    matrix: [[[4, 5, 6]]],
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.changed, true);
  const second = await store.quantizeStored(first.imageId, 1, 2);
  const historical = store.getRun(first.runId);
  assert.deepEqual(historical.report.palette, [[1, 2, 3]]);
  assert.deepEqual(second.report.palette, [[4, 5, 6]]);
  store.close();
});
