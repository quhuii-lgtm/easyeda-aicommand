import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { pcbCommands } from '../src/commands/pcb.ts'
import { listTasks } from '../src/engine/tasks.ts'
export { pcbCommands, listTasks }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-input-validation-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands, listTasks } = await import(moduleUrl)
const command = name => pcbCommands.find(item => item.name === name)

{
	const before = listTasks().length
	await assert.rejects(() => command('pcb.delete').handler({ primitiveIds: [] }, {}), /primitiveIds 不能为空/)
	await assert.rejects(() => command('pcb.delete').handler({ primitiveIds: ['  '] }, {}), /primitiveIds 不能为空/)
	assert.equal(listTasks().length, before, 'empty delete requests must be rejected before task registration')
}

{
	const calls = []
	let netClassResult = true
	let equalLengthResult = true
	globalThis.eda = { pcb_Drc: {
		createNetClass: async (...args) => { calls.push(['netClass', ...args]); return netClassResult },
		createEqualLengthNetGroup: async (...args) => { calls.push(['equalLength', ...args]); return equalLengthResult },
	}, pcb_Net: { getAllNetsName: async () => ['D0', 'D1'] } }
	await command('pcb.createNetClass').handler({ name: 'POWER', nets: ['D0'], color: '#f08' }, {})
	await command('pcb.createNetClass').handler({ name: 'POWER2', nets: ['D0'], color: '#10203080' }, {})
	await command('pcb.createEqualLengthGroup').handler({ name: 'DDR', nets: ['D0', 'D1'], color: '#1234' }, {})
	assert.deepEqual(calls, [
		['netClass', 'POWER', ['D0'], { r: 255, g: 0, b: 136, alpha: 1 }],
		['netClass', 'POWER2', ['D0'], { r: 16, g: 32, b: 48, alpha: 128 / 255 }],
		['equalLength', 'DDR', ['D0', 'D1'], { r: 17, g: 34, b: 51, alpha: 68 / 255 }],
	])
	await assert.rejects(() => command('pcb.createNetClass').handler({ name: 'BAD', nets: ['D0'], color: 'red' }, {}), /颜色格式无效/)
	netClassResult = false
	await assert.rejects(() => command('pcb.createNetClass').handler({ name: 'FALSE', nets: ['D0'] }, {}), /官方接口返回 false/)
	equalLengthResult = false
	await assert.rejects(() => command('pcb.createEqualLengthGroup').handler({ name: 'FALSE', nets: ['D0'] }, {}), /官方接口返回 false/)
}

{
	let importCalls = 0
	globalThis.eda = { pcb_Document: { importAutoRouteSesFile: async () => { importCalls++; return true } } }
	for (const base64 of ['%', '', Buffer.from('not ses').toString('base64')])
		await assert.rejects(() => command('pcb.importAutoRouteSes').handler({ base64 }, {}), /base64|SES session/)
	assert.equal(importCalls, 0, 'invalid base64 and non-SES content must be rejected before the SDK call')
	await assert.rejects(() => command('pcb.importAutoRouteSes').handler({ base64: Buffer.from('(session\n)').toString('base64') }, {}))
	assert.equal(importCalls, 0, 'empty SES geometry must be rejected before any SDK write')
}

{
	const setTypes = []
	let setTypeResult = true
	globalThis.eda = { pcb_Layer: { setPcbType: async type => { setTypes.push(type); return setTypeResult } } }
	assert.deepEqual(await command('pcb.setPcbType').handler({ pcbType: 'normal' }, {}), { done: true })
	assert.deepEqual(await command('pcb.setPcbType').handler({ pcbType: 'FPC' }, {}), { done: true })
	assert.deepEqual(setTypes, [1, 2], 'SDK plate type enum values are NORMAL=1 and FPC=2')
	setTypeResult = false
	await assert.rejects(() => command('pcb.setPcbType').handler({ pcbType: 'normal' }, {}), /官方接口返回 false/)
	await assert.rejects(() => command('pcb.setPcbType').handler({ pcbType: 'flexible' }, {}), /仅支持 normal \| fpc/)
	assert.deepEqual(setTypes, [1, 2, 1], 'invalid board type must not reach the SDK')
}

{
	const copperLayerCalls = []
	let setResult = true
	globalThis.eda = { pcb_Layer: {
		setTheNumberOfCopperLayers: async count => { copperLayerCalls.push(count); return setResult },
	} }
	const setCopperLayers = command('pcb.setCopperLayers')
	for (const params of [{}, { count: null }, { count: '2' }, { count: 2.5 }, { count: -1 }, { count: 1 }, { count: 3 }, { count: 33 }, { count: 34 }, { count: Number.NaN }, { count: Number.POSITIVE_INFINITY }, { count: Number.NEGATIVE_INFINITY }])
		await assert.rejects(() => setCopperLayers.handler(params, {}), /count/)
	assert.deepEqual(copperLayerCalls, [], 'invalid copper layer counts must be rejected before the SDK call')
	for (const count of [2, 4, 6, 32]) {
		assert.deepEqual(await setCopperLayers.handler({ count }, {}), { set: true })
	}
	assert.deepEqual(copperLayerCalls, [2, 4, 6, 32], 'valid even copper layer counts must pass through unchanged')
	setResult = false
	assert.deepEqual(await setCopperLayers.handler({ count: 2 }, {}), { set: false }, 'valid SDK return semantics must remain unchanged')
	assert.deepEqual(copperLayerCalls, [2, 4, 6, 32, 2])
}

{
	const calls = []
	const file = new Blob(['pnp'])
	Object.defineProperty(file, 'name', { value: 'placement.csv' })
	globalThis.eda = { pcb_ManufactureData: {
		getPickAndPlaceFile: async (...args) => { calls.push(args); return file },
	} }
	await command('pcb.exportPickPlace').handler({ fileType: 'CSV', unit: 'mil' }, {})
	assert.deepEqual(calls, [[undefined, 'csv', 'mil']])
	for (const params of [{ fileType: 'pdf' }, { unit: 'inch' }])
		await assert.rejects(() => command('pcb.exportPickPlace').handler(params, {}), /无效 (fileType|unit)/)
	assert.deepEqual(calls, [[undefined, 'csv', 'mil']], 'unsupported file types and units must be rejected before export')
}

{
	let componentReads = 0
	globalThis.eda = { pcb_PrimitiveComponent: { getAll: async () => { componentReads++; return [] } } }
	for (const minClearance of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'invalid'])
		await assert.rejects(() => command('pcb.checkPlacement').handler({ minClearance }, {}), /minClearance/)
	assert.equal(componentReads, 0, 'invalid clearance must be rejected before reading PCB components')
	const zeroClearance = await command('pcb.checkPlacement').handler({ minClearance: 0 }, {})
	assert.equal(zeroClearance.complete, true)
	assert.equal(componentReads, 1, 'zero clearance remains valid')
}

{
	const calls = []
	globalThis.eda = { pcb_Document: {
		getPrimitiveAtPoint: async (x, y) => { calls.push(['point', x, y]); return undefined },
		getPrimitivesInRegion: async (...bounds) => { calls.push(['region', ...bounds]); return [] },
	} }
	for (const [x, y] of [[Number.NaN, 0], [0, Number.POSITIVE_INFINITY], ['invalid', 0]])
		await assert.rejects(() => command('pcb.getPrimitiveAtPoint').handler({ x, y }, {}), /有限数字/)
	await assert.rejects(() => command('pcb.getPrimitivesInRegion').handler({ left: 0, right: 10, top: 'invalid', bottom: -10 }, {}), /有限数字/)
	await command('pcb.getPrimitivesInRegion').handler({ left: 0, right: 10, top: 0, bottom: -10 }, {})
	assert.deepEqual(calls, [['region', 0, 10, 0, -10]], 'invalid coordinates must be rejected before SDK calls and zero remains valid')
	await command('pcb.getPrimitiveAtPoint').handler({ x: 0, y: 0 }, {})
	assert.deepEqual(calls.at(-1), ['point', 0, 0], 'zero point coordinates remain valid')
}

function installFreerouting({ jobState = 'READY_TO_START', jobStates, failJobStateReadAt, documentUuid = 'pcb-A' } = {}) {
	const calls = []
	let jobStateReads = 0
	let activeUuid = documentUuid
	const storage = new Map()
	const dsnFile = new Blob(['dsn'])
	Object.defineProperty(dsnFile, 'name', { value: 'design.dsn' })
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: activeUuid }) },
		sys_FileManager: {
			getDocumentSource: async () => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid: activeUuid })}|`,
		},
		sys_Storage: {
			setExtensionUserConfig: async (key, value) => { storage.set(key, value); return true },
			getExtensionUserConfig: key => storage.get(key),
		},
		pcb_ManufactureData: { getDsnFile: async () => dsnFile },
		pcb_PrimitiveLine: { getAllPrimitiveId: async () => [] },
		pcb_PrimitiveVia: { getAllPrimitiveId: async () => [] },
		pcb_PrimitiveArc: { getAllPrimitiveId: async () => [] },
		pcb_Document: {
			startCalculatingRatline: async () => true,
			importAutoRouteSesFile: async file => { calls.push({ type: 'ses-import', fileName: file.name }); return true },
		},
		pcb_Drc: { check: async () => [] },
		sys_ClientUrl: {
			request: async (url, method, body) => {
				calls.push({ url, method, body })
				if (method === 'GET' && url.endsWith('/jobs/job-A')) {
					jobStateReads++
					if (jobStateReads === failJobStateReadAt)
						throw new Error('injected status read failure')
				}
				return {
					ok: true,
					status: 200,
					json: async () => {
						if (url.endsWith('/jobs/job-A')) return { state: jobStates && jobStateReads <= jobStates.length ? jobStates[jobStateReads - 1] : jobState }
						if (url.endsWith('/jobs/job-A/output')) return { data: Buffer.from('(session\n)').toString('base64'), filename: 'route.ses' }
						if (url.endsWith('/sessions/create')) return { id: 'session-A' }
						if (url.endsWith('/jobs/enqueue')) return { id: 'job-A' }
						return {}
					},
				}
			},
		},
	}
	calls.setFocus = uuid => { activeUuid = uuid }
	return calls
}

{
	for (const maxPasses of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'invalid']) {
		const calls = installFreerouting()
		await assert.rejects(() => command('pcb.autoRouteStart').handler({ maxPasses }, {}), /maxPasses 必须是大于 0 的有限整数/)
		assert.equal(calls.length, 0, `invalid maxPasses ${String(maxPasses)} must be rejected before any API request`)
	}
	const calls = installFreerouting({ jobState: 'COMPLETED' })
	const stopped = await command('pcb.autoRouteStop').handler({ jobId: 'job-A' }, {})
	assert.deepEqual(stopped, { cancelled: false, jobId: 'job-A', state: 'COMPLETED', note: '任务已结束，无需取消' })
	assert.equal(calls.some(call => call.method === 'PUT'), false, 'completed tasks must not receive a cancellation request')
	assert.equal(calls.filter(call => call.method === 'GET').length, 1, 'stop must read task state before cancellation')
}

{
	const calls = installFreerouting({ jobState: 'FAILED' })
	await command('pcb.autoRouteStart').handler({}, {})
	const stopped = await command('pcb.autoRouteStop').handler({}, {})
	assert.deepEqual(stopped, { cancelled: false, jobId: 'job-A', state: 'FAILED', note: '任务已结束，无需取消' })
	assert.equal(calls.some(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/cancel')), false)
	const restarted = await command('pcb.autoRouteStart').handler({}, {})
	assert.equal(restarted.jobId, 'job-A', 'confirmed FAILED state must release the prior default job ID')
	assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/jobs/enqueue')).length, 2)
}

{
	const calls = installFreerouting({ jobStates: ['RUNNING', 'CANCELLED'] })
	const stopped = await command('pcb.autoRouteStop').handler({}, {})
	assert.deepEqual(stopped, { cancelled: true, jobId: 'job-A', state: 'CANCELLED' })
	assert.equal(calls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/cancel')).length, 1)
	await assert.rejects(() => command('pcb.autoRouteStop').handler({}, {}), /没有进行中的布线任务/)
}

{
	const calls = installFreerouting({ jobStates: ['RUNNING', 'RUNNING', 'RUNNING'] })
	await command('pcb.autoRouteStart').handler({}, {})
	const stopped = await command('pcb.autoRouteStop').handler({}, {})
	assert.equal(stopped.cancelled, false)
	assert.equal(stopped.jobId, 'job-A')
	assert.equal(stopped.state, 'RUNNING')
	assert.equal(stopped.outcome, 'cancel-request-pending')
	assert.equal(calls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/cancel')).length, 1, 'a successful cancel request must not be retried automatically')
	const stillTracked = await command('pcb.autoRouteStatus').handler({ noImport: true }, {})
	assert.equal(stillTracked.jobId, 'job-A', 'an unconfirmed cancellation must retain the default job ID')
}

{
	const calls = installFreerouting({ jobStates: [''] })
	const result = await command('pcb.autoRouteStop').handler({}, {})
	assert.equal(result.cancelled, false)
	assert.equal(result.outcome, 'cancel-not-sent')
	assert.equal(calls.some(call => call.method === 'PUT'), false, 'unknown pre-cancel status must not trigger a write')
	const stillTracked = await command('pcb.autoRouteStatus').handler({ noImport: true }, {})
	assert.equal(stillTracked.jobId, 'job-A', 'unknown pre-cancel status must preserve the default job ID')
}

{
	const calls = installFreerouting({ jobStates: ['RUNNING', 'RUNNING', 'RUNNING'], failJobStateReadAt: 2 })
	const result = await command('pcb.autoRouteStop').handler({}, {})
	assert.equal(result.cancelled, false)
	assert.equal(result.outcome, 'cancel-request-unknown')
	assert.match(result.note, /无法确认任务状态/)
	assert.equal(calls.filter(call => call.method === 'PUT' && call.url.endsWith('/jobs/job-A/cancel')).length, 1)
	const stillTracked = await command('pcb.autoRouteStatus').handler({ noImport: true }, {})
	assert.equal(stillTracked.jobId, 'job-A', 'post-cancel read failure must preserve the default job ID')
}

{
	const calls = installFreerouting({ jobState: 'COMPLETED', jobStates: ['COMPLETED'] })
	const stopResult = await command('pcb.autoRouteStop').handler({}, {})
	assert.equal(stopResult.cancelled, false)
	await assert.rejects(() => command('pcb.autoRouteStatus').handler({ noImport: true }, {}), /没有进行中的布线任务/)
	const completed = await command('pcb.autoRouteStatus').handler({ jobId: 'job-A', noImport: true }, {})
	assert.equal(completed.jobId, 'job-A', 'COMPLETED stop releases only the default slot; explicit old ID remains queryable')
	assert.equal(completed.state, 'COMPLETED')
	assert.equal(calls.some(call => call.method === 'PUT'), false)
}

{
	globalThis.eda = { pcb_PrimitiveComponent: {
		getAll: async () => [{ getState_Designator: () => 'USB1', getState_PrimitiveId: () => 'usb-polygon', getState_Layer: () => 1 }],
		getAllPinsByPrimitiveId: async () => [{ getState_X: () => 100, getState_Y: () => 200, getState_Rotation: () => 0, getState_Pad: () => ['POLYGON', [0, 0, 20, 0, 20, 10, 0, 10]] }],
	} }
	assert.match(command('pcb.checkPlacement').returns, /skippedUnsupported\?: \[\{ designator, primitiveId, padIndex, reason \}\]/)
	const result = await command('pcb.checkPlacement').handler({})
	assert.equal(result.complete, false)
	assert.deepEqual(result.skippedUnsupported.map(x => ({ designator: x.designator, primitiveId: x.primitiveId, padIndex: x.padIndex })), [{ designator: 'USB1', primitiveId: 'usb-polygon', padIndex: 1 }])
	assert.deepEqual(result.skippedUnsupported[0], { designator: 'USB1', primitiveId: 'usb-polygon', padIndex: 1, reason: 'pad 1 形状 POLYGON 当前未支持；未纳入间距检查' })
}
console.log('PASS PCB input validation, conversions, export options, polygon skip identity, and confirmed auto-route cancellation')
