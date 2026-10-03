# RGB 调色板量化与像素误差解释后端

本地运行的小型彩色图像调色板服务。输入八位 RGB 像素矩阵（JSON），指定颜色数上限
`K`（1..16），生成调色板、逐像素索引、重建矩阵与误差报告。只提供 **HTTP API 与 CLI**，
不含图像编辑界面。

- 语言/运行时：TypeScript + Node.js（建议 Node ≥ 22.5，开发于 Node 25）
- 存储：内置 `node:sqlite`（`DatabaseSync`），数据库文件位于项目内 `data/app.db`
- 不依赖 Docker / WSL / 付费服务 / 外部在线 API，无需原生模块编译
- 不做 ICC 色彩管理、感知重复检索、频域压缩或图像格式编码；仅额外支持演示用 PPM(P6)

## 量化算法（确定性加权 median-cut）

1. 先按 RGB 三元组统计出现次数（频数），颜色盒只记录唯一颜色与权重，不重复计数。
2. 每轮从“可继续分裂”的盒中挑选 **最大通道跨度** 的盒：
   - 跨度平局：取较小盒 id（生成次序更早者）；
   - 同一盒内通道平局：固定取 `R < G < B`。
3. 在最大跨度通道上排序：同值颜色按 `(R,G,B)` 字典序，保证完全确定。
4. 沿排序结果累计像素权重，在累计权重 **第一次达到或超过总权重一半** 的位置切开，
   产生两个非空盒；同一唯一颜色整体归属一侧，不会被拆成两个相同部分。
5. 当盒数达到 `K`，或没有任何盒还能分裂（所有盒只剩一个唯一颜色）时停止。
6. 每盒代表色 = 各通道按像素频数的加权平均，采用 **半数向上（round half up）** 舍入。
7. 最终映射不沿用盒归属：对每个原像素，在 **所有代表色** 中选 RGB 平方距离最小者，
   距离相等取较小调色板索引。
8. 报告实际颜色数、每色使用次数、逐通道平方误差(SSE)、逐通道 MSE、最大单像素平方
   距离，并保留每一步分裂的通道、左右权重、总权重、跨度与父盒范围。

平局规则版本字符串为 `tie-v1`，随结果一并存入数据库。

### 明确假设

- 输入允许 **非矩形（锯齿）二维矩阵**：每行长度可不同；“形状不一致”特指像素不是长度
  3 的整数数组或存在空行。PPM 导出仅支持矩形矩阵，锯齿矩阵请用 JSON 导出。
- 上限：像素总数 ≤ 2,000,000；唯一颜色数 ≤ 200,000；`K` ∈ [1,16]；请求体 ≤ 256MB。
- 输入身份以 **颜色直方图（颜色+频数）** 为准：像素排列不同但直方图相同时视为同一输入，
  产生相同调色板并复用记录；直方图变化则生成新图像版本（新 `imageId`）。
- median-cut 是启发式算法，**不保证最优调色板，也不保证 K 增加时每一项误差严格单调**；
  运行 `demo` 可看到色块图最大单像素平方距离在 K=3→K=4 时反而上升。

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP 服务，默认自动选择空闲端口
npm run demo       # 渐变图与色块图的差异演示
```

`npm start` 启动后会打印实际地址（例如 `http://127.0.0.1:60991`），并把端口写入
`data/server.port`。需要固定端口时设置环境变量 `PORT`：

```powershell
$env:PORT=8080; npm start
```

## HTTP API

所有请求/响应均为 JSON。出错返回 HTTP 400 与 `{ code, message }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/images` | 导入矩阵，body：`{"matrix":[[[r,g,b],...],...]}` |
| GET | `/api/images` | 列出已保存图像（含输入快照） |
| POST | `/api/quantize` | body：`{"imageId":1,"k":4}`，量化并持久化结果 |
| GET | `/api/images/:id/steps?k=4` | 查看分裂步骤 |
| GET | `/api/images/:id/pixels?k=4&row=0&col=1` | 查询某像素原色/替代色/误差 |
| GET | `/api/images/:id/compare?k1=2&k2=4` | 比较两个 K 的报告 |
| GET | `/api/images/:id/export?k=4&format=json` | 导出完整结果（默认 json） |
| GET | `/api/images/:id/export?k=4&format=ppm` | 导出重建图 PPM（限矩形） |
| GET | `/api/images/:id/export?k=4&format=ppm-original` | 导出原图 PPM（限矩形） |

PowerShell 调用示例：

```powershell
$body = '{"matrix":[[[0,0,0],[255,255,255]],[[128,128,128]]]}'
$imp  = Invoke-RestMethod -Uri http://127.0.0.1:8080/api/images -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/quantize" -Method Post -ContentType 'application/json' -Body ('{"imageId":'+$imp.imageId+',"k":2}')
```

## CLI

编译后可使用 `node dist/src/cli.js ...`（`npm link` 后可直接用 `rq`）。

```powershell
node dist/src/cli.js import --file examples/blocks.json
node dist/src/cli.js quantize --image 1 --k 4
node dist/src/cli.js steps --image 1 --k 4
node dist/src/cli.js pixel --image 1 --k 4 --row 0 --col 1
node dist/src/cli.js compare --image 1 --k1 2 --k2 4
node dist/src/cli.js export --image 1 --k 4 --format json --out result.json
node dist/src/cli.js export --image 1 --k 4 --format ppm --out rebuilt.ppm
node dist/src/cli.js demo
```

## 错误码

| code | 含义 |
| --- | --- |
| `E_CHANNEL` | 通道值不是 0..255 的整数 |
| `E_SHAPE` | 像素不是长度 3 的数组、空行、或对锯齿矩阵请求 PPM |
| `E_EMPTY` | 输入矩阵为空 |
| `E_K` | K 不是 1..16 的整数 |
| `E_LIMIT` | 超过像素数 / 唯一颜色数 / 请求体上限 |
| `E_NOT_FOUND` | 图像或资源不存在 / 未知路由 |
| `E_BAD_JSON` | 请求体不是合法 JSON |
| `E_ARG` | CLI 或查询参数缺失/越界 |

非法通道、形状不一致或超限请求会在校验阶段被拒绝，**不会**在数据库中留下成功记录。

## 持久化

- `images`：输入快照（矩阵 JSON）、尺寸、是否矩形、像素数、直方图哈希。
- `quantizations`：每个 `(imageId, k)` 的调色板、索引、重建矩阵与完整报告，以及
  `rule_version`。`(image_id, k)` 唯一。

重启后历史图像与报告可直接读取；再次请求同一 K 时优先返回已存结果（无需重算）。

## 测试

`npm test` 覆盖：单色图、K=1、K 大于唯一颜色数、通道跨度平局、权重明显不均的手算
第一次分裂与代表色、最近色平局、非矩形输入、独立扫描两图核对 SSE/MSE/最大误差、
索引合法与使用次数总和等于像素数、像素重排直方图一致时调色板一致、非法输入不落库，
以及完整 HTTP/持久化（含“重启读取”）流程。

## 已知限制

- 仅支持八位、三通道、无透明通道 RGB；不支持 Alpha、YCbCr 或其他色彩空间。
- 无抖动、无最优（如 k-means/全局最优）保证、无感知色差（CIEDE2000 等）。
- PPM 为无压缩演示格式，锯齿（非矩形）矩阵不能导出 PPM。
- `node:sqlite` 在当前 Node 版本带实验性警告，不影响功能。
