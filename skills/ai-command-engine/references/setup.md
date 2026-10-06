# 连接·坐标·激活（每次操作前必做）

## 1. 健康检查

```bash
curl http://localhost:49720/health   # {ok, extensionConnected, connections:[...]}
```

失败按下面分支排查，别只重试。

### 1a. 后台（指令代理）没跑——AI 自己拉起

`/health` 连接拒绝/超时 = **指令代理没在跑**，AI 必须自己拉起，不要等用户：

```bash
# ① 优先 URL Scheme（非阻塞；装了协议才有效，成败都要继续探测）
cmd /c start "" "ai-command-proxy://"
# ② 10s 后仍不通，直接起 node（按实际存在路径选一）：
node bridge/command-proxy.mjs（仓库目录下）
#    或跑 command-proxy.mjs 所在目录的 launch-proxy.bat
# ③ 轮询验证（最多等 ~15s）：curl http://localhost:49720/health
```

代理就绪后还必须确认扩展在线：`connections` 非空才算链路通。空闲退出是正常行为——所有 EDA 窗口断开 **300s** 后代理自动退出（EDA 开着时扩展每 10s 心跳保活，绝不会掉）；要常驻用 `PROXY_IDLE_MS=0` 环境变量启动。**0.10.71 起插件每 5 分钟自动重试拉起代理**（走 `ai-command-proxy://` 协议，需本机已注册；未注册则退化为提示手动跑 start-services.bat）——代理空闲退出/崩溃后最多 5 分钟自愈，AI 侧等待 `connections` 恢复即可，不必手动起 node。

**重启代理**（连接异常、僵尸实例多、端口怪异）：Windows 运行 `ai-command-proxy://`（地址栏或 `cmd /c start "" "ai-command-proxy://"`)，或再跑 `bridge/launch-proxy.bat`。代理重启后扩展自动重连，不用重启 EDA；**instanceId 全变，必须重新 GET /connections**。

### 1b. 代理在跑但扩展没连上（EDA 侧）

`/health` 通但 `connections` 为空：依次确认 1) EDA 已打开工程窗口；2) 扩展已启用且勾选「允许外部交互」；3) 重启 EDA。0.10.64 起也可让用户在 EDA「AI Command」菜单点「**连接指令代理**」（已连接时点 = 强制重连，代理重启后恢复用它）；「断开指令代理」= **暂停**（0.10.68 起：指令被拒、连接断开、后台空闲自动退出），只有用户点「连接指令代理」能恢复（0.10.69 起恢复需口令，AI/旧模块重放一律无效）。排查串台/多 AI 抢窗口时优先让用户用这两个菜单开关。

## 2. 多窗口选窗（⚠️ 高频踩坑）

EDA 每开一个窗口就有一个扩展实例连代理，可能同时存在多个不同版本/工程的实例。直接发指令会打到错误窗口（串台，实测污染过别的工程）。

```bash
curl http://localhost:49720/connections   # 必须 GET（POST 404）；返回 instanceId/version/connectedAt/selected/info.project
curl -X POST http://localhost:49720/select -H "Content-Type: application/json" -d '{"instanceId":"f82572bc"}'
```

- 只有一个工程在线时代理自动选窗（version 最新、connectedAt 最新），无需手动 /select。
- 多工程共存必须显式 `/select`（或 0.9.3+ 每条请求带顶层 `instanceId`）：按 info.project 匹配，同工程选 version 最新，同版本选 connectedAt 最大。
- 已选目标断开时代理粘滞等待，绝不自动改投其他窗口。
- ⚠️ 重装/升级插件后 instanceId 会变，**必须重新查询**，勿缓存复用。

**多 AI 并行（0.9.3+）**：`/command` 请求体直接带顶层 `instanceId`，逐条独立路由，不经过全局 select——各 AI 各操作各的工程互不抢选。一个窗口同时仍只归一个 AI（窗口内焦点共享）；instanceId 不在线原样拒绝（UNKNOWN_INSTANCE），绝不改投。

## 3. 发送指令

```bash
curl -X POST http://localhost:49720/command -H "Content-Type: application/json" -d '{"cmd":"project.getInfo"}'
```

- 请求体只许 `cmd`（必填）+`params`（可选）+`instanceId`（0.9.3+ 顶层路由，勿放进 params）；不要加未文档化字段。**instanceId 必填、一律不允许省略**（0.10.70 桥端硬校验：省略直接拒绝，与实例数量无关——"单实例可省略"是危险窗口：两个工程都在跑时关掉一个，剩下的会静默接盘别家指令）。省略的历史行为是落到全局选中实例。
- 成功 `{ok, cmd, data, durationMs}`；失败 `{ok:false, error:{message, suggestion}}`——读 message/suggestion 修正后重试。
- 常见瞬断：`503 TARGET_OFFLINE`=窗口瞬断，等 3–5 秒重 select 再发；`editor.openDocument` 偶发致扩展重载断连，重 select 即可。

## 4. 查指令文档

```bash
curl "http://localhost:49720/help?cmd=schematic.placeDevice"   # 单指令
curl http://localhost:49720/help                                # 全部（JSON 含参数/示例）
```

拿不准**先查 /help 再发**，勿凭记忆猜参数。

## 5. 超时、进度心跳与单行道（0.10.49~0.10.51）

长指令——`schematic.batchWire`、`schematic.delete`、`pcb.delete`、`macro`——执行中扩展会**逐条/逐阶段推送进度心跳**（{type:'progress'}），代理每收到一次就重置该指令的 300s 计时器：

- **批量指令只要还在推进就永远不会超时**；超时判定 = 「300s 没有任何进度」，不是总时长。单条指令不上报心跳，仍是 300s 绝对超时（语义不变）。
- 客户端 HTTP 超时**≠任务取消**（EDA 无取消机制）。处置：凭响应里的 `taskId` 用 `task.get` 查询（在册任务先 `task.list`）；或**原样重发同参数指令**——0.10.42 起同指纹任务在跑时只回进度、绝不重复执行。
- ⚠️ 并发纪律（0.10.50 起有硬保护）：官方导线 create 并发容量≈2，并发创建会批量 create failed（实测定案）。代理已把**全部写指令按窗口排成单行道**（一次放行一个，读指令照常并发）——并发打过来自动排队逐个执行，**不会失败，代价是吞吐 ~3s/条**。实机复测：串行/排队执行 batchWire 64 项 64 全过（0.10.50，独立工程）。大批量接线/删除**一次提交一个批量指令**（batchWire 48 项约 60s 有逐条心跳）仍是最优路径。
- 批量失败诊断（0.10.51 起）：`batchWire` 失败项 `error` 保持字符串兼容，另带 `name`/`stack`（截 4000 字符）/`cause`——官方内部 `wire.create` 拒绝也能拿到完整堆栈定位。代理侧单行道事件记 `lane-log-*.jsonl`（代理运行目录，查写指令执行顺序用）；0.10.52 起删除/终扫/健康探针各阶段、探针候选坐标与 ID、清理尝试也写入同一文件（`event:ext-log`），可直接离线对账一次失败的完整时间线。**laneLog 写盘失败会落 `lane-log-error.txt` 旁路**（2026-10-06 实发过一次进程级写盘失效，事件全丢无任何痕迹，靠旁路才定位）——查日志前先确认这两个文件的存在与最新时间戳。

## 6. 坐标与单位（⚠️ 极易混淆）

| 画布 | 单位 | Y 轴 | 有效范围 |
| --- | --- | --- | --- |
| 原理图/符号 | **10mil**（1 单位 = 10mil） | +Y 向上 | 先查图框：A4 约 1170×825 单位，建议留 50 边距 |
| PCB/封装 | **mil**（1mm ≈ 39.37mil） | +Y 向上 | 以板框为准 |

- ⚠️ 两者相差 10 倍，混用会把图元放到十万八千里外。
- 原理图网格吸附：坐标取 **10 的倍数**，否则 DRC 报"网络图元不在原理图格点上"。
- **图纸尺寸查询**：原理图用 `schematic.getPageInfo`（返回 titleBlock 的 `width`/`height`，单位 10mil；A4 = 1170×825，A3 = 1630×1150 左右，以实际读取为准）；PCB 板框尺寸用 `pcb.getPrimitivesInRegion` 扫全板找 Region 图元换算，或截图比对。
- 图框尺寸不是定值：先 `schematic.getPageInfo` 读 `width`/`height` 再放器件。
- ⚠️ 矩形的"左上角"：原理图 +Y 向上，官方矩形锚点是**世界坐标左上点 (minX, maxY)**，即传入的 y 是矩形**上沿**，矩形向下（Y 减小方向）延伸 height。做布局换算时不要把屏幕坐标（向下为正）直接当世界坐标用；`listRects`/`checkRectOverlap`（0.9.4 起）返回归一化 `span:{x1,y1,x2,y2}`，一律用 span 计算。
- **图纸/图框切换（0.9.4 起明确）**：`project.modifyTitleBlock` 只能改当前图框**已存在**的字段（先 `schematic.getPageInfo` 看 titleBlockData 有哪些键）；传不存在的键官方抛 TypeError。**Page Size / Symbol 不能通过该接口切换纸张**，只能让用户在 EDA 界面手动改（改完后 `getPageInfo` 的 width/height 会变，但 size/Symbol 字段可能仍显示旧值——以 width/height 为准）。
- 层：`"top"` / `"bottom"`。

## 7. 文档激活（⚠️ 0.8.2 起有类型守卫）

任何 `schematic.*` / `pcb.*` 指令前，必须先激活对应类型文档：

```json
{ "cmd": "editor.openDocument", "params": { "uuid": "<图页或PCB的uuid>" } }
```

- uuid 从 `project.getInfo` 的文档树获取。
- ⚠️ 焦点不对时指令会明确报错（这是守卫，不是 bug），重新 openDocument 即可。

## 8. 其他编辑器操作

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `editor.listTabs` | 列出全部打开的标签页（排查"操作错画布"） | 无 |
| `editor.screenshot` | 截图（⚠️ 加 `zoomToAll:true` 才是全图，否则只截当前视口；**窗口在后台时截到的是缓存帧**——连截两次字节相同就是没重绘，别拿它做验收，见 pitfalls K9） | `zoomToAll?`, `tabId?` |
| `schematic.exportPng` | **视觉验收首选**（独立渲染管线，窗口后台也出全图；返回**全部原理图页打包成 ZIP** 的 base64——PK 开头，先解 ZIP 再读每页 PNG） | 无 |
| `editor.zoomToAll` | 缩放到全部图元 | `tabId?` |
| `editor.zoomToRegion` | 缩放到指定区域（坐标随文档：原理图 10mil、PCB mil） | `left/right/top/bottom`, `tabId?` |
| `editor.closeDocument` | 关闭指定文档页签 | `uuid?`, `tabId?` |

- **区域截图**（无原生指令，两步 macro 等效）：`zoomToRegion` 对准区域 → `screenshot` 截视口。

```json
{"cmd":"macro","params":{"steps":[
  {"cmd":"editor.zoomToRegion","params":{"left":<x1>,"right":<x2>,"top":<y大>,"bottom":<y小>}},
  {"cmd":"editor.screenshot","params":{}}
]}}
```

（区域语义 left<right、top>bottom，Y 向上取大值；截图结果在 macro 返回 steps[1] 的 base64。）
