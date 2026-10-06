# 网络类·差分对·生产导出（PCB）

层管理/层叠/等长组/实时 DRC 已并入 [commands-pcb.md](commands-pcb.md) ③⑥，本文只留信号与生产。

## 网络类（NetClass）与差分对

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.createNetClass` | 建网络类（一组网统一设规则/颜色） | `name`, `nets[]`, `color?` |
| `pcb.listNetClasses` / `deleteNetClass` / `renameNetClass` | 列出/删除/重命名 | delete/rename: `name` |
| `pcb.addNetToClass` / `removeNetFromClass` | 网络类增删成员 | `netClass`, `nets[]` |
| `pcb.createDiffPair` | 建差分对（USB D+/D- 等） | `name`, `positiveNet`, `negativeNet` |
| `pcb.listDiffPairs` / `deleteDiffPair` | 列出/删除 | delete: `name` |
| `pcb.getNetRules` | 读当前设计规则中的网络规则（线宽/间距等，**只读**——写入接口结构复杂暂未开放） | 无 |
| `pcb.getNetLength` | 网络已布线总长度（等长检查用） | `net` |
| `pcb.getNetInfo` / `getNetPrimitives` | 网络详细信息 / 网络上全部图元（走线/过孔/焊盘） | `net` |
| `pcb.highlightNet` | 高亮/取消高亮网络（排查用） | `net` 或 `all:true`, `highlight?` |

## 生产导出（base64 自行落盘）

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.exportGerber` | Gerber 打板文件（通常 zip） | `fileName?` |
| `pcb.exportPickPlace` | 贴片坐标（Pick&Place） | `fileName?`, `fileType?`(xlsx\|csv), `unit?`(mm\|mil) |
| `pcb.exportDsn` | Specctra DSN（外部自动布线第一步：`exportDsn` → 外部布线器 → `importAutoRouteSes` 导回） | `fileName?` |
| `pcb.exportNetlist` | PCB 网表 | `fileName?`, `netlistType?`（如 Protel2） |

## 选择/交叉探针

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `pcb.select` / `pcb.clearSelection` / `pcb.getSelection` | 按 ID 选中/清空/读当前选择 | select: `primitiveIds[]` |
| `pcb.crossProbe` | 交叉探针：位号/引脚/网络在原理图↔PCB 间联动定位（高亮+选中） | `components?`/`pins?`/`nets?`, `highlight?`, `select?` |

## 原理图杂项补充

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.autoRoute` | 原理图自动连线（官方引擎；⚠️ 官方能力，AI 批量场景仍优先 batchWire/buildBlock，失败再考虑它。**与批量引擎的差异**：autoRoute 是官方引擎按几何走线风格自动连，批量语义化引擎是 labelWire/linkWire 短桩+标签 / U 形无名线——两套风格，混用同一张图纸会乱；批量一律 batchWire/buildBlock，autoRoute 仅作失败兜底，且不保证按语义网名走线） | `uuids?`（参与连线的器件 uuid，留空=全部） |
| `schematic.setPinNoConnect` | 给引脚打/取消 X 非连接标识（消除悬空引脚 DRC 提示） | `componentId`, `pinNumbers[]`, `noConnected?` |
| `schematic.getAttributes` / `setAttribute` | 读/改图元属性（key=Designator/Value/Footprint 等） | `primitiveId`（set 再加 `key`,`value`） |
| `schematic.getSelection` | 读当前选中的图元 | 无 |
| `schematic.exportBom` | 导 BOM（xlsx/csv，base64） | `fileName?`, `fileType?` |
| `schematic.exportPng` | 导原理图 PNG（单边最大 4096px） | `fileName?`, `width?`/`height?` |
| `schematic.listNets` | 原理图全部网络（`detail:true` 带导线明细） | `detail?` |

## 调试

- `system.eval`：扩展上下文执行任意 JS（全局 `eda` 可用、支持 await）。**正常操作禁用**，仅排障；沙箱可能禁 eval（见 pitfalls §8）。
