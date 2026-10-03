import {
  MAX_PIXELS,
  MAX_UNIQUE_COLORS,
  MAX_K,
  MIN_K,
  QuantError,
} from "./constants.js";

export type RGB = [number, number, number];

// 非矩形矩阵：每行长度可以不同，但每个像素必须是长度 3 的整数数组。
export function parseImage(input: unknown): RGB[][] {
  if (!Array.isArray(input)) {
    throw new QuantError("E_SHAPE", "输入必须是二维像素矩阵（数组的数组）");
  }
  if (input.length === 0) {
    throw new QuantError("E_EMPTY", "矩阵至少包含一行");
  }
  const rows: RGB[][] = [];
  let pixelCount = 0;
  for (let r = 0; r < input.length; r++) {
    const row = (input as unknown[])[r];
    if (!Array.isArray(row)) {
      throw new QuantError("E_SHAPE", `第 ${r} 行不是数组`);
    }
    if (row.length === 0) {
      throw new QuantError("E_SHAPE", `第 ${r} 行为空`);
    }
    const out: RGB[] = [];
    for (let c = 0; c < row.length; c++) {
      const px = row[c] as unknown;
      if (
        !Array.isArray(px) ||
        px.length !== 3 ||
        !px.every((v) => Number.isInteger(v))
      ) {
        throw new QuantError(
          "E_SHAPE",
          `像素 [${r}][${c}] 必须是长度 3 的整数数组 [R,G,B]`
        );
      }
      for (const v of px as number[]) {
        if (v < 0 || v > 255) {
          throw new QuantError(
            "E_CHANNEL",
            `像素 [${r}][${c}] 存在越界通道值 ${v}，必须在 0..255`
          );
        }
      }
      out.push([px[0], px[1], px[2]] as RGB);
      pixelCount++;
      if (pixelCount > MAX_PIXELS) {
        throw new QuantError(
          "E_LIMIT",
          `像素总数超过上限 ${MAX_PIXELS}`
        );
      }
    }
    rows.push(out);
  }
  return rows;
}

export function validateK(k: unknown): number {
  if (typeof k !== "number" || !Number.isInteger(k)) {
    throw new QuantError("E_K", "K 必须是整数");
  }
  if (k < MIN_K || k > MAX_K) {
    throw new QuantError("E_K", `K 必须在 ${MIN_K}..${MAX_K} 之间`);
  }
  return k;
}

// 统计 RGB 三元组频数，返回唯一颜色与权重。
export function histogram(rows: RGB[][]): { colors: RGB[]; weights: number[] } {
  const map = new Map<number, number>();
  let unique = 0;
  for (const row of rows) {
    for (const [r, g, b] of row) {
      const key = (r << 16) | (g << 8) | b;
      const cur = map.get(key);
      if (cur === undefined) {
        map.set(key, 1);
        unique++;
        if (unique > MAX_UNIQUE_COLORS) {
          throw new QuantError(
            "E_LIMIT",
            `唯一颜色数超过上限 ${MAX_UNIQUE_COLORS}`
          );
        }
      } else {
        map.set(key, cur + 1);
      }
    }
  }
  const colors: RGB[] = [];
  const weights: number[] = [];
  for (const [key, w] of map) {
    colors.push([(key >>> 16) & 255, (key >>> 8) & 255, key & 255]);
    weights.push(w);
  }
  // 固定初始次序：按 (R,G,B) 字典序，保证与插入/扫描顺序无关。
  const idx = colors.map((_, i) => i);
  idx.sort((a, b) => {
    const ca = colors[a];
    const cb = colors[b];
    return ca[0] - cb[0] || ca[1] - cb[1] || ca[2] - cb[2];
  });
  return {
    colors: idx.map((i) => colors[i]),
    weights: idx.map((i) => weights[i]),
  };
}
