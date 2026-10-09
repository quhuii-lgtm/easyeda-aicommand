# 嘉立创下单检查（PCB DFM）

> P11 版本提示：0.10.90 曾出现 DFM 入口异常；0.10.91 已在指定 PCB 的命令调用中实机复验生成 18 项结果，菜单 iframe 与导出仍待实机验收。0.10.91 源解析显示外/内层均为 1oz，这是图纸读数，不能代替 0.10.92 的下单铜厚输入。

> 本页说明 `pcb.runDfm`、`pcb.runSmtDfm`、`pcb.checkSameNetPadSpacing` 及 PCB 菜单“嘉立创下单检查”。命令经现有 `/command` 通道执行；请求外层仍须带 `instanceId`。

## AI 命令

| 命令 | 必需参数 | 检查范围 |
| --- | --- | --- |
| `pcb.runDfm` | `material`、`thickness`、`outerCopperOz`、`innerCopperOz` | PCB 18 项检查。板材须精确使用 `FR4`、`HDI板`、`高频板`、`铝基板`、`铜基板` 之一；板厚单位 mm，须为有限正数；外层铜厚须为数字 `1` 或 `2`，内层铜厚须为数字 `1`。缺参或其他铜厚值拒绝。铜厚按本次下单输入选档，不从图纸或默认值代填 |
| `pcb.runSmtDfm` | `standard`、`thickness` | SMT 7 项检查；`standard` 为 `economy` 或 `standard`；厚度单位 mm，须为有限正数 |
| `pcb.checkSameNetPadSpacing` | `minSpacingMm` | 同网络焊盘间距 1 项检查；间距单位 mm，须为有限正数 |

板材枚举以复用的上游 core 导出 `JLC_SUPPORTED_MATERIALS` 为准。检查实现复用[上游项目](https://github.com/easyeda/eext-jlc-order-dfm-checker) v1.0.4，来源提交 `afd538786d510f537ad4fa47c6329e6a99dc7625`，许可证 Apache-2.0。没有新增依赖；工艺参数表及几何算法来自该上游版本，不表示与嘉立创网站当前工艺实时同步。上游 v1.0.4 原接口只有板材与板厚；`outerCopperOz`、`innerCopperOz` 是本地增强字段。本次仅支持外层 1/2 oz、内层 1 oz，不代表厂家全部工艺选项。

`pcb.runSmtDfm` 与 `pcb.checkSameNetPadSpacing` 不增加铜厚输入。菜单中的 PCB DFM 表单由用户明确选择外层 1 或 2 oz、内层 1 oz；这些选项仅适用于 PCB DFM。

使用前须确认已安装 0.10.92 或后续含此增强的版本，并在在线命令帮助中看到这两个铜厚参数。旧版 0.10.91 不支持它们，可能忽略额外字段；仅向旧版请求添加参数不能证明已按本次铜厚检查。新报告必须回显 `inputs.outerCopperOz`、`inputs.innerCopperOz` 及 `reportedCopper`。

## 返回与完整性

命令成功回包的 `data` 中保留 `results`、`expectedCount`、`issues` 和 `coverage`；`issues` 项包含 `code`、`message` 和可选 `item`。`data` 另含 `documentUuid`、`checkType`、`inputs`、`timestamp`、`upstream` 及汇总字段 `upstreamPassed`、`complete`、`passed`。`upstreamPassed` 为兼容保留的字段名，表示复用并适配后的各项结果是否全部为 `success`；不表示官方在线服务已通过，也不表示算法逐行保持原样。菜单与 TXT 将其标为“逐项检查通过”。单项检查通过不等于整项检查通过；只在 `complete:true` 且 `passed:true` 时可报告该命令覆盖范围内通过。`complete:false` 必须同时为 `passed:false`。命令回包 `ok:true` 只代表处理器成功返回，不代表 `data.passed:true`。

三类检查分别保留预期的 18、7、1 项原始结果。若用于本次检查的必要输入不完整、读取失败或使用回退/推断值，适配层会标记未完整，不能报告完整通过。例如源码读取失败、网络数据只部分可读、焊盘尺寸缺失或无板框而使用回退，都不能变成通过结论。铜厚请求参数不会默认；图纸源铜厚按下一节单独处理。查看 `coverage`、完整性标记及 `upstream` 说明，勿只看 `passed` 或问题数。

## 下单铜厚输入与图纸读数

`pcb.runDfm` 以本次输入的铜厚选档检查支持性：第 5 项检查所选外层铜厚，第 6 项检查所选内层铜厚；第 12/13 项根据设计铜层及设计层数，分别使用外层或内层所选铜厚从原工艺表取阈值。工艺表数值和几何算法不变；其他检查中的有效铜层数量仍按原有含铜图元启发式判断。

PCB 结果另含 `reportedCopper`，与 DFM 判定分开：`status` 为 `available`、`partial` 或 `unavailable`；`layers` 为 `[{layerId:number, thicknessMil:number|null, copperOz:number|null}]`；`matchesTarget` 为布尔值或 `null`；`differences` 为 `[{layerId, requestedOz, reportedOz}]`；`messages` 为铜厚源采集诊断字符串数组。请求铜厚仍列在 `inputs`；检查标准值反映本次外/内铜厚输入及对应阈值。

图纸铜厚与本次输入不一致、缺少 `LAYER_PHYS` 记录或无法解析时，只在 `reportedCopper` 表示，不单独加入 `issues`，也不因此把 DFM 判为失败。若源读取异常影响必要几何、身份或 API 数据，则仍须按既有规则进入 `issues` 并令检查不完整，不能被铜厚旁证豁免。0.10.91 实机报告中的图纸外/内 1oz 是源读数，不代表用户下单请求了 1oz；差异本身也不构成 DFM 失败。

## PCB 菜单行为

PCB 顶部“嘉立创下单检查”菜单提供上述三项检查，与 AI 命令共用同一检查处理和结果汇总。菜单可显示逐项结果及问题位置；用户点击“导出TXT”或“导出JSON”后，宿主保存对话框用于选择报告保存位置。AI 命令不弹窗、不清日志、不自动写报告；命令执行本身不保存、修复、上传或下单。定位是辅助查看，不会修改图纸。

菜单或命令开始后若当前焦点或 PCB 身份变化，后续读取及报告交付会停止。定位前先核对目标 PCB 与当前板一致；不要把另一板上的坐标用于定位。旧 DFM 窗口会话失效时，关闭旧窗口并从 PCB 菜单重新打开。菜单表单、AI 命令及 TXT/JSON 导出应显示相同的 `inputs`、外/内层阈值和 `reportedCopper` 对照。

## 检查边界

这些检查复用上游插件的参数表和算法，不是嘉立创在线 DFM 服务的全量检查，也不是可制造性放行。当前几何覆盖有明确近似：线间距只计算 `Line` 的正间隙，不覆盖接触、重叠、`Arc` 或 `Polyline`；长圆及不等边焊环按最大轴近似；同网焊盘间距采用胶囊体和内接圆近似；有效铜层按存在铜图元的层启发式计算；EIA/BGA 类型依据名称识别。定位 ID 由两组列表索引辅助匹配，问题位置可能有偏差；菜单定位仅辅助查看，不能自动改图。请把原始结果和 `coverage` 一并交由工程人员审阅。

0.10.90 曾通过核心 20/20、命令/菜单 8/8、owner 17/17、client 32/32 本地回归和类型检查，随后真实宿主发现 P11 入口错误。0.10.91 针对词法 SDK 入口重跑命令/菜单 8/8、owner 17/17 与类型检查通过；未变的核心与 client 沿用原证据。2026-10-09 在 PCB3_1 以 FR4/1.6mm 完成命令实机复验：18 项结果返回，图纸源铜厚外/内均读为 1oz，丝印项报错且25个焊盘网络未确定，因此 complete=false、passed=false；检查前后非文档头源内容一致。该图纸读数不代表下单请求值。0.10.92 铜厚输入与图纸对照已通过本地核心31/31、命令/菜单8/8、owner 17/17与类型检查，独立审查闭合；真实宿主命令对照已完成（见下）；菜单表单、定位和导出对话框此前未实机验收。

2026-10-09 安装版0.10.92在PCB3_1（FR4、1.6mm、设计4层）只读对照通过：外2/内1时线宽/线距门槛为外0.15、内0.09mm，线距项报21条违规记录；外1/内1时门槛均为0.09mm，线距项通过。两次均返回18项，图纸源铜厚均为1oz并独立列对照，25个焊盘网络未确定及丝印问题仍在，complete=false、passed=false。两次检查前后非DOCHEAD源内容相同；菜单定位与导出对话框未实机验收。
