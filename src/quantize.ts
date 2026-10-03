import { RGB } from "./validate.js";
import { QuantError } from "./constants.js";

export interface SplitStep {
  step: number;
  parentBoxId: number;
  channel: "R" | "G" | "B";
  range: number;
  totalWeight: number;
  cutWeight: number;
  leftWeight: number;
  rightWeight: number;
  parentRange: {
    r: [number, number];
    g: [number, number];
    b: [number, number];
  };
  leftBoxId: number;
  rightBoxId: number;
}

export interface Box {
  id: number;
  indices: number[];
  weight: number;
  range: { r: [number, number]; g: [number, number]; b: [number, number] };
}

export interface QuantResult {
  palette: RGB[];
  indices: number[][];
  rebuilt: RGB[][];
  actualColors: number;
  usage: number[];
  channelSSE: [number, number, number];
  channelMSE: [number, number, number];
  maxPixelSqDist: number;
  totalPixels: number;
  boxes: Box[];
  steps: SplitStep[];
}

function rangeOf(
  indices: number[],
  colors: RGB[]
): Box["range"] {
  let rMin = 255,
    rMax = 0,
    gMin = 255,
    gMax = 0,
    bMin = 255,
    bMax = 0;
  for (const i of indices) {
    const [r, g, b] = colors[i];
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return {
    r: [rMin, rMax],
    g: [gMin, gMax],
    b: [bMin, bMax],
  };
}

// 加权平均，四舍五入（半数向上），舍入规则固定。
function representative(
  indices: number[],
  colors: RGB[],
  weights: number[]
): RGB {
  let sr = 0,
    sg = 0,
    sb = 0,
    w = 0;
  for (const i of indices) {
    const wt = weights[i];
    sr += colors[i][0] * wt;
    sg += colors[i][1] * wt;
    sb += colors[i][2] * wt;
    w += wt;
  }
  const roundHalfUp = (num: number, den: number) =>
    Math.floor(num / den + 0.5);
  return [roundHalfUp(sr, w), roundHalfUp(sg, w), roundHalfUp(sb, w)];
}

export function quantize(
  rows: RGB[][],
  colors: RGB[],
  weights: number[],
  k: number
): QuantResult {
  if (k < 1) throw new QuantError("E_K", "K 至少为 1");
  const steps: SplitStep[] = [];
  let nextId = 1;
  const root: Box = {
    id: nextId++,
    indices: colors.map((_, i) => i),
    weight: colors.reduce((s, _, i) => s + weights[i], 0),
    range: rangeOf(colors.map((_, i) => i), colors),
  };
  let boxes: Box[] = [root];

  const channels = ["r", "g", "b"] as const;
  while (boxes.length < k) {
    // 选择可分裂盒中跨度最大者；平局按较小盒 id，再按通道 r<g<b（固定规则）。
    let best = -1;
    let bestRange = 0;
    let bestCh: (typeof channels)[number] = "r";
    for (const box of boxes) {
      if (box.indices.length < 2) continue;
      for (const ch of channels) {
        const span = box.range[ch][1] - box.range[ch][0];
        if (span === 0) continue;
        if (best === -1) {
          best = boxes.indexOf(box);
          bestRange = span;
          bestCh = ch;
          continue;
        }
        if (
          span > bestRange ||
          (span === bestRange &&
            (box.id < boxes[best].id ||
              (box.id === boxes[best].id &&
                channels.indexOf(ch) < channels.indexOf(bestCh))))
        ) {
          best = boxes.indexOf(box);
          bestRange = span;
          bestCh = ch;
        }
      }
    }
    if (best === -1) break; // 没有可分裂的盒

    const parent = boxes[best];
    const sorted = [...parent.indices].sort((a, b) => {
      const ca = colors[a];
      const cb = colors[b];
      const ci =
        bestCh === "r" ? 0 : bestCh === "g" ? 1 : 2;
      // 同值颜色按 RGB 字典序（含另一盒不变量）固定平局。
      return (
        ca[ci] - cb[ci] || ca[0] - cb[0] || ca[1] - cb[1] || ca[2] - cb[2]
      );
    });
    const half = parent.weight / 2;
    let cum = 0;
    let cut = 0; // 左半取 [0, cut)，右半取 [cut, end)
    for (let j = 0; j < sorted.length - 1; j++) {
      cum += weights[sorted[j]];
      if (cum >= half) {
        cut = j + 1;
        break;
      }
    }
    if (cut === 0) cut = 1; // 保证两个非空盒；唯一颜色各自整体，不会被拆开
    const leftIdx = sorted.slice(0, cut);
    const rightIdx = sorted.slice(cut);
    const leftWeight = leftIdx.reduce((s, i) => s + weights[i], 0);
    const rightWeight = parent.weight - leftWeight;
    const leftBox: Box = {
      id: nextId++,
      indices: leftIdx,
      weight: leftWeight,
      range: rangeOf(leftIdx, colors),
    };
    const rightBox: Box = {
      id: nextId++,
      indices: rightIdx,
      weight: rightWeight,
      range: rangeOf(rightIdx, colors),
    };
    steps.push({
      step: steps.length + 1,
      parentBoxId: parent.id,
      channel: bestCh === "r" ? "R" : bestCh === "g" ? "G" : "B",
      range: bestRange,
      totalWeight: parent.weight,
      cutWeight: leftWeight,
      leftWeight,
      rightWeight,
      parentRange: parent.range,
      leftBoxId: leftBox.id,
      rightBoxId: rightBox.id,
    });
    boxes = boxes
      .filter((b) => b.id !== parent.id)
      .concat([leftBox, rightBox]);
  }

  // 最终盒按 id（公开生成次序）排序后求代表色。
  boxes.sort((a, b) => a.id - b.id);
  const palette: RGB[] = boxes.map((box) =>
    representative(box.indices, colors, weights)
  );

  // 逐像素在“所有”代表色中找平方距离最小者，平局取较小索引。
  const totalPixels = rows.reduce((s, r) => s + r.length, 0);
  const indices: number[][] = [];
  const rebuilt: RGB[][] = [];
  const usage = new Array<number>(palette.length).fill(0);
  const sse: [number, number, number] = [0, 0, 0];
  let maxDist = 0;
  for (const row of rows) {
    const idxRow: number[] = [];
    const rebRow: RGB[] = [];
    for (const px of row) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let p = 0; p < palette.length; p++) {
        const [pr, pg, pb] = palette[p];
        const dr = px[0] - pr;
        const dg = px[1] - pg;
        const db = px[2] - pb;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          bestIdx = p;
        }
      }
      const rep = palette[bestIdx];
      idxRow.push(bestIdx);
      rebRow.push(rep);
      usage[bestIdx]++;
      sse[0] += (px[0] - rep[0]) ** 2;
      sse[1] += (px[1] - rep[1]) ** 2;
      sse[2] += (px[2] - rep[2]) ** 2;
      if (bestD > maxDist) maxDist = bestD;
    }
    indices.push(idxRow);
    rebuilt.push(rebRow);
  }

  return {
    palette,
    indices,
    rebuilt,
    actualColors: palette.length,
    usage,
    channelSSE: sse,
    channelMSE: [
      sse[0] / totalPixels,
      sse[1] / totalPixels,
      sse[2] / totalPixels,
    ],
    maxPixelSqDist: maxDist,
    totalPixels,
    boxes,
    steps,
  };
}
