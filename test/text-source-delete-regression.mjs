import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { __testDeleteTextFromSourceSnapshot, schematicCommands } from '../src/commands/schematic.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { __testDeleteTextFromSourceSnapshot, schematicCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'text-source-delete-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
	plugins: [{
		name: 'test-only-private-text-helper-export',
		setup(build) {
			build.onLoad({ filter: /schematic\.ts$/ }, async args => ({
				contents: `${await readFile(args.path, 'utf8')}\nexport { deleteTextFromSourceSnapshot as __testDeleteTextFromSourceSnapshot }\n`,
				loader: 'ts',
			}))
		},
	}],
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { schematicCommands, executeCommand, registerCommand, __testDeleteTextFromSourceSnapshot: deleteTextFromSourceSnapshot } = await import(moduleUrl)
const deleteCommand = schematicCommands.find(command => command.name === 'schematic.delete')
assert.ok(deleteCommand, 'normal schematic.delete command remains registered')
assert.equal(schematicCommands.some(command => command.name === 'schematic.deleteTextViaSource'), false, 'retired experiment command is not registered')

const DOC_UUID = 'page-text-delete-1'
const record = (type, id, data, ticket = 1) => `${JSON.stringify({ type, ticket, id })}||${JSON.stringify(data)}`
const header = `{"type":"DOCHEAD"}||${JSON.stringify({ docType: 'SCH_PAGE', uuid: DOC_UUID, client: 'mock' })}`
const textA = record('TEXT', 'target-a', { text: 'remove me', x: 10 })
const textB = record('TEXT', 'target "quoted"', { text: 'keep me', x: 20 })
const referenceText = record('TEXT', 'reference-text', { text: 'keep reference', x: 30 }, 56)
const versionOld = record('TEXT', 'versioned-text', { text: 'older version' }, 7)
const versionNew = record('TEXT', 'versioned-text', { text: 'newer version' }, 8)
const other = record('ATTR', 'attribute-1', { key: 'K', value: 'V' })
const canvas = record('CANVAS', 'CANVAS', { originX: 0, originY: 0 }, 2)
const wire = record('WIRE', 'wire-1', { zIndex: 9 }, 47)
const unknownHeader = `${JSON.stringify({ type: 'FUTURE_RECORD', ticket: 48, id: 'future-1', vendorMarker: 'keep' })}||${JSON.stringify({ value: 'future-data' })}`
const anonymousRecord = `{"type":"META"}||${JSON.stringify({ value: 'plain' })}`
const baseSource = [header, canvas, textA, textB, referenceText, versionOld, versionNew, other, wire, unknownHeader, anonymousRecord].join('\n')

function updateRecords(source, update) {
	return source.split(/\r?\n/).map(line => {
		const split = line.indexOf('||')
		if (split < 0) return line
		const header = JSON.parse(line.slice(0, split))
		const data = JSON.parse(line.slice(split + 2))
		if (update(header, data) === false) return undefined
		return `${JSON.stringify(header)}||${JSON.stringify(data)}`
	}).filter(Boolean).join('\n')
}

function modelIds(source) {
	const records = source.split(/\r?\n/).map(line => {
		const split = line.indexOf('||')
		if (split < 0) return undefined
		return { header: JSON.parse(line.slice(0, split)), data: JSON.parse(line.slice(split + 2)) }
	}).filter(Boolean)
	const effective = new Map()
	for (const item of records) {
		if (item.header.type !== 'TEXT') continue
		const id = String(item.header.id)
		const current = effective.get(id)
		if (!current || Number(item.header.ticket ?? 0) >= Number(current.header.ticket ?? 0)) {
			if (item.data === '') effective.delete(id)
			else effective.set(id, item)
		}
	}
	return [...effective.keys()]
}

function installEda({
	initialSource = baseSource,
	setMode = 'apply',
	readMode = 'ok',
	mutateOther = false,
	mutateAnonymous = false,
	mutateReference = false,
	missingWire = false,
	missingReference = false,
	missingCanvas = false,
	mutateUnknownHeader = false,
	duplicateWire = false,
	reorderVersions = false,
	renumberReferenceTicket = false,
	lateWrite = false,
} = {}) {
	let source = initialSource
	let sourceReads = 0
	let setCalls = 0
	let resolveLate
	const getSource = async () => {
		sourceReads++
		if (readMode === 'pre-fail' && sourceReads === 1) throw new Error('pre-read failed')
		if (readMode === 'post-fail' && sourceReads === 2) throw new Error('post-read failed')
		if (readMode === 'post-invalid' && sourceReads === 2) return '{invalid'
		return source
	}
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: DOC_UUID }) },
		sys_FileManager: {
			getDocumentSource: getSource,
			setDocumentSource: async next => {
				setCalls++
				if (setMode === 'reject') throw new Error('setter rejected')
				if (setMode === 'false') return false
				if (lateWrite) return new Promise(resolve => { resolveLate = () => { source = next; resolve(true) } })
				if (setMode === 'no-effect') return true
				source = next
				if (mutateOther)
					source = source.replace('"value":"V"', '"value":"changed"')
				if (mutateAnonymous)
					source = source.replace('"value":"plain"', '"value":"changed"')
				if (mutateReference || missingWire || missingReference || missingCanvas || mutateUnknownHeader || duplicateWire || reorderVersions || renumberReferenceTicket) {
					source = updateRecords(source, (recordHeader, data) => {
						if (missingWire && recordHeader.type === 'WIRE' && recordHeader.id === 'wire-1') return false
						if (missingReference && recordHeader.type === 'TEXT' && recordHeader.id === 'reference-text') return false
						if (missingCanvas && recordHeader.type === 'CANVAS' && recordHeader.id === 'CANVAS') return false
						if (mutateReference && recordHeader.type === 'TEXT' && recordHeader.id === 'reference-text') data.text = 'changed reference'
						if (mutateUnknownHeader && recordHeader.type === 'FUTURE_RECORD') recordHeader.vendorMarker = 'changed'
						if (reorderVersions && recordHeader.type === 'TEXT' && recordHeader.id === 'versioned-text') recordHeader.ticket = data.text === 'older version' ? 9 : 8
						if (renumberReferenceTicket && recordHeader.type === 'TEXT' && recordHeader.id === 'reference-text') recordHeader.ticket = 55
					})
					if (duplicateWire) source += `\n${record('WIRE', 'wire-1', { zIndex: 9 }, 49)}`
				}
				return true
			},
		},
		sch_PrimitiveText: { getAllPrimitiveId: async () => modelIds(source) },
	}
	return { get source() { return source }, get setCalls() { return setCalls }, resolveLate: () => resolveLate?.() }
}

function installOrdinaryDeleteEda({ mutateOther = false, mutateAnonymous = false, lateWrite = false } = {}) {
	let source = baseSource
	let setCalls = 0
	let saveCalls = 0
	let probeCalls = 0
	let resolveLate
	const noIds = async () => []
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: DOC_UUID }) },
		sys_FileManager: {
			getDocumentSource: async () => source,
			setDocumentSource: async next => {
				setCalls++
				if (lateWrite) return new Promise(resolve => { resolveLate = () => { source = next; resolve(true) } })
				source = next
		if (mutateOther) source = source.replace('"value":"V"', '"value":"changed"')
		if (mutateAnonymous) source = source.replace('"value":"plain"', '"value":"changed"')
				return true
			},
		},
		sch_PrimitiveComponent: { getAllPrimitiveId: noIds },
		sch_PrimitiveWire: { getAllPrimitiveId: noIds, delete: async () => true, create: async () => { probeCalls++; return undefined } },
		sch_PrimitiveText: { getAllPrimitiveId: async () => modelIds(source) },
		sch_PrimitiveRectangle: { getAllPrimitiveId: noIds, delete: async () => true },
		sch_PrimitiveAttribute: { getAllPrimitiveId: noIds, getAll: async () => [], delete: async () => true },
		sch_Document: { save: async () => { saveCalls++; return true } },
	}
	return {
		get source() { return source },
		get setCalls() { return setCalls },
		get saveCalls() { return saveCalls },
		get probeCalls() { return probeCalls },
		resolveLate: () => resolveLate?.(),
	}
}

registerCommand(deleteCommand)

async function capture(params, setup) {
	const state = installEda(setup)
	const { primitiveIds, _timeoutMs, ...options } = params
	try { return { value: await deleteTextFromSourceSnapshot(primitiveIds, { ...options, ...(_timeoutMs != null ? { timeoutMs: _timeoutMs } : {}) }), state } }
	catch (error) { return { error, state } }
}

{
	const result = await capture({ primitiveIds: ['target-a', 'target "quoted"'] })
	const { value, state } = result
	assert.ok(value, `normal snapshot deletion failed: ${result.error?.message}; cause=${JSON.stringify(result.error?.cause)}`)
	assert.deepEqual(value.deleted, ['target-a', 'target "quoted"'])
	assert.equal(value.strategy, 'source-snapshot')
	assert.equal(value.sourceVerified, true)
	assert.equal(value.modelVerified, true)
	assert.equal(state.source, [header, canvas, referenceText, versionOld, versionNew, other, wire, unknownHeader, anonymousRecord].join('\n'), 'snapshot removes only exact target TEXT rows and preserves unrelated source rows')
}

{
	const { value, state } = await capture({ primitiveIds: ['target-a'] }, { renumberReferenceTicket: true })
	assert.ok(value, 'ticket-only changes must not be treated as content drift')
	assert.equal(value.sourceVerified, true)
	assert.ok(state.source.includes(record('TEXT', 'reference-text', { text: 'keep reference', x: 30 }, 55)), 'mock server may renumber a preserved reference ticket')
}

{
	const { error, state } = await capture({ primitiveIds: ['target-a'] }, { setMode: 'no-effect' })
	assert.equal(error.cause.partial, true, 'true setter acknowledgment without actual deletion is partial')
	assert.match(error.message, /目标 TEXT target-a.*源码仍存在/)
}

	for (const [label, setup] of [
	['setter false', { setMode: 'false' }],
	['setter reject', { setMode: 'reject' }],
	['post-write read throws', { readMode: 'post-fail' }],
	['post-write source is invalid', { readMode: 'post-invalid' }],
	['non-target content changes', { mutateOther: true }],
	['anonymous non-target content changes', { mutateAnonymous: true }],
	['reference text content changes', { mutateReference: true }],
	['non-target wire is missing', { missingWire: true }],
	['reference text is missing', { missingReference: true }],
	['canvas record is missing', { missingCanvas: true }],
	['unknown header field changes', { mutateUnknownHeader: true }],
	['non-target duplicate record is added', { duplicateWire: true }],
	['same-id versions reorder effective data', { reorderVersions: true }],
]) {
	const { error, state } = await capture({ primitiveIds: ['target-a'] }, setup)
	assert.equal(error.cause.partial, true, `${label} after attempted write is partial`)
	assert.doesNotMatch(error.message, /超时/, `${label} reports the comparison cause instead of a timeout`)
	if (label === 'same-id versions reorder effective data')
		assert.match(error.message, /非目标有效源码记录发生变化：TEXT:versioned-text/, 'ticket-insensitive row comparison still rejects changed effective version data')
}

{
	const { error, state } = await capture({ primitiveIds: ['target-a'] }, { readMode: 'pre-fail' })
	assert.equal(error.cause.partial, false, 'pre-write source read failure is not a partial write')
	assert.equal(state.setCalls, 0)
}

{
	const alreadyDeletedSource = [header, record('TEXT', 'target-a', '', 2), textB, other].join('\n')
	for (const source of [alreadyDeletedSource, [header, textB, other].join('\n')]) {
		const { value, state } = await capture({ primitiveIds: ['target-a'] }, { initialSource: source })
		assert.deepEqual(value.deleted, [])
		assert.deepEqual(value.skipped, ['target-a'])
		assert.equal(value.sourceVerified, true)
		assert.equal(state.setCalls, 0, 'already deleted or missing IDs do not write')
	}
}

{
	const duplicateSource = [header, textA, record('TEXT', 'target-a', { text: 'older record' }, 0), textB, other].join('\n')
	const { error, state } = await capture({ primitiveIds: ['target-a'] }, { initialSource: duplicateSource })
	assert.equal(error.cause.partial, false, 'ambiguous source rows are rejected before writing')
	assert.equal(state.setCalls, 0)
}

{
	const state = installOrdinaryDeleteEda()
	const result = await executeCommand({ cmd: 'schematic.delete', params: { primitiveIds: ['target-a', 'target "quoted"'] } })
	assert.equal(result.ok, true, JSON.stringify(result))
	assert.deepEqual(result.data.deleted, ['target-a', 'target "quoted"'], 'successive TEXT deletes use the latest source snapshot')
	assert.equal(result.data.persistenceVerified, false, 'ordinary delete explicitly leaves close/reopen persistence unverified')
	assert.deepEqual(modelIds(state.source), ['reference-text', 'versioned-text'])
	assert.equal(state.saveCalls, 0, 'ordinary schematic.delete does not save')
}

{
	const state = installOrdinaryDeleteEda({ mutateAnonymous: true })
	let markerWrites = 0
	registerCommand({ name: 'test.ordinaryTextMarker', summary: 'marker', params: [], returns: '', handler: async () => { markerWrites++; return { wrote: true } } })
	const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
		{ cmd: 'schematic.delete', params: { primitiveIds: ['target-a', 'target "quoted"'] } },
		{ cmd: 'test.ordinaryTextMarker' },
	] } })
	assert.equal(result.ok, false)
	assert.equal(result.error?.cause?.partial, true, 'non-target source drift after write is uncertain partial')
	assert.equal(result.data?.steps?.[0]?.error?.cause?.partial, true)
	assert.ok(result.error?.cause?.result?.diagnostics?.some(item => item.includes('单项删除写入或读回状态未确认')), 'post-write source mismatch reports an unconfirmed readback, not a timeout')
	assert.equal(markerWrites, 0, 'non-target drift stops later macro writes')
	assert.equal(state.probeCalls, 0, 'uncertain TEXT source result skips the health-probe write')
	assert.equal(state.saveCalls, 0)
}

{
	const state = installOrdinaryDeleteEda({ lateWrite: true })
	const pending = deleteCommand.handler({ primitiveIds: ['target-a', 'target "quoted"'] }).then(value => ({ value }), error => ({ error }))
	for (let turn = 0; state.setCalls === 0 && turn < 1000; turn++)
		await new Promise(resolve => setImmediate(resolve))
	assert.ok(state.setCalls > 0, 'ordinary TEXT path should reach setDocumentSource before the item timeout')
	await new Promise(resolve => setTimeout(resolve, 8_100))
	const result = await pending
	assert.equal(result.error?.cause?.partial, true)
	state.resolveLate()
	await new Promise(resolve => setImmediate(resolve))
	assert.equal(state.saveCalls, 0, 'late ordinary source write cannot continue into save')
	assert.equal(state.setCalls, 1, 'late completion cannot start the next TEXT snapshot write')
}

{
	const state = installEda({ lateWrite: true })
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	const timers = new Map()
	let nextTimer = 923000
	globalThis.setTimeout = (callback, ms, ...args) => {
		if (ms >= 900 && ms <= 1000) {
			const id = ++nextTimer
			timers.set(id, { active: true, fire: () => callback(...args) })
			return id
		}
		return originalSetTimeout(callback, ms, ...args)
	}
	globalThis.clearTimeout = id => {
		if (timers.has(id)) timers.get(id).active = false
		else originalClearTimeout(id)
	}
	try {
		const pending = deleteTextFromSourceSnapshot(['target-a'], { timeoutMs: 1000 }).then(value => ({ value }), error => ({ error }))
		while (state.setCalls === 0) await new Promise(resolve => setImmediate(resolve))
		const activeTimer = [...timers.values()].find(timer => timer.active)
		assert.ok(activeTimer, 'the pending source write has an active shared-budget timer')
		activeTimer.fire()
		const result = await pending
		assert.equal(result.error.cause.partial, true, 'late setter timeout is partial')
		state.resolveLate()
		await new Promise(resolve => setImmediate(resolve))
	}
	finally {
		globalThis.setTimeout = originalSetTimeout
		globalThis.clearTimeout = originalClearTimeout
	}
}

console.log('text-source-delete-regression: all checks passed')
