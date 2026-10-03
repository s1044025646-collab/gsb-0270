import {
  getImage,
  getQuant,
  listImages,
  parseResult,
  saveQuantization,
  upsertImage,
} from "./db.js";
import { quantize, QuantResult } from "./quantize.js";
import { histogram, parseImage, RGB, validateK } from "./validate.js";
import { QuantError, RULE_VERSION } from "./constants.js";

export interface ImportResponse {
  imageId: number;
  reused: boolean;
  pixelCount: number;
  uniqueColors: number;
  rectangular: boolean;
  height: number;
  width: number | null;
}

export function importImage(input: unknown): ImportResponse {
  const rows = parseImage(input);
  const { colors } = histogram(rows);
  const { imageId, isNew } = upsertImage(rows);
  return {
    imageId,
    reused: !isNew,
    pixelCount: rows.reduce((s, r) => s + r.length, 0),
    uniqueColors: colors.length,
    rectangular: new Set(rows.map((r) => r.length)).size === 1,
    height: rows.length,
    width: new Set(rows.map((r) => r.length)).size === 1 ? rows[0].length : null,
  };
}

function loadMatrix(imageId: number): { rows: RGB[][] } {
  const rec = getImage(imageId);
  if (!rec) throw new QuantError("E_NOT_FOUND", `图像 ${imageId} 不存在`);
  return { rows: JSON.parse(rec.matrix_json) as RGB[][] };
}

export interface QuantResponse extends QuantResult {
  imageId: number;
  k: number;
  ruleVersion: string;
}

export function runQuantize(imageId: number, kInput: unknown): QuantResponse {
  const k = validateK(kInput);
  const { rows } = loadMatrix(imageId);
  const { colors, weights } = histogram(rows);
  const result = quantize(rows, colors, weights, k);
  saveQuantization(imageId, k, result);
  return { imageId, k, ruleVersion: RULE_VERSION, ...result };
}

function storedOrCompute(imageId: number, k: number): QuantResult {
  const row = getQuant(imageId, k);
  if (row) return parseResult(row);
  return runQuantize(imageId, k);
}

export function getSteps(imageId: number, kInput: unknown) {
  const k = validateK(kInput);
  loadMatrix(imageId);
  return { imageId, k, steps: storedOrCompute(imageId, k).steps };
}

export function getPixel(
  imageId: number,
  kInput: unknown,
  row: number,
  col: number
) {
  const k = validateK(kInput);
  const { rows } = loadMatrix(imageId);
  if (!Number.isInteger(row) || !Number.isInteger(col))
    throw new QuantError("E_ARG", "row 与 col 必须为整数");
  if (row < 0 || row >= rows.length)
    throw new QuantError("E_ARG", `row 越界（0..${rows.length - 1}）`);
  if (col < 0 || col >= rows[row].length)
    throw new QuantError(
      "E_ARG",
      `col 越界（该行长度 ${rows[row].length}）`
    );
  const result = storedOrCompute(imageId, k);
  const original = rows[row][col];
  const idx = result.indices[row][col];
  const replacement = result.rebuilt[row][col];
  const dr = original[0] - replacement[0];
  const dg = original[1] - replacement[1];
  const db2 = original[2] - replacement[2];
  return {
    imageId,
    k,
    row,
    col,
    original,
    paletteIndex: idx,
    replacement,
    pixelSqDist: dr * dr + dg * dg + db2 * db2,
  };
}

export function compareK(
  imageId: number,
  k1Input: unknown,
  k2Input: unknown
) {
  const k1 = validateK(k1Input);
  const k2 = validateK(k2Input);
  loadMatrix(imageId);
  const a = storedOrCompute(imageId, k1);
  const b = storedOrCompute(imageId, k2);
  const sumMse = (r: QuantResult) =>
    r.channelMSE[0] + r.channelMSE[1] + r.channelMSE[2];
  return {
    imageId,
    a: {
      k: k1,
      actualColors: a.actualColors,
      channelMSE: a.channelMSE,
      totalMSE: sumMse(a),
      maxPixelSqDist: a.maxPixelSqDist,
      palette: a.palette,
    },
    b: {
      k: k2,
      actualColors: b.actualColors,
      channelMSE: b.channelMSE,
      totalMSE: sumMse(b),
      maxPixelSqDist: b.maxPixelSqDist,
      palette: b.palette,
    },
    totalMseDelta: sumMse(b) - sumMse(a),
    perChannelMseDelta: [
      b.channelMSE[0] - a.channelMSE[0],
      b.channelMSE[1] - a.channelMSE[1],
      b.channelMSE[2] - a.channelMSE[2],
    ],
    maxPixelSqDistDelta: b.maxPixelSqDist - a.maxPixelSqDist,
    note: "启发式量化不保证 K 增大时每项误差严格单调。",
  };
}

export function exportResult(imageId: number, kInput: unknown) {
  const k = validateK(kInput);
  loadMatrix(imageId);
  const result = storedOrCompute(imageId, k);
  return { imageId, k, ...result };
}

export { listImages };
