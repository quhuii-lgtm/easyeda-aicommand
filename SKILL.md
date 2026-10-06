---
name: ai-command-engine
description: 通过简易 JSON 指令操作嘉立创 EDA 专业版（EasyEDA Pro）。当用户要求用 AI 操作/检查/绘制嘉立创 EDA 的原理图或 PCB，或查询嘉立创 SMT 可贴装物料时使用本 skill。前置条件：EDA 内已安装并启用 "AI Command Engine" 扩展（勾选「允许外部交互」），且 bridge/command-proxy.mjs 指令代理正在运行（打开 EDA 会自动拉起，关闭 EDA 后 300 秒自动退出（0.10.37 起，PROXY_IDLE_MS 环境变量可调））。
---

# AI Command Engine — 嘉立创 EDA 专业版 AI 操作指令集

你通过 HTTP 向本地代理（默认 `http://localhost:49720`）发送**简易 JSON 指令**操作嘉立创 EDA 专业版。不要自己编造底层 `eda.*` API 代码——所有 EDA 操作都必须走本文档的指令。

本文档包含大量**实测踩坑经验**（标注 ⚠️ 的条目），都是真实操作中付出过代价换来的，请务必遵守。

## 一、连接与选窗（每次脚本开头必做）

### 1. 健康检查

```bash
curl http://localhost:49720/health
```

返回 `{ "ok": true, "extensionConnected": true }` 表示链路可用。若失败，按下面顺序排查。

#### 1a. 后台（指令代理）没跑时——AI 拉起操作

`/health` 连不上（连接拒绝/超时）说明**指令代理没在跑**，AI 必须自己把它拉起来，不要等用户：

```bash
# ① 优先 URL Scheme 拉起（非阻塞，装了协议才有效；成功与否都要继续探测）
cmd /c start "" "ai-command-proxy://"
# ② 若 10 秒后 /health 仍不通，直接前台/后台起 node（按实际存在路径选一）：
node bridge/command-proxy.mjs（仓库目录下）
#    或跑 launch-proxy.bat（command-proxy.mjs 所在目录）
# ③ 轮询验证（最多等 ~15 秒）
curl http://localhost:49720/health
```

代理就绪后还要确认扩展在线：`/health` 的 `connections` 非空（或 `GET /connections`）才算链路通。代理空闲退出是正常行为（所有 EDA 窗口断开 300s 后自动退出，EDA 开着时扩展每 10s 心跳保活绝不会掉）；要常驻可设环境变量 `PROXY_IDLE_MS=0` 启动。

**重启代理**（连接异常、僵尸实例太多、端口行为怪异时）：直接在 Windows 运行 `ai-command-proxy://`（浏览器地址栏或 `cmd /c start "" "ai-command-proxy://"`），或再跑一次 `bridge/launch-proxy.bat`。代理重启后 EDA 扩展会**自动重连**，无需重启 EDA；重连后 instanceId 全变，必须重新 GET /connections 选窗。

#### 1b. 代理在跑但扩展没连上（EDA 侧问题）

`/health` 通但 `extensionConnected:false` / `connections` 为空：代理活着、EDA 扩展没挂上来。依次确认：1) EDA 已打开工程窗口；2) 「设置→扩展」里 AI Command Engine 已启用且勾选「允许外部交互」；3) 仍不行就重启 EDA（激活时会自动重连+尝试自动拉起代理）。**0.10.64 起**也可让用户在 EDA「AI Command」菜单点「连接指令代理」（已连接时点=强制重连，适合代理重启后恢复）；「断开指令代理」=**暂停**（0.10.68 起：指令被拒、连接断开、后台空闲 300s 自动退出），**0.10.69 起恢复需口令，只有用户点菜单能解除**——AI 与其他会话发的恢复声明一律被代理拒绝（排查串台/多 AI 抢窗口时优先让用户用这两个开关）。

### 2. 多窗口选窗（⚠️ 高频踩坑点）

EDA 每开一个窗口就有一个扩展实例连到代理，**可能同时存在多个不同版本、不同工程的实例**。直接发指令会打到错误的窗口（串台，实测发生过污染别的工程）。

```bash
# ① 列出全部实例（必须 GET，POST 会 404）
curl http://localhost:49720/connections
# 返回 connections: [{ instanceId, extension, version, connectedAt, selected,
#   info: { project, tabs: [...] } }]

# ② 选定目标实例（每次脚本都要显式 select，不要假设上次的选择还有效）
curl -X POST http://localhost:49720/select \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "f82572bc"}'
```

选窗规则：

- **0.9.0 起：只有一个工程在线时，代理自动选窗（版本最新、连接最新的实例），无需手动 /select**；
- 多工程共存时代理不自动选（防串台），必须显式 `/select`：按 `info.project`（工程名）匹配目标工程，同工程多实例选 version 最新，同版本选 `connectedAt` 最大；
- 已显式选定的目标断开时代理保持粘滞、绝不自动改投其他窗口，等其重连或手动改选；
- ⚠️ 重装/升级插件后 instanceId 会变，**必须重新查询**，不要缓存复用。

**多 AI 客户端并行（0.9.3 起）**：`/command` 请求体支持直接带 `instanceId`，每条指令独立路由到指定窗口，不经过全局 `/select`——两个 AI 各操作各的工程互不抢选：

```bash
curl -X POST http://localhost:49720/command \
  -H "Content-Type: application/json" \
  -d '{"cmd": "pcb.listComponents", "params": {}, "instanceId": "cf446ce4"}'
```

规则：一个 EDA 窗口同一时间仍只归一个 AI（窗口内焦点是共享状态）；instanceId 不在线时指令原样拒绝（UNKNOWN_INSTANCE），绝不改投。

### 3. 发送指令

```bash
curl -X POST http://localhost:49720/command \
  -H "Content-Type: application/json" \
  -d '{"cmd": "project.getInfo"}'
```

⚠️ 请求体**只允许 `cmd` 和 `params` 两个键**，多带任何键都会被拒。

统一返回格式：

- 成功：`{ "ok": true, "cmd": "...", "data": ..., "durationMs": 12 }`
- 失败：`{ "ok": false, "cmd": "...", "error": { "message": "...", "suggestion": "..." } }` —— 阅读 message 与 suggestion 修正后重试。

⚠️ 常见瞬断：`503 TARGET_OFFLINE` = 目标窗口瞬断，等 3–5 秒重新 `/select` 再发；`editor.openDocument` 偶尔会导致扩展重载断连，同样重 select 重试即可。

### 4. 查指令文档

```bash
curl "http://localhost:49720/help?cmd=schematic.placeDevice"   # 单个指令
curl http://localhost:49720/help                                # 全部指令（JSON，含参数/示例）
```

拿不准参数时**先查 /help 再发**，不要凭记忆猜参数格式。

## 二、坐标与单位（⚠️ 极易混淆）

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

## 三、文档激活（⚠️ 0.8.2 起有类型守卫）

任何 `schematic.*` / `pcb.*` 指令前，必须先激活对应类型文档：

```json
{ "cmd": "editor.openDocument", "params": { "uuid": "<图页或PCB的uuid>" } }
```

- uuid 从 `project.getInfo` 的文档树获取。
- ⚠️ 焦点不对时指令会明确报错（这是守卫，不是 bug），重新 openDocument 即可。
- `editor.listTabs` 可确认当前打开的标签页，排查"操作错了画布"时用。

## 四、指令一览

### 工程与库

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `project.getInfo` | 当前工程信息（含文档树 uuid） | 无 |
| `project.getBoardInfo` | 板子与原理图/PCB 关联状态 | 无 |
| `project.exportFile` | 导出 .epro 工程备份（⚠️ 大改前导一次，官方没有撤销 API） | 无 |
| `project.importFile` | **导入外部文件成新工程**（0.10.35；薄封装官方 importProjectByProjectFile，支持 .PcbDoc/.SchDoc/.epro/.kicad_pcb 等，fileType 按扩展名自动推断；缺省自动取当前团队 uuid 走 New Project，saveToFolderPath 仅离线客户端可用） | `base64`, `fileName`, `fileType?`, `newProjectName?` |
| `project.getDocumentSource` | 读当前文档源数据 JSON（整体分析用，只读） | 无 |
| `editor.openDocument` | 激活指定图页/PCB | `uuid` |
| `editor.listTabs` | 列出全部打开的标签页 | 无 |
| `editor.screenshot` | 截图（⚠️ 加 `"zoomToAll": true` 才是全图，否则只截当前视口） | `zoomToAll?`, `tabId?` |
| `editor.zoomToAll` | 缩放到全部图元 | `tabId?` |
| `library.searchDevice` | 搜索器件库 | `keyword`, `limit?` |
| `library.getDeviceByLcsc` | 按立创编号查器件 | `lcscId` |

### 库器件组装与复用模块（0.10.34 起；全部薄封装官方 API，libraryUuid 缺省自动取个人库）

**自建器件三件套**：符号（原理图图形）+ 封装（PCB 焊盘图形）→ 组装成器件（device）。典型流程：`lib.symbolCreate` → `lib.symbolUpdateSource` 写符号内容 → `lib.footprintCreate` → `lib.footprintUpdateSource` → `lib.deviceCreate` 绑定两者组装。create 类返回 uuid 且插件自动 get 读回；官方返回空一律报错不假装成功。

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `lib.symbolCreate` / `lib.footprintCreate` | 创建空白符号/封装（返回 uuid） | `name`, `description?` |
| `lib.symbolUpdateSource` / `lib.footprintUpdateSource` | 把文档源码写进库符号/封装 | `uuid`, `documentSource` |
| `lib.deviceCreate` | **组装器件**：绑定符号+封装(+3D) | `name`, `symbolUuid`, `footprintUuid?`, `model3DUuid?` |
| `lib.symbolSearch/Get/Copy/Modify/Delete` | 符号管理五件套 | 见 /help |
| `lib.footprintSearch/Get/Copy/Modify/Delete` | 封装管理五件套 | 见 /help |
| `lib.deviceSearch/Get/GetByLcscIds/Copy/Modify/Delete` | 器件管理六件套（modify 可改绑符号/封装） | 见 /help |

**复用模块（CBB）**：一个 CBB=模块工程（原理图页+PCB+模块符号），存系统库/个人库。复用流程：`cbb.listLibraries` → `cbb.search` 找模块 → `cbb.openProject` 打开模块工程拿图页/PCB uuid → 回目标工程 `cbb.placeSchematicPage` + `cbb.placePcb` 一次性铺入原理图与 PCB 布局（含布线）。沉淀自建模块用 `cbb.create` + `cbb.openProject` 打开后往里画。`cbb.placeSymbol` 是层次化设计的模块符号放法。

| 指令 | 说明 |
| --- | --- |
| `cbb.listLibraries` / `cbb.search` / `cbb.get` | 库清单 / 搜索模块 / 模块详情 |
| `cbb.placeSchematicPage` / `cbb.placePcb` | **复用原理图页 / 复用 PCB（含布局布线）** |
| `cbb.placeSymbol` | 放模块符号（层次化设计） |
| `cbb.create` / `cbb.copy` / `cbb.delete` / `cbb.exportFile` | 模块管理 |
| `cbb.openProject` / `cbb.openSymbolInEditor`（0.10.34 补） | 打开模块工程 / 模块符号 |

### 原理图

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.getPageInfo` | 读图页信息与图框尺寸 | `pageUuid?` |
| `schematic.listComponents` | 列出器件 | `allPages?` |
| `schematic.listPins` | 列出器件引脚（编号/名称/坐标） | `primitiveId` |
| `schematic.placeDevice` | 放置器件（默认转入 BOM 和 PCB） | `lcscId`, `x`, `y`, `rotation?` |
| `schematic.connectPin` | 引脚接入网络（0.10.1 起优先用下面的 labelWire/linkWire 语义化指令） | `primitiveId`, `pin`, `net` |
| `schematic.labelWire` | **【0.10.1 推荐·语义化】标签连线：把 1 个引脚接入网络**——自动沿引脚朝向外画短桩 20（防撞自动换向）+ 放同名网络标签（同名防呆+附着验证）。**只接 1 个引脚、必须带网络名**。0.10.2 起**占用预检**：引脚已被同名网络占用直接复用，被异名占用拒绝（防串网），`force:true` 强行合并。**0.10.20 起方向策略（锚点语义实锤后的最终版）：rotation 恒 0、锚点恒在桩末端，全方向一致**——决定性实验实锤：① **附着判定看锚点**，锚点必须落在导线上（端点/中段均附着，离线外 5 单位即浮标）；② rotation 0 文字自锚点向右伸展（锚点=文字左缘）。0.10.18 的「锚点左移文字宽度右缘对齐」电气不成立（锚点离线即浮标、指令超时，验收 2/2 复现）已回滚。附着验证失败快速返回 attached:false（最多 2 次 500ms 重试，不再轮询到超时）。**不要再给标签传 rotation 180/90/270，也不要偏移锚点**。0.10.21 起**短桩统一默认长 60**（能容纳 STATUS_LED 级长网名文字右伸不压器件本体，全方向一致；用户决策：不按网名自适应，长短不一难看）；`stubLen` 参数可显式覆盖（最小钳 20），返回带实际 `stubLen` | `pin`（"U1.7"）, `net`, `color?`, `force?` |
| `schematic.linkWire` | **【0.10.1 推荐·语义化】无名导线：物理连通正好 2 个引脚**——自动 U 形正交走线，横腿深度动态避开现有导线防共线合并。**必须正好 2 个引脚、不允许带名字**（要接网络用 labelWire）。0.10.2 起**占用预检**：两脚已在同一网络直接复用，分属不同网络拒绝（防短接），`force:true` 强行合并 | `pins`（["U1.7","C1.1"]）, `color?`, `jogDir?`, `force?` |
| `schematic.batchWire` | **【推荐·批量】一次提交一批接线项**（label/link 混合），逐条执行逐条收错，最后只做一次网表统一审计——比逐条调 labelWire/linkWire 快得多（审计前自动等待重试：网表导出是缓存快照，任一项未过则等 800ms 重导、最多 5 次取末次结果）。0.10.10 修复审计误报根因：网表 JSON 的位号在 `components[x].props.Designator`（键是 gge 开头的 uuid 不是位号），0.10.9 及以前取错字段导致 audit 恒 pass:false。**只报告不自动修复**：audit 失败项按 `audit.detail` 建议由操作者处置后重跑该项 | `items`（[{type:"label",pin,net,color?},{type:"link",pins,color?,jogDir?}]）, `continueOnError?`, `skipAudit?` |
| `schematic.drawWire` | 画导线（0.9.0 起内部自动拆简单段+智能命名，见 §六.3/§六.4；0.9.8 起支持颜色/线宽/线型） | `points`, `net?`, `color?`, `lineWidth?`, `lineType?` |
| `schematic.modifyWire` | 改导线颜色/线宽/线型/网名（0.9.8 起；支持按网名批量，如 3V3 全网络标红） | `primitiveId` 或 `net`, `color?`, `lineWidth?`, `lineType?`, `newNet?` |
| `schematic.listWires` | 列出导线（读回自查） | `net?` |
| `schematic.setWireNet` | 改导线网络名（0.10.23 起 **modify 后强制读回验证**：全量枚举导线读真实 NET，读回不符判失败并如实返回实际网名，返回带 `readback:{net,verified}`——0.10.22 GPT 现场曾假成功：回显目标网名但保存后实际为空、网表仍在旧网） | `primitiveId`, `net` |
| `schematic.dedupeWireNets` | 一键清理"导线有多个网络名"警告（v2 重建法；0.9.0 起正常画线不会再产生，仅用于清理历史图纸） | 无 |
| `schematic.placeNetLabel` | 放网络标签（**自动验证电气附着**；0.10.7 起未附着**不再自动删除**，返回 `attached:false`+处置建议，由操作者决定删/挪；`noVerify:true` 可跳过验证；0.10.0 起**同名防呆**：附近导线已有该网络名时拒绝放置，`force:true` 强行放；0.10.16 起支持 `rotation` 参数指定文字方向；⚠️ 0.10.18 装机实锤 **rotation 180=上下颠倒反字（不可用）**，正常标签一律 rotation 0，朝左场景用 labelWire 的位置偏移而不是旋转） | `net`, `x`, `y`, `noVerify?`, `force?`, `rotation?` |
| `schematic.listNetLabels` | 列出全部网络标签（0.9.5 起；含附着状态 attached 和颜色——浮空标签就是 DRC"没有连接导线"的来源；⚠️ 0.10.46 起查标签一律用本指令，listLabels 已删） | `net?` |
| `schematic.pruneFloatingLabels` | **【宏】一键清理浮空标签**（附着失败残留、删导线留下的孤儿标签）：扫描全页 attached=false 标签，dryRun 预览（返回每个浮标的世界坐标 worldX/worldY，Y 已翻转成 API 坐标，方便手动框选兜底）或直接删。⚠️ 官方实锤属性图元 delete 接口无效（@internal"不会有任何效果"），删除主通道为**借尸还魂**（建临时导线→modify 浮标 parentId 挂上去→删导线级联带走→文档源码重扫验证）。0.10.12 加固：每条 8s 超时熔断、连续 3 条失败熔断整批（提示会话损坏不保存重开）、`batchSize` 分批（默认 5，批间停 300ms，返回 `batches` 进度，大批浮标多次调用接着删）、时间预算耗尽即停且累积 `diagnostics` 不丢（`unprocessed` 列出未轮到的）、回滚顺序修正（删临时导线失败先把 parentId 改回 `$$root` 再重试删线，避免"持属性无名导线"孤儿）。0.10.13 修正：**每条成败一律以走完后源码重扫读回为准**（官方 modify parentId 有"返回 falsy 但实际生效"的假失败行为，0.10.12 实测 4/4 报"被拒"读回却已删 3 个——读回已删即记成功、不计入连续失败，防熔断误触发）；回滚删线也失败时 diagnostics 明确记录导线 ID+坐标；浮标缺坐标直接 failed 不往 (0,0) 画线；⚠️ **文档源码改写通道默认禁用**（0.10.10 实机事故：写回被官方运行时判"数据格式不对"弹窗拒绝——离线字节级验证通过 ≠ 运行时安全），仅显式 `allowSourceRewrite:true` 才执行且返回带醒目 `warning`，属最后手段，操作前确保工程已保存；全失败时返回 `manualDelete` 世界坐标清单供手动框选删除 | `dryRun?`、`batchSize?`、`allowSourceRewrite?` |
| `schematic.fixNetLabels` | **【宏·全科体检】一条命令修复全部网络标签问题**（0.10.17，替代 fixMirroredLabels；0.10.18 升级）：① 浮空标签（parentId=$$root，DRC 来源）→ 浮标删除通道清除；② 重复标签（同导线同网名 >1 个，或同网名锚点间距 <10）→ 保留位置正确者，其余清除（短桩删桩重放）；③ 方向/反字（rotation 命中 `angle`，默认 180——⚠️ 装机实锤 **rotation 180=上下颠倒反字**，rotation 0 接触点在文字右缘；标签 ATTR 无镜像字段只能按角度识别）→ 原地 rotation→0 读回验证（0.10.18 修复假成功：rotation=0 现在真走 modify+读回），改不动删桩级联+labelWire 重放；④ 位置不对（锚点距所属导线本体 >20=不在线上，点到线段距离口径；**0.10.18 新增导线越位**：导线越过 rotation 0 标签文字右缘 5~40 且戳出端点悬空无引脚→平移标签右缘对齐导线外端）→ moveLabel+读回验证，失败删重放兜底。**dryRun 默认 true 只出四类分类体检报告（每条带 id/net/世界坐标/问题/建议），确认后 dryRun:false 真修**，逐条收错，修完自动 pruneFloatingLabels dryRun 复核剩余 | `dryRun?`, `angle?`, `net?` |
| `schematic.modifyNetLabel` | 改网络标签颜色/位置/改名/**文字方向**（0.9.5 起；可按网名批量改，如 GND 全部深蓝、某网络标签全部 `rotation:0` 扶正；rotation 改完读回验证带 `readback`）。⚠️ **镜像会让文字反字，且 0.10.18 装机实锤 rotation 180 也是上下颠倒反字**——正常标签一律 rotation 0、锚点压在导线上（0.10.20 实锤附着看锚点），不要旋转也不要偏移锚点；官方原理图属性接口不支持 mirror（pro-api-types 无此字段），被镜像/旋转的标签只能转正或删了重放 | `primitiveId` 或 `net`, `color?`, `newNet?`, `x?`, `y?`, `rotation?` |
| `schematic.moveLabel` | 移动网络标签/属性 | `primitiveId`, `x`, `y` |
| `schematic.placeText` | 放注释文本（功能区标签，非电气） | `x`, `y`, `content`, `fontSize?` |
| `schematic.listTexts` / `modifyText` | 文本读回/修改（已实测；listTexts 0.10.46 起返回 `offGrid` 标记——坐标非 10 倍数即"图元不在格点"DRC 来源） | `primitiveId` |
| `schematic.getPrimitivesInRegion` / `getPrimitiveAtPoint` | 区域/点查图元 | ⚠️ 同 PCB 侧：文本类图元可能不被区域查询返回 |
| `schematic.listRects` | 列出全部矩形（0.9.4 起返回归一化 `span:{x1,y1,x2,y2}` 世界包围盒，布局计算一律用 span）——查分区大小 | 无 |
| `schematic.modifyRect` | 改矩形位置/尺寸/样式（y 同样是上沿） | `primitiveId`, `x?`, `y?`, `width?`, `height?` |
| `schematic.checkRectOverlap` | 检查矩形两两重叠（0.9.4 起输出带每个矩形 span 供核对，结果存疑时先对比 span 与源数据） | 无 |
| `schematic.placeRegion` | 功能区一步绘制：矩形框+区标题（0.9.5 起；标题自动放框内左上，返回 span） | `x`, `y`（上沿）, `width`, `height`, `title`, `color?`, `lineType?`, `fontSize?` |
| `schematic.getComponentsInRect` | 查区框内的器件（0.9.7 起；按器件锚点判定，可按 rectId 或显式 span，支持 margin 外扩） | `rectId` 或 `x1,y1,x2,y2`, `margin?` |
| `schematic.repairNet` | **碎网修复宏**（0.9.7 起）：审计网络 → 收养无名残线（adoptWireIds）→ 给缺名导线自动补标签 → 网表前后对比。人工拖动标签致网络断裂后用它收尾 | `net`, `adoptWireIds?`, `dryRun?` |
| `schematic.autoLayout` | **【宏·原理图自动整理】已放好网络的器件重新排整齐+重建连线**（0.10.19）：`designators` 或 `region` 二选一框定器件 → 网表导出连接表（NC/悬空自动跳过，网络内引脚保留全集——link 重建需要外部另一端）→ 网络聚类贪心排序（同网络器件相邻）+ cw32 行列排（横距 60 行距 90，可用 `template` 改）→ 移动器件（官方 modify x/y 读回验证）→ **rewire（默认开）**：删碰旧引脚的导线（级联删标签）+ 清附近浮标 + 连接表转 batchWire 重建（2 引脚非电源 link、≥3/电源类 label，外部引脚标签不动只重建目标侧）→ DRC 聚合。⚠️ 探针实锤**官方移动器件导线/标签不跟随**，rewire 必须全量重建。**dryRun 默认 true 只出方案+连接表预览，确认后 dryRun:false 才动画布** | `designators?` 或 `region?`, `template?`, `rewire?`, `dryRun?` |
| `schematic.buildBlock` | **功能区自动生成宏**（0.9.8 起）：给器件清单+连接表，自动平铺区框（缺省从 0,0 起排、间隙 5、自动估算尺寸；默认黑色虚线框，可 color/lineType 自定义）→ 行列排布器件（cw32-style 模板：横距 60、行距 90、标题框底居中字号 20）→ 按 nets 连线 → 网表+DRC 自查。**0.10.14 起连线层切换到 batchWire 语义化引擎**：2 引脚非电源网络 → link 项（linkWire U 形走线，横腿深度 30 起 +15×8 层动态避让防共线）；≥3 引脚/电源类/显式 style:"label" → 每引脚一个 label 项（labelWire 短桩四方向防撞+同名防呆+假失败 ghost 检查+占用预检+NC 预检）；per-net color 透传；batchWire 逐条收错不中断（NC 引脚逐条拒入 failed）+一次网表统一审计（明细在返回的 `wireAudit`）。引脚按 "ref.引脚号" 引用。**0.10.18 起电源网识别支持全大写后缀**（VDD_T/VOUT_5V 这类也判电源类走标签网；后缀必须全大写数字下划线，小写后缀视为信号不误判） | `components`, `nets`, `region?`, `title?`, `color?`, `skipAudit?` |
| `schematic.moveComponent` | 移动/旋转/镜像器件 | `primitiveId`, `x?`, `y?` |
| `schematic.delete` | 删除图元（0.8.6 起先识别类型+删后读回验证；0.10.9 起兼容单数 `primitiveId` 自动转数组，并能删浮空标签；**0.10.23 加固**：逐项 8s 超时熔断、连续 3 失败熔断整批、`batchSize` 分批默认 10 批间停 300ms、全局预算 100s 耗尽停开新项且累积结果照常返回、`unprocessed` 清单可再次调用续删——GPT 现场 34 组删除曾 25s 假超时、后台继续删 3 分钟、2 个目标残留） | `primitiveIds`（或 `primitiveId`）, `batchSize?` |
| `schematic.runDrc` | 原理图 DRC（0.9.0 起内部自动跑两遍取稳定值） | 无 |
| `schematic.runDrcDetailed` | **DRC 逐条明细**（0.10.23）：官方 `eda.sch_Drc.check(true,false,true)` 返回 `Array<ISCH_DrcError>`（type/rule/net/primitives[{name,designator,primitiveId,sheet}]），primitiveId 可画布定位；若运行时退化为聚合结构则原样透传并标 `aggregated:true` | 无 |
| `schematic.exportNetlist` | 导网表（base64；⚠️ 验证连通性的最终手段） | 无 |
| `schematic.save` | 保存原理图 | 无 |

### PCB

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.listComponents` | 列出器件 | `layer?` |
| `pcb.moveComponent` | 移动/旋转器件（0.8.5 起支持位号） | `primitiveId` 或 `designator`, `x?`, `y?` |
| `pcb.getComponentPads` | 读器件焊盘（编号/网络/坐标/形状）——**验证导入后网络是否正确** | `primitiveId` |
| `pcb.checkPlacement` | 布局间距检查：按焊盘外形算包围盒，报重叠与间距不足（0.9.2 起；DRC 不查本体挤压，布局完成必跑），同时返回各器件外形尺寸 | `minClearance?`, `margin?`, `designators?` |
| `pcb.delete` | 删除图元（0.8.5 起先识别类型+删后读回验证；支持 region/fill/arc；**0.10.23 加固**（与 schematic.delete 同套机制）：逐项 8s 超时熔断、连续 3 失败熔断整批、`batchSize` 分批默认 10、全局预算 100s、`unprocessed` 可续删） | `primitiveIds`, `batchSize?` |
| `pcb.routeTrack` | 走线（折线，自动拆段） | `net`, `points`, `layer?`, `width?` 或 `currentA?` |
| `pcb.placeVia` | 放过孔 | `net`, `x`, `y`, `holeDiameter`, `diameter` |
| `pcb.pourCopper` | 矩形铺铜 | `net`, `layer?`, `x`, `y`, `width`, `height` |
| `pcb.listLines` / `listVias` / `listPours` | 读回自查 | `net?` 等 |
| `pcb.listNets` | 列出全部网络 | 无 |
| `pcb.getPrimitivesInRegion` | 区域扫描图元类型 | `left/right/top/bottom`（mil） |
| `pcb.importChanges` | 从原理图导入变更（⚠️ 会弹对话框，需用户点应用） | `schematicUuid?` |
| `pcb.drawOutline` | 画矩形板框（⚠️ 0.8.5 起 x,y 为**左下角**；旧版语义错乱见 §六.7） | `x`, `y`, `width`, `height`（mil） |
| `pcb.runDrc` | DRC 检查 | 无 |
| `pcb.runDrcDetailed` | **DRC 逐条明细**（0.10.23）：官方 `eda.pcb_Drc.check(true,false,true)` 详细模式返回全部违规项（含描述，类型 `Array<any>`）；本指令对每项归一化提取 type/rule/message/net/primitiveId/x/y 常见字段，原始项保留在 `raw`，并按级别聚合计数 fatalCount/warnCount | 无 |
| `pcb.groupBySchematicRegions` | **【宏·0.10.22】按原理图 RECT 区框把 PCB 器件聚合分组**（走文档源码 append-only 写入，不用实时 API）：读全部图页区框（`pageUuid` 可限定），归属判定位号文本位置优先、多框取面积最小；组内位号前缀分行（U>R>C>L>D>Q>其他）+贪心避让，组间 shelf packing **强制收进板框内**（摆不下报错列出溢出量，不静默摆出板外）；组边框+组名文本生成 `spg_` 前缀文档层（layerId=13）图元，重复执行先墓碑清场。五步管线：版本化备份（代理落盘 `backups/<工程>/<时间戳>.txt` 保留最近 5 份，代理不可用回退扩展存储单槽）→ 写源码 → 回读逐器件比对（容差 0.001）→ 失败自动整份恢复 → 全过才保存。**dryRun 默认 true 只出分组预览，确认后 dryRun:false 才动 PCB**。⚠️ 调用前焦点须在 PCB；执行中会短暂切焦点读原理图页再切回 | `pageUuid?`, `dryRun?`, `origin?`, `boardSize?`, `groupGap?` |
| `pcb.sourceRollback` | PCB 源码备份列出/恢复（0.10.22）：`list:true` 列当前 PCB 全部备份；否则恢复（默认最近一份，或按 `backupId` 指定）。恢复前校验备份 pcbUuid 与当前 PCB 匹配（不匹配拒绝），恢复后回读校验并保存 | `list?`, `backupId?` |
| `pcb.save` | 保存 PCB（⚠️ 无修改时官方返回 false，**不代表失败**） | 无 |

<details>
<summary>0.8.1 批次补充指令（图元读改 / 层叠 / 等长组 / 实时 DRC，实测注意点）</summary>

| 指令 | 说明 | 实测注意 |
| --- | --- | --- |
| `pcb.modifyLine` / `modifyVia` / `modifyPour` / `modifyString` | 改线/孔/铺铜/丝印（读回验证有效） | 均已实测 |
| `pcb.placeString` / `listStrings` | 丝印文字放/读 | 已实测 |
| `pcb.getPrimitivesInRegion` / `getPrimitiveAtPoint` | 区域/点查图元 | ⚠️ **查不到丝印文字（String）**，只返回铜类图元（Line/Via/Pad/Region 等）；区域语义 left<right、top>bottom |
| `pcb.importAutoRouteSes` | SES 回灌（外部自动布线闭环） | 垃圾数据会优雅报错 |
| `pcb.listStackingConfigs` / `getStackingConfig` / `save/apply/rename/delete/setDefaultStackingConfig` | 层叠配置管理 | ⚠️ 双层板实测 list 为空、get 返回 null（官方行为，非故障） |
| `pcb.addCustomLayer` / `removeCustomLayer` / `modifyLayer` / `setPcbType` | 自定义层与板型 | ⚠️ **加/删层会触发文档重载、焦点丢失**，后续 pcb.* 指令可能报"焦点不是PCB"——需重新 editor.openDocument（0.9.3 起守卫会尝试自愈） |
| `pcb.createEqualLengthGroup` / `list/rename/delete` / `addNet/removeNet` | 等长组管理 | 6 条全链路实测通过 |
| `pcb.startRealTimeDrc` / `stopRealTimeDrc` / `getRealTimeDrcStatus` | 实时 DRC 开关 | ⚠️ 官方 @beta 接口，**需要 EDA v4.2+**；低版本 start 返回 done:false、status 恒 false（非插件 bug） |

</details>

### PCB 自动布线（0.10.0 起，FreeRouting 闭环）

⚠️ **标准工艺流程（电源先行）**：① AI 用 `pcb.routeTrack`/`pourCopper` 按知识库规则布完电源主路径 → ② `pcb.setNetLock` 锁定电源网络（回灌会清除全部**未锁定**走线/过孔，不锁就被冲掉）→ ③ `pcb.autoRouteStart` 启动 → ④ `pcb.autoRouteStatus` 轮询（完成自动回灌+DRC）→ ⑤ AI 审查走线，不合理的局部 `pcb.delete`+`routeTrack` 重修。

前置：本地 FreeRouting V2.2.3+ 服务运行（端口 37864），可跑 `bridge/start-freerouting.bat` 一键拉起。

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.setNetLock` | 锁定/解锁指定网络的全部走线/过孔/圆弧（布线前保护电源线） | `net` 或 `nets`, `locked?` |
| `pcb.autoRouteStart` | 启动自动布线（导出 DSN→FreeRouting 服务→启动任务） | `maxPasses?`, `viaCosts?`, `maxThreads?`, `skipDrc?` |
| `pcb.autoRouteStatus` | 查进度；COMPLETED 时自动清未锁定走线+回灌 SES+DRC，返回统计 | `jobId?`, `noImport?` |
| `pcb.autoRouteStop` | 停止任务（保留当前结果） | `jobId?` |

### 知识库

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `knowledge.query` | 检索布线规则/经验 | `query`, `limit?` |
| `knowledge.listRules` | 列出全部规则主题 | 无 |
| `knowledge.widthForCurrent` | 载流→线宽换算 | `currentA` |

### 嘉立创开放平台（代理本地执行，无需 EDA 在线）

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `smt.queryComponent` | 查询 SMT 可贴装物料 | `queryString`, `pageNum?`, `pageSize?` |

- 返回 `components[].code` 即立创编号，可直接用于 `schematic.placeDevice`。
- 首次使用：让用户打开 `http://127.0.0.1:49720/smt` 填 appId / accessKey / secretKey（存于 `bridge/jlc-credentials.json`，升级不丢失）；该页面也支持人工查询。

### 宏指令（组合多个指令）

`cmd` 为 `macro`，`steps` 按序执行；步骤设 `id` 后，后续步骤可用 `$id` 或 `$id.字段` 引用其结果。**返回结果的键是 `steps`**（⚠️ 不是 result/data，解析时注意）。

```json
{
	"cmd": "macro",
	"params": {
		"steps": [
			{ "id": "u1", "cmd": "schematic.placeDevice", "params": { "lcscId": "C25804", "x": 200, "y": 200 } },
			{ "cmd": "schematic.connectPin", "params": { "primitiveId": "$u1.primitiveId", "pin": "VDD", "net": "3V3" } },
			{ "cmd": "schematic.save" }
		]
	}
}
```

任一步失败即中断（`stopOnError: false` 可关闭）。

## 五、标准工作流程

### 画原理图

1. `/connections` 选窗 → `editor.openDocument` 激活图页 → `schematic.getPageInfo` 读图框。
2. `schematic.placeDevice` 按功能区分块放器件（参考成熟板子的布局风格：同功能器件聚拢，区内部真导线连接）。
3. **连线优先用 0.10.1 语义化指令**：单引脚接网络用 `schematic.labelWire`（短桩+标签一条命令，自动防撞换向、同名防呆、附着验证）；两引脚互连用 `schematic.linkWire`（无名 U 形导线，自动错层防共线合并）。⚠️ 两条指令从源头上互斥（labelWire 必须带名只接 1 脚，linkWire 无名必须 2 脚），可根治"短线上已有网络名又叠放同名标签"这类重复标签事故。**一批连线（≥3 条）一律用 0.10.8 的 `schematic.batchWire` 一次提交**：逐条收错+一次网表统一审计，比逐条调用快数倍。底层 `connectPin`/`drawWire`/`placeNetLabel` 仍在，特殊场景（母排、多点直连、批量改色）再用。
4. **读回自查**：`schematic.listWires` + `schematic.exportNetlist` 审计每个网络的引脚成员（别信"画了就通"）。
5. `schematic.runDrc`（0.9.0 起自动取稳定值）→ 致命错误清零；历史图纸若出现"多个网络名"警告跑 `schematic.dedupeWireNets`。
6. `schematic.save`。

### 元器件摆放规范（放器件/整理/审图必查，2026-10-06 用户增订）

1. **解耦电容对脚专配**——哪颗电容属于哪个引脚就直接短桩接在该引脚上，不与其他引脚的电容并联混接；整排电容全并在电源总线上是典型违规。
2. **输入/输出电容就近同序**——芯片要求就近放置的输入/输出电容，原理图上也按同样顺序就近摆，与引脚一一对应。
3. **同引脚可并联**——归属同一引脚的多个电容允许并联。
4. **无孤立器件**——每个元件至少一脚实质入网；指示器件按信号本意接线（LED 接控制脚而非惯性接电源）。
5. **走线不进器件本体**——导线（含干线母线）与符号身体/边框留间距；网络标签方向随导线（横线横标、竖线竖标），不压引脚、不重叠。
6. 详细验收清单与持续改进闭环见 `eda-schematic-layout` 技能 §1–§2。

### 原理图转 PCB

1. ⚠️ **原理图有致命 DRC 错误时 `pcb.importChanges` 静默返回 false 无任何提示**——导入前必须清到 0 致命。
2. `pcb.importChanges` 会弹对话框，**提示用户点「应用修改」**，AI 无法代点。
3. 导入后 `pcb.listComponents` + 逐器件 `pcb.getComponentPads` 比对焊盘网络与网表是否一致。
4. 布局：`pcb.moveComponent`（可用位号）；⚠️ **DRC 只查铜皮间距，不查元件本体/丝印重叠**——摆完后跑 `pcb.checkPlacement`（0.9.2 起）自动算包围盒查重叠/间距；连接器、电感等本体大于焊盘的器件加 `margin`（10~30mil）近似本体。DRC 过了不代表没挤压。
5. 布线：`pcb.routeTrack`（大电流节点用宽线/铺铜，先 `knowledge.widthForCurrent`）、`pcb.placeVia`、`pcb.pourCopper`（GND 整面）。
6. `pcb.runDrc` → 报告违规 → `pcb.save`。

## 六、⚠️ 踩坑实录（全是实测教训，务必读完）

### 1. 官方 API 的"假成功"

- 官方各 `delete()` 对**类型不匹配甚至不存在**的 ID 也可能返回 true。插件 0.8.5/0.8.6 起 `pcb.delete`/`schematic.delete` 会先识别真实类型再删、删后读回验证，返回 `{ deleted, failed, deletedBy }` 逐 ID 报告——**务必检查 failed 数组**。
- ⚠️ **setWireNet 假成功案例（0.10.22 GPT 现场实锤，0.10.23 修复）**：N 驱动页 U4.5 短线调 `schematic.setWireNet`，modify 返回非空、插件回显目标网名 N_VREF 报成功，但**保存后导线网名实际为空、网表里 U4.5 仍在旧网 $3N39**——modify 实际没生效/没保存住，只信返回值就是假成功。0.10.23 起 `setWireNet`/`modifyWire(newNet)`/`setAttribute`/`moveComponent`/`moveLabel`/`modifyText`/`modifyNetLabel(newNet)`/`drawWire(命名段)` 全部在 modify/create 后读回验证（枚举全量图元核对真实状态），读回不符判失败并如实返回实际值（返回带 `readback` 字段）。**铁律重申：官方返回值不可信，成败以读回为准。**
- ⚠️ **批量 delete 失控案例（0.10.22 GPT 现场实锤，0.10.23 加固）**：34 组 `schematic.delete` 首步 25s 超时返回失败，但客户端处理器**后台继续删**，尾项 3 分钟后才消失，且 2 个目标被循环越过残留。0.10.23 起 delete 类指令照抄 pruneFloatingLabels 0.10.12 加固模式：逐项 8s 超时熔断、连续 3 失败熔断整批、`batchSize` 分批（默认 10，批间停 300ms）、全局预算 100s（耗尽停开新项、累积结果照常返回）、`unprocessed` 清单可续删；两侧超时表同步放宽（扩展 140s / 代理 150s）。**大批删除保持默认分批多次调用，看 `batches`/`unprocessed` 续删，不要一次调大 batchSize 硬跑。** ⚠️ **超时假失败再实锤（0.10.24 装机验收）**：4 个报「单项超时失败」的导线实际被官方后台删掉了，failed 口径偏保守。0.10.25 起 delete 整批结束（含熔断/预算耗尽路径）后做**终扫对账**——重新全量枚举（原理图侧含浮标源码扫描补判，防止浮标被误判已删），已不存在的「失败」项挪入 `deleted` 并在 `reconciled` 注明「超时返回但后台已删除，经终扫确认」；终扫仍存在的保留 `failed` 并附 `failedNote` 续删提示。
- ⚠️ **多字段合并修改整体失效（P10，0.10.21 GPT 现场实锤，0.10.24 修复）**：`schematic.modifyNetLabel` 一次传「位置+旋转」（`x/y/rotation` 同传）→ 返回 modified 空、failed 含原 ID、读回全旧值，**实际什么都没改**；拆成「只转 rotation」「只移 x/y」两个单步分别调用都成功并读回正确。结论：**官方 modify 对多字段合并修改不接受或部分失效**。0.10.24 起全部多字段修改指令在插件内部**原子化拆分**——每字段/每类别独立步骤顺序执行 + 逐步读回验证，读回不符即从 modified 挪到 failed（带字段与实际值）：`modifyNetLabel`（rotation 走 applyLabelRotation → 位置 x/y → 改名 value → 颜色 color）、`modifyText`（content/位置/fontSize/textColor/rotation 分步）、`modifyRect`（位置/尺寸/样式分步）、`schematic.moveComponent`（位置/旋转/镜像分步）、`modifyWire`（样式与改名分步）、`pcb.moveComponent`/`pcb.modifyLine`/`pcb.modifyVia`/`pcb.modifyPour`/`pcb.modifyString`（全部改分步 + 新增读回验证，此前 PCB 侧只信返回值）。**调用侧不再需要自己拆步，多字段照传即可；但批量命名偶发失效（P01 第二例：30 条中 1 条空网名）必须看 batchWire 返回的 failed——0.10.24 起网表审计未通过的项即使执行阶段 ok 也会改写进 failed（带实际网名），不再静默进成功计数。**
- 官方单对象 `get()` 对已删除 ID **永久返回缓存旧对象**（不是延迟，等多久都查得到）。插件删后验证用的是全量列表接口，你自己写扩展时注意别用 `get()` 做存在性判断。
- ⚠️ `getAll(net)` 的网络过滤参数**运行时不可靠**（0.9.1 实测：原理图导线传 net 过滤返回空数组）。插件内部已改为全量取回 + `getState_Net()` 手动过滤；你自己写扩展时同样别依赖这个过滤参数。

### 2. 官方没有撤销（undo）API

删错无法挽回。防护措施（0.9.0 起大部分已自动化）：

- **代理自动备份**：`schematic.delete` / `pcb.delete` / `schematic.dedupeWireNets` / 删除图页、PCB、板子等破坏性指令执行前，代理自动导出 .epro 到 `bridge/backups/`（60 秒内只备一次，返回结果带 `backup` 字段）；
- 大改前也可手动 `project.exportFile` 导出备份；
- 删除类操作前先用列表类指令确认目标 ID；
- 实在搞坏了：EDA 自动备份在 `文档\LCEDA-Pro\online-projects-backup\<工程名>\`，epru 是 NDJSON 文本可解析（WIRE 是容器、LINE 记录存 `lineGroup` 归属、NET 是挂 ATTR 记录），可从中恢复几何数据；
- 让用户关掉标签页时选「不保存」可回滚未保存的内存改动（⚠️ 但实测**重开标签页不一定回滚**，内存模型可能仍在，别把它当可靠手段）。

### 3. 原理图导线命名与"多个网络名"警告（0.9.0 起已从源头消除）

- 根因：每根导线可挂多个 NET 属性。同一网络的多段分别命名后段合并，属性叠加 → DRC 报"导线有多个网络名: X、X、X"；官方 `modify(net)` 删不掉重复属性。
- **0.9.0 起 `drawWire`/`connectPin` 智能命名**：命名前插件先查该网络是否已在页面存在（命名导线或网络标签），已存在则自动画无名段——正常画线不会再产生此警告，无需特别规避。
- 历史图纸的存量警告用 `schematic.dedupeWireNets`（v2 重建法：拆段→无名重画→统一命名）一键清理。
- ⚠️ **导线持有的 Name/NET 属性删不掉**（0.9.6 实测：官方无类级删除接口，实例 `delete()` 对导线附属属性也无效，属性随父导线存亡）。要消除一根导线上的多余/错误网络名，唯一可靠办法是**删线重画**：`schematic.listWires` 读回该导线的全部线段几何数组留存 → `schematic.delete` 删掉 → `drawWire` 按原几何重画（需要命名则带 net 参数一次命名）→ `exportNetlist` 审计确认网络成员恢复。这也是修复"网络被人工操作打碎"的通用收尾手段。

- ⚠️ **浮空标签（parentId=$$root）删除的官方盲区**（0.10.10 根因实锤）：① `sch_PrimitiveAttribute.getAll/getAllPrimitiveId` 不枚举浮标；② **属性图元官方就不支持删除**——pro-api-types 里 `SCH_PrimitiveAttribute.delete` 标注 `@internal`「属性图元不支持删除，本接口调用将不会有任何效果」，`ISCH_PrimitiveAttribute` 实例上根本没有 delete 方法；属性只能随父图元存亡（删导线会级联带走附着标签，已实测确认），浮标父图元是 $$root 无父可删；③ `modify(id, …)` 按 ID 可以改浮标（坐标已读回验证）；④ 删除主通道是**借尸还魂**（建临时短导线 → modify 改浮标 parentId 挂上去 → 删导线级联带走 → 文档源码重扫读回验证；modify 后标签可能仍显示在画布，成败以删导线后的源码重扫为准；任一步失败回滚临时导线并如实报 `diagnostics`）。⚠️ **文档源码改写通道已被官方运行时实锤判死（0.10.10 实机事故，0.10.11 起默认禁用）**：离线字节级切除验证正确（17 浮标 34 段全切除、其余字节完好），但 `setDocumentSource` 写回时官方有额外运行时格式校验，直接弹"数据格式不对"错误框拒绝——**离线验证通过 ≠ 运行时安全**。该通道仅显式 `allowSourceRewrite:true` 才执行（最后手段），返回带醒目 `warning`，操作前必须确保工程已保存（那次事故靠工程未保存重开才幸免）。`pruneFloatingLabels` 流程：实例/类级 delete 兜底（无害，官方实锤无效）→ 借尸还魂主通道 →（可选）源码改写；全失败时返回 `manualDelete`（世界坐标，Y 已翻转）供手动框选删除。
- ⚠️ **大批量删浮标必须分多次跑 + 会话损坏迹象与处置**（0.10.11 实机事故，0.10.12 加固）：借尸还魂通道真实删掉了 8 个浮标（删除原理成立），但删到第 9 个时指令整体超时，**超时后整个 EDA 会话的创建类 API 全线失效**（空白区 drawWire/placeText/placeNetLabel 全败，读类正常，重激活/zoomToAll/等待均不自愈——疑似官方弹模态框或卡导线绘制模式），还留下一条删不掉的"持属性无名导线"孤儿（借尸还魂半途状态）。教训与规则：
  1. **大批量删浮标分多次跑**：保持默认 `batchSize:5`，每批之间插件自动停 300ms；删完一批看返回的 `batches`/`unprocessed`，确认会话健康再调下一次，不要一次调大 batchSize 硬跑。
  2. **会话损坏迹象**：创建类指令（drawWire/placeNetLabel/placeText/placeDevice/labelWire/linkWire）突然全部 `create failed!` 或超时，而读类指令正常——即判定会话已损坏。
  3. **处置**：不要继续在坏会话里空跑（插件连续 3 条失败会自动熔断）；**不保存工程直接关闭页面重开**即可还原电路（浮标会回来，但页面无损），重开后分批继续删。
  4. 0.10.12 起每条借尸还魂包 8s 超时熔断，超时也照常返回已累积的 `diagnostics`（部分结果不丢）；删临时导线失败会先把浮标 parentId 改回 `$$root` 再重试删线，不再留下持属性孤儿线。
  5. ⚠️ **官方 `sch_PrimitiveAttribute.modify` 有假失败行为**（0.10.12 终验实锤，与 createNetLabel 假失败同款）：modify parentId 返回 falsy 但实际已生效——4/4 报"被拒"的浮标读回已删 3 个。因此 0.10.13 起每条成败**一律以走完后源码重扫读回为准**，不信 modify/delete 返回值；读回已删即记成功、不计入连续失败（否则会误触发熔断、把健康会话误判为损坏）。
- ⚠️ **NC（未连接）引脚官方禁止接线**：`labelWire`/`linkWire` 对带 NC 标识（`getState_NoConnected()`）的引脚画短桩会被官方直接抛原始 `create failed!`；0.10.9 起插件预检并给出中文报错"该引脚为 NC 未连接引脚，官方禁止接线"。
- ⚠️ **网络标签 rotation 180 = 上下颠倒反字（0.10.18 装机目测实锤，悬案结案）**：rotation 0 标签电气接触点在**文字右缘**（导线从右侧接上、姿态完美）。0.10.16 那套"桩向左用 rotation 180 朝外"是错的。**0.10.20 决定性实验进一步实锤：附着判定看锚点（锚点必须在导线上，离线外 5 单位即浮标），rotation 0 文字自锚点向右伸展**——0.10.18 的「锚点左移右缘对齐」因此电气不成立（浮标+超时）已回滚；最终策略 **rotation 恒 0 + 锚点恒在桩末端**（全方向一致，文字右伸压过短桩是官方标准形态，12路 人工页即如此）。文字宽度估算式 **4.4×字符数+5 单位**（exportPng 像素标定三样本：GND 17.4、STATUS_LED 46、USART2_RTS 47.1，1.955px/单位；数字/下划线略宽，宁高估）——用于 labelWire 桩长自适应（桩长=max(20,宽+14)）与 fixNetLabels 越位几何测量。
- ⚠️ **官方 modify 既有假失败也有假成功**（0.10.17 验收实锤）：`applyLabelRotation` 旧代码对 rotation=0 直接返回 0 什么都没改，fixNetLabels 原地转正因此报 fixed 但读回仍 180；0.10.18 起 rotation=0 也真走 modify+读回。凡涉及图元修改，成败一律以读回/源码重扫为准。

### 4. drawWire 的限制（0.9.0 起已内部吸收）

- ~~多分支折线一次画被拒~~、~~斜线伪段~~、~~重复段~~：0.9.0 起插件内部自动拆成简单两点段（去重、跳过伪段），AI 直接传折点数组即可，官方会自动合并相连段。
- `points` 支持 `[[x,y],...]` 和 `[{x,y},...]` 两种格式。

### 5. connectPin 的正确姿势

- 它画一条从「引脚尖端外 30」到引脚原点的导线——**端点精确落在引脚原点即连通**。
- ⚠️ 不要让导线探入器件本体侧：端点落在引脚线中段会产生 T 形结点红点 + "单网络"警告。
- ⚠️ EDA 只认与引脚线段有非零重叠的导线；端点对端点重合、网络标识直贴引脚都会报致命错误"引脚端点重叠且未连接"。

### 6. 网络标签（NetLabel）的电气附着（0.9.0 起自动验证）

- ⚠️ 标签**压在线体上会被官方拒绝创建**（返回空）；要放在导线边上（锚点贴近线段，文字自动让开）。
- ⚠️ 实测：锚点稍微偏离线体能创建成功但**电气上不一定附着**（网表里网络名丢失）；`moveLabel` 移动标签**不会重新计算附着**。
- **0.9.0 起 `placeNetLabel` 放置后自动验证附着**：未附着会**自动删除标签并报错**（附着的可靠位置是导线自由端/短桩末端），不会再出现"看着有标签其实没生效"。0.9.6 起锚点压线被拒时自动 ±2 微偏重试（实测压线常被拒、偏移 2 即成功且附着正常）。
- ⚠️ **人工在 EDA 界面拖动网络标签会丢失附着甚至删除标签**（实测拖一个 J3 的 VOUT 标签，连带丢 2 个 VOUT + 1 个 LED 标签、网络被打碎）。移动标签后必须用 `schematic.listNetLabels` 检查 attached 并用网表审计网络成员是否完整。
- ⚠️ **不要在已带网络名的导线上再放同名标签**（0.10.0 起插件自动拒绝）：导线命名属性和标签都是导线持有的属性，重复会产生"多个网络名"警告且删不掉。给导线命名前先 `schematic.listNetLabels`/`listWires` 确认它还没有名字；已经放重了的用 `schematic.dedupeWireNets` 清理。
- ⚠️ **"双标签/幽灵浮标"根因（0.10.10 实锤修复）**：`createNetLabel` 假失败（返回空但标签已创建并附着）后，若复查逻辑按"导线网络名"过滤找标签，会撞上**导线网名异步传播**的竞态——标签已挂上导线但导线还没改名，复查漏判 → ±2 微偏重试画出第二个标签，且第二个往往是浮空的。教训两条：① 假失败复查要按**属性值+坐标**匹配（属性随创建即时可查），不要依赖导线 `getState_Net`；② **文档源码与 API 的 Y 轴符号相反**（API y=-600 ↔ 源码 y=+600），凡拿 API 坐标去源码扫描结果里比对（或反向），必须翻转 Y 符号，否则永远匹配不上。0.10.10 起 `findGhostNetLabel` 已改：枚举全部导线属性按值匹配 + 300ms×3 轮短重试，双标签从源头杜绝。
- **碎网修复标准流程**（标签丢失导致同一网络断成几截时）：① `exportNetlist` 审计，确认哪个网络成员残缺、期望成员有哪些；② 缺标签的导线用 `placeNetLabel` 补同名标签（锚点取该导线线段中点，0.9.6 起压线自动 ±2 微偏重试，直接发线段上的点即可）；③ 若导线上有删不掉的重复/错误属性（见第 3 节），改用删线重画；④ 补完再跑一次网表审计 + `runDrc` 双确认，缺一不可。
- 需要最终确认时用 `schematic.exportNetlist` 查该网络的引脚成员。

### 7. 板框（drawOutline）

- 官方多边形接口的矩形 (x,y) 语义是**左上角**（画布 +Y 向上，矩形向下延伸）；插件 0.8.5 起对外统一为**左下角**并内部换算。用旧版插件画出的板框位置会偏。
- ⚠️ 官方会把板框层图形自动转成 **Region 类型**——旧版 delete 列表里没有 Region，出现"删不掉的幽灵板框"。0.8.5+ 已支持。重复板框用 `pcb.getPrimitivesInRegion` 找到多余 Region 的 ID 再 `pcb.delete`。

### 8. 布局与 DRC 的盲区

- ⚠️ PCB DRC **只查铜皮**（焊盘/走线/过孔间距），不查元件本体和丝印重叠。连接器、电解电容等大本体元件即使 DRC 通过也可能物理互压——按实测封装尺寸 + 本体尺寸核算间距。
- 原理图 DRC 接口只返回按类型聚合的计数（`{type, count}`），没有逐条明细；明细让用户看 EDA 底部消息面板。**0.10.25 定论（pro-api-types 26002 行注释实锤）：逐条明细重载 `sch_Drc.check(strict, ui, includeVerboseError:true)` 标注「ADD since EDA v4.2」——EDA 4.1.60 运行时不支持，调用参数正确也只返回聚合结构（`runDrcDetailed` 标 `aggregated:true`），不要再假装支持或反复重试**；v4.2+ 运行时才有逐条 ISCH_DrcError。PCB 侧 `pcb.runDrcDetailed` 明细可用，但官方返回是**树形分组**（`[{name:规则类别, list:[{name:网络, list:[叶]}]}]`，叶的 `errData` 嵌在 `explanation` 内部），0.10.25 起插件拍平提取 type/rule/errorType/message/net/primitiveId(s)/x/y，raw 保留原始叶兜底。
- ~~大批量改动后立即跑 DRC 可能返回过渡态旧结果~~：0.9.0 起 `schematic.runDrc` 内部自动跑两遍取稳定值（首次不稳定时返回里带 note 说明）。

### 9. 导入与保存

- `pcb.importChanges` 弹的对话框 AI 点不了，必须提醒用户手动点「应用修改」。
- `pcb.save` 在无修改时返回 false 是官方行为，不是失败。
- `project.renameBoard` 底层官方按名字匹配板子，重名会改错——插件已加校验，改名前先 `project.getBoardInfo` 确认。

### 10. 其它

- ⚠️ **文档源码写入必须遵守 append-only 纪律（0.10.22 从官方分组扩展移植的实锤结论）**：EasyEDA 文档源码是**行式 JSON 变更日志**（`JSON(header)||JSON(data)` 行尾带 `|`，同 (type,id) 多次出现由 ticket 分新旧，data 空串=删除墓碑），不是快照。0.10.10 事故的根因就是整份重写/编辑既有行被判"数据格式不对"。安全写法只有一条：① **从不编辑旧行**，变更全部生成新记录追加文末；② ticket 从现有 max+1 单调递增（小了会被旧记录压过）；③ 改图元用原 data 浅拷贝只覆盖要改的键，未知字段原样保留；④ 移动器件坐标**双字段同改**（x/y/angle 与 positionX/positionY/rotation 在就一起改）；⑤ 删除用墓碑不物理删行；⑥ 写入前整份原文备份、写后立即回读重新解析逐值比对（容差 0.001）、任何一步失败整份恢复、全过才 save——**不求一次写对，求错了能无损恢复**。这套管线封装在 `pcb.groupBySchematicRegions`/`pcb.sourceRollback`（基础设施 `src/pcb/sourcelog.ts` 通用，原理图侧可复用）；生成图元一律 `spg_` 前缀+文档层 layerId=13，便于墓碑清场。备份是版本化文件栈：`ai-command-engine/backups/<工程>/<时间戳>.txt`（每工程保留最近 5 份，由指令代理落盘；代理不可用时回退 EDA 扩展存储单槽只留最近一份）。
- macro 返回结果的键是 `steps`。
- `editor.screenshot` 默认只截当前视口；全图用 `{ "zoomToAll": true }`。截图可能因渲染时机出现空白，重截即可。
- 截图坐标换算：PCB mil、原理图 10mil，裁剪局部图时按画布范围比例换算。
- `schematic.autoLayout`（0.10.19）使用流程：**先 dryRun（默认）看 plan（每个器件 旧坐标→新坐标）和 connections（连接表+link/label 风格）确认无误，再 `dryRun:false` 真跑**。真跑不可逆（器件移动+旧导线删除重建），跑前确保工程已保存；跑完看返回的 `moved`/`moveFailed`/`rewired`（batchWire 结果含 wireAudit）/`drc`，并目测画布。与 buildBlock 的分工：buildBlock 是从零生成功能区（放器件+连线），autoLayout 是整理已有功能区（器件和网络关系已存在）。⚠️ 官方移动器件后旧导线原地不动（不跟随），所以 rewire 是删旧重建，不是平移。
- `schematic.buildBlock`（0.9.8）第一版是规则式布局：器件按 60/90 行列网格排，美观度约 80 分，生成后可能需要人工或 moveComponent 微调；nets 里的引脚引用必须用 components 清单里的 `ref`（不是 EDA 自动分配的位号，二者可能不同，插件内部已做 ref→位号映射，返回的 placed 列表有对照）；生成后务必看返回里的 `incomplete` / `failed` / `wireAudit` 字段。0.10.14 起连线走 batchWire 语义化引擎（labelWire/linkWire），行为变化：两点网络直连为无名 U 形导线（不再给导线命名）、标签连接带占用预检（引脚已被异名网络占用会逐条拒绝并入 failed，不会强行串网）。**0.10.17 起放置后自动把用户 ref 落为真实位号**（lcscId 放置初始位号是 "R?"/"C?" 占位符，不改写连线引擎会产出 "R?.2" 被拒——0.10.16 实测全败；改写后读回验证，失败带 `designatorNote`），返回新增 `refMap`（ref→实际位号）。
- ⚠️ **原理图走线的"共线合并"陷阱（0.9.9 三轮实测翻车总结）**：官方会把几何上共线重叠/相接的导线自动合并成一根——① 相邻器件的短桩若画在同一间隙会重叠合并，挂两个网络标签直接串网；② 同一行器件引脚共线时，直线/L 形走线会穿过中间引脚把它并进网络；③ 多条网络的横腿在同一深度也会共线合并。buildBlock 与 labelWire/linkWire 内部已防（短桩四方向防撞 + U 形走线动态错层避让），但你自己用 drawWire 手动画线时同样要避开：**不要画穿过中间引脚的长直线，不要让两条不同网络的导线共线重叠**。
- ⚠️ **短桩避让必须查整段路径而非只查端点（0.10.24 终验实锤，0.10.26 修复）**：autoLayout rewire 时 FB 短桩（RV1.2，610→550 @y=560）**横穿 R1.2 引脚中段** (580,560)，把 R1.2 并入 FB 网络，后续 FBA link（R1.2–RV1.3）被占用预检拒绝、旧导线又已删 → FBA 断网。旧代码只查"桩末端 8 单位内有引脚"，端点距 30 判安全但中段横穿。0.10.26 起 labelWire 改为**整段路径 8 单位内有任何器件引脚（全页，含中段）就换方向**；autoLayout rewire 改为 **link 直连先于 label 短桩**建（先占好直连引脚，减少短桩占用冲突）；重连失败项在 `rewireFailed`/`warning` 明列（旧导线已删，失败项网络就是断的，必须人工逐条修复，插件不擅自恢复原连接）。
- ⚠️ **drawWire 带 net 命名会自动在导线中点落一个 NET 属性标签（0.10.24 终验实锤）**：该标签与 placeNetLabel 的标签是两套，同网并存即重复；且它是导线持有的属性，**官方不支持单独删除**（schematic.delete 对它报"删后读回验证仍在"是预期行为，0.10.26 起报错文案会直接说明）——要消除只能删整根导线重画。**需要标签收尾的场景：drawWire 不传 net（画无名线）+ placeNetLabel 放标签，不要两边都命名。** drawWire 命名成功时返回带 `namingNote` 提醒。
- ⚠️ **pcb.groupBySchematicRegions 板框/落子三连坑（0.10.24 终验实锤，0.10.26 修复）**：① 板框源码解析把 POLY 记录的 `path` 多边形源数组（`['R', x, y上沿, w, h, ...]` 带字符串标记）当纯数字对顺序配对，读出 (-100,-100)–(3360,3360)（宽度 3360 被当高度来源），与 autoPlace 的 outline 识别 (0,-1400)–(3360,-100) 矛盾 → 组块摆出真实板框外。0.10.26 起带字符串标记的 path 走多边形源语义解析，且**实时 Polyline/Region API 优先、源码兜底、两者不一致采信 API**（返回 source 注明）。② 组内贪心避让循环耗尽后错用前一个器件的 bbox 当本器件 bbox（落子失真、重叠成堆）——已修（固定 60 次推挤上限、始终记录本器件最终候选），并新增**落子重叠自检** `overlapCheck`（dryRun/实跑都带，重叠>0 附 warning）。③ "组边框未生成"系误报口径问题：spg_ 边框是 POLY（Polyline 类），`pcb.listLines` 枚举不到属正常——0.10.26 起实跑后从源码回读**核销 spg_ 生成物**（返回 `generated: {borders, labels, expected*}`，不符附 generatedWarning），以核销为准。dryRun 与实跑的 `groups[].placements` 均带逐项落子坐标，可直接比对"预览=实跑"。
- ⚠️ **0.10.29 grouping 布局引擎整体换成官方原版移植（0.10.26~0.10.28 三轮自修废弃）**：0.10.27 复测 14 对重叠全是**跨组**（overlapCheck 的 pairs 带 groupA/groupB，全跨组即可排除组内推挤嫌疑）；根因是自改版 layoutGroup 行锚定方向反、组 bbox 顶边裁掉高行内容（实测组 1 bbox 顶 -555 而 J4 落子 y=-291）。三轮自改（推挤记账/面积最小化/顶边锚定/角度归一）连修仍有重叠后，0.10.29 放弃自研布局，**逐行忠实移植官方 eext-pcb-component-grouping 的 buildPcbPatch 排布**（X86 主板验证过）：组按估算面积升序货架横排（rowLimit=max(最宽组估算宽, round(√总估算面积))，组缝 120，从原点向右向上铺）；组内行排序=行内器件数升序再前缀 U>R>C>L>D>Q，从组底 margin 15 起逐行向上排，贪心避让 componentGap 10/rowGap 15，R/C/L 强制 angle=0；bbox 三级测量链（封装源码→getPrimitivesBBox→通用兜底）与官方一致（官方兜底里的 X86 项目特定封装指纹未移植）。**与官方仅有的差异**：① 起点从 (0,0) 平移到板框内左下角；② 出口闸——排完任何组出板框即报错不写；③ 组名文本单行。origin 参数语义变为【左下角】起点。⚠️ 真实尺寸下 PCB4（板高 1300mil）组 2 高 ~1460mil 超顶，闸会报"摆不下"——这是闸在如实工作（旧版"放得下"恰是因为 bbox 被裁小），需拆框或加大板框。
- ⚠️ **0.10.31 三修复（GPT PCB 阶段反馈实锤）**：① **层参数静默回退（真缺陷）**——`pcb.placeString` 传 `layer:"13"`（数字字符串）旧版 resolveLayerEx 不识别，**静默回退层 3（顶层丝印）还报成功**，保存读回才发现放错层。0.10.31 起两个层解析函数都支持数字字符串（"13"→13），**传了但不认识的层名/层号一律报错**（错误信息列全部合法取值：top(1)/bottom(2)/top-silk(3)/bottom-silk(4)/top-mask(5)/bottom-mask(6)/top-paste(7)/bottom-paste(8)/top-assembly(9)/bottom-assembly(10)/outline(11)/multi(12)/document(13)/mechanical(14)/inner1~32(15~46)/custom1~200(71~270)，别名表已按 pcb.listLayers 在线实测核对），绝不静默回退；只有 layer 未传（undefined/null）才用缺省层。全插件审计结论：层解析仅 pcb.ts 的 resolveLayer/resolveLayerEx 两处（前者原来也有"未知→顶层 1"静默回退，一并严格化），schematic 侧无层参数、无第二处实现；placeString/modifyString 的 help 层说明已列出别名清单。② **createPcb/createSchematic 的 boardName 文档缺口**——help 原文"关联的板子名，留空自动"有误导：传**不存在**的板名会创建失败。0.10.31 改为明确"必须是已存在的板子名；要新建请省略 boardName，之后用 project.associateBoard 关联"。审计其余"留空"文案均为真实可选语义（过滤/缺省值），无同类误导。③ **macro 不在 /commands 目录**——macro 此前只在 executeCommand 特判执行、未进注册表，代理 /commands（__listCommands）不列出，OpenCode 固定执行器预检查因此拒绝。0.10.31 起 macro 注册为正式指令文档（steps/stopOnError 参数与 $stepId.path 变量说明进 /help），执行路径不变。buildBlock/autoLayout/groupBySchematicRegions 等组合指令本就在注册表，不受此影响。
- ⚠️ **偶发超时观察（0.10.26 装机记录，未复现未修复）**：① `pcb.runDrcDetailed` 偶发超时一次后自行恢复（同场景随后 543 项全量读取成功，结果与修改前逐项相同，非电路故障）。② `editor.openDocument` 切页偶发超时（UUID 与调用形式经只读确认无误，无弹窗；用户手动切页后同实例全部切页成功，不再复现）。两者根因均未证实，遇到时先重试或手动操作一次再复核，不要直接判定插件失效。
- ⚠️ **0.10.32 grouping 三打磨（货架/姿态/诊断）**：① **货架 rowLimit 收紧到板框可用宽度**——官方 `rowLimit=max(最宽组估算宽, round(√总估算面积))` 在组少时 √总面积≈组宽，第二组刚超就换行向上，横向大片浪费且容易上溢出板触发出口闸。0.10.32 起 `rowLimit=min(官方值, 板框可用宽)`（板宽连最宽组都放不下时保底最宽组，退化为每组独占一行，由出口闸如实报错）。② **R/C/L 估算盒归 0 姿态**——组内落子对 R/C/L 强制 angle=0，但此前估算盒按器件当前姿态实测（旋转 90° 的 R 横宽竖窄），pitch 与最终落子姿态不一致会重叠/稀疏。0.10.32 起估算盒绕器件原点逆旋转归 0 再排（非 RCL 保持原角，不受影响）。③ **出口闸报错附诊断**——出板框报错现在带板框宽×高、origin 后可用宽、实际 rowLimit、各组 bbox 尺寸清单，一眼判断是板太小还是排布策略问题。组内官方排布算法本体未动。
- ⚠️ **0.10.33 避让循环修复（0.10.32 装机验证实锤）**：单组+大量未认领器件场景（21 个障碍物散布板内），货架避让循环把组一路推过板顶、误报"上溢"（上溢量≈组全高、与 origin 无关，终点恰在障碍群顶之上）。根因两条：① 换行阈值用 rowLimit（常远小于板可用宽），组没碰到板右沿就被迫换行；② 换行时本行未放成任何组则 shelfRowHeight=0，每次换行只抬 groupGap=120mil 原地踏步。修复：换行阈值收紧 `min(rowLimit, 板可用宽)`；换行至少抬升本组高度 `Math.max(shelfRowHeight, 本组高)+groupGap`。修后板内确无空位时走出口闸如实报错（blockedBy 或上溢诊断），绝不静默摆出板外。出口闸诊断的 rowLimit 显示取整。
- ⚠️ **0.10.36 定论：system.eval 在当前运行环境不可用**——EDA 扩展沙箱同时禁用了 `new Function`（抛 "Function is not a constructor"）和全局 `eval`（"is not a function"），不要再用它做调试，需要任意代码能力就提需求封正式指令。同版修复 `project.importFile`：0.10.35 省略 saveTo 时官方在线环境返回空，0.10.36 起缺省自动取 `dmt_Team.getCurrentTeamInfo` 的团队 uuid 走 New Project 分支（saveToFolderPath 仍仅离线客户端可用）。
- ⚠️ **0.10.37（KIMI-EDA-20261002-01）超时全链路统一 300s + 图页改名 + copy 读回**：① **超时**：代理（command-proxy.mjs）与扩展（client.ts）的默认/长指令超时全部统一 300s，代理空闲自动退出 60s→300s；超时报错文案明确"超时≠取消，扩展可能仍在后台执行，重发前先只读确认现场"（EDA 官方 API 无取消机制，这是边界不是缺陷）。**代理脚本不在 eext 包里，改完要重启代理才生效**。② **project.renameSchematicPage 新增**：薄封装 dmt_Schematic.modifySchematicPageName，改后读回确认。③ **project.copySchematicPage 读回增强**：透传已逐字核对官方签名（schematicPageUuid 第一参数，无回落逻辑），复制后等 1.5s 同步再用 getSchematicPageInfo 读回，返回 name/parentSchematicUuid/sourcePageUuid，归属与目标不符时带 warning——GPT 现场"复制 P2 空白页得到 P1 电源页内容"若再现，返回的 sourcePageUuid 与读回信息可直接定位是官方行为还是调用问题。
- ⚠️ **0.10.30 grouping 三遗留修复（0.10.29 装机复测实锤）**：① **overlapCheck 自检改实测口径**——0.10.29 自检用布局估算盒报 0 重叠，checkPlacement 实测却有 3 处（C5×C6 同组 82×68：估算宽 ~97mil vs 真实焊盘 ~106mil；J1×J3 129×140；J2×C6 102×50）。0.10.30 起自检对所有落子调 getPrimitivesBBox 量真实焊盘 bbox（旋转+平移到落子姿态，checkPlacement 同款口径），量不到才回退估算盒；返回的 `overlapCheck` 字段带 `caliber: 'actual-pads'` 和 `measuredCount/fallbackCount`。② **货架排布避让既有器件**——官方算法假设全板重排不管既有器件，J2×C6 就是这么撞的。0.10.30 把未被区框认领的器件（含锁定/未分组）按当前姿态实测 bbox 作为 obstacles，组货架候选位撞上就往右让（让不开换行），200 次仍绕不开记 `blockedBy` 由出口闸报错不写；绕开的记 `avoidedObstacles`。组内排布算法不动（仍是官方原版）。③ **测量链防污染**——D1（SMA 二极管）从封装源码提取出 ~2048mil 虚高（真实 396×130），污染源是 D3_ATTRIBUTE/RULE 等非几何记录里的数值被当成坐标对；J3 组块 461×609 虚高来自 conn 兜底 800×800（真实 94×294）。0.10.30 起提取黑名单扩到全部非几何元数据记录（DOCHEAD/ATTR/CANVAS/LAYER*/RULE*/NET/PAD_NET/SILK_OPTS/ACTIVE_LAYER/D3_ATTRIBUTE），加合理性护栏（提取 bbox 单边 >2000 或 <5mil 返 null 落到实量级），conn 兜底瘦身 800→400；placements 逐项带 `measured/measureSource`（footprint-source/primitives-bbox/fallback），fallback 项宽高可能与真实封装有偏差请留意。注意：官方 footprint-source 提取语义与旧版一致、官方同样有污染隐患（X86 板运气好没踩到），护栏是我们加的防御。
- ⚠️ **0.10.27 装机复测四修（autoLayout / grouping / delete）**：① **link 直连也要整段避引脚**——0.10.26 只修了 labelWire 短桩，linkWire 的 U 形/L 形路径没查引脚，FBA link 横腿 (580,560)→(625,560) 横穿 RV1.2 引脚 (620,560) 把它并入无名网。0.10.27 起 linkWire 全部候选路径（U 形 8 层 + L 形两变体）逐段查全页引脚（两端点豁免，距离 <8 即判穿），全档位无解时抛带 `PIN_CROSSING_FALLBACK` 标记的错误。② **autoLayout rewire 外部引脚掉网（R2.1 FB、J4.1 EN）**——删"碰旧引脚的导线"时把穿着目标器件以外引脚的线也删了，外部侧没重建。0.10.27 起删线前用全页引脚表分类：纯内部线照删；**带 1 个外部引脚的线删后自动补网**（label 网把外部引脚补进重建项、link 网由连接表 link 项天然覆盖，返回 `externalRewired` 清单）；**穿 ≥3 个引脚的复杂长线保留不删**（进 `skippedWires`，目标侧照常重建，可能留悬线请人工复核）。link 重建若因穿第三方引脚失败，**自动降级为两端 label 短桩**再试一次（返回 `fallbacks`），只有未恢复的才进 `rewireFailed`。③ **grouping 推挤振荡**——固定 60 次推挤在拥挤场景来回振荡，耗尽停在振荡中点仍重叠（复测 14 对）。0.10.27 改**重叠面积最小化**：最多 200 次迭代，每步算与全部已放 bbox 的总交叠面积，归零即收，耗尽用历史最小面积位置落子。④ **delete 会话健康探针**——出现过"报失败但后台已删"（reconciled）或真失败时，自动画一条探针图元再删掉（原理图侧无名短线、PCB 侧文档层文本，10s 超时），返回 `sessionHealth: ok|degraded`；degraded 说明写通道可能损坏，附 warning 建议【不保存重开页面】。探针自身异常绝不影响已有删除结果。
- ⚠️ **0.10.40 探针加固（GPT KIMI-EDA-20261002-02：0.10.37 现场批量删除后探针一次 create 被官方 reject「create failed!」即报 degraded，调用方停摆——官方主机忙/模态瞬态也会这样 reject，单次失败不足为据）**：探针改为 ① 焦点文档复核（焦点不在对应文档类型→`sessionHealth: inconclusive`，不误报）；② create **3 次重试**（间隔 2s，多组候选坐标），全败才 degraded；③ 创建/删除均读回验证，删除失败报 `probeResidue`（残留探针图元 ID，恢复后用 delete 定点清理）。**收到 degraded 的处置**：先跑只读指令（listWires/listComponents）复核——读正常但写持续失败才算写通道劣化，再决定【不保存重开页面】；`inconclusive` 只需采信删除结果本身（已读回验证），不必停摆。**0.10.41 口径修复**：失败原因是「图元不存在」的 ID 从不存在，终扫必然查不到——不再误当「后台已删」挪进 deleted（0.10.40 装机实测假 ID 被误挪），保持 failed 原样。
- ⚠️ **0.10.42 长任务化（GPT KIMI-EDA-20261002-03：0.10.41 删 8 根线 300s 无返回——根因是终扫枚举/浮标扫描/探针读回等收尾 await 无超时保护，官方挂起时整批永远不回）**：① 新增 `task.get {taskId}` / `task.list`——delete 返回带 `taskId`，客户端超时后用 task.get 查实时进度（stage: deleting/final-sweep/health-probe + deleted/failed 快照），完成后补取 result（保留 15 分钟）；② **相同 ID 清单的任务在跑时重发 delete 只回 `alreadyRunning` 进度，不重复执行**——超时后尽管重发或查 task.get，不会双删；③ 删除路径所有收尾 await 补超时（终扫枚举 20s、浮标扫描 15s、焦点查询 5s、探针删除/读回 10s），整批最坏耗时封在 ~200s 内必有返回；④ 预算耗尽/熔断即停止派发新项（原有机制保留）。
- ⚠️ **0.10.43（GPT PCB电源铺铜反馈 20261002）**：① **routeTrack/pourCopper 省略 layer 恢复缺省顶层**——0.10.39 把 resolveLayer 的「不认识层报错」改写时把未传 layer（空串）也丢进报错分支，文档声明「默认 top」但省略即被拒；0.10.43 起未传（undefined/null/空串）回顶层 1，不认识的非空层名照旧报错不静默回退。② **`pcb.rebuildPour {primitiveId?}` 新增**——官方 rebuildCopperRegion(s) 封装：单框 `pour.rebuildCopperRegion()`（@beta，官方注明纯 API 创建的覆铜上重建可能报内部错误，如实透传为 failed）、全板 `eda.pcb_PrimitivePour.rebuildCopperRegions()`（@alpha）；status 以 `getCopperRegion()` 读回为准（completed/no-fill/failed/timeout），重建本体 240s 超时保护，**只触发重建+读回，不保存不切层**；超时≠取消，只读复核后再决定。③ **`pcb.listPours` 加 `withFill:true`**——逐框读回 `filled/fillPrimitiveId/fillRegions`（getCopperRegion），验收「铺铜是否真填充」用它，不把 pourCopper 返回当填充成功。④ **pourCopper 语义**：只创建覆铜边框，不保证同步生成填充；填充确认走 rebuildPour + listPours withFill，或界面手动重建（设计→覆铜）。
- ⚠️ **0.10.44（GPT KIMI-EDA-20261002-04：exportNetlist 返空核实 + task.list 返 null）**：① exportNetlist wrapper 逐字核对无缺陷（sch_ManufactureData.getNetlistFile 薄封装），官方返 undefined 的触发条件无文档、缺封装因果未证实不妄断；导出范围（活动页/多页）官方未文档化，待独立实测。② 新增 `schematic.getNetlist {netlistType?}`——官方 sch_Netlist.getNetlist（@deprecated 仍公开）薄封装，与 getNetlistFile 两条独立路径，exportNetlist 返空时的连通性审计备选；两条同时失败=数据不满足官方网表校验。③ `task.list` 改返回 `{tasks, count}` 对象——空注册表 wire 格式本是 `[]`，PowerShell Invoke-RestMethod 会把 JSON 空数组塌成 `$null`（客户端伪象，不是宿主语义）；对象包装在任何客户端不塌缩。
- ⚠️ **0.10.45 装机实测两边界（某测试工程，EDA 4.1.60）**：① 官方 @alpha 静态 `pcb_PrimitivePour.rebuildCopperRegions` 在运行时不存在（类型库有、宿主没实现，"not a function"）——`pcb.rebuildPour` 全板模式退化为逐框 `rebuildCopperRegion` 循环（返回 `mode:'per-pour-loop'`）。② 官方 @beta `pour.rebuildCopperRegion()` 在**纯 API 创建的覆铜边框上为空操作**（不抛错、返回 undefined、无填充生成，官方文档 caveat 实锤；板外区域、modify 触发后复测均同）。结论：API 铺铜的填充生成当前不可由扩展完成，需界面手动重建（设计→覆铜）；扩展侧能提供的是 rebuildPour 触发 + `pcb.listPours {withFill:true}` 读回验收（getCopperRegion 每框填充图元/区域数）。
- ⚠️ **0.10.45（续 GPT KIMI-EDA-20261002-05）**：① 官方 `sch_Netlist.getNetlist` 格式兼容性实测（4.1.60）：**JLCEDA 挂起>120s、EasyEDA 返空**（你方现场 JLCEDA 报 "i is not iterable" 同路径不同形态）——`schematic.getNetlist` 对这两个格式前置拒绝并提示可用格式，其余格式 45s 超时保护；**实测可用：Protel2/PADS/Allegro/DISA/DSNET**。官方文档已标该接口 obsolete（pro-api-sdk#30 记录悬空脚无限卡死），不要依赖。② **网表审计带回退**：新增 `pinNetMapRobust()`——getNetlistFile（JSON）返空/抛错时自动回退 `getNetlist('PADS')` 文本解析（`*SIGNAL*` 段）；batchWire 终审 / repairNet / autoLayout 三处内部审计全部换用。**⚠️ 0.10.45 更正（05 补测实锤）**：**缺封装状态下 PADS 回退同样失效**——任一器件 Footprint 空且 Convert to PCB=yes 时官方网表生成器整体拒产（文件路径返 undefined、字符串路径全格式返空），此时三处审计如实报"未能审计"（pass:undefined），唯一连通性验证手段是不依赖网表生成器的 listWires/listNetLabels/getComponentPads 局部读回；唯一已实测解封手段：补封装，或把缺封装器件 Convert to PCB 设为 no（该器件仍在电气网表中，getNetlistFile 即恢复，但不会转入 PCB）。
- `editor.openDocument` 的参数名是 `uuid`（不是 documentUuid），传错参数名会静默失败（返回错误但焦点不换），后续指令就打在错误文档上——调用后检查返回 ok。

## 七、工作守则

1. **先查再画**：修改前先 `project.getInfo` / `schematic.listComponents` / `pcb.listComponents` 了解现状。
2. **先选窗、先激活**：单工程时代理自动选窗，多工程必须显式 `/select`；原理图/PCB 指令前先 `editor.openDocument`。
3. **批量操作用 macro**：多于 2 步的操作合并为一条 macro 发送。
4. **画完必读回**：导线用 `listWires`、网络用 `exportNetlist`、PCB 网络用 `getComponentPads`，逐项审计，不假设成功。
5. **每完成一个阶段就 save**。
6. **收尾必 DRC**，把结果如实报告给用户；原理图 0 致命才允许 `pcb.importChanges`。
7. 失败时不盲目重试：读 `error.message` 与 `error.suggestion`，修正参数后再发；同一指令连错 3 次就停下来换方案。
8. 涉及阻抗、等长、载流等专业知识时，先 `knowledge.query`，按插件返回的 constraints/guidance 执行。
9. **新 API 行为先用官方网关探针验证**（插件开发者向）：对没把握的原生 API，先 `POST http://127.0.0.1:49620/execute {"code":"..."}` 直接在 EDA 环境试跑（`/eda-windows` 列窗口，`/eda-windows/select` 选窗；⚠️ 代码不支持可选链 `?.`，用传统判空），确认真实行为后再封装/修改插件指令——不要靠猜，也不要用"构建→装包→实测"的长循环试错。⚠️ 网关可能掉线（0.10.10 调试时 49620 连接拒绝），插件的 `system.eval` 逃生口在当前 EDA 版本沙箱里也不可用（Function/eval 均被禁）——此时只能用现有封装指令当探针（placeNetLabel/listNetLabels/pruneFloatingLabels dryRun/exportNetlist 组合）或直接查 pro-api-types 类型注释（官方把关键限制写在注释里，如属性图元 delete 的 @internal 说明）。
10. **插件不越权（0.10.7 确立的设计原则）**：指令只检查、如实反馈，**不擅自修复/删除/回滚**——异常时返回状态码+warning+处置建议，删不删由操作者决定（操作者主动调用 `pruneFloatingLabels`/`dedupeWireNets`/`delete` 才是授权清理）。另：官方创建类接口存在"假失败"（返回空但实际已创建，事务未回滚），不信返回值，以文档实际内容为准（查文档源码/枚举复核）。
