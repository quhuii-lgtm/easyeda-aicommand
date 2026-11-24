# 首次安装 · EDA 0.21.22 与 AI 配套包

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
