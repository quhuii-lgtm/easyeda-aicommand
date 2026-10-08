/**
 * AI Command Engine — Command Proxy（指令代理）
 *
 * 独立服务：HTTP + WebSocket 同端口（默认 49720）。
 * - EDA 扩展（AI Command Engine）主动连接 ws://127.0.0.1:49720/ws
 * - AI 通过 HTTP 发送简易 JSON 指令
 * - smt.* 指令由代理本地处理（嘉立创开放平台签名调用），无需 EDA 在线
 *
 * 生命周期：
 * - 扩展断开连接 60 秒后自动退出（EDA 关闭 → 代理自动关闭）
 * - 从未有扩展连接时保持运行（等待 EDA 启动）
 *
 * 用法：
 *   node bridge/command-proxy.mjs            # 默认监听 49720
 *   PORT=49721 node bridge/command-proxy.mjs
 *
 * 端点：
 *   GET  /health             服务与扩展连接状态（含全部在线实例）
 *   GET  /commands           列出全部指令（扩展指令 + 代理本地指令）
 *   GET  /help?cmd=xxx       查询指令文档
 *   POST /command            执行指令，body: { "cmd": "...", "params": {...}, "instanceId": "可选" }
 *                            带 instanceId 时按请求级路由直发该窗口（多 AI 客户端并行各带各的，
 *                            互不抢全局 /select）；不带则走全局选中实例（向后兼容）
 *
 * 超时语义（0.10.49）：长指令（schematic.delete / pcb.delete / schematic.batchWire / macro）
 * 执行中扩展会持续推送 { type:'progress', id } 进度心跳，代理每收到一次就重置该指令的
 * 超时计时器——超时判定从「绝对时长」变为「无心跳时长」（默认各 300s）。
 * 批量指令只要还在推进就永远不会超时；单条指令不上报心跳，语义与旧版一致。
 * 客户端 HTTP 超时后：任务仍在后台执行，重发同参数指令只回进度不重复执行（0.10.42+），
 * 或凭返回的 taskId 用 task.get 查询/补取结果。
 *
 * 写指令单行道（0.10.50）：除只读指令（schematic./pcb. 的 list/get/export/runDrc、
 * project. 的 get/list/export、editor.、library.、task.、knowledge.）外，全部写指令
 * 按目标窗口 FIFO 排队、一次放行一个——官方导线 create 并发容量≈2，并发创建批量失败。
 * 并发调用由此自动串行化，不会失败，代价是吞吐 ~3s/条；读指令不受影响。
 *   GET  /connections        列出全部已连接的 EDA 窗口实例（多窗口场景）
 *   POST /select             切换指令目标实例 { "instanceId": "..." }
 *   GET  /smt                SMT 物料手动查询页面（含密钥配置）
 *   GET  /smt/config         密钥配置状态（脱敏）
 *   POST /smt/config         保存密钥 { appId, accessKey, secretKey }
 *   POST /smt/query          SMT 物料查询 { queryString, pageNum?, pageSize? }
 */
import http from 'node:http'
import crypto, { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT) || 49720
// 0.10.37（KIMI-EDA-20261002-01 用户要求）：全链路指令超时统一 300s——客户端 live-common.ps1 已 300s，
// 代理层必须 ≥ 扩展侧 client.ts 的对应超时，否则外层加长内层先掐。超时只是兜底，不代表任务已取消：
// EDA 官方 API 无取消机制，代理超时后扩展可能仍在后台执行，重发前必须先确认现场状态。
const COMMAND_TIMEOUT_MS = Number(process.env.PROXY_CMD_TIMEOUT_MS) > 0 ? Number(process.env.PROXY_CMD_TIMEOUT_MS) : 300000
const COMMAND_TIMEOUT_OVERRIDES = {
	'schematic.pruneFloatingLabels': 300000,
	'schematic.delete': 300000,
	'pcb.delete': 300000,
	'pcb.groupBySchematicRegions': 300000,
	'pcb.sourceRollback': 300000,
}
// 空闲自动退出：60s → 300s（用户要求，长操作间隙不再掉代理）。
// 语义：仅当「曾有扩展连上过，且当前 0 个连接」时计时——EDA 窗口开着就不会触发（扩展每 10s 心跳保活）。
// 可用环境变量 PROXY_IDLE_MS 覆盖（单位毫秒），设 0 表示永不自动退出。
const IDLE_SHUTDOWN_MS = Number(process.env.PROXY_IDLE_MS) >= 0 && process.env.PROXY_IDLE_MS !== undefined
	? Number(process.env.PROXY_IDLE_MS)
	: 300000
const WS_PING_INTERVAL_MS = 20000

const PROXY_DIR = path.dirname(fileURLToPath(import.meta.url))
const CREDENTIALS_FILE = path.join(PROXY_DIR, 'jlc-credentials.json')
const JLC_ENDPOINT = 'https://open-api.jlc.com'
const SMT_QUERY_PATH = '/smtOpenApi/order/selectComponentInfo'
const SMT_DETAIL_PATH = '/smtOpenApi/smtComponent/selectComponentInfoByCodes'

/** 所有已连接的扩展实例：ws -> { instanceId, extension, version, connectedAt, info } */
const connections = new Map()
/** 当前选中的指令目标 instanceId（多 EDA 窗口时通过 /connections 查看、/select 切换）。
 *  选定后粘滞：目标断开不再自动改选其他窗口，防止指令落到错误的工程 */
let selectedInstanceId = null
let extensionSocket = null
let extensionInfo = null
/** 0.10.66（KIMI-EDA-20261006-01）：被 EDA 菜单「断开指令代理」暂停的实例集合。
 *  官方 sys_WebSocket 封装对服务端掐断会内置自动重连（插件侧压不住物理连接），
 *  故「断开」改为暂停语义：连接保持，但发往该实例的指令一律拒绝并明确提示。 */
const pausedIds = new Set()
/** 0.10.69（KIMI-EDA-20261006-01）：每个实例的恢复口令（扩展模块级随机数，每次「断开」轮换）。
 *  代理只在帧口令与存值匹配时才允许清除暂停——防止旧版本残留模块的重放 hello
 *  或其他会话越权恢复用户从菜单点的「断开」（实测 EDA 封装会重放历史 hello 帧）。 */
const instanceNonces = new Map()

/** 按 selectedInstanceId 找到当前可用的连接（目标重连后自动恢复） */
function selectedConnection() {
	if (!selectedInstanceId)
		return null
	for (const [ws, c] of connections.entries()) {
		if (c.instanceId === selectedInstanceId && ws.readyState === 1)
			return { ws, info: c }
	}
	return null
}

/** 版本号比较（semver 粗略比较，返回正数表示 a 更新） */
function compareVersion(a, b) {
	const pa = String(a ?? '0').split('.').map(Number)
	const pb = String(b ?? '0').split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		if ((pa[i] || 0) !== (pb[i] || 0))
			return (pa[i] || 0) - (pb[i] || 0)
	}
	return 0
}

/**
 * 单工程场景自动选窗：仅在从未显式选过目标时触发。
 * 所有在线实例同属一个工程（或只有一个实例）时，自动选版本最新、连接最新的实例；
 * 多工程共存时不自动选（防串台），仍要求显式 /select。
 */
function autoSelectIfSingleProject() {
	if (selectedInstanceId)
		return
	const ready = [...connections.entries()].filter(([ws]) => ws.readyState === 1)
	if (!ready.length)
		return
	const projects = new Set(ready.map(([, c]) => c.info?.project ?? null))
	if (ready.length > 1 && projects.size > 1)
		return
	ready.sort(([, a], [, b]) =>
		compareVersion(b.version, a.version) || b.connectedAt - a.connectedAt)
	const [ws, c] = ready[0]
	selectedInstanceId = c.instanceId
	extensionSocket = ws
	extensionInfo = { extension: c.extension, version: c.version, instanceId: c.instanceId, ...(c.info ?? {}) }
	console.log(`[ai-command-proxy] 单工程自动选窗: 实例 ${c.instanceId} v${c.version} 工程 ${c.info?.project ?? '未知'}`)
}
const pending = new Map()
/** graceful stop requests keyed by instanceId; only the owning socket may receive completion */
const stoppingInstances = new Map()

/** 空闲自杀状态 */
let everConnected = false
let disconnectedAt = 0

// ---------- 工具 ----------

function corsHeaders(extra = {}) {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Accept',
		...extra,
	}
}

function json(res, status, data) {
	res.writeHead(status, corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }))
	res.end(JSON.stringify(data))
}

function readBody(req) {
	return new Promise((resolve) => {
		let raw = ''
		req.on('data', chunk => (raw += chunk))
		req.on('end', () => resolve(raw))
	})
}

function noExtension(res) {
	json(res, 503, {
		ok: false,
		error: '扩展未连接。请确认：1) 嘉立创EDA专业版已打开工程 2) AI Command Engine 扩展已启用 3) 已勾选「允许外部交互」权限 4) 已重启过 EDA',
	})
}

/** 按 instanceId 找可用连接（指令级路由用；找不到或不在线返回 null） */
function connectionFor(instanceId) {
	for (const [ws, c] of connections.entries()) {
		if (c.instanceId === instanceId)
			return ws.readyState === 1 ? { ws, ...c } : null
	}
	return null
}

/** 向扩展转发一条指令并等待结果。
 *  instanceId 为空时严格发往 selectedInstanceId（绝不改投其他窗口）；
 *  指定 instanceId 时按请求级路由发往该实例（多 AI 客户端并行各带各的窗口，互不抢全局选择） */
function forwardToExtension(message, instanceId, isWrite = false) {
	return new Promise((resolve, reject) => {
		const target = instanceId ? connectionFor(instanceId) : selectedConnection()
		if (!target) {
			reject(new Error(instanceId
				? (connectionFor(instanceId) === null && [...connections.values()].some(c => c.instanceId === instanceId) ? 'TARGET_OFFLINE' : 'UNKNOWN_INSTANCE')
				: (selectedInstanceId ? 'TARGET_OFFLINE' : 'NO_EXTENSION')))
			return
		}
		// 0.10.66：用户从 EDA 菜单「断开指令代理」暂停的实例，指令一律拒绝（读指令同样拒——
		// 暂停语义就是"这个窗口现在不接待 AI"，避免半暂停状态误导）
		const tid = target.instanceId ?? target.info?.instanceId
		if (tid && pausedIds.has(tid)) {
			reject(new Error(`TARGET_PAUSED:${tid}`))
			return
		}
		const id = randomUUID()
		const timeoutMs = COMMAND_TIMEOUT_OVERRIDES[message.cmd] ?? COMMAND_TIMEOUT_MS
		const targetId = target.instanceId ?? target.info?.instanceId
		const entry = { resolve, timer: null, lastProgress: undefined, timeoutMs, write: isWrite, cmd: message.cmd, id, instanceId: targetId, owner: target.ws }
		entry.timer = setTimeout(() => {
			pending.delete(id)
			// 0.10.72：写指令超时 = 结果不确定，标记写保护（拒绝后续写直到自愈/确认）
			// 0.10.73：保护按实例号键并记录本指令 id，迟到结果只认这个 id
			if (isWrite) markWriteUncertain(targetId, message.cmd, '指令超时', id, target.ws)
			tryCompleteStop(targetId)
			// 0.10.37：超时只是代理放弃等待，扩展侧可能仍在后台执行（EDA API 无取消机制）——如实告知边界
			// 0.10.49：附最后收到的进度心跳，客户端可据此判断任务实际推进到哪
			const prog = entry.lastProgress !== undefined ? `；最后进度：${JSON.stringify(entry.lastProgress).slice(0, 500)}` : ''
			reject(new Error(`指令执行超时（${Math.round(timeoutMs / 1000)}s 无进度心跳，代理已放弃等待）${prog}。注意：这≠任务已取消，扩展可能仍在后台执行；重发同参数只回进度不重复执行，或用 task.get 查询；重发前也请先用只读指令（如 listTabs/listComponents）确认现场状态`))
		}, timeoutMs)
		pending.set(id, entry)
		// 注意：id 必须放在展开之后——调用方若自带 id 字段会覆盖代理的关联 id，导致响应永远无法匹配（表现为 30s 超时）
		target.ws.send(JSON.stringify({ type: 'command', ...message, id }))
	})
}

// ---------- 0.10.50 写指令单行道（KIMI-EDA-20261002-07 R2 实测定案） ----------
// 官方导线 create 并发容量≈2：并发创建批量 "create failed!"，幸存者还可能半注册
// （文档源码可见但 listWires/命中测试查不到、常规删不掉）。代理侧把写指令按目标窗口
// 排成 FIFO，一次只放行一个——方式 3（并发单条）由此退化为逐条执行：不再失败，代价是
// 吞吐 ~3s/条。读指令（list/get/export/runDrc/editor 等）不受影响，照常并发。
// 0.10.72（KIMI-EDA-20261006-03 P1-2）：editor.* 不再整体判只读——openDocument/closeDocument
// 会改变目标文档上下文，曾绕过写单行道与在跑的批量写交错（GPT 源码审查定案）。只读白名单
// 收紧为真正的无副作用四条；其余 editor.*（openDocument/closeDocument 等）按写指令排队。
const READONLY_COMMAND_PATTERNS = [
	/^schematic\.(list|get|export|runDrc|checkRectOverlap)/,
	/^pcb\.(list|get|export|runDrc)/,
	/^project\.(get|list|export)/,
	/^editor\.(listTabs|screenshot|zoomToAll|zoomToRegion)$/,
	/^library\.(search|get)/,
	/^task\.(get|list)/,
	/^knowledge\./,
]
function isReadOnlyCommand(cmd) {
	return typeof cmd === 'string' && READONLY_COMMAND_PATTERNS.some(re => re.test(cmd))
}
/** 每个 EDA 窗口（ws）一条写队列；tail 永远 resolved，深度单独计数 */
const writeQueues = new Map()
const MAX_QUEUED_WRITES = 50

// ---------- 0.10.73 写结果不确定保护 v2（KIMI-EDA-20261006-04 P1-3 复核收口） ----------
// 背景：写指令超时/心跳丢失时代理放弃等待，但扩展侧可能仍在后台执行（EDA API 无取消）。
// 此时若放行下一条写指令，两条写会在扩展侧交错，产生半注册导线等不可预期现场。
// v2 定案（GPT 复核四点全部采纳）：
//  ① 保护按实例号（instanceId）键——ws 断开重连不清除，防同一宿主旧写与新写重叠；
//  ② 只认"导致保护的那条指令的 id"的迟到结果，任何其他无主 result 不解保护；
//  ③ 扩展熔断杀死的结果带 error.cause.partial 标记，partial 的迟到结果不算可信完成信号；
//  ④ 删除"冷却期满 + task.list 空 → 自动解除"——普通写不在任务表里，空表什么也证明不了。
// 解除只有两条路：id 匹配且非 partial 的迟到 result（=该指令真实跑完），或 write.acknowledge
// （调用方只读核对现场后的显式确认）。永不返回的任务不会被自动放行，读指令始终可用。
const writeUncertain = new Map() // key: instanceId；value: { since, cmd, reason, id }
function markWriteUncertain(instanceId, cmd, reason, id, owner = null) {
	if (!instanceId) return
	// 已标记则不覆盖首次触发记录（保留最早的"现场开始不确定"时点与原始指令 id）
	if (writeUncertain.has(instanceId)) return
	writeUncertain.set(instanceId, { since: Date.now(), cmd, reason, id, owner })
	laneLog({ event: 'write-uncertain-set', instanceId, cmd, reason, id })
}
function clearWriteUncertain(instanceId, why) {
	if (!writeUncertain.has(instanceId)) return
	writeUncertain.delete(instanceId)
	laneLog({ event: 'write-uncertain-cleared', instanceId, why })
	const stop = stoppingInstances.get(instanceId)
	if (stop?.blocked)
		stop.blocked = false
	tryCompleteStop(instanceId)
}
function queueDepthFor(instanceId) {
	let depth = 0
	for (const [ws, q] of writeQueues) {
		if (connections.get(ws)?.instanceId === instanceId)
			depth += q.depth
	}
	return depth
}
function pendingFor(instanceId) {
	for (const entry of pending.values()) {
		if (entry.instanceId === instanceId)
			return true
	}
	return false
}
function tryCompleteStop(instanceId) {
	const stop = stoppingInstances.get(instanceId)
	if (!stop || stop.readySent || pendingFor(instanceId) || queueDepthFor(instanceId) > 0)
		return
	if (writeUncertain.has(instanceId)) {
		if (stop.blocked)
			return
		stop.blocked = true
		try { stop.ws.send(JSON.stringify({ type: 'stop-blocked', requestId: stop.requestId, reason: 'writeUncertain' })) }
		catch {}
		return
	}
	stop.readySent = true
	try { stop.ws.send(JSON.stringify({ type: 'stop-ready', requestId: stop.requestId })) }
	catch {}
	refreshDisconnectedAt()
}
function lifecycleBusy() {
	return [...connections.values()].some(c => !pausedIds.has(c.instanceId))
		|| pending.size > 0
		|| [...writeQueues.values()].some(q => q.depth > 0)
		|| writeUncertain.size > 0
}
function refreshDisconnectedAt() {
	if (!everConnected || lifecycleBusy()) {
		disconnectedAt = 0
		return
	}
	if (!disconnectedAt)
		disconnectedAt = Date.now()
}
/** 写保护闸：返回非空字符串 = 拒绝原因（HTTP 200 + { ok:false } 由调用方组装）；null = 放行 */
async function assertWriteCertain(routeId) {
	const target = routeId ? connectionFor(routeId) : selectedConnection()
	if (!target) return null // 连接问题交给后续正常报错路径
	const iid = target.instanceId ?? target.info?.instanceId
	const rec = iid ? writeUncertain.get(iid) : undefined
	if (!rec) return null
	const minutes = Math.floor((Date.now() - rec.since) / 60000)
	return `写保护生效：写指令「${rec.cmd}」结果不确定（${rec.reason}，已保护 ${minutes} 分钟），代理已放弃等待且扩展可能仍在后台执行，期间拒绝一切写指令防交错污染现场。解除只有两条路：① 该指令真实完成的迟到结果到达（代理自动核验请求 id 后自愈）；② 你用只读指令核对现场（task.get 查该指令结果 + listComponents/listWires 看无半注册残留）后，发 write.acknowledge（带顶层 instanceId=${iid}）显式解除。读指令不受限`
}

// 0.10.51：单行道事件日志——按时间戳记录每条写指令的入队/放行/完成与队列深度，
// 用于给调用方提供「同一目标实例的请求起止/队列」证据（JSONL，每日一个文件）
const LANE_LOG_FILE = path.join(PROXY_DIR, `lane-log-${new Date().toISOString().slice(0, 10)}.jsonl`)
function laneLog(event) {
	try {
		fs.appendFileSync(LANE_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
	}
	catch (err) {
		// 日志失败不影响主流程；2026-10-06 诊断增强：把失败原因落到旁路文件，
		// 否则静默吞错导致「事件发生了但日志全无」无法取证（当日实发：hello/硬校验
		// 事件全部丢失且无任何痕迹）。
		try {
			fs.appendFileSync(path.join(PROXY_DIR, 'lane-log-error.txt'), `${new Date().toISOString()} ${JSON.stringify(event)} -> ${err?.code ?? ''} ${String(err?.message ?? err)}\n`)
		}
		catch {
			// 旁路也失败则彻底放弃
		}
	}
}

/**
 * 取写通道：返回 enqueue(fn)->Promise；队列已满返回 'QUEUE_FULL'；目标不在线返回 null（走原逻辑报错）
 */
function acquireWriteLane(routeId) {
	const target = routeId ? connectionFor(routeId) : selectedConnection()
	if (!target)
		return null
	let q = writeQueues.get(target.ws)
	if (!q) {
		q = { tail: Promise.resolve(), depth: 0 }
		writeQueues.set(target.ws, q)
	}
	if (q.depth >= MAX_QUEUED_WRITES)
		return 'QUEUE_FULL'
	q.depth++
	const enqueue = (fn) => {
		laneLog({ event: 'enqueue', cmd: fn.cmd, depth: q.depth })
		const run = q.tail.then(fn)
		q.tail = run.then(() => {
			q.depth--
			laneLog({ event: 'done', cmd: fn.cmd, depth: q.depth })
			tryCompleteStop(target.instanceId)
		}, () => {
			q.depth--
			laneLog({ event: 'done-failed', cmd: fn.cmd, depth: q.depth })
			tryCompleteStop(target.instanceId)
		})
		return run
	}
	return enqueue
}

// ---------- 嘉立创开放平台签名（JOP） ----------

function loadCredentials() {
	try {
		const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'))
		if (data?.appId && data?.accessKey && data?.secretKey)
			return data
	}
	catch {}
	return null
}

function saveCredentials(cred) {
	fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(cred, null, 2), 'utf8')
}

function maskSecret(value) {
	if (!value)
		return ''
	const s = String(value)
	return s.length <= 6 ? '******' : `${s.slice(0, 6)}******`
}

function makeNonce() {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
	const bytes = crypto.randomBytes(32)
	let nonce = ''
	for (let i = 0; i < 32; i++)
		nonce += chars[bytes[i] % chars.length]
	return nonce
}

/**
 * 按官方「请求签名」规范生成 Authorization 头
 * 签名串：HTTP方法\n URL路径(+查询)\n 时间戳(秒)\n 随机串(32位)\n 请求体\n
 * 签名值：Base64( HmacSHA256(secretKey, 签名串) )
 */
function jlcAuthorization(cred, method, pathWithQuery, body) {
	const timestamp = Math.floor(Date.now() / 1000).toString()
	const nonce = makeNonce()
	const stringToSign = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`
	const signature = crypto.createHmac('sha256', cred.secretKey).update(stringToSign, 'utf8').digest('base64')
	return `JOP appid="${cred.appId}",accesskey="${cred.accessKey}",nonce="${nonce}",timestamp="${timestamp}",signature="${signature}"`
}

/** 嘉立创开放平台 POST 通用调用（签名在内部完成） */
async function jlcPost(path, bodyObj) {
	const cred = loadCredentials()
	if (!cred)
		throw new Error('未配置嘉立创开放平台密钥。请打开 http://127.0.0.1:' + PORT + '/smt 填写 appId / accessKey / secretKey（只需配置一次，保存在代理工作目录，升级插件不丢失）。')
	// 注意：参与签名的 body 必须与真实发送的 body 逐字节一致
	const body = JSON.stringify(bodyObj)
	const authorization = jlcAuthorization(cred, 'POST', path, body)
	const resp = await fetch(JLC_ENDPOINT + path, {
		method: 'POST',
		headers: {
			'Authorization': authorization,
			'Content-Type': 'application/json',
			'Accept': 'application/json',
		},
		body,
	})
	const result = await resp.json().catch(() => null)
	if (!resp.ok || !result)
		throw new Error(`嘉立创开放平台请求失败 HTTP ${resp.status}`)
	if (result.code !== 200 || result.success === false)
		throw new Error(`嘉立创开放平台返回错误 code=${result.code}: ${result.message ?? '未知错误'}`)
	return result.data
}

/** 把详情接口的单条物料映射为统一结构 */
function mapComponentDetail(item) {
	const ladder = (item.smtComponentPriceInfoVOList ?? []).map(p => ({
		startNumber: p.startNumber,
		endNumber: p.endNumber,
		price: p.productPrice,
	}))
	return {
		code: item.componentCode,
		name: item.componentName,
		type: item.componentType,
		model: item.componentModel,
		footprint: item.componentSpecification,
		brand: item.componentBrand,
		encapsulationNumber: item.encapsulationNumber,
		stock: item.stockNum,
		description: item.paramTextAll,
		priceLadder: ladder,
		// 首档单价（最常用的参考价）
		price: ladder.length ? ladder[0].price : undefined,
	}
}

/** 按元件编号批量查询物料详情（名称/类别/品牌/库存/参数描述/阶梯价） */
async function smtQueryComponentDetails(params = {}) {
	let codes = params.componentCodeList ?? params.codes ?? params.code
	if (typeof codes === 'string')
		codes = codes.split(/[,，\s]+/).filter(Boolean)
	if (!Array.isArray(codes) || !codes.length)
		throw new Error('缺少参数 componentCodeList（元件编号列表，也接受 codes / code，支持逗号分隔字符串）')
	codes = codes.map(String)
	const data = await jlcPost(SMT_DETAIL_PATH, { componentCodeList: codes })
	const list = Array.isArray(data) ? data : (data?.list ?? [])
	return { count: list.length, components: list.map(mapComponentDetail) }
}

/** SMT 查询物料（元器件）信息；detail!=false 时自动用详情接口补全名称/库存/价格等字段 */
async function smtQueryComponents(params = {}) {
	const queryString = String(params.queryString ?? params.keyword ?? '').trim()
	if (!queryString)
		throw new Error('缺少参数 queryString（查询关键字，也接受别名 keyword）')
	const pageNum = Number(params.pageNum) || 1
	const pageSize = Math.min(Number(params.pageSize) || 20, 100)

	const page = await jlcPost(SMT_QUERY_PATH, { queryString, pageNum, pageSize }) ?? {}
	// 实际响应结构：{ list, total, pages, pageNum, pageSize }（PDF 文档中的 data/totalRows 与实际不符，做兼容）
	const list = page.list ?? page.data ?? []
	let components = list.map(item => ({
		code: item.componentCode,
		footprint: item.componentSpecification,
		model: item.componentModel,
	}))

	// 详情补全：搜索接口本身只返回 3 个字段，名称/库存/价格要调详情接口
	if (params.detail !== false && components.length) {
		try {
			const detail = await smtQueryComponentDetails({ componentCodeList: components.map(c => c.code) })
			const byCode = new Map(detail.components.map(c => [c.code, c]))
			components = components.map(c => byCode.get(c.code) ?? c)
		}
		catch (err) {
			// 详情接口失败不拖垮搜索，返回基础字段并附带提示
			return {
				totalRows: page.total ?? page.totalRows ?? 0,
				totalPages: page.pages ?? page.totalPages ?? 0,
				pageNum: page.pageNum ?? pageNum,
				pageSize: page.pageSize ?? pageSize,
				components,
				detailError: String(err?.message ?? err),
			}
		}
	}

	return {
		totalRows: page.total ?? page.totalRows ?? 0,
		totalPages: page.pages ?? page.totalPages ?? 0,
		pageNum: page.pageNum ?? pageNum,
		pageSize: page.pageSize ?? pageSize,
		components,
	}
}

/** 代理本地指令（无需扩展在线） */
const LOCAL_COMMAND_DOCS = [
	{
		name: 'smt.queryComponent',
		summary: '查询嘉立创 SMT 可贴装物料（元器件）信息；默认自动补全详情（名称/类别/品牌/库存/参数描述/阶梯价），传 detail:false 可只返回编号/封装/型号',
		params: {
			queryString: '查询关键字，如 "10k"、"STM32F103"（必填）',
			pageNum: '页码，默认 1',
			pageSize: '每页数量，默认 20，最大 100',
			detail: '是否补全详情，默认 true',
		},
		returns: '{ totalRows, totalPages, pageNum, pageSize, components: [{ code, name, type, model, footprint, brand, stock, description, price, priceLadder }] }',
		note: '首次使用需在 http://127.0.0.1:' + PORT + '/smt 配置开放平台密钥',
	},
	{
		name: 'smt.queryComponentDetail',
		summary: '按元件编号批量查询物料详情（名称/类别/品牌/库存/参数描述/阶梯售价）',
		params: {
			componentCodeList: '元件编号列表，如 ["C17414","C25744"]（也接受 codes / code，支持逗号分隔字符串）',
		},
		returns: '{ count, components: [{ code, name, type, model, footprint, brand, encapsulationNumber, stock, description, price, priceLadder }] }',
		note: '首次使用需在 http://127.0.0.1:' + PORT + '/smt 配置开放平台密钥',
	},
	{
		name: 'write.acknowledge',
		summary: '解除目标实例的写保护（0.10.72 写结果不确定保护）。仅在前一条写指令超时/心跳丢失、且你已用只读指令核对现场无半注册残留后使用——本指令不替你核对现场',
		params: {
			instanceId: '目标窗口实例 ID（必填，先 GET /connections 查）',
		},
		returns: '{ ok, acknowledged: true, instanceId, hadProtection: true/false }；无 instanceId 返回 ok:false',
		note: '保护按实例号键、断线重连不清除。自动解除只认一种：导致保护的那条指令的迟到结果（id 匹配且非 partial）。发本指令前必须已用只读指令核对现场',
	},
]

async function executeLocalCommand(command) {
	if (command.cmd === 'smt.queryComponent')
		return { ok: true, cmd: command.cmd, data: await smtQueryComponents(command.params) }
	if (command.cmd === 'smt.queryComponentDetail')
		return { ok: true, cmd: command.cmd, data: await smtQueryComponentDetails(command.params) }
	if (command.cmd === 'write.acknowledge') {
		// 0.10.72：显式解除写保护。必须带 instanceId（本指令作用对象就是某个窗口的写通道）
		if (!command.instanceId)
			return { ok: false, cmd: command.cmd, error: { message: 'write.acknowledge 必须带顶层 instanceId（先 GET /connections 查，勿缓存）' } }
		const target = connectionFor(command.instanceId)
		if (!target)
			return { ok: false, cmd: command.cmd, error: { message: `目标实例 ${command.instanceId} 不在线，无法定位写通道` } }
		// 0.10.73：保护按实例号键，按实例号直接清除（不要求特定连接）
		const had = writeUncertain.has(command.instanceId)
		clearWriteUncertain(command.instanceId, 'acknowledged')
		return { ok: true, cmd: command.cmd, acknowledged: true, instanceId: command.instanceId, hadProtection: had }
	}
	return null
}

// ---------- 破坏性指令自动备份 ----------

const BACKUP_DIR = path.join(PROXY_DIR, 'backups')
/** 源码写入指令的版本化备份目录：ai-command-engine/backups/<工程>/<时间戳>.txt */
const SOURCE_BACKUP_ROOT = path.join(PROXY_DIR, '..', 'backups')
const SOURCE_BACKUP_KEEP = 5
/** 破坏性指令清单：执行前自动导出 .epro 工程备份（官方没有撤销 API） */
const DESTRUCTIVE_COMMANDS = new Set([
	'schematic.delete',
	'pcb.delete',
	'schematic.dedupeWireNets',
	'project.deleteSchematicPage',
	'project.deletePcb',
	'project.deleteBoard',
])
const lastBackupAt = new Map()
const BACKUP_INTERVAL_MS = 60000 // 批量删除场景 60 秒内只备一次

async function autoBackupBeforeDestructive(cmdName, instanceId) {
	try {
		// .epro 是整份工程备份；用工程 UUID 隔离同实例切换工程及不同实例，不能用可重复的显示名。
		const identityBefore = await forwardToExtension({ cmd: 'project.getInfo' }, instanceId)
		const projectUuidBefore = identityBefore?.ok === true && typeof identityBefore?.data?.uuid === 'string' && identityBefore.data.uuid
			? identityBefore.data.uuid
			: null
		const backupKey = projectUuidBefore ? JSON.stringify([instanceId, projectUuidBefore]) : null
		if (backupKey && Date.now() - (lastBackupAt.get(backupKey) ?? 0) < BACKUP_INTERVAL_MS)
			return null

		const result = await forwardToExtension({ cmd: 'project.exportFile' }, instanceId)
		const b64 = result?.data?.base64
		if (!b64)
			return null
		fs.mkdirSync(BACKUP_DIR, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const file = path.join(BACKUP_DIR, `backup_${stamp}_${randomUUID()}_${cmdName.replace(/\W+/g, '_')}.epro`)
		fs.writeFileSync(file, Buffer.from(b64, 'base64'))
		// 工程可能在导出过程中切换；只有前后 UUID 相同，才把成功时间记给该身份。
		if (backupKey) {
			try {
				const identityAfter = await forwardToExtension({ cmd: 'project.getInfo' }, instanceId)
				if (identityAfter?.ok === true && identityAfter.data?.uuid === projectUuidBefore)
					lastBackupAt.set(backupKey, Date.now())
			}
			catch (err) {
				console.log(`[ai-command-proxy] 备份已保存但无法复核工程身份，不应用节流: ${err?.message ?? err}`)
			}
		}
		console.log(`[ai-command-proxy] 破坏性指令 ${cmdName} 前已自动备份: ${file}`)
		return file
	}
	catch (err) {
		// 备份失败不阻断指令（工程导出在部分状态下不可用），仅记录
		console.log(`[ai-command-proxy] 自动备份失败（不阻断 ${cmdName}）:`, err?.message ?? err)
		return null
	}
}

// ---------- 源码备份（版本化文件栈，供 pcb.groupBySchematicRegions / pcb.sourceRollback） ----------

function safeDirName(name) {
	const cleaned = String(name ?? 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
	return cleaned || 'unknown'
}

function readBackupMeta(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'))
	}
	catch {
		return null
	}
}

/** 列出全部源码备份（可按 pcbUuid 过滤），新的在前 */
function listSourceBackups(pcbUuid) {
	const result = []
	if (!fs.existsSync(SOURCE_BACKUP_ROOT))
		return result
	for (const projectDir of fs.readdirSync(SOURCE_BACKUP_ROOT)) {
		const dir = path.join(SOURCE_BACKUP_ROOT, projectDir)
		if (!fs.statSync(dir).isDirectory())
			continue
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith('.json'))
				continue
			const meta = readBackupMeta(path.join(dir, file))
			if (!meta?.backupId)
				continue
			if (pcbUuid && meta.pcbUuid !== pcbUuid)
				continue
			result.push(meta)
		}
	}
	result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
	return result
}

/** 存一份源码备份：backups/<工程>/<时间戳>.txt + 同名 .json 元数据；每工程保留最近 5 份 */
function storeSourceBackup({ project, pcbUuid, source, note }) {
	if (typeof source !== 'string' || !source)
		throw new Error('source 不能为空')
	const dir = path.join(SOURCE_BACKUP_ROOT, safeDirName(project))
	fs.mkdirSync(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const backupId = `${safeDirName(project)}/${stamp}`
	const file = path.join(dir, `${stamp}.txt`)
	fs.writeFileSync(file, source, 'utf8')
	const meta = { backupId, project: String(project ?? ''), pcbUuid: String(pcbUuid ?? ''), createdAt: new Date().toISOString(), size: source.length, note: String(note ?? '') }
	fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(meta, null, 2), 'utf8')
	// 修剪：该工程目录下只保留最近 5 份
	const pruned = []
	const stamps = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4)).sort().reverse()
	for (const old of stamps.slice(SOURCE_BACKUP_KEEP)) {
		for (const ext of ['.txt', '.json']) {
			try {
				fs.rmSync(path.join(dir, old + ext))
				pruned.push(`${safeDirName(project)}/${old}`)
			}
			catch {}
		}
	}
	console.log(`[ai-command-proxy] 源码备份已保存: ${file}（${source.length} 字符）`)
	return { backupId, file, pruned }
}

/** 读备份内容：按 backupId，或按 pcbUuid 取最近一份 */
function readSourceBackup({ backupId, pcbUuid }) {
	let meta = null
	if (backupId) {
		const found = listSourceBackups().find(item => item.backupId === backupId)
		if (!found)
			throw new Error(`备份 ${backupId} 不存在（用 pcb.sourceRollback {list:true} 查看现有备份）`)
		meta = found
	}
	else {
		const list = listSourceBackups(pcbUuid)
		if (!list.length)
			throw new Error(`没有 pcbUuid=${pcbUuid} 的源码备份`)
		meta = list[0]
	}
	const file = path.join(SOURCE_BACKUP_ROOT, ...meta.backupId.split('/')) + '.txt'
	if (!fs.existsSync(file))
		throw new Error(`备份文件丢失: ${file}`)
	return { backupId: meta.backupId, pcbUuid: meta.pcbUuid, createdAt: meta.createdAt, source: fs.readFileSync(file, 'utf8') }
}

// ---------- SMT 手动查询页面 ----------

function smtPageHtml() {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>SMT 物料查询 - AI Command Engine</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;max-width:1280px;margin:24px auto;padding:0 16px;color:#222}
h1{font-size:20px;border-bottom:2px solid #1565c0;padding-bottom:8px}
fieldset{border:1px solid #ccc;border-radius:6px;margin-bottom:16px}
legend{font-weight:bold;padding:0 8px}
label{display:inline-block;width:110px;text-align:right;margin-right:8px}
input[type=text],input[type=password],input[type=number]{padding:6px 8px;border:1px solid #bbb;border-radius:4px;font-size:14px}
input.k{width:320px}
button{padding:7px 18px;border:none;border-radius:4px;background:#1565c0;color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#0d47a1}
table{border-collapse:collapse;width:100%;margin-top:12px}
th,td{border:1px solid #ddd;padding:6px 10px;font-size:13px;text-align:left}
th{background:#f2f6fb}
tr:nth-child(even){background:#fafafa}
.msg{margin:8px 0;font-size:13px;color:#666}
.msg.err{color:#c62828}
.msg.ok{color:#2e7d32}
.row{margin:6px 0}
</style>
</head>
<body>
<h1>嘉立创 SMT 物料查询</h1>

<fieldset>
<legend>开放平台密钥（保存在代理工作目录，升级插件不丢失）</legend>
<div class="row"><label>App ID</label><input class="k" type="text" id="appId" placeholder="应用 ID"></div>
<div class="row"><label>AccessKey</label><input class="k" type="text" id="accessKey" placeholder="API 密钥 AccessKey"></div>
<div class="row"><label>SecretKey</label><input class="k" type="password" id="secretKey" placeholder="留空表示不修改已保存的 SecretKey"></div>
<div class="row"><label></label><button onclick="saveConfig()">保存密钥</button></div>
<div class="msg" id="cfgMsg">正在读取配置状态...</div>
</fieldset>

<fieldset>
<legend>物料查询</legend>
<div class="row"><label>关键字</label><input class="k" type="text" id="q" placeholder="如 10k、STM32F103、C17902" onkeydown="if(event.key==='Enter')query(1)"></div>
<div class="row"><label>每页数量</label><input type="number" id="pageSize" value="20" min="1" max="100" style="width:80px"></div>
<div class="row"><label></label><button onclick="query(1)">查询</button></div>
<div class="msg" id="qMsg"></div>
<table id="result" style="display:none">
<thead><tr><th>#</th><th>元件编号</th><th>名称</th><th>类别</th><th>元件型号</th><th>封装</th><th>品牌</th><th>库存</th><th>参考单价(¥)</th></tr></thead>
<tbody id="tbody"></tbody>
</table>
<div class="row" id="pager" style="display:none;margin-top:10px">
<button onclick="prevPage()">上一页</button>
<span id="pageInfo" style="margin:0 12px"></span>
<button onclick="nextPage()">下一页</button>
</div>
</fieldset>

<script>
var curPage = 1, totalPages = 1;
function msg(id, text, cls){ var el=document.getElementById(id); el.textContent=text; el.className='msg '+(cls||''); }
function loadConfig(){
	fetch('/smt/config').then(function(r){return r.json()}).then(function(d){
		if(d.configured){
			document.getElementById('appId').value = d.appId||'';
			document.getElementById('accessKey').value = d.accessKey||'';
			msg('cfgMsg','已配置密钥（SecretKey 已保存，修改时留空即可）','ok');
		}else{
			msg('cfgMsg','尚未配置密钥，请填写后保存。密钥在嘉立创开放平台 https://open.jlc.com 创建应用获取','err');
		}
	}).catch(function(e){ msg('cfgMsg','读取配置失败: '+e,'err'); });
}
function saveConfig(){
	var body={ appId:document.getElementById('appId').value.trim(),
		accessKey:document.getElementById('accessKey').value.trim(),
		secretKey:document.getElementById('secretKey').value.trim() };
	fetch('/smt/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
	.then(function(r){return r.json()}).then(function(d){
		if(d.ok){ msg('cfgMsg','密钥已保存','ok'); document.getElementById('secretKey').value=''; }
		else msg('cfgMsg','保存失败: '+(d.error||''),'err');
	}).catch(function(e){ msg('cfgMsg','保存失败: '+e,'err'); });
}
function query(page){
	var q=document.getElementById('q').value.trim();
	if(!q){ msg('qMsg','请输入查询关键字','err'); return; }
	var ps=Number(document.getElementById('pageSize').value)||20;
	msg('qMsg','查询中...');
	fetch('/smt/query',{method:'POST',headers:{'Content-Type':'application/json'},
		body:JSON.stringify({queryString:q,pageNum:page,pageSize:ps})})
	.then(function(r){return r.json()}).then(function(d){
		if(!d.ok){ msg('qMsg','查询失败: '+(d.error&&d.error.message?d.error.message:d.error),'err'); return; }
		var data=d.data, comps=data.components||[];
		curPage=data.pageNum; totalPages=data.totalPages||1;
		var tb=document.getElementById('tbody'); tb.innerHTML='';
		comps.forEach(function(c,i){
			var tr=document.createElement('tr');
			var price=(c.price!=null)?Number(c.price).toFixed(4):'-';
			var stock=(c.stock!=null)?c.stock:'-';
			tr.innerHTML='<td>'+((curPage-1)*data.pageSize+i+1)+'</td><td>'+c.code+'</td>'
				+'<td title="'+(c.description||'').replace(/"/g,'&quot;')+'">'+(c.name||'-')+'</td>'
				+'<td>'+(c.type||'-')+'</td><td>'+(c.model||'-')+'</td><td>'+(c.footprint||'-')+'</td>'
				+'<td>'+(c.brand||'-')+'</td><td>'+stock+'</td><td>'+price+'</td>';
			tb.appendChild(tr);
		});
		document.getElementById('result').style.display = comps.length?'table':'none';
		document.getElementById('pager').style.display = 'block';
		document.getElementById('pageInfo').textContent='第 '+curPage+' / '+totalPages+' 页，共 '+data.totalRows+' 条';
		msg('qMsg', comps.length?('找到 '+data.totalRows+' 条记录'):'未找到匹配物料', comps.length?'ok':'err');
	}).catch(function(e){ msg('qMsg','查询失败: '+e,'err'); });
}
function prevPage(){ if(curPage>1) query(curPage-1); }
function nextPage(){ if(curPage<totalPages) query(curPage+1); }
loadConfig();
</script>
</body>
</html>`
}

// ---------- HTTP 服务 ----------

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`)

	// CORS 预检
	if (req.method === 'OPTIONS') {
		res.writeHead(204, corsHeaders())
		res.end()
		return
	}

	try {
		if (req.method === 'GET' && url.pathname === '/health') {
			json(res, 200, {
				ok: true,
				service: 'ai-command-proxy',
				lifecycleProtocol: 1,
				extensionConnected: Boolean(selectedConnection()),
				extension: extensionInfo,
				connections: [...connections.entries()].map(([ws, c]) => ({
					instanceId: c.instanceId,
					extension: c.extension,
					version: c.version,
					connectedAt: c.connectedAt,
					selected: c.instanceId === selectedInstanceId,
					paused: pausedIds.has(c.instanceId),
					info: c.info,
				})),
				smtConfigured: Boolean(loadCredentials()),
			})
		}
		else if (req.method === 'GET' && url.pathname === '/connections') {
			json(res, 200, {
				ok: true,
				connections: [...connections.entries()].map(([ws, c]) => ({
					instanceId: c.instanceId,
					extension: c.extension,
					version: c.version,
					connectedAt: c.connectedAt,
					selected: c.instanceId === selectedInstanceId,
					paused: pausedIds.has(c.instanceId),
					info: c.info,
				})),
			})
		}
		else if (req.method === 'POST' && url.pathname === '/select') {
			const body = JSON.parse(await readBody(req) || '{}')
			const target = [...connections.entries()].find(([, c]) => c.instanceId === body.instanceId)
			if (!target)
				return json(res, 404, { ok: false, error: `未找到实例 ${body.instanceId}，用 GET /connections 查看在线实例` })
			selectedInstanceId = target[1].instanceId
			extensionSocket = target[0]
			const c = target[1]
			extensionInfo = { extension: c.extension, version: c.version, instanceId: c.instanceId, ...(c.info ?? {}) }
			console.log(`[ai-command-proxy] 指令目标已切换为实例 ${c.instanceId}`)
			json(res, 200, { ok: true, selected: c.instanceId })
		}
		else if (req.method === 'GET' && url.pathname === '/commands') {
			const local = LOCAL_COMMAND_DOCS.map(d => d.name)
			autoSelectIfSingleProject()
			if (!selectedConnection())
				return json(res, 200, { ok: true, cmd: '__listCommands', data: { local, extension: [] } })
			const result = await forwardToExtension({ cmd: '__listCommands' })
			json(res, 200, { ok: true, cmd: '__listCommands', data: { local, extension: result?.data ?? [] } })
		}
		else if (req.method === 'GET' && url.pathname === '/help') {
			const cmd = url.searchParams.get('cmd')
			if (cmd && LOCAL_COMMAND_DOCS.some(d => d.name === cmd))
				return json(res, 200, { ok: true, cmd: '__help', data: LOCAL_COMMAND_DOCS.filter(d => d.name === cmd) })
			autoSelectIfSingleProject()
			if (!selectedConnection())
				return noExtension(res)
			const result = await forwardToExtension({ cmd: '__help', params: { cmd } })
			json(res, 200, result)
		}
		else if (req.method === 'POST' && url.pathname === '/command') {
			const body = await readBody(req)
			const command = JSON.parse(body)
			// smt.* / write.acknowledge 指令由代理本地执行，无需 EDA 在线（write.acknowledge 需目标在线以定位写通道）
			if (typeof command.cmd === 'string' && (command.cmd.startsWith('smt.') || command.cmd === 'write.acknowledge')) {
				try {
					const result = await executeLocalCommand(command)
					if (result)
						return json(res, 200, result)
					return json(res, 404, { ok: false, cmd: command.cmd, error: { message: `未知的本地指令: ${command.cmd}` } })
				}
				catch (err) {
					// 本地指令错误也走统一返回格式，不抛 HTTP 500
					return json(res, 200, { ok: false, cmd: command.cmd, error: { message: String(err?.message ?? err) } })
				}
			}
			// 请求级路由：body 带 instanceId 时直发该窗口（多 AI 客户端并行各带各的，不抢全局 /select）
			const routeId = typeof command.instanceId === 'string' && command.instanceId ? command.instanceId : null
			delete command.instanceId
			// 0.10.70（KIMI-EDA-20261006-02 R2，三层防呆之第三层·桥端硬校验）：**无条件**拒绝
			// 不带 instanceId 的 /command——"省略就落到全局选中实例"是遗忘能造成事故的根子（实测
			// 另一会话画图曾落进别家窗口）。"单实例时放行"同样是危险窗口：两个工程都在跑时关掉
			// 一个，剩下的会静默接盘别家指令（用户定案：一律拒绝，不留例外）。
			// smt.* 本地指令在前面已放行，不受此限；GET /commands、/help 是指令发现接口，仍走选中实例。
			if (!routeId) {
				laneLog({ event: 'missing-instanceId-rejected', cmd: command.cmd, connections: connections.size })
				return json(res, 200, { ok: false, cmd: command.cmd, error: { message: `本指令已拒绝：/command 必须带顶层 instanceId 指定目标窗口，一律不允许省略（当前在线 ${connections.size} 个实例）。先 GET /connections 查 instanceId（勿缓存），再带 instanceId 重发——省略会落到全局选中实例，多 AI 并行时可能操作别家工程` } })
			}
			if (!routeId)
				autoSelectIfSingleProject()
			if (!routeId && !selectedConnection())
				return noExtension(res)
			// 0.10.50：写指令单行道——并发的写指令按目标窗口 FIFO 逐个放行（官方导线 create
			// 并发容量≈2，并发批量 create failed）。读指令不进队列。对调用方透明：并发方式 3
			// 自动退化为逐条执行，不再失败，代价是吞吐 ~3s/条。
			// 0.10.72：放行前先过写保护闸——上一条写结果不确定（超时/心跳丢失）时拒绝一切写，
			// 防止两条写在扩展侧交错污染现场（writeUncertain 自愈或 write.acknowledge 后恢复）
			if (!isReadOnlyCommand(command.cmd)) {
				const blockReason = await assertWriteCertain(routeId)
				if (blockReason)
					return json(res, 200, { ok: false, cmd: command.cmd, error: { message: blockReason } })
			}
			const writeLane = isReadOnlyCommand(command.cmd) ? null : acquireWriteLane(routeId)
			if (writeLane === 'QUEUE_FULL')
				return json(res, 200, { ok: false, cmd: command.cmd, error: { message: `写指令队列已满（${MAX_QUEUED_WRITES} 个写操作排队中），为保护工程已拒绝本条。请等队列消化后再发；大批量操作请合并为一次 batchWire/macro 提交` } })
			const executeWrite = async () => {
				// 0.10.73b（KIMI-EDA-20261006-05 用例1）：出队二次检查——入队时保护尚未设置
				// （前一条写还在跑），排队期间前写超时触发 writeUncertain 的，本条不得发往扩展，
				// 否则会与可能仍在后台执行的旧写交错。解除（可信迟到结果/acknowledge）后重发即可。
				// 注意：读指令也走本函数（不进队列直接转发），二次检查只对写生效。
				if (!isReadOnlyCommand(command.cmd)) {
					const blockReason = await assertWriteCertain(routeId)
					if (blockReason)
						return { ok: false, cmd: command.cmd, error: { message: blockReason } }
				}
				// 破坏性指令执行前自动导出 .epro 备份（官方没有撤销 API，删错不可挽回）
				let backupFile = null
				if (DESTRUCTIVE_COMMANDS.has(command.cmd))
					backupFile = await autoBackupBeforeDestructive(command.cmd, routeId)
				const result = await forwardToExtension(command, routeId, true) // 0.10.72：true=写指令，超时/心跳丢失要触发写保护
				if (backupFile && result && typeof result === 'object' && !Array.isArray(result))
					result.backup = backupFile
				return result
			}
			executeWrite.cmd = command.cmd // 0.10.51：单行道日志用
			const result = writeLane ? await writeLane(executeWrite) : await executeWrite()
			json(res, 200, result)
		}
		else if (req.method === 'GET' && url.pathname === '/smt') {
			res.writeHead(200, corsHeaders({ 'Content-Type': 'text/html; charset=utf-8' }))
			res.end(smtPageHtml())
		}
		else if (req.method === 'GET' && url.pathname === '/smt/config') {
			const cred = loadCredentials()
			json(res, 200, {
				ok: true,
				configured: Boolean(cred),
				appId: cred?.appId ?? '',
				accessKey: cred ? maskSecret(cred.accessKey) : '',
				file: CREDENTIALS_FILE,
			})
		}
		else if (req.method === 'POST' && url.pathname === '/smt/config') {
			const body = JSON.parse(await readBody(req) || '{}')
			const old = loadCredentials() ?? {}
			const cred = {
				appId: String(body.appId ?? old.appId ?? '').trim(),
				accessKey: String(body.accessKey ?? old.accessKey ?? '').trim(),
				// secretKey 留空表示不修改
				secretKey: String(body.secretKey ?? '').trim() || old.secretKey || '',
			}
			if (!cred.appId || !cred.accessKey || !cred.secretKey)
				return json(res, 400, { ok: false, error: 'appId / accessKey / secretKey 均不能为空（secretKey 首次保存必填）' })
			// accessKey 若仍是脱敏值则保留旧值
			if (cred.accessKey.endsWith('******') && old.accessKey)
				cred.accessKey = old.accessKey
			saveCredentials(cred)
			console.log('[ai-command-proxy] 嘉立创开放平台密钥已保存到', CREDENTIALS_FILE)
			json(res, 200, { ok: true })
		}
		else if (req.method === 'POST' && url.pathname === '/smt/query') {
			const body = JSON.parse(await readBody(req) || '{}')
			const data = await smtQueryComponents(body)
			json(res, 200, { ok: true, data })
		}
		else if (req.method === 'POST' && url.pathname === '/source-backup') {
			const body = JSON.parse(await readBody(req) || '{}')
			json(res, 200, { ok: true, ...storeSourceBackup(body) })
		}
		else if (req.method === 'GET' && url.pathname === '/source-backup/list') {
			json(res, 200, { ok: true, backups: listSourceBackups(url.searchParams.get('pcbUuid') || undefined) })
		}
		else if (req.method === 'POST' && url.pathname === '/source-backup/read') {
			const body = JSON.parse(await readBody(req) || '{}')
			json(res, 200, { ok: true, ...readSourceBackup(body) })
		}
		else {
			json(res, 404, { ok: false, error: '未知端点，可用: /health /commands /help /command /connections /select /smt /smt/config /smt/query /source-backup /source-backup/list /source-backup/read' })
		}
	}
	catch (err) {
		if (err?.message === 'NO_EXTENSION')
			return noExtension(res)
		if (err?.message === 'TARGET_OFFLINE')
			return json(res, 503, { ok: false, error: `目标实例 ${selectedInstanceId} 已断开。为保护工程，指令未改投其他窗口；请等其重连，或用 GET /connections + POST /select 显式改选` })
		if (typeof err?.message === 'string' && err.message.startsWith('TARGET_PAUSED:')) {
			const pid = err.message.slice('TARGET_PAUSED:'.length)
			return json(res, 200, { ok: false, error: `目标实例 ${pid} 已被用户从 EDA「AI Command」菜单「断开指令代理」暂停。指令未发往任何窗口（工程安全）。如需恢复，让用户点菜单「连接指令代理」` })
		}
		if (err?.message === 'UNKNOWN_INSTANCE')
			return json(res, 404, { ok: false, error: '请求携带的 instanceId 不在线（用 GET /connections 查看在线实例；该错误说明指令未发往任何窗口，工程安全）' })
		json(res, 500, { ok: false, error: String(err?.message ?? err) })
	}
})

// ---------- WebSocket（扩展接入） ----------

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws) => {
	ws.isAlive = true
	ws.on('pong', () => {
		ws.isAlive = true
	})

	ws.on('message', (raw) => {
		let msg
		try {
			msg = JSON.parse(raw.toString())
		}
		catch {
			return
		}

		if (msg?.type === 'hello') {
			// 多 EDA 窗口共存：不再踢掉旧连接，登记为新实例；仅在无选中实例时自动接管
			const instanceId = msg.instanceId || randomUUID()
			// 0.10.68（KIMI-EDA-20261006-01）：hello 携带扩展侧的 manualStop（菜单「断开指令代理」）状态。
			// true=保持暂停并立即断开（EDA 封装会自动重连，重连 hello 仍是 paused，代理持续挡回，
			//   连接数归零后代理按 IDLE_SHUTDOWN_MS 自动退出——用户要的"断开=后台自动关闭"）；
			// false=恢复（pausedIds 清除，正常建立连接——"连接"时自动重启闭环）。
			if (msg.paused === true) {
				pausedIds.add(instanceId)
				everConnected = true
				if (typeof msg.nonce === 'string' && msg.nonce)
					instanceNonces.set(instanceId, msg.nonce)
				laneLog({ event: 'hello', instanceId, version: msg.version, paused: true, connections: connections.size })
				connections.set(ws, {
					instanceId,
					extension: msg.extension,
					version: msg.version,
					connectedAt: Date.now(),
					info: null,
				})
				console.log(`[ai-command-proxy] 实例 ${instanceId} 处于暂停态（hello paused:true），登记后立即断开`)
				try {
					ws.send(JSON.stringify({ type: 'describe' }))
					ws.close()
				}
				catch {}
				return
			}
			// 0.10.69：恢复口令校验——暂停中的实例只有在帧口令与存值匹配时才允许恢复；
			// 不匹配视为旧模块重放/其他会话越权，保持暂停。校验用存值比对，之后才更新存值，
			// 被拒绝的帧不能轮换口令（否则会把秘密回滚，连真正模块都恢复不了）
			const knownNonce = instanceNonces.get(instanceId)
			const frameNonce = typeof msg.nonce === 'string' && msg.nonce ? msg.nonce : undefined
			if (msg.paused === false && pausedIds.has(instanceId)) {
				const allowed = knownNonce === undefined ? frameNonce === undefined : frameNonce === knownNonce
				if (allowed) {
					pausedIds.delete(instanceId)
					stoppingInstances.delete(instanceId)
					laneLog({ event: 'resume', instanceId, via: 'hello' })
					console.log(`[ai-command-proxy] 实例 ${instanceId} 通过 hello 恢复（口令校验通过），暂停已清除`)
				}
				else {
					laneLog({ event: 'resume-rejected', instanceId, via: 'hello' })
					console.log(`[ai-command-proxy] 实例 ${instanceId} 的恢复声明被口令校验拒绝（疑似旧模块重放/其他会话），保持暂停`)
				}
			}
			if (frameNonce && (knownNonce === undefined || knownNonce === frameNonce))
				instanceNonces.set(instanceId, frameNonce)
			connections.set(ws, {
				instanceId,
				extension: msg.extension,
				version: msg.version,
				connectedAt: Date.now(),
				info: null,
			})
			everConnected = true
			if (!pausedIds.has(instanceId))
				disconnectedAt = 0
			// 仅在从未选定过目标时才自动接管；已选定则粘滞，重连由 selectedConnection() 自动恢复
			if (!selectedInstanceId) {
				selectedInstanceId = instanceId
				extensionSocket = ws
				extensionInfo = { extension: msg.extension, version: msg.version, instanceId }
			}
			console.log(`[ai-command-proxy] 扩展已连接: ${msg.extension} v${msg.version} 实例 ${instanceId}（当前共 ${connections.size} 个连接）`)
			laneLog({ event: 'hello', instanceId, version: msg.version, paused: msg.paused ?? null, connections: connections.size })
			// 请求实例自报家门（工程名 + 打开的标签页），便于多窗口选路
			try {
				ws.send(JSON.stringify({ type: 'describe' }))
			}
			catch {}
			return
		}

		if (msg?.type === 'info') {
			const entry = connections.get(ws)
			if (entry) {
				entry.info = {
					project: msg.project ?? null,
					tabs: Array.isArray(msg.tabs) ? msg.tabs : [],
				}
				if (extensionSocket === ws && extensionInfo)
					extensionInfo = { ...extensionInfo, ...entry.info }
			}
			return
		}

		if (msg?.type === 'ping') {
			// 应用层心跳应答：扩展据此判断连接是否还活着（传输层 ping 无法覆盖半开连接）
			try {
				ws.send(JSON.stringify({ type: 'pong' }))
			}
			catch {}
			return
		}

		// 0.10.66（KIMI-EDA-20261006-01）：扩展菜单「断开指令代理」/强制重连。
		// 官方 sys_WebSocket.close() 实测不生效（close 后代理侧连接仍在、指令照发），
		// 扩展改发 bye 帧，由代理侧主动关闭本连接。
		if (msg?.type === 'bye') {
			const entry = connections.get(ws)
			const stop = entry && stoppingInstances.get(entry.instanceId)
			if (stop && (!msg.requestId || msg.requestId !== stop.requestId)) {
				laneLog({ event: 'bye-rejected-during-stop', instanceId: entry.instanceId })
				return
			}
			if (entry && stop)
				stoppingInstances.delete(entry.instanceId)
			laneLog({ event: 'bye', instanceId: entry?.instanceId ?? null })
			console.log(`[ai-command-proxy] 实例 ${entry?.instanceId ?? '?'} 发送 bye（菜单断开/强制重连），代理侧主动关闭连接`)
			try {
				ws.close()
			}
			catch {}
			return
		}

		// 0.10.74: graceful stop. Pause the target immediately, but keep this owner socket
		// alive until every already-dispatched result and queued write has settled.
		if (msg?.type === 'stop') {
			const entry = connections.get(ws)
			if (!entry || !msg.requestId)
				return
			pausedIds.add(entry.instanceId)
			if (typeof msg.nonce === 'string' && msg.nonce)
				instanceNonces.set(entry.instanceId, msg.nonce)
			stoppingInstances.set(entry.instanceId, { ws, requestId: msg.requestId, blocked: false, readySent: false })
			laneLog({ event: 'stop-request', instanceId: entry.instanceId, requestId: msg.requestId })
			try { ws.send(JSON.stringify({ type: 'stop-accepted', requestId: msg.requestId })) }
			catch {}
			tryCompleteStop(entry.instanceId)
			return
		}

		// 0.10.66/0.10.68（KIMI-EDA-20261006-01）：菜单「断开指令代理」= 暂停 + 断开。
		// EDA 封装会自动重连，重连 hello 带 paused:true 会被代理持续挡回；
		// 连接归零后代理按 IDLE_SHUTDOWN_MS 自动退出（用户要的"断开=后台自动关闭"）。
		if (msg?.type === 'pause') {
			const entry = connections.get(ws)
			if (entry) {
				pausedIds.add(entry.instanceId)
				// 0.10.69：暂停帧若带口令（新版本模块每次断开都会轮换），存为当前口令
				if (typeof msg.nonce === 'string' && msg.nonce)
					instanceNonces.set(entry.instanceId, msg.nonce)
				laneLog({ event: 'pause', instanceId: entry.instanceId })
				console.log(`[ai-command-proxy] 实例 ${entry.instanceId} 已被用户暂停（菜单「断开指令代理」），断开连接；重连将被挡回，全部断开后代理自动退出`)
				try {
					ws.close()
				}
				catch {}
			}
			return
		}

		// 0.10.66：菜单「连接指令代理」= 恢复（resume 先到达、随后 bye+重连换到新连接，暂停标记不带到新连接）
		// 0.10.69：恢复口令校验通过才真正清除暂停
		if (msg?.type === 'resume') {
			const entry = connections.get(ws)
			if (entry) {
				const known = instanceNonces.get(entry.instanceId)
				const frameOk = known === undefined
					? !(typeof msg.nonce === 'string' && msg.nonce)
					: msg.nonce === known
				if (!frameOk) {
					laneLog({ event: 'resume-rejected', instanceId: entry.instanceId, via: 'resume' })
					console.log(`[ai-command-proxy] 实例 ${entry.instanceId} 的 resume 帧被口令校验拒绝，保持暂停`)
					if (msg.requestId)
						try { ws.send(JSON.stringify({ type: 'resume-rejected', requestId: msg.requestId })) } catch {}
				}
				else {
					stoppingInstances.delete(entry.instanceId)
					if (pausedIds.delete(entry.instanceId)) {
						laneLog({ event: 'resume', instanceId: entry.instanceId, via: 'resume' })
						console.log(`[ai-command-proxy] 实例 ${entry.instanceId} 已恢复（菜单「连接指令代理」，口令校验通过）`)
					}
					if (msg.requestId)
						try { ws.send(JSON.stringify({ type: 'resume-accepted', requestId: msg.requestId })) } catch {}
				}
			}
			return
		}

		if (msg?.type === 'result' && msg.id && pending.has(msg.id)) {
			const entry = pending.get(msg.id)
			if (entry.owner !== ws) {
				laneLog({ event: 'foreign-result-rejected', instanceId: entry.instanceId, id: msg.id })
				return
			}
			pending.delete(msg.id)
			clearTimeout(entry.timer)
			if (entry.write && msg.result?.error?.cause?.partial)
				markWriteUncertain(entry.instanceId, entry.cmd ?? '(partial result)', '扩展返回 partial，底层操作是否结束未知', entry.id, ws)
			entry.resolve(msg.result)
			tryCompleteStop(entry.instanceId)
			return
		}

		// 0.10.73：迟到结果只在「id 匹配导致保护的那条写」且「非 partial（非扩展熔断包装层返回）」
		// 时解除保护——其他无主 result（别的超时读请求、其他操作）一律不动保护
		if (msg?.type === 'result' && msg.id && writeUncertain.size) {
			for (const [iid, rec] of writeUncertain) {
				if (rec.id !== msg.id || rec.owner !== ws || connections.get(ws)?.instanceId !== iid) continue
				if (msg.result?.error?.cause?.partial) {
					laneLog({ event: 'late-result-partial-ignored', instanceId: iid, id: msg.id })
				}
				else {
					clearWriteUncertain(iid, 'late-result')
				}
				tryCompleteStop(iid)
				break
			}
		}

		// 0.10.49：进度心跳——长指令（批量删除/batchWire/macro）执行中扩展逐条/逐阶段上报，
		// 据此重置该指令的超时计时器：超时语义从「绝对时长」变为「无心跳时长」，
		// 批量指令不会因总时长被误杀（单条指令不上报心跳，语义不变）
		if (msg?.type === 'progress' && msg.id && pending.has(msg.id)) {
			const entry = pending.get(msg.id)
			if (entry.owner !== ws)
				return
			clearTimeout(entry.timer)
			entry.lastProgress = msg.progress
			entry.timer = setTimeout(() => {
				pending.delete(msg.id)
				// 0.10.72：心跳超时 = 写结果不确定（此分支只可能是写指令，读指令无心跳机制不走这），标记写保护
				// 0.10.73：按实例号键并记录指令 id
				if (entry.write) markWriteUncertain(entry.instanceId, entry.cmd ?? '(心跳超时)', '心跳超时', entry.id, entry.owner)
				tryCompleteStop(entry.instanceId)
				const prog = entry.lastProgress !== undefined ? `；最后进度：${JSON.stringify(entry.lastProgress).slice(0, 500)}` : ''
				entry.resolve({ ok: false, cmd: '(超时)', error: { message: `指令执行超时（${Math.round(entry.timeoutMs / 1000)}s 无进度心跳，代理已放弃等待）${prog}。这≠任务已取消，扩展可能仍在后台执行；重发同参数只回进度不重复执行，或用 task.get 查询` } })
			}, entry.timeoutMs)
			return
		}

		// 0.10.52：扩展诊断日志（删除/终扫/探针各阶段、候选坐标、探针 ID、清理尝试）→ lane-log
		if (msg?.type === 'log' && msg.stage) {
			laneLog({ event: 'ext-log', cmd: msg.cmd, stage: msg.stage, detail: msg.detail })
		}
	})

	ws.on('close', () => {
		const closed = connections.get(ws)
		laneLog({ event: 'close', instanceId: closed?.instanceId ?? null })
		connections.delete(ws)
		writeQueues.delete(ws) // 0.10.50：窗口断开即废弃其写队列（重连后新建）
		// 0.10.73：写保护按实例号键，ws close 不清除——同一宿主重连后旧写仍可能在后台跑，保护必须延续
		if (extensionSocket === ws) {
			extensionSocket = null
			extensionInfo = null
		}
		if (closed && closed.instanceId === selectedInstanceId) {
			// 选定目标断开：保持 selectedInstanceId 不变，绝不自动改选其他窗口（防止指令落到错误工程）
			console.log(`[ai-command-proxy] 选定实例 ${closed.instanceId} 已断开，指令将报 TARGET_OFFLINE 直至其重连或手动 /select`)
		}
		refreshDisconnectedAt()
	})
})

// WS 层心跳保活：20 秒一次 ping，无响应则断开
const pingTimer = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			ws.terminate()
			continue
		}
		ws.isAlive = false
		// Application-level ping: host SDKs may miss transport close/error callbacks,
		// so the extension must be able to confirm the proxy is still responsive.
		try { ws.send(JSON.stringify({ type: 'ping' })) } catch {}
		ws.ping()
	}
}, WS_PING_INTERVAL_MS)
pingTimer.unref()

// 空闲自动退出：扩展曾连接过，断开后超过 IDLE_SHUTDOWN_MS 未重连 → 认为 EDA 已关闭，自动退出
// PROXY_IDLE_MS=0 时禁用自动退出（常驻）
const idleTimer = setInterval(() => {
	refreshDisconnectedAt()
	if (IDLE_SHUTDOWN_MS > 0 && everConnected && !lifecycleBusy() && disconnectedAt > 0 && Date.now() - disconnectedAt > IDLE_SHUTDOWN_MS) {
		console.log(`[ai-command-proxy] 扩展断开超过 ${Math.round(IDLE_SHUTDOWN_MS / 1000)} 秒，自动退出（下次打开 EDA 会自动拉起）`)
		process.exit(0)
	}
}, IDLE_SHUTDOWN_MS > 0 ? Math.min(10000, Math.max(100, Math.floor(IDLE_SHUTDOWN_MS / 4))) : 10000)
idleTimer.unref()

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[ai-command-proxy] 监听 http://127.0.0.1:${PORT}（WS: ws://127.0.0.1:${PORT}/ws），等待 EDA 扩展连接...`)
	console.log(`[ai-command-proxy] SMT 物料查询页面: http://127.0.0.1:${PORT}/smt`)
})
