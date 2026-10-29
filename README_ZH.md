# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 本次更新：0.20.126（相比 0.20.125）

线宽规则读取、判断和 DSN 分层线宽转换现在依据实际 TRACK 字段、单位、启用铜层，以及从源码与 SDK 读取的规则绑定结构；不再固定检查 EDA 4.1.78 版本。`editorVersion` 仍用于诊断；本次没有解除其他能力或几何限制。

嘉立创 EDA 专业版 4.1.93 的限定验收通过：转换后 4 个网络、4 个铜层的线宽匹配；低于 25 mil 最小值的 20 mil 线路在写入前被拒绝；合法旧版 SES 导入 10 条走线和 2 个过孔；规则绑定保留；重复导入零新增；保存重开读回通过；原 ARC 保护保持有效。留存夹具仍有 9 项 DRC 错误，整板验收未通过，也不代表满足生产要求。

12 组仓库回归、2 组本机留存夹具辅助测试、TypeScript 检查及零警告构建通过。2 组辅助测试不计作独立仓库回归。配套 AI 技能独立版本为 v2026.10.29。当前市场公开版为 v0.20.124；v0.20.125 已退回修改。v0.20.126 的 GitHub 与市场状态分别以[GitHub 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.126)和[嘉立创扩展市场页面](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)为准，渠道确认前不称已发布。

## 功能

- 查询和编辑原理图器件、导线、标签及工程图页。
- 查看和编辑 PCB 器件、走线、过孔、覆铜、支持的独立焊盘与安装孔，并检查丝印。
- 执行支持范围内的差分、补长、焊盘分支布线及丝印、制造检查。
- 导出 DSN、调用外部布线服务，并显式导入 SES 结果。
- 查询和维护器件库资源，读取工程信息。

### 功能演示

以下 GIF 是功能示例，不代表 v0.20.126 全部功能或实机验收证据。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

EDA 扩展、完整代理源码及依赖、AI 技能需分别安装。安装扩展不会自动安装 Node.js、代理依赖或技能。

1. **代理：**下载完整插件源码仓库并安装 Node.js >=20.17.0。在仓库目录运行 `npm ci`，再运行 `node bridge/command-proxy.mjs`。不能只复制代理脚本。
2. **EDA 扩展：**从 [GitHub v0.20.126 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.126)下载 `.eext`，在嘉立创 EDA 专业版导入并启用，允许外部交互。
3. **AI 技能：**从[技能发布页 v2026.10.29](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.29)或[完整双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.29/ai-command-engine-skill_v2026.10.29_en-zh.zip)下载。把完整 `ai-command-engine/` 目录安装到 AI 工具的技能目录，保留 `SKILL.md`、`SKILL_ZH.md`、`references/`、`scripts/`、`VERSION` 和 `LICENSE`。重载 AI 工具，让它读取 `SKILL.md` 并报告技能版本。技能和插件分别编号。

按[首次安装指南](docs/QUICKSTART_ZH.md)完成连接。先在本机终端的完整源码目录启动代理，再在 EDA 导入并启用扩展、允许外部交互，选择“AI 指令引擎 → 启动桥接”。检查 `http://127.0.0.1:49720/health` 和 `http://127.0.0.1:49720/connections`，核对目标工程与 `instanceId`，先执行只读 `project.getInfo` 再修改文档。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
