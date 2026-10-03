// 全局可配置上限与规则版本。
export const RULE_VERSION = "tie-v1";
export const MIN_K = 1;
export const MAX_K = 16;
// 像素总数上限（含重复）。
export const MAX_PIXELS = 2_000_000;
// 唯一颜色数上限（颜色盒统计规模）。
export const MAX_UNIQUE_COLORS = 200_000;

export interface ApiError {
  code:
    | "E_CHANNEL"
    | "E_SHAPE"
    | "E_LIMIT"
    | "E_K"
    | "E_EMPTY"
    | "E_NOT_FOUND"
    | "E_BAD_JSON"
    | "E_ARG";
  message: string;
}

export class QuantError extends Error {
  code: ApiError["code"];
  constructor(code: ApiError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
