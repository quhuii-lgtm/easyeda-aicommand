# EasyEDA AI Command

嘉立创 EDA 专业版的 AI 操作扩展：AI 按任务调用配套技能中的简明指令，由本地代理转发至已连接的 EDA 窗口，用于原理图、PCB、工程和元件库查询及编辑。具体操作仍需按项目目标检查结果并由使用者验收。

**使用时必须另外安装 Node.js >=20.17.0、本地指令代理和 AI 技能。**从插件市场安装扩展本身不会安装或启动代理，也不会替你安装技能。扩展启用后还需在 EDA 中允许外部交互，并由使用者启动本地代理、安装对应技能及核对连接目标。

## 能力

- 通过本机代理向指定 EDA 窗口发送原理图、PCB、工程和元件库指令。
- 使用 AI 技能查询指令参数、安排操作步骤，并按读回信息检查结果。
- 通过本地问题上报工具，整理可公开的必要问题信息；提交 GitHub Issue 使用本机 [GitHub CLI](https://cli.github.com/) 登录身份，完全可选，由 AI 在提交前告知使用者后执行。

扩展、代理和 AI 技能是分别安装的组成部分。代理默认在本机运行，默认地址为 `http://127.0.0.1:49720`。问题上报不会由 EDA 指令自动触发，也不会在后台上传工程数据。

## 版本状态

当前已公开版本为 [v0.10.87](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.10.87)。**v0.10.88 是未发布的市场候选**，尚未完成候选包实机安装验收或市场审核；不要将候选文档视为已发布版本。有限的 `.87` 安装验证及未覆盖范围见 [v0.10.88 候选说明](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/releases/v0.10.88.md)。

## AI 技能下载与安装

**配套技能地址：[ai-command-engine 技能目录](https://github.com/quhuii-lgtm/easyeda-aicommand/tree/main/skills/ai-command-engine)。**

- [查看技能入口 SKILL.md](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/skills/ai-command-engine/SKILL.md)：了解技能用途及操作规则。
- [下载完整仓库 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand/archive/refs/heads/main.zip)：解压后，将 `skills/ai-command-engine/` **整个目录**安装到所用 AI 工具的技能目录，保留 `references/`、脚本等子目录，不能只复制 `SKILL.md`。
- [查看详细安装说明](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md#4-安装-ai-技能)：按所用 AI 工具完成安装和首次调用。

技能随项目仓库及候选扩展包一同分发，但扩展市场的安装操作不会自动向 AI 工具安装技能。推荐从上述仓库获取配套文件，并按版本说明同步更新扩展、代理和技能；`main` 是持续更新的分支，复现问题时请记录所用提交。普通使用不需要登录 GitHub，只有自动提交问题时需要 GitHub CLI 登录。

## 首次使用

请按[安装与使用指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md)完成 Node.js 与代理依赖、EDA 扩展安装、外部交互授权、首次只读验证和 AI 技能安装。要运行代理，请在仓库目录执行：

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
npm ci
node bridge/command-proxy.mjs
```

ZIP 用户在解压后的仓库目录运行 `npm ci` 和 `node bridge/command-proxy.mjs`。保留代理终端，再从 [Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) 下载 `.eext`，在 EDA 插件管理界面导入、启用并允许外部交互。然后将完整的 [`skills/ai-command-engine/`](https://github.com/quhuii-lgtm/easyeda-aicommand/tree/main/skills/ai-command-engine) 安装到 AI 工具的技能目录，并在 EDA 菜单点击 AI Command → 启动桥接。安装扩展不会在本机部署代理或向 AI 工具安装技能；完整步骤见[首次使用指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md)。

Windows 提供可选的 URL 协议启动方式；注册和生命周期说明见[桥接生命周期文档](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/BRIDGE-LIFECYCLE.md)。普通调用不需要 GitHub CLI；只有选择使用可选的问题上报功能时才需要它。SMT 物料查询另需[嘉立创开放平台](https://open.jlc.com)凭据，配置见[物料查询指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md#5-可选-smt-物料查询)。

## 安全与验证边界

- 每条 `/command` 请求都须携带顶层 `instanceId`；先查询连接并核对目标窗口。图页操作还要确认页身份。
- 写入超时不表示操作已取消；遇到未知结果或写保护时先只读核实，不要盲目重试。
- 插件/API 返回、保存读回、关闭后重开读回和生产验收代表不同证据。命令成功、DRC 或模拟回归都不能单独证明电路正确。
- 问题上报只使用已取得且可公开的必要证据。提交前需告知使用者；GitHub CLI、Issue 创建和登录都是可选流程。提交入口见[GitHub Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)。

## 开发者资料

源码、代理与完整 AI 技能见[仓库](https://github.com/quhuii-lgtm/easyeda-aicommand)。本地回归、构建、宿主验证等信息会在对应版本说明中分别标明。项目更新记录见 [CHANGELOG](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/CHANGELOG.md)，构建框架历史见 [SDK changelog](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/SDK-CHANGELOG.md)。

[Apache-2.0 许可](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/LICENSE)。
