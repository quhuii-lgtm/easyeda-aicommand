# 嘉立创 EDA AI 指令引擎

[English](README.md)

## 最近更新与新功能：0.21.22（相比 0.21.19）

- **PCB 绕行与余线检查：**只读定位残留线头、共线重叠线段、疑似多余过孔，以及值得复核的绕行路径、折点和跨层过孔。报告不是自动清理或自动改线指令；缺少规则、焊盘或障碍证据时需要补充核对。
- **制造文件检查：**读取单板或拼板制造 ZIP，检查支持的阻焊间距、设计锡膏与镀孔重叠、钻孔和邮票孔候选，以及有充分外形证据的器件到板边间距。报告注明数据来源与未覆盖范围。
- **PCB 分阶段检查脚本：**完整 AI 配套包新增摆放后、每批布线后、重铺后和制造文件导出后的检查入口，核对目标身份及修订，保存各阶段报告；缺资料时报告待复核，不把缺项当通过。

### 实际验证与限制

已在嘉立创 EDA 专业版 4.1.99 读回实际安装的 0.21.22，并在独立工程执行基础 PCB 18 项、SMT 7 项、绕行 6 条路径及 1 个余线／过孔候选的只读调用。安装版还用实际拼板 ZIP 和单板保存样本复测制造文件检查，结果与预验证一致。最后一轮独立板源码对照未完成；没有转向正式工程补测，也没有发出工程写入或保存指令。

随单钢网文件未提供，目前只核设计锡膏；名单计数不代表缺失资料下的完整生产清单。斜向邮票孔及部分特殊几何未覆盖。阻焊过窄对照能报警，但已知合并为同一开口的样例可能漏报，需要人工或独立几何复核。0.10 mm 是样例筛查阈值，不是订单验收标准；报告中的间距下界不等于精确最窄值。分阶段独立样板报告仍因资料和覆盖缺项为 `incomplete`，不宣称整板 DRC、完整铜路或制造验收通过。

## 三种包与安装方式

| 包 | 用途与下载 | 安装位置 |
| --- | --- | --- |
| EDA 扩展 0.21.22 `.eext` | [GitHub 扩展下载](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.22)，或从[嘉立创市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)安装 | 嘉立创 EDA 专业版 |
| 独立中英技能 2026.11.24.1 | [完整技能 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.24.1/ai-command-engine-skill_v2026.11.24.1_en-zh.zip) | AI 工具的技能目录 |
| 通用 AI 配套插件 0.1.0 | [便携插件 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.24.1/ai-command-engine-companion_v0.1.0_portable.zip) | 支持本地插件或技能导入的 AI 客户端 |

**所有用户先安装 EDA 扩展；需要 AI 时，独立技能与通用 AI 插件二选一即可。** 市场只安装 EDA 扩展，不会自动安装两个 AI 包、Node.js 或代理依赖。

1. 在嘉立创扩展市场安装 EDA 扩展；或从 GitHub 下载 `.eext`，在 EDA 的“高级 → 扩展管理器 → 导入”中选择它，启用并允许外部交互。市场审核进度以实际页面为准。
2. 选择独立技能：解压 ZIP，将完整 `ai-command-engine/` 安装到 AI 工具的技能目录，保留脚本、参考文件和个人设置，并重新加载技能。
3. 或选择通用 AI 插件：解压 ZIP，按客户端实际支持的本地插件方式导入根目录；只支持技能的客户端，可按其技能安装方式导入包内 `skills/` 目录。不要覆盖已有全局规则。通用插件另含协作规则，是否合并到其他任务的规则文件由用户决定。
4. 在运行 EDA 的同一电脑准备 Node.js >=20.17.0。独立技能在 `ai-command-engine/`，通用插件在 `skills/ai-command-engine/` 中运行 `npm ci --omit=dev`。两个 AI 包包含完整代理，不能只复制源码仓库的通用 `bridge/` 脚本。
5. 让 AI 先读取所选包的技能入口和连接指南，后台启动代理，再核对实际 EDA 实例、目标工程和图页，先做只读查询，再开始绘图。Windows 可按指南使用 `scripts/start-proxy.ps1`；使用启动器返回的实际地址。不要为安装包检查而结束现有共享桥接。

通用插件 0.1.0 已离线核包，**Codex、Claude、Kimi、OpenCode 均尚未实机安装验证**。包内提供兼容入口不等于四种客户端均已验证可用。它的内嵌技能版本标识为 2026.11.22.3；独立技能版本为 2026.11.24.1。两者共用的运行脚本、参考资料一致，插件入口额外加载协作规则，版本号分别管理。

更多步骤见[中文首次安装指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART_ZH.md)。SMT 开放平台查询另需密钥，普通绘图不需要。保留个人设置、原工程和在途任务；文件更新不会自动替换正在运行的旧代理。市场与 GitHub 的审核／公开版本可能不同。

## 功能概览

通过本机代理，AI 可按结构化指令查询和编辑支持的原理图、PCB、工程及元器件库，使用模块复用、可选布线和检查工具。指令以目标实例的帮助及完整技能要求为准，成功回包不代表保存、电气、整板 DRC 或制造验收通过。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

演示仅展示流程，不代表本版全部功能均已实机验证。原生布线默认，FreeRouting 与 KiRouting 保留可选；不保证任意整板布通。

[GitHub](https://github.com/quhuii-lgtm/easyeda-aicommand) · [AI packages](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.24.1) · [Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues) · [Apache-2.0](LICENSE)
