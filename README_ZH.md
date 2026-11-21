# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 最近更新与修复：0.21.19（相比 0.21.18）

### 本次更新

- **写入超时与断线恢复。** 区分未开始、执行中和结果未知。结果未知时暂停目标窗口的后续写入；先只读核实原请求终态和实际图纸，再确认原请求并恢复，避免直接重发造成重复修改。
- **工程与图页核对。** 分别报告工程已打开和活动页已确认；切页后核对工程、文档及页签身份，不把页面尚未确认当作切页完成。
- **原理图接线和清理。** 改进无名支路接入具名母线后的读回、同锚点重复标签处理和批量删除核对。不同锚点或带关联分支的去重仍按安全条件拒绝，不能强行合并。
- **选库和装配 BOM。** 同料号首项没有封装时继续检查候选，优先使用已核实有封装的器件；装配变体按 SDK 实际列表选择并核对导出结果。
- **完整配套代理。** 技能正式候选恢复既有 KiRouting 服务接入、权限检查及原数据目录行为，同时保留本次写入恢复修复。请使用完整技能目录；源码仓库的通用 `bridge/` 不是完整 KiRouting 安装入口。

### 实际验证范围

2026-11-21，Windows / 嘉立创 EDA 专业版 4.1.99、安装版 0.21.19，在独立工程完成工程打开、切页及错页拒绝、T 接读回、异网拒绝、受限去重零写入、两线删除对照、选库和 BOM 对照。相关线路、去重结果及删除对照完成保存关闭重开；首次宿主删除返回 false 的去重场景保留原图，保存重开后再次处理成功，不宣称任意宿主拒绝都会自动恢复。

另用正式候选代理和同版桥接客户端，在前台独立 EDA 图页完成真实写入超时、正常断开与硬断线重连、终态读回、确认原请求后恢复写入及保存重开。正常断开和硬断线均由同一实例重连。用户当前共享代理没有重启。

### 测试边界与升级要求

较早两次未主动把独立 EDA 窗口置于前台的硬断线，分别观察了 **27 秒和 110 秒**，各自在观察期内未见重连。原因尚未确认，不能归因为已证实的后台定时器故障，也不能承诺后台窗口必定在固定时间重连。

KiRouting 本轮仅验证冷启动协议、查询接口与权限，没有重跑实际布线。此前样板和旧版未验证范围继续适用；跨域复合测例中旧新版共有的 FreeRouting 模拟报错尚未归因，不列为本次已修复事项。独立样板通过不代表用户工程整体或制造验收通过。

**升级插件时，请同步更新完整 AI 技能 2026.11.21.1。** 从[技能发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.21.1)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.21.1/ai-command-engine-skill_v2026.11.21.1_en-zh.zip)，保留个人设置，将完整 `ai-command-engine/` 目录更新到 AI 工具的技能目录后重新加载。安装市场插件不会自动安装 Node.js、代理依赖或技能。更新文件也不会自动替换正在运行的旧代理；先核对实际连接及恢复能力，按完整技能指南安排升级，不强制重启共享代理。

渠道状态以[GitHub 插件发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.19)和[扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)实际显示为准。市场提交、审核通过和公开上架是不同状态。

## 功能

- 查询和编辑原理图器件、导线、标签及工程图页。
- 查看和编辑 PCB 器件、走线、过孔、覆铜、支持的独立焊盘与安装孔，并检查丝印。
- 执行支持范围内的差分、补长、焊盘分支布线及丝印、制造检查。
- 导出 DSN、调用外部布线服务，并显式导入 SES 结果。
- 查询和维护器件库资源，读取工程信息。

### 模块复用

模块复用把模块提取、库管理、文件恢复、PCB组合和器件替换接入 AI 指令引擎菜单及 `module.*` 指令。按配套技能中的模块复用指南顺序操作，参数先查目标实例的 `__help`。具体操作范围与验证条件见配套技能。

选定的模块库目录会被记住。未设置时，默认目录是实际嘉立创 EDA 安装目录下的 `module-library`，不是 EDA 文档目录。改用合并扩展前，先结束独立模块复用扩展中的在途任务并停止旧桥接。现有模块库文件不会被搬动、覆盖或自动迁移。

### 功能演示

以下 GIF 展示功能流程，不代表 v0.21.19 的每项功能均已通过实机验收。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

插件、代理技能和 AI 工具是三个独立部分。安装 `.eext` 不会自动安装 Node.js 或技能。

1. **技能与代理：**从[技能 v2026.11.21.1 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.21.1)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.21.1/ai-command-engine-skill_v2026.11.21.1_en-zh.zip)，安装完整 `ai-command-engine/` 并保留参考文件与脚本。使用 Node.js >=20.17.0，首次在技能根目录运行 `npm ci --omit=dev`。
2. **后台启动：**让 AI 阅读技能的[连接说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/setup.md)，并运行 `scripts/start-proxy.ps1`。Windows 隐藏启动并返回实际端点；兼容服务会复用。
3. **EDA 扩展：**从[插件 v0.21.19 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.19)取得 `.eext`，导入、启用并允许外部交互。
4. **核对连接：**使用启动器返回的端口（`49720–49729` 范围内）检查 `/health`、`/connections`，核对目标实例和工程，再调用只读 `project.getInfo`。

首次安装步骤详见[GitHub 中文安装指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART_ZH.md)。升级前先处理并保存每个 EDA 窗口中的未完成操作，再重新加载仍运行旧版插件的窗口；在一个窗口导入插件不能保证其他已打开窗口也升级。插件与技能版本独立。更新技能不覆盖代理的用户数据，也不强制替换运行中的兼容代理。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
