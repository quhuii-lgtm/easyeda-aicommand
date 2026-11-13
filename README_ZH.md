# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 最近更新与新功能：0.21.6（相比 0.21.2）

### 最近修复

修复换件后的 Device 有效关联核对，包括继承属性的有效关联。本版也包含 0.21.2 后续的换件停止保护、unknown 结果重放保护、接线铜层连续性检查和链接模块库根目录支持。

### 新增功能

「标记功能区」添加 PCB 边框和名称，不移动元件。「定位／高亮功能区」定位并选中全部成员，包含锁定元件。旧「按原理图功能区分组（移动元件）」仍是单独的移动分组操作。

### 实机验证范围

Windows / 嘉立创 EDA 专业版 4.1.99 安装版 0.21.6 已通过三框三名称、20 成员的功能区验收。菜单标记、取消零写入、重复更新、定位高亮及保存关闭重开通过；原元件位置保持，用户确认画面可见。

独立工程中，双脚电阻由 10 kΩ 旧 Device 替换为同封装的 2.2 kΩ 新 Device。位号、UID、两脚网络和焊盘几何保持；保存、关闭两个目标标签并重开后，有效 Device 关联通过。最终正式原理图和 PCB 双网表的 20 个共同器件在 Device、Footprint、位号和逐脚网络上全部一致。

本次 Device 实测为双脚、同封装、不同 Device，不外推全部器件或不同封装。父 SCH 新增两条 TRACK 规则，与既有 PCB 物理线宽等价，不宣称整包逐字段不变。旧版 unknown/partial 现场仍是历史失败。Linux 和其他原有未验宿主/API 场景继续保留限制。此前 Existing Project 的 META.tags 样本往返限制和独立 TEXT 持久性限制仍适用；本版不交付逐元件丝印显示色功能。

**请同步更新完整的 AI 技能 2026.11.13.4。** 从[技能发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.13.4)下载中英双语 ZIP，保留个人设置，安装完整 ai-command-engine 目录，再重新加载技能。

打开 PCB 图页后，「AI 指令引擎」菜单显示 18 项；开始页和原理图页显示 7 个通用入口，包含模块复用。各渠道状态见[插件发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.6)、[扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)和[本次发布说明](docs/releases/v0.21.6-zh.md)。

## 功能

- 查询和编辑原理图器件、导线、标签及工程图页。
- 查看和编辑 PCB 器件、走线、过孔、覆铜、支持的独立焊盘与安装孔，并检查丝印。
- 执行支持范围内的差分、补长、焊盘分支布线及丝印、制造检查。
- 导出 DSN、调用外部布线服务，并显式导入 SES 结果。
- 查询和维护器件库资源，读取工程信息。

### 模块复用——0.21.1 本地候选

本地合并候选把模块提取、库管理、文件恢复、PCB组合和器件替换接入 AI 指令引擎菜单及 `module.*` 指令。按配套技能中的模块复用指南顺序操作，参数先查目标实例的 `__help`。该候选尚未在 EDA 中安装验收。

选定的模块库目录会被记住。未设置时，默认目录是实际嘉立创 EDA 安装目录下的 `module-library`，不是 EDA 文档目录。改用合并扩展前，先结束独立模块复用扩展中的在途任务并停止旧桥接。现有模块库文件不会被搬动、覆盖或自动迁移。

### 功能演示

以下 GIF 展示功能流程，不代表 v0.21.6 的每项功能均已通过实机验收。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

插件、代理技能和 AI 工具是三个独立部分。安装 `.eext` 不会自动安装 Node.js 或技能。

1. **技能与代理：**从[技能 v2026.11.13.4 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.13.4)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.13.4/ai-command-engine-skill_v2026.11.13.4_en-zh.zip)，安装完整 `ai-command-engine/` 并保留参考文件与脚本。使用 Node.js >=20.17.0，首次在技能根目录运行 `npm ci --omit=dev`。
2. **后台启动：**让 AI 阅读技能的[连接说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/setup.md)，并运行 `scripts/start-proxy.ps1`。Windows 隐藏启动并返回实际端点；兼容服务会复用。
3. **EDA 扩展：**从[插件 v0.21.6 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.6)取得 `.eext`，导入、启用并允许外部交互。
4. **核对连接：**使用启动器返回的端口（`49720–49729` 范围内）检查 `/health`、`/connections`，核对目标实例和工程，再调用只读 `project.getInfo`。

首次安装步骤详见[GitHub 中文安装指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART_ZH.md)。升级前先处理并保存每个 EDA 窗口中的未完成操作，再重新加载仍运行旧版插件的窗口；在一个窗口导入插件不能保证其他已打开窗口也升级。插件与技能版本独立。更新技能不覆盖代理的用户数据，也不强制替换运行中的兼容代理。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
