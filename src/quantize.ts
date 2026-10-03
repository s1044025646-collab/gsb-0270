import { assertUniqueColorLimit } from "./validation.js";
import { RULE_VERSION } from "./limits.js";
import type {
  BoxRange,
  Channel,
  QuantizationResult,
  Rgb,
  RgbMatrix,
  SplitStep,
  UniqueColor,
} from "./types.js";

interface Box {
  id: number;
  colors: UniqueColor[];
  weight: number;
  range: BoxRange;
  spans: Rgb;
  maxSpan: number;
  maxChannel: Channel;
  splittable: boolean;
}

function rgbKey(rgb: Rgb): string {
  return `${rgb[0]},${rgb[1]},${rgb[2]}`;
}

function compareRgb(a: Rgb, b: Rgb): number {
  for (let channel = 0; channel < 3; channel += 1) {
    if (a[channel] !== b[channel]) return a[channel] - b[channel];
  }
  return 0;
}

function makeRange(colors: UniqueColor[]): BoxRange {
  const min: Rgb = [255, 255, 255];
  const max: Rgb = [0, 0, 0];
  for (const { rgb } of colors) {
    for (let channel = 0; channel < 3; channel += 1) {
      min[channel] = Math.min(min[channel], rgb[channel]);
      max[channel] = Math.max(max[channel], rgb[channel]);
    }
  }
  return { min, max };
}

function describeBox(id: number, colors: UniqueColor[]): Box {
  const range = makeRange(colors);
  const spans: Rgb = [
    range.max[0] - range.min[0],
    range.max[1] - range.min[1],
    range.max[2] - range.min[2],
  ];
  let maxChannel: Channel = 0;
  for (let channel = 1 as Channel; channel <= 2; channel = (channel + 1) as Channel) {
    if (spans[channel] > spans[maxChannel]) maxChannel = channel;
  }
  const weight = colors.reduce((sum, color) => sum + color.count, 0);
  return {
    id,
    colors,
    weight,
    range,
    spans,
    maxSpan: spans[maxChannel],
    maxChannel,
    splittable: colors.some(
      (color) => compareRgb(color.rgb, colors[0].rgb) !== 0
    ),
  };
}

export function histogram(matrix: RgbMatrix): UniqueColor[] {
  const byColor = new Map<string, UniqueColor>();
  for (const row of matrix) {
    for (const rgb of row) {
      const key = rgbKey(rgb);
      const existing = byColor.get(key);
      if (existing) existing.count += 1;
      else byColor.set(key, { rgb: [...rgb] as Rgb, count: 1 });
    }
  }
  return [...byColor.values()].sort((a, b) => compareRgb(a.rgb, b.rgb));
}

function representative(box: Box): Rgb {
  const result = [0, 0, 0] as Rgb;
  for (let channel = 0; channel < 3; channel += 1) {
    let weightedSum = 0;
    for (const color of box.colors) {
      weightedSum += color.rgb[channel] * color.count;
    }
    result[channel] = Math.floor(weightedSum / box.weight + 0.5);
  }
  return result;
}

function compareBoxes(a: Box, b: Box): number {
  if (b.maxSpan !== a.maxSpan) return b.maxSpan - a.maxSpan;
  if (a.maxChannel !== b.maxChannel) return a.maxChannel - b.maxChannel;
  if (b.weight !== a.weight) return b.weight - a.weight;
  const minimumDifference = compareRgb(a.range.min, b.range.min);
  if (minimumDifference !== 0) return minimumDifference;
  return a.id - b.id;
}

function splitBox(box: Box, nextId: number, stepNumber: number): {
  left: Box;
  right: Box;
  record: SplitStep;
} {
  const channel = box.maxChannel;
  const ordered = [...box.colors].sort((a, b) => {
    if (a.rgb[channel] !== b.rgb[channel]) {
      return a.rgb[channel] - b.rgb[channel];
    }
    return compareRgb(a.rgb, b.rgb);
  });

  let cumulative = 0;
  let bestIndex = -1;
  let bestCumulative = 0;
  let bestDistanceToHalf = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    cumulative += ordered[index].count;
    if (ordered[index].rgb[channel] === ordered[index + 1].rgb[channel]) {
      continue;
    }
    const distanceToHalf = Math.abs(cumulative * 2 - box.weight);
    if (distanceToHalf < bestDistanceToHalf) {
      bestDistanceToHalf = distanceToHalf;
      bestIndex = index;
      bestCumulative = cumulative;
    }
  }

  if (bestIndex < 0) {
    throw new Error("内部错误：无法分裂颜色盒");
  }

  const leftColors = ordered.slice(0, bestIndex + 1);
  const rightColors = ordered.slice(bestIndex + 1);
  const left = describeBox(nextId, leftColors);
  const right = describeBox(nextId + 1, rightColors);
  const record: SplitStep = {
    step: stepNumber,
    parentBoxId: box.id,
    channel,
    channelName: (["R", "G", "B"] as const)[channel],
    parentWeight: box.weight,
    parentRange: box.range,
    cutBoundary: {
      belowOrEqual: ordered[bestIndex].rgb[channel],
      aboveOrEqual: ordered[bestIndex + 1].rgb[channel],
    },
    leftCumulativeWeight: bestCumulative,
    distanceToHalf: bestDistanceToHalf,
    leftBoxId: left.id,
    rightBoxId: right.id,
    leftWeight: left.weight,
    rightWeight: right.weight,
    leftRange: left.range,
    rightRange: right.range,
  };
  return { left, right, record };
}

function squaredDistance(a: Rgb, b: Rgb): number {
  return (
    (a[0] - b[0]) ** 2 +
    (a[1] - b[1]) ** 2 +
    (a[2] - b[2]) ** 2
  );
}

export function quantize(
  matrix: RgbMatrix,
  k: number,
  imageId = "memory",
  inputHash = ""
): QuantizationResult {
  const uniqueColors = histogram(matrix);
  assertUniqueColorLimit(uniqueColors.length);
  let boxes = [describeBox(0, uniqueColors)];
  const steps: SplitStep[] = [];
  let nextBoxId = 1;

  while (boxes.length < k) {
    const candidates = boxes.filter((box) => box.splittable).sort(compareBoxes);
    if (candidates.length === 0) break;
    const parent = candidates[0];
    const { left, right, record } = splitBox(parent, nextBoxId, steps.length + 1);
    nextBoxId += 2;
    boxes = boxes.filter((box) => box.id !== parent.id);
    boxes.push(left, right);
    boxes.sort((a, b) => a.id - b.id);
    steps.push(record);
  }

  boxes.sort((a, b) => a.id - b.id);
  const palette = boxes.map(representative);
  const indices: number[][] = [];
  const reconstructed: RgbMatrix = [];
  const usageCounts = new Array<number>(palette.length).fill(0);
  const channelSquareError: Rgb = [0, 0, 0];
  let maxPixelSquareDistance = -1;
  let maxPixelLocation = { row: 0, column: 0 };
  let pixelCount = 0;

  matrix.forEach((row, rowIndex) => {
    const indexRow: number[] = [];
    const reconstructedRow: Rgb[] = [];
    row.forEach((rgb, columnIndex) => {
      pixelCount += 1;
      let selectedIndex = 0;
      let selectedDistance = Number.POSITIVE_INFINITY;
      palette.forEach((candidate, paletteIndex) => {
        const distance = squaredDistance(rgb, candidate);
        if (distance < selectedDistance) {
          selectedDistance = distance;
          selectedIndex = paletteIndex;
        }
      });

      const replacement = palette[selectedIndex];
      indexRow.push(selectedIndex);
      reconstructedRow.push([...replacement] as Rgb);
      usageCounts[selectedIndex] += 1;
      for (let channel = 0; channel < 3; channel += 1) {
        channelSquareError[channel] +=
          (rgb[channel] - replacement[channel]) ** 2;
      }
      if (selectedDistance > maxPixelSquareDistance) {
        maxPixelSquareDistance = selectedDistance;
        maxPixelLocation = { row: rowIndex, column: columnIndex };
      }
    });
    indices.push(indexRow);
    reconstructed.push(reconstructedRow);
  });

  return {
    imageId,
    inputHash,
    indices,
    reconstructed,
    steps,
    report: {
      ruleVersion: RULE_VERSION,
      pixelCount,
      requestedK: k,
      actualColorCount: palette.length,
      palette,
      usageCounts,
      channelSquareError,
      channelMse: [
        channelSquareError[0] / pixelCount,
        channelSquareError[1] / pixelCount,
        channelSquareError[2] / pixelCount,
      ],
      totalSquareError:
        channelSquareError[0] +
        channelSquareError[1] +
        channelSquareError[2],
      maxPixelSquareDistance,
      maxPixelLocation,
    },
  };
}
