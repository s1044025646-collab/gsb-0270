import { RGB } from "./validate.js";
import { QuantError } from "./constants.js";

// P6 二进制 PPM，仅支持矩形矩阵。
export function toPPM(rows: RGB[][]): Buffer {
  const widths = new Set(rows.map((r) => r.length));
  if (widths.size !== 1) {
    throw new QuantError(
      "E_SHAPE",
      "非矩形（锯齿）矩阵无法导出 PPM，请使用 JSON 导出"
    );
  }
  const height = rows.length;
  const width = rows[0].length;
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const body = Buffer.alloc(width * height * 3);
  let p = 0;
  for (const row of rows)
    for (const [r, g, b] of row) {
      body[p++] = r;
      body[p++] = g;
      body[p++] = b;
    }
  return Buffer.concat([header, body]);
}
