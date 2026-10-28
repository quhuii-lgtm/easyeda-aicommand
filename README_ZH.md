# EasyEDA AI Command

**English:** [README.md](README.md) | **简体中文：** [README_ZH.md](README_ZH.md)

**仓库与下载：**[插件与 Node 代理](https://github.com/quhuii-lgtm/easyeda-aicommand) | [插件发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) | [独立 AI 技能仓库](https://github.com/quhuii-lgtm/easyeda-aicommand-skill) | [最新技能版本](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/latest)


嘉立创 EDA 专业版的 AI 操作扩展：AI 按任务调用配套技能中的简明指令，由本地代理转发至已连接的 EDA 窗口，用于原理图、PCB、工程和元件库查询及编辑。具体操作仍需按项目目标检查结果并由使用者验收。

你可以向配套 AI 工具描述任务，例如“查一下这个芯片的库存和阶梯价”“把 PCB 上的元件按原理图功能区分组”“把这个符号和封装组合成我的库器件”“放置 MCU 和外围元件，接线并整理网络标签”。AI 会结合当前工程，查询器件和引脚、调用绘图指令，再读取执行结果。插件将**选料查询、自建器件库、批量绘图、PCB 功能区聚合和结果检查**整合到同一套操作流程中。

<a id="first-install-ai"></a>

## 第一次安装：复制给 AI，让它带你完成连接

首次使用建议选择能访问本机文件、执行终端命令的 AI 编程工具。只有网页聊天能力的 AI 可以解释步骤，但不能直接在你的电脑上安装依赖或启动代理。

把下面整段复制给 AI，即使尚未安装配套技能，也可以从环境检查开始。若已下载源码或插件，请同时告诉 AI 文件所在位置。

```text
我正在首次安装嘉立创 EDA 的“AI 指令引擎”。请带我一步步建立本机环境，连接 EDA，并完成一次只读验证。项目地址：https://github.com/quhuii-lgtm/easyeda-aicommand 。

请先检查现状，再执行；每一步告诉我检查结果、当前阻点和下一步。不要一次给我一长串命令后就宣称安装完成。

1. 检查你能否访问本机文件和终端，并确认操作系统、Node.js 和 npm。按项目 package.json 检查版本要求，当前要求 Node.js >=20.17.0。缺少工具时指导我从官方来源安装，安装后重新检查；Git可选，Python不是直接HTTP连接的必需项。
2. 确认我安装或准备安装的插件版本，获取对应的完整源码仓库。读取 README.md、docs/QUICKSTART.md、package.json 和 package-lock.json。说明插件、代理和AI技能分别从哪里获取、版本是否匹配；若渠道版本不同或对应源码不可得，先说明，不能猜造下载地址或默认视为匹配。
3. 把源码保存在固定目录。发现已有仓库、技能或配置时先检查并保留个人改动，不覆盖旧目录或密钥。确认源码目录同时有 package.json、package-lock.json 和 bridge/command-proxy.mjs。
4. 在源码目录执行 npm ci，确认依赖安装成功。不要添加 --omit=dev；使用已下载的插件包不需要运行构建。从独立技能仓库或技能 ZIP 安装完整的 ai-command-engine/ 目录，保留 references/、scripts/ 和 SKILL.md。不要从本插件源码仓库复制技能目录。
5. 检查 http://127.0.0.1:49720/health。如果没有代理，运行 node bridge/command-proxy.mjs，并保持进程可用；若端口已占用，先识别服务，不结束未知进程，不擅自改端口。检查健康响应和代理版本；失败时停在本步排查。Windows自动启动注册是可选项，不是首次连接的必需项。
6. 指导我在嘉立创EDA专业版中导入或安装 .eext、启用插件、允许外部交互，并打开一个用于试用的工程和图页。登录、验证码、系统确认及需要我手动点击的步骤，明确告诉我在哪里完成，等我完成后再继续。不要替我创建或修改电路。
7. 指导我点击“AI 指令引擎 → 启动桥接”。查询 GET /connections，核对插件版本与工程身份；没有实例时检查插件启用、外部交互、桥接状态和代理，不能跳过。多个实例时按我指定的工程选择，不自动选第一项。
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

## 重点功能

### 1. 元器件库存、价格与可贴装物料查询

选料时即可查询嘉立创 SMT 物料的**元件编号、型号、封装、品牌、库存、参考单价和阶梯价格**，也支持按多个元件编号批量查询详情，方便比较候选器件的供货情况和采购数量对应的价格。

- **AI 查询**：让 AI 按关键词查找物料，或对一批料号查询库存、参数描述和阶梯报价。
- **独立查询窗口**：通过插件菜单打开 SMT 物料查询页面，直接查看查询结果。
- **结合绘图选料**：配合器件库搜索与按立创编号放置器件，把查询到的候选型号用于后续原理图绘制。

库存与价格来自嘉立创开放平台的查询结果，具体以平台当次返回和下单时信息为准；参考单价不等于所有采购数量的成交价。此功能需单独配置开放平台凭据，见[物料查询配置](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md#5-可选-smt-物料查询)。普通绘图功能不需要这组凭据。

### 2. PCB 按原理图功能区聚合与初步排布

把原理图中已用矩形区框划分的“电源”“MCU”“驱动”“接口”等功能区，转换成 PCB 上对应的器件分组。插件读取区框和器件归属，将同一功能区的器件聚合排布，并生成组边框和组名，便于从分散的器件开始整理布局。

- 整合了 PCB 元件聚合能力，布局引擎移植自官方 `eext-pcb-component-grouping`，可由 AI 直接调用。
- 支持跨图页读取功能区，也可指定图页；组内按器件类别分行，组间分区排列。
- **先预览再执行**：默认返回分组与位置方案；实际执行时检查板框范围、避让已有器件，并做写入前备份和位置读回核对。

适合原理图导入 PCB 后的功能区归组和初步排布。需要先在原理图中建立功能区框；聚合完成后仍需结合去耦、回流、散热、射频和机械要求继续调整，不等同于完成最终布局或自动布线。

### 3. 自建器件库：符号、封装与完整器件管理

除了使用现有商城器件，也能通过 AI 管理自己的符号库、封装库和器件库，把项目中需要的自定义元件保存下来，供后续工程复用。库操作默认面向个人库，也可指定有权限访问的目标库。

- **创建与编辑符号、封装**：新建库条目、打开对应编辑器，并将编辑后的符号或封装内容写回库中。
- **组合完整器件**：把已有原理图符号与 PCB 封装关联成器件，可同时绑定已有 3D 模型，并设置位号前缀、制造商、供应商及 BOM、转 PCB 属性。
- **复制与派生型号**：将已有符号、封装或器件复制到指定库并另命名，便于在现有资料基础上维护自己的版本。
- **查询与维护**：搜索、读取、修改或删除库条目，调整器件的符号和封装关联，维护常用元件资料。

例如，将已绘制的专用连接器符号和已核对尺寸的封装组合成自有器件，后续按该库器件放入原理图。创建库条目不等于自动完成引脚和封装设计，实际使用前仍需核对引脚编号、焊盘对应关系与尺寸；绑定 3D 模型也不代表自动生成模型。

### 4. 从器件清单与连接关系批量画原理图

支持按立创料号放置器件、读取实际引脚、修改位号与属性，以及批量创建功能区。AI 可以依据器件清单和连接关系，分步骤完成放置、连接、命名和检查，减少重复的查找、点击和输入。

已有原理图也可按指定器件或区域预览整理方案，再执行重排和连线重建。适合重复通道、MCU 外围、接口模块等具有明确连接关系的绘制任务。

完整换件使用新临时实例，并按配套技能完成核验、删除旧实例、属性修改、身份转移和持久性检查。这不是保留旧实例 ID 的原位更新；具体步骤和字段来源以[原理图指令说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/commands-schematic.md#完整器件更换)为准。v0.10.143 的器件更新指令已移除。若需把原理图变更同步到已有 PCB，由使用者在 EDA 界面发起并确认导入；AI 只在操作前后做只读检查。

### 5. 批量连线、网络标签与连接核对

提供引脚间直连、短线加网络标签，以及混合批量连线。支持网络标签命名和整理、引脚非连接标记、网络成员查询与网表导出。

连线时可依据真实引脚位置处理路径，标签创建后核对是否实际附着到导线；批量连线会检查网表中的连接结果。这样既能生成整齐的图面，也能进一步确认“这些引脚是否真正进入同一个网络”。下方 MCU 演示展示了短线引出、左右标签对齐及保存重开核对。

### 6. PCB 绘制、铺铜与网络管理

支持板框绘制、器件移动与旋转、按坐标生成走线、放置过孔、创建和修改铺铜区域，以及重建铺铜后读取填充状态。还可管理网络类、差分对，查询网络长度、读取网络上的走线和焊盘，并通过高亮或原理图与 PCB 联动定位辅助排查。

适合按明确规则执行成批操作，例如“按这些坐标布线”“给指定区域建立 GND 铺铜并重建”“把这组信号加入网络类”。外部自动布线流程可使用 DSN 导出与 SES 导入衔接，布线结果仍需检查。

### 7. 工程检查、资料导出与多窗口操作

- **结果检查**：读取器件、引脚、导线、标签和铺铜状态；运行原理图及 PCB DRC，并导出网表核对连接。检查明细的可用程度取决于 EDA 宿主版本。
- **资料导出**：支持 BOM、原理图图片、PCB Gerber、贴片坐标等，便于整理设计资料与后续制造交付。
- **多窗口定位**：通过实例和文档身份指定操作目标，适用于同时打开多个工程的工作场景。
- **组合操作**：宏指令可将放器件、连线、检查等步骤串起来，按顺序执行并返回各步结果；遇到写入结果不确定时停止依赖它的后续操作。

这些能力由本地代理和配套 AI 技能协同使用。插件提供工程操作与结果读取，电路方案和最终验收仍需结合实际项目要求。

### 8. 嘉立创下单检查（DFM）

提供 PCB DFM、SMT 和同网间距检查，分别返回 18、7、1 项结果，并保留完整性和几何覆盖信息。运行 DFM 时必须明确输入外层铜厚 `outerCopperOz` 与内层铜厚 `innerCopperOz`；图纸读取到的铜厚单独报告，不能代替输入值。结果不等于制造放行，也不代表完整在线 DFM 服务。详见[下单检查说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/commands-frequency.md)。

### 9. 焊盘扇出与自动局部铜皮

`pcb.getFanoutPlan` 和 `pcb.getAutoCopperPlan` 先生成只读计划；`pcb.fanout` 与 `pcb.autoCopper` 按完整计划执行。扇出线长、线宽、过孔外径、孔径和安全间距都须以 mil 明确输入。几何支持范围、保守近似和拒绝条件见[几何命令说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/commands-pcb-special.md)。历史隔离工程验收覆盖了部分较大 MCU 扇出样本，不代表所有封装形状、所有板子或完整 MCU 扇出流程均已通过。独立的填充读回路径也曾对特定铺铜区完成保存、关闭、重开后的核验；证据仅适用于对应测试对象，实际操作仍须审查计划、几何和生产输出。

### 10. 焊盘外扩与网络文字丝印

可用 `pcb.getPadExpansionPlan` / `pcb.expandPads` 规划并执行焊盘外扩，也可用 `pcb.getNetSilkscreenPlan` / `pcb.generateNetSilkscreen` 为焊盘网络生成可编辑丝印文字。外扩的支持形状、区域拆分与持久性限制，以及网络文字的放置和避让限制，见[几何命令说明](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/references/zh/commands-pcb-special.md)；本功能不替代对实际图形、间距和生产结果的检查。

## 实际操作演示

以下两段动画均录制于扩展 v0.10.89、EDA Pro 4.1.60，展示既有操作能力，不是 v0.20.50 的实机验收记录。

### 原理图：多脚 MCU、外围元件、短连线与标签

![48 脚 MCU 原理图：放置外围元件、短直线连接、网络标签对齐与保存重开检查](images/demo-schematic.gif)

实际绘制 STM32F103C8T6 和 6 个外围元件，用短直线连接复位、BOOT0 支路，其余引脚用等长短线引出，最后将网络标签分列对齐。保存重开后，**57 个标签均已附着，60 个引脚网络成员保持一致**。这是绘图功能演示，非完整 MCU 最小系统；本次 DRC 为 0 个致命错误、37 条警告。录制环境为扩展 v0.10.89、EDA Pro 4.1.60；[步骤和验证说明](docs/DEMO-SCHEMATIC.md)。

### PCB：板框、走线、过孔与铺铜

![AI 指令驱动 PCB 绘制：板框、走线、过孔、铺铜，以及保存重开检查](images/demo-pcb.gif)

在独立演示 PCB 中，AI 依次调用指令创建板框、绘制顶层走线、放置过孔并接续底层走线、创建并重建铺铜，最后保存、关闭、重开并读取结果。重开后读回 **6 段走线，铺铜状态为已填充**。

画面来自真实 EDA 操作截图，指令说明为后期字幕，已裁去账号和工程列表。演示预先建立了 GND 焊盘与网络；它是功能演示板，不是完整电路设计。录制环境为 **2026-10-09、扩展 v0.10.89、EDA Pro 4.1.60**，验证范围限于下述演示对象。动画约 18 秒，详细步骤及验证范围见 [演示说明](docs/DEMO.md)。

## 安装前准备

**使用时必须另外安装 Node.js >=20.17.0、本地指令代理和 AI 技能。**从插件市场安装扩展本身不会安装或启动代理，也不会替你安装技能。扩展启用后还需在 EDA 中允许外部交互，并由使用者启动本地代理、安装对应技能及核对连接目标。

扩展、代理和 AI 技能是分别安装的组成部分。代理默认在本机运行，默认地址为 `http://127.0.0.1:49720`。可选的问题上报工具可整理必要问题信息，使用本机 [GitHub CLI](https://cli.github.com/) 登录身份提交 GitHub Issue；提交前由 AI 告知使用者。问题上报不会由 EDA 指令自动触发，也不会在后台上传工程数据。

## 版本状态

原插件仓库当前正式版为 **v0.20.50**。本次只是拆分资料，不改变插件功能或版本。v0.20.50 尚未重新安装到 EDA 宿主验证。市场上架状态和版本可能变化，请以[扩展市场页面](https://lceda.cn/page/extensions)实际显示为准。既有功能说明和验证范围见 [v0.20.50 版本说明](docs/releases/v0.20.50_ZH.md)和[英文版](docs/releases/v0.20.50.md)。

当前兼容性和操作边界：

- EDA 4.1.78 下，需要 EDA 4.2 的 14 条指令均已停用并在版本检查处拒绝；EDA 4.2 下的正向执行和持久性尚未验收。
- `routeTrack` 与 SES 线段输入受插件策略保护：任何短于 1 mil 的线段都会在写入前被拒绝。这是插件策略，不是 SDK 最短长度限制。
- `pcb.connectComponentPadDirect` 暂时停用；兼容入口会在访问工程或 SDK 前拒绝调用。
- `modifyPour` 中改网或改名的请求会在写入前拒绝。自动布线 SES 回灌已禁用；检查和明确导入仍是分开的操作。

这些保护和分项检查不代表所有底层问题、几何结果、覆铜填充或持久性问题都已修复。证据范围和限制见版本说明。

页面展示的“小机器人画电路板”图标是项目 Logo；市场发布图标文件为 `images/logo-marketplace.png`。

## 下载与安装

原插件仓库提供扩展包，以及运行本地 Node 代理所需的源码。其 v0.20.50 正式版附件为插件包和源码 ZIP；源码仓库不再提供完整 AI 技能。历史标签源码包可能包含旧技能文件；当前 main 分支源码 ZIP 仅含插件/代理和迁移说明。本地准备的 v0.20.124 尚未公开，不能作为下载版本。

- [插件 GitHub Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases)：下载扩展包与插件/代理源码 ZIP。
- [独立技能仓库](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)：查看技能文档。
- [最新独立技能版本](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/latest)：下载技能 ZIP，再安装其中完整的 `ai-command-engine/` 目录。
- [技能入口文件](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/blob/main/ai-command-engine/SKILL.md)。

技能仓库使用独立的日期版本，本次拆分日期为 2026.10.28。技能版本与插件版本相互独立，不需要随插件每次升级。英文 `SKILL.md` 和中文 `SKILL_ZH.md` 共用一个安装目录；保留 `references/zh/` 和脚本。不要从插件源码仓库复制技能目录。

扩展、代理和 AI 技能需要分别安装。Node.js 代理安装步骤见[安装与使用指南](docs/QUICKSTART.md)；市场扩展不会自动安装代理或 AI 技能。
## 首次使用

请按[安装与使用指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md)完成 Node.js 与代理依赖、EDA 扩展安装、外部交互授权、首次只读验证和 AI 技能安装。要运行代理，请在仓库目录执行：

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
npm ci
node bridge/command-proxy.mjs
```

ZIP 用户在解压后的仓库目录运行 `npm ci` 和 `node bridge/command-proxy.mjs`。保留代理终端，再从 [Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) 下载 `.eext`，在 EDA 插件管理界面导入、启用并允许外部交互。再从[独立技能仓库最新版本](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/latest)下载技能 ZIP，并将完整的 `ai-command-engine/` 目录安装到 AI 工具的技能目录，并在 EDA 菜单点击“AI 指令引擎”→“启动桥接”。安装扩展不会在本机部署代理或向 AI 工具安装技能；完整步骤见[首次使用指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md)。

Windows 提供可选的 URL 协议启动方式；注册和生命周期说明见[桥接生命周期文档](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/BRIDGE-LIFECYCLE.md)。普通调用不需要 GitHub CLI；只有选择使用可选的问题上报功能时才需要它。SMT 物料查询另需[嘉立创开放平台](https://open.jlc.com)凭据，配置见[物料查询指南](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/QUICKSTART.md#5-可选-smt-物料查询)。

## 安全与验证边界

- 每条 `/command` 请求都须携带顶层 `instanceId`；先查询连接并核对目标窗口。图页操作还要确认页身份。
- 写入超时不表示操作已取消；遇到未知结果或写保护时先只读核实，不要盲目重试。
- 插件/API 返回、保存读回、关闭后重开读回和生产验收代表不同证据。命令成功、DRC 或模拟回归都不能单独证明电路正确。
- 问题上报只使用已取得且可公开的必要证据。提交前需告知使用者；GitHub CLI、Issue 创建和登录都是可选流程。提交入口见[GitHub Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues)。

## 开发者资料

插件源码与代理见[原仓库](https://github.com/quhuii-lgtm/easyeda-aicommand)，完整 AI 技能见[独立技能仓库](https://github.com/quhuii-lgtm/easyeda-aicommand-skill)。本地回归、构建、宿主验证等信息会在对应版本说明中分别标明。项目更新记录见 [CHANGELOG](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/CHANGELOG.md)，构建框架历史见 [SDK changelog](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/docs/SDK-CHANGELOG.md)。

[Apache-2.0 许可](https://github.com/quhuii-lgtm/easyeda-aicommand/blob/main/LICENSE)。
