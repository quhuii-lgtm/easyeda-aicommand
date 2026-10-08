import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { schematicCommands } from '../src/commands/schematic.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { schematicCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-delete-netlist-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { schematicCommands, executeCommand, registerCommand } = await import(moduleUrl)
const handler = name => schematicCommands.find(command => command.name === name).handler
const command = handler('schematic.delete')
const getNetlist = handler('schematic.getNetlist')

async function withTestTimers(fn) {
	const original = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	const activeTimers = new Map()
	let nextTimerId = 1
	globalThis.setTimeout = (callback, ms, ...args) => {
		if (ms === 8000) {
			const timer = { active: true, fire: () => { if (timer.active) callback(...args) } }
			const id = nextTimerId++
			activeTimers.set(id, timer)
			if (globalThis.__forceDeleteItemTimeout?.()) queueMicrotask(timer.fire)
			else if (Array.isArray(globalThis.__deferredDeleteTimeouts)) globalThis.__deferredDeleteTimeouts.push(timer.fire)
			return id
		}
		if (ms <= 1500) {
			if (ms === 300) globalThis.__fireDeferredDeleteTimeouts?.()
			queueMicrotask(() => callback(...args))
			return 0
		}
		return 0
	}
	globalThis.clearTimeout = id => {
		const timer = activeTimers.get(id)
		if (timer) {
			timer.active = false
			activeTimers.delete(id)
			return
		}
		originalClearTimeout(id)
	}
	try { await fn() }
	finally { globalThis.setTimeout = original; globalThis.clearTimeout = originalClearTimeout }
}

function makeEda({ wires = [], attributes = [], failLists = false, failAttributeListAt, failWireListsAfterDelete = false, persistDelete = true, pendingDelete } = {}) {
	const wireIds = new Set(wires)
	const attrs = new Map(attributes.map(({ id, parentId }) => [id, parentId]))
	let deleteCalls = 0
	let probeCreateCalls = 0
	let resolvePendingDelete
	let attributeListCalls = 0
	let markDeleteStarted
	const deleteStarted = new Promise(resolve => { markDeleteStarted = resolve })
	const list = set => async () => {
		if (failLists) throw new Error('mock list read failure')
		if (failWireListsAfterDelete && set === wireIds && deleteCalls > 0) throw new Error('post-delete wire read failure')
		return [...set]
	}
	const removeWire = ids => {
		deleteCalls++
		markDeleteStarted()
		if (pendingDelete === 'never') return new Promise(() => {})
		if (pendingDelete === 'resolve' || pendingDelete === 'reject') {
			return new Promise((resolve, reject) => {
				resolvePendingDelete = () => {
					if (pendingDelete === 'resolve' && persistDelete) {
						for (const id of ids)
							wireIds.delete(id)
					}
					if (pendingDelete === 'reject') reject(new Error('late delete rejection'))
					else resolve(true)
				}
			})
		}
		if (persistDelete) for (const id of ids) {
			wireIds.delete(id)
			for (const [attrId, parentId] of attrs) if (parentId === id) attrs.delete(attrId)
		}
		return true
	}
	const makeAttr = (id, parentId) => ({
		getState_PrimitiveId: () => id,
		getState_ParentPrimitiveId: () => parentId,
		delete: () => { if (persistDelete) attrs.delete(id) },
	})
	globalThis.eda = {
		sys_FileManager: { getDocumentSource: async () => '|' },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 2 }) },
		sch_PrimitiveComponent: { getAllPrimitiveId: list(new Set()), delete: async () => true },
		sch_PrimitiveWire: { getAllPrimitiveId: list(wireIds), delete: removeWire, create: async () => { probeCreateCalls++; throw new Error('probe should not run') } },
		sch_PrimitiveText: { getAllPrimitiveId: list(new Set()) },
		sch_PrimitiveRectangle: { getAllPrimitiveId: list(new Set()), delete: async () => true },
		sch_PrimitiveAttribute: {
			getAllPrimitiveId: async () => {
				attributeListCalls++
				if (failLists || attributeListCalls === failAttributeListAt) throw new Error('mock attribute list read failure')
				return [...attrs.keys()]
			},
			getAll: async () => [...attrs].map(([id, parentId]) => makeAttr(id, parentId)),
			get: async id => attrs.has(id) ? makeAttr(id, attrs.get(id)) : undefined,
		},
	}
	return { wireIds, attrs, deleteStarted, resolvePendingDelete: () => resolvePendingDelete?.(), get deleteCalls() { return deleteCalls }, get probeCreateCalls() { return probeCreateCalls } }
}

function makeProbeEda({ listMode = 'visible', focusSwitchAt, delayedCreate, delayedProbeDelete, createFailure, createNoId, deleteFailure, targetDeleteAfterCommitFailure, afterList } = {}) {
	const targetIds = new Set(['wire-stuck'])
	const probeIds = new Set()
	let createCalls = 0
	let targetDeleteCalls = 0
	let probeDeleteCalls = 0
	let focusReads = 0
	let resolveCreate
	let resolveProbeDelete
	let markCreateStarted
	const createStarted = new Promise(resolve => { markCreateStarted = resolve })
	const probe = {
		getState_PrimitiveId: () => 'probe-1',
		getState_Line: () => [10, 0, 0, 0], // API may reverse the endpoints; the line is geometrically identical.
	}
	const noIdProbe = { getState_PrimitiveId: () => undefined }
	globalThis.eda = {
		sys_FileManager: { getDocumentSource: async () => '|' },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => {
			focusReads++
			return { documentType: 1, uuid: focusSwitchAt && focusReads >= focusSwitchAt ? 'doc-B' : 'doc-A' }
		} },
		sch_PrimitiveComponent: { getAllPrimitiveId: async () => [], delete: async () => true },
		 sch_PrimitiveWire: {
			getAllPrimitiveId: async () => {
				if (listMode === 'throw-after-create' && probeIds.size) throw new Error('probe readback rejected')
				if (listMode === 'invalid-after-create' && probeIds.size) return undefined
				const ids = [...targetIds, ...probeIds]
				const visibleIds = listMode === 'hidden' ? ids.filter(id => id !== 'probe-1') : ids
				afterList?.(visibleIds)
				return visibleIds
			},
			get: async id => id === 'probe-1' ? probe : undefined,
			delete: async ids => {
				if (ids[0] === 'wire-stuck') {
					targetDeleteCalls++
					if (targetDeleteAfterCommitFailure) {
						targetIds.delete('wire-stuck')
						throw new Error('target delete rejected after commit')
					}
					return true
				}
				probeDeleteCalls++
				if (deleteFailure) throw new Error('probe delete rejected')
				if (delayedProbeDelete) return new Promise(resolve => { resolveProbeDelete = () => { probeIds.delete('probe-1'); resolve(true) } })
				probeIds.delete('probe-1')
				return true
			},
			create: async () => {
				createCalls++
				markCreateStarted()
				if (createFailure) throw new Error('probe create rejected')
				if (createNoId) return noIdProbe
				if (delayedCreate) return new Promise(resolve => { resolveCreate = () => { probeIds.add('probe-1'); resolve(probe) } })
				probeIds.add('probe-1')
				return probe
			},
		},
		sch_PrimitiveText: { getAllPrimitiveId: async () => [] },
		sch_PrimitiveRectangle: { getAllPrimitiveId: async () => [], delete: async () => true },
		sch_PrimitiveAttribute: { getAllPrimitiveId: async () => [], getAll: async () => [], get: async () => undefined },
	}
	return {
		createStarted,
		resolveCreate: () => resolveCreate?.(),
		resolveProbeDelete: () => resolveProbeDelete?.(),
		get createCalls() { return createCalls },
		get targetDeleteCalls() { return targetDeleteCalls },
		get probeDeleteCalls() { return probeDeleteCalls },
	}
}

async function capturePartial(params) {
	let caught
	try {
		await command(params, {})
	}
	catch (error) { caught = error }
	assert.ok(caught, 'expected delete error')
	return caught
}

await withTestTimers(async () => {
	// A parent wire deletion cascades its attribute; it is reported as a confirmed cascade, not a write failure.
	{
		const state = makeEda({ wires: ['wire-1'], attributes: [{ id: 'label-1', parentId: 'wire-1' }] })
		const result = await command({ primitiveIds: ['wire-1', 'label-1'] }, {})
		assert.deepEqual(result.deleted.sort(), ['label-1', 'wire-1'])
		assert.equal(result.outcomeBy['wire-1'], 'directDeleted')
		assert.equal(result.outcomeBy['label-1'], 'cascadeDeleted')
		assert.deepEqual(result.failed, [])
		assert.equal(state.deleteCalls, 1)
	}
	// A wire can be confirmed deleted while its cascaded child final readback is unknown; the child stays failed/partial.
	{
		const state = makeEda({ wires: ['wire-unknown-child'], attributes: [{ id: 'label-unknown', parentId: 'wire-unknown-child' }], failAttributeListAt: 3 })
		const error = await capturePartial({ primitiveIds: ['wire-unknown-child', 'label-unknown'] })
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.result.outcomeBy['wire-unknown-child'], 'directDeleted')
		assert.equal(error.cause.result.outcomeBy['label-unknown'], 'unknown')
		assert.deepEqual(error.cause.result.failed, ['label-unknown'])
		assert.deepEqual(error.cause.result.deleted, ['wire-unknown-child'])
		assert.equal(state.deleteCalls, 1)
	}
	// A fake ID stays notFound and is never sent to delete or promoted to success.
	{
		const state = makeEda()
		const error = await capturePartial({ primitiveIds: ['fake-id'] })
		assert.equal(error.cause?.partial, undefined, 'pre-write fake ID does not trigger macro uncertain-write handling')
		const result = error.cause.result
		assert.equal(result.outcomeBy['fake-id'], 'notFound')
		assert.deepEqual(result.deleted, [])
		assert.deepEqual(result.failed, ['fake-id'])
		assert.equal(state.deleteCalls, 0)
		assert.equal(result.failedNote, undefined)
	}
	// A confirmed deletion plus a fake ID remains machine-readable partial state for the macro.
	{
		const state = makeEda({ wires: ['wire-valid'] })
		const error = await capturePartial({ primitiveIds: ['wire-valid', 'fake-mixed'] })
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause.result.outcomeBy['wire-valid'], 'directDeleted')
		assert.equal(error.cause.result.outcomeBy['fake-mixed'], 'notFound')
		assert.deepEqual(error.cause.result.deleted, ['wire-valid'])
		assert.deepEqual(error.cause.result.failed, ['fake-mixed'])
		assert.equal(state.deleteCalls, 1)
	}
	// A complete readback that still contains the target is the only case that receives failedNote.
	{
		const state = makeEda({ wires: ['wire-stuck'], persistDelete: false })
		const error = await capturePartial({ primitiveIds: ['wire-stuck'] })
		assert.equal(error.cause?.partial, true)
		const partial = error.cause.result
		assert.equal(partial.outcomeBy['wire-stuck'], 'stillExists')
		assert.match(partial.failedNote, /wire-stuck/)
		assert.equal(state.deleteCalls, 1)
	}
	// A pre-write enumeration failure remains unknown and does not claim an uncertain write.
	{
		const state = makeEda({ wires: ['wire-unreadable'], failLists: true })
		const error = await capturePartial({ primitiveIds: ['wire-unreadable'] })
		assert.equal(error.cause?.partial, undefined, 'pre-write read failure is not an uncertain write')
		const partial = error.cause.result
		assert.equal(partial.outcomeBy['wire-unreadable'], 'unknown')
		assert.equal(partial.failedNote, undefined)
		assert.deepEqual(partial.deleted, [])
		assert.equal(state.deleteCalls, 0)
	}
	// A timed-out delete is a tagged uncertain write: no later target or health-probe write may start.
	for (const pendingDelete of ['never', 'resolve', 'reject']) {
		const state = makeEda({ wires: ['wire-timeout', 'wire-after-timeout'], pendingDelete })
		globalThis.__forceDeleteItemTimeout = () => state.deleteCalls > 0
		const error = await capturePartial({ primitiveIds: ['wire-timeout', 'wire-after-timeout'] })
		globalThis.__forceDeleteItemTimeout = undefined
		const result = error.cause.result
		assert.equal(error.cause.partial, true, `${pendingDelete} timeout preserves partial-write cause`)
		assert.equal(result.outcomeBy['wire-timeout'], 'unknown', `${pendingDelete} timeout remains unknown`)
		assert.deepEqual(result.unprocessed, ['wire-after-timeout'])
		assert.deepEqual(result.deleted, [])
		assert.equal(state.deleteCalls, 1, `${pendingDelete} timeout stops the second delete`)
		assert.equal(state.probeCreateCalls, 0, `${pendingDelete} timeout skips the health-probe create`)
		if (pendingDelete !== 'never') {
			state.resolvePendingDelete()
			await new Promise(resolve => setImmediate(resolve))
			assert.equal(result.outcomeBy['wire-timeout'], 'unknown', `${pendingDelete} late settlement cannot promote the result`)
			assert.deepEqual(result.deleted, [])
			assert.equal(state.deleteCalls, 1)
			assert.equal(state.probeCreateCalls, 0)
		}
	}
	// A short total fuse blocks the next write when the first delete settles after its timer window, even if its timeout callback is delayed.
	{
		const state = makeEda({ wires: ['wire-late-success', 'wire-after-fuse'], pendingDelete: 'resolve' })
		const originalNow = performance.now
		let fakeNow = originalNow.call(performance)
		performance.now = () => fakeNow
		try {
			const pending = command({ primitiveIds: ['wire-late-success', 'wire-after-fuse'], _timeoutMs: 1000 }, {}).then(value => ({ value }), error => ({ error }))
			await state.deleteStarted
			fakeNow += 1001
			state.resolvePendingDelete()
			const completed = await pending
			assert.equal(completed.error?.cause?.partial, true)
			assert.equal(completed.error?.cause?.result?.outcomeBy?.['wire-late-success'], 'directDeleted')
			assert.deepEqual(completed.error?.cause?.result?.unprocessed, ['wire-after-fuse'])
			assert.equal(state.deleteCalls, 1)
			assert.equal(state.probeCreateCalls, 0)
		}
		finally { performance.now = originalNow }
	}
	// Invalid timeout values are rejected before any target write.
	for (const _timeoutMs of [NaN, Infinity, 2147483648, 'not-a-number']) {
		const state = makeEda({ wires: ['wire-invalid-fuse'] })
		const error = await capturePartial({ primitiveIds: ['wire-invalid-fuse'], _timeoutMs })
		assert.match(error.message, /_timeoutMs/)
		assert.equal(state.deleteCalls, 0)
		assert.equal(state.probeCreateCalls, 0)
	}
	// A write-after-readback unknown stops later deletes and remains unknown after the final read.
	{
		const state = makeEda({ wires: ['wire-readback-unknown', 'wire-after-unknown'], failWireListsAfterDelete: true })
		const error = await capturePartial({ primitiveIds: ['wire-readback-unknown', 'wire-after-unknown'] })
		assert.equal(error.cause.partial, true)
		assert.equal(error.cause.result.outcomeBy['wire-readback-unknown'], 'unknown')
		assert.deepEqual(error.cause.result.unprocessed, ['wire-after-unknown'])
		assert.equal(state.deleteCalls, 1)
		assert.equal(state.probeCreateCalls, 0)
	}
	// A floating-label instance delete that resolves after the timeout cannot start its class-delete fallback.
	{
		let labelSource = '{"type":"ATTR","id":"float-late"}||{"key":"_NETLABEL_","value":"LATE","parentId":"$$root","x":10,"y":-20}|'
		let attributeDeleteCalls = 0
		let classDeleteCalls = 0
		let releaseAttributeDelete
		let markAttributeDeleteStarted
		const attributeDeleteStarted = new Promise(resolve => { markAttributeDeleteStarted = resolve })
		const state = {
			get attributeDeleteCalls() { return attributeDeleteCalls },
			get classDeleteCalls() { return classDeleteCalls },
			probeCreateCalls: 0,
			resolveAttributeDelete: () => releaseAttributeDelete?.(),
		}
		globalThis.eda = {
			sys_FileManager: { getDocumentSource: async () => labelSource },
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'doc-A' }) },
			sch_PrimitiveComponent: { getAllPrimitiveId: async () => [], delete: async () => true },
			sch_PrimitiveWire: { getAllPrimitiveId: async () => [], delete: async () => true, create: async () => { state.probeCreateCalls++; throw new Error('probe should not run') } },
			sch_PrimitiveText: { getAllPrimitiveId: async () => [] },
			sch_PrimitiveRectangle: { getAllPrimitiveId: async () => [], delete: async () => true },
			sch_PrimitiveAttribute: {
				getAllPrimitiveId: async () => [],
				getAll: async () => [],
				get: async id => id === 'float-late' ? { delete: () => {
					attributeDeleteCalls++
					markAttributeDeleteStarted()
					return new Promise(resolve => { releaseAttributeDelete = () => { labelSource = '|'; resolve() } })
				} } : undefined,
				delete: async () => { classDeleteCalls++; return true },
			},
		}
		globalThis.__forceDeleteItemTimeout = () => state.attributeDeleteCalls > 0
		globalThis.__deferredDeleteTimeouts = []
		const pending = command({ primitiveIds: ['float-late'] }, {}).then(value => ({ value }), error => ({ error }))
		await attributeDeleteStarted
		globalThis.__deferredDeleteTimeouts.at(-1)?.()
		const completed = await pending
		globalThis.__forceDeleteItemTimeout = undefined
		globalThis.__deferredDeleteTimeouts = undefined
		assert.equal(completed.error?.cause?.partial, true)
		assert.equal(completed.error?.cause?.result?.outcomeBy?.['float-late'], 'unknown')
		assert.equal(state.attributeDeleteCalls, 1)
		assert.equal(state.classDeleteCalls, 0)
		assert.equal(state.probeCreateCalls, 0)
		state.resolveAttributeDelete()
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(state.classDeleteCalls, 0, 'late instance-delete resolution cannot start the class fallback')
		assert.equal(state.probeCreateCalls, 0)
	}
	// A completed item's old timeout cannot poison the next successful item.
	{
		const state = makeEda({ wires: ['wire-timer-cleanup-1', 'wire-timer-cleanup-2'] })
		globalThis.__deferredDeleteTimeouts = []
		globalThis.__fireDeferredDeleteTimeouts = () => globalThis.__deferredDeleteTimeouts.forEach(fire => fire())
		try {
			await withTestTimers(async () => {
				const result = await command({ primitiveIds: ['wire-timer-cleanup-1', 'wire-timer-cleanup-2'], batchSize: 1 }, {})
				assert.equal(result.deleted.length, 2)
				assert.equal(state.deleteCalls, 2)
			})
		}
		finally {
			globalThis.__deferredDeleteTimeouts = undefined
			globalThis.__fireDeferredDeleteTimeouts = undefined
		}
	}
	// A timeout partial stops a real macro even when stopOnError is false.
	{
		const state = makeEda({ wires: ['wire-macro-timeout', 'wire-macro-next'], pendingDelete: 'never' })
		globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ documentType: 1, uuid: 'doc-A' })
		let markerWrites = 0
		registerCommand(schematicCommands.find(def => def.name === 'schematic.delete'))
		registerCommand({ name: 'test.timeoutMarkerWrite', summary: 'test marker', params: [], returns: '', handler: async () => {
			markerWrites++
			return { wrote: true }
		} })
		globalThis.__forceDeleteItemTimeout = () => state.deleteCalls > 0
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'schematic.delete', params: { primitiveIds: ['wire-macro-timeout', 'wire-macro-next'] } },
			{ cmd: 'test.timeoutMarkerWrite' },
		] } })
		globalThis.__forceDeleteItemTimeout = undefined
		assert.equal(result.ok, false)
		assert.equal(result.error?.cause?.partial, true)
		assert.equal(result.data?.stoppedReason, 'partial')
		assert.equal(result.data?.unexecutedSteps, 1)
		assert.equal(result.data?.steps?.[0]?.error?.cause?.result?.outcomeBy?.['wire-macro-timeout'], 'unknown')
		assert.equal(markerWrites, 0)
		assert.equal(state.deleteCalls, 1)
		assert.equal(state.probeCreateCalls, 0)
	}
	// R3: verified ID/geometry, prior list visibility, one delete, and a legal absent list confirm cleanup.
	{
		const state = makeProbeEda()
		const error = await capturePartial({ primitiveIds: ['wire-stuck'] })
		const result = error.cause.result
		assert.equal(result.sessionHealth, 'ok')
		assert.equal(result.probeStatus, 'cleaned')
		assert.equal(result.probeDocumentUuid, 'doc-A')
		assert.equal(result.probeId, 'probe-1')
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, 1)
	}
	// Expiration during the final probe cleanup read keeps the reconciled delete partial and stops the macro.
	{
		const originalNow = performance.now
		let fakeNow = originalNow.call(performance)
		performance.now = () => fakeNow
		let state
		state = makeProbeEda({
			targetDeleteAfterCommitFailure: true,
			afterList: ids => {
				if (state?.probeDeleteCalls === 1 && !ids.includes('wire-stuck') && !ids.includes('probe-1'))
					fakeNow += 100001
			},
		})
		let markerWrites = 0
		registerCommand(schematicCommands.find(def => def.name === 'schematic.delete'))
		registerCommand({ name: 'test.probeDeadlineMarker', summary: 'test marker', params: [], returns: '', handler: async () => {
			markerWrites++
			return { wrote: true }
		} })
		try {
			const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
				{ cmd: 'schematic.delete', params: { primitiveIds: ['wire-stuck'], _timeoutMs: 100000 } },
				{ cmd: 'test.probeDeadlineMarker' },
			] } })
			assert.equal(result.ok, false)
			assert.equal(result.error?.cause?.partial, true)
			assert.equal(result.data?.stoppedReason, 'partial')
			assert.equal(result.data?.unexecutedSteps, 1)
			assert.equal(result.data?.steps?.[0]?.error?.cause?.result?.sessionHealth, 'ok')
			assert.equal(result.data?.steps?.[0]?.error?.cause?.result?.reconciled?.length, 1)
			assert.equal(markerWrites, 0)
			assert.equal(state.targetDeleteCalls, 1)
			assert.equal(state.probeDeleteCalls, 1)
		}
		finally { performance.now = originalNow }
	}
	// A lagging enumeration never proves cleanup, even when post-delete lists omit the ID.
	{
		const state = makeProbeEda({ listMode: 'hidden' })
		const error = await capturePartial({ primitiveIds: ['wire-stuck'] })
		const result = error.cause.result
		assert.equal(error.cause.partial, true)
		assert.equal(result.sessionHealth, 'inconclusive')
		assert.equal(result.probeStatus, 'unconfirmed')
		assert.equal(result.probeId, 'probe-1')
		assert.equal(result.probeResidue, undefined, 'lagging list does not confirm probe residue')
		assert.equal(result.probeResidueDetail, undefined, 'lagging list does not confirm probe residue details')
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, 1)
	}
	// Rejected and malformed list reads cannot produce a false healthy result.
	for (const listMode of ['throw-after-create', 'invalid-after-create']) {
		const state = makeProbeEda({ listMode })
		const error = await capturePartial({ primitiveIds: ['wire-stuck'] })
		assert.equal(error.cause.result.sessionHealth, 'inconclusive', `${listMode} remains inconclusive`)
		assert.equal(error.cause.result.probeResidue, undefined, `${listMode} does not confirm probe residue`)
		assert.equal(error.cause.result.probeResidueDetail, undefined, `${listMode} does not confirm probe residue details`)
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, 1)
	}
	// A page switch immediately before cleanup stops the delete and keeps the probe ID evidence.
	{
		const state = makeProbeEda({ focusSwitchAt: 3 })
		const error = await capturePartial({ primitiveIds: ['wire-stuck'] })
		const result = error.cause.result
		assert.equal(result.sessionHealth, 'inconclusive')
		assert.equal(result.probeResidue, undefined, 'page switch leaves probe presence unknown')
		assert.equal(result.probeResidueDetail, undefined, 'page switch leaves probe presence unknown')
		assert.equal(result.probeId, 'probe-1')
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, 0)
	}
	// Create rejection/no-ID and delete rejection stay structured and never launch duplicate writes.
	for (const options of [{ createFailure: true }, { createNoId: true }, { deleteFailure: true }]) {
		const state = makeProbeEda(options)
		const error = await capturePartial({ primitiveIds: ['wire-stuck'] })
		const result = error.cause.result
		assert.equal(error.cause.partial, true)
		assert.equal(result.sessionHealth, options.deleteFailure ? 'degraded' : 'inconclusive')
		assert.equal(result.probeStatus, 'unconfirmed')
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, options.deleteFailure ? 1 : 0)
		if (options.createFailure || options.createNoId)
			assert.equal(result.probeId, undefined)
		if (options.deleteFailure) {
			assert.equal(result.probeResidue, 'probe-1', 'a valid post-cleanup list confirms probe residue')
			assert.equal(result.probeResidueDetail?.id, 'probe-1')
		}
	}
	// A late create remains owned by the one awaited chain; it never starts a second create.
	{
		const state = makeProbeEda({ delayedCreate: true })
		const pending = command({ primitiveIds: ['wire-stuck'] }, {}).then(value => ({ value }), error => ({ error }))
		await state.createStarted
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, 0)
		state.resolveCreate()
		const completed = await pending
		assert.equal(completed.error?.cause?.result?.probeId, 'probe-1')
		assert.equal(state.createCalls, 1)
		assert.equal(state.probeDeleteCalls, 1)
	}
	// A late delete remains on the same promise; cleanup is never retried blindly.
	{
		const state = makeProbeEda({ delayedProbeDelete: true })
		const pending = command({ primitiveIds: ['wire-stuck'] }, {}).then(value => ({ value }), error => ({ error }))
		await state.createStarted
		for (let i = 0; i < 30 && !state.probeDeleteCalls; i++)
			await new Promise(resolve => setImmediate(resolve))
		assert.equal(state.probeDeleteCalls, 1)
		state.resolveProbeDelete()
		const completed = await pending
		assert.equal(completed.error?.cause?.result?.probeId, 'probe-1')
		assert.equal(state.probeDeleteCalls, 1)
	}
	// Real registry macro stops after a partial cascade-child unknown result, even when stopOnError is false.
	{
		const state = makeEda({ wires: ['wire-macro-unknown'], attributes: [{ id: 'label-macro-unknown', parentId: 'wire-macro-unknown' }], failAttributeListAt: 3 })
		globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ documentType: 1, uuid: 'doc-A' })
		let markerWrites = 0
		registerCommand(schematicCommands.find(def => def.name === 'schematic.delete'))
		registerCommand({ name: 'test.markerWrite', summary: 'test marker', params: [], returns: '', handler: async () => { markerWrites++; return { wrote: true } } })
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'schematic.delete', params: { primitiveIds: ['wire-macro-unknown', 'label-macro-unknown'] } },
			{ cmd: 'test.markerWrite' },
		] } })
		assert.equal(result.ok, false)
		assert.equal(result.error?.cause?.partial, true, 'registry macro preserves the delete partial cause')
		assert.equal(result.data?.stoppedReason, 'partial')
		assert.equal(result.data?.unexecutedSteps, 1)
		assert.equal(result.data?.steps?.[0]?.error?.cause?.result?.outcomeBy?.['label-macro-unknown'], 'unknown')
		assert.equal(markerWrites, 0, 'macro must not execute a later write after cascade uncertainty')
		assert.equal(state.deleteCalls, 1)
	}
	// getNetlist defaults to the explicit Protel2 enum and preserves caller-supplied values.
	{
		const received = []
		globalThis.eda = { sch_Netlist: { getNetlist: async (...args) => { received.push(args); return 'net' } } }
		const defaultResult = await getNetlist({}, {})
		const explicitResult = await getNetlist({ netlistType: 'PADS' }, {})
		assert.equal(received[0][0], 'Protel2')
		assert.equal(received[1][0], 'PADS')
		assert.equal(defaultResult.netlistType, 'Protel2')
		assert.equal(explicitResult.netlistType, 'PADS')
	}
})

console.log('PASS handler scenarios, registry macro cascade-stop, and getNetlist default/explicit formats')
