# PCB 扇出与自动局部铜皮

> 两项操作都先生成只读计划，再将完整计划对象传给对应执行命令。外层 `/command` 仍需带当前 PCB 窗口的顶层 `instanceId`；连接和请求格式见 [setup.md](setup.md)。所有长度与坐标使用 mil。

## 指令

| 指令 | 用途 | 参数 |
| --- | --- | --- |
| `pcb.getFanoutPlan` | 只读规划焊盘扇出线和通孔 | `padIds?`、`componentIds?`、`net?` 三选一；方向、层及尺寸参数见下文 |
| `pcb.fanout` | 执行扇出计划 | `plan`：`pcb.getFanoutPlan` 返回的完整对象 |
| `pcb.getAutoCopperPlan` | 只读规划局部覆铜或固定填充 | `targetIds`、`layer` 必填；`net?`、`expansion?`、`generationType?`、倒角选项可选 |
| `pcb.autoCopper` | 执行自动局部铜皮计划 | `plan`：`pcb.getAutoCopperPlan` 返回的完整对象 |

先规划并检查 `executable`、目标、网络、层、几何、警告和覆盖信息。`executable:false` 时不得提交执行命令。计划包含 `documentUuid`、`operation`、`units`、`inputs`、设计源码和 DRC 规则 `baseline`、`targets`、`groups`、`plannedPrimitives`、`coverage`、`warnings` 与 `provenance` 等内容。执行命令要求原样提供完整计划；不要只拼出部分字段。

执行前会核对 PCB 焦点、文档身份、源码与规则基线，并根据当前对象重算目标和几何计划；与提交计划不符就拒绝写入。每个 SDK 操作依序执行并核对焦点。写入结果逐项读回；失败时停止后续步骤，回执说明已创建/已核验项目和未执行步骤。命令不自动保存、回滚或重试；失败后先只读检查现场，再决定是否保存或继续。

## 焊盘扇出

`padIds`、`componentIds`、`net` 必须且只能指定一类目标。`direction` 可用 `auto`、`8directions` 或 `N`、`NE`、`E`、`SE`、`S`、`SW`、`W`、`NW`；缺省为 `auto`。`auto` 与 `8directions` 都会尝试八个方向并选择可用的较短路线。`staggerLength` 为相邻目标的参差距离，缺省为 0 mil。

必须明确提供 `lineLength`、`lineWidth`、`viaDiameter`、`holeDiameter` 和 `clearance`，单位均为 mil；当前没有核实可统一适用的 DRC 规则字段，不会从规则结构猜默认值。缺任一数值、孔径不小于过孔外径、几何/网络/层数据不完整或搜索无结果时，计划不可执行。多层或通孔焊盘必须明确 `layer: "top"` 或 `"bottom"`；顶/底 SMT 焊盘保留其实际铜层。工具按当前实现创建通孔，不能把结果当作盲孔或埋孔扇出。

受支持的椭圆、长圆和圆角矩形焊盘按不大于 10 度的角度步长采样，并按弓高误差向外保守膨胀；这不代表所有曲线焊盘均受支持。焊盘复杂多边形中的 `C`/`ARC`/`CARC` 曲线、曲线铜面或区域，以及弧形板框或板内孔边界当前不可安全解析，会使计划不可执行。单独的圆弧走线可按弓高误差膨胀后作为障碍处理。

计划会返回目标焊盘的真实坐标、网络与层、路线分组、拟创建线段/过孔、候选搜索次数及限制状态。搜索每个方向最多检查 20,000 个候选；若达到上限，`coverage.searchLimited` 与组内状态会显示受限。缺少完整障碍、板框、禁布区或目标形状数据时，不应把部分几何当作安全路线。仅选网络意味着选中该网络的目标焊盘来扇出，不代表该网络已全部连通。

执行按计划逐段新建线与通孔，并按图元 ID 读回网络、层、坐标和尺寸。成功回执含 `createdIds`、`verifiedIds`、逐项 `readback` 及 `saved:false`。这只确认新图元与计划相符，不代表 DRC 通过、网络完整连通或制造验收。

## 自动局部铜皮

`targetIds` 是必填、不重复的图元 ID，可指焊盘、过孔或器件；器件会展开为焊盘。`layer` 必须明确为 `top` 或 `bottom`。`net` 可选，用于按网络筛选目标。`expansion` 为外扩 mil，缺省 5；`generationType` 为 `pour` 或 `fill`，缺省 `pour`。倒角选项为 `enableChamfer`（默认 `false`）、`chamferType`（默认 `straight`）和 `chamferWidth`（默认 5 mil）。

计划按网络和目标铜层分组，分别生成多边形，不把不同网络合并为同一片。普通 SMT 焊盘不会投影到另一面。计划列出已选和排除目标、各组几何、实际边界/间距/裁剪处理、规则信息、诊断与退化说明；不完整的对象或规则数据、未解析几何及冲突会使计划不可执行。边界生成和避让沿用 `JLCEDA/eext-auto-copper-shape` 的相关几何链，但计划不是完整板级 DRC 结论：目标附近有未处理圆弧时计划不可执行；只接受已核验的闭合单环线板框，多环或弧线板框不可执行。阅读 `coverage` 和 `warnings`，不要把有限覆盖说成完整制造检查。

默认 `generationType: "pour"` 会逐组创建覆铜边框、重建填充并读回新填充图元；成功结果区分几何读回、覆铜顺序源码读回和填充读回。`generationType: "fill"` 创建固定填充几何并读回，不执行覆铜边框重建流程。执行不自动运行 DRC，也不自动保存。部分失败不自动撤销已创建的图元。

## 来源

- 扇出算法来源：`JLCEDA/eext-pad-fanout`，commit `7c88e571457e6d63463b7cb391e1e62bdbdd02d7`。
- 自动局部铜皮算法来源：`JLCEDA/eext-auto-copper-shape`，commit `98317b6b5941977a3ae90948a05295f9d8b1169f`；许可证为 Apache-2.0。规划复用边界、规则和裁剪处理，原扩展界面与其 SDK 写入路径不作为本命令执行路径。
- 本地 0.10.93 候选；本页不代表已经安装或通过真实宿主、保存关闭重开验收。
