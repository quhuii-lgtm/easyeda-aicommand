import { setDiagSink } from '../engine/diag';
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
 * （需先运行 bridge/install-url-scheme.ps1 注册当前仓库的启动器）。
 */
import { executeCommand, getCommandDocs, listCommandNames } from '../engine/registry';

const WS_ID_PREFIX = 'ai-command-engine';
const DEFAULT_PORT = 49720;
const RECONNECT_MS = 5000;
const HEARTBEAT_MS = 10000;
/**
 * 单条指令最长执行时间：EDA API 偶尔永不 resolve（如无工程窗口/模态框阻塞），
 *  超时强制返回错误，避免消息处理函数挂死导致整个扩展失联
 */
// 0.10.37（KIMI-EDA-20261002-01）：全链路超时统一 300s——必须 ≤ 代理侧（command-proxy.mjs 已 300s），
// 否则外层等着、内层先掐造成"假超时、后台继续跑"。超时≠取消：EDA API 无取消机制。
const COMMAND_TIMEOUT_MS = 300000;
const COMMAND_TIMEOUT_OVERRIDES: Record<string, number> = {
	'schematic.pruneFloatingLabels': 300000,
	'schematic.delete': 300000,
	'pcb.delete': 300000,
	'pcb.groupBySchematicRegions': 300000,
	'pcb.sourceRollback': 300000,
};
/** 本扩展实例 ID：同一台机器可能开着多个 EDA 窗口，每个窗口一个实例，供代理区分与选路 */
const INSTANCE_ID = Math.random().toString(16).slice(2, 10);

let started = false;
let connected = false;
/** 菜单「断开指令代理」置位：暂停自动重连，直到再次 startBridgeClient() */
let manualStop = false;
let currentPort = DEFAULT_PORT;
let lifecycleGeneration = 0;
let lifecycleSequence = 0;
let lifecycleStatus = '未连接';
let proxyCompatible = false;
let connecting = false;
let checkingHealth = false;
let pendingResume: string | null = null;
let stopRequest: { id: string; reconnect: boolean } | null = null;
/**
 * 0.10.69（KIMI-EDA-20261006-01）：恢复口令。模块级随机数，随 hello/pause/resume 帧携带。
 *  代理只在口令匹配时才允许清除「断开指令代理」的暂停态——防止旧版本残留模块的重放 hello
 *  或其他客户端越权恢复（实测：EDA WebSocket 封装会重放历史 hello 帧，把暂停冲掉；
 *  system.eval 已被官方沙箱禁用，外部无法读本变量）。每次「断开」会轮换口令。
 */
let resumeNonce: string | null = null;
function getResumeNonce(rotate = false): string {
	if (rotate || !resumeNonce)
		resumeNonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	return resumeNonce;
}
/** 最近一次收到代理任何消息（pong/指令/describe）的时间戳；心跳据此判定半开连接 */
let lastHeardAt = 0;
/** 超过静默时长后发一次应用层探测；探测后仍静默才退役连接 */
const SILENCE_DEAD_MS = 35000;
let probeSentAt = 0;
/**
 * 0.10.71：最近一次尝试自动拉起代理的时间戳；自动拉起从"一生一次"改为"每 5 分钟最多一次"。
 *  旧 autoLaunchTried 一生一次导致代理空闲退出/崩溃后数小时黑窗（2026-10-06 凌晨实发：
 *  05:56 代理退出，09:05 才复活）——重连循环里定期重试拉起，代理随 EDA 在、EDA 全关才退
 */
let lastLaunchAttemptAt = 0;
const LAUNCH_RETRY_MS = 5 * 60 * 1000;
/**
 * 0.10.71：在途指令计数。自动重连/判死前若仍有指令在跑，推迟——重连会作废在途结果，
 *  批量接线途中撞上 2 分钟重连churn会被整体作废（凌晨 Luna 会话"只读查询超时"实发）
 */
let inflightCommands = 0;
/**
 * 连接代际（0.10.65）：每次 connect() 递增。同一 WS_ID 强制重连/快速断连时，
 *  旧连接迟到的 close/error 事件与旧在途指令的 result 帧按代际校验丢弃，
 *  防止旧事件抹掉新连接的 connected 标志、旧结果发到新连接上
 */
let connectionGeneration = 0;
let currentConnectionId: string | null = null;
let pendingCloseId: string | null = null;

export function isBridgeConnected(): boolean {
	return connected;
}

export function getBridgeLifecycleStatus(): string {
	return lifecycleStatus;
}

function setLifecycleStatus(status: string): void {
	lifecycleStatus = status;
	log(`AI Command Engine：${status}`);
}

function nextLifecycleId(): string {
	return `${INSTANCE_ID}-${++lifecycleSequence}`;
}

function isCurrentConnection(id: string, gen: number): boolean {
	return id === currentConnectionId && gen === connectionGeneration;
}

function closeRetiredConnection(id: string): boolean {
	try {
		eda.sys_WebSocket.close(id, 1000, 'AI Command Engine connection replaced');
		pendingCloseId = null;
		return true;
	}
	catch (err) {
		manualStop = true;
		pendingCloseId = id;
		connected = false;
		connecting = false;
		stopRequest = null;
		setLifecycleStatus(`旧连接已退役，但关闭失败，本次替换已停止：${String(err)}`);
		return false;
	}
}

/** Retire callbacks before calling the host: close() is synchronous and may not close the socket. */
function retireConnection(id: string, gen: number, closeHost = true): boolean {
	if (!isCurrentConnection(id, gen))
		return true;
	connectionGeneration++;
	currentConnectionId = null;
	connected = false;
	connecting = false;
	probeSentAt = 0;
	if (!closeHost)
		return true;
	return closeRetiredConnection(id);
}

function log(message: string): void {
	try {
		eda.sys_Log.add(message);
	}
	catch {
		// 日志失败不影响主流程
	}
}

async function handleMessage(event: MessageEvent<any>, id: string, gen: number): Promise<void> {
	// 过期代际的事件全部丢弃：只属于当前连接的 close/error 才复位标志（0.10.65 修复）
	if (!isCurrentConnection(id, gen))
		return;
	// 连接关闭/出错事件：复位标志，让 5 秒重连循环接管
	const eventType = (event as any)?.type;
	if (eventType === 'close' || eventType === 'error') {
		retireConnection(id, gen, false);
		if (stopRequest)
			setLifecycleStatus('停止尚未确认：连接已中断，未清除写保护');
		else if (!manualStop)
			setLifecycleStatus('连接已中断，等待重新连接');
		return;
	}

	let msg: any;
	try {
		msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
	}
	catch {
		return;
	}

	// 收到当前代任何有效消息都说明连接活着，并结束本轮探测
	const hadProbe = probeSentAt > 0;
	lastHeardAt = Date.now();
	probeSentAt = 0;
	if (hadProbe && !manualStop && !pendingResume && !stopRequest)
		setLifecycleStatus('已连接');
	if (msg?.type === 'pong')
		return;
	if (msg?.type === 'ping') {
		try {
			eda.sys_WebSocket.send(id, JSON.stringify({ type: 'pong' }));
		}
		catch (err) {
			log('桥接心跳应答发送失败：' + String(err));
		}
		return;
	}

	if (msg?.type === 'resume-accepted' || msg?.type === 'resume-rejected') {
		if (!pendingResume || msg.requestId !== pendingResume || manualStop)
			return;
		pendingResume = null;
		if (msg.type === 'resume-accepted') {
			setLifecycleStatus('已连接');
		}
		else {
			manualStop = true;
			setLifecycleStatus('恢复被桥接拒绝，连接保持暂停');
		}
		return;
	}

	if (msg?.type === 'stop-accepted' || msg?.type === 'stop-ready' || msg?.type === 'stop-blocked') {
		if (!manualStop || !stopRequest || msg.requestId !== stopRequest.id)
			return;
		if (msg.type === 'stop-accepted') {
			setLifecycleStatus(stopRequest.reconnect ? '正在等待当前操作结束，然后重连本窗口' : '停止请求已接收，正在等待当前操作结束');
			return;
		}
		if (msg.type === 'stop-blocked') {
			setLifecycleStatus('停止尚未完成：写操作结果未知，连接和写保护继续保留');
			return;
		}
		if (inflightCommands > 0) {
			setLifecycleStatus('停止尚未完成：本窗口仍有操作未返回，连接继续保留');
			return;
		}
		const completed = stopRequest;
		try {
			eda.sys_WebSocket.send(id, JSON.stringify({ type: 'bye', requestId: completed.id }));
		}
		catch (err) {
			setLifecycleStatus(`停止确认后断开失败：${String(err)}`);
			return;
		}
		if (!retireConnection(id, gen))
			return;
		stopRequest = null;
		connected = false;
		connecting = false;
		setLifecycleStatus('本窗口桥接已停止');
		if (completed.reconnect) {
			manualStop = false;
			lifecycleGeneration++;
			setLifecycleStatus('当前操作已结束，正在重新连接本窗口');
			void connectWhenReady(true);
		}
		return;
	}

	if (msg?.type === 'describe') {
		// 代理询问本实例身份：回报当前工程名与打开的标签页，用于多窗口选路。
		// 注意：无工程窗口上这些 API 可能永不 resolve，必须各自限时，
		// 否则 describe 挂起会堵死后续所有指令的消息循环
		const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
			Promise.race([p, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms))]);

		let project: string | null = null;
		const tabs: Array<string> = [];
		try {
			const info: any = await withTimeout((eda.dmt_Project as any).getCurrentProjectInfo(), 5000);
			project = info?.friendlyName ?? info?.name ?? null;
		}
		catch {}
		try {
			const tree: any = await withTimeout((eda.dmt_EditorControl as any).getSplitScreenTree(), 5000);
			const walk = (node: any): void => {
				if (!node)
					return;
				if (Array.isArray(node.tabs)) {
					for (const t of node.tabs)
						tabs.push(String(t?.title ?? ''));
				}
				if (Array.isArray(node.children))
					node.children.forEach(walk);
			};
			walk(tree);
		}
		catch {}
		// 复审补强（0.10.65）：info 帧发送前补代际校验——describe 处理期间若发生强制重连，
		// 迟到的旧快照会发到新连接上，与 result/progress 帧口径对齐
		if (!isCurrentConnection(id, gen))
			return;
		try {
			eda.sys_WebSocket.send(id, JSON.stringify({ type: 'info', instanceId: INSTANCE_ID, project, tabs }));
		}
		catch {}
		return;
	}

	if (msg?.type !== 'command')
		return;

	// A command already sent before the stop reached the proxy may still arrive.
	// Reject it before entering the handler; previously accepted work keeps its result path.
	if (manualStop) {
		try {
			eda.sys_WebSocket.send(id, JSON.stringify({
				type: 'result', id: msg.id,
				result: { ok: false, cmd: msg.cmd, error: { message: '本窗口已停止接收指令，此指令未执行' } },
			}));
		}
		catch (err) {
			log(`停止期间拒绝指令的结果未能发送：${String(err)}`);
		}
		return;
	}

	// 代理端伪指令：指令清单与文档查询
	let result: unknown;
	if (msg.cmd === '__listCommands') {
		result = { ok: true, cmd: msg.cmd, data: listCommandNames() };
	}
	else if (msg.cmd === '__help') {
		const docs = getCommandDocs();
		const cmd = msg.params?.cmd;
		result = { ok: true, cmd: msg.cmd, data: cmd ? docs.filter(doc => doc.name === cmd) : docs };
	}
	else {
		// 超时兜底：任何一条指令挂起都必须能返回错误，绝不能拖死消息循环。
		// 0.10.49：心跳感知超时——长指令（批量删除/batchWire/macro）执行中会通过 ctx.onProgress
		// 持续上报进度，每次心跳重置计时窗口；超时语义从「绝对时长」变为「无心跳时长」，
		// 批量指令不会因总时长被误杀。单条指令不上报心跳，语义与旧版一致（绝对时长）。
		const timeoutMs = COMMAND_TIMEOUT_OVERRIDES[msg.cmd] ?? COMMAND_TIMEOUT_MS;
		let lastBeatAt = Date.now();
		// 0.10.65：watchdog 引用提到外层，指令正常完成时由 finally 立即清理——
		// 旧版只在超时分支 clearInterval，正常路径的 interval 会空转到超时点才自清理（每条指令泄漏一个定时器）
		let watchdog: ReturnType<typeof setInterval> | undefined;
		try {
			// 0.10.71：在途计数——重连/判死逻辑据此推迟，避免作废在途结果
			inflightCommands++;
			result = await Promise.race([
				executeCommand({ cmd: msg.cmd, params: msg.params }, {
					vars: {},
					onProgress: (patch) => {
						lastBeatAt = Date.now();
						// 0.10.65：连接已被重连取代时不再往新连接发旧指令的心跳
						if (!isCurrentConnection(id, gen))
							return;
						try {
							// 进度载荷截断到 2000 字符——心跳通道是辅助设施，不搬大件数据。
							// 0.10.65 修复：旧版截断后再 JSON.parse 必抛（截断串不是合法 JSON），
							// 大载荷心跳被静默吞掉（恰是最需要心跳的长指令贴近误杀）——改为对象级降级
							let payload: any = patch ?? {};
							if (JSON.stringify(payload).length > 2000)
								payload = { truncated: true, keys: Object.keys(patch ?? {}) };
							eda.sys_WebSocket.send(id, JSON.stringify({ type: 'progress', id: msg.id, progress: payload }));
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
								clearInterval(watchdog);
							reject(new Error(`指令 ${msg.cmd} 执行超时（${Math.round(timeoutMs / 1000)}s 无进度心跳，底层操作可能仍在执行）。`, { cause: { partial: true, source: 'client-watchdog' } }));
						}
					}, 3000);
				}),
			]);
		}
		catch (err) {
			result = { ok: false, cmd: msg.cmd, error: { message: String((err as Error)?.message ?? err), cause: (err as Error)?.cause } };
		}
		finally {
			inflightCommands--;
			if (watchdog)
				clearInterval(watchdog);
		}
	}
	// 0.10.65 修复：result 发送是唯一无 try/catch 的 send（旧版断线瞬间必抛未处理 rejection）；
	// 且连接已被重连取代时代际不符，丢弃本结果帧（旧 id 落到新连接会困扰代理；该指令由代理 300s 超时兜底）
	try {
		if (isCurrentConnection(id, gen))
			eda.sys_WebSocket.send(id, JSON.stringify({ type: 'result', id: msg.id, result }));
		else
			log(`指令 ${msg.cmd} 的结果帧已随旧连接作废（连接已被重连/断开取代），丢弃`);
	}
	catch (err) {
		log(`结果帧发送失败（连接可能刚断开）: ${String(err)}`);
	}
}

function connect(port: number): void {
	if (connecting)
		return;
	if (pendingCloseId && !closeRetiredConnection(pendingCloseId))
		return;
	if (currentConnectionId && !retireConnection(currentConnectionId, connectionGeneration))
		return;
	try {
		connecting = true;
		const gen = ++connectionGeneration;
		const id = `${WS_ID_PREFIX}:${INSTANCE_ID}:${gen}`;
		currentConnectionId = id;
		eda.sys_WebSocket.register(
			id,
			`ws://127.0.0.1:${port}/ws`,
			event => void handleMessage(event, id, gen),
			() => {
				// 0.10.65：onOpen 也可能是旧连接的迟到回调，代际不符直接丢弃
				if (!isCurrentConnection(id, gen))
					return;
				connecting = false;
				connected = !manualStop;
				lastHeardAt = Date.now();
				eda.sys_WebSocket.send(id, JSON.stringify({
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
				}));
				if (!manualStop)
					setLifecycleStatus('已连接');
			},
		);
	}
	catch (err) {
		connected = false;
		connecting = false;
		setLifecycleStatus(`连接指令代理失败: ${String(err)}`);
	}
}

/** Health and URL launch share the lifecycle generation so a late probe cannot undo Stop. */
async function probeAndAutoLaunch(port: number, force: boolean): Promise<boolean> {
	const generation = lifecycleGeneration;
	let response: Response | undefined;
	try {
		response = await eda.sys_ClientUrl.request('http://127.0.0.1:' + port + '/health', 'GET');
	}
	catch {
		// The launcher performs its own local-port check before starting a process.
	}
	if (manualStop || generation !== lifecycleGeneration)
		return false;
	if (response) {
		try {
			const health = await response.json();
			if (manualStop || generation !== lifecycleGeneration)
				return false;
			proxyCompatible = response.status === 200 && health?.service === 'ai-command-proxy' && health?.lifecycleProtocol === 1;
			if (!proxyCompatible)
				setLifecycleStatus('桥接版本不匹配：请在当前任务结束后更新配套桥接，现有服务未被关闭');
			return proxyCompatible;
		}
		catch {
			proxyCompatible = false;
			setLifecycleStatus('桥接健康响应无法识别，现有服务未被关闭');
			return false;
		}
	}
	proxyCompatible = false;
	if (!force && Date.now() - lastLaunchAttemptAt < LAUNCH_RETRY_MS)
		return false;
	lastLaunchAttemptAt = Date.now();
	try {
		eda.sys_Window.open('ai-command-proxy://start', '_blank' as any);
		setLifecycleStatus('已请求启动桥接；若尚未注册，请运行 bridge/install-url-scheme.ps1');
	}
	catch (err) {
		setLifecycleStatus('自动启动失败：' + String(err) + '；可运行 bridge/launch-proxy.bat');
	}
	return false;
}

async function connectWhenReady(force: boolean): Promise<void> {
	if (manualStop || connected || checkingHealth || inflightCommands > 0)
		return;
	checkingHealth = true;
	const generation = lifecycleGeneration;
	try {
		const ready = await probeAndAutoLaunch(currentPort, force);
		if (ready && generation === lifecycleGeneration && !manualStop && !connected && inflightCommands === 0) {
			if (connecting)
				return;
			connect(currentPort);
		}
	}
	finally {
		checkingHealth = false;
	}
}

/** Start is idempotent; resuming a draining connection does not discard its results. */
export function startBridgeClient(port: number = DEFAULT_PORT): void {
	currentPort = port;
	if (connected && !manualStop && !stopRequest)
		return;
	if (checkingHealth || connecting)
		return;
	if (pendingCloseId && !closeRetiredConnection(pendingCloseId))
		return;
	lifecycleGeneration++;
	const wasStopped = manualStop;
	manualStop = false;
	stopRequest = null;
	if (connected) {
		if (wasStopped) {
			const id = currentConnectionId;
			if (!id)
				return;
			pendingResume = nextLifecycleId();
			try {
				eda.sys_WebSocket.send(id, JSON.stringify({ type: 'resume', nonce: getResumeNonce(), requestId: pendingResume }));
				setLifecycleStatus('已请求恢复本窗口，等待桥接确认');
			}
			catch (err) {
				manualStop = true;
				pendingResume = null;
				setLifecycleStatus('恢复请求发送失败：' + String(err));
			}
		}
		return;
	}
	if (!started) {
		started = true;
		const tryConnect = (): void => {
			if (!manualStop && !connected)
				void connectWhenReady(false);
			setTimeout(tryConnect, RECONNECT_MS);
		};
		try {
			eda.sys_Timer.setIntervalTimer('aiCommandHeartbeat', HEARTBEAT_MS, () => {
				if (!connected)
					return;
				const id = currentConnectionId;
				if (!id)
					return;
				const now = Date.now();
				if (probeSentAt > 0) {
					if (!manualStop && inflightCommands === 0 && now - probeSentAt > SILENCE_DEAD_MS) {
						if (retireConnection(id, connectionGeneration))
							setLifecycleStatus('桥接探测超时，等待重新连接');
					}
					return;
				}
				if (!manualStop && lastHeardAt > 0 && now - lastHeardAt > SILENCE_DEAD_MS) {
					probeSentAt = now;
					setLifecycleStatus('桥接静默，正在探测连接');
					try {
						eda.sys_WebSocket.send(id, JSON.stringify({ type: 'ping' }));
					}
					catch (err) {
						log('桥接探测发送失败：' + String(err));
					}
					return;
				}
				const heardBeforePing = lastHeardAt;
				try {
					eda.sys_WebSocket.send(id, JSON.stringify({ type: 'ping' }));
				}
				catch (err) {
					if (probeSentAt === 0 && lastHeardAt === heardBeforePing) {
						probeSentAt = now;
						if (!manualStop)
							setLifecycleStatus('桥接心跳发送失败，正在等待探测结果');
					}
					log('桥接心跳发送失败：' + String(err));
				}
			});
		}
		catch (err) {
			log('无法注册桥接心跳：' + String(err));
		}
		setTimeout(tryConnect, RECONNECT_MS);
	}
	setLifecycleStatus('正在检查并启动桥接');
	void connectWhenReady(true);
}

function requestBridgeStop(reconnect: boolean): void {
	if (stopRequest) {
		// Stop during a pending reconnect changes only the final intent.
		stopRequest.reconnect = reconnect;
		return;
	}
	lifecycleGeneration++;
	pendingResume = null;
	manualStop = true;
	if (!connected) {
		setLifecycleStatus(inflightCommands > 0 ? '停止尚未确认：连接中断且仍有操作未返回' : '本窗口桥接已停止');
		return;
	}
	if (!proxyCompatible) {
		setLifecycleStatus('本窗口已拒绝新指令，但桥接不支持安全停止；保留连接等待当前操作');
		return;
	}
	const id = currentConnectionId;
	if (!id) {
		setLifecycleStatus('停止请求失败：当前连接标识不存在，写保护继续保留');
		return;
	}
	const previousNonce = resumeNonce;
	const request = { id: nextLifecycleId(), reconnect };
	stopRequest = request;
	try {
		eda.sys_WebSocket.send(id, JSON.stringify({ type: 'stop', requestId: request.id, nonce: getResumeNonce(true) }));
		setLifecycleStatus(reconnect ? '已请求等待当前操作结束后重连' : '已请求停止，正在等待当前操作结束');
	}
	catch (err) {
		resumeNonce = previousNonce;
		stopRequest = null;
		setLifecycleStatus('停止请求发送失败，连接保留：' + String(err));
	}
}

export function stopBridgeClient(): void {
	requestBridgeStop(false);
}

/** Reconnect uses the same drain handshake as Stop and never clears write protection. */
export function reconnectBridgeClient(): void {
	if (!connected && !stopRequest) {
		startBridgeClient(currentPort);
		return;
	}
	requestBridgeStop(true);
}

// 0.10.52（KIMI-EDA-20261003-09）：诊断日志通道——指令内经 diag() 发出的事件经 WebSocket
// 送代理写入 lane-log-*.jsonl（删除/终扫/探针各阶段起止、底层调用、探针候选 ID），
// 同时镜像到 EDA 系统日志。发送失败静默忽略，绝不影响主流程。
setDiagSink((event) => {
	try {
		const id = currentConnectionId;
		if (connected && id)
			eda.sys_WebSocket.send(id, JSON.stringify({ type: 'log', ts: Date.now(), ...event }));
	}
	catch {
		// 忽略发送失败
	}
	try {
		eda.sys_Log.add(`[diag] ${event.cmd ?? ''} ${event.stage}${event.detail ? ` | ${event.detail}` : ''}`);
	}
	catch {
		// 日志失败不影响主流程
	}
});
