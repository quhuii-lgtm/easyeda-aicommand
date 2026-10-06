# 原理图指令全表

四组：**① 批量生成整理（第一入口）→ ② 基础指令 → ③ 修复维护 → ④ 查询检查导出**。完整陷阱见 [pitfalls.md](pitfalls.md)。

## ① 批量生成与整理（第一入口）

### `schematic.buildBlock` — 从零生成功能区

器件清单+连接表 → 自动区框（默认 0,0 起、黑虚线，可 color/lineType）→ 行列排布（cw32 模板横距 60 行距 90，标题框底居中字号 20）→ 按 nets 连线 → 网表+DRC 自查。

| 参数 | 说明 |
| --- | --- |
| `components` | 器件清单（lcscId + 自定义 `ref`） |
| `nets` | 连接表，引脚用清单里的 `ref`（"U1.7"，**不是 EDA 自动位号**；插件做 ref→位号映射，返回 `refMap`） |
| `region?` `title?` `color?` `skipAudit?` | 区框起点/标题/颜色/跳过网表审计 |

- 用户 ref 自动落为真实位号（"R?" 改写+读回验证，失败带 `designatorNote`）。
- 连线走 batchWire 引擎：2 引脚非电源网 → link 无名 U 形线；≥3 引脚/电源网（VDD/VCC/GND 及**全大写下划线后缀**如 VDD_T、VOUT_5V；小写后缀算信号）/显式 `style:"label"` → 每引脚 label 短桩。per-net color 透传。
- 逐条收错不中断 + 一次网表统一审计（明细 `wireAudit`）。**必看返回**：`refMap`、`designatorNote`、`incomplete`/`failed`/`wireAudit`。
- 规则式网格排布，约 80 分美观；生成后可 `moveComponent` 微调。

### `schematic.autoLayout` — 整理已有功能区

已放好的器件重排+重建连线。`designators` 或 `region` 二选一框定器件。

流程：导网表取连接表（NC/悬空跳过）→ 网络聚类贪心排序+行列排布（横距 60 行距 90，`template` 可改）→ 移动器件（官方 modify 读回验证）→ **rewire（默认开）**：删碰旧引脚的导线（级联删标签）+清浮标+连接表转 batchWire 重建。

- **dryRun 默认 true**：只出方案（plan 旧→新坐标；connections 连接表+link/label 风格），确认后 `dryRun:false` 才动。真跑不可逆，**跑前保存工程**。
- 官方移动器件后旧导线/标签不跟随（实测）；rewire 是删旧重建不是平移。
- rewire：link 直连先于 label；删线前按全页引脚分类——纯内部线照删；带 1 外部引脚的线删后自动补网（`externalRewired`）；穿 ≥3 引脚的复杂长线保留（`skippedWires`，可能留悬线需人工复核）；link 重建因穿第三方引脚失败自动降级两端 label（`fallbacks`）；仍未恢复进 `rewireFailed`（旧线已删、网断，须人工修）。
- 跑完看 `moved`/`moveFailed`/`rewired`（含 wireAudit）/`drc`，并目测画布。
- 分工：**buildBlock 从零生成；autoLayout 整理已有**。

### `schematic.batchWire` — 批量连线

一次提交 label/link 混合项：`items:[{type:"label",pin,net,color?},{type:"link",pins,color?,jogDir?}]`。

- 逐条执行逐条收错，最后一次网表统一审计——比逐条调快数倍。
- 网表是缓存快照：任一项未过则等 800ms 重导，最多 5 次取末次。
- **只报告不自动修复**：audit 失败项按 `audit.detail` 处置后重跑该项。
- 审计未过的项即使执行 ok 也进 `failed`（带实际网名）。
- `continueOnError?` `skipAudit?` 可选。

## ② 基础指令（第二入口）

### 语义化连线（单条也可用）

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.labelWire` | **单引脚接入命名网**：沿引脚朝向外画短桩+放同名标签（防呆+附着验证）。必须带网名只接 1 脚 | `pin`("U1.7"), `net`, `color?`, `force?`, `stubLen?` |
| `schematic.linkWire` | **正好 2 引脚物理连通**：U 形正交走线，横腿动态避让防共线合并。必须 2 脚不带名（要命名用 labelWire） | `pins`(["U1.7","C1.1"]), `color?`, `jogDir?`, `force?` |

- 两指令互斥（1 脚带名 vs 2 脚无名），根治"短线已有网名又叠同名标签"事故。
- 短桩默认长 60（容纳 STATUS_LED 级长网名右伸不压本体；`stubLen` 可覆盖，最小 20，不自适应）。
- **标签 rotation 恒 0、锚点恒在桩末端**。附着判定看锚点，锚点须在导线上，离线外 5 单位即浮标；rotation 180=反字（装机实锤）。朝左场景用位置偏移，不要旋转。
- 文字宽度估算 **4.4×字符数+5 单位**（数字/下划线略宽，宁高估）。
- **占用预检**：引脚已被同名网占用直接复用；异名占用拒绝（防串网）；`force:true` 强并。
- **整段路径避让**：短桩/横腿全段 8 单位内有任何引脚即换向；linkWire 全部候选（U 形 8 层+L 形 2 变体）逐段查引脚（两端点豁免），无解抛 `PIN_CROSSING_FALLBACK`。
- **NC 引脚禁止接线**：预检中文报错，不强画。
- 附着验证失败快速返回 `attached:false`（最多 2 次 500ms 重试）。

### 放置与绘制

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.placeDevice` | 放器件（默认进 BOM 和 PCB） | `lcscId` 或 `deviceUuid`+`libraryUuid`, `x`, `y`, `rotation?` |
| `schematic.connectPin` | 底层单脚连线：引脚尖端外 30→引脚原点，端点落原点即连通。**普通场景优先 labelWire** | `primitiveId`, `pin`, `net` |
| `schematic.drawWire` | 画导线（折点数组；自动拆段+去重+智能命名；支持 color/lineWidth/lineType） | `points`, `net?`, `color?`, `lineWidth?`, `lineType?` |
| `schematic.placeNetLabel` | 放网络标签（**自动验证附着**；同名防呆） | `net`, `x`, `y`, `noVerify?`, `force?`, `rotation?` |
| `schematic.placeText` | 注释文本（非电气） | `x`, `y`, `content`, `fontSize?` |
| `schematic.placeRegion` | 区框+标题一步（标题自动框内左上，返回 span） | `x`, `y`, `width`, `height`, `title`, `color?`, `lineType?`, `fontSize?` |
| `schematic.moveComponent` | 移动/旋转/镜像（内部分步+读回验证） | `primitiveId`, `x?`, `y?`, `rotation?`, `mirror?` |
| `schematic.moveLabel` | 移动网络标签/属性 | `primitiveId`, `x`, `y` |

- **drawWire 带 net 会自动在导线中点落一个 NET 属性标签**（与 placeNetLabel 两套，同网并存即重复；它是导线持有属性，官方不支持单独删）——要标签收尾：**drawWire 不传 net + placeNetLabel 放标签，别两边都命名**。命名成功返回 `namingNote`。
- drawWire 智能命名：该网已在页面存在则自动画无名段。
- connectPin 别让导线探入器件本体侧（端点落引脚线中段→T 形结点红点+"单网络"警告）；EDA 只认与引脚线段非零重叠的导线——端点对端点重合、网标直贴引脚都报致命"引脚端点重叠且未连接"。
- **共线合并陷阱**：官方自动把几何共线重叠/相接的导线合并——勿画穿中间引脚的长直线（会把中间引脚并进网）；勿让不同网的导线/短桩/横腿共线重叠（串网）。批量指令内部已防，手画 drawWire 同样避开。
- placeNetLabel：标签压线体上会被拒（自动 ±2 微偏重试）；未附着**不再自动删**，返回 `attached:false`+建议（`noVerify:true` 跳过）；附近导线已有该网名拒绝（`force:true` 强放）；rotation 恒 0。
- 网格吸附：坐标取 10 的倍数，否则 DRC 报"网络图元不在格点上"。

### 修改类

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.setWireNet` | 改导线网名（modify 后强制读回，返回 `readback:{net,verified}`） | `primitiveId`, `net` |
| `schematic.modifyWire` | 改颜色/线宽/线型/网名（可按网名批量，如 3V3 全网标红） | `primitiveId` 或 `net`, `color?`, `lineWidth?`, `lineType?`, `newNet?` |
| `schematic.modifyNetLabel` | 改颜色/位置/改名/**文字方向**（可按网名批量） | `primitiveId` 或 `net`, `color?`, `newNet?`, `x?`, `y?`, `rotation?` |
| `schematic.modifyText` | 改注释文本 | `primitiveId` |
| `schematic.modifyRect` | 改位置/尺寸/样式（y 也是上沿） | `primitiveId`, `x?`, `y?`, `width?`, `height?` |

- 官方 modify 多字段合并改会整体失效（实测"位置+旋转"同传→什么都没改）——插件已**原子化拆分**（每字段独立步骤+逐步读回，不符挪 failed 带实际值），调用侧多字段照传。
- 官方 modify 有假失败也有假成功——凡修改，成败以读回/源码重扫为准。
- 镜像/rotation 180 都反字——正常标签 rotation 0、锚点压导线；官方属性接口不支持 mirror，被镜像的标签只能转正或删了重放。

## ③ 修复维护（出问题再用）

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.pruneFloatingLabels` | **【宏】清浮空标签**（附着残留、删线孤儿） | `dryRun?`, `batchSize?`, `allowSourceRewrite?` |
| `schematic.fixNetLabels` | **【宏】标签全科体检**：①浮空 ②重复 ③反字 ④位置不对 | `dryRun?`, `angle?`, `net?` |
| `schematic.repairNet` | **碎网修复宏**：审计→收养无名残线→补标签→网表前后对比 | `net`, `adoptWireIds?`, `dryRun?` |
| `schematic.dedupeWireNets` | 清"导线多个网络名"警告（仅历史图纸） | 无 |
| `schematic.delete` | 删图元（批量；先识别类型+删后读回+终扫对账） | `primitiveIds`, `batchSize?` |
| `schematic.deleteTextViaSource` | **【实验性·TEXT 专项】**官方 TEXT delete 不落盘（0.10.53/54 实测删后复活），本指令走源码 append-only 墓碑删除 | `primitiveIds*`, `save?` |

- **浮空标签（parentId=$$root）官方删除盲区**：属性图元不支持删除（@internal），主通道**借尸还魂**（建临时导线→modify 挂 parentId→删导线级联带走→源码重扫验证）；官方 modify parentId 有假失败——以走完后的源码重扫为准。
- pruneFloatingLabels：dryRun 返回每个浮标世界坐标（**Y 已翻成 API 坐标**，便手动框选兜底）。每条 8s 熔断、连 3 败熔断整批、`batchSize` 默认 5（批间停 300ms，看 `batches`/`unprocessed` 分批续删，**不要调大硬跑**）。**大批量分多次跑**。
- **文档源码改写默认禁用**（实机事故：离线字节级验证过 ≠ 运行时安全，官方写回有格式校验弹窗拒绝）：仅 `allowSourceRewrite:true` 才执行（最后手段），返回带 `warning`，操作前保存工程。全失败返回 `manualDelete` 世界坐标清单。
- **会话损坏迹象**：创建类指令（drawWire/placeNetLabel/placeText/placeDevice/labelWire/linkWire）突然全 `create failed!` 或超时而读类正常 → 判定损坏；不空跑（插件连 3 败自动熔断）；**不保存直接关页面重开**即可还原，重开后分批继续。
- fixNetLabels：**dryRun 默认 true 只出四类体检报告**（id/net/世界坐标/问题/建议），确认后 `dryRun:false` 真修，逐条收错，修完自动 pruneFloatingLabels 复核。四类：浮空（parentId=$$root，DRC 来源）；重复（同线同网名>1 或锚点距<10）；反字（rotation 180）；位置不对（锚点离线>20 或导线戳出悬空端点）。
- repairNet：人工拖标签致网断后用它收尾；流程另见 pitfalls.md。
- **delete 加固**：官方 delete 对类型不匹配甚至不存在的 ID 也可能返回 true——插件先识别真实类型、删后读回、整批后**终扫对账**（超时但后台已删的挪 `deleted`，`reconciled` 注明）。逐项 8s 熔断、连 3 败熔断整批、`batchSize` 默认 10、全局预算 100s、`unprocessed` 可续删。**大批删除保持默认分批**。批末自动探针图元，返回 `sessionHealth:ok|degraded|inconclusive`——0.10.40 起探针加固（焦点复核+3 次重试+创建/删除读回+残留报 `probeResidue`）：`degraded`（创建 3 连败或删除异常）先用只读指令复核再决定【不保存重开页面】；`inconclusive` 是探针未得出可信结论（如焦点不在对应文档），不采信、删除结果本身已读回验证、不必停摆。**0.10.42 起返回带 `taskId`**：客户端超时时用 `task.get {taskId}` 查实时进度/补取结果（结果留 15 分钟）；同 ID 清单在跑时重发只回 `alreadyRunning` 进度不重复执行；全部收尾 await 已有超时保护，整批最坏 ~200s 必返回。
- 导线中点的 NET 属性标签**不支持单独删**（delete 报"删后仍在"是预期）——只能删整根导线重画。

## ④ 查询与检查导出

| 指令 | 说明 | 关键参数 |
| --- | --- | --- |
| `schematic.getPageInfo` | 图页信息+图框尺寸（titleBlock width/height，单位 10mil；titleBlockData 键决定 modifyTitleBlock 能改什么） | `pageUuid?` |
| `schematic.listComponents` | 列器件 | `allPages?` |
| `schematic.listPins` | 列引脚（编号/名称/坐标） | `primitiveId` |
| `schematic.listWires` | 列导线（读回自查） | `net?` |
| `schematic.listNetLabels` | 列全部网络标签（含 attached 和颜色——浮空标签就是 DRC"没有连接导线"来源；0.10.46 起查标签一律用本指令，listLabels 已删） | `net?` |
| `schematic.listTexts` | 列注释文本（0.10.46 起带 `offGrid` 格点标记，接替已删 listLabels 的"不在格点"排查） | 无 |
| `schematic.listRects` | 列全部矩形（返回归一化 `span:{x1,y1,x2,y2}`，布局计算一律用 span） | 无 |
| `schematic.checkRectOverlap` | 矩形两两重叠检查（输出带 span） | 无 |
| `schematic.getComponentsInRect` | 区框内器件（按锚点判定；按 rectId 或显式 span；支持 margin 外扩） | `rectId` 或 `x1,y1,x2,y2`, `margin?` |
| `schematic.getPrimitivesInRegion` / `getPrimitiveAtPoint` | 区域/点查图元 | ⚠️ 文本类可能不被区域查询返回 |
| `schematic.runDrc` | 原理图 DRC（内部自动两遍取稳定值） | 无 |
| `schematic.runDrcDetailed` | DRC 逐条明细（**需 EDA v4.2+**；4.1 只返回聚合结构并标 `aggregated:true`，别假装支持或反复重试） | 无 |
| `schematic.structuralAudit` | **【0.10.60】整页结构+排版验收（只读）**：并查集编树+官方 net 对账。blocking=桥接(LABEL_NET_MISMATCH/树内多网名)/异网共线重叠/重复位号；candidate=孤立树/浮标/引脚穿线/十字交叉/区框重叠/器件出区/器件相碰(引脚云近似待目检)；info=零长段/悬端/同网重叠。九页验收逐页调用 | `ncExempt?`(豁免名单如 ["U2.2"]), `deviceMargin?`(相碰筛选外扩 mil,默认 10) |
| `schematic.exportNetlist` | 导网表（base64；⚠️ 验证连通性的最终手段） | 无 |
| `schematic.getNetlist` | 直接读网表字符串（0.10.44；exportNetlist 返空时的连通性审计备选，只读不写） | `netlistType?` |
| `schematic.save` | 保存原理图 | 无 |

- 官方单对象 `get()` 对已删除 ID 永久返回缓存旧对象——存在性判断用全量列表/源码重扫，别用 `get()`。
- **structuralAudit 宿主语义边界（0.10.61 实测）**：①宿主会把物理相接的异网名导线**合并成一个 wire** 并把 net 定为其中一个名——桥接实际由 LABEL_NET_MISMATCH[blocking] 抓获，MULTI_NET_TREE 只在字段可伪造的场景出现，不触发属正常；②画线穿过引脚会被官方**吸附拆分**、引脚成为端点=合法连接——PIN_INTERIOR_LANDING 在宿主数据上通常不触发，规则保留作防御；③图框 (0,0) 会被报 COMP_OUTSIDE_REGION[candidate]，图框不是器件，可忽略。
- 官方 `getAll(net)` 网络过滤不可靠——插件已改全量取回手动过滤。
- 人工在 EDA 界面**拖网络标签会丢附着甚至删标签、碎网**——拖后用 `listNetLabels` 查 attached 并审计成员完整性。
- **文档源码与 API 的 Y 轴符号相反**（API y=-600 ↔ 源码 y=+600）——两边比对必须翻转 Y。
- `createNetLabel` 有假失败（返回空但已创建附着）——复查按**属性值+坐标**匹配，别依赖导线网名的异步传播。

## ⑤ 宏指令（组合多个指令）

`cmd` 为 `macro`，`steps` 按序执行；步骤设 `id` 后，后续步骤可用 `$id` 或 `$id.字段` 引用其结果。**返回结果的键是 `steps`**（⚠️ 不是 result/data，解析时注意）。任一步失败即中断（`stopOnError:false` 可关闭）。

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
