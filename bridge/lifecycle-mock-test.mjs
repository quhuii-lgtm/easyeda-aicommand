/** Isolated proxy lifecycle protocol regression; does not connect to an EDA process. */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const bridgeDir = path.dirname(fileURLToPath(import.meta.url))
const proxyScript = path.join(bridgeDir, 'command-proxy.mjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
function check(name, pass, detail = '') {
	checks.push({ name, pass: !!pass })
	console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function waitFrame(client, predicate, timeoutMs = 2500) {
	return new Promise((resolve, reject) => {
		const found = client.frames.findIndex(predicate)
		if (found >= 0) return resolve(client.frames.splice(found, 1)[0])
		const timer = setTimeout(() => { cleanup(); reject(new Error('frame timeout')) }, timeoutMs)
		const poll = setInterval(() => {
			const at = client.frames.findIndex(predicate)
			if (at < 0) return
			const [frame] = client.frames.splice(at, 1)
			cleanup()
			resolve(frame)
		}, 10)
		function cleanup() { clearTimeout(timer); clearInterval(poll) }
	})
}
function connect(port, instanceId, onCommand = () => {}) {
	const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`)
	const client = { sock, frames: [], commands: [], pongs: 0 }
	sock.on('message', data => {
		let msg
		try { msg = JSON.parse(data.toString()) } catch { return }
		client.frames.push(msg)
		if (msg.type === 'ping') {
			client.pongs++
			sock.send(JSON.stringify({ type: 'pong' }))
		}
		if (msg.type === 'command') {
			client.commands.push(msg)
			onCommand(msg, client)
		}
	})
	return new Promise((resolve, reject) => {
		sock.once('error', reject)
		sock.once('open', () => {
			sock.send(JSON.stringify({ type: 'hello', extension: 'ai-command-engine', version: '0.10.74-mock', instanceId, paused: false, nonce: `nonce-${instanceId}` }))
			resolve(client)
		})
	})
}
async function post(port, cmd, instanceId, params = {}) {
	const response = await fetch(`http://127.0.0.1:${port}/command`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd, instanceId, params }),
	})
	return response.json()
}
async function waitHealth(port) {
	for (let i = 0; i < 60; i++) {
		try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return r.json() } catch {}
		await delay(50)
	}
	throw new Error(`proxy ${port} did not start`)
}
async function startProxy(port, idleMs) {
	const child = spawn(process.execPath, [proxyScript], {
		env: { ...process.env, PORT: String(port), PROXY_CMD_TIMEOUT_MS: '900', PROXY_IDLE_MS: String(idleMs) },
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	child.stderr.on('data', data => process.stderr.write(`[proxy ${port}] ${data}`))
	await waitHealth(port)
	return child
}
async function stopAndBye(client, requestId, nonce) {
	const ready = waitFrame(client, m => m.type === 'stop-ready' && m.requestId === requestId)
	client.sock.send(JSON.stringify({ type: 'stop', requestId, nonce }))
	await waitFrame(client, m => m.type === 'stop-accepted' && m.requestId === requestId)
	await ready
	client.sock.send(JSON.stringify({ type: 'bye', requestId }))
}

let persistentProxy
let idleProxy
let clients = []
try {
	const PORT = 49811
	persistentProxy = await startProxy(PORT, 0)
	const held = new Map()
	const ownerA = await connect(PORT, 'lifeA', (msg, client) => {
		if (msg.cmd === 'schematic.wait-stop') held.set(msg.id, client)
		else if (msg.cmd === 'schematic.partial-stop') client.sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: false, cmd: msg.cmd, error: { message: 'partial', cause: { partial: true, source: 'mock' } } } }))
		else if (msg.cmd !== 'editor.openDocument') client.sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: {} } }))
	})
	const ownerB = await connect(PORT, 'lifeB', msg => {
		if (msg.cmd !== 'schematic.partial-stop') ownerB.sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: {} } }))
	})
	clients.push(ownerA, ownerB)
	const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
	check('health identifies proxy and lifecycle protocol', health.service === 'ai-command-proxy' && health.lifecycleProtocol === 1)
	await waitFrame(ownerA, m => m.type === 'ping', 22000)
	check('proxy sends an application ping on the existing 20 second heartbeat', ownerA.pongs > 0)

	const slowHttp = post(PORT, 'schematic.wait-stop', 'lifeA')
	const slowCommand = await waitFrame(ownerA, m => m.type === 'command' && m.cmd === 'schematic.wait-stop')
	const queuedHttp = post(PORT, 'editor.openDocument', 'lifeA')
	await delay(80)
	const stopId = 'life-stop-A'
	ownerA.sock.send(JSON.stringify({ type: 'stop', requestId: stopId, nonce: 'nonce-lifeA' }))
	await waitFrame(ownerA, m => m.type === 'stop-accepted' && m.requestId === stopId)
	check('stop is acknowledged immediately while work remains in flight', !ownerA.frames.some(m => m.type === 'stop-ready' && m.requestId === stopId))
	ownerA.sock.send(JSON.stringify({ type: 'result', id: slowCommand.id, result: { ok: true, cmd: slowCommand.cmd, data: 'completed' } }))
	const [slowResult, queuedResult] = await Promise.all([slowHttp, queuedHttp])
	await waitFrame(ownerA, m => m.type === 'stop-ready' && m.requestId === stopId)
	check('in-flight result is delivered before safe stop', slowResult.ok === true)
	check('queued write is rejected without dispatch after stop begins', queuedResult.ok === false && !ownerA.commands.some(m => m.cmd === 'editor.openDocument'))
	ownerA.sock.send(JSON.stringify({ type: 'bye', requestId: stopId }))
	await delay(100)
	check('stopping one window leaves the other window available', (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).connections.some(c => c.instanceId === 'lifeB') && persistentProxy.exitCode === null)

	const partial = await post(PORT, 'schematic.partial-stop', 'lifeB')
	check('partial write response immediately activates write protection', partial.ok === false && /写保护生效/.test((await post(PORT, 'schematic.drawWire', 'lifeB')).error?.message ?? ''))
	const blockedId = 'life-stop-B'
	ownerB.sock.send(JSON.stringify({ type: 'stop', requestId: blockedId, nonce: 'nonce-lifeB' }))
	await waitFrame(ownerB, m => m.type === 'stop-accepted' && m.requestId === blockedId)
	await waitFrame(ownerB, m => m.type === 'stop-blocked' && m.requestId === blockedId)
	check('writeUncertain reports stop-blocked and withholds stop-ready', !ownerB.frames.some(m => m.type === 'stop-ready' && m.requestId === blockedId))
	const ack = await post(PORT, 'write.acknowledge', 'lifeB')
	await waitFrame(ownerB, m => m.type === 'stop-ready' && m.requestId === blockedId)
	check('explicit acknowledgement allows stop to complete', ack.ok === true)
	ownerB.sock.send(JSON.stringify({ type: 'bye', requestId: blockedId }))

	// The short idle threshold uses a separate proxy. Paused reconnect hellos must not reset it.
	const IDLE_PORT = 49812
	idleProxy = await startProxy(IDLE_PORT, 600)
	const idleA = await connect(IDLE_PORT, 'idleA')
	const idleB = await connect(IDLE_PORT, 'idleB', (msg, client) => {
		if (msg.cmd === 'schematic.partial-stop') client.sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: false, cmd: msg.cmd, error: { message: 'partial', cause: { partial: true, source: 'mock' } } } }))
		else client.sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, cmd: msg.cmd, data: {} } }))
	})
	clients.push(idleA, idleB)
	await stopAndBye(idleA, 'idle-stop-A', 'nonce-idleA')
	await delay(900)
	check('one active instance prevents idle shutdown', idleProxy.exitCode === null && (await (await fetch(`http://127.0.0.1:${IDLE_PORT}/health`)).json()).connections.some(c => c.instanceId === 'idleB'))
	await post(IDLE_PORT, 'schematic.partial-stop', 'idleB')
	idleB.sock.send(JSON.stringify({ type: 'stop', requestId: 'idle-stop-B', nonce: 'nonce-idleB' }))
	await waitFrame(idleB, m => m.type === 'stop-accepted' && m.requestId === 'idle-stop-B')
	await waitFrame(idleB, m => m.type === 'stop-blocked' && m.requestId === 'idle-stop-B')
	await delay(900)
	check('writeUncertain prevents idle shutdown after all stop requests', idleProxy.exitCode === null)
	const idleAck = await post(IDLE_PORT, 'write.acknowledge', 'idleB')
	await waitFrame(idleB, m => m.type === 'stop-ready' && m.requestId === 'idle-stop-B')
	idleB.sock.send(JSON.stringify({ type: 'bye', requestId: 'idle-stop-B' }))
	await delay(100)
	for (let i = 0; i < 6 && idleProxy.exitCode === null; i++) {
		const replay = new WebSocket(`ws://127.0.0.1:${IDLE_PORT}/ws`)
		replay.on('open', () => replay.send(JSON.stringify({ type: 'hello', extension: 'ai-command-engine', version: '0.10.74-mock', instanceId: 'idleB', paused: true, nonce: 'nonce-idleB' })))
		await new Promise(resolve => { replay.once('close', resolve); replay.once('error', resolve); setTimeout(resolve, 100) })
		await delay(80)
	}
	for (let i = 0; i < 35 && idleProxy.exitCode === null; i++) await delay(100)
	check('all stopped instances idle out and repeated paused hellos do not reset timer', idleAck.ok === true && idleProxy.exitCode === 0)
}
catch (error) {
	console.error('Lifecycle mock failed:', error)
	checks.push({ name: 'test harness completed without exception', pass: false })
}
finally {
	for (const client of clients) { try { client.sock.terminate() } catch {} }
	for (const child of [persistentProxy, idleProxy]) { try { child?.kill() } catch {} }
}
const failures = checks.filter(c => !c.pass)
console.log(`\nLifecycle mock: ${checks.length - failures.length}/${checks.length} passed`)
process.exit(failures.length ? 1 : 0)
