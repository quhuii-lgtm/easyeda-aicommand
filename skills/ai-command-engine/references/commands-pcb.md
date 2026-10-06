# PCB 指令全表

> 本页表格/参数对象描述命令及 `params`，不是完整 HTTP 请求。发送 `/command` 时外层必须带 `cmd`、顶层 `instanceId` 和所需 `params`；宏仅外层路由，步骤继承实例。完整示例见 [setup](setup.md)。

**① 布局 → ② 布线 → ③ 结构与层 → ④ 检查导入导出 → ⑤ 图元读改**，附录 **⑥ 低频（等长组/层叠/实时DRC）→ ⑦ 自动布线闭环**。陷阱见 [pitfalls.md](pitfalls.md)。

## ① 布局

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.listComponents` | 列器件 | `layer?` |
| `pcb.moveComponent` | 移动/旋转（ID 或位号；内部分步+读回验证） | `primitiveId` 或 `designator`, `x?`, `y?` |
| `pcb.getComponentPads` | 读焊盘（编号/网络/坐标/形状）——**验证导入后网络** | `primitiveId` |
| `pcb.checkPlacement` | 间距检查（按焊盘包围盒报重叠/间距不足+返回外形尺寸；⚠️ DRC 不查本体挤压，布局完必跑） | `minClearance?`, `margin?`, `designators?` |
| `pcb.groupBySchematicRegions` | **【宏·唯一自动布局】按原理图区框聚合分组 PCB 器件**（0.10.55 起替代已删除的 autoPlace；源码 append-only 管线） | `pageUuid?`, `dryRun?`, `origin?`, `boardSize?`, `gap?`, `groupGap?` |
| `pcb.sourceRollback` | 源码备份列出/恢复 | `list?`, `backupId?` |
| `pcb.delete` | 删图元（同 schematic.delete 加固） | `primitiveIds`, `batchSize?` |

- **DRC 只查铜皮间距，不查本体/丝印重叠**——大本体器件（连接器、电解电容）DRC 过也可能互压；checkPlacement 按焊盘包围盒，大本体加 `margin`（10~30mil）近似。
- **groupBySchematicRegions**：读全图页区框（`pageUuid` 限定），按位号文本位置归属、多框取面积最小；组内位号前缀分行（U>R>C>L>D>Q>其他）；组间货架 packing 强制收进板框，摆不下报错并附诊断（板框宽高、可用宽、rowLimit、各组 bbox）。布局引擎是官方原版移植（X86 主板验证）：组按估算面积升序货架横排（rowLimit=min(官方值,可用宽)，组缝 120），贪心避让 gap 10/15，R/C/L 强制 angle=0。避让既有器件（实测 bbox 作 obstacles，绕不开记 `blockedBy` 出口闸报错）。测量链三级（封装源码→实测→兜底），placements 带 `measured/measureSource`（fallback 项宽高可能有偏差）。组边框+组名生成 `spg_` 前缀文档层（layerId=13），重复执行先清场，实跑后源码回读核销。**五步管线**：版本化备份（`backups/<工程>/<时间戳>.txt` 留 5 份）→写源码→回读比对（容差 0.001）→失败整份恢复→全过才保存。**dryRun 默认 true**。⚠️ 调用前焦点在 PCB，执行中短暂切焦点读原理图再切回。（0.10.55 起为唯一自动布局指令，autoPlace 已删除。）
- **sourceRollback**：`list:true` 列备份；否则恢复（默认最近或按 `backupId`），恢复前校验 pcbUuid 匹配，恢复后回读+保存。
- **pcb.delete**：同 schematic.delete 加固（识别类型+删后读回+8s 熔断+连 3 败熔断+batchSize 10+预算 100s+终扫对账+sessionHealth 探针+taskId 查进度）。

## ② 布线

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.routeTrack` | 走线（折线自动拆段） | `net`, `points`, `layer?`, `width?` 或 `currentA?` |
| `pcb.placeVia` | 过孔 | `net`, `x`, `y`, `holeDiameter`, `diameter` |
| `pcb.pourCopper` | 矩形铺铜（只创建覆铜边框，不保证同步填充） | `net`, `layer?`, `x`, `y`, `width`, `height` |
| `pcb.rebuildPour` | 重建铺铜填充并读回 | `primitiveId?`（留空=全板） |
| `pcb.listLines`/`listVias`/`listPours` | 读回自查（listPours 传 `withFill:true` 可读回填充状态） | `net?` |
| `pcb.listNets` | 列全部网络 | 无 |
| `pcb.importAutoRouteSes` | SES 回灌 | 无 |

- 大电流先 `knowledge.widthForCurrent` 换算线宽（`currentA?` 传电流时插件按 IPC-2221 自动换算）；GND 优先整层铺铜。
- 自动布线闭环（锁电源网→FreeRouting→回灌）见附录 ⑦。
- 等长组管理见附录 ⑥。
- 修线心法：自动布线后审查，不合理局部 `pcb.delete`+`routeTrack` 重修。

## ③ 结构与层

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.drawOutline` | 矩形板框（⚠️ x,y 是**左下角**，官方接口左上角、插件内部换算） | `x`, `y`, `width`, `height`（mil） |
| `pcb.getPrimitivesInRegion` | 区域扫描（语义 left<right、top>bottom） | `left/right/top/bottom` |
| `pcb.getPrimitiveAtPoint` | 点查 | `x`, `y` |
| `pcb.listLayers` | 列全部层 | 无 |
| `pcb.getCurrentLayer` / `pcb.selectLayer` | 查/切当前激活层 | select: `layer`（ID 或 top/bottom） |
| `pcb.setCopperLayers` | 设铜层数（2/4/6…，⚠️ 改层数影响叠层，谨慎） | `count` |
| `pcb.setLayerVisible` / `setLayerLocked` | 层显示/隐藏、锁定 | `layers[]`, `visible?`/`locked?` |
| `addCustomLayer` / `removeCustomLayer` / `modifyLayer` / `setPcbType` | 自定义层与板型（刚性 NORMAL / 柔性 FPC；⚠️ 加删层触发文档重载，需重新 openDocument，守卫会自愈） | 层名/板型 |

- 官方把板框层图形自动转成 **Region**——重复/幽灵板框用 `getPrimitivesInRegion` 扫全板找 Region ID 再 `pcb.delete`。
- `getPrimitivesInRegion` **查不到丝印文字**（只返回 Line/Via/Pad/Region 等铜类）。
- **层参数严格化**：不认识的层名/层号一律报错（列出合法值），不静默回退；只有未传才用缺省。合法值：top(1)/bottom(2)/top-silk(3)/bottom-silk(4)/top-mask(5)/bottom-mask(6)/top-paste(7)/bottom-paste(8)/top-assembly(9)/bottom-assembly(10)/outline(11)/multi(12)/document(13)/mechanical(14)/inner1~32(15~46)/custom1~200(71~270)，数字字符串亦识别。
- 层叠配置管理（多层板）见附录 ⑥。

## ④ 检查与导入导出

| 指令 | 说明 |
| --- | --- |
| `pcb.runDrc` | DRC |
| `pcb.runDrcDetailed` | 逐条明细（官方树形分组，插件拍平提 type/rule/message/net/primitiveId/x/y，raw 保留原样，聚合 fatalCount/warnCount） |
| `pcb.importChanges` | 从原理图导入（⚠️ 弹对话框，需用户点「应用修改」） |
| `pcb.save` | 保存（⚠️ 无修改时官方返回 false，非失败） |

- **原理图有致命 DRC 时 `importChanges` 静默返回 false**——导入前必须清到 0 致命。
- 导入后 `listComponents`+逐器件 `getComponentPads` 比对焊盘网络与网表。
- `runDrcDetailed` 偶发超时一次后自恢复——先重试，勿判插件失效。`editor.openDocument` 切页偶发超时同理。
- `project.renameBoard` 按名字匹配，重名会改错——改名前先 `project.getBoardInfo`。

## ⑤ 图元读改

| 指令 | 说明 |
| --- | --- |
| `pcb.modifyLine`/`modifyVia`/`modifyPour`/`modifyString` | 改线/孔/铺铜/丝印（分步+读回验证），均实测 |
| `pcb.placeString`/`listStrings` | 丝印放/读 |
| `pcb.getPrimitivesInRegion`/`getPrimitiveAtPoint` | ⚠️ 查不到丝印文字；区域语义 left<right、top>bottom |

## ⑥ 低频附录（用到再查）

### 等长组管理

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.createEqualLengthGroup` | 建等长组 | 组名/网络名 |
| `pcb.listEqualLengthGroups` | 列全部等长组 | 无 |
| `pcb.addNetToEqualLengthGroup` / `removeNetFromEqualLengthGroup` | 组内增删网络 | `name*`, `nets*` |
| `pcb.renameEqualLengthGroup` | 改名 | `oldName*`, `newName*` |
| `pcb.deleteEqualLengthGroup` | 删除组 | `name*` |

### 层叠配置（多层板叠层设置入口）

读改写闭环：`getStackingConfig` 读回 → 改 `configuration` 对象 → `applyStackingConfig` 写回。

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.listStackingConfigs` | 列全部层叠配置（含当前生效与默认配置名） | 无 |
| `pcb.getStackingConfig` | 读指定配置完整定义（层序/厚度/介质；不传 name 读当前生效；⚠️ 双层板 list 空、get null 是官方行为） | `name?` |
| `pcb.applyStackingConfig` | 配置对象应用到当前 PCB | `configuration*` |
| `pcb.saveStackingConfig` | 另存为命名配置 | `configuration*`, `name*`, `allowOverwrite?` |
| `pcb.renameStackingConfig` / `deleteStackingConfig` / `setDefaultStackingConfig` | 改名/删除/设为默认 | rename: `oldName*`,`newName*`；delete/setDefault: `name*` |

### 实时 DRC

| 指令 | 说明 |
| --- | --- |
| `pcb.startRealTimeDrc` | 开实时 DRC（布线即时报违规；⚠️ 官方 @beta） |
| `pcb.stopRealTimeDrc` / `getRealTimeDrcStatus` | 关/查状态（需 EDA v4.2+，低版本恒返回 enabled:false） |

## ⑦ 自动布线闭环（FreeRouting）

⚠️ **标准工艺流程（电源先行）**：① AI 用 `pcb.routeTrack`/`pourCopper` 按知识库规则布完电源主路径 → ② `pcb.setNetLock` 锁定电源网络（回灌会清除全部**未锁定**走线/过孔，不锁就被冲掉）→ ③ `pcb.autoRouteStart` 启动 → ④ `pcb.autoRouteStatus` 轮询（完成自动回灌+DRC）→ ⑤ AI 审查走线，不合理的局部 `pcb.delete`+`routeTrack` 重修。

前置：本地 FreeRouting V2.2.3+ 服务运行（端口 37864），可跑 `bridge/start-freerouting.bat` 一键拉起。

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.setNetLock` | 锁定/解锁指定网络的全部走线/过孔/圆弧（布线前保护电源线） | `net` 或 `nets`, `locked?` |
| `pcb.autoRouteStart` | 启动自动布线（导出 DSN→FreeRouting 服务→启动任务） | `maxPasses?`, `viaCosts?`, `maxThreads?`, `skipDrc?` |
| `pcb.autoRouteStatus` | 查进度；COMPLETED 时自动清未锁定走线+回灌 SES+DRC，返回统计 | `jobId?`, `noImport?` |
| `pcb.autoRouteStop` | 停止任务（保留当前结果） | `jobId?` |
