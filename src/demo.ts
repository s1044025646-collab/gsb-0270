import { RGB } from "./validate.js";

// 平滑渐变：R 沿 x、G 沿 y、B 固定，颜色连续。
export function gradient(w: number, h: number): RGB[][] {
  const rows: RGB[][] = [];
  for (let y = 0; y < h; y++) {
    const row: RGB[] = [];
    for (let x = 0; x < w; x++) {
      row.push([
        Math.round((x / (w - 1)) * 255),
        Math.round((y / (h - 1)) * 255),
        96,
      ]);
    }
    rows.push(row);
  }
  return rows;
}

// 色块图：少量高对比纯色块，频数明显不均。
export function colorBlocks(): RGB[][] {
  const palette: RGB[] = [
    [10, 10, 10],
    [240, 20, 20],
    [20, 220, 40],
    [30, 60, 230],
    [235, 230, 40],
  ];
  const counts = [40, 6, 3, 2, 1];
  const rows: RGB[][] = [];
  let pi = 0;
  let remaining = counts[0];
  let row: RGB[] = [];
  const total = counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < total; i++) {
    row.push(palette[pi]);
    remaining--;
    if (remaining === 0) {
      rows.push(row);
      row = [];
      pi++;
      if (pi < counts.length) remaining = counts[pi];
    }
  }
  return rows;
}
