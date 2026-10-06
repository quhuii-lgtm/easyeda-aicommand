# 标准工作流程

## 画原理图（批量优先）

1. `GET /connections` 核对窗口；每条请求带顶层 `instanceId` → `editor.openDocument` 激活 → 页级请求带 `params.__docUuid` → `schematic.getPageInfo` 读图框。
2. **放器件优先 `buildBlock`**：一个功能区一条命令；零散补充才 `placeDevice`。同功能器件聚拢。
3. **连线优先 `batchWire`**：一批接线一次提交；单条修补用 `labelWire`（单脚）/`linkWire`（双脚）；`connectPin`/`drawWire`/`placeNetLabel` 仅特殊场景（母排、多点直连、批量改色）。
4. **读回自查**：`listWires`+`exportNetlist` 审计每个网络的引脚成员（别信"画了就通"）。
5. `runDrc`（自动取稳定值）→ 致命清零；历史图"多个网络名"警告跑 `dedupeWireNets`。
6. `save`。

## 整理已有原理图

- 器件乱/连线乱：`autoLayout`（先 dryRun 看 plan/connections，确认后真跑；跑前保存，跑完看 moved/moveFailed/rewired/drc）。
- 标签问题：`fixNetLabels` 全科体检（dryRun 默认 true）；浮标残留 `pruneFloatingLabels`（分批，看 batches/unprocessed）。
- 网络碎（人工拖标签等）：`repairNet` 收尾。

## 元器件摆放与表达（以项目及器件要求为准）

1. 去耦电容在原理图上应能辨认对应电源引脚/电源域；实际连接、容量、数量及 PCB 距离按具体器件资料与项目工况确定。不能从示意摆放推导同名电源脚不可并网。
2. 输入/输出电容与相关引脚的关系表达清楚，PCB 就近布局要求仍须在 PCB 上核验。
3. 同功能块优先真实连线，跨块按需标签；合法未连接引脚明确标注 NC，不为消除视觉孤立而添加需求外连接。
4. 避免导线穿符号本体、标签压引脚、文字重叠；移动后复核网络和预期端点。
5. 本技能自包含，不要求用户另装作者的原理图优化技能。

## 原理图转 PCB

1. ⚠️ 原理图有致命 DRC 时 `importChanges` **静默 false**——先清到 0 致命。
2. `importChanges` 弹对话框，**提示用户点「应用修改」**，AI 代点不了。
3. 导入后 `listComponents`+逐器件 `getComponentPads` 比对焊盘网络与网表。
4. 布局：零散 `moveComponent`；功能区成组用 `groupBySchematicRegions`（先 dryRun）。⚠️ DRC 不查本体/丝印挤压——摆完跑 `checkPlacement`，大本体器件（连接器、电感）加 `margin`（10~30mil）。
5. 布线：`routeTrack`（大电流先 `knowledge.widthForCurrent`）、`placeVia`、`pourCopper`（GND 整面）；量大走自动布线闭环（先锁电源网，见 commands-pcb.md 附录 ⑦）。
6. `runDrc` → 报告违规 → `save`。

## 收尾纪律

每阶段 save；破坏性操作前确认目标 ID、留备份（代理自动备份 .epro 或手动 `project.exportFile`）；所有修改以读回为准（带 `readback` 的返回也不信单次值）。

## 工作守则（全文）

1. **先查再画**：改前先 `project.getInfo`/`listComponents` 了解现状。
2. **先核对目标、再激活**：每条请求带顶层 `instanceId`，不以 `/select` 代替；`schematic.*`/`pcb.*` 前先 `editor.openDocument`。
3. **批量用 macro**：>2 步合并一条 macro 发送。
4. **画完必读回**：导线 `listWires`、网络 `exportNetlist`、PCB 网络 `getComponentPads` 逐项审计，不假设成功。
5. **每阶段 save**。
6. **收尾必 DRC** 如实报告；原理图 0 致命才允许 `pcb.importChanges`。
7. **不盲目重试**：读 `error.message`/`suggestion` 修正再发；同一指令连错 3 次停下换方案。
8. **专业知识先查库**：阻抗/等长/载流先 `knowledge.query`，按 constraints/guidance 执行。
9. **扩展开发另行处理**：普通绘图使用本插件指令。任意原生 API 调试不属于本技能安装流程；作者曾用的 49620 网关未包含在此仓库，不能假定用户已安装或据此执行代码。
10. **插件不越权**：指令只检查如实反馈，**不擅自修复/删除/回滚**——异常返回状态码+warning+建议，由操作者决定（主动调 `pruneFloatingLabels`/`dedupeWireNets`/`delete` 才是授权清理）。官方创建类接口有假失败（返回空但实际已创建），不信返回值，以文档实际内容为准。
