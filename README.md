# EasyEDA AI Command（easyeda-aicommand）

嘉立创 EDA 专业版（EasyEDA Pro）的 AI 指令引擎：用简易 JSON 指令通过本地代理操作原理图 / PCB / 工程 / 元件库，配套 AI 使用侧技能（skill），**插件与技能同步安装、同步发布**。

当前版本：**0.10.73**（插件）。代理（bridge）无版本号，随仓库最新代码运行。

## 组成部分

| 目录 | 内容 |
| --- | --- |
| `src/` + `extension.json` | EDA 插件本体（206 条指令：schematic./pcb./project./library./editor./macro 等） |
| `bridge/` | 指令代理 `command-proxy.mjs`：HTTP + WebSocket 桥，写指令单行道、写保护状态机、SMT 物料查询、lane-log 对账 |
| `skills/ai-command-engine/` | AI 使用侧技能：SKILL.md + references（指令手册 setup/workflow/pitfalls/tasks），教 AI 安全正确地调用本插件 |
| `test/` | 回归测试（守卫单测、结构审计回归等） |
| `bridge/mock-host-test.mjs` | 代理状态机假宿主回归（19 用例，独立端口，不触真实 EDA） |

## 安装（三部分一起装）

### 1. 装 EDA 插件

Release 页下载 `ai-command-engine_vX.Y.Z.eext`，在嘉立创 EDA 专业版「文件 → 导入 → 专业版插件」导入。打开工程后插件自动连接本地代理（首次会自动拉起）。

### 2. 装指令代理

代理是独立 Node 脚本，插件依赖它通信：

```bash
node bridge/command-proxy.mjs        # 监听 127.0.0.1:49720
```

环境变量：`PORT`（改端口）、`PROXY_IDLE_MS`（空闲退出毫秒，0=常驻）、`PROXY_CMD_TIMEOUT_MS`（指令超时，默认 300000）。全部扩展断开后默认 300 秒自动退出，打开 EDA 会自动拉起。

### 3. 装 AI 技能

把 `skills/ai-command-engine/` 整个目录拷到你的 AI 工具技能目录（Kimi Work：技能目录下；其他工具按其技能规范）。AI 加载该技能后即可获得全部指令手册与安全守则。

> 三步缺一不可：插件干活、代理传话、技能教 AI 怎么发话。

### 4. （可选）配置查询物料密钥

要用 `smt.queryComponent`（SMT 可贴装物料查询）才需要配置，一次性，不配置不影响画图等其他全部功能。

**获取密钥**（嘉立创开放平台，约 1 分钟）：

1. 打开 https://open.jlc.com ，登录嘉立创账号
2. 点「快速接入」→「创建应用」，一键生成应用密钥
3. 记下三个值：**appId（应用ID）、accessKey（应用API密钥）、secretKey（应用密钥）**

**填写密钥**：

1. 启动代理后（`node bridge/command-proxy.mjs`，或打开 EDA 自动拉起），浏览器打开 `http://127.0.0.1:49720/smt`
2. 把三个值粘贴进对应输入框，保存
3. 密钥写入 `bridge/jlc-credentials.json`，**只需配置一次**：升级插件/代理不丢失，保存后即时生效（不用重启代理），页面也支持人工查询物料

> ⚠️ 安全：jlc-credentials.json 含 secretKey，**不要提交到 git、不要外发**（本仓库 .gitignore 已排除）。SMT 查询走代理本地签名调用，密钥不出本机。

**验证**：

```bash
curl -X POST http://127.0.0.1:49720/command \
  -H "Content-Type: application/json" \
  -d '{"cmd":"smt.queryComponent","instanceId":"<实例ID>","params":{"queryString":"0603 10k"}}'
```

未配置时该指令会返回明确报错并提示去 `/smt` 页面填写。

## 快速验证

```bash
# 代理存活 + 实例在线
curl http://127.0.0.1:49720/connections

# 发一条只读指令（instanceId 从 /connections 查，勿缓存）
curl -X POST http://127.0.0.1:49720/command \
  -H "Content-Type: application/json" \
  -d '{"cmd":"project.getInfo","instanceId":"<实例ID>","params":{}}'
```

## 核心可靠性设计（0.10.73）

- **写指令单行道**：每窗口 FIFO 一次一条，官方 API 并发容量低的根治
- **写保护状态机**：写超时/心跳超时 → 该实例拒绝一切写，直到可信迟到结果或显式 `write.acknowledge`；入队+出队双重检查；按实例号键，断线重连不清除
- **文档守卫**：schematic./pcb. 指令校验焦点文档类型与可选 `__docUuid`，杜绝写到错误页
- **instanceId 硬校验**：/command 必须带顶层 instanceId，多 AI 并行互不串台
- **lane-log 对账**：写队列/保护/连接事件全量 JSONL，出问题先查日志

## 构建与回归

```bash
npm install && npm run build     # 产出 build/dist/ai-command-engine_v*.eext
node bridge/mock-host-test.mjs   # 代理状态机 19 用例（约 20 秒）
```

## 许可证

Apache-2.0（见 LICENSE）
