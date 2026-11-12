import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { createModuleLibraryService, getModuleLibraryOriginDiagnostic, isTrustedModuleLibraryOrigin } from '../bridge/module-library.mjs'

async function temporaryDirectory(t) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'module-library-regression-'))
	t.after(() => rm(directory, { recursive: true, force: true }))
	return directory
}

function serviceAt(stateDirectory, injections = {}) {
	return createModuleLibraryService({ stateDirectory, ...injections })
}

function nativeInput(localId, version, fileName, bytes, extra = {}) {
	return {
		localId,
		version,
		fileName,
		base64: Buffer.from(bytes).toString('base64'),
		sha256: createHash('sha256').update(bytes).digest('hex'),
		...extra,
	}
}

test('info selects exactly one discovered install child without creating the directory', async (t) => {
	const root = await temporaryDirectory(t)
	const install = path.join(root, 'EDA')
	const service = serviceAt(path.join(root, 'proxy'), { detectEdaInstallPaths: async () => [install, install] })
	const result = await service.dispatch('info')
	assert.equal(result.ok, true)
	assert.equal(result.data.directory, path.join(install, 'module-library'))
	assert.equal(result.data.source, 'default')
	assert.equal(result.data.edaInstallDirectory, install)
	assert.equal(result.data.exists, false)
	await assert.rejects(stat(result.data.directory), { code: 'ENOENT' })
})

test('missing or multiple install paths require an explicit choice', async (t) => {
	const root = await temporaryDirectory(t)
	for (const paths of [[], [path.join(root, 'EDA-1'), path.join(root, 'EDA-2')]]) {
		const service = serviceAt(path.join(root, `proxy-${paths.length}`), { detectEdaInstallPaths: async () => paths })
		const result = await service.dispatch('info')
		assert.equal(result.ok, false)
		assert.equal(result.error.code, paths.length === 0 ? 'EDA_INSTALL_PATH_NOT_FOUND' : 'EDA_INSTALL_PATH_AMBIGUOUS')
		assert.match(result.error.message, /setDirectory/)
	}
})

test('explicit directory takes precedence and persists; null clears it', async (t) => {
	const root = await temporaryDirectory(t)
	const stateDirectory = path.join(root, 'proxy')
	const preferred = path.join(root, 'user-library')
	const service = serviceAt(stateDirectory, { detectEdaInstallPaths: async () => [path.join(root, 'EDA')] })
	const selected = await service.dispatch('setDirectory', { directory: preferred })
	assert.equal(selected.ok, true)
	assert.equal(selected.data.directory, preferred)
	assert.equal(selected.data.source, 'user')
	assert.equal(selected.data.exists, false)
	assert.equal(JSON.parse(await readFile(selected.data.configFile, 'utf8')).directory, preferred)
	const restarted = serviceAt(stateDirectory, { detectEdaInstallPaths: async () => [path.join(root, 'EDA')] })
	assert.equal((await restarted.dispatch('info')).data.directory, preferred)
	const reset = await restarted.dispatch('setDirectory', { directory: null })
	assert.equal(reset.ok, true)
	assert.equal(reset.data.directory, path.join(root, 'EDA', 'module-library'))
})

test('setDirectory can choose a known EDA install path for the default child', async (t) => {
	const root = await temporaryDirectory(t)
	const stateDirectory = path.join(root, 'proxy')
	const install = path.join(root, 'Known EDA')
	const service = serviceAt(stateDirectory, { platform: 'linux' })
	const chosen = await service.dispatch('setDirectory', { directory: null, edaInstallDirectory: install })
	assert.equal(chosen.ok, true)
	assert.equal(chosen.data.directory, path.join(install, 'module-library'))
	assert.equal(chosen.data.source, 'default')
	assert.equal(chosen.data.edaInstallDirectory, install)
})

test('Linux default discovery explains missing condition and does not guess cwd', async (t) => {
	const root = await temporaryDirectory(t)
	const result = await serviceAt(path.join(root, 'proxy'), { platform: 'linux' }).dispatch('info')
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'EDA_INSTALL_PATH_UNAVAILABLE')
	assert.match(result.error.message, /setDirectory/)
})

test('denied target write reports original path and error without fallback', async (t) => {
	const root = await temporaryDirectory(t)
	const target = path.join(root, 'selected-library')
	const fallback = path.join(root, 'fallback')
	const actual = { mkdir, readFile, rm, writeFile, rename, mkdtemp, stat }
	const fileSystem = {
		...actual,
		mkdir: async (value, options) => {
			if (path.resolve(value) === target) {
				const error = new Error('access denied by test')
				error.code = 'EPERM'
				throw error
			}
			return mkdir(value, options)
		},
	}
	const service = serviceAt(path.join(root, 'proxy'), { fileSystem, detectEdaInstallPaths: async () => [fallback] })
	const result = await service.dispatch('save', nativeInput('denied', '1', 'native.epro', Buffer.from('epro'), { directory: target }))
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'EPERM')
	assert.match(result.error.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
	assert.match(result.error.message, /EPERM/)
	await assert.rejects(stat(fallback), { code: 'ENOENT' })
})

test('save readback preserves bytes, retries are idempotent, and temporaries are cleaned', async (t) => {
	const root = await temporaryDirectory(t)
	const libraryDirectory = path.join(root, 'library')
	const service = serviceAt(path.join(root, 'proxy'))
	const bytes = Buffer.from([0, 1, 2, 255, 65, 66])
	const input = nativeInput('radio-module', '1.0.0', 'module.epro2', bytes, { directory: libraryDirectory, name: 'Radio module', description: 'native archive', tags: ['radio'] })
	const first = await service.dispatch('save', input)
	assert.equal(first.ok, true)
	assert.equal(first.data.created, true)
	assert.equal(first.data.files[0].role, 'native')
	const get = await service.dispatch('get', { localId: 'radio-module', version: '1.0.0', directory: libraryDirectory })
	assert.equal(get.ok, true)
	assert.deepEqual(Buffer.from(get.data.files[0].base64, 'base64'), bytes)
	assert.equal(get.data.files[0].sha256, input.sha256)
	const retry = await service.dispatch('save', input)
	assert.equal(retry.ok, true)
	assert.equal(retry.data.created, false)
	assert.equal(retry.data.alreadyExists, true)
	assert.deepEqual((await readdir(libraryDirectory)).filter(name => name.startsWith('.module-library-import-')), [])
	const list = await service.dispatch('list', { directory: libraryDirectory })
	assert.equal(list.ok, true)
	assert.equal(list.data.length, 1)
	const search = await service.dispatch('search', { query: 'radio-module', directory: libraryDirectory, limit: 1 })
	assert.equal(search.ok, true)
	assert.equal(search.data.length, 1)
})

test('same localId/version cannot replace a different native payload', async (t) => {
	const root = await temporaryDirectory(t)
	const libraryDirectory = path.join(root, 'library')
	const service = serviceAt(path.join(root, 'proxy'))
	const original = Buffer.from('original package')
	const changed = Buffer.from('different package')
	assert.equal((await service.dispatch('save', nativeInput('immutable', '2', 'module.epro', original, { directory: libraryDirectory }))).ok, true)
	const conflict = await service.dispatch('save', nativeInput('immutable', '2', 'module.epro', changed, { directory: libraryDirectory }))
	assert.equal(conflict.ok, false)
	assert.equal(conflict.error.code, 'VERSION_EXISTS')
	const saved = await service.dispatch('get', { localId: 'immutable', version: '2', directory: libraryDirectory })
	assert.deepEqual(Buffer.from(saved.data.files[0].base64, 'base64'), original)
})

test('invalid file paths and mismatched digests are rejected before writing', async (t) => {
	const root = await temporaryDirectory(t)
	const libraryDirectory = path.join(root, 'library')
	const service = serviceAt(path.join(root, 'proxy'))
	const unsafe = await service.dispatch('save', nativeInput('unsafe', '1', '../escape.epro', Buffer.from('x'), { directory: libraryDirectory }))
	assert.equal(unsafe.ok, false)
	assert.equal(unsafe.error.code, 'INVALID_FILE_NAME')
	const mismatch = await service.dispatch('save', { ...nativeInput('bad-hash', '1', 'module.epro', Buffer.from('x'), { directory: libraryDirectory }), sha256: '0'.repeat(64) })
	assert.equal(mismatch.ok, false)
	assert.equal(mismatch.error.code, 'INTEGRITY_ERROR')
	await assert.rejects(stat(libraryDirectory), { code: 'ENOENT' })
})

test('module-library origin policy trusts only no-origin and exact EDA SDK origin', () => {
	assert.equal(isTrustedModuleLibraryOrigin(undefined), true)
	assert.equal(isTrustedModuleLibraryOrigin('https://pro.lceda.cn'), true)
	assert.equal(isTrustedModuleLibraryOrigin('https://pro.lceda.cn', 49721), true)
	assert.equal(isTrustedModuleLibraryOrigin('http://127.0.0.1:49721', 49721), true)
	assert.equal(isTrustedModuleLibraryOrigin('http://localhost:49721', 49721), true)
	assert.equal(isTrustedModuleLibraryOrigin('http://127.0.0.1:49722', 49721), false)
	assert.equal(isTrustedModuleLibraryOrigin('http://localhost:49722', 49721), false)
	assert.equal(isTrustedModuleLibraryOrigin('http://127.0.0.1:49721/path', 49721), false)
	assert.equal(isTrustedModuleLibraryOrigin('http://user@127.0.0.1:49721', 49721), false)
	assert.equal(isTrustedModuleLibraryOrigin('http://127.0.0.1.evil.example:49721', 49721), false)
	assert.equal(isTrustedModuleLibraryOrigin('https://pro.lceda.cn.evil.example'), false)
	assert.equal(isTrustedModuleLibraryOrigin('https://pro.lceda.cn/'), false)
	assert.equal(isTrustedModuleLibraryOrigin('null'), false)
	assert.equal(isTrustedModuleLibraryOrigin('https://evil.example'), false)
})

test('Origin diagnostics return only a sanitized HTTP(S) origin or a safe category', () => {
	assert.deepEqual(getModuleLibraryOriginDiagnostic('https://alice:secret@attacker.example/private/path?token=hidden'), {
		receivedOrigin: 'https://attacker.example',
		receivedOriginType: 'https',
	})
	assert.deepEqual(getModuleLibraryOriginDiagnostic(undefined), { receivedOriginType: 'missing' })
	assert.deepEqual(getModuleLibraryOriginDiagnostic('null'), { receivedOriginType: 'opaque' })
	assert.deepEqual(getModuleLibraryOriginDiagnostic('not a URL'), { receivedOriginType: 'invalid' })
	assert.deepEqual(getModuleLibraryOriginDiagnostic('file:///private/path'), { receivedOriginType: 'opaque' })
})

test('HTTP module routes advertise protocol, enforce Origin on both paths, and leave reads local', async (t) => {
	const repositoryDirectory = path.resolve(import.meta.dirname, '..')
	const portServer = net.createServer()
	await new Promise((resolve, reject) => {
		portServer.once('error', reject)
		portServer.listen(0, '127.0.0.1', resolve)
	})
	const { port } = portServer.address()
	await new Promise(resolve => portServer.close(resolve))
	const child = spawn(process.execPath, ['bridge/command-proxy.mjs'], {
		cwd: repositoryDirectory,
		windowsHide: true,
		stdio: 'ignore',
		env: { ...process.env, PORT: String(port), PROXY_IDLE_MS: '0' },
	})
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill()
	})
	const endpoint = `http://127.0.0.1:${port}`
	let health
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			health = await fetch(`${endpoint}/health`).then(response => response.json())
			break
		}
		catch {
			await new Promise(resolve => setTimeout(resolve, 100))
		}
	}
	assert.equal(health?.moduleLibraryProtocol, 1)

	const readParams = { directory: path.join(os.tmpdir(), `module-library-nonexistent-${process.pid}`) }
	const listResponse = await fetch(`${endpoint}/module-library`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action: 'list', params: readParams }),
	})
	assert.equal(listResponse.status, 200)
	assert.deepEqual(await listResponse.json(), { ok: true, data: [] })
	for (const host of ['127.0.0.1', 'localhost']) {
		const loopback = await fetch(`${endpoint}/module-library`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: `http://${host}:${port}` },
			body: JSON.stringify({ action: 'list', params: readParams }),
		})
		assert.equal(loopback.status, 200)
		assert.deepEqual(await loopback.json(), { ok: true, data: [] })
	}
	const wrongLoopbackPort = await fetch(`${endpoint}/module-library`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}` },
		body: JSON.stringify({ action: 'list', params: readParams }),
	})
	assert.equal(wrongLoopbackPort.status, 403)
	assert.equal((await wrongLoopbackPort.json()).error.code, 'ORIGIN_NOT_ALLOWED')

	const unsafeOrigin = 'https://alice:secret@attacker.example/private/path?token=hidden'
	const rejectedLibrary = await fetch(`${endpoint}/module-library`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: unsafeOrigin },
		body: JSON.stringify({ action: 'list', params: readParams }),
	})
	assert.equal(rejectedLibrary.status, 403)
	const rejectedLibraryBody = await rejectedLibrary.json()
	assert.equal(rejectedLibraryBody.error.code, 'ORIGIN_NOT_ALLOWED')
	assert.deepEqual(rejectedLibraryBody.error.cause, {
		receivedOrigin: 'https://attacker.example',
		receivedOriginType: 'https',
		partial: false,
		writeAttempted: false,
		outcome: 'not_started',
	})
	assert.equal(JSON.stringify(rejectedLibraryBody).includes('secret'), false)
	assert.equal(JSON.stringify(rejectedLibraryBody).includes('/private/path'), false)
	assert.equal(JSON.stringify(rejectedLibraryBody).includes('token=hidden'), false)

	const rejectedPreflight = await fetch(`${endpoint}/module-library`, {
		method: 'OPTIONS',
		headers: { Origin: unsafeOrigin, 'Access-Control-Request-Method': 'POST' },
	})
	assert.equal(rejectedPreflight.status, 403)
	const rejectedPreflightBody = await rejectedPreflight.json()
	assert.deepEqual(rejectedPreflightBody.error.cause, rejectedLibraryBody.error.cause)

	const rejectedCommand = await fetch(`${endpoint}/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: unsafeOrigin },
		body: JSON.stringify({ cmd: 'macro', params: { steps: [{ cmd: 'module.librarySave', params: {} }] } }),
	})
	assert.equal(rejectedCommand.status, 403)
	const rejectedCommandBody = await rejectedCommand.json()
	assert.equal(rejectedCommandBody.error.code, 'ORIGIN_NOT_ALLOWED')
	assert.deepEqual(rejectedCommandBody.error.cause, rejectedLibraryBody.error.cause)
	for (const command of [
		{ cmd: 'macro', params: { steps: [{ cmd: 'module.librarySave', params: {} }] } },
		{ cmd: 'macro', params: { steps: [{ cmd: 'schematic.get' }, { cmd: 'macro', params: { steps: [{ cmd: 'module.libraryGet', params: {} }] } }] } },
	]) {
		const nested = await fetch(`${endpoint}/command`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
			body: JSON.stringify(command),
		})
		assert.equal(nested.status, 403)
		assert.equal((await nested.json()).error.code, 'ORIGIN_NOT_ALLOWED')
	}

	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
	t.after(() => socket.close())
	await new Promise((resolve, reject) => {
		socket.once('open', resolve)
		socket.once('error', reject)
	})
	socket.send(JSON.stringify({ type: 'hello', instanceId: 'module-library-test', extension: 'test', version: '0.0.0' }))
	const received = []
	socket.on('message', raw => {
		const message = JSON.parse(raw.toString())
		if (message.type === 'command')
			received.push(message)
	})
	const waitForCommands = async (count) => {
		for (let attempt = 0; attempt < 50 && received.length < count; attempt++)
			await new Promise(resolve => setTimeout(resolve, 20))
		assert.ok(received.length >= count, `expected ${count} proxied commands, got ${received.length}`)
	}
	const sendCommand = (cmd) => fetch(`${endpoint}/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: 'https://pro.lceda.cn' },
		body: JSON.stringify({ cmd, instanceId: 'module-library-test', params: readParams }),
	})
	const writeResponse = sendCommand('module.testWrite')
	const queryResponse = sendCommand('module.libraryList')
	await waitForCommands(2)
	assert.deepEqual(received.map(message => message.cmd).sort(), ['module.libraryList', 'module.testWrite'])
	for (const command of received)
		socket.send(JSON.stringify({ type: 'result', id: command.id, result: { ok: true, cmd: command.cmd, data: [] } }))
	assert.equal((await writeResponse).status, 200)
	assert.equal((await queryResponse).status, 200)

	const beforeOrdinaryMacro = received.length
	const ordinaryMacro = fetch(`${endpoint}/command`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
		body: JSON.stringify({ cmd: 'macro', instanceId: 'module-library-test', params: { steps: [{ cmd: 'schematic.get' }] } }),
	})
	await waitForCommands(beforeOrdinaryMacro + 1)
	const macroCommand = received.at(-1)
	assert.equal(macroCommand.cmd, 'macro')
	socket.send(JSON.stringify({ type: 'result', id: macroCommand.id, result: { ok: true, cmd: 'macro' } }))
	assert.equal((await ordinaryMacro).status, 200)
})

