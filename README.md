# RGB 调色板量化与像素误差解释后端

这是一个 Windows 本地可运行的小型彩色图像量化服务，只提供 HTTP API 与命令行（CLI），不包含图片编辑界面。输入为无 Alpha 的八位 RGB 像素矩阵或等价 JSON，使用自行实现的确定性加权 median-cut 生成调色板、逐像素索引、重建矩阵和误差报告。

## 功能范围

- 输入 RGB 矩阵，允许非矩形矩阵；不读取、编码或解码 PNG/JPEG 等图片文件。
- `K` 限制为 1 到 16；默认最多 256 行、256 列、65536 个唯一颜色。
- 按 RGB 原始八位数值计算，不做 ICC、色彩空间转换、感知重复检索、抖动、频域压缩或高级色差。
- 保存输入快照、版本、输入哈希、`K`、规则版本、完整量化结果到项目内 SQLite。
- 同一输入和 `K` 重算时读取历史结果；修改输入产生新版本，旧版本报告仍可读取。
- 可导出 JSON，或为矩形输入导出 P3 PPM 演示图片。

## 环境要求

- Windows、PowerShell。
- Node.js 25 或更高版本（项目使用 Node 内置的实验性 `node:sqlite`，无需 C++ 原生编译工具）。
- npm。
- 不需要 Docker、WSL、付费服务或外部在线 API。

## 快速开始

```powershell
npm install
npm run build
npm test
npm start
```

默认监听 `127.0.0.1`，端口号 `0` 表示由系统选择空闲端口，启动时会打印实际地址。SQLite 默认位于 `data/palette.sqlite`。

指定端口或数据库：

```powershell
$env:PORT="3000"
$env:DATABASE_PATH="E:\GSB\0270\A\data\palette.sqlite"
npm start
```

## 输入格式

矩阵为 `[行][列][R,G,B]`，通道必须是 0 到 255 的整数：

```json
[
  [[0, 0, 0], [255, 0, 0]],
  [[0, 255, 0], [0, 0, 255]]
]
```

非矩形矩阵指不同行可有不同列数；API 与 JSON 结果支持它，但 PPM 是矩形栅格格式，因此非矩形输入不能导出 PPM。

## 确定性量化规则

规则版本为 `weighted-median-cut-rgb-v1`。

1. 先统计完全相同 RGB 三元组的出现次数，所有选择和均值都使用像素频数作为权重。
2. 初始盒包含全部唯一颜色。每轮只考虑至少包含两个不同颜色值的盒。
3. 候选盒按以下固定优先级选择：
   - 最大通道跨度较大者优先；
   - 跨度相同按 R、G、B 顺序；
   - 再按较大像素权重；
   - 再按盒最小 RGB 字典序；
   - 最后按盒 ID。
4. 在选中盒的最大通道上排序；通道值相同时按 RGB 字典序。
5. 只允许在相邻不同通道值之间切分，确保同一个唯一颜色不会被拆到两边。
6. 在所有合法切点中选择累计左侧权重最接近总权重一半的切点；距离相同选择左侧权重较小、切点更靠前的位置。
7. 盒数达到 `K` 或没有可分裂盒时停止。
8. 每盒代表色为三通道加权平均，按“半入”舍入：`floor(加权和 / 权重 + 0.5)`。
9. 最终调色板按盒 ID 公开编号。
10. 每个原像素独立扫描全部代表色，选择 RGB 平方距离最小者；距离相等选较小调色板索引。最终映射不直接沿用盒归属。

报告包含实际颜色数、每色使用次数、逐通道平方误差、逐通道 MSE、总平方误差和最大单像素平方距离。分裂步骤保留父盒、通道、权重、切点值、左右盒权重及盒范围。

## HTTP API

所有请求和响应均为 JSON，除 PPM 导出外。非法请求返回统一结构：

```json
{
  "error": {
    "code": "INVALID_CHANNEL",
    "message": "像素 (0, 0) 的通道 0 必须是 0 到 255 的整数"
  }
}
```

- `GET /health`：健康检查。
- `POST /images`：导入或更新输入；请求字段：`matrix`、可选 `imageId`、`name`。
- `GET /images`：列出现有图像最新版本。
- `GET /images/{imageId}?version=1`：读取某版本输入快照。
- `POST /images/{imageId}/quantize?version=1`：对已保存输入量化，请求 `{ "k": 4 }`。
- `POST /quantize`：一次性导入并量化，请求 `{ "matrix": ..., "k": 4, "name?": "..." }`。
- `GET /runs/{runId}`：读取完整结果。
- `GET /runs/{runId}/steps`：读取分裂步骤。
- `GET /runs/{runId}/pixel?row=0&column=0`：查询指定像素原色、替代色和调色板索引。
- `GET /runs/{runId}/export.ppm`：导出重建 PPM（仅矩形矩阵）。
- `POST /compare`：比较两个运行，请求 `{ "firstRunId": 1, "secondRunId": 2 }`。
- `POST /validate`：只校验矩阵和可选 `K`，不保存成功结果。

PowerShell 调用示例：

```powershell
$body = @{
  matrix = @(
    @(@(0, 0, 0), @(255, 0, 0)),
    @(@(0, 255, 0), @(0, 0, 255))
  )
  k = 2
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "http://127.0.0.1:3000/quantize" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

## CLI

```powershell
npm run build

npm run cli -- import --input data/sample.json --id demo --name 演示
npm run cli -- quantize --input data/sample.json --k 4
npm run cli -- quantize --id demo --k 4 --version 1
npm run cli -- images
npm run cli -- run --run 1
npm run cli -- steps --run 1
npm run cli -- pixel --run 1 --row 0 --column 0
npm run cli -- compare --first 1 --second 2
npm run cli -- export --run 1 --output result.json
npm run cli -- export --run 1 --output result.ppm
npm run cli -- demo --kind gradient --k 4
npm run cli -- demo --kind blocks --k 4
npm run cli -- serve --port 3000
```

可用 `--db data/another.sqlite` 指定其他数据库。

## 演示与非单调性

`gradient` 演示是平滑颜色变化，错误通常分散在许多像素上；增加 `K` 通常能明显降低总平方误差，但边界处最大单像素误差不一定每次下降。

`blocks` 演示由少数纯色区域组成；当 `K` 覆盖全部色块时，重建误差可以为零。二者差异说明 median-cut 是按通道范围和像素权重的空间启发式，而不是全局最优调色板。

最终映射还会独立重新选择最近代表色。因此从 `K=n` 增加到 `K=n+1` 后，某些像素可能改投新代表色，导致某个通道误差或最大单像素误差上升；实现不承诺每项误差都严格单调，只提供完整报告与比较结果。

## 错误码

- `INVALID_JSON`：请求体不是合法 JSON 对象。
- `INVALID_MATRIX`、`EMPTY_MATRIX`、`INVALID_ROW`、`EMPTY_ROW`、`INVALID_PIXEL`：形状错误。
- `INVALID_CHANNEL`：通道不是 0 到 255 的整数。
- `TOO_MANY_ROWS`、`TOO_MANY_COLUMNS`、`TOO_MANY_PIXELS`、`TOO_MANY_UNIQUE_COLORS`：超过限制。
- `INVALID_K`、`K_OUT_OF_RANGE`：`K` 非法或超出 1 到 16。
- `IMAGE_NOT_FOUND`、`RUN_NOT_FOUND`、`PIXEL_NOT_FOUND`、`ROUTE_NOT_FOUND`：资源不存在。
- `NON_RECTANGULAR_MATRIX`：非矩形输入请求 PPM 导出。
- `PAYLOAD_TOO_LARGE`：请求体超过 50MB。

非法通道、形状不一致或超限请求会在校验阶段失败，不会写入量化成功记录。

## 自动化测试

```powershell
npm test
```

测试覆盖单色图、`K=1`、`K` 大于唯一颜色数、通道跨度平局、权重明显不均、最近色平局、非矩形输入、独立扫描误差核对、索引合法、使用次数总和、直方图相同但像素顺序变化、SQLite 持久化、历史版本和非法请求不落记录。

## 项目结构

- `src/quantize.ts`：加权 median-cut、代表色、最近色映射和误差统计。
- `src/validation.ts`：参数与限制校验。
- `src/store.ts`：SQLite、输入版本和结果持久化。
- `src/server.ts`：HTTP API。
- `src/cli.ts`：CLI。
- `src/ppm.ts`：P3 PPM 导出。
- `tests/quantize.test.ts`：自动化测试。
