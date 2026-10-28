import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/commands/pcb.ts', import.meta.url), 'utf8')
// Compile the real command module in memory. Imports are omitted because these
// scenarios use only command-local helpers and the injected EDA/API boundary.
const runnableSource = source.replace(/^import .*$/gm, '') + `
module.exports.__setRouteSlot = value => { currentRouteJobId = value }
module.exports.__getRouteSlot = () => currentRouteJobId
module.exports.__setBaseline = (id, value) => routeJobBaselines.set(id, value)
module.exports.__getBaseline = id => routeJobBaselines.get(id)
module.exports.__setDocument = (id, value) => routeJobDocumentUuids.set(id, value)
`
const compiled = ts.transpileModule(runnableSource, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled)(() => { throw new Error('unexpected dependency') }, module, module.exports)
const { pcbCommands } = module.exports
const command = name => {
	const found = pcbCommands.find(entry => entry.name === name)
	assert.ok(found, `command ${name} exists`)
	return found
}

let layerCalls = []
globalThis.eda = {
	pcb_Layer: {
		setLayerVisible: async layers => { layerCalls.push(['visible', layers]); return true },
		setLayerInvisible: async layers => { layerCalls.push(['invisible', layers]); return true },
		lockLayer: async layers => { layerCalls.push(['lock', layers]); return true },
		unlockLayer: async layers => { layerCalls.push(['unlock', layers]); return true },
		selectLayer: async layer => { layerCalls.push(['select', layer]); return true },
	},
	pcb_Net: { getAllNetsName: async () => ['N1'] },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-guard' }) },
	pcb_PrimitiveLine: {
		create: async (net, layer, x1, y1, x2, y2, width) => {
			const id = 'line-1'
			storedLine = { id, net, layer, a: [x1, y1], b: [x2, y2], width }
			return { getState_PrimitiveId: () => id }
		},
		getAllPrimitiveId: async () => storedLine ? [storedLine.id] : [],
		get: async () => lineState(storedLine),
	},
	sys_ClientUrl: { request: async (_url, method) => {
		apiCalls.push(method)
		const payload = apiResponder(_url, method)
		return { ok: true, status: 200, json: async () => payload, text: async () => '' }
	} },
}

let storedLine
const lineState = line => ({
	getState_PrimitiveId: () => line.id,
	getState_Net: () => line.net,
	getState_Layer: () => line.layer,
	getState_StartX: () => line.a[0],
	getState_StartY: () => line.a[1],
	getState_EndX: () => line.b[0],
	getState_EndY: () => line.b[1],
	getState_LineWidth: () => line.width,
})

await command('pcb.setLayerVisible').handler({ layers: ['top-silk', 'inner1', 'custom200'], visible: true })
assert.deepEqual(layerCalls.pop(), ['visible', [3, 15, 270]])
await command('pcb.setLayerVisible').handler({ layers: ['bottom-mask'], visible: false })
assert.deepEqual(layerCalls.pop(), ['invisible', [6]])
await command('pcb.setLayerLocked').handler({ layers: ['inner2', 'document'], locked: true })
assert.deepEqual(layerCalls.pop(), ['lock', [16, 13]])
await command('pcb.selectLayer').handler({ layer: 'top-paste' })
assert.deepEqual(layerCalls.pop(), ['select', 7])
await assert.rejects(command('pcb.setLayerLocked').handler({ layers: ['not-a-layer'] }), /不认识的层/)
assert.equal(layerCalls.length, 0, 'unknown aliases do not reach the layer API')

const routed = await command('pcb.routeTrack').handler({ net: 'N1', points: [[0, 0], [100, 0]], width: 10, layer: 'inner1', _timeoutMs: 1000 })
assert.deepEqual(routed.segmentIds, ['line-1'])
assert.equal(storedLine.layer, 15, 'routeTrack handler sends inner1 as layer 15')

let apiCalls = []
let apiResponder = () => ({})
const setApiResponse = response => { apiCalls = []; apiResponder = typeof response === 'function' ? response : () => response }
for (const state of ['COMPLETED', 'CANCELLED', 'CANCELED', 'FAILED', 'ABORTED', 'ERROR']) {
	module.exports.__setRouteSlot('job-current')
	setApiResponse({ id: 'job-current', state })
	const status = await command('pcb.autoRouteStatus').handler({ jobId: 'job-current' })
	assert.equal(status.state, state)
	assert.equal(module.exports.__getRouteSlot(), undefined, `Status releases current ${state} job`)

	if (state !== 'COMPLETED') {
		module.exports.__setRouteSlot('job-current')
		setApiResponse({ id: 'job-current', state })
		const result = await command('pcb.autoRouteGetResult').handler({ jobId: 'job-current', _timeoutMs: 1000 })
		assert.equal(result.state, state)
		assert.equal(module.exports.__getRouteSlot(), undefined, `GetResult releases current ${state} job`)
	}

	module.exports.__setRouteSlot('job-current')
	setApiResponse({ state })
	await command('pcb.autoRouteStop').handler({ jobId: 'job-current' })
	assert.equal(module.exports.__getRouteSlot(), undefined, `Stop releases current ${state} job`)
}

module.exports.__setRouteSlot('job-current')
setApiResponse({ id: 'job-other', state: 'COMPLETED' })
await command('pcb.autoRouteStatus').handler({ jobId: 'job-other' })
assert.equal(module.exports.__getRouteSlot(), 'job-current', 'an unrelated terminal job does not release the active slot')

for (const response of [{ id: 'job-current', state: 'RUNNING' }, { id: 'job-current', state: 'MYSTERY' }, { state: 'COMPLETED' }]) {
	module.exports.__setRouteSlot('job-current')
	setApiResponse(response)
	await assert.rejects(command('pcb.autoRouteStart').handler({ maxPasses: 1 }), /未提交新任务/)
	assert.equal(module.exports.__getRouteSlot(), 'job-current')
	assert.equal(apiCalls.some(method => method === 'POST'), false, 'old-task guard does not issue POST')
}

module.exports.__setRouteSlot('job-current')
module.exports.__setDocument('job-current', 'pcb-guard')
const baseline = { format: 'ai-command-engine-route-baseline/v1', documentUuid: 'pcb-guard', status: 'complete', arcs: [], protectedWires: [] }
module.exports.__setBaseline('job-current', baseline)
const session = '(session )'
const encoded = Buffer.from(session, 'utf8').toString('base64')
setApiResponse((url) => url.endsWith('/output')
	? { job_id: 'job-current', data: encoded, filename: 'route.ses', format: 'SES', size: Buffer.byteLength(session) }
	: { id: 'job-current', state: 'COMPLETED' })
globalThis.parseAutoRouteSes = () => ({ wires: [], vias: [] })
const fetched = await command('pcb.autoRouteGetResult').handler({ jobId: 'job-current', _timeoutMs: 1000 })
assert.equal(fetched.fetched, true)
assert.deepEqual(fetched.routeBaseline, baseline)
assert.equal(module.exports.__getRouteSlot(), undefined, 'successful SES fetch frees the active slot')
assert.deepEqual(module.exports.__getBaseline('job-current'), baseline, 'baseline history remains mapped after slot release')

console.log('pcb-guard-regression: actual command handlers passed layer-alias and terminal-release scenarios')
