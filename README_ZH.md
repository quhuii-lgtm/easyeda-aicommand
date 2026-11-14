# 嘉立创 EDA AI 指令引擎

[English](README.md)

AI 指令引擎通过本机 Node.js 代理连接嘉立创 EDA 专业版，让 AI 按结构化指令查询和操作原理图、PCB、工程及器件库。

## 最近更新与新功能：0.21.7（相比 0.21.6）

### 新增与改进

- **PCB 设计规则读写：**可读取规则、预览修改，再明确执行。按网络类为当前成员批量分配规则，同时保留未选字段；单独指定的网络规则优先，重复相同请求不再写入。
- **按板框缩放视图：**新增 `pcb.zoomToBoardOutline`，按真实板框定位和缩放，不受远处丝印影响，不移动设计对象；矩形和凹形板框均已实图核对。
- **单 PCB 源码恢复：**`pcb.sourceRollback` 核对备份身份，恢复后完整读回并确认保存，再通过关闭重开比较；重复恢复相同内容时跳过源码写入。
- **DRC 结果更完整：**保留原生结果树、分类、严重级别和未知项，避免把 Physical、Track 等对象分类当作电气网络。
- **扇出结果核对：**报告实际读回数量、部分覆盖和几何精度来源；相关命令绑定目标工程、图页和标签，目标不符时在写入前拒绝。

### 本次实际验证范围

Windows / 嘉立创 EDA 专业版 4.1.99，安装版 0.21.7 在独立测试工程完成规则配置、网络类分配、单网络优先覆盖、重复零写入及原生 DRC 定向效果验证。规则保存、关闭重开后完整有效源码一致。矩形／凹形板框缩放实图通过，设计对象未移动。扇出新增 1 条线和 1 个通孔逐 ID 核对，并通过保存重开比较。测试线网络、端点和宽度修改保存后，单 PCB 恢复及重复恢复核对通过。测试工程保留故意设置的错误；这些结果不代表整板 DRC 或制造通过。

### 使用边界

完整物理叠层仍取决于宿主支持的 API。`Track:"default"` 跟随默认方案；宿主保存时可能把“当前默认方案名称”绑定规范化为 `default`，尚不保证以后更换默认方案仍固定原名称。本次证据涉及当前默认方案 copperThickness1oz，并非非默认 2oz 规则丢失。

实填充坐标单位、凹形板框的扇出规划仍有限制；支持板框缩放不代表支持凹形板布线。整工程恢复仍为 SDK 合并导入，不是原样覆盖恢复。不同图元的读取舍入及组合样本 `FILL.refs` 的 `[null] → null` 保存差异继续保留说明，不作统一容差放宽。其他原有未验场景仍按对应指南处理。

**升级插件时，请同步更新完整 AI 技能 2026.11.14.1。** 从[技能下载页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.14.1)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.14.1/ai-command-engine-skill_v2026.11.14.1_en-zh.zip)，保留个人设置，将完整 `ai-command-engine/` 目录安装或更新到 AI 工具的技能目录，再重新加载。首次安装与连接步骤见下文。

各渠道状态以[GitHub 插件发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.7)与[扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)实际显示为准，市场审核与公开上架可能晚于 GitHub。

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

以下 GIF 展示功能流程，不代表 v0.21.7 的每项功能均已通过实机验收。

![原理图功能演示](images/demo-schematic.gif)

![PCB 功能演示](images/demo-pcb.gif)

可用指令取决于已安装插件和 EDA 版本。使用前查询当前连接实例的帮助。指令返回成功本身不能证明工程已保存、电气连接正确、全板 DRC 通过或满足生产要求。辅助自动布线不保证任意整板均可布通。

## 首次安装与连接

插件、代理技能和 AI 工具是三个独立部分。安装 `.eext` 不会自动安装 Node.js 或技能。

1. **技能与代理：**从[技能 v2026.11.14.1 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.14.1)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.14.1/ai-command-engine-skill_v2026.11.14.1_en-zh.zip)，安装完整 `ai-command-engine/` 并保留参考文件与脚本。使用 Node.js >=20.17.0，首次在技能根目录运行 `npm ci --omit=dev`。
2. **后台启动：**让 AI 阅读技能的[连接说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/setup.md)，并运行 `scripts/start-proxy.ps1`。Windows 隐藏启动并返回实际端点；兼容服务会复用。
3. **EDA 扩展：**从[插件 v0.21.7 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.21.7)取得 `.eext`，导入、启用并允许外部交互。
4. **核对连接：**使用启动器返回的端口（`49720–49729` 范围内）检查 `/health`、`/connections`，核对目标实例和工程，再调用只读 `project.getInfo`。

首次安装步骤详见[GitHub 中文安装指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART_ZH.md)。升级前先处理并保存每个 EDA 窗口中的未完成操作，再重新加载仍运行旧版插件的窗口；在一个窗口导入插件不能保证其他已打开窗口也升级。插件与技能版本独立。更新技能不覆盖代理的用户数据，也不强制替换运行中的兼容代理。

## 项目链接

- [GitHub 插件源码与发布包](https://github.com/quhuii-lgtm/easyeda-aicommand)
- [嘉立创 EDA 扩展市场](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)
- [独立 AI 技能仓库与发布](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)
- [反馈与问题](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)
- 许可证：[Apache-2.0](LICENSE)
