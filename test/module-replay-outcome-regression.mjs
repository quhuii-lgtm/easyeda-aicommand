import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const storage = new Map()
globalThis.eda = {
	sys_Storage: {
		getExtensionUserConfig: key => storage.get(key),
		setExtensionUserConfig: async (key, value) => { storage.set(key, value); return true },
	},
	dmt_Project: { getCurrentProjectInfo: async () => { throw new Error('stored replay must not read or write the host project') } },
}
const temp = await mkdtemp(join(tmpdir(), 'ace-module-replay-outcome-'))
try {
	const serviceOutput = await build({
		entryPoints: [fileURLToPath(new URL('../src/modules/reuse/service.ts', import.meta.url))],
		bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false,
	})
	const servicePath = join(temp, 'module-service.mjs')
	await writeFile(servicePath, serviceOutput.outputFiles[0].contents)
	const service = await import(pathToFileURL(servicePath).href)

	const registryOutput = await build({
		entryPoints: [fileURLToPath(new URL('../src/engine/registry.ts', import.meta.url))],
		bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false,
	})
	const registryPath = join(temp, 'registry.mjs')
	await writeFile(registryPath, registryOutput.outputFiles[0].contents)
	const registry = await import(pathToFileURL(registryPath).href)

	// This matches nativePlacement.operationData(): it contains `outcome`, with
	// no `status` or `state` member.
	for (const command of ['module.mapInstanceNets', 'module.placeSchematicPage', 'module.alignTemplatePcb']) {
		const replay = { operationId: `replay-${command}`, outcome: 'unknown', phase: 'write_started' }
		assert.throws(() => service.assertWriteResult(command, replay), error => {
			assert.equal(error.cause.outcome, 'unknown')
			assert.equal(error.cause.partial, true)
			assert.equal(error.cause.operationId, replay.operationId)
			return true
		}, `${command} must reject a persisted unknown replay`)
	}
	for (const [command, confirmedOutcome] of [
		['module.placeSchematicPage', 'placed'],
		['module.alignTemplatePcb', 'reference-aligned'],
		['module.mapInstanceNets', 'mapped'],
	]) {
		assert.doesNotThrow(() => service.assertWriteResult(command, { outcome: confirmedOutcome }),
			`${command} accepts its confirmed stored outcome ${confirmedOutcome}`)
		assert.throws(() => service.assertWriteResult(command, { outcome: 'pending-verification', phase: 'readback' }), error => {
			assert.equal(error.cause.outcome, 'pending-verification')
			assert.equal(error.cause.partial, true)
			return true
		}, `${command} treats pending verification as partial`)
		for (const outcome of ['failed', 'not_started']) {
			for (const writeAttempted of [false, true]) {
				assert.throws(() => service.assertWriteResult(command, { outcome, writeAttempted }), error => {
					assert.equal(error.cause.outcome, outcome)
					assert.equal(error.cause.writeAttempted, writeAttempted)
					assert.equal(error.cause.partial, writeAttempted)
					return true
				}, `${command} ${outcome} with writeAttempted=${writeAttempted} preserves partial semantics`)
			}
		}
	}

	assert.throws(() => service.assertWriteResult('module.placeSchematicPage', {
		status: 'confirmed', outcome: 'unknown', operationId: 'conflicting-replay',
	}), error => error.cause.outcome === 'unknown' && error.cause.partial === true,
	'unknown must take precedence over a contradictory confirmed status')

	assert.doesNotThrow(() => service.assertWriteResult('module.placeSchematicPage', {
		operationId: 'confirmed-replay', outcome: 'confirmed', phase: 'readback-confirmed',
	}), 'a confirmed business replay remains successful')

	const query = { operationId: 'query-unknown', outcome: 'unknown', phase: 'write_started' }
	assert.doesNotThrow(() => service.assertWriteResult('module.getPlacementOperation', query),
		'explicit operation queries return unknown records as read data')

	// Exercise the actual business route and nativePlacement storage replay. The
	// hostile project getter proves a matching cached record returns before EDA
	// host access; assertWriteResult then turns that outcome into an ACE error.
	const routeArgs = {
		operationId: 'routed-unknown-replay', cbbUuid: 'cbb-1', libraryUuid: 'library-1',
		sourceSchematicUuid: 'source-sch-1', sourcePcbUuid: 'source-pcb-1', targetProjectUuid: 'target-project-1',
		targetSchematicUuid: 'target-sch-1', targetSchematicPageUuid: 'target-page-1', targetPcbUuid: 'target-pcb-1',
		x: 0, y: 0, reimportWhenNameRepeated: false,
	}
	const placementKey = 'module-reuse:native-placement:v1'
	storage.set(placementKey, JSON.stringify({ schema: 1, operations: {
		[routeArgs.operationId]: { operation: 'placeSchematicPage', operationId: routeArgs.operationId,
			targetProjectUuid: routeArgs.targetProjectUuid, args: routeArgs, outcome: 'unknown', phase: 'placement_write_started' },
	} }))
	await assert.rejects(() => service.executeModuleOperation('module.placeSchematicPage', routeArgs), error => {
		assert.equal(error.cause.outcome, 'unknown')
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.operationId, routeArgs.operationId)
		return true
	}, 'executeModuleOperation routes through native placement storage replay and rejects its unknown outcome')
	const routedQuery = await service.executeModuleOperation('module.getPlacementOperation', {
		operationId: routeArgs.operationId, targetProjectUuid: routeArgs.targetProjectUuid,
	})
	assert.equal(routedQuery.outcome, 'unknown', 'the explicit query route keeps unknown operation data readable')

	let laterWriteRan = false
	registry.registerCommand({
		name: 'test.module.replayUnknown', summary: 'test', params: [], returns: 'test',
		handler: async () => service.assertWriteResult('module.mapInstanceNets', {
			operationId: 'macro-replay', outcome: 'unknown', phase: 'write_started',
		}),
	})
	registry.registerCommand({
		name: 'test.module.followupWrite', summary: 'test', params: [], returns: 'test',
		handler: async () => { laterWriteRan = true; return true },
	})
	const macro = await registry.executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
		{ cmd: 'test.module.replayUnknown' }, { cmd: 'test.module.followupWrite' },
	] } })
	assert.equal(macro.ok, false, 'macro reports the unknown business replay as failed')
	assert.equal(macro.data.stoppedReason, 'partial', 'unknown replay stops the macro as partial')
	assert.equal(laterWriteRan, false, 'macro skips dependent writes after an unknown replay')

	console.log('module-replay-outcome-regression: unknown replay, conflicting states, confirmed replay, query result and macro stop passed')
}
finally {
	await rm(temp, { recursive: true, force: true })
}
