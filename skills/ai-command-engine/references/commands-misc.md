# 低频指令附录（32 条，0.10.62 口径）

不在主文档详表里的低频指令，按对象分组一句话说明。**参数细节一律 `GET /help?cmd=<名>` 在线查**，别猜。

## 原理图补充

| 指令 | 说明 |
| --- | --- |
| `schematic.getPrimitiveAtPoint` | 查询指定坐标处的图元（返回 id+类型），排查"这个位置是什么" |
| `schematic.setAttribute` | 改器件属性（如位号 R?→R4，key=Designator）。⚠️ 只能改已存在属性；Footprint 别写裸名/空串（见 pitfalls G1/G2） |
| `schematic.autoRoute` | ⚠️ **薄封装官方整页自动连线，未加防护**——可能大面积打乱已有走线，生产环境别用；整理已有图用 `autoLayout` |

## lib 库管理（⚠️ 全族记住：modify 后 uuid 可能变化——0.10.62 起三个 Modify 已内置回查，返回 `uuid/uuidChanged/verify`；Copy/Delete 仍信返回值，失败按名复核）

| 指令 | 说明 |
| --- | --- |
| `lib.symbolGet` / `lib.symbolModify` / `lib.symbolCopy` / `lib.symbolDelete` | 符号四操作（Modify 0.10.62 起带 uuid 回查） |
| `lib.footprintGet` / `lib.footprintModify` / `lib.footprintCopy` / `lib.footprintDelete` / `lib.footprintUpdateSource` | 封装四操作+源码写回（Get 对不存在 uuid 会 reject 而非返空，报错≠丢了，按名搜） |
| `lib.deviceGet` / `lib.deviceCopy` / `lib.deviceDelete` | 器件三操作（目标库重名会失败） |

## PCB 层/铺铜/过孔/文字

| 指令 | 说明 |
| --- | --- |
| `pcb.addCustomLayer` / `pcb.removeCustomLayer` | 自定义层增删（CUSTOM_1=71 起，只能删 CUSTOM 层） |
| `pcb.modifyLayer` / `pcb.setLayerLocked` | 改层属性（名/类型/颜色/透明度）/ 锁定层 |
| `pcb.listPours` / `pcb.modifyPour` / `pcb.rebuildPour` | 铺铜查/改/重铺（listPours 可按网络/层过滤） |
| `pcb.listVias` / `pcb.modifyVia` | 过孔查/改（网络/位置/孔径/外径） |
| `pcb.listStrings` / `pcb.modifyString` / `pcb.placeString` | PCB 文字（丝印）查/改/放 |
| `pcb.setPcbType` | 板子类型（刚性 NORMAL / 柔性 FPC） |

## PCB 网络类/差分/层叠低频项

| 指令 | 说明 |
| --- | --- |
| `pcb.deleteNetClass` / `pcb.removeNetFromClass` / `pcb.renameNetClass` | 网络类删/移出/改名 |
| `pcb.deleteDiffPair` | 删差分对（建/查见 commands-net.md） |
| `pcb.deleteStackingConfig` / `pcb.setDefaultStackingConfig` | 层叠配置删/设默认（建/应用见 commands-pcb.md） |
| `pcb.removeNetFromEqualLengthGroup` | 网络移出等长组 |
| `pcb.getNetPrimitives` | 查网络上的全部图元（走线/过孔/焊盘） |

## 维护说明

新指令默认先进主文档（commands-*.md）或本附录；本附录指令升主文档后从这里删除。文档覆盖率可用工作区 `t_docdiff.py` 核对（差集应只剩误报）。
