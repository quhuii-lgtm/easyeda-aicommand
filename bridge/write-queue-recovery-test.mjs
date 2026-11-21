/** Focused proxy regression: queue cancellation, uncertain writes, readonly access and reconnect. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const BRIDGE = path.dirname(fileURLToPath(import.meta.url))
const PORT = 49798
const checks = []
const check = (name, ok, detail = '') => {
	checks.push({ name, ok: !!ok })
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function post(cmd, instanceId = 'test-window', params = {}, signal) {
	const response = await fetch(`http://127.0.0.1:${PORT}/command`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ cmd, instanceId, params }), signal,
	})
	return response.json()
}

async function connect(instanceId = 'test-window', onCommand = () => {}) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
	await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
	ws.send(JSON.stringify({ type: 'hello', extension: 'ai-command-engine', version: 'test', instanceId }))
	ws.on('message', data => {
		let message
		try { message = JSON.parse(data.toString()) } catch { return }
		if (message.type === 'command') onCommand(ws, message)
	})
	return ws
}

const proxy = spawn(process.execPath, [path.join(BRIDGE, 'command-proxy.mjs')], {
	env: { ...process.env, PORT: String(PORT), PROXY_CMD_TIMEOUT_MS: '700', PROXY_IDLE_MS: '0' },
	stdio: ['ignore', 'ignore', 'pipe'],
})
proxy.stderr.on('data', data => process.stderr.write(data))
const shutdown = () => { try { proxy.kill() } catch {} }
process.on('exit', shutdown)

try {
	for (let i = 0; i < 50; i++) {
		try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {}
		await sleep(100)
	}

	const received = []
	const receivedNetlistTypes = []
	let firstId
	let ws = await connect('test-window', (socket, message) => {
		received.push(message.cmd)
		if (message.cmd === 'schematic.getNetlist') receivedNetlistTypes.push(message.params?.netlistType ?? 'Protel2')
		if (message.cmd === 'schematic.hang') { firstId = message.id; return }
		if (message.cmd === 'schematic.list') {
			socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
			return
		}
		if (message.cmd === 'schematic.get') return // exercise a readonly timeout while a write is frozen
		if (message.cmd === 'schematic.businessPartial') {
			socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: false, error: { cause: { partial: true, operation: 'local-business-rejection' } } } }))
			return
		}
		socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
	})

	const active = post('schematic.hang')
	for (let i = 0; i < 30 && !firstId; i++) await sleep(20)
	const aborted = new AbortController()
	const queuedPromise = post('editor.openDocument', 'test-window', {}, aborted.signal).catch(() => null)
	await sleep(80)
	aborted.abort()
	await queuedPromise
	await sleep(50)
	check('queued write is cancelled when client disconnects', !received.includes('editor.openDocument'), received.join(' → '))

	const timeoutResult = await active
	const timedOutId = timeoutResult?.error?.cause?.requestId
	check('dispatched timeout carries original requestId', timeoutResult?.error?.cause?.code === 'BRIDGE_COMMAND_TIMEOUT' && timedOutId === firstId)
	const frozen = await post('schematic.drawWire')
	check('dependent write is frozen after timeout', frozen?.error?.cause?.code === 'WRITE_OUTCOME_UNKNOWN')
	const exportNetlistBlocked = await post('schematic.exportNetlist')
	const exportNetlistJlcBlocked = await post('schematic.getNetlist', 'test-window', { netlistType: 'JLCEDA' })
	const netlistRead = await post('schematic.getNetlist')
	check('side-effecting schematic netlist exports are blocked with zero host frames', exportNetlistBlocked?.error?.cause?.code === 'WRITE_OUTCOME_UNKNOWN' && exportNetlistJlcBlocked?.error?.cause?.code === 'WRITE_OUTCOME_UNKNOWN' && !received.includes('schematic.exportNetlist') && !receivedNetlistTypes.includes('JLCEDA'))
	check('default Protel2 getNetlist remains a readonly diagnostic', netlistRead?.ok === true && received.includes('schematic.getNetlist'))
	const read = await post('schematic.list')
	check('readonly diagnostics remain available while frozen', read?.ok === true)
	const readTimeout = await post('schematic.get')
	check('readonly timeout does not claim that writes were frozen', readTimeout?.error?.cause?.code === 'BRIDGE_COMMAND_TIMEOUT' && !/后续写入已暂停/.test(readTimeout?.error?.message ?? ''))

	ws.send(JSON.stringify({ type: 'result', id: firstId, result: { ok: true, cmd: 'schematic.hang', data: 'terminal' } }))
	await sleep(40)
	const afterLateTerminal = await post('schematic.drawWire')
	check('matching late terminal result restores writes', afterLateTerminal?.ok === true)

	const longWrite = post('schematic.hang')
	for (let i = 0; i < 30 && received.filter(cmd => cmd === 'schematic.hang').length < 2; i++) await sleep(20)
	const longId = firstId
	const expiresWhileQueued = post('editor.openDocument')
	await sleep(250)
	ws.send(JSON.stringify({ type: 'progress', id: longId, progress: { phase: 'still-running' } }))
	await sleep(250)
	ws.send(JSON.stringify({ type: 'progress', id: longId, progress: { phase: 'still-running' } }))
	const queuedTimeout = await expiresWhileQueued
	check('queued write expires with a not-sent result', queuedTimeout?.error?.cause?.code === 'BRIDGE_QUEUE_TIMEOUT' && queuedTimeout?.error?.cause?.outcome === 'not_started')
	check('expired queued write is not dispatched later', !received.includes('editor.openDocument'), received.join(' → '))
	ws.send(JSON.stringify({ type: 'result', id: longId, result: { ok: true, cmd: 'schematic.hang' } }))
	await longWrite

	const watchdogPromise = post('schematic.hang')
	for (let i = 0; i < 30 && received.filter(cmd => cmd === 'schematic.hang').length < 3; i++) await sleep(20)
	const watchdogId = firstId
	ws.send(JSON.stringify({ type: 'result', id: watchdogId, result: { ok: false, error: { message: 'watchdog timeout', cause: { partial: true, source: 'client-watchdog' } } } }))
	await watchdogPromise
	const watchdogFrozen = await post('schematic.drawWire')
	check('client watchdog result keeps writes frozen', watchdogFrozen?.error?.cause?.requestId === watchdogId)
	const watchdogAck = await post('write.acknowledge', 'test-window', { confirmedTerminal: true, requestId: watchdogId, confirmation: 'task-terminal' })
	check('verified watchdog terminal acknowledgment restores lane', watchdogAck?.ok === true)

	const fusePromise = post('schematic.hang')
	for (let i = 0; i < 30 && received.filter(cmd => cmd === 'schematic.hang').length < 4; i++) await sleep(20)
	const fuseId = firstId
	ws.send(JSON.stringify({ type: 'result', id: fuseId, result: { ok: false, error: { message: 'registry fuse timeout', cause: { partial: true, source: 'heartbeat-fuse' } } } }))
	await fusePromise
	const fuseFrozen = await post('schematic.drawWire')
	check('registry heartbeat-fuse result keeps writes frozen', fuseFrozen?.error?.cause?.requestId === fuseId)
	const fuseAck = await post('write.acknowledge', 'test-window', { confirmedTerminal: true, requestId: fuseId, confirmation: 'task-terminal' })
	check('verified registry fuse terminal acknowledgment restores lane', fuseAck?.ok === true)

	const normalPartial = await post('schematic.businessPartial')
	check('ordinary business partial is returned without freezing the lane', normalPartial?.ok === false && (await post('schematic.drawWire'))?.ok === true)

	const disconnectPromise = post('schematic.hang')
	for (let i = 0; i < 30 && received.filter(cmd => cmd === 'schematic.hang').length < 5; i++) await sleep(20)
	const disconnectedId = firstId
	const staleQueuedWrite = post('editor.openDocument')
	await sleep(40)
	ws.close()
	const disconnectResult = await disconnectPromise
	check('disconnect response identifies unknown original request', disconnectResult?.error?.cause?.code === 'BRIDGE_DISCONNECTED' && disconnectResult?.error?.cause?.requestId === disconnectedId)
	const staleQueuedResult = await staleQueuedWrite
	check('disconnect cancels queued old-socket write', staleQueuedResult?.error?.cause?.code === 'BRIDGE_QUEUE_CANCELLED')

	const otherReceived = []
	const other = await connect('other-window', (socket, message) => {
		otherReceived.push(message.cmd)
		socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
	})
	check('different instance is not blocked by old instance uncertainty', (await post('schematic.drawWire', 'other-window'))?.ok === true)

	ws = await connect('test-window', (socket, message) => {
		received.push(message.cmd)
		socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
	})
	const sameInstanceBlocked = await post('schematic.drawWire')
	check('reconnect with same instanceId keeps old uncertainty', sameInstanceBlocked?.error?.cause?.requestId === disconnectedId)
	check('old queued command is never forwarded after reconnect', !received.includes('editor.openDocument'))
	const badAck = await post('write.acknowledge', 'test-window', { confirmedTerminal: true, requestId: 'wrong-id', confirmation: 'task-terminal' })
	check('wrong requestId cannot clear uncertainty', badAck?.ok === false && (await post('schematic.drawWire'))?.error?.cause?.requestId === disconnectedId)
	const ack = await post('write.acknowledge', 'test-window', { confirmedTerminal: true, requestId: disconnectedId, confirmation: 'window-exited-and-readback' })
	check('explicit verified terminal acknowledgment restores only matching instance', ack?.ok === true && ack?.hadProtection === true && (await post('schematic.drawWire'))?.ok === true)

	const backupDir = path.join(BRIDGE, 'backups')
	const backupDirExisted = fs.existsSync(backupDir)
	const backupFilesBefore = new Set(backupDirExisted ? fs.readdirSync(backupDir) : [])
	const backupCommands = []
	let backupExportId = null
	const backupWs = await connect('backup-window', (socket, message) => {
		backupCommands.push(message.cmd)
		if (message.cmd === 'project.getInfo') {
			socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, data: { uuid: 'backup-cancel-project' } } }))
		}
		else if (message.cmd === 'project.exportFile') backupExportId = message.id
		else socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
	})
	const deleteAbort = new AbortController()
	const deletePromise = post('schematic.delete', 'backup-window', {}, deleteAbort.signal).catch(() => null)
	for (let i = 0; i < 50 && !backupExportId; i++) await sleep(20)
	deleteAbort.abort()
	await deletePromise
	backupWs.send(JSON.stringify({ type: 'result', id: backupExportId, result: { ok: true, data: { base64: 'dGVzdC1lZXBybw==' } } }))
	await sleep(120)
	check('delete is not sent after backup returns to an aborted HTTP request', !backupCommands.includes('schematic.delete'), backupCommands.join(' → '))
	check('the serial write lane recovers after cancelled pre-send work', (await post('schematic.drawWire', 'backup-window'))?.ok === true)
	for (const file of fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(name => !backupFilesBefore.has(name)) : [])
		fs.unlinkSync(path.join(backupDir, file))
	if (!backupDirExisted && fs.existsSync(backupDir) && fs.readdirSync(backupDir).length === 0)
		fs.rmdirSync(backupDir)

	let reconnectExportId = null
	const oldBackupWs = await connect('backup-reconnect-window', (socket, message) => {
		if (message.cmd === 'project.getInfo') socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, data: { uuid: 'reconnect-backup-project' } } }))
		else if (message.cmd === 'project.exportFile') reconnectExportId = message.id
		else socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
	})
	const reconnectDelete = post('schematic.delete', 'backup-reconnect-window')
	for (let i = 0; i < 50 && !reconnectExportId; i++) await sleep(20)
	oldBackupWs.close()
	let reconnectFrames = []
	const newBackupWs = await connect('backup-reconnect-window', (socket, message) => {
		reconnectFrames.push(message.cmd)
		socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, cmd: message.cmd } }))
	})
	const reconnectDeleteResult = await reconnectDelete
	check('backup read followed by reconnection rejects delete instead of rerouting', reconnectDeleteResult?.error?.code === 'BRIDGE_DISCONNECTED' && !reconnectFrames.includes('project.exportFile') && !reconnectFrames.includes('schematic.delete'))
	check('subsequent write can use the reconnected socket after pre-send rejection', (await post('schematic.drawWire', 'backup-reconnect-window'))?.ok === true)
	newBackupWs.close()

	other.close()
	ws.close()
	const failures = checks.filter(item => !item.ok)
	console.log(`\n${checks.length - failures.length}/${checks.length} proxy recovery checks passed${failures.length ? `; failed: ${failures.map(f => f.name).join(', ')}` : ''}`)
	process.exit(failures.length ? 1 : 0)
}
catch (error) {
	console.error(error)
	process.exit(2)
}
finally {
	shutdown()
}
