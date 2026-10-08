# 首次安装与使用

本指南从一台尚未配置本插件的电脑开始。插件、代理和 AI 技能是三个独立部分；只下载 `.eext` 不会安装 Node.js、代理依赖或 AI 技能。

## 环境与兼容范围

| 项目 | 要求与验证范围 |
| --- | --- |
| EDA | 嘉立创 EDA 专业版桌面客户端。仓库历史操作记录包含 4.1.60；部分指令注明需要 4.2+，不能据此认为所有版本都支持所有指令。插件声明的 `^3.2.0` 是宿主加载范围，不是完整实测兼容矩阵。 |
| 操作系统 | 以下给出 Windows PowerShell 步骤；macOS/Linux 的完整安装链路尚未验证。 |
| Node.js / npm | Node.js >=20.17.0，附带 npm。用 `node --version`、`npm --version` 检查。 |
| Python | 可选，仅 `scripts/eda.py` 助手及其测试需要；已使用 Python 3.12 测试。直接 HTTP 调用不需要 Python。 |
| 网络与账号 | 按 EDA 本身要求登录；下载仓库、插件和 npm 依赖需要联网。普通画图无需配置嘉立创开放平台密钥。 |

## 1. 下载仓库并安装代理依赖

从 [仓库首页](https://github.com/quhuii-lgtm/easyeda-aicommand) 的 Code → Download ZIP 下载并解压到固定目录，或使用 Git：

```powershell
git clone https://github.com/quhuii-lgtm/easyeda-aicommand.git
Set-Location easyeda-aicommand
```

ZIP 用户在解压后的仓库目录打开 PowerShell。确认该目录包含 `package.json` 和 `bridge`，然后执行：

```powershell
node --version
npm --version
npm ci
node bridge/command-proxy.mjs
```

`npm ci` 使用锁定依赖；不要加 `--omit=dev`，当前 `ws` 在开发依赖中。此步骤不需要 `npm run build`。完成后可注册当前仓库的用户级 URL 启动入口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\install-url-scheme.ps1
```

这会把 `ai-command-proxy://start` 注册到当前 Windows 用户；不启动或停止代理。本命令只对本次脚本运行绕过执行策略，不修改机器策略。仓库固定在该目录后再注册；移动仓库后重新运行脚本。需要移除时运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\uninstall-url-scheme.ps1`。手动启动可双击 `bridge/launch-proxy.bat`。

默认使用 49720。不要只改代理的 `PORT`：发布插件、启动器和 Python 助手默认都连接 49720，目前没有面向普通用户的一键改端口入口。

启动器只接受 `ai-command-proxy://start`。如果默认端口上有其他程序或旧版代理，它会报不兼容并停止；它不会悄悄替换或结束现有服务。先让旧服务的操作完成，再更新桥接和插件。若注册目标已指向旧仓库，只有确认要替换后才运行 `.\bridge\install-url-scheme.ps1 -Force`。

## 2. 安装并连接 EDA 插件

1. 从 [Releases](https://github.com/quhuii-lgtm/easyeda-aicommand/releases) 下载 `ai-command-engine_v*.eext`。源代码 ZIP 与 `.eext` 用途不同。
2. 在 EDA 的扩展/插件管理界面导入该 `.eext`，启用插件并勾选“允许外部交互”。不同 EDA 版本菜单位置可能不同，以当前客户端的插件导入入口为准。
3. 新建一个用于试用的空白工程及原理图页，打开该页。
4. 在“AI Command”菜单使用“启动桥接”“停止桥接”或“重新连接桥接”。启动已连接的窗口是幂等操作；重新连接会先排空本窗口已有请求，再换连。停止会拒绝排队中的新写请求，交付已派发请求的结果后再断开本窗口。partial 或结果不确定时停止会明确报告并保留写保护。

v0.10.87 附件校验值见 [SHA256SUMS.txt](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/download/v0.10.87/SHA256SUMS.txt)。

可用 PowerShell `Get-FileHash -Algorithm SHA256 -LiteralPath '<下载的 eext 路径>'` 核对。校验值只适用于本次发布附件，不适用于自行重新打包的文件。

本版尚未完成完整宿主安装验收；升级后先在试用工程核对，验证边界见 [版本说明](releases/v0.10.87.md)。从旧版升级需关闭并重新打开 EDA 窗口，代理和技能也应更新到同一标签。

## 3. 完成第一次只读调用

在另一个 PowerShell 终端执行（代理终端保持开启）：

```powershell
$base = 'http://127.0.0.1:49720'
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/connections" | ConvertTo-Json -Depth 8
```

`/health` 应返回 `ok: true`；`/connections` 应列出已连接实例。先核对 `info.project` 和版本，复制刚查到的目标 `instanceId`。不要直接选第一项，也不要复用其他人的示例 ID。

```powershell
$instanceId = '<刚查询并核对的目标 instanceId>'
$body = @{
    cmd = 'project.getInfo'
    instanceId = $instanceId
    params = @{}
} | ConvertTo-Json -Depth 8
$result = Invoke-RestMethod -Uri "$base/command" -Method Post -ContentType 'application/json' -Body $body
$result | ConvertTo-Json -Depth 12
```

预期结果是 `ok: true`，且 `data` 中工程信息与试用工程一致。`ok: false` 仍可能使用 HTTP 200 返回，因此必须检查 JSON 的 `ok`。这一步验证了“电脑 → 代理 → EDA → 返回数据”，不会修改图纸。

需要核对图页时，使用同样的请求结构调用 `project.listSchematicPages`，按返回的工程层级、页名和 UUID 选定目标；`editor.openDocument` 用 `params.uuid` 激活该页，再以 `schematic.listComponents` 及 `params.__docUuid` 核对。空白页可以没有器件，关键是响应成功且目标页匹配。`__docUuid` 是页级核对参数，不能替代顶层 `instanceId`。

## 4. 安装 AI 技能

唯一维护的技能目录是 `skills/ai-command-engine/`。完整复制目录，保留 `references`、`scripts` 和 `SKILL.md`，不要只复制一个文件，也不要把仓库根目录当成技能安装。

Codex 本地安装位置通常是 `~/.codex/skills/ai-command-engine/`（Windows 为 `%USERPROFILE%\.codex\skills\ai-command-engine\`）。已有同名技能时先备份并比较差异，避免覆盖个人规则。其他 AI 工具通过其技能管理功能导入该目录；不支持技能加载的工具可以读取该目录的 `SKILL.md` 及所引用手册。

在新的会话中让 AI 确认能读取该技能及 `references/setup.md`，再给它以下试用请求：

> 使用 ai-command-engine，查询当前 EDA 实例，按工程名找到我刚建的试用工程。只读取工程信息和当前原理图器件，报告所用 instanceId、图页 UUID 和结果，不修改图纸。

先完成只读验证，再在试用工程上进行绘制。画图后需要保存读回、网络检查和图像核对；接口返回成功不代表电路设计已经正确。

可选 Python 助手：

```powershell
python skills/ai-command-engine/scripts/eda.py project.getInfo --instance-id '<刚查询并核对的目标 instanceId>'
```

## 5. 可选 SMT 物料查询

仅 `smt.queryComponent` 需要开放平台密钥。从 [嘉立创开放平台](https://open.jlc.com) 创建应用，取得 appId、accessKey、secretKey；启动代理后在浏览器打开 `http://127.0.0.1:49720/smt` 填写并保存。

密钥保存在当前仓库的 `bridge/jlc-credentials.json`，已被 `.gitignore` 排除。签名在本地完成，请求发送给嘉立创开放平台；不要将密钥文件、截图或请求认证信息附在 Issue 中。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 找不到 `node` 或 `npm` | 安装符合上述要求的 Node.js，重新打开终端并检查版本。 |
| `ERR_MODULE_NOT_FOUND` / 找不到 `ws` | 回到含 `package-lock.json` 的仓库根目录执行 `npm ci`，完成后重新启动代理。 |
| 连接被拒绝 | 确认代理已启动且使用默认 49720。所有窗口停止且没有待处理请求或写保护时，代理默认空闲 300 秒后退出；下次启动插件会再次检查并按需拉起。 |
| `EADDRINUSE` | 先查询 `/health` 确认是否是已有代理；若是其他程序占用，先解决端口冲突，不要只改单端口。 |
| `/health` 正常但没有实例 | 检查工程窗口、插件启用状态、“允许外部交互”和用户暂停状态，然后点击连接菜单。 |
| 缺少 `instanceId` | 每个完整 `/command` 请求都带顶层 `instanceId`，`/select` 不能代替它。 |
| `UNKNOWN_INSTANCE` / `TARGET_OFFLINE` | 重新查询 `/connections`，按工程身份核对目标；不要自动改投另一个实例。 |
| 焦点类型或 `__docUuid` 不匹配 | 核对目标页 UUID，显式打开正确文档，再只读验证。 |
| 超时或写保护拒绝 | 超时不等于取消。先查可用的 `task.get` 结果及现场只读数据；无法确认旧写结束时停止写入。`task.list` 为空不是解除依据，不要自动发送 `write.acknowledge`。详见技能的 pitfalls。 |

## 升级、停止与卸载

升级前完成当前操作并保存工程；记录插件版本、仓库提交和个人技能改动。备份当前目录的 `bridge/jlc-credentials.json`。Git 用户获取新版本前先处理自己的未提交修改；ZIP 用户使用新目录时，需要自行迁移密钥，不能假设它自动跟随。

停止旧代理终端（Ctrl+C），更新仓库、执行 `npm ci`，再启动代理；按发布说明导入匹配的 `.eext`，更新完整技能目录。重新查询 `/connections`，核对版本和工程。仅更新 `.eext` 不会更新外部代理或 AI 技能。

停用时在 EDA 菜单选择“停止桥接”；当前窗口的操作完成后断开，所有窗口均停止且无写保护时代理会在空闲阈值后自动退出。卸载时先运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\uninstall-url-scheme.ps1`，再从 EDA 扩展管理器卸载插件、移除 AI 工具中的技能；自行决定是否保留仓库、密钥和 `bridge/backups/` 备份。卸载脚本只移除指向当前仓库的注册项，不会更改其他安装。

## 反馈与验证边界

在 [Issues](https://github.com/quhuii-lgtm/easyeda-aicommand/issues) 提交操作系统、EDA/插件/Node 版本、仓库提交、最小复现步骤和脱敏后的报错。日志与工程内容可能含个人信息，分享前先检查。

仓库提供的模拟测试不等于完整客户端兼容性测试。本次文档修订不宣称完成所有平台的干净装机验收，也不提供未经实机核对的设置截图。
