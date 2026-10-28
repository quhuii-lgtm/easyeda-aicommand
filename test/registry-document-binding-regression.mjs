import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { installVirtualClock } from './virtual-clock.mjs'

const virtualClock = installVirtualClock()
try {
	const source = fs.readFileSync(new URL('../src/engine/registry.ts', import.meta.url), 'utf8')
	const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
	let currentDoc = { documentType: 3, uuid: 'pcb-page' }
	let infoCalls = 0
	let activateCalls = 0
	let handlerCalls = 0
	let handlerSdkCalls = 0
	let docLookup
	const context = {
		exports: {},
		require(name) {
			if (name === './diag') return { diag() {} }
			if (name === './tasks') return {
				beginTask() { return { task: { id: 'macro-test' }, existing: false } },
				failTask() {}, finishTask() {}, taskProgress() {},
			}
			throw new Error(`Unexpected dependency: ${name}`)
		},
		eda: {
			dmt_SelectControl: { getCurrentDocumentInfo() { infoCalls++; return docLookup ? docLookup() : Promise.resolve(currentDoc) } },
			dmt_EditorControl: { getSplitScreenTree() { activateCalls++; throw new Error('must not inspect or change document focus') }, activateDocument() { activateCalls++; throw new Error('must not change document focus') } },
		},
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
		Date: class VirtualDate extends Date { static now() { return virtualClock.now } },
		console,
	}
	vm.runInNewContext(code, context)
	const { registerCommand, getCommandDocs, executeCommand } = context.exports
	const register = (name, handler) => registerCommand({ name, summary: '', params: [], returns: '', handler })
	register('pcb.testPage', async params => { handlerCalls++; return { page: currentDoc.uuid, requested: params.__docUuid } })
	register('schematic.testPage', async params => { handlerCalls++; return { page: currentDoc.uuid, requested: params.__docUuid } })
	const predeclaredTargetParams = [{ name: '__docUuid', type: 'string', required: false, description: 'existing target parameter' }]
	registerCommand({ name: 'pcb.predeclaredTarget', summary: '', params: predeclaredTargetParams, returns: '', handler: async () => true })
	register('project.testPage', async () => { handlerCalls++; return true })
	let docs
	for (let i = 0; i < 3; i++) {
		docs = getCommandDocs()
		const pageDocs = docs.filter(doc => doc.name.startsWith('pcb.') || doc.name.startsWith('schematic.'))
		assert.equal(pageDocs.length, 3)
		for (const doc of pageDocs)
			assert.equal(doc.params.filter(param => param.name === '__docUuid').length, 1, 'page help exports exactly one optional __docUuid')
		assert.ok(!docs.find(doc => doc.name === 'project.testPage').params.some(param => param.name === '__docUuid'), 'non-page help keeps its original parameter list')
	}
	assert.deepEqual(predeclaredTargetParams, [{ name: '__docUuid', type: 'string', required: false, description: 'existing target parameter' }], 'help augmentation does not mutate the registered definition parameters')
	assert.equal(docs.find(doc => doc.name === 'pcb.predeclaredTarget').params.find(param => param.name === '__docUuid').description, 'existing target parameter', 'an existing target parameter is preserved')

	let result = await executeCommand({ cmd: 'pcb.testPage', params: { __docUuid: 'pcb-page' } })
	assert.equal(result.ok, true)
	assert.equal(result.data.page, 'pcb-page')
	result = await executeCommand({ cmd: 'schematic.testPage' })
	assert.equal(result.ok, false)
	currentDoc = { documentType: 1, uuid: 'sch-page' }
	result = await executeCommand({ cmd: 'schematic.testPage', params: { __docUuid: 'sch-page' } })
	assert.equal(result.ok, true, 'a current schematic page passes the real registry guard')
	currentDoc = { documentType: 3, uuid: ' page ' }
	result = await executeCommand({ cmd: 'pcb.testPage', params: { __docUuid: ' page ' } })
	assert.equal(result.ok, true, 'valid UUID is compared without trimming or rewriting')
	assert.equal(activateCalls, 0, 'valid page execution never activates another document')
	currentDoc = { documentType: 3, uuid: 'pcb-page-B' }
	const beforeSameTypeMismatch = handlerCalls
	result = await executeCommand({ cmd: 'pcb.testPage', params: { __docUuid: 'pcb-page-A' } })
	assert.equal(result.ok, false, 'a current PCB page B must reject a request explicitly targeting PCB page A')
	assert.match(result.error.message, /UUID 与 __docUuid 不符/)
	assert.equal(handlerCalls, beforeSameTypeMismatch, 'same-type PCB UUID mismatch never reaches the handler')
	assert.equal(activateCalls, 0, 'same-type mismatch never self-heals by activating another tab')
	assert.equal(result.error.cause?.partial, undefined)

	for (const badUuid of ['', '   ', null, 7, undefined]) {
		const beforeInfo = infoCalls
		const beforeHandler = handlerCalls
		result = await executeCommand({ cmd: 'pcb.testPage', params: { __docUuid: badUuid } })
		assert.equal(result.ok, false)
		assert.match(result.error.message, /__docUuid 必须是非空/)
		assert.equal(infoCalls, beforeInfo, 'invalid caller target is rejected before the SDK read')
		assert.equal(handlerCalls, beforeHandler, 'invalid caller target never starts the command handler')
		assert.equal(result.error.cause?.partial, undefined)
	}

	for (const wrongDoc of [{ documentType: 1, uuid: 'other-sch' }, { documentType: 3, uuid: '' }, { documentType: 3, uuid: '   ' }, { documentType: 3 }]) {
		currentDoc = wrongDoc
		const beforeHandler = handlerCalls
		result = await executeCommand({ cmd: 'pcb.testPage' })
		assert.equal(result.ok, false)
		assert.equal(handlerCalls, beforeHandler, 'wrong type or missing/blank current UUID never reaches the handler')
		assert.equal(result.error.cause?.partial, undefined)
	}
	currentDoc = { documentType: 1, uuid: 'other-schematic' }
	assert.match((await executeCommand({ cmd: 'pcb.testPage' })).error.message, /editor\.openDocument/)
	assert.equal(activateCalls, 0, 'a mismatch requests explicit user activation and never self-heals focus')

	let readsBeforeInvalidParams = infoCalls
	let handlersBeforeInvalidParams = handlerCalls
	result = await executeCommand({ cmd: 'pcb.testPage', params: { _timeoutMs: 'bad' } })
	assert.equal(result.ok, false)
	assert.equal(infoCalls, readsBeforeInvalidParams)
	assert.equal(handlerCalls, handlersBeforeInvalidParams)
	assert.equal(result.error.cause?.partial, undefined)

	currentDoc = { documentType: 3, uuid: 'pcb-page' }
	const beforeRejectedLookup = handlerCalls
docLookup = () => Promise.reject({ message: 'focus-read-failed' })
result = await executeCommand({ cmd: 'pcb.testPage', params: { __docUuid: 'pcb-page' } })
assert.equal(result.ok, false)
assert.match(result.error.message, /focus-read-failed/)
assert.equal(handlerCalls, beforeRejectedLookup)
assert.equal(result.error.cause?.partial, undefined)

let resolveLate
docLookup = () => new Promise(resolve => { resolveLate = resolve })
const beforePending = handlerCalls
const pendingCall = executeCommand({ cmd: 'pcb.testPage', params: { __docUuid: 'pcb-page', _timeoutMs: 1000 } })
const pendingResult = await pendingCall
assert.equal(pendingResult.ok, false)
assert.match(pendingResult.error.message, /读取当前文档信息超时/)
assert.equal(pendingResult.error.cause?.partial, undefined, 'pre-handler SDK timeout is a normal read failure, not partial')
assert.equal(handlerCalls, beforePending)
resolveLate({ documentType: 3, uuid: 'pcb-page' })
await Promise.resolve(); await Promise.resolve()
assert.equal(handlerCalls, beforePending, 'a late focus-read result never starts a handler')

// The entry read and handler share the initial command window; a 700 ms lookup leaves only 300 ms.
docLookup = () => new Promise(resolve => setTimeout(() => resolve({ documentType: 3, uuid: 'pcb-page' }), 700))
register('pcb.pendingHandler', async () => { handlerCalls++; return new Promise(resolve => setTimeout(() => resolve(true), 500)) })
const beforeBudgetHandler = handlerCalls
result = await executeCommand({ cmd: 'pcb.pendingHandler', params: { _timeoutMs: 1000 } })
assert.equal(result.ok, false)
assert.equal(handlerCalls, beforeBudgetHandler + 1)
assert.equal(result.error.cause?.partial, true, 'once the handler starts, its timeout retains existing partial-write semantics')
assert.match(result.error.message, /超时（300ms 无进度心跳）/)

// A 700 ms entry read leaves 300 ms for the first handler window; its heartbeat restores the full 1000 ms window.
docLookup = () => new Promise(resolve => setTimeout(() => resolve({ documentType: 3, uuid: 'pcb-page' }), 700))
register('pcb.heartbeatHandler', async (_params, ctx) => {
	handlerCalls++
	return new Promise(resolve => {
		setTimeout(() => ctx.onProgress?.({ stage: 'still-working' }), 200)
		setTimeout(() => resolve(true), 1100)
	})
})
result = await executeCommand({ cmd: 'pcb.heartbeatHandler', params: { _timeoutMs: 1000 } }, { vars: {}, onProgress() {} })
assert.equal(result.ok, true, 'a handler heartbeat renews the original configured window after its reduced first window')

// Macro steps re-check the current page: switching away after step one blocks step two.
currentDoc = { documentType: 1, uuid: 'sch-macro' }
docLookup = undefined
register('schematic.switchToPcb', async () => { handlerCalls++; currentDoc = { documentType: 3, uuid: 'pcb-after-switch' }; return true })
register('schematic.mustNotRun', async () => { handlerCalls++; throw new Error('macro wrong-page handler ran') })
const beforeMacroSwitch = handlerCalls
result = await executeCommand({ cmd: 'macro', params: { steps: [{ cmd: 'schematic.switchToPcb' }, { cmd: 'schematic.mustNotRun' }] } })
assert.equal(result.ok, false)
assert.match(result.error.message, /editor\.openDocument/)
assert.equal(handlerCalls, beforeMacroSwitch + 1, 'macro stops after the page-bound second step fails its fresh guard')
assert.equal(activateCalls, 0)

// Same-type macro page switches must also honor the explicit target UUID on the later step.
currentDoc = { documentType: 1, uuid: 'schematic-A' }
register('schematic.switchSameTypeToB', async () => { handlerCalls++; currentDoc = { documentType: 1, uuid: 'schematic-B' }; return true })
register('schematic.mustRemainAtA', async params => { handlerCalls++; return params.__docUuid })
const beforeSameTypeMacroSwitch = handlerCalls
result = await executeCommand({ cmd: 'macro', params: { steps: [
	{ cmd: 'schematic.switchSameTypeToB' },
	{ cmd: 'schematic.mustRemainAtA', params: { __docUuid: 'schematic-A' } },
] } })
assert.equal(result.ok, false)
assert.match(result.error.message, /UUID 与 __docUuid 不符/)
assert.equal(handlerCalls, beforeSameTypeMacroSwitch + 1, 'same-type page UUID changes are checked between macro steps')
assert.equal(activateCalls, 0)

// Non-page commands retain their existing behavior and do not invoke the page lookup.
const beforeProjectInfo = infoCalls
result = await executeCommand({ cmd: 'project.testPage' })
assert.equal(result.ok, true)
assert.equal(infoCalls, beforeProjectInfo)
assert.equal(activateCalls, 0)

console.log('PASS registry page binding: UUID validation, read-only focus guard, shared timeout, heartbeats and per-macro-step revalidation')
}
finally {
	virtualClock.restore()
}
