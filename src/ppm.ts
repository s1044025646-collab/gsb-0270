import { AppError } from "./errors.js";
import type { RgbMatrix } from "./types.js";

export function matrixToPPM(matrix: RgbMatrix): string {
  if (matrix.length === 0) {
    throw new AppError("EMPTY_MATRIX", "不能导出空矩阵", 400);
  }
  const width = matrix[0].length;
  if (matrix.some((row) => row.length !== width)) {
    throw new AppError(
      "NON_RECTANGULAR_MATRIX",
      "PPM 只支持矩形矩阵；非矩形输入可使用 JSON 导出",
      400
    );
  }

  const lines = ["P3", `${width} ${matrix.length}`, "255"];
  for (const row of matrix) {
    for (const [red, green, blue] of row) {
      lines.push(`${red} ${green} ${blue}`);
    }
  }
  return lines.join("\n") + "\n";
}
