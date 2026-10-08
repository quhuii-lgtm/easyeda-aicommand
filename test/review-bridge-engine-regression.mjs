/** R1/R7 regressions. Uses an isolated local proxy, mocked extension frames and the real registry/backup source. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import Module from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import WebSocket from 'ws'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checks = []

function check(name, condition, details = '') {
	checks.push({ name, passed: Boolean(condition) })
	console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${details ? ` — ${details}` : ''}`)
}

async function reservePort() {
	const server = net.createServer()
	await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
	const { port } = server.address()
	await new Promise(resolve => server.close(resolve))
	return port
}

async function waitForHealth(port, timeoutMs = 5000) {
	const end = Date.now() + timeoutMs
	while (Date.now() < end) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`)
			if (response.ok)
				return
		}
		catch {}
		await new Promise(resolve => setTimeout(resolve, 25))
	}
	throw new Error('isolated proxy did not become healthy')
}

async function checkPendingPartialProtection() {
	const port = await reservePort()
	const proxy = spawn(process.execPath, [path.join(ROOT, 'bridge', 'command-proxy.mjs')], {
		env: { ...process.env, PORT: String(port), PROXY_IDLE_MS: '0', PROXY_CMD_TIMEOUT_MS: '3000' },
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	const stderr = []
	proxy.stderr.on('data', data => stderr.push(data.toString()))
	let ws
	try {
		await waitForHealth(port)
		ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
		await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject))
		ws.send(JSON.stringify({ type: 'hello', extension: 'test-mock', version: 'test', instanceId: 'partial-instance' }))
		const received = []
		ws.on('message', raw => {
			let message
			try { message = JSON.parse(raw.toString()) }
			catch { return }
			if (message.type !== 'command')
				return
			received.push(message.cmd)
			if (message.cmd === 'editor.openDocument') {
				ws.send(JSON.stringify({
					type: 'result',
					id: message.id,
					result: { ok: false, cmd: message.cmd, error: { message: 'mock partial', cause: { partial: true, source: 'test' } } },
				}))
			}
		})
		const post = async cmd => {
			const response = await fetch(`http://127.0.0.1:${port}/command`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cmd, params: {}, instanceId: 'partial-instance' }),
			})
			return response.json()
		}
		const first = await post('editor.openDocument')
		const second = await post('editor.closeDocument')
		check('R1 pending partial prevents the next write from reaching the extension', first?.ok === false && second?.ok === false && /写保护生效/.test(second?.error?.message ?? '') && JSON.stringify(received) === JSON.stringify(['editor.openDocument']), JSON.stringify({ first: first?.error?.message, second: second?.error?.message, received }))
	}
	finally {
		try { ws?.close() }
		catch {}
		const stopped = new Promise(resolve => {
			if (proxy.exitCode !== null) {
				resolve()
				return
			}
			const timer = setTimeout(resolve, 2000)
			proxy.once('close', () => { clearTimeout(timer); resolve() })
		})
		proxy.kill()
		await stopped
	}
	if (proxy.exitCode !== 0 && proxy.exitCode !== null)
		throw new Error(`isolated proxy exited ${proxy.exitCode}: ${stderr.join('')}`)
}

async function loadRegistry() {
	const filename = path.join(ROOT, 'src', 'engine', 'registry.ts')
	const result = await build({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false })
	const loaded = new Module(filename)
	loaded.filename = filename
	loaded.paths = Module._nodeModulePaths(ROOT)
	loaded._compile(result.outputFiles[0].text, filename)
	return loaded.exports
}

async function checkMacroPartialPropagation() {
	const registry = await loadRegistry()
	let followingWrites = 0
	registry.registerCommand({
		name: 'test.partialWrite', summary: 'test', params: [], returns: 'never',
		handler: async () => { throw new Error('wrapped timeout', { cause: { partial: true, source: 'test' } }) },
	})
	registry.registerCommand({
		name: 'test.followingWrite', summary: 'test', params: [], returns: 'ok',
		handler: async () => { followingWrites++; return { done: true } },
	})
	for (const stopOnError of [true, false]) {
		followingWrites = 0
		const result = await registry.executeCommand({ cmd: 'macro', params: { stopOnError, steps: [
			{ cmd: 'test.partialWrite' },
			{ cmd: 'test.followingWrite' },
		] } })
		check(`R1 macro stopOnError=${stopOnError} preserves partial and halts later writes`, result?.ok === false && result?.error?.cause?.partial === true && result?.data?.steps?.[0]?.error?.cause?.partial === true && result?.data?.unexecutedSteps === 1 && followingWrites === 0 && /不要直接重发/.test(result?.error?.message ?? ''))
	}
	followingWrites = 0
	const nested = await registry.executeCommand({ cmd: 'macro', params: { steps: [
		{ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'test.partialWrite' },
			{ cmd: 'test.followingWrite' },
		] } },
		{ cmd: 'test.followingWrite' },
	] } })
	check('R1 nested macro retains partial and halts both inner and outer writes', nested?.ok === false && nested?.error?.cause?.partial === true && nested?.data?.steps?.[0]?.error?.cause?.partial === true && followingWrites === 0)
}

async function checkBackupIdentityThrottle() {
	const source = fs.readFileSync(path.join(ROOT, 'bridge', 'command-proxy.mjs'), 'utf8')
	const start = source.indexOf("const BACKUP_DIR = path.join(PROXY_DIR, 'backups')")
	const end = source.indexOf('// ---------- 源码备份', start)
	assert(start >= 0 && end > start, 'backup function section markers must remain in proxy source')
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicommand-r7-'))
	const writtenFiles = new Set()
	const fixedNow = Date.parse('2026-10-06T00:00:00.000Z')
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [fixedNow])) }
		static now() { return fixedNow }
	}
	const projectByInstance = new Map([['instance-A', { uuid: 'project-A', friendlyName: 'same-name' }], ['instance-B', { uuid: 'project-B', friendlyName: 'same-name' }]])
	let exportCalls = 0
	let failNextExport = false
	let switchOnExport = null
	const context = {
		PROXY_DIR: tempRoot,
		fs,
		path,
		Buffer,
		Date: FixedDate,
		randomUUID,
		console,
		forwardToExtension: async (message, instanceId) => {
			if (message.cmd === 'project.getInfo') {
				const identity = projectByInstance.get(instanceId)
				return identity ? { ok: true, cmd: message.cmd, data: { uuid: identity.uuid, friendlyName: identity.friendlyName } } : { ok: true, cmd: message.cmd, data: {} }
			}
			assert.equal(message.cmd, 'project.exportFile')
			exportCalls++
			if (failNextExport) {
				failNextExport = false
				return { ok: true, cmd: message.cmd, data: {} }
			}
			if (switchOnExport) {
				projectByInstance.set(switchOnExport.instanceId, switchOnExport.identity)
				switchOnExport = null
			}
			return { ok: true, cmd: message.cmd, data: { base64: Buffer.from('mock-epro').toString('base64') } }
		},
	}
	try {
		vm.runInNewContext(source.slice(start, end), context, { filename: 'command-proxy-backup-section.vm' })
		let serial = 0
		const backup = async (instanceId, commandName = `test-${++serial}`) => {
			const file = await context.autoBackupBeforeDestructive(commandName, instanceId)
			if (file) writtenFiles.add(file)
			return file
		}

		const aFirst = await backup('instance-A', 'same-command')
		const beforeDuplicate = exportCalls
		const aDuplicate = await backup('instance-A')
		check('R7 same instance and project is still throttled after a successful backup', Boolean(aFirst) && aDuplicate === null && exportCalls === beforeDuplicate)
		const bSameMillisecond = await backup('instance-B', 'same-command')
		check('R7 same-millisecond backups from separate instances use distinct files', Boolean(aFirst) && Boolean(bSameMillisecond) && aFirst !== bSameMillisecond && fs.existsSync(aFirst))

		projectByInstance.set('instance-A', { uuid: 'project-B', friendlyName: 'same-name' })
		check('R7 changing project UUID in the same instance allows a fresh backup', Boolean(await backup('instance-A')))

		projectByInstance.set('instance-B', null)
		const missingOne = await backup('instance-B')
		const afterMissingOne = exportCalls
		const missingTwo = await backup('instance-B')
		check('R7 missing UUID never applies or records a fallback throttle key', Boolean(missingOne) && Boolean(missingTwo) && exportCalls === afterMissingOne + 1)

		projectByInstance.set('instance-A', { uuid: 'project-C', friendlyName: 'same-name' })
		switchOnExport = { instanceId: 'instance-A', identity: { uuid: 'project-D', friendlyName: 'same-name' } }
		const switchedDuringExport = await backup('instance-A')
		projectByInstance.set('instance-A', { uuid: 'project-C', friendlyName: 'same-name' })
		const projectCAgain = await backup('instance-A')
		check('R7 identity change during export does not record success against the stale project', Boolean(switchedDuringExport) && Boolean(projectCAgain))

		projectByInstance.set('instance-B', { uuid: 'project-E', friendlyName: 'same-name' })
		failNextExport = true
		const failedBackup = await backup('instance-B')
		const beforeRetry = exportCalls
		const successfulRetry = await backup('instance-B')
		check('R7 failed export does not record a successful backup time', failedBackup === null && Boolean(successfulRetry) && exportCalls === beforeRetry + 1)
	}
	finally {
		for (const file of writtenFiles)
			fs.rmSync(file, { force: true })
		const resolvedTempRoot = path.resolve(tempRoot)
		const resolvedTempBase = path.resolve(os.tmpdir())
		if (path.dirname(resolvedTempRoot) === resolvedTempBase && path.basename(resolvedTempRoot).startsWith('aicommand-r7-'))
			fs.rmSync(resolvedTempRoot, { recursive: true, force: true })
		else
			throw new Error(`refusing to recursively remove unexpected test temp path: ${resolvedTempRoot}`)
	}
}

async function main() {
	await checkMacroPartialPropagation()
	await checkBackupIdentityThrottle()
	await checkPendingPartialProtection()
	const failed = checks.filter(item => !item.passed)
	console.log(`\nRegression: ${checks.length - failed.length}/${checks.length} passed${failed.length ? `; failed: ${failed.map(item => item.name).join(', ')}` : ''}`)
	process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
