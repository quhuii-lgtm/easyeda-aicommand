# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 本次更新：0.20.125（相比 0.20.124）

ARC 额外重复/拆分候选现在只比较 `layerName` 与 `net` 均相同的线路，避免该候选检查误拒跨层或异网的合法线路。原有几何检查仍拒绝同层同网线路的线宽或线型变化。

源码包补齐37项回归样本、manifest、样本说明和7个测试脚本。这些资料仅供源码回归测试，不进入 `.eext` 扩展包或技能 ZIP。

17组相关回归、TypeScript 检查和生产构建在本地通过；没有在新版本 EDA 宿主安装验证。0.20.124 已在扩展市场上架；GitHub v0.20.125 发布状态及其市场审核状态，分别以[GitHub 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.125)和[嘉立创扩展市场页面](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)为准。

## 功能

- 查询和编辑原理图器件、导线、标签及工程图页。
- 查看和编辑 PCB 器件、走线、过孔、覆铜、支持的独立焊盘与安装孔，并检查丝印。
- 执行支持范围内的差分、补长、焊盘分支布线及丝印、制造检查。
- 导出 DSN、调用外部布线服务，并显式导入 SES 结果。
- 查询和维护器件库资源，读取工程信息。

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

EDA 扩展、完整代理源码及依赖、AI 技能需分别安装。安装扩展不会自动安装 Node.js、代理依赖或技能。

1. **代理：**下载完整插件源码仓库并安装 Node.js >=20.17.0。在仓库目录运行 `npm ci`，再运行 `node bridge/command-proxy.mjs`。不能只复制代理脚本。
2. **EDA 扩展：**从 [GitHub v0.20.125 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.125)下载 `.eext`，在嘉立创 EDA 专业版导入并启用，允许外部交互。
3. **AI 技能：**从[技能发布页 v2026.10.28.4](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.4)或[完整双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.4/ai-command-engine-skill_v2026.10.28.4_en-zh.zip)下载。把完整 `ai-command-engine/` 目录安装到 AI 工具的技能目录，保留 `SKILL.md`、`SKILL_ZH.md`、`references/`、`scripts/`、`VERSION` 和 `LICENSE`。重载 AI 工具，让它读取 `SKILL.md` 并报告技能版本。技能和插件分别编号。

按[首次安装指南](docs/QUICKSTART_ZH.md)完成连接。先在本机终端的完整源码目录启动代理，再在 EDA 导入并启用扩展、允许外部交互，选择“AI 指令引擎 → 启动桥接”。检查 `http://127.0.0.1:49720/health` 和 `http://127.0.0.1:49720/connections`，核对目标工程与 `instanceId`，先执行只读 `project.getInfo` 再修改文档。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
