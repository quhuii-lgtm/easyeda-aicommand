# 按需求选指令（任务速查）

不按对象、按"我要做什么"给指令序列。**序列从左到右执行**；`list*`/`get*` 一律只读，可放心探路。参数细节进对应命令文档，拿不准 `GET /help?cmd=<名>`。

## A. 只读体检 / 验收（不动图）

| 我要… | 用这条 |
| --- | --- |
| 整页结构验收（桥接/错网标签/共线重叠/重复位号/浮标/孤立线/十字交叉/区框/器件归区相碰，一次全查） | **`schematic.structuralAudit`**（逐页 `editor.openDocument` → 本指令；blocking=0 是结构合法，不证明设计意图） |
| 审计某网络到底连了哪些引脚（连通性最终手段） | `schematic.exportNetlist`（或 `getNetlist`）逐网络对账 |
| 标签全科体检（浮空/重复/反字/位置） | `schematic.fixNetLabels`（dryRun 默认 true，先看报告） |
| DRC 收尾 | `schematic.runDrc`（自动两遍取稳定值）→ 要明细用 `runDrcDetailed`（需 EDA v4.2+） |
| 看某根线/某个图元是什么 | `schematic.listWires`/`getPrimitiveAtPoint`/`getPrimitivesInRegion` |
| PCB 版本 DRC | `pcb.runDrc` / `pcb.runDrcDetailed` / `pcb.getRealTimeDrcStatus` |
| PCB 摆完看器件是否相碰/出界 | `pcb.checkPlacement`（大本体加 `margin` 10~30mil） |

## B. 画新图 / 加功能块（批量优先）

| 我要… | 用这条 |
| --- | --- |
| 从零画一个功能区 | `schematic.buildBlock`（器件清单+连接表一条命令；必看返回 refMap/wireAudit） |
| 已有图上批量加器件+接线 | `schematic.placeDevice`（零散）+ `schematic.batchWire`（一批接线一次提交） |
| 单引脚接入命名网（电源/信号桩） | `schematic.labelWire` |
| 两个引脚物理直连 | `schematic.linkWire` |
| 手画特殊走线（母排/多点） | `schematic.drawWire`（⚠️ 不传 net，命名用 placeNetLabel，别两边都命名） |
| 画功能区框+标题 | `schematic.placeRegion` |
| 画完确认 | `listWires`+`exportNetlist` 读回 → `runDrc` → `schematic.save` |

## C. 整理已有乱图

| 我要… | 用这条 |
| --- | --- |
| 器件乱/连线乱，重排 | `schematic.autoLayout`（**先 dryRun 看 plan**，确认后真跑；跑前 save） |
| 清浮空标签 | `schematic.pruneFloatingLabels`（分批跑，别调大 batchSize） |
| 人工拖标签拖碎的网络 | `schematic.repairNet` |
| 历史图"多个网络名"警告 | `schematic.dedupeWireNets` |
| 删图元 | `schematic.delete`（已加固：类型识别+删后读回+终扫对账；批量保持默认分批） |

## D. 工程 / 图页管理

| 我要… | 用这条 |
| --- | --- |
| 看工程文档树（uuid 全从这来） | `project.getInfo` / `project.list` |
| 切换工程 | ⚠️ **先 `schematic.save`**（有未保存修改时 open 直接报失败）→ `project.open` |
| 改图页名 | `project.renameSchematicPage`（⚠️ 目标页须在本窗口打开过且 save 过一次，否则官方假失败；见 pitfalls） |
| 删/复制/排序图页 | `deleteSchematicPage` / `copySchematicPage` / `reorderSchematicPages` |
| 备份/迁移工程 | `project.exportFile`（.epro2 base64 自行落盘） |
| 导入外部文件 | `project.importFile`（🔴 覆盖导入不可回退，先备份） |

## E. 原理图 → PCB

1. 原理图 `runDrc` 清到 **0 致命**（有致命时 `importChanges` 静默 false）。
2. `pcb.importChanges` → **弹对话框须用户点「应用修改」**，AI 代点不了。
3. 对账：`pcb.listComponents` + 逐器件 `pcb.getComponentPads` 比焊盘网络。
4. 布局：`pcb.groupBySchematicRegions`（先 dryRun）/ `pcb.moveComponent`；摆完 `pcb.checkPlacement`。
5. 布线：`pcb.routeTrack`（大电流先 `knowledge.widthForCurrent` 算线宽）+ `pcb.placeVia`；GND 整面 `pcb.pourCopper`。
6. `pcb.runDrc` → 清零 → `pcb.save`。

## F. PCB 专项 / 生产导出

| 我要… | 用这条 |
| --- | --- |
| 线宽/载流/阻抗/等长查询 | `knowledge.query` / `knowledge.widthForCurrent`（先查再画） |
| 差分对 / 等长组 / 网络类 | `pcb.createDiffPair` / `createEqualLengthGroup` / `createNetClass`（全表见 [commands-net.md](commands-net.md)） |
| 多层板层叠 | `pcb.applyStackingConfig` / `getStackingConfig` |
| 量太大走自动布线 | 闭环 `exportDsn` → 外部布线 → `importAutoRouteSes`（先锁电源网，见 commands-pcb.md 附录⑦） |
| 出生产资料 | `pcb.exportGerber` / `exportPickPlace` / `exportNetlist`；原理图侧 `schematic.exportBom` |

## G. 复用模块 / 自建库 / 选料

| 我要… | 用这条 |
| --- | --- |
| 把画好的块存成模块复用 | `cbb.create` / `cbb.placeSchematicPage` / `cbb.placePcb`（见 [commands-cbb.md](commands-cbb.md)） |
| 自建符号/封装/器件 | `lib.symbolCreate` / `lib.footprintCreate` / `lib.deviceCreate`（⚠️ modify 后 uuid 会变，按名复核，见 [commands-lib.md](commands-lib.md)） |
| 立创商城选料 | `library.searchDevice` / `library.getDeviceByLcsc` |
| 查 SMT 可贴装物料 | `knowledge.listRules` + knowledge.query |

## H. 故障排查 / 进度

| 现象 | 怎么办 |
| --- | --- |
| 客户端超时了 | 超时≠取消：`task.list` / `task.get {taskId}` 查后台进度补取结果 |
| 指令报错了 | 读 `error.message`/`suggestion` 修正再发；同一指令连错 3 次停下换方案 |
| 创建类全失败、读类正常 | 会话损坏：不保存，关页面重开还原 |
| 返回成功但不敢相信 | 以读回/源码重扫为准（官方有假成功/假失败） |
| 不确定行为 | 先 dryRun / 先只读 list 探现场，再动写指令 |

## I. 汇报 / 截图

| 我要… | 用这条 |
| --- | --- |
| 画布截图给用户看 | `editor.screenshot` / `editor.zoomToRegion` 后截图（⚠️ 窗口后台时截的是缓存帧，连截字节相同=不可信，pitfalls K9） |
| 原理图整页 PNG（**视觉验收首选**） | `schematic.exportPng`（返回全部页打包 ZIP 的 base64，先解 ZIP；后台窗口也出全图，K10） |
| 看当前开了哪些页 | `editor.listTabs` |
| **逐条目检 candidate（排版验收截图确认）** | 配方：`schematic.structuralAudit` 取 issues → 对每条 candidate 按其 `coords` 发 `editor.zoomToRegion {x1,y1,x2,y2}`（coords 为中心，框 ±150mil）→ `editor.screenshot` 存证（须确认窗口在前台，否则改用 exportPng 整页目检）。多条件目检可串成一条 `macro`（steps 里 zoom/screenshot 交替），逐条看图确认器件不碰/线不压/功能区分开 |
