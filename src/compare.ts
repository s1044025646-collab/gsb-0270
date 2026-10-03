import type { StoredResult } from "./types.js";

export function compareRuns(first: StoredResult, second: StoredResult): object {
  return {
    first: {
      runId: first.runId,
      k: first.k,
      actualColorCount: first.report.actualColorCount,
      channelSquareError: first.report.channelSquareError,
      channelMse: first.report.channelMse,
      totalSquareError: first.report.totalSquareError,
      maxPixelSquareDistance: first.report.maxPixelSquareDistance,
    },
    second: {
      runId: second.runId,
      k: second.k,
      actualColorCount: second.report.actualColorCount,
      channelSquareError: second.report.channelSquareError,
      channelMse: second.report.channelMse,
      totalSquareError: second.report.totalSquareError,
      maxPixelSquareDistance: second.report.maxPixelSquareDistance,
    },
    deltaSecondMinusFirst: {
      channelSquareError: second.report.channelSquareError.map(
        (value, index) => value - first.report.channelSquareError[index]
      ),
      channelMse: second.report.channelMse.map(
        (value, index) => value - first.report.channelMse[index]
      ),
      totalSquareError:
        second.report.totalSquareError - first.report.totalSquareError,
      maxPixelSquareDistance:
        second.report.maxPixelSquareDistance -
        first.report.maxPixelSquareDistance,
    },
    note:
      "median-cut 是启发式；K 增大后总量通常不增加，但单通道误差或最大单像素误差可能因最近色重映射而变化。",
  };
}
