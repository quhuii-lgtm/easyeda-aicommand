import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'ace-module-commands-'))
const bundlePath = join(temp, 'module-commands.mjs')
let libraryRequests = 0
const requestPayloads = []
let backendEnvelope = { ok: true, data: { accepted: true } }
let operationRecord
globalThis.eda = {
	sys_Storage: { getExtensionUserConfig: key => key === 'module-reuse:component-replacement:operation:v1:query-op' ? JSON.stringify(operationRecord) : undefined, setExtensionUserConfig: async () => true },
	sys_ClientUrl: { request: async (_url, _method, body) => {
		libraryRequests++
		requestPayloads.push(JSON.parse(body))
		return { text: async () => JSON.stringify(backendEnvelope) }
	} },
}
try {
	const bundled = await build({
		entryPoints: [fileURLToPath(new URL('../src/commands/module.ts', import.meta.url))],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		write: false,
	})
	await writeFile(bundlePath, bundled.outputFiles[0].contents)
	const aceBundle = await import(pathToFileURL(bundlePath).href)
	const serviceBundle = await build({ entryPoints: [fileURLToPath(new URL('../src/modules/reuse/service.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
	const servicePath = join(temp, 'module-service.mjs')
	await writeFile(servicePath, serviceBundle.outputFiles[0].contents)
	const service = await import(pathToFileURL(servicePath).href)
	const registryPath = fileURLToPath(new URL('../src/engine/registry.ts', import.meta.url))
	const registryBundle = await build({ entryPoints: [registryPath], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
	const registryPathOnDisk = join(temp, 'registry.mjs')
	await writeFile(registryPathOnDisk, registryBundle.outputFiles[0].contents)
	const registry = await import(pathToFileURL(registryPathOnDisk).href)

	const commandMap = new Map(aceBundle.moduleCommands.map(command => [command.name, command]))
	assert.equal(commandMap.size, 27, 'should expose 21 module operations and six library commands')
	for (const name of ['module.getContext', 'module.placeSchematicPage', 'module.mapInstanceNets', 'module.preparePcbComposition', 'module.prepareReplacement', 'module.extractModuleArchive', 'module.librarySave', 'module.librarySearch'])
		assert.ok(commandMap.has(name), `missing ${name}`)
	assert.ok(commandMap.get('module.extractModuleArchive').params.some(param => param.name === 'workcard' && /newModule\{localId,version,name\}/.test(param.description)), 'workcard help must list the required nested fields')
	assert.ok(commandMap.get('module.preparePcbComposition').params.some(param => param.name === 'transform' && /dx,dy,rotationDegrees/.test(param.description)), 'transform help must list coordinates')
	assert.ok(commandMap.get('module.prepareReplacement').params.find(param => param.name === 'replacements').description.includes('pinMap[{oldNumber,newNumber}]'), 'replacement help must list concrete replacement member fields')
	assert.equal(aceBundle.isModuleBusinessCommand('module.getStatus'), true)
	assert.equal(aceBundle.isModuleBusinessCommand('module.setLibraryDirectory'), true)
	assert.equal(aceBundle.isModuleRecordQuery('module.getReplacementOperation'), true)
	assert.equal(aceBundle.isModuleRecordQuery('module.librarySearch'), true)
	assert.equal(aceBundle.isModuleRecordQuery('module.executeReplacement'), false)
	assert.ok(!/SHA-256/.test(commandMap.get('module.exportTemplateFile').returns), 'template export help must not promise a hash that implementation does not return')

	const sourceParams = {
		operationId: 'extract-1', projectUuid: 'project-1', captureId: 'capture-1',
		workcard: { newModule: { localId: 'sensor-front-end', version: '1.0.0', name: 'Sensor front end' } },
		libraryDirectory: 'D:/custom/module-library',
	}
	let extractCalls = 0
	let saveCalls = 0
	const extracted = { state: 'extracted', operationId: 'extract-1', fileName: 'sensor-front-end.epro2', base64: 'UEs=', sha256: 'a'.repeat(64), bytes: 3 }
	const successful = await aceBundle.runModuleExtractionWithAutoSave(sourceParams, async (_cmd, params) => {
		extractCalls++
		assert.equal(Object.hasOwn(params, 'libraryDirectory'), false, 'directory override must not be sent to legacy extraction validator')
		return extracted
	}, async params => {
		saveCalls++
		assert.equal(params.localId, 'sensor-front-end')
		assert.equal(params.version, '1.0.0')
		assert.equal(params.directory, 'D:/custom/module-library')
		return { saved: true, file: 'library/sensor-front-end.epro2' }
	})
	assert.equal(extractCalls, 1)
	assert.equal(saveCalls, 1)
	assert.equal(successful.librarySaved, true)
	assert.deepEqual(successful.library, { saved: true, file: 'library/sensor-front-end.epro2' })
	assert.equal(successful.base64, extracted.base64, 'keep the original extraction result')

	let failedSaveCalls = 0
	await assert.rejects(() => aceBundle.runModuleExtractionWithAutoSave(sourceParams, async () => extracted, async () => {
		failedSaveCalls++
		throw new Error('module library disk state unknown', { cause: { partial: true, writeAttempted: true, outcome: 'unknown' } })
	}), error => {
		assert.match(error.message, /不要重复提取/)
		assert.equal(error.cause.operationId, 'extract-1')
		assert.equal(error.cause.extractionConfirmed, true)
		assert.equal(error.cause.partial, true, 'an incomplete extraction-plus-save workflow is partial')
		assert.equal(error.cause.writeAttempted, true)
		assert.equal(error.cause.file.base64, extracted.base64)
		assert.equal(error.cause.retry.cmd, 'module.librarySave')
		assert.equal(error.cause.retry.params.localId, 'sensor-front-end')
		return true
	})
	assert.equal(failedSaveCalls, 1)

	let saveAfterFailedExtract = false
	await assert.rejects(() => aceBundle.runModuleExtractionWithAutoSave(sourceParams, async () => ({ state: 'failed', operationId: 'extract-failed' }), async () => {
		saveAfterFailedExtract = true
		return {}
	}), /未尝试保存模块库/)
	assert.equal(saveAfterFailedExtract, false, 'failed extraction must not be saved')

	assert.throws(() => service.assertWriteResult('module.executeReplacement', { status: 'unknown', operationId: 'replace-2', phase: 'pcb_create_candidate', writeAttempted: true, retryable: false }), error => {
		assert.equal(error.cause.operationId, 'replace-2')
		assert.equal(error.cause.phase, 'pcb_create_candidate')
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.writeAttempted, true)
		return true
	})
	assert.throws(() => service.assertWriteResult('module.executeReplacement', { status: 'not_started', operationId: 'replace-zero', phase: 'prepared', writeAttempted: false, error: 'first stage rejected' }), error => {
		assert.equal(error.cause.operationId, 'replace-zero')
		assert.equal(error.cause.outcome, 'not_started')
		assert.equal(error.cause.partial, false)
		assert.equal(error.cause.writeAttempted, false)
		return true
	})
	assert.doesNotThrow(() => service.assertWriteResult('module.executeReplacement', { status: 'confirmed', operationId: 'replace-ok', writeAttempted: false }))
	assert.doesNotThrow(() => service.assertWriteResult('module.getReplacementOperation', { status: 'unknown', operationId: 'replace-2', writeAttempted: true }), 'query result keeps its operation state as a normal read')

	const { setProxyPort } = await import(pathToFileURL(join(temp, 'module-commands.mjs')).href)
	setProxyPort(49720)
	const info = await commandMap.get('module.getStatus').handler({})
	assert.equal(info.integrated, true)
	assert.equal(libraryRequests, 0, 'status must not need a configured library or make a library request')
	operationRecord = { operationId: 'query-op', planId: 'plan-q', projectUuid: 'project-q', status: 'unknown', phase: 'pcb_stage', writeAttempted: true, completed: [], stageResults: [] }
	const queriedOperation = await commandMap.get('module.getReplacementOperation').handler({ operationId: 'query-op' })
	assert.equal(queriedOperation.status, 'unknown')
	assert.equal(libraryRequests, 0, 'operation queries must not require a configured library directory')
	await commandMap.get('module.setLibraryDirectory').handler({ directory: 'D:/module-library', _timeoutMs: 1000 })
	assert.equal(requestPayloads[0].action, 'setDirectory')
	assert.deepEqual(requestPayloads[0].params, { directory: 'D:/module-library' })
	await commandMap.get('module.librarySearch').handler({ query: 'sensor', limit: 3 })
	assert.deepEqual(requestPayloads[1], { action: 'search', params: { query: 'sensor', limit: 3 } })
	backendEnvelope = { ok: false, error: { message: 'directory not writable', code: 'PATH_NOT_WRITABLE', cause: { partial: false, writeAttempted: false, retryable: false } } }
	await assert.rejects(() => commandMap.get('module.librarySave').handler({ localId: 'sensor', version: '1', fileName: 'sensor.epro2', base64: 'UEs=', sha256: 'a'.repeat(64) }), error => {
		assert.equal(error.message, 'directory not writable')
		assert.equal(error.cause.partial, false, 'preserve a definite backend pre-write refusal')
		assert.equal(error.cause.writeAttempted, false)
		assert.equal(error.cause.code, 'PATH_NOT_WRITABLE')
		return true
	})
	backendEnvelope = { ok: true, data: { accepted: true } }
	assert.equal(libraryRequests, 3, 'only library commands should call the backend')

	registry.registerCommand({ name: 'test.module.partial', summary: 'test', params: [], returns: 'test', handler: async () => service.assertWriteResult('module.executeReplacement', { status: 'unknown', operationId: 'macro-op', writeAttempted: true }) })
	let followupRan = false
	registry.registerCommand({ name: 'test.module.followup', summary: 'test', params: [], returns: 'test', handler: async () => { followupRan = true; return true } })
	const macro = await registry.executeCommand({ cmd: 'macro', params: { steps: [{ cmd: 'test.module.partial' }, { cmd: 'test.module.followup' }] } })
	assert.equal(macro.ok, false, 'partial module operation must fail the ACE macro')
	assert.equal(followupRan, false, 'macro must stop before later writes after partial result')
	assert.equal(macro.error.cause.partial, true)

	console.log('module-commands-regression: 27 commands, help schemas, module error/macro handling, extraction auto-save/recovery, and library routing passed')
}
finally {
	await rm(temp, { recursive: true, force: true })
}
