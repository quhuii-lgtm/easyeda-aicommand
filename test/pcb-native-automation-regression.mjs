import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fs.readFileSync(new URL('../src/commands/pcbNativeAutomation.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const comparatorBundle = buildSync({ entryPoints: [fileURLToPath(new URL('../src/engine/documentRecovery.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', write: false })
const comparatorModule = { exports: {} }
new Function('exports', 'require', 'module', comparatorBundle.outputFiles[0].text)(comparatorModule.exports, () => { throw new Error('Unexpected external comparator import') }, comparatorModule)
const { compareDocumentSources } = comparatorModule.exports

function setup() {
	let doc = { documentType: 3, uuid: 'pcb-1', tabId: 'tab-1' }
	let sdkWrites = 0
	let calls = { layout: 0, route: 0 }
	const intervals = new Map()
	const progress = []
	let intervalId = 0
	let rows = [
		{ header: { type: 'DOCHEAD' }, data: { docType: 'PCB', uuid: 'pcb-1' } },
		{ header: { type: 'RULE', id: 'r1' }, data: { width: 10 } },
		{ header: { type: 'LINE', id: 'line1' }, data: { net: 'A', x1: 1 } },
	]
	let components = [
		{ id: 'movable', ref: 'R1', x: 1, locked: false },
		{ id: 'locked', ref: 'U1', x: 2, locked: true },
	]
	let layoutResult = { success: true, totalComponentsCount: 0, successComponentsCount: 1, failedComponents: ['locked'], duration: 4 }
	let routeResult = { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 4 }
	let failReadback = false
	const obj = c => { const { id, ref, x, locked } = c; return { getState_PrimitiveId: () => id, getState_Designator: () => ref, getState_X: () => x, getState_Y: () => 0, getState_Rotation: () => 0, getState_PrimitiveLock: () => locked } }
	const eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ ...doc }) },
		sys_FileManager: { getDocumentSource: async () => { if (failReadback && calls.layout + calls.route) throw new Error('readback failed'); return rows.map(r => `${JSON.stringify(r.header)}||${JSON.stringify(r.data)}|`).join('\n') } },
		pcb_PrimitiveComponent: { getAll: async () => components.map(obj) },
		pcb_Document: {
			autoLayout: async () => { calls.layout++; sdkWrites++; components[0].x = 9; return layoutResult },
			autoRouting: async props => { calls.route++; sdkWrites++; assert.equal(props.existingPrimitiveMode, 'keep'); assert.deepEqual(props.RoutingNets, ['A']); rows.push({ header: { type: 'LINE', id: 'line2' }, data: { netName: 'A' } }); return routeResult },
		},
	}
	const taskApi = { beginTask: (_cmd, _params, onUpdate) => ({ task: { id: 'task-1', state: 'running', progress: {}, onUpdate }, existing: false }), failTask() {}, finishTask() {}, taskProgress(task, patch) { Object.assign(task.progress, patch); task.onUpdate?.(task) } }
	const sourceLog = {
		parseSourceLog(text) { return { ...JSON.parse(text.split('\n').map(x => x.slice(x.indexOf('||') + 2, -1))[0]), docType: 'PCB', uuid: 'pcb-1', records: text.split('\n').map(line => { const i = line.indexOf('||'); return { header: JSON.parse(line.slice(0, i)), data: JSON.parse(line.slice(i + 2, -1)) } }) } },
		resolveRecords(parsed) { return new Map(parsed.records.filter(r => r.header.type !== 'DOCHEAD').map(r => [`${r.header.type}\0${r.header.id}`, r])) },
	}
	const context = { exports: {}, require(name) { if (name === '../engine/tasks') return taskApi; if (name === '../pcb/sourcelog') return sourceLog; if (name === '../engine/documentRecovery') return { compareDocumentSources }; throw new Error(name) }, get eda() { return eda }, setInterval(fn, ms) { const id = ++intervalId; intervals.set(id, { fn, ms, cleared: false }); return id }, clearInterval(id) { if (intervals.has(id)) intervals.get(id).cleared = true }, Date, Error, Map, Set, JSON, String, Boolean, Array }
	vm.runInNewContext(code, context)
	const ctx = { vars: {}, documentTarget: { documentType: 3, uuid: 'pcb-1', tabId: 'tab-1' }, onProgress: p => progress.push(p), assertDocumentTarget: async () => { if (doc.uuid !== 'pcb-1') throw new Error('target changed') } }
	return { commands: context.exports.pcbNativeAutomationCommands, ctx, calls, progress, intervals, get sdkWrites() { return sdkWrites }, eda, setFailReadback(v) { failReadback = v }, setRows(v) { rows = v }, setDoc(v) { doc = v }, setLayoutResult(v) { layoutResult = v }, setRouteResult(v) { routeResult = v } }
}

const env = setup()
const [layout, route] = env.commands
assert.equal((await layout.handler({}, env.ctx)).dryRun, true)
assert.equal((await route.handler({}, env.ctx)).dryRun, true)
assert.equal(env.sdkWrites, 0, 'default dryRun must not call SDK')
await assert.rejects(() => route.handler({ typo: true, dryRun: false }, env.ctx), /未知参数/)
await assert.rejects(() => layout.handler({ dryRun: false }, env.ctx), /allowRoutedMovement:true/)
assert.equal(env.sdkWrites, 0, 'parameter rejection must happen before SDK')

const layoutResult = await layout.handler({ dryRun: false, allowRoutedMovement: true }, env.ctx)
assert.deepEqual(Array.from(layoutResult.moved), ['R1'])
assert.deepEqual(Array.from(layoutResult.skippedLocked), ['U1'])
assert.equal(layoutResult.actualTotal, 2)
assert.equal(layoutResult.rawResult.totalComponentsCount, 0)
assert.deepEqual(Array.from(layoutResult.rawResult.failedComponents), ['locked'])
assert.equal(layoutResult.connectivityPreserved, 'unverified')

const routed = await route.handler({ dryRun: false, RoutingNets: ['A'] }, env.ctx)
assert.equal(routed.existingPrimitiveMode, 'keep')
assert.equal(routed.existingRoutingPreserved, 'verified')
assert.equal(routed.routingBefore.total, 1)
assert.deepEqual(Array.from(routed.addedRoutingRecords, x => x.netName), ['A'])
assert.equal(routed.routingScopeVerified, true)

const allUnrouted = setup()
allUnrouted.eda.pcb_Document.autoRouting = async props => {
	assert.deepEqual(props.RoutingNets, [])
	allUnrouted.calls.route++
	allUnrouted.setRows([
		{ header: { type: 'DOCHEAD' }, data: { docType: 'PCB', uuid: 'pcb-1' } },
		{ header: { type: 'RULE', id: 'r1' }, data: { width: 10 } },
		{ header: { type: 'LINE', id: 'line1' }, data: { net: 'A', x1: 1 } },
		{ header: { type: 'LINE', id: 'line2' }, data: { netName: 'A' } },
	])
	return { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 1 }
}
assert.equal((await allUnrouted.commands[1].handler({ dryRun: false, RoutingNets: [] }, allUnrouted.ctx)).routingScopeVerified, true, 'the SDK defines an empty network array as all unrouted nets')

const wrongNet = setup()
wrongNet.eda.pcb_Document.autoRouting = async () => { wrongNet.calls.route++; wrongNet.setRows([
	{ header: { type: 'DOCHEAD' }, data: { docType: 'PCB', uuid: 'pcb-1' } },
	{ header: { type: 'RULE', id: 'r1' }, data: { width: 10 } },
	{ header: { type: 'LINE', id: 'line1' }, data: { net: 'A', x1: 1 } },
	{ header: { type: 'LINE', id: 'wrong' }, data: { netName: 'B' } },
	]); return { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 4 } }
await assert.rejects(() => wrongNet.commands[1].handler({ dryRun: false, RoutingNets: ['A'] }, wrongNet.ctx), /未请求或明确忽略的网络/)

const delayed = setup()
let releaseRoute
delayed.eda.pcb_Document.autoRouting = () => new Promise(resolve => { releaseRoute = resolve })
const delayedPromise = delayed.commands[1].handler({ dryRun: false, RoutingNets: ['A'] }, delayed.ctx)
while (!releaseRoute) await new Promise(resolve => setImmediate(resolve))
const timer = [...delayed.intervals.values()].find(item => item.ms === 10_000)
timer.fn()
assert.equal(delayed.progress.at(-1).stage, 'waiting-sdk')
assert.match(delayed.progress.at(-1).note, /不是实际进度/)
releaseRoute({ success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 4 })
await delayedPromise
assert.equal(timer.cleared, true, 'heartbeat interval must be cleared after completion')

const failedRaw = setup()
failedRaw.eda.pcb_Document.autoLayout = async () => {
	failedRaw.calls.layout++
	failedRaw.setRows([
		{ header: { type: 'DOCHEAD' }, data: { docType: 'PCB', uuid: 'pcb-1', client: 'changed', updateTime: 123, version: 99 } },
		{ header: { type: 'RULE', id: 'r1' }, data: { width: 10 } },
		{ header: { type: 'LINE', id: 'line1' }, data: { net: 'A', x1: 1 } },
	])
	return { success: false, totalComponentsCount: 0, successComponentsCount: 0, failedComponents: [], duration: 4 }
}
await assert.rejects(() => failedRaw.commands[0].handler({ dryRun: false, allowRoutedMovement: true }, failedRaw.ctx), error => /success=true/.test(error.message) && error.cause?.partial === false)
assert.equal(failedRaw.calls.layout, 1)

const failedRoute = setup()
failedRoute.eda.pcb_Document.autoRouting = async () => {
	failedRoute.calls.route++
	failedRoute.setRows([
		{ header: { type: 'DOCHEAD' }, data: { docType: 'PCB', uuid: 'pcb-1', client: 'changed', updateTime: 456, version: 100 } },
		{ header: { type: 'RULE', id: 'r1' }, data: { width: 10 } },
		{ header: { type: 'LINE', id: 'line1' }, data: { net: 'A', x1: 1 } },
	])
	return { success: false, totalNetsCount: 0, successNetsCount: 0, failedNets: [], duration: 2 }
}
await assert.rejects(() => failedRoute.commands[1].handler({ dryRun: false, RoutingNets: ['A'] }, failedRoute.ctx), error => /success=true/.test(error.message) && error.cause?.partial === false)
assert.equal(failedRoute.calls.route, 1, 'failed route stub must execute once, with the unchanged source proving no write')

const noRetry = setup()
noRetry.setFailReadback(true)
await assert.rejects(() => noRetry.commands[0].handler({ dryRun: false, allowRoutedMovement: true }, noRetry.ctx), /readback failed/)
assert.equal(noRetry.calls.layout, 1, 'readback failure must not trigger a blind second SDK call')

const drift = setup()
drift.eda.pcb_Document.autoLayout = async () => { drift.calls.layout++; drift.setDoc({ documentType: 3, uuid: 'other', tabId: 'tab-1' }); return { success: true } }
await assert.rejects(() => drift.commands[0].handler({ dryRun: false, allowRoutedMovement: true }, drift.ctx), /target changed/)
assert.equal(drift.calls.layout, 1)

console.log('pcb native automation regression passed')
