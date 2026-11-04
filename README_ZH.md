# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 本次更新：0.20.127（相比 0.20.126）

本地代理随配套 AI 技能分发，由 AI 在 Windows 隐藏后台启动；插件自动连接，不再为未运行的代理自动打开自定义 URL。用户手动停止桥接后，仍可从 EDA 菜单恢复。兼容的运行中代理会继续复用，不会被插件强制替换。

34 项客户端生命周期用例、17 项代理所有者用例、8 项 Python 用例、TypeScript 检查及零警告构建通过。嘉立创 EDA 专业版 4.1.93 安装版 0.20.127 自动连接，注册 217 条指令；只读 `project.getInfo` 和 `task.list` 调用成功。11 月 4 日处理旧窗口后重新打开，0.20.127 成功连接，只读 `project.getInfo` 成功。以上只验证启动与连接，不代表 217 条指令全部通过、整板验收、DRC 或生产就绪。macOS/Linux 完整启动尚未实测。

本次更新前扩展市场公开版为 0.20.126。配套技能独立版本为 v2026.11.03。当前渠道状态和附件见[v0.20.127 GitHub 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127)及[嘉立创扩展市场页面](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)。升级要求见[本次发布说明](docs/releases/v0.20.127-zh.md)。

## 功能

- 查询和编辑原理图器件、导线、标签及工程图页。
- 查看和编辑 PCB 器件、走线、过孔、覆铜、支持的独立焊盘与安装孔，并检查丝印。
- 执行支持范围内的差分、补长、焊盘分支布线及丝印、制造检查。
- 导出 DSN、调用外部布线服务，并显式导入 SES 结果。
- 查询和维护器件库资源，读取工程信息。

### 功能演示

以下 GIF 是功能示例，不代表 v0.20.127 全部功能或实机验收证据。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

0.20.127 使用配套技能后台启动代理，插件自动连接，不再自动打开 Windows 启动链接。当前安装版已完成启动和只读连接验收；这不代表所有指令或绘图流程均已验收。

1. **技能与代理：**从[技能 v2026.11.03 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.03)下载[双语技能 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.03/ai-command-engine-skill_v2026.11.03_en-zh.zip)，安装完整 `ai-command-engine/`。保留 `package.json`、`package-lock.json`、`scripts/` 和说明文件。Node.js >=20.17.0；首次在技能根目录执行 `npm ci --omit=dev`。
2. **后台启动：**让 AI 按技能的[连接说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/setup.md)运行 `scripts/start-proxy.ps1`。无需完整插件源码或 URL 协议注册；Windows 启动器隐藏运行代理。
3. **EDA 扩展：**从[插件 v0.20.127 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127)取得配套 `.eext`，导入、启用并允许外部交互。插件自动接入代理；曾手动停止时点击“启动桥接”。
4. **核对连接：**检查 `http://127.0.0.1:49720/health`、`http://127.0.0.1:49720/connections`，核对插件版本和工程，带目标 `instanceId` 调用只读 `project.getInfo`。

首次安装步骤详见[GitHub 中文安装指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART_ZH.md)。升级前先处理并保存每个 EDA 窗口中的未完成操作，再重新加载仍运行旧版插件的窗口；在一个窗口导入插件不能保证其他已打开窗口也升级。插件与技能版本独立。更新技能不覆盖代理的用户数据，也不强制替换运行中的兼容代理。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
