# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 本次更新：0.20.128（相比 0.20.127）

代理默认在 `49720–49729` 中选择可用端口，复用兼容服务并报告实际端点。插件扫描该范围发现服务，断线后重新发现；显式 `-Port` / `PORT` 仍固定使用单一端口。SMT、PCB 备份和 Python 助手改用实际端点，绑定错误保留系统详情。配套技能在 Windows 隐藏启动代理，不打开旧启动 URL、不结束未知进程、不更改系统端口设置。

客户端生命周期 43 项、所有者生命周期 19 项、SMT 端点 1 项、PCB 分组 4 项、review bridge 11 项、Python 助手 10 项、技能打包 2 项、绑定错误 10 项及真实端口冲突 1 项通过；TypeScript 检查通过，构建零警告。嘉立创 EDA 专业版 4.1.93 实机中，0.20.128 自动发现 49721 并连接，显示 217 条已注册指令，只读读取工程和任务信息，并使用实际端点打开 SMT 页面。这是 Windows 限定宿主验收，不代表 217 条指令全部验证、PCB 分组写入、一般绘图、保存重开、整板 DRC 或生产验收。Linux 尚未实机验证。

配套技能独立版本为 2026.11.08。GitHub 与扩展市场状态分别查看[插件发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.128)、[技能发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.08)及[嘉立创扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)。升级要求见[本次发布说明](docs/releases/v0.20.128-zh.md)。

## 功能

- 查询和编辑原理图器件、导线、标签及工程图页。
- 查看和编辑 PCB 器件、走线、过孔、覆铜、支持的独立焊盘与安装孔，并检查丝印。
- 执行支持范围内的差分、补长、焊盘分支布线及丝印、制造检查。
- 导出 DSN、调用外部布线服务，并显式导入 SES 结果。
- 查询和维护器件库资源，读取工程信息。

### 功能演示

以下 GIF 展示功能流程，不代表 v0.20.128 的每项功能均已通过实机验收。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

插件、代理技能和 AI 工具是三个独立部分。安装 `.eext` 不会自动安装 Node.js 或技能。

1. **技能与代理：**从[技能 v2026.11.08 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.08)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.08/ai-command-engine-skill_v2026.11.08_en-zh.zip)，安装完整 `ai-command-engine/` 并保留参考文件与脚本。使用 Node.js >=20.17.0，首次在技能根目录运行 `npm ci --omit=dev`。
2. **后台启动：**让 AI 阅读技能的[连接说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/setup.md)，并运行 `scripts/start-proxy.ps1`。Windows 隐藏启动并返回实际端点；兼容服务会复用。
3. **EDA 扩展：**从[插件 v0.20.128 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.128)取得 `.eext`，导入、启用并允许外部交互。
4. **核对连接：**使用启动器返回的端口（`49720–49729` 范围内）检查 `/health`、`/connections`，核对目标实例和工程，再调用只读 `project.getInfo`。

首次安装步骤详见[GitHub 中文安装指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART_ZH.md)。升级前先处理并保存每个 EDA 窗口中的未完成操作，再重新加载仍运行旧版插件的窗口；在一个窗口导入插件不能保证其他已打开窗口也升级。插件与技能版本独立。更新技能不覆盖代理的用户数据，也不强制替换运行中的兼容代理。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
