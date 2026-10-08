# ⚠️ 踩坑实录（按主题分组）

全是实测教训。操作对应主题前必读；历史行为以实际版本、/help 和读回为准。

## 1. 返回值不可信（总纲）

- 官方 `delete()` 对类型不匹配甚至不存在的 ID 也可能返回 true——看 `failed` 数组。
- 官方 modify/create 有**假成功**（返回非空但保存后没生效）也有**假失败**（返回空但实际已生效，事务不回滚）——**成败一律以读回/源码重扫为准**（插件 modify/create/delete 已内置读回验证，返回带 `readback`）。
- 官方单对象 `get()` 对已删除 ID **永久返回缓存旧对象**——存在性用全量列表/源码重扫判断。
- 官方 `getAll(net)` 网络过滤不可靠——全量取回手动过滤。
- **多字段合并修改整体失效**（"位置+旋转"同传→什么都没改）——插件已原子化拆分+逐步读回；调用侧多字段照传，但批量命名偶发失效必须看 `failed`。
- 大批量改动后网表/DRC 可能返回过渡态——插件已稳定化（runDrc 两遍、batchWire 审计重试），自组指令时注意。

## 2. 无撤销

- 官方无撤销 API，删错无法挽回。
- 防护：破坏性指令前代理自动导出 .epro 到 `bridge/backups/`（60 秒只备一次，返回带 `backup`，**确认实际备到**）；大改前手动 `project.exportFile`；删除前用列表指令确认目标 ID。
- 搞坏了：EDA 自动备份在 `文档\LCEDA-Pro\online-projects-backup\<工程名>\`（epru 是 NDJSON 文本，WIRE 是容器、LINE 存 lineGroup 归属、NET 挂 ATTR）；PCB 侧用 `pcb.sourceRollback` 恢复。
- 关标签页选「不保存」**不一定回滚**（内存模型可能仍在），别当可靠手段。

## 3. 连线与标签

- **NC 引脚禁止接线**（画短桩抛 `create failed!`）——插件预检给中文报错。
- **共线合并陷阱**：官方把共线重叠/相接的导线自动合并——① 相邻短桩同间隙重叠合并挂两个标签直接串网；② 直线穿中间引脚把它并进网；③ 不同网横腿同深度共线合并。labelWire/linkWire/buildBlock 已防，**手画 drawWire 同样避开**。
- connectPin 端点落引脚原点、不探入本体；EDA 只认与引脚线段非零重叠的导线——端点对端点重合、网标直贴引脚=致命"引脚端点重叠且未连接"。
- **标签 rotation 默认 0、锚点压导线/桩末端**（附着看锚点，离线 5 单位即浮标；文字自锚点右伸）；显式传入 rotation 时尝试设置并读回核对。rotation 180=反字（装机实锤），镜像同反字且官方属性接口不支持 mirror——被转/镜像的标签只能转正或删了重放。文字宽≈4.4×字符数+5 单位。短桩默认 60、最小 20。
- placeNetLabel：压线被拒（自动 ±2 微偏重试）；只有指定标签 ID、父导线和父导线属性三处读回一致才确认附着，ghost 标签也同样验证。读回未知或确认浮空以 partial 异常返回并保留标签及 ID；`noVerify` 不确认附着。附近同名导线或负坐标不能证明附着；已带网名的导线别再放同名标签（插件拒，force 强行）。
- **drawWire 带 net 会自动在导线中点落 NET 属性标签**（与 placeNetLabel 两套，同网并存即重复，导线持有属性删不掉）——要标签收尾就"无名线+placeNetLabel"，别两边命名。
- 导线持有的 Name/NET 属性**删不掉**（官方无类级删除）——唯一可靠办法：**删线重画**（listWires 留几何→delete→drawWire 重画命名→exportNetlist 审计）。
- `createNetLabel` 假失败复查按**属性值+坐标**匹配，别依赖导线网名异步传播；**文档源码与 API 的 Y 轴符号相反**（API y=-600 ↔ 源码 y=+600），从源码读坐标发指令必须**先翻转 Y**，否则图元画到镜像位置且批量返回全 OK 不易察觉（刹车板实测踩过）。附着以指定标签及父导线关系读回为准，坐标正负本身不能证明附着。
- 人工在 EDA 界面**拖网络标签会丢附着甚至删标签、碎网**——拖后 listNetLabels 查 attached+网表审计成员。
- 碎网流程：① exportNetlist 审计期望成员；② 缺标签的导线补同名标签（锚点取线段中点）；③ 删不掉的重复/错误属性→删线重画；④ 补完网表审计+runDrc 双确认。

## 4. 批量删除与浮标清理

- **大批量删除分批多次跑**（原理图 delete batchSize 10 / prune 5），看 `batches`/`unprocessed` 续删，别调大硬跑。
- `schematic.delete` 在删除调用后立即读回；只有仍存在才按既有 400/600/1000ms 间隔复核。超时不代表没删；读回未知则保留 partial 并停止后续写入，不据此判断宿主根因。
- 创建连续失败或超时时停止写入并核对现场；删除存在未知写入时跳过健康探针。非未知路径的探针仅单次串行创建/清理，失败或残留必须保留证据。不要依据一次超时直接判断页面损坏或自动关页。
- 浮标（parentId=$$root）删除主通道借尸还魂（临时线→挂 parentId→删线级联→源码重扫）；官方 modify parentId 假失败（返回 falsy 但已生效）——以源码重扫为准。
- **浮空标签处理的源码改写第三兜底默认禁用**（离线验证通过 ≠ 运行时安全，官方写回有额外格式校验）：`allowSourceRewrite` 仅用于此路径，须明确传 `true` 才尝试；先保存并检查 warning。此开关与普通 `TEXT` 删除使用的内部快照路径分开。

## 5. PCB 布局与分组

- DRC **只查铜皮**不查本体挤压——checkPlacement 用焊盘包围盒，大本体加 margin 或按实测尺寸核算。
- drawOutline 对外 x/y 是**左下角**（官方左上角，插件换算）；板框自动转 Region，重复板框先 getPrimitivesInRegion 找 ID 再 delete。
- groupBySchematicRegions：板框解析以实时 Polyline/Region API 优先、源码兜底、不一致采信 API；"摆不下"是如实报错——需拆框或加大板框；dryRun 与实跑 placements 逐项可比。
- groupBySchematicRegions **dryRun 默认 true**，确认方案再真跑（0.10.47 起唯一自动布局宏，autoPlace 已删：autoFromSchematic 模式焦点悖论实测不可用，显式分组无备份且质量等价）。

## 6. 检查与导入

- 原理图 DRC 4.1 只返回分类计数；`runDrcDetailed` 需 EDA v4.2+，4.1 只返回聚合（`aggregated:true`），**别假装支持或反复重试**。
- `importChanges` 前原理图必须 0 致命（否则静默 false）；弹对话框 AI 点不了，提醒用户点「应用修改」。
- `save` 无修改返回 false 是官方行为；`renameBoard` 前先 `project.getBoardInfo` 防重名误改。
- `openDocument` 参数名是 `uuid`（不是 documentUuid），传错静默失败——调用后查返回 ok；偶发切页超时先重试或手动切页再复核。
- `runDrcDetailed` 偶发超时一次后自恢复——先重试，勿判插件失效。

## 7. 文档源码写入（开发者向）

- 文档源码是**行式 JSON 变更日志**（`JSON(header)||JSON(data)`，同 (type,id) 由 ticket 分新旧，空 data=删除墓碑），不是快照。安全写法：**append-only**——① 不编辑旧行，变更追加文末；② ticket 从 max+1 单调递增；③ 改图元用原 data 浅拷贝只覆盖要改的键；④ 移动器件坐标双字段同改（x/y/angle 与 positionX/positionY/rotation 一起）；⑤ 删除用墓碑不物理删行；⑥ 写入前整份备份、写后回读逐值比对（容差 0.001）、失败整份恢复、全过才 save。生成图元一律 `spg_` 前缀+文档层 layerId=13 便于清场。
- 管线封装在 `pcb.groupBySchematicRegions`/`pcb.sourceRollback`（基础设施 `src/pcb/sourcelog.ts`）。

## 8. 界面与杂项

- `editor.screenshot` 默认只截当前视口，全图加 `zoomToAll:true`；截图空白是渲染时机问题，重截即可。**但窗口在后台时它截的是旧缓存帧（连截字节级相同），"图上看不到新物件"先疑截图再疑数据——视觉验收用 `schematic.exportPng`**（pitfalls K9~K10）。裁剪坐标按画布比例换算（PCB mil、原理图 10mil）。
- macro 返回结果的键是 `steps`（不是 result/data）。
- `project.modifyTitleBlock` 只能改图框**已存在**的字段；纸张切换让用户在 EDA 界面手动改。
- `project.createPcb`/`project.createSchematic` 的 boardName **必须是已存在的板子名**；新建省略 boardName，之后 `project.associateBoard` 关联。
- 历史开发环境另有 49620 原生 API 网关，但未随本仓库发布，不是使用前置条件。普通调用先查正式指令帮助；扩展开发需单独确认调试环境和授权。
- **按指令授权范围操作**：不超出被调用指令的授权范围修复、删除或恢复。`dedupeWireNets` 与 `autoRouteStatus` 在已写入后失败时会尝试整页快照恢复并读回；恢复失败或未确认仍报错，不保证成功。`autoLayout` 本身不自动恢复。

## 桥接开关与多实例（0.10.66~0.10.70 实测，K5~K8）

- **「断开指令代理」=暂停语义（0.10.68 起）**：用户点断开后连接随即断开、AI 指令一律被拒（错误明示），EDA 封装的自动重连被代理持续挡回，全部断开后代理空闲 300 秒自动退出；点「连接指令代理」恢复，后台没在跑插件会自动拉起。`/connections` 条目带 `paused` 字段。
- **恢复口令（0.10.69）**：每次断开代理要求匹配口令才允许恢复——旧版本残留模块重放的 hello 帧、其他 AI 会话发的恢复声明一律被拒（`resume-rejected` 记 lane-log）。**AI 侧不要尝试绕**：只有用户点菜单能解除暂停。
- **`sys_WebSocket.close()` 官方 bug**：调用后连接不关闭。插件已全部改应用层帧（bye/pause/resume），排查连接问题别再用 close 思路。
- **EDA 为扩展累积多个 JS 上下文**：重复导入/部分菜单点击会产生新上下文；`sys_WebSocket` 注册表按 WS_ID 全局共享、后注册顶替先注册；偶发新上下文指令表只剩 macro（"残态"）。0.10.70 起菜单函数幂等自激活兜底；遇残态让用户重开 EDA 窗口。
- **多 AI 会话共用代理**：指令必须带顶层 instanceId 且核对 `info.project`；不带会落到全局选中实例——实测另一会话的画图指令曾因此落进本窗口。用户暂停本窗口不影响其他窗口（暂停按实例生效）。
- **多窗口版本不一很正常**：`/connections` 里不同实例 version 不同（旧窗口没重开），选窗时以实例为准，别假设全是最新版。

## 超时与调试（0.10.36~0.10.37 定论）

- **超时≠取消**：代理/扩展超时只是放弃等待，指令内部可能仍在后台执行（EDA 官方 API 无取消机制）。重发前先用只读指令确认现场，避免重复写入。0.10.37 起全链路（客户端 300s / 代理 300s / 扩展 300s / 空闲退出 300s）统一，改代理脚本须重启代理才生效。
- **system.eval 不可用**：EDA 扩展沙箱同时禁用 new Function 和 eval（0.10.36 实测），别再用它调试，提需求封正式指令。

## 库指令假失败（0.10.38 实测）

- **lib.footprintModify 报 `[object Object]`/报错但可能实际已改成功**，且**修改后封装 uuid 会变化**（实测 f2382a3a→4b6d2d72）。官方 lib_Footprint.modify 会 reject 普通对象（0.10.38 起框架 JSON 序列化不再吞消息）。任何 modify 后必须 `lib.footprintSearch` 按名字复核，不要沿用旧 uuid。
- `lib.footprintGet` 对不存在/已改名的 uuid 也会 reject 对象而非返回空——报错不等于封装丢了，先按名字搜。

## 网表与封装属性（0.10.52 受控实测，EDA 4.1.60）

- **Footprint 属性 = 空串 → 网表双路径全死**：getNetlist 报"官方返回非字符串或空"、exportNetlist 报"官方返回空（File|undefined）"，Protel2/PADS 一起死，可逆（恢复非空值即恢复）。attr=null（未绑定）反而正常，FOOTPRINT 列自动用器件自带封装。**诊断 XLink 式网表返空先查有没有空串封装**。
- **Footprint 裸名绑定无效**：setAttribute 写 `R0603` 这类裸名，导出能成功但 FOOTPRINT 列输出 `undefined`（PCB 导入会炸）；正确格式疑为带 uuid 的 JSON（同 DeviceName 格式），未验证。别用裸名补封装。
- **网表范围 = 整个工程**（跨全部原理图），不是活动页；某页器件属性损坏会把整个工程导出拖死。
- 网表首个坏快照缺失的根因尚未确认；外部逐页脚本仅用于补充并留存证据，不代表 `getNetlist` 算法已修复。
- **空串封装失败循环 + save 后，器件全部 ATTR 记录可能丢失**（器件还在，位号/封装/Convert 全没，getAttributes 返空），网表转为**静默剔除**该器件——比报错更危险，导出"成功"但少了器件。时点未隔离，写空串属性是高危操作。
- `project.save` 不存在，保存用 `schematic.save`（返回 `{saved:true}`）。
- `getDocumentSource` 读**未打开**的页可能返回当前活动页数据——读源码前先 `editor.openDocument` 激活目标页再核 DOCHEAD.uuid。
- Convert to PCB 只能改**已存在**的属性；属性丢失后 setAttribute 报"器件上没有属性 X"。

## TEXT 删除与持久性（0.10.85 隔离工程安装验证，EDA 4.1.60）

- 历史故障：旧类级/实例级和源码墓碑路径曾失败；不代表当前路径。
- 当前统一使用 `schematic.delete`：源码快照移除后核对源码与模型；内容比较仅忽略两层记录的 `header.ticket`，回放仍保留原 ticket，其余 header、data、记录数、有效记录与模型继续严格核对。0.10.85 隔离工程安装版经 save→close→open 后确认目标未复活。
- 普通删除不自动保存；`persistenceVerified:false` 表示命令本身没有执行关闭重开验证，并不否定任务级独立验收。按任务另行 save→close→open 并重扫目标。0.10.86 候选移除旧实验入口；隔离工程安装版 0.10.85 仍显示该入口，日常操作统一用 `schematic.delete`。
- 验证删除持久性不能只看即时读回，必须 **save → `editor.closeDocument` → `editor.openDocument` → 重扫源码**（close 是异步的，关掉后轮询页签列表确认真关了再开）。
- `editor.closeDocument` 官方关闭异步生效（约 2 秒内页签消失）；脏文档会弹确认框 AI 点不了，返回 closed:false——**关前必须先 schematic.save**。

## TEXT 官方 API 层历史实测（0.10.55，EDA 4.1.60）

- 当时观察到 TEXT 创建可持久，而修改和类级/实例级删除会在保存重开后弹回；`setDocumentSource` 墓碑实验虽返回 true 也未持久。这是 0.10.55 的历史结论，不代表当前源码快照候选已经通过宿主持久性验收。
- 判定删除是否持久必须 save → `editor.closeDocument`（轮询确认真关）→ `editor.openDocument` → 重扫，只看即时读回会被骗（TEXT 假删除即时读回也是消失的）。

## 工程切换与改名（0.10.59~0.10.61 实测）

- **project.open 遇脏页直接失败**：当前工程有未保存修改时，官方 openProject 返回 false（报"工程打开失败"，uuid 明明正确）。先 `schematic.save`（返回 `{saved:true}`）再切工程。
- **renameSchematicPage 三前置**（独立工程多窗口实测）：①目标页文档须在本窗口打开激活；②页所在文档须在本窗口 save 过一次；③改名异步提交读回 >800ms。缺任一则官方返回 false 且不排队=假失败。隐藏规律：全新窗口从未成功改过页名时，其他窗口创建的旧页被永远拒绝；对本窗口新建页成功改名一次即解锁全部页。renameBoard 按名匹配会误改 Panel——改名前后快照比对，只信快照。
- placeNetLabel 的附着要按指定标签 ID、父导线和父导线属性交叉读回；单看标签坐标正负不能判定附着。
- **deleteBoard 可能删不掉**：空板删除返回 `deleted:false` 且重试无效（实例：XLink 误建空板 Schematic8），只能请用户手动删。

## structuralAudit 宿主语义边界（0.10.60/0.10.61 故障注入实测）

- **宿主合并异网名导线**：物理相接的不同网名导线会被官方合并成一个 wire，net 定为其中一个名，异网名只残留在标签属性 → 桥接由 LABEL_NET_MISMATCH[blocking] 抓获；MULTI_NET_TREE 在真实宿主数据上不触发属正常（规则保留作防御）。
- **画线穿引脚会被吸附拆分**：导线穿过引脚位置时官方自动在引脚处拆分，引脚成为端点=合法连接 → PIN_INTERIOR_LANDING 在宿主数据上通常不触发（规则保留作候选，供离线/异常数据）。
- **重复位号丢引脚教训（0.10.60 bug，0.10.61 已修）**：一批器件位号未规范化（全是 "R?"）时，按位号索引引脚会互相覆盖只留第一个——引脚收集必须按器件（primitiveId）条目，不能按位号做 key。
- **structuralAudit 的 COMP_OUTSIDE_REGION 对图框误报**：图框 (0,0) 不在任何功能区框内会被报 candidate，图框不是器件，验收时忽略。

## 视觉验收与工程操作（0.10.71 实测，K9~K12，2026-10-06 VIN 事件定论）

- **K9 后台窗口不重绘，screenshot 截缓存帧**：EDA 窗口在后台/不聚焦时交互画布不增量重绘，`editor.screenshot` 拿到的是旧帧——**连截两次返回字节级相同就是缓存帧信号**（zoomToAll/zoomToRegion 返回 ok 也刷不动它）。API 放置/修改后"图上看不到"**先疑截图、再疑数据**；数据核验永远以 listComponents/getDocumentSource/网表/exportPng 为准。实测：同页 5 个器件 screenshot 只显示 1 个，exportPng 全在；生产工程"VIN 不可见"纯属假象，符号一直在图上。
- **K10 视觉验收首选 `schematic.exportPng`**：独立渲染管线，窗口后台也输出完整图纸。注意返回的是**全部原理图页打包 ZIP 的 base64**（解码后 PK 开头，每页一张 PNG，文件名带页名），不是裸 PNG。验收流程：写入 → save → 读回核对 → exportPng 解 ZIP 逐页目检。
- **K11 `project.create`/`project.open` 复用当前窗口**：不会新开窗口，实例号不变，但**整个窗口的活动工程被切走**——别人正在用这个窗口就要小心串台。用完必须 `project.open` 原工程切回并 getInfo 验证。插件无 `project.delete`，测试工程会留在用户工程列表，需用户手动删。
- **K12 参数名小坑三枚**（报错信息有迷惑性）：`editor.openDocument` 参数名是 `uuid`（传 tabId 报"缺少参数 uuid"）；`placeDevice` 用 `deviceUuid` 必须同传 `libraryUuid`（漏传不报错、指令挂起到超时）；`schematic.setAttribute` 参数名是 `key`（传 name 报"器件上没有属性 undefined"）。另：电源符号 setAttribute 改 `Global Net Name` 会自动同步 `Name` 属性，不用手动改两个。

## 工程备份恢复与 epro 导入（0.10.71 实测，2026-10-06 实测定论）

- **API `project.importFile` 不可用**：`sys_FileManager.importProjectByProjectFile` 对 .epro 官方返回空（"导入失败：官方返回空"，17ms 快拒和 517ms 慢拒都见过），与 base64 内容、fileType（'epro'/'JLCEDA Pro'）、newProjectName 均无关。**epro 恢复只能走客户端 GUI**。
- **GUI 导入是四级流程，漏一级 = 静默失败**（文件对话框关闭 ≠ 导入提交，日志零痕迹）：①文件→导入→嘉立创EDA(专业版)→系统文件对话框选 .epro→打开；②应用内「导入」对话框（导入选项：导入文档/提取库文件/导入并提取库）→点「导入」；③应用内「导入文档」对话框（新建工程/保存至已有工程 + 工程名输入框）→**工程名必须改成不与云端已有工程同名**（默认带出的名字与原工程同名，疑似同名即静默失败的根因）→点「导入」；④提示「创建成功！是否打开新工程？」→是/在新窗口打开。KimiCU 自动化时前几级之间要等对话框真正出现再动手，每级截图确认。
- **导入后工程 uuid/页 uuid 全部重新生成**，与原工程无任何共享；`Channel ID` 等内部标识也会重新生成——恢复验证对比网表时这些字段差异无害，只比 `components` 的位号+`pinInfoMap`（电气连接）。
- **恢复工程验证口径**（轻验证定型）：project.listSchematicPages 页数/页名 vs 原工程结构；目标页 listComponents 器件数与关键器件在不在（如被误删的部件）；exportNetlist 与备份时基线 .enet 逐元件 diff `pinInfoMap`（json.loads 后是 `components` dict，不是 nets 列表）。
- **`project.getDocumentSource` 返回头/体交替记录**：每实体两条 json（`{"type":"COMPONENT","ticket":N,"id":"eX"}` 头 + 属性体）以 `||` 与 `|\n` 分隔；ATTR 体含 `parentId/key/value`，解析必须先按分隔符切 token 再头体两两配对，按行 split 会丢字段。
- **多步 GUI 操作（导入/改名/对话框链）必须避开并发会话**：另一 AI 会话在同一窗口高频跑 macro 会把模态对话框挤掉（实测"导入文档"对话框被并发 delete/placeDevice 冲没）。选人/窗口先看该窗口日志面板有无别人的 macro 在跑，挑无干扰窗口执行。

## 写保护状态机与 editor 写队列（0.10.72 引入，0.10.73 v2 定案，0.10.73b 出队检查，KIMI-EDA-20261006-03/04/05 GPT 三轮审查）

- **写结果不确定保护（writeUncertain）**：写指令超时或心跳超时，代理放弃等待但扩展侧可能仍在后台执行（EDA 无取消机制）——此时放行下一条写会与它交错（半注册导线等不可预期现场）。0.10.73 v2 起：写超时/心跳超时 → 该实例进入写保护，**期间一切写指令被拒**（读指令不受限），拒绝文案含触发指令与解除方法。
- **双重检查点**：入队前一次（assertWriteCertain，快速拒绝不占队列槽）+ **出队执行前一次**（executeWrite 内，0.10.73b 新增）——入队时保护未设置、排队期间前写超时的，出队必须拦住，不得发往扩展。注意读指令也走 executeWrite 函数（不进队列直接转发），出队检查只对写生效。
- **保护按实例号键，断线重连不清除**——同一宿主重连后旧写可能仍在后台跑，保护必须延续。解除只有两条路（没有基于时间的自动放行）：
  ① **id 匹配且非 partial 的迟到 result**——代理记录导致保护那条指令的请求 id，只认这个 id 的迟到结果；扩展熔断杀死的结果带 `error.cause.partial` 标记，**partial 结果不算可信完成信号**（记 lane-log `late-result-partial-ignored`）；其他无主 result（别的超时读请求等）一律不动保护。
  ② **`write.acknowledge`**（本地指令，需顶层 instanceId）——调用方确认现场后的显式解除。注意：普通写（drawWire/placeDevice）不在任务表，**task.list 空不能证明写已结束**，不要拿它当解除依据。
- **写被拒时的标准动作**：不要无脑重试——先 `task.get` 查前一条写的实际结果（长任务类），再用只读指令核对现场（listComponents/listWires 看有无半注册残留），然后 `write.acknowledge` 解除。lane-log 记 `write-uncertain-set/cleared` 可对账。
- **editor.\* 不再整体只读**：只读白名单为 `editor.(listTabs|screenshot|zoomToAll|zoomToRegion)$` 四条；`openDocument/closeDocument` 会改变目标文档上下文，**按写指令排队**；macro 整体占一条写通道，外部切页排在其后不被插入（假宿主实测顺序 macro→openDocument）。
- **文档守卫（插件侧 0.10.73）**：焦点类型不符时**只有激活的同类标签才自愈**（焦点卡住实测场景的恢复）；无激活命中 → 拒绝，要求显式声明目标。页级操作建议显式传 `params.__docUuid`（页 uuid 用 `project.listSchematicPages` 查），焦点不符即报错。
- **运维旋钮**：`PROXY_CMD_TIMEOUT_MS` 环境变量可覆盖代理指令超时（默认 300s）；`PORT` 仅改变代理监听端口，不同步插件/启动器/助手；普通用户保持默认 49720。假宿主回归脚本 `bridge/mock-host-test.mjs`（19 用例，独立端口不触真实 EDA）。
