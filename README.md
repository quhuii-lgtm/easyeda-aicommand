# EasyEDA AI Command

嘉立创 EDA 专业版的 AI 指令引擎，通过本机 HTTP 代理执行原理图、PCB、工程和元件库操作。

**首次使用请按 [安装与使用指南](docs/QUICKSTART.md) 依次完成：代理依赖 → EDA 插件 → 只读验证 → AI 技能。**下载 `.eext` 并不自动安装另外两部分。

## 版本与组成

当前发布插件为 [v0.10.73](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.10.73)。代理与技能随仓库代码分发，请同时记录所用仓库提交；插件版本相同不表示代理和技能也相同。后续文档及助手修订见 [CHANGELOG](CHANGELOG.md)。

| 路径 | 内容 |
| --- | --- |
| `src/`、`extension.json` | EDA 插件源码；安装包从 Releases 下载 |
| `bridge/` | Node.js HTTP/WebSocket 代理及 Windows 启动器 |
| [skills/ai-command-engine/](skills/ai-command-engine/SKILL.md) | 唯一维护的 AI 技能入口、分类指令手册和可选 Python 助手 |
| `test/`、`bridge/mock-host-test.mjs` | 守卫与代理模拟回归，不代替真实 EDA 验收 |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | 安装、首次调用、常见报错、升级和卸载 |

## 安装摘要

要求 Node.js >=20.17.0（含 npm）。Windows 是本文档提供的操作路径；宿主版本及其他平台的验证边界见首次使用指南。

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
npm ci
node bridge/command-proxy.mjs
```

ZIP 用户在解压后的仓库目录运行后两条命令。保留代理终端，再从 [Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) 下载 `.eext`，在 EDA 插件管理界面导入、启用并允许外部交互，打开试用工程，点击 AI Command → 连接指令代理。

默认地址为 `http://127.0.0.1:49720`。代理启动后再验证 `/health` 与 `/connections`，按工程名核对目标实例。完整 PowerShell 请求和预期结果见 [第一次只读调用](docs/QUICKSTART.md#3-完成第一次只读调用)。

**默认手动启动代理。**`ai-command-proxy://` 自动拉起只有在用户已自行注册协议时才有效；仓库没有协议注册脚本。不要只修改代理端口，发布插件和配套工具默认使用 49720。

## 安装 AI 技能

将整个 `skills/ai-command-engine/` 安装到 AI 工具的技能目录，保留其子目录。已有同名技能先备份、对比，不覆盖个人改动。具体位置与试用提示词见 [技能安装](docs/QUICKSTART.md#4-安装-ai-技能)。根目录 `SKILL.md` 只是导航，不是另一份技能。

## 可选 SMT 物料查询

仅物料查询需要 [嘉立创开放平台](https://open.jlc.com) 的 appId、accessKey 和 secretKey。代理启动后打开 `http://127.0.0.1:49720/smt` 填写；配置文件是当前仓库的 `bridge/jlc-credentials.json`，已被 Git 忽略。

普通画图不需要这些密钥。换目录升级时需自行迁移配置；不要上传或在反馈中粘贴密钥。步骤见 [物料查询](docs/QUICKSTART.md#5-可选-smt-物料查询)。

## 调用边界

- 每个完整 `/command` 请求显式携带顶层 `instanceId`，先查询并核对目标，`/select` 不能替代它。
- 图页操作还应带 `params.__docUuid` 核对页身份。实例相同不代表焦点页正确。
- 写超时不代表取消；遇到写保护先只读核实旧写状态，不能盲目重试或自动解除保护。
- 完成修改后保存、读回并检查网络及图像。API 成功、DRC 或模拟回归不能独立证明电路正确。

## 开发与回归

安装发布包不需要构建。开发者在仓库目录执行：

```powershell
npm ci
npm run build
node bridge/mock-host-test.mjs
npx esbuild test/docGuardRegression.ts --bundle --format=cjs --platform=node --outfile=build/dist/docGuardRegression.cjs
node build/dist/docGuardRegression.cjs
python -B -m unittest discover -s skills/ai-command-engine/tests -v
```

构建产物位于 `build/dist/ai-command-engine_v*.eext`。代理回归使用独立端口 49799 和假扩展；运行前确认该端口空闲。Python 测试使用模拟 HTTP，不连接 EDA。真实客户端安装与绘图仍需单独验收。

## 反馈与许可

问题请提交到 [Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)，附版本、仓库提交、复现步骤及脱敏错误。升级、密钥迁移与卸载见 [指南](docs/QUICKSTART.md#升级停止与卸载)。

[Apache-2.0](LICENSE)。构建框架原有历史保留在 [SDK changelog](docs/SDK-CHANGELOG.md)。
