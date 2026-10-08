/**
 * 0.10.73 writeUncertain 状态机假宿主模拟验证（KIMI-EDA-20261006-04 P1-3 回归）
 * 不触碰真实 EDA：独立端口起代理 + WebSocket 假扩展，模拟挂起/迟到结果/断线重连。
 * 用法：node mock-host-test.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const BRIDGE = path.dirname(fileURLToPath(import.meta.url))
const PORT = 49799
const LANE_LOG = path.join(BRIDGE, `lane-log-${new Date().toISOString().slice(0, 10)}.jsonl`)
const results = []
const check = (name, cond, detail = '') => {
	results.push({ name, pass: !!cond, detail })
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function post(cmd, params = {}, instanceId = 'mockA') {
	const res = await fetch(`http://127.0.0.1:${PORT}/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd, params, instanceId }),
	})
	return res.json()
}

function laneEvents(event, instanceId = 'mockA') {
	try {
		return fs.readFileSync(LANE_LOG, 'utf-8').split('\n').filter(Boolean)
			.map(l => { try { return JSON.parse(l) } catch { return null } })
			.filter(e => e && e.event === event && (instanceId === null || e.instanceId === instanceId))
	}
	catch { return [] }
}

let hungCmdId = null
let ws = null

function connectExt(instanceId = 'mockA', port = PORT) {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`)
		sock.on('open', () => {
			sock.send(JSON.stringify({ type: 'hello', extension: 'ai-command-engine', version: '0.10.73-mock', instanceId }))
			ws = sock
			resolve(sock)
		})
		sock.on('error', reject)
		sock.on('message', (data) => {
			let msg
			try { msg = JSON.parse(data.toString()) } catch { return }
			if (msg.type !== 'command') return
			if (msg.cmd === 'schematic.hang') return // 模拟官方 API 挂起：永不回复
			if (msg.cmd === 'schematic.list') {
				// 读指令模拟：正常应答
				sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: ['page1', 'page2'] } }))
				return
			}
			sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: 'mock-ok' } }))
		})
	})
}
async function postAt(port, cmd, params = {}, instanceId) {
	const res = await fetch(`http://127.0.0.1:${port}/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd, params, instanceId }),
	})
	return res.json()
}

function waitForFrame(sock, predicate, timeoutMs = 2000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { sock.off('message', onMessage); reject(new Error('frame timeout')) }, timeoutMs)
		const onMessage = (data) => {
			let msg
			try { msg = JSON.parse(data.toString()) } catch { return }
			if (!predicate(msg)) return
			clearTimeout(timer)
			sock.off('message', onMessage)
			resolve(msg)
		}
		sock.on('message', onMessage)
	})
}

async function main() {
	const proxy = spawn(process.execPath, [path.join(BRIDGE, 'command-proxy.mjs')], {
		env: { ...process.env, PORT: String(PORT), PROXY_CMD_TIMEOUT_MS: '1500', PROXY_IDLE_MS: '0' },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	proxy.stderr.on('data', d => process.stderr.write(`[proxy] ${d}`))
	const cleanup = () => { try { proxy.kill() } catch {} }
	process.on('exit', cleanup)

	// 等代理起来
	for (let i = 0; i < 40; i++) {
		try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break } catch {}
		await sleep(250)
	}

	await connectExt()

	// ① 写指令挂起 → 超时 → 写保护 set（超时走 HTTP 500 + error 字符串，为 0.10.72 前既有行为）
	const t0 = Date.now()
	const hangRes = await post('schematic.hang')
	const hangMsg = hangRes?.error?.message ?? hangRes?.error ?? ''
	check('① 挂起写超时返回错误', hangRes?.ok === false && /超时/.test(String(hangMsg)), String(hangMsg).slice(0, 60))
	console.log(`   (耗时 ${Date.now() - t0}ms)`)
	await sleep(300)
	const sets = laneEvents('write-uncertain-set')
	check('① lane-log 记 write-uncertain-set', sets.length >= 1, sets.at(-1) ? `cmd=${sets.at(-1).cmd} id=${sets.at(-1).id}` : '无事件')
	hungCmdId = sets.at(-1)?.id
	check('① 保护记录带指令 id', typeof hungCmdId === 'string' && hungCmdId.length > 8, hungCmdId)

	// ② 冷却期内第二条写被拒
	const blocked = await post('schematic.drawWire')
	check('② 第二条写被拒（写保护生效）', blocked?.ok === false && /写保护生效/.test(blocked?.error?.message ?? ''))

	// ③ 读指令不受限
	const readRes = await post('schematic.list')
	check('③ 读指令不受写保护限制', readRes?.ok === true && Array.isArray(readRes?.data))

	// ④ 无关迟到 result（错误 id）不解保护
	ws.send(JSON.stringify({ type: 'result', id: 'wrong-id-0000', result: { ok: true } }))
	await sleep(300)
	const blocked2 = await post('schematic.drawWire')
	check('④ 错误 id 的迟到结果不解保护', blocked2?.ok === false && /写保护生效/.test(blocked2?.error?.message ?? ''))

	// ⑤ 匹配 id 但 partial（扩展熔断包装层返回）不解保护
	ws.send(JSON.stringify({ type: 'result', id: hungCmdId, result: { ok: false, error: { message: '指令执行超时', cause: { partial: true, source: 'heartbeat-fuse' } } } }))
	await sleep(300)
	const blocked3 = await post('schematic.drawWire')
	check('⑤ partial 迟到结果不解保护', blocked3?.ok === false && /写保护生效/.test(blocked3?.error?.message ?? ''))
	check('⑤ lane-log 记 late-result-partial-ignored', laneEvents('late-result-partial-ignored').length >= 1)

	// ⑥ 匹配 id 且非 partial → 自愈，写放行
	ws.send(JSON.stringify({ type: 'result', id: hungCmdId, result: { ok: true, cmd: 'schematic.hang', data: 'late-done' } }))
	await sleep(300)
	const writeAfter = await post('schematic.drawWire')
	check('⑥ 可信迟到结果自愈、写放行', writeAfter?.ok === true, JSON.stringify(writeAfter).slice(0, 80))
	check('⑥ lane-log 记 late-result 清除', laneEvents('write-uncertain-cleared').some(e => e.why === 'late-result'))

	// ⑦ 再次挂起 → 断线重连（同实例号）→ 保护延续 → write.acknowledge 解除
	await post('schematic.hang')
	await sleep(2200)
	check('⑦ 第二次挂起触发保护', laneEvents('write-uncertain-set').length >= 2)
	ws.close()
	await sleep(400)
	await connectExt() // 同 instanceId 重连
	const blocked4 = await post('schematic.drawWire')
	check('⑦ 断线重连后保护延续（按实例号键）', blocked4?.ok === false && /写保护生效/.test(blocked4?.error?.message ?? ''))
	const ack = await post('write.acknowledge', {}, 'mockA')
	check('⑦ write.acknowledge 解除保护', ack?.ok === true && ack?.acknowledged === true && ack?.hadProtection === true, JSON.stringify(ack).slice(0, 100))
	const writeFinal = await post('schematic.drawWire')
	check('⑦ 解除后写放行', writeFinal?.ok === true)

	// ⑧ 入队后触发保护的排队写，出队时必须被拦（KIMI-EDA-20261006-05 用例1）
	// hang 占住写通道；openDocument 在保护设置前入队；hang 超时触发 writeUncertain；
	// openDocument 出队时二次检查必须拦住，不得到达假宿主；可信迟到结果到达后重发放行。
	const received = []
	ws.removeAllListeners('message')
	ws.on('message', (data) => {
		let msg
		try { msg = JSON.parse(data.toString()) } catch { return }
		if (msg.type === 'command') {
			received.push(msg.cmd)
			if (msg.cmd === 'macro') {
				// 模拟长宏：600ms 后完成（整体占一条写通道）
				setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: 'macro', data: 'macro-done' } })), 600)
				return
			}
			if (msg.cmd !== 'schematic.hang')
				ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: 'mock-ok' } }))
		}
	})
	const hangP = post('schematic.hang').catch(() => {}) // 挂起，占住写通道
	await sleep(200) // 确保 hang 先进入队列
	const t8 = Date.now()
	const openRes = await post('editor.openDocument', { uuid: 'page1' })
	const openMs = Date.now() - t8
	await hangP
	check('⑧a 排队写出队时被写保护拦截（未发往扩展）', openRes?.ok === false && /写保护生效/.test(openRes?.error?.message ?? ''), `耗时 ${openMs}ms`)
	check('⑧b 假宿主只收到 hang，未收到被拦的 openDocument', JSON.stringify(received) === JSON.stringify(['schematic.hang']), received.join('→'))
	const hangId8 = laneEvents('write-uncertain-set').at(-1)?.id
	ws.send(JSON.stringify({ type: 'result', id: hangId8, result: { ok: true, cmd: 'schematic.hang', data: 'late-done' } }))
	await sleep(300)
	const openRetry = await post('editor.openDocument', { uuid: 'page1' })
	check('⑧c 可信迟到结果自愈后重发放行', openRetry?.ok === true, JSON.stringify(openRetry).slice(0, 80))

	// ⑩ macro 整体占写通道：外部 openDocument 排在 macro 完成之后（不被插入、不自我死锁）
	const received10 = []
	let macroId10 = null
	let resolveMacroDispatched
	const macroDispatched = new Promise(resolve => { resolveMacroDispatched = resolve })
	ws.removeAllListeners('message')
	ws.on('message', (data) => {
		let msg
		try { msg = JSON.parse(data.toString()) } catch { return }
		if (msg.type === 'command') {
			received10.push(msg.cmd)
			if (msg.cmd === 'macro') {
				macroId10 = msg.id
				resolveMacroDispatched()
				return
			}
			ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: 'mock-ok' } }))
		}
	})
	const t10 = Date.now()
	const enqueueCount10 = laneEvents('enqueue', null).length
	const macroPromise10 = post('macro', { steps: [{ cmd: 'schematic.drawWire' }] })
	await Promise.race([macroDispatched, sleep(2000).then(() => { throw new Error('macro was not dispatched') })])
	const openPromise10 = post('editor.openDocument', { uuid: 'page1' })
	let secondEnqueued10 = false
	for (let i = 0; i < 100; i++) {
		secondEnqueued10 = laneEvents('enqueue', null).slice(enqueueCount10).some(e => e.cmd === 'editor.openDocument')
		if (secondEnqueued10) break
		await sleep(20)
	}
	check('⑩ 外部切页已进入写队列', secondEnqueued10)
	await sleep(50)
	check('⑩ macro 未完成前切页未派发', JSON.stringify(received10) === JSON.stringify(['macro']), received10.join('→'))
	ws.send(JSON.stringify({ type: 'result', id: macroId10, result: { ok: true, cmd: 'macro', data: 'macro-done' } }))
	const [macroRes, openRes10] = await Promise.all([macroPromise10, openPromise10])
	const macroMs = Date.now() - t10
	check('⑩ macro 完成且外部切页排在其后（不插入不死锁）', macroRes?.ok === true && openRes10?.ok === true, `总耗时 ${macroMs}ms`)
	check('⑩ 假宿主收到顺序 macro→openDocument', JSON.stringify(received10) === JSON.stringify(['macro', 'editor.openDocument']), received10.join('→'))

	// 汇总
	const fails = results.filter(r => !r.pass)
	console.log(`\n===== ${results.length - fails.length}/${results.length} 通过${fails.length ? '，失败：' + fails.map(f => f.name).join('、') : ''} =====`)
	cleanup()
	process.exit(fails.length ? 1 : 0)
}

main().catch(err => { console.error('测试异常:', err); process.exit(2) })
