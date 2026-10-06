/**
 * 桥接客户端：扩展侧主动连接本地指令代理（WebSocket）
 *
 * 协议（JSON 文本帧）：
 * - 扩展 → 代理: { type: 'hello', extension: 'ai-command-engine', version }
 * - 扩展 → 代理: { type: 'ping' }（每 10 秒心跳）
 * - 代理 → 扩展: { type: 'command', id, cmd, params }
 * - 扩展 → 代理: { type: 'result', id, result: TCommandResult }
 *
 * 断线自动重连。需要扩展启用「外部交互」权限。
 *
 * 自动拉起代理：激活时先探测代理 /health，若代理未运行，
 * 尝试通过 URL Scheme（ai-command-proxy://start）唤起本地启动器
 * （需先运行一次 bridge/install-url-scheme.bat 注册协议）。
 */
import { executeCommand, getCommandDocs, listCommandNames } from '../engine/registry'
import { setDiagSink } from '../engine/diag'

const WS_ID = 'ai-command-engine'
const DEFAULT_PORT = 49720
const RECONNECT_MS = 5000
const HEARTBEAT_MS = 10000
/** 单条指令最长执行时间：EDA API 偶尔永不 resolve（如无工程窗口/模态框阻塞），
 *  超时强制返回错误，避免消息处理函数挂死导致整个扩展失联 */
// 0.10.37（KIMI-EDA-20261002-01）：全链路超时统一 300s——必须 ≤ 代理侧（command-proxy.mjs 已 300s），
// 否则外层等着、内层先掐造成"假超时、后台继续跑"。超时≠取消：EDA API 无取消机制。
const COMMAND_TIMEOUT_MS = 300000
const COMMAND_TIMEOUT_OVERRIDES: Record<string, number> = {
	'schematic.pruneFloatingLabels': 300000,
	'schematic.delete': 300000,
	'pcb.delete': 300000,
	'pcb.groupBySchematicRegions': 300000,
	'pcb.sourceRollback': 300000,
}
/** 本扩展实例 ID：同一台机器可能开着多个 EDA 窗口，每个窗口一个实例，供代理区分与选路 */
const INSTANCE_ID = Math.random().toString(16).slice(2, 10)

let started = false
let connected = false
/** 菜单「断开指令代理」置位：暂停自动重连，直到再次 startBridgeClient() */
let manualStop = false
/** 0.10.69（KIMI-EDA-20261006-01）：恢复口令。模块级随机数，随 hello/pause/resume 帧携带。
 *  代理只在口令匹配时才允许清除「断开指令代理」的暂停态——防止旧版本残留模块的重放 hello
 *  或其他客户端越权恢复（实测：EDA WebSocket 封装会重放历史 hello 帧，把暂停冲掉；
 *  system.eval 已被官方沙箱禁用，外部无法读本变量）。每次「断开」会轮换口令。 */
let resumeNonce: string | null = null
function getResumeNonce(rotate = false): string {
	if (rotate || !resumeNonce)
		resumeNonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
	return resumeNonce
}
/** 最近一次收到代理任何消息（pong/指令/describe）的时间戳；心跳据此判定半开连接 */
let lastHeardAt = 0
/** 超过该时长没收到代理任何消息，判定连接已死，强制重连 */
const SILENCE_DEAD_MS = 35000
/** 0.10.71：最近一次尝试自动拉起代理的时间戳；自动拉起从"一生一次"改为"每 5 分钟最多一次"。
 *  旧 autoLaunchTried 一生一次导致代理空闲退出/崩溃后数小时黑窗（2026-10-06 凌晨实发：
 *  05:56 代理退出，09:05 才复活）——重连循环里定期重试拉起，代理随 EDA 在、EDA 全关才退 */
let lastLaunchAttemptAt = 0
const LAUNCH_RETRY_MS = 5 * 60 * 1000
/** 0.10.71：在途指令计数。自动重连/判死前若仍有指令在跑，推迟——重连会作废在途结果，
 *  批量接线途中撞上 2 分钟重连churn会被整体作废（凌晨 Luna 会话"只读查询超时"实发） */
let inflightCommands = 0
/** 连接代际（0.10.65）：每次 connect() 递增。同一 WS_ID 强制重连/快速断连时，
 *  旧连接迟到的 close/error 事件与旧在途指令的 result 帧按代际校验丢弃，
 *  防止旧事件抹掉新连接的 connected 标志、旧结果发到新连接上 */
let connectionGeneration = 0

export function isBridgeConnected(): boolean {
	return connected
}

function log(message: string): void {
	try {
		eda.sys_Log.add(message)
	}
	catch {
		// 日志失败不影响主流程
	}
}

async function handleMessage(event: MessageEvent<any>, gen: number): Promise<void> {
	// 过期代际的事件全部丢弃：只属于当前连接的 close/error 才复位标志（0.10.65 修复）
	if (gen !== connectionGeneration)
		return
	// 连接关闭/出错事件：复位标志，让 5 秒重连循环接管
	const eventType = (event as any)?.type
	if (eventType === 'close' || eventType === 'error') {
		connected = false
		return
	}

	let msg: any
	try {
		msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
	}
	catch {
		return
	}

	// 收到代理任何消息都说明连接活着
	lastHeardAt = Date.now()
	if (msg?.type === 'pong')
		return

	if (msg?.type === 'describe') {
		// 代理询问本实例身份：回报当前工程名与打开的标签页，用于多窗口选路。
		// 注意：无工程窗口上这些 API 可能永不 resolve，必须各自限时，
		// 否则 describe 挂起会堵死后续所有指令的消息循环
		const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
			Promise.race([p, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms))])

		let project: string | null = null
		const tabs: Array<string> = []
		try {
			const info: any = await withTimeout((eda.dmt_Project as any).getCurrentProjectInfo(), 5000)
			project = info?.friendlyName ?? info?.name ?? null
		}
		catch {}
		try {
			const tree: any = await withTimeout((eda.dmt_EditorControl as any).getSplitScreenTree(), 5000)
			const walk = (node: any): void => {
				if (!node)
					return
				if (Array.isArray(node.tabs)) {
					for (const t of node.tabs)
						tabs.push(String(t?.title ?? ''))
				}
				if (Array.isArray(node.children))
					node.children.forEach(walk)
			}
			walk(tree)
		}
		catch {}
		// 复审补强（0.10.65）：info 帧发送前补代际校验——describe 处理期间若发生强制重连，
		// 迟到的旧快照会发到新连接上，与 result/progress 帧口径对齐
		if (gen !== connectionGeneration || !connected)
			return
		try {
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'info', instanceId: INSTANCE_ID, project, tabs }))
		}
		catch {}
		return
	}

	if (msg?.type !== 'command')
		return

	// 代理端伪指令：指令清单与文档查询
	let result: unknown
	if (msg.cmd === '__listCommands') {
		result = { ok: true, cmd: msg.cmd, data: listCommandNames() }
	}
	else if (msg.cmd === '__help') {
		const docs = getCommandDocs()
		const cmd = msg.params?.cmd
		result = { ok: true, cmd: msg.cmd, data: cmd ? docs.filter(doc => doc.name === cmd) : docs }
	}
	else {
		// 超时兜底：任何一条指令挂起都必须能返回错误，绝不能拖死消息循环。
		// 0.10.49：心跳感知超时——长指令（批量删除/batchWire/macro）执行中会通过 ctx.onProgress
		// 持续上报进度，每次心跳重置计时窗口；超时语义从「绝对时长」变为「无心跳时长」，
		// 批量指令不会因总时长被误杀。单条指令不上报心跳，语义与旧版一致（绝对时长）。
		const timeoutMs = COMMAND_TIMEOUT_OVERRIDES[msg.cmd] ?? COMMAND_TIMEOUT_MS
		let lastBeatAt = Date.now()
		// 0.10.65：watchdog 引用提到外层，指令正常完成时由 finally 立即清理——
		// 旧版只在超时分支 clearInterval，正常路径的 interval 会空转到超时点才自清理（每条指令泄漏一个定时器）
		let watchdog: ReturnType<typeof setInterval> | undefined
		try {
			// 0.10.71：在途计数——重连/判死逻辑据此推迟，避免作废在途结果
			inflightCommands++
			result = await Promise.race([
				executeCommand({ cmd: msg.cmd, params: msg.params }, {
					vars: {},
					onProgress: (patch) => {
						lastBeatAt = Date.now()
						// 0.10.65：连接已被重连取代时不再往新连接发旧指令的心跳
						if (gen !== connectionGeneration || !connected)
							return
						try {
							// 进度载荷截断到 2000 字符——心跳通道是辅助设施，不搬大件数据。
							// 0.10.65 修复：旧版截断后再 JSON.parse 必抛（截断串不是合法 JSON），
							// 大载荷心跳被静默吞掉（恰是最需要心跳的长指令贴近误杀）——改为对象级降级
							let payload: any = patch ?? {}
							if (JSON.stringify(payload).length > 2000)
								payload = { truncated: true, keys: Object.keys(patch ?? {}) }
							eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'progress', id: msg.id, progress: payload }))
						}
						catch {
							// 心跳发送失败静默——不影响指令本身
						}
					},
				}),
				new Promise((_, reject) => {
					watchdog = setInterval(() => {
						if (Date.now() - lastBeatAt > timeoutMs) {
							if (watchdog)
								clearInterval(watchdog)
							reject(new Error(`指令 ${msg.cmd} 执行超时（${Math.round(timeoutMs / 1000)}s 无进度心跳，EDA API 可能未响应，存在模态框或工程未打开）。注意：超时≠取消，指令内部可能仍在后台执行，重发同参数只回进度不重复执行，或 task.get 查询`))
						}
					}, 3000)
				}),
			])
		}
		catch (err) {
			result = { ok: false, cmd: msg.cmd, error: String((err as Error)?.message ?? err) }
		}
		finally {
			inflightCommands--
			if (watchdog)
				clearInterval(watchdog)
		}
	}
	// 0.10.65 修复：result 发送是唯一无 try/catch 的 send（旧版断线瞬间必抛未处理 rejection）；
	// 且连接已被重连取代时代际不符，丢弃本结果帧（旧 id 落到新连接会困扰代理；该指令由代理 300s 超时兜底）
	try {
		if (gen === connectionGeneration && connected)
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'result', id: msg.id, result }))
		else
			log(`指令 ${msg.cmd} 的结果帧已随旧连接作废（连接已被重连/断开取代），丢弃`)
	}
	catch (err) {
		log(`结果帧发送失败（连接可能刚断开）: ${String(err)}`)
	}
}

function connect(port: number): void {
	try {
		const gen = ++connectionGeneration
		eda.sys_WebSocket.register(
			WS_ID,
			`ws://127.0.0.1:${port}/ws`,
			event => void handleMessage(event, gen),
			() => {
				// 0.10.65：onOpen 也可能是旧连接的迟到回调，代际不符直接丢弃
				if (gen !== connectionGeneration)
					return
				connected = true
				lastHeardAt = Date.now()
				eda.sys_WebSocket.send(WS_ID, JSON.stringify({
					type: 'hello',
					extension: 'ai-command-engine',
					version: (globalThis as any).__aiCommand?.version ?? 'unknown',
					instanceId: INSTANCE_ID,
					// 0.10.68（KIMI-EDA-20261006-01）：声明菜单「断开指令代理」暂停态——代理对
					// 暂停态 hello 登记后立即断开并持续挡回 EDA 封装的自动重连（连接归零后
					// 代理自动退出）；恢复时 manualStop 已被 startBridgeClient() 复位，带 false 正常建立
					paused: manualStop,
					// 0.10.69：恢复口令——代理仅在口令匹配时才允许清除暂停（防旧模块重放 hello 越权恢复）
					nonce: getResumeNonce(),
				}))
				log(manualStop
					? 'AI Command Engine 已连接指令代理（暂停态：代理将挡回本连接，全部断开后后台自动退出）'
					: 'AI Command Engine 已连接指令代理')
			},
		)
	}
	catch (err) {
		connected = false
		log(`AI Command Engine 连接指令代理失败: ${String(err)}`)
	}
}

/** 探测代理健康状态；未运行时通过 URL Scheme 自动拉起。0.10.71 起每 5 分钟最多试一次
 *  （旧"一生一次"会留下数小时黑窗）；调用方（激活/重连循环）可高频调用，由时间窗节流 */
async function probeAndAutoLaunch(port: number): Promise<void> {
	try {
		const resp = await eda.sys_ClientUrl.request(`http://127.0.0.1:${port}/health`, 'GET')
		if (resp?.status === 200)
			return
	}
	catch {
		// 代理未运行或不可达
	}

	if (Date.now() - lastLaunchAttemptAt < LAUNCH_RETRY_MS)
		return
	lastLaunchAttemptAt = Date.now()

	log('AI Command Engine 未检测到指令代理，尝试自动拉起（ai-command-proxy://start）...')
	try {
		eda.sys_Window.open('ai-command-proxy://start', '_blank' as any)
	}
	catch (err) {
		log(`AI Command Engine 自动拉起失败: ${String(err)}，请手动运行 start-services.bat`)
	}
}

/** 启动桥接客户端，断线每 5 秒自动重连。
 *  已启动时重复调用 = 立即强制重连一次（菜单「连接指令代理」/重启后台后用） */
export function startBridgeClient(port: number = DEFAULT_PORT): void {
	manualStop = false
	if (started) {
		// 已启动时重复调用 = 强制重连（先关后连；连接中会把进行中的指令留在旧连接上作废，
		// 这是「强制重连」的固有代价，调用方已在对话框文案中说明）
		// 0.10.66：先发 bye 让代理侧真正释放旧连接（官方 close() 不生效）
		// 0.10.67：先 resume 清除「断开指令代理」的暂停标记，再 bye+重连换到新连接（新连接不带暂停）
		// 0.10.69：resume 携带恢复口令——代理校验通过才真正清除暂停
		try {
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'resume', nonce: getResumeNonce() }))
		}
		catch {
			// 忽略
		}
		try {
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'bye' }))
		}
		catch {
			// 忽略
		}
		try {
			eda.sys_WebSocket.close(WS_ID)
		}
		catch {
			// 忽略关闭异常
		}
		connected = false
		connect(port)
		return
	}
	started = true

	const tryConnect = (): void => {
		if (!connected && !manualStop) {
			// 0.10.71（KIMI-EDA-20261006-02）：有指令在途时推迟重连——
			// 此时重连作废在途结果（Luna 会话"只读查询超时"的根因之一）；
			// 指令自带 300s 超时兜底，结束后下一轮重连自然接上。
			if (inflightCommands > 0) {
				setTimeout(tryConnect, RECONNECT_MS)
				return
			}
			// 0.10.66：残留半开连接也先发 bye 请代理侧清理（官方 close() 不生效）
			try {
				eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'bye' }))
			}
			catch {
				// 忽略
			}
			try {
				eda.sys_WebSocket.close(WS_ID)
			}
			catch {
				// 忽略关闭异常
			}
			connect(port)
			// 0.10.71：重连循环里带上代理自动拉起重试（5 分钟节流），
			// 代理空闲退出/崩溃后插件能自己拉回。
			void probeAndAutoLaunch(port)
		}
		setTimeout(tryConnect, RECONNECT_MS)
	}

	// 心跳：让代理知道 EDA 还活着（代理端据此实现空闲自动退出）
	try {
		eda.sys_Timer.setIntervalTimer('aiCommandHeartbeat', HEARTBEAT_MS, () => {
			if (connected) {
				// 半开连接检测：超过 SILENCE_DEAD_MS 没收到代理任何消息（含 pong），判定死亡
				if (lastHeardAt > 0 && Date.now() - lastHeardAt > SILENCE_DEAD_MS) {
					// 0.10.71：指令在途时推迟判死——重连会作废在途结果；
					// 指令自带 300s 超时兜底，结束后下一轮心跳再判。
					if (inflightCommands > 0) return
					log('AI Command Engine 心跳超时，判定连接已死，准备重连')
					connected = false
					return
				}
				try {
					eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'ping' }))
				}
				catch {
					// 发送失败说明连接已断：复位标志，交给重连逻辑。
					// 0.10.71：指令在途时不复位——复位会触发重连作废在途结果，
					// 留给静默判死分支（带在途保护）统一处理。
					if (inflightCommands === 0) connected = false
				}
			}
		})
	}
	catch {
		// 定时器不可用时退化为仅依赖连接状态
	}

	// 首次立即连接；若代理未运行则尝试自动拉起
	void probeAndAutoLaunch(port)
	connect(port)
	setTimeout(tryConnect, RECONNECT_MS)
}

/**
 * 菜单「断开指令代理」：暂停连接并停止自动重连尝试。
 * 0.10.64（KIMI-EDA-20261005-01）：供 AI Command 菜单开关使用；
 * 重连循环仍在跑但跳过连接，直到再次调用 startBridgeClient()（菜单「连接指令代理」）。
 * 0.10.67（KIMI-EDA-20261006-01）：官方 sys_WebSocket.close() 实测不生效，且封装对
 * 服务端掐断内置自动重连（插件侧压不住物理连接）——「断开」改为**暂停语义**：
 * 给代理发 pause 帧，代理拒收发往本实例的一切指令并明确提示，连接本身保持。
 */
export function stopBridgeClient(): void {
	manualStop = true
	connected = false
	try {
		// 0.10.69：暂停时轮换恢复口令——此前所有重放/缓存帧里的旧口令即刻作废
	eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'pause', nonce: getResumeNonce(true) }))
	}
	catch {
		// 连接可能已不在，忽略
	}
	log('AI Command Engine 已暂停指令代理（菜单「连接指令代理」可恢复）')
}

// 0.10.52（KIMI-EDA-20261003-09）：诊断日志通道——指令内经 diag() 发出的事件经 WebSocket
// 送代理写入 lane-log-*.jsonl（删除/终扫/探针各阶段起止、底层调用、探针候选 ID），
// 同时镜像到 EDA 系统日志。发送失败静默忽略，绝不影响主流程。
setDiagSink((event) => {
	try {
		if (connected)
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({ type: 'log', ts: Date.now(), ...event }))
	}
	catch {
		// 忽略发送失败
	}
	try {
		eda.sys_Log.add(`[diag] ${event.cmd ?? ''} ${event.stage}${event.detail ? ` | ${event.detail}` : ''}`)
	}
	catch {
		// 日志失败不影响主流程
	}
})
