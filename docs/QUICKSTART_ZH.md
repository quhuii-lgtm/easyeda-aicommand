# 首次安装与使用

[English](QUICKSTART.md) | 简体中文

更新日期：2026-11-04。0.20.127 改为由配套技能后台启动代理，插件自动连接。安装版验收范围限于启动和只读连接；渠道发布状态见各发布页面。

## 第一次安装：交给 AI 完成

把下面内容交给能访问本机文件和终端的 AI：

```text
请安装并连接嘉立创 EDA“AI 指令引擎”，只做环境设置与只读连接验证，不修改图纸。
1. 检查系统、Node.js和npm，Node.js要求>=20.17.0。
2. 下载 https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.03/ai-command-engine-skill_v2026.11.03_en-zh.zip，将完整ai-command-engine目录安装到当前AI工具的技能目录。保留个人修改，读取SKILL.md及references/setup.md。代理已经随技能提供，不需要完整插件源码或开发依赖。
3. 在技能根目录运行npm ci --omit=dev。由技能scripts/start-proxy.ps1隐藏后台启动代理；不要打开黑窗、不要注册或打开自定义URL链接。
4. 核对http://127.0.0.1:49720/health的service与lifecycleProtocol。兼容代理已运行就复用，不结束未知进程或强行升级运行中的服务。
5. 指导我从 https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127 取得配套.eext，在EDA导入、启用并允许外部交互。若需要人工点击，说明位置并等我完成。插件会自动连接；曾停止桥接时再点击启动桥接。
6. 查询/connections，核对插件版本与工程。显式使用目标instanceId调用只读project.getInfo，确认ok:true及工程身份。多个窗口不自动选第一项。
7. 报告环境、技能版本、代理健康、插件实例及只读调用结果。未完成项如实说明；安装或连接不代表绘图验收。
```

## 1. 安装技能和代理

从[技能 v2026.11.03 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/tag/v2026.11.03)下载[中英双语 ZIP](https://github.com/quhuii-lgtm/easyeda-aicommand-skill/releases/download/v2026.11.03/ai-command-engine-skill_v2026.11.03_en-zh.zip)，将完整技能安装到 AI 工具的技能目录。保留 `SKILL.md`、`SKILL_ZH.md`、`references/`、`scripts/`、`package.json`、`package-lock.json`、`VERSION` 和 `LICENSE`。重新加载技能。

在技能根目录运行一次：

```powershell
npm ci --omit=dev
```

这里只安装代理运行依赖，不需要下载插件源码或运行构建。更新技能后按新锁文件重装依赖。

## 2. 隐藏后台启动

由 AI 的终端工具执行，把占位路径替换为当前技能实际目录：

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<技能目录>/scripts/start-proxy.ps1"
```

启动器复用兼容代理，或隐藏启动 Node 并检查健康。失败返回错误，不弹系统链接或启动错误对话框。执行策略参数只对本次脚本生效。默认端口为 49720；不自动结束其他服务或改端口。

新启动器把运行数据放在 `%LOCALAPPDATA%/ai-command-engine`，技能更新不覆盖凭据、日志或备份。已有旧代理可继续运行并使用原数据目录，凭据不会自动迁移。插件源码仓库中的旧 `bridge/` 入口仅为兼容保留；新流程不依赖它或 URL 协议注册。

## 3. 安装 EDA 插件

从[插件 v0.20.127 发布页](https://github.com/quhuii-lgtm/easyeda-aicommand/releases/tag/v0.20.127)下载配套 `.eext`，在 EDA 导入并启用，允许外部交互。插件与技能分别安装，版本号独立；以发布说明及当前命令帮助核对适配。

插件自动连接代理。代理后启动也会接入；手动停止过桥接时，通过菜单“启动桥接”恢复。安装 `.eext` 不会安装 Node.js 或技能。

## 4. 只读验证

```powershell
Invoke-RestMethod http://127.0.0.1:49720/health
Invoke-RestMethod http://127.0.0.1:49720/connections | ConvertTo-Json -Depth 8
```

健康响应需确认 `service:"ai-command-proxy"`、`lifecycleProtocol:1`。核对连接中的版本和工程；每次请求在顶层指定目标 `instanceId`：

```json
{"instanceId":"<当前目标实例>","cmd":"project.getInfo","params":{}}
```

请求发往 `POST http://127.0.0.1:49720/command`。确认 JSON `ok:true` 和正确工程；HTTP 200 本身不证明成功。先查询实例命令帮助，不猜参数。不在首次连接检查中创建或修改电路。

## 故障与升级

- 缺少依赖时，在完整技能根目录运行 `npm ci --omit=dev`。
- 没有 EDA 连接时，检查插件启用、外部交互和桥接状态。
- 端口被未知或不兼容服务占用时，先识别服务，保留原进程及任务。
- 更新磁盘文件不代表运行中的代理或插件已更新。已有操作结束后再按需要更新运行实例。
- 更新插件前，先处理并保存每个 EDA 窗口中的未完成操作，再重新加载仍运行旧版插件的所有窗口。在一个窗口导入新包不能保证其他已打开窗口也升级。
- 发生超时先核对任务和实际内容，不盲目重发写操作。

Windows 隐藏启动是本轮实现目标；macOS/Linux 的完整启动体验未在本轮实测。SMT 查询密钥按需配置，普通画图不需要。保存、重开、DRC与生产验收按绘图任务分别完成。
