import { AppError } from "./errors.js";
import {
  MAX_COLUMNS,
  MAX_K,
  MAX_PIXELS,
  MAX_ROWS,
  MAX_UNIQUE_COLORS,
  MIN_K,
} from "./limits.js";
import type { Rgb, RgbMatrix } from "./types.js";

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function validateMatrix(value: unknown): RgbMatrix {
  if (!Array.isArray(value)) {
    throw new AppError("INVALID_MATRIX", "matrix 必须是二维数组", 400);
  }
  if (value.length === 0) {
    throw new AppError("EMPTY_MATRIX", "matrix 至少需要一行", 400);
  }
  if (value.length > MAX_ROWS) {
    throw new AppError("TOO_MANY_ROWS", `行数不能超过 ${MAX_ROWS}`, 400, {
      maxRows: MAX_ROWS,
    });
  }

  const matrix: RgbMatrix = [];
  let pixelCount = 0;
  value.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new AppError("INVALID_ROW", `第 ${rowIndex} 行必须是数组`, 400, {
        row: rowIndex,
      });
    }
    if (row.length === 0) {
      throw new AppError("EMPTY_ROW", `第 ${rowIndex} 行不能为空`, 400, {
        row: rowIndex,
      });
    }
    if (row.length > MAX_COLUMNS) {
      throw new AppError(
        "TOO_MANY_COLUMNS",
        `第 ${rowIndex} 行超过 ${MAX_COLUMNS} 列`,
        400,
        { row: rowIndex, maxColumns: MAX_COLUMNS }
      );
    }
    pixelCount += row.length;
    if (pixelCount > MAX_PIXELS) {
      throw new AppError("TOO_MANY_PIXELS", `像素数不能超过 ${MAX_PIXELS}`, 400, {
        maxPixels: MAX_PIXELS,
      });
    }

    const normalizedRow: Rgb[] = [];
    row.forEach((pixel, columnIndex) => {
      if (!Array.isArray(pixel) || pixel.length !== 3) {
        throw new AppError(
          "INVALID_PIXEL",
          `像素 (${rowIndex}, ${columnIndex}) 必须是长度为 3 的 RGB 数组`,
          400,
          { row: rowIndex, column: columnIndex }
        );
      }
      const channelValues = pixel.map((channel, channelIndex) => {
        if (!isFiniteInteger(channel) || channel < 0 || channel > 255) {
          throw new AppError(
            "INVALID_CHANNEL",
            `像素 (${rowIndex}, ${columnIndex}) 的通道 ${channelIndex} 必须是 0 到 255 的整数`,
            400,
            { row: rowIndex, column: columnIndex, channel: channelIndex }
          );
        }
        return channel;
      });
      normalizedRow.push(channelValues as Rgb);
    });
    matrix.push(normalizedRow);
  });

  return matrix;
}

export function validateK(value: unknown): number {
  if (!isFiniteInteger(value)) {
    throw new AppError("INVALID_K", "k 必须是整数", 400);
  }
  if (value < MIN_K || value > MAX_K) {
    throw new AppError(
      "K_OUT_OF_RANGE",
      `k 必须在 ${MIN_K} 到 ${MAX_K} 之间`,
      400,
      { minK: MIN_K, maxK: MAX_K }
    );
  }
  return value;
}

export function assertUniqueColorLimit(count: number): void {
  if (count > MAX_UNIQUE_COLORS) {
    throw new AppError(
      "TOO_MANY_UNIQUE_COLORS",
      `唯一颜色数不能超过 ${MAX_UNIQUE_COLORS}`,
      400,
      { maxUniqueColors: MAX_UNIQUE_COLORS }
    );
  }
}
