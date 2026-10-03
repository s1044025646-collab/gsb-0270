export type Channel = 0 | 1 | 2;
export type Rgb = [number, number, number];
export type RgbMatrix = Rgb[][];

export interface UniqueColor {
  rgb: Rgb;
  count: number;
}

export interface BoxRange {
  min: Rgb;
  max: Rgb;
}

export interface SplitStep {
  step: number;
  parentBoxId: number;
  channel: Channel;
  channelName: "R" | "G" | "B";
  parentWeight: number;
  parentRange: BoxRange;
  cutBoundary: {
    belowOrEqual: number;
    aboveOrEqual: number;
  };
  leftCumulativeWeight: number;
  distanceToHalf: number;
  leftBoxId: number;
  rightBoxId: number;
  leftWeight: number;
  rightWeight: number;
  leftRange: BoxRange;
  rightRange: BoxRange;
}

export interface QuantizationReport {
  ruleVersion: string;
  pixelCount: number;
  requestedK: number;
  actualColorCount: number;
  palette: Rgb[];
  usageCounts: number[];
  channelSquareError: Rgb;
  channelMse: Rgb;
  totalSquareError: number;
  maxPixelSquareDistance: number;
  maxPixelLocation: {
    row: number;
    column: number;
  };
}

export interface QuantizationResult {
  imageId: string;
  inputHash: string;
  indices: number[][];
  reconstructed: RgbMatrix;
  report: QuantizationReport;
  steps: SplitStep[];
}

export interface StoredResult extends QuantizationResult {
  runId: number;
  k: number;
  imageVersion: number;
}
