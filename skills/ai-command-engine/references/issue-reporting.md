# 插件问题上报

本流程随 AI Command Engine 技能使用。遇到插件错误、读回与返回结果不一致等问题，AI 按下面格式整理记录，在提交前告知使用者，然后用使用者当前的 GitHub 身份提交到 `quhuii-lgtm/easyeda-aicommand`。不需要逐条等待再次确认；使用者明确要求不提交时，遵从该要求。

## AI 操作规则

1. 只记录本次实际遇到的插件问题。缺少关键复现信息时先补充，无法确认的版本填“未知”；区分已观察事实与原因猜测。
2. 只使用任务中已取得、可公开的必要证据。删除密钥、令牌、个人信息和私有工程内容；不能为了上报扫描整个工程、上传完整日志或工程文件。工具不会自动脱敏，AI 必须在写入报告前完成检查。
3. 保存 UTF-8 JSON 报告到系统临时目录，在插件仓库目录运行 `preview`，读取将提交的标题和正文。
4. 在对话中告知使用者：将以其 GitHub 身份公开提交到哪个仓库、问题标题、主要内容及包含哪些证据。告知后直接执行 `submit`，不再增加逐条确认步骤。仅工具输出不等于已告知使用者。
5. 提交成功后返回 Issue 链接。未登录、缺少工具或 GitHub 拒绝请求时如实报告，保留本地草稿，不能报告为已提交。工具对 GitHub 拒绝只返回通用拒绝信息，不凭状态码猜测权限或限流原因。
6. 创建结果未知时，先到问题列表核对，不能盲目重发。已经创建但读回失败时，提供工具保留的 Issue 链接并说明尚未核验，不能重复创建。

这是一项由 AI 显式执行的本地工具，不是后台错误监控；EDA 命令执行本身不会自动上传数据。脚本无法证明对话中是否已经告知，AI 负责执行以上流程。

## 首次准备

- 已安装 Node.js >=20.17.0（与指令代理要求一致）。
- 安装 [GitHub CLI](https://cli.github.com/)，由使用者完成一次登录：

```powershell
gh auth login --hostname github.com --web
gh auth status --hostname github.com
```

使用 GitHub CLI 当前有效身份，环境中已配置的 `GH_TOKEN` / `GITHUB_TOKEN` 也可能影响该身份。需要换账号时由使用者通过 GitHub CLI 切换。浏览器或 Git 的登录状态不等于 GitHub CLI 已登录。

工具不索取、读取输出或保存 GitHub 令牌；凭证由 GitHub CLI 管理。不要把令牌写入报告、插件源码或聊天。此功能不需要开启 EDA、连接指令代理或提供 `instanceId`。

## 报告格式

所有字段都是字符串。必填：`title`、`pluginVersion`、`edaVersion`、`os`、`steps`、`expected`、`actual`。可选：`command`、`evidence`。不支持其他字段；不会静默丢弃未知字段。

```json
{
  "title": "[问题] 保存后返回成功，但目标文本仍存在",
  "pluginVersion": "0.10.87",
  "edaVersion": "未知",
  "os": "Windows 11",
  "steps": "1. 打开测试图页\n2. 执行删除目标文本\n3. 保存后重新读取目标",
  "expected": "目标文本被删除，读回确认不存在。",
  "actual": "返回成功，但读回仍存在。此处仅为格式示例，不是真实缺陷证据。",
  "command": "schematic.delete；对象标识已替换",
  "evidence": "只放与问题有关且已脱敏的错误片段。"
}
```

上例仅演示格式，禁止直接提交为真实问题。`evidence` 为正文文本，不会自动读取附件或文件路径。一个问题一条记录，避免重复提交同一已记录问题。

## 预览和提交

在包含 `bridge` 的插件仓库目录运行，`--file` 指向 AI 已生成的报告：

```powershell
node bridge/report-issue.mjs preview --file "$env:TEMP\aicommand-issue.json"
node bridge/report-issue.mjs submit --file "$env:TEMP\aicommand-issue.json"
```

`preview` 只做本地格式校验和正文渲染，不联网。`submit` 会公开创建 Issue：先检查 GitHub CLI 登录，再提交，最后按返回编号读回并核对标题、正文和链接。所有调用固定到 `github.com/quhuii-lgtm/easyeda-aicommand`，不会采用当前目录的其他仓库。

退出码为 0 表示该操作成功；非 0 时读取 JSON 错误结果。无自动登录、自动重试或后台重发。提交结果未知不等于未创建。

GitHub 网页表单位于仓库 `.github/ISSUE_TEMPLATE/bug_report.yml`，使用同一组信息字段。网页提交和 API 提交分别校验，网页表单不会代替本工具的输入校验。

## 验证边界

本地模拟测试：`node test/issue-report-regression.mjs`。模拟测试不创建公开 Issue，也不能代替真实 GitHub 登录和联网验收。

官方依据：[GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login)、[GitHub CLI API](https://cli.github.com/manual/gh_api)、[创建 Issue](https://docs.github.com/en/rest/issues/issues#create-an-issue)。
