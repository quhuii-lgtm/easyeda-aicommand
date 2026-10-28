# 嘉立创 EDA AI 指令引擎

> **AI 技能下载：**[技能发布 v2026.10.28.1](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.1) · [下载完整 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.1/ai-command-engine-skill_v2026.10.28.1_en-zh.zip)。解压并把完整 `ai-command-engine/` 目录放入 AI 工具的技能目录，保留英文入口 `SKILL.md`、中文备用入口 `SKILL_ZH.md`、`references/`、`scripts/` 和 `VERSION`；重载 AI 工具后让它读取 `SKILL.md` 并确认技能版本。技能独立于插件发布，版本号无需相同。

**English:** [README.md](README.md) | 简体中文

嘉立创 EDA 专业版的 AI 指令引擎，通过本机 HTTP 代理执行原理图、PCB、工程和元件库操作。

**首次使用请按 [安装与使用指南](docs/QUICKSTART_ZH.md) 依次完成：Node.js 代理依赖 → EDA 扩展 → 只读验证 → AI 技能。**下载 `.eext` 并不自动安装另外两部分。

## 相比市场0.20.51的累计更新（0.20.124）

市场当前公开版本为 0.20.51（2026-10-20 上架）；v0.20.124 市场包交给用户上传，本次尚未提交市场审核。GitHub 上一公开版为 v0.20.50。以下是本次相对市场 0.20.51、也相对 GitHub v0.20.50 的累计新增和修正，已验功能仍按对应版本记录为准：位号属性修改；独立焊盘和安装孔；丝印与制造几何检查；制造资料核对；差分、补长和焊盘分支布线；DSN 导出、外部布线服务及 SES 显式导入；分层宽度规则及混合规则处理；代理稳定性改进，移除旧结果导致后续独立请求持续锁定；106–108 版属性修改、画线和网表通道；以及 0.20.124 的数组保序、自动布线同 ID 终态任务槽处理、PCB 层名一致映射和帮助文字修正。辅助布线不保证任意整板全部布通，生产验收仍须使用具体板级资料。

v0.20.124 版本说明（2026-10-28）还包含三项本地修正和一项帮助文字更正：任务指纹保留数组顺序；自动布线终态释放匹配任务槽并对旧槽做一次只读确认；PCB 命令统一层名映射；修正旧 `autoRouteStart` 帮助文字。三项修正和帮助更正尚未在 EDA 宿主安装验收。主要功能验收依据为已安装并验收的 v0.20.123 及对应历史记录。

发布状态：GitHub 发布信息见 [v0.20.124 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.124)，以该页实际状态为准；[嘉立创 EDA 扩展市场页面](https://jlc-ext.com/item/eda_gdqnxffl/ai-command-engine)当前公开版本为 0.20.51，v0.20.124 市场包交给用户上传，本次尚未提交市场审核。配套技能另行发布为 v2026.10.28.1；插件和技能版本号独立，按功能及版本帮助核对适配。

插件包：`ai-command-engine_v0.20.124_zh-CN.eext`、`ai-command-engine_v0.20.124_en.eext`；源码归档：`easyeda-aicommand-plugin-source_v0.20.124.zip`。扩展不自动安装 Node.js、代理依赖或 AI 技能。首次安装提示词请先下载独立技能，再安装完整目录。

## 独立 AI 技能

从[技能发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.1)下载[完整技能 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.1/ai-command-engine-skill_v2026.10.28.1_en-zh.zip)。解压后把 `ai-command-engine/` 整个目录放到 AI 工具的技能目录，保留 `SKILL.md`、备用中文入口 `SKILL_ZH.md`、`references/`、`scripts/` 和 `VERSION`。重载 AI 工具，让它读取 `SKILL.md` 并报告识别到的版本。技能版本独立于插件版本；根据对应功能和帮助内容核对，不按数字相同判断。

## 功能演示

以下图片和 GIF 直接包含在本扩展包中，展示已有功能的实际操作。录制于 2026-10-09，扩展 v0.10.89、EDA Pro 4.1.60；它们是历史功能演示，不是 v0.20.124 的安装验收记录。

### 原理图：放置 MCU、添加短线与标签、保存重开

![原理图功能演示：放置器件、绘制短线、对齐网络标签并核对保存重开结果](images/demo-schematic.gif)

![原理图演示结果静态图](images/demo-schematic-poster.png)

示例包含 MCU 和辅助器件。保存重开后，57 个网络标签保持附着，60 个引脚网络成员一致。该图用于演示操作，不是完整 MCU 最小系统；当时 DRC 为 0 致命项、37 警告。

### PCB：板框、走线、过孔与覆铜

![PCB功能演示：绘制板框、走线、过孔、覆铜并保存重开核对](images/demo-pcb.gif)

![PCB演示结果静态图](images/demo-pcb-poster.png)

示例在独立演示板上创建板框、顶底层走线、过孔和覆铜。保存重开后读到 6 段走线及填充状态。演示板已预置 GND 焊盘和网络，不代表完整电路或制造验收。

## 版本与组成

GitHub 正式版 **v0.20.124**（2026-10-28）包含任务数组保序、自动布线终态任务槽释放与旧槽只读确认、PCB 层名映射统一，以及旧 `autoRouteStart` 帮助文字修正。10 项本地回归、整体 TypeScript 检查和生产配置编译通过；v0.20.124 尚未安装进行宿主验收。既有主要功能验收依据仍为已安装并验收的 v0.20.123 及各自有效记录，不能据此声称本次三项修正已通过宿主验证。详见[英文发布说明](docs/releases/v0.20.124-en.md)与[中文发布说明](docs/releases/v0.20.124-zh.md)。

## 主要功能

- 原理图绘制、器件库维护及器件属性修改。
- 支持的独立焊盘和安装孔创建，以及丝印和制造图形检查。
- 已验收范围内的差分、补长和焊盘分支布线。
- DSN 导出、调用外部布线服务、取回 SES 并显式导入。辅助布线不保证整板全部布通。
- 支持的规则与制造资料核对。具体生产验收仍须依据实际板叠层、阻抗、订单及其他板级资料。

代理源码在完整插件源码仓库中；AI 技能从上方独立技能发布页获取，不随插件源码包或 `.eext` 分发。Node.js 代理要求 Node.js >=20.17.0，并需在完整源码目录执行 `npm ci`，再运行 `node bridge/command-proxy.mjs`。后续记录见 [CHANGELOG](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/CHANGELOG.md)。

| 路径 | 内容 |
| --- | --- |
| `src/`、`extension.json` | EDA 插件源码；安装包从 Releases 下载 |
| `bridge/` | Node.js HTTP/WebSocket 代理及 Windows 启动器 |
| [独立技能发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.1) | 单独下载完整 `ai-command-engine/`，插件包不含技能 |
| `test/`、`bridge/mock-host-test.mjs` | 守卫与代理模拟回归，不代替真实 EDA 验收 |
| [安装指南](docs/QUICKSTART_ZH.md) | 安装、首次调用、常见报错、升级和卸载 |

<a id="first-install-ai"></a>

## 第一次安装：复制给 AI，让它带你完成连接

首次使用建议选择能访问本机文件、执行终端命令的 AI 编程工具。只有网页聊天能力的 AI 可以解释步骤，但不能直接在你的电脑上安装依赖或启动代理。

把下面整段复制给 AI，即使尚未安装配套技能，也可以从环境检查开始。若已下载源码或插件，请同时告诉 AI 文件所在位置。

```text
我正在首次安装嘉立创 EDA 的“AI 指令引擎”。请带我一步步建立本机环境，连接 EDA，并完成一次只读验证。项目地址：https://github.com/quhuii-lgtm/easyeda-aicommand 。

请先检查现状，再执行；每一步告诉我检查结果、当前阻点和下一步。不要一次给我一长串命令后就宣称安装完成。

1. 检查你能否访问本机文件和终端，并确认操作系统、Node.js 和 npm。按项目 package.json 检查版本要求，当前要求 Node.js >=20.17.0。缺少工具时指导我从官方来源安装，安装后重新检查；Git可选，Python不是直接HTTP连接的必需项。
2. 确认我安装或准备安装的插件版本，获取对应的完整源码仓库。读取 README.md、docs/QUICKSTART.md、package.json 和 package-lock.json。插件与代理源码从插件仓库获取；AI技能从 https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.10.28.1 或 https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.10.28.1/ai-command-engine-skill_v2026.10.28.1_en-zh.zip 单独获取。说明三部分分开安装且版本号独立；按相关功能及帮助核对适配，不要求技能和插件版本号相同。
3. 把源码保存在固定目录。发现已有仓库、技能或配置时先检查并保留个人改动，不覆盖旧目录或密钥。确认源码目录同时有 package.json、package-lock.json 和 bridge/command-proxy.mjs。
4. 在源码目录执行 npm ci，确认代理依赖安装成功。不要添加 --omit=dev；使用已下载的插件包不需要运行构建。解压独立技能 ZIP，并将完整 ai-command-engine/ 安装到当前AI工具的技能目录，保留 SKILL.md、备用中文入口 SKILL_ZH.md、references/、scripts/ 和 VERSION。重载AI工具，让它读取 SKILL.md 并报告技能版本；不要把插件仓库根目录的 SKILL.md 当作技能入口。
5. 检查 http://127.0.0.1:49720/health。如果没有代理，运行 node bridge/command-proxy.mjs，并保持进程可用；若端口已占用，先识别服务，不结束未知进程，不擅自改端口。检查健康响应和代理版本；失败时停在本步排查。Windows自动启动注册是可选项，不是首次连接的必需项。
6. 指导我在嘉立创EDA专业版中导入或安装 .eext、启用插件、允许外部交互，并打开一个用于试用的工程和图页。登录、验证码、系统确认及需要我手动点击的步骤，明确告诉我在哪里完成，等我完成后再继续。不要替我创建或修改电路。
7. 指导我点击“AI Command Engine → Start bridge”（中文菜单为“AI 指令引擎 → 启动桥接”）。查询 GET /connections，核对插件版本与工程身份；没有实例时检查插件启用、外部交互、桥接状态和代理，不能跳过。多个实例时按我指定的工程选择，不自动选第一项。
8. 使用刚查询到的 instanceId，在 POST /command 的顶层显式携带它，调用 project.getInfo。核对返回 JSON 的 ok 为 true，且工程身份正确；HTTP 200本身不能证明成功。按需只读查询图页并核对UUID；不要猜参数，按所选实例对应版本的帮助查询。
9. 最后报告：Node/npm版本、源码目录与版本、技能安装位置、代理健康状态、EDA/插件版本、目标instanceId、工程/图页身份，以及只读调用结果。缺哪项就说明哪项，不能把“已安装插件”当作“已连接EDA”。

本次只建立环境和验证连接，不放置器件、不走线、不改库、不配置SMT密钥、不公开上传文件。首次只读验证成功后，等待我另行给出绘图任务。
```

### 完成后应该看到什么

| 检查 | 完成条件 |
| --- | --- |
| 本机环境 | Node.js 与 npm 可用，代理依赖安装成功 |
| AI 技能 | AI 能读取完整技能入口及连接说明 |
| 本地代理 | `/health` 正常，代理进程仍可用 |
| EDA 桥接 | `/connections` 出现已核对版本及工程身份的目标实例 |
| 实际往返 | 带目标 `instanceId` 的 `project.getInfo` 返回 `ok:true`，工程身份正确 |

这些结果证明连接链路已打通。绘图、保存重开和电路检查属于后续任务，不能由首次连接结果代替。

## 安装摘要

要求 Node.js >=20.17.0（含 npm）。Windows 是本文档提供的操作路径；宿主版本及其他平台的验证边界见首次使用指南。

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
npm ci
node bridge/command-proxy.mjs
```

ZIP 用户在解压后的仓库目录运行后两条命令。保留代理终端，再从 [Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) 下载 `.eext`，在 EDA 插件管理界面导入、启用并允许外部交互，打开试用工程，点击“AI 指令引擎 → 启动桥接”。

默认地址为 `http://127.0.0.1:49720`。代理启动后再验证 `/health` 与 `/connections`，按工程名核对目标实例。完整 PowerShell 请求和预期结果见 [第一次只读调用](docs/QUICKSTART_ZH.md#3-完成第一次只读调用)。

**Windows 可按需注册自动启动。**运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\install-url-scheme.ps1` 后，插件可通过 `ai-command-proxy://start` 唤起本仓库启动器；该命令只对本次脚本运行绕过执行策略，不修改机器策略。注册只作用于当前用户，移动仓库后需重新注册。默认端口为 49720。启动、停止、重连以及兼容限制见 [桥接生命周期说明](docs/BRIDGE-LIFECYCLE.md)。

## 安装 AI 技能

将整个 `ai-command-engine/` 安装到 AI 工具的技能目录，保留其子目录。已有同名技能先备份、对比，不覆盖个人改动。具体位置与试用提示词见 [技能安装](docs/QUICKSTART_ZH.md#4-安装-ai-技能)。根目录 `SKILL.md` 只是导航，不是另一份技能。

## 可选 SMT 物料查询

仅物料查询需要 [嘉立创开放平台](https://open.jlc.com) 的 appId、accessKey 和 secretKey。代理启动后打开 `http://127.0.0.1:49720/smt` 填写；配置文件是当前仓库的 `bridge/jlc-credentials.json`，已被 Git 忽略。

普通画图不需要这些密钥。换目录升级时需自行迁移配置；不要上传或在反馈中粘贴密钥。步骤见 [物料查询](docs/QUICKSTART_ZH.md#5-可选-smt-物料查询)。

## 调用边界

- 每个完整 `/command` 请求显式携带顶层 `instanceId`，先查询并核对目标，`/select` 不能替代它。
- 图页操作还应带 `params.__docUuid` 核对页身份。实例相同不代表焦点页正确。
- 写超时不代表取消；先核实旧写状态，不盲目重试。0.20.57及配套代理不因历史失败持续锁定后续独立请求，无需手动解锁。
- 完成修改后保存、读回并检查网络及图像。API 成功、DRC 或模拟回归不能独立证明电路正确。

## 开发与回归

安装发布包不需要构建。开发者在仓库目录执行：

```powershell
npm ci
npm run build
node bridge/mock-host-test.mjs
npx esbuild test/docGuardRegression.ts --bundle --format=cjs --platform=node --outfile=build/dist/docGuardRegression.cjs
node build/dist/docGuardRegression.cjs
# In the separate skill checkout: python -B -m unittest discover -s ai-command-engine/tests -v
```

构建产物位于 `build/dist/ai-command-engine_v*.eext`。桥接回归使用独立端口和假扩展：`node bridge/mock-host-test.mjs`、`node bridge/lifecycle-mock-test.mjs`；客户端状态机测试为 `node test/bridge-client-lifecycle.mjs`。Python 测试使用模拟 HTTP，不连接 EDA。真实客户端安装与绘图仍需单独验收。

## 反馈与许可

问题请提交到 [Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)，附版本、仓库提交、复现步骤及脱敏错误。升级、密钥迁移与卸载见 [指南](docs/QUICKSTART_ZH.md#升级停止与卸载)。

[Apache-2.0](LICENSE)。构建框架原有历史保留在 [SDK changelog](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/SDK-CHANGELOG.md)。
