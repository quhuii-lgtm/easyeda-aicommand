# Bridge lifecycle in v0.20.57

Historical partial/timeout results no longer lock later independent requests. The proxy keeps the existing per-window request FIFO, which advances after the current response or configured timeout. A timeout does not cancel SDK calls that may still run in the host; it does not certify recovery. Current macro dependency steps still stop on partial. `write.acknowledge` is a compatibility no-op and is not required. The matching proxy reports `writeProtection:false` in `/health`.

## Background heartbeat correction

The proxy sends an application-level `ping` in its existing 20-second transport keepalive loop. The extension immediately replies with `pong`, so a background window does not depend on its 10-second timer running on schedule to receive evidence that the proxy is alive. Transport ping/pong alone does not update the extension's application-message timestamp.

After 35 seconds without an application message, the client probes the current connection rather than immediately marking it disconnected. Accepted work keeps its current-generation result path. If the probe remains unanswered for another 35 seconds and no command is in flight, the client retires that connection; stale callbacks cannot execute commands or return results through a replacement connection. Stop/drain and resume remain in effect; historical uncertain-write protection was removed in v0.20.57.

Use the matching extension and proxy when upgrading. Do not replace a running proxy while operations are active. Fake-API regressions, real-host module checks, and installed-package checks are separate forms of evidence; a module check does not certify package installation or menu integration.

## Earlier lifecycle records (v0.10.74–0.10.79)

This release gives each EDA window explicit start, stop, and reconnect behavior. Stopping the extension is not the same as disabling or uninstalling it in EDA.

## Behavior and acceptance

| Requirement | Behavior | Evidence |
| --- | --- | --- |
| Start | An active window start is idempotent. An inactive window checks `/health` and starts the registered local launcher if needed. | Startup scripts and client integration; isolated launcher checks are recorded by the maintainer. |
| Stop | The client sends `stop` with a request ID and nonce. The proxy immediately pauses dispatch and responds `stop-accepted`; already-dispatched requests can still return. Queued writes drain from the proxy lane and are rejected when they reach dispatch. | `node bridge/lifecycle-mock-test.mjs` |
| Multiple windows | The proxy only completes the stop for the owning instance/socket. Other active windows keep the shared process alive. | Lifecycle mock, multi-window case. |
| Safe idle exit | The proxy exits only after the configured idle period with no unpaused connections, pending requests or queued writes. Replayed paused hello frames do not restart the idle clock. | Lifecycle mock, short isolated idle threshold. |
| Partial / uncertain result | Partial and timeout responses remain errors but do not retain a lock. Stop completes automatically after pending requests and accepted queues drain; no acknowledgement is required. | Lifecycle mock, partial-result case. |
| Reconnect / stop-start race | Every stop and completion is matched by request ID. Resume cancels an outstanding stop without replacing the socket; a stale completion must be ignored by the client. | `node test/bridge-client-lifecycle.mjs`, 9/9 passed; type check and build. |
| Existing proxy compatibility | `/health` reports `service: ai-command-proxy` and `lifecycleProtocol: 1`. The launcher refuses an occupied port serving an older or different service. | Isolated launcher checks; no real machine registration or service start performed. |

Earlier regression snapshot (before the v0.20.57 lock removal): `node bridge/lifecycle-mock-test.mjs` passed 11/11; `node bridge/mock-host-test.mjs` passed 21/21; `node test/bridge-client-lifecycle.mjs` passed 9/9. TypeScript checking and packaging build passed.

The stop wire messages are `stop(requestId, nonce)`, `stop-accepted(requestId)`, then `stop-ready(requestId)` after pending requests drain. Older proxies may send `stop-blocked`; the client retains compatibility handling. The client may send `bye(requestId)` only after a matching `stop-ready`. A valid `resume` cancels the pending stop and receives `resume-accepted`; a nonce mismatch receives `resume-rejected`. Result, progress, and late-result handling are tied to the WebSocket owner as well as the request ID.

## Windows setup

After `npm ci`, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\install-url-scheme.ps1` once to register this repository for the current user. The execution policy bypass applies to this script invocation only and does not change the machine policy. Registration does not start or stop the proxy. If the repository moves, run it again. Use `-Force` only when intentionally replacing an existing `ai-command-proxy` registration. To remove this repository's registration, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\uninstall-url-scheme.ps1`. The launcher only accepts `ai-command-proxy://start`, checks the service identity/protocol, and starts Node hidden after verifying Node.js and the `ws` dependency.

Do not replace a running older bridge underneath active operations. Finish or safely stop those operations, then install the matching bridge and extension. The launcher leaves an unknown or incompatible listener alone and reports the conflict.

## Verification boundary

The lifecycle and host mocks start isolated proxy processes on test ports and fake WebSocket extensions. Client state-machine tests use a fake EDA API. All recorded mock tests passed as listed above. These are not live EDA tests. URL registration was checked with PowerShell `-WhatIf`; the protocol handler was not registered on this computer. The actual EDA host's WebSocket auto-reconnect behavior, menu presentation, and packaged install remain unverified until a real client test.

0.10.77 补充：SDK 活跃同名 WebSocket 注册不替换回调，因此每次连接采用实例及代际唯一 ID。退役先使旧回调失效，再调用官方 close；close 的 void 返回不证明物理连接已关闭。抛错时保留待关闭 ID，停止自动替换，显式启动或重连先重试关闭。已验证真实 SDK 新连接握手、重连后帮助回包及停止握手；最终安装包菜单和多窗口组合仍须安装后验证。

0.10.78 补充：.77 安装版菜单复现新执行环境创建第二个客户端，证明上面的客户端探针不足以覆盖菜单入口。入口现改为同窗口扩展私有消息总线同步发现唯一所有者，登记查询回复及唯一 RPC 服务后才启动连接；菜单通过该服务调用原客户端。SDK 同主题 RPC 服务会轮询，因此不能复用固定 RPC 主题。无所有者、多所有者、初始化未完成和消息总线异常明确失败，不自动创建替代连接。升级前关闭并重新打开 EDA 窗口，清除不参与新协议的旧执行环境。真实模块验证和最终包安装验证分别记录，前者不代替后者。

2026-10-07 安装版补验：0.10.78 实际菜单重新连接后仍只有原实例一条活动连接、帮助返回207条指令；实际停止后connections为空；实际启动后恢复同一实例并成功读取目标工程。此结果覆盖当前单窗口安装场景，未替代两个正式安装窗口并行验收。

## 0.10.88 冷启动修复说明（待宿主验收）

已安装宿主的 HTTP 转发层可能将 `127.0.0.1` 拒绝连接包装成 HTTP 500 JSON，导致扩展把未运行的桥接当成不兼容服务、跳过启动。0.10.88 仅将扩展内部健康探测改为 `http://localhost:49720/health`，利用宿主对此地址的直接请求路径；WebSocket、监听地址和 Windows 启动器不变。真实异服务/旧服务仍拒绝，不因 HTTP 500 盲目新起进程。localhost 在当前宿主内的解析及完整冷启动须用安装版另行验证，手动启动成功不算冷启动通过。

若提示“WebSocket 调试模式连接重试已达最大次数”或要求 `npm run dev`，这是宿主扩展开发调试连接，与 AI Command 的桥接重连不是同一条链。正常使用安装包不需要启动开发服务器；不要靠启动无关调试服务来掩盖桥接故障。