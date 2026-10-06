# 标准工作流程

## 画原理图（批量优先）

1. `/connections` 选窗 → `editor.openDocument` 激活 → `schematic.getPageInfo` 读图框。
2. **放器件优先 `buildBlock`**：一个功能区一条命令；零散补充才 `placeDevice`。同功能器件聚拢。
3. **连线优先 `batchWire`**：一批接线一次提交；单条修补用 `labelWire`（单脚）/`linkWire`（双脚）；`connectPin`/`drawWire`/`placeNetLabel` 仅特殊场景（母排、多点直连、批量改色）。
4. **读回自查**：`listWires`+`exportNetlist` 审计每个网络的引脚成员（别信"画了就通"）。
5. `runDrc`（自动取稳定值）→ 致命清零；历史图"多个网络名"警告跑 `dedupeWireNets`。
6. `save`。

## 整理已有原理图

- 器件乱/连线乱：`autoLayout`（先 dryRun 看 plan/connections，确认后真跑；跑前保存，跑完看 moved/moveFailed/rewired/drc）。
- 标签问题：`fixNetLabels` 全科体检（dryRun 默认 true）；浮标残留 `pruneFloatingLabels`（分批，看 batches/unprocessed）。
- 网络碎（人工拖标签等）：`repairNet` 收尾。

## 元器件摆放规范（放器件/整理/审图必查，2026-10-06 用户增订）

1. **解耦电容对脚专配**——哪颗电容属于哪个引脚就直接短桩接在该引脚上，不与其他引脚的电容并联混接；整排电容全并在电源总线上是典型违规。
2. **输入/输出电容就近同序**——芯片要求就近放置的输入/输出电容，原理图上也按同样顺序就近摆，与引脚一一对应。
3. **同引脚可并联**——归属同一引脚的多个电容允许并联。
4. **无孤立器件**——每个元件至少一脚实质入网；指示器件按信号本意接线（LED 接控制脚而非惯性接电源）。
5. **走线不进器件本体**——导线（含干线母线）与符号身体/边框留间距；网络标签方向随导线（横线横标、竖线竖标），不压引脚、不重叠。
6. 详细验收清单与持续改进闭环见 `eda-schematic-layout` 技能 §1–§2。

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
2. **先选窗、先激活**：多工程显式 `/select`；`schematic.*`/`pcb.*` 前先 `editor.openDocument`。
3. **批量用 macro**：>2 步合并一条 macro 发送。
4. **画完必读回**：导线 `listWires`、网络 `exportNetlist`、PCB 网络 `getComponentPads` 逐项审计，不假设成功。
5. **每阶段 save**。
6. **收尾必 DRC** 如实报告；原理图 0 致命才允许 `pcb.importChanges`。
7. **不盲目重试**：读 `error.message`/`suggestion` 修正再发；同一指令连错 3 次停下换方案。
8. **专业知识先查库**：阻抗/等长/载流先 `knowledge.query`，按 constraints/guidance 执行。
9. **新 API 先用网关探针验证**（开发者向）：没把握的原生 API 先 `POST http://127.0.0.1:49620/execute {"code":"..."}` 在 EDA 环境试跑（`/eda-windows` 列窗口、`/eda-windows/select` 选窗；⚠️ 不支持可选链 `?.`），确认真实行为再封装——别靠猜、别用"构建→装包→实测"长循环。网关可能掉线、`system.eval` 逃生口在当前沙箱不可用——用现有封装指令当探针（placeNetLabel/listNetLabels/pruneFloatingLabels dryRun/exportNetlist）或直接查 pro-api-types 类型注释（官方把限制写在注释里）。
10. **插件不越权**：指令只检查如实反馈，**不擅自修复/删除/回滚**——异常返回状态码+warning+建议，由操作者决定（主动调 `pruneFloatingLabels`/`dedupeWireNets`/`delete` 才是授权清理）。官方创建类接口有假失败（返回空但实际已创建），不信返回值，以文档实际内容为准。
