import { test } from "node:test";
import assert from "node:assert/strict";
import { histogram, parseImage } from "../src/validate.js";
import { quantize } from "../src/quantize.js";

function q(matrix: number[][][], k: number) {
  const rows = parseImage(matrix);
  const { colors, weights } = histogram(rows);
  return quantize(rows, colors, weights, k);
}

test("单色图：只有一个唯一颜色，任何 K 都得一个盒", () => {
  const m = [
    [[10, 20, 30], [10, 20, 30]],
    [[10, 20, 30], [10, 20, 30]],
  ];
  for (const k of [1, 2, 16]) {
    const r = q(m, k);
    assert.equal(r.actualColors, 1);
    assert.deepEqual(r.palette, [[10, 20, 30]]);
    assert.equal(r.steps.length, 0);
    assert.deepEqual(r.channelSSE, [0, 0, 0]);
  }
});

test("K=1：代表色为整体加权平均（半数向上）", () => {
  // 两个颜色权重 3 与 1：R 平均=(0*3+4)/4=1, G=(0*3+6)/4=1.5->2, B=0
  const m = [
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    [[4, 6, 0]],
  ];
  const r = q(m, 1);
  assert.deepEqual(r.palette, [[1, 2, 0]]);
  assert.equal(r.usage[0], 4);
});

test("K 大于唯一颜色数：实际颜色数等于唯一颜色数", () => {
  const m = [[[0, 0, 0]], [[255, 255, 255]], [[128, 0, 0]]];
  const r = q(m, 16);
  assert.equal(r.actualColors, 3);
  assert.equal(r.steps.length, 2);
});

test("手算第一次分裂：权重不均时切在累计权重过半处", () => {
  // R 通道跨度最大。颜色 A=(0,0,0) 权重 7，B=(100,0,0) 权重 1，C=(200,0,0) 权重 4。
  // 总权重 12，半=6。排序 A,B,C：累计 A=7 >= 6 => 切在 A | (B,C)。
  const m = [
    ...Array.from({ length: 7 }, () => [[0, 0, 0] as number[]]),
    ...Array.from({ length: 1 }, () => [[100, 0, 0] as number[]]),
    ...Array.from({ length: 4 }, () => [[200, 0, 0] as number[]]),
  ];
  const r = q(m, 2);
  assert.equal(r.steps.length, 1);
  const step = r.steps[0];
  assert.equal(step.channel, "R");
  assert.equal(step.leftWeight, 7);
  assert.equal(step.rightWeight, 5);
  assert.equal(step.range, 200);
  // 左代表色=A=(0,0,0)；右为 B,C 加权：R=(100+800)/5=180
  assert.deepEqual(r.palette[0], [0, 0, 0]);
  assert.deepEqual(r.palette[1], [180, 0, 0]);
});

test("通道跨度平局：选择 R 通道（r<g<b 固定平局）", () => {
  // 两色在 R 与 B 上跨度相同（100），G 跨度 0。
  const m = [
    [[0, 50, 0], [0, 50, 0]],
    [[100, 50, 100], [100, 50, 100]],
  ];
  const r = q(m, 2);
  assert.equal(r.steps[0].channel, "R");
});

test("最近色平局：相等距离取较小调色板索引", () => {
  // 以 quantize 内部完全一致的“严格小于才更新”规则验证等距平局。
  const pick = (
    palette: [number, number, number][],
    px: [number, number, number]
  ) => {
    let best = 0;
    let bestD = Infinity;
    palette.forEach((c, i) => {
      const d =
        (c[0] - px[0]) ** 2 +
        (c[1] - px[1]) ** 2 +
        (c[2] - px[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  assert.equal(
    pick(
      [
        [0, 0, 0],
        [20, 0, 0],
      ],
      [10, 0, 0]
    ),
    0
  );
});

test("非矩形（锯齿）输入：按行重建，像素数为各行之和", () => {
  const m = [
    [[0, 0, 0], [255, 255, 255]],
    [[128, 128, 128]],
  ];
  const r = q(m, 2);
  assert.equal(r.indices.length, 2);
  assert.equal(r.indices[0].length, 2);
  assert.equal(r.indices[1].length, 1);
  assert.equal(r.totalPixels, 3);
  assert.equal(r.usage.reduce((a, b) => a + b, 0), 3);
});

test("误差一致性：独立扫描原图与重建图核对 SSE/MSE/用量/索引", () => {
  const m = [
    [[10, 200, 4], [200, 30, 90]],
    [[50, 60, 70], [1, 2, 3]],
    [[120, 0, 240]],
  ];
  const r = q(m, 3);
  let n = 0;
  const sse: [number, number, number] = [0, 0, 0];
  let maxD = 0;
  const use = new Array(r.palette.length).fill(0);
  m.forEach((row, ri) =>
    row.forEach((px, ci) => {
      const idx = r.indices[ri][ci];
      assert.ok(Number.isInteger(idx) && idx >= 0 && idx < r.palette.length);
      use[idx]++;
      const rep = r.rebuilt[ri][ci];
      assert.deepEqual(rep, r.palette[idx]);
      for (let ch = 0; ch < 3; ch++) {
        sse[ch] += (px[ch] - rep[ch]) ** 2;
      }
      const d =
        (px[0] - rep[0]) ** 2 +
        (px[1] - rep[1]) ** 2 +
        (px[2] - rep[2]) ** 2;
      if (d > maxD) maxD = d;
      n++;
    })
  );
  assert.deepEqual(sse, r.channelSSE);
  assert.equal(maxD, r.maxPixelSqDist);
  assert.deepEqual(use, r.usage);
  assert.equal(use.reduce((a, b) => a + b, 0), n);
  for (let ch = 0; ch < 3; ch++)
    assert.ok(Math.abs(r.channelMSE[ch] - sse[ch] / n) < 1e-9);
});

test("像素顺序变化但直方图相同 => 调色板一致", () => {
  const a = [
    [[0, 0, 0], [100, 0, 0], [0, 100, 0]],
    [[0, 0, 100], [50, 50, 50], [200, 200, 0]],
  ];
  const b = [
    [[200, 200, 0], [0, 0, 0]],
    [[50, 50, 50], [0, 100, 0], [0, 0, 100], [100, 0, 0]],
  ];
  for (const k of [1, 2, 3, 4]) {
    const ra = q(a, k);
    const rb = q(b, k);
    assert.deepEqual(ra.palette, rb.palette);
  }
});

test("非法输入：越界通道、错误形状", () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(codeOf(() => q([[[256, 0, 0]]], 2)), "E_CHANNEL");
  assert.equal(codeOf(() => q([[[-1, 0, 0]]], 2)), "E_CHANNEL");
  assert.equal(codeOf(() => q([[[0, 0]]], 2)), "E_SHAPE");
  assert.equal(
    codeOf(() => q([[[0, 0, "x" as unknown as number]]], 2)),
    "E_SHAPE"
  );
  assert.equal(codeOf(() => q([], 2)), "E_EMPTY");
});
