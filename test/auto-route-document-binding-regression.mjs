import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const root = resolve(import.meta.dirname, '..')
const pcbSourceOverride = process.env.PCB_SOURCE_OVERRIDE
const built = await build({
	stdin: {
		contents: `import { pcbCommands } from '../src/commands/pcb.ts'; import { parseAutoRouteSes, mapSesRoutes, serializeSesSubset } from '../src/engine/autoRouteSes.ts'; export { pcbCommands, parseAutoRouteSes, mapSesRoutes, serializeSesSubset }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'auto-route-document-binding-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
	...(pcbSourceOverride ? { plugins: [{
		name: 'pcb-source-baseline-override',
		setup(builder) {
			builder.onLoad({ filter: /[\\/]src[\\/]commands[\\/]pcb\.ts$/u }, args => ({
				contents: readFileSync(pcbSourceOverride, 'utf8'),
				loader: 'ts',
				resolveDir: resolve(root, 'src', 'commands'),
			}))
		},
	}] } : {}),
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands, parseAutoRouteSes, mapSesRoutes, serializeSesSubset } = await import(moduleUrl)
const command = name => pcbCommands.find(item => item.name === name)
const realSes = readFileSync(resolve(root, 'test/fixtures/auto-route-real-v223.ses'), 'utf8').replaceAll('"ACE_IN_A"', '"中文(主网)"')

let activeUuid = 'pcb-A'
let focusSequence = []
let documentSourceReads = 0
let nextPrimitive = 0
let nextSourceTicket = 0
const sourceTickets = new Map()
let routeLines = []
let routeVias = []
let pouredPresent = true
let sourceReadCount = 0
let neverSourceReadAt = -1
let delayBeforeRecoveryDiagnosticWrite = false
let hostRouteReadCount = 0
const sourceRecord = (type, id, data) => {
	const key = `${type}\0${id}`
	if (!sourceTickets.has(key)) sourceTickets.set(key, ++nextSourceTicket)
	return `${JSON.stringify({ type, id, ticket: sourceTickets.get(key) })}||${JSON.stringify(data)}`
}
const documentSource = () => [
	`${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid: activeUuid })}`,
	...(pouredPresent ? [sourceRecord('POURED', 'pour-1', { layer: 1, net: 'GND', outline: 'stable-pour' })] : []),
	...routeLines.map(item => sourceRecord('LINE', item.id, { net: item.net, layer: item.layer, width: item.widthMil, a: item.a, b: item.b })),
	...routeVias.map(item => sourceRecord('VIA', item.id, { net: item.net, x: item.x, y: item.y, diameter: item.diameterMil, hole: item.holeDiameterMil, viaType: item.viaType })),
].join('|\n') + '|'
const storage = new Map()
const snapshotWrites = []
const calls = []
let failNextSesImport = false
let mutateSourceOnFailedSesImport = false
let sesImportMode = 'normal'
let addLineDuringNoopImport = false
let recoveryStripPoured = false
let recoveryWriteSucceeds = true
let jobNumber = 0
let drcThrows = false
const statusSequences = new Map()
let failCancelPut = false
const sdkItem = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]))
const lineItem = item => sdkItem({ PrimitiveId: item.id, Net: item.net, Layer: item.layer, LineWidth: item.widthMil, StartX: item.a.x, StartY: item.a.y, EndX: item.b.x, EndY: item.b.y, PrimitiveLock: item.locked ?? false })
const viaItem = item => sdkItem({ PrimitiveId: item.id, Net: item.net, X: item.x, Y: item.y, Diameter: item.diameterMil, HoleDiameter: item.holeDiameterMil, ViaType: item.viaType === 'through' ? 0 : item.viaType, PrimitiveLock: item.locked ?? false })
const dsnFile = new Blob(['dsn'])
Object.defineProperty(dsnFile, 'name', { value: 'design.dsn' })
globalThis.eda = {
	pcb_Net: { getAllNetsName: async () => ['MIN_LENGTH_BOUNDARY', 'MIN_LENGTH_BATCH', 'MIN_DELTA'] },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: focusSequence.length ? focusSequence.shift() : activeUuid }) },
	sys_FileManager: {
		getDocumentSource: async () => {
			documentSourceReads++
			sourceReadCount++
			if (sourceReadCount === neverSourceReadAt) return new Promise(() => {})
			return documentSource()
		},
		setDocumentSource: async source => { calls.push({ type: 'restore-source', source }); pouredPresent = source.includes('POURED') && !recoveryStripPoured; return recoveryWriteSucceeds },
	},
	sys_Storage: {
		setExtensionUserConfig: async (key, value) => {
			snapshotWrites.push({ key, value })
			if (delayBeforeRecoveryDiagnosticWrite && key.includes(':beforeRecovery')) {
				delayBeforeRecoveryDiagnosticWrite = false
				await new Promise(resolve => setTimeout(resolve, 700))
			}
			storage.set(key, value)
			return true
		},
		getExtensionUserConfig: key => storage.get(key),
	},
	pcb_ManufactureData: { getDsnFile: async () => dsnFile },
	pcb_Layer: { getAllLayers: async () => { hostRouteReadCount++; return [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }, { id: 2, name: 'BottomLayer', type: 'SIGNAL' }] } },
	pcb_PrimitiveLine: {
		getAll: async () => { hostRouteReadCount++; return routeLines.map(lineItem) },
		getAllPrimitiveId: async () => { calls.push('enumerate-lines'); return routeLines.map(item => item.id) },
		get: async id => { calls.push({ type: 'line-get', id }); const item = routeLines.find(line => line.id === id); return item ? lineItem(item) : undefined },
		create: async (net, layer, x1, y1, x2, y2, widthMil) => {
			calls.push('line-create')
			const item = { id: `line-${++nextPrimitive}`, net, layer, widthMil, a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, locked: false }
			if (sesImportMode === 'delete-poured' || sesImportMode === 'delete-poured-noop') pouredPresent = false
			if (sesImportMode !== 'noop' && sesImportMode !== 'delete-poured-noop') routeLines.push(item)
			if (addLineDuringNoopImport && (sesImportMode === 'noop' || sesImportMode === 'delete-poured-noop')) {
				addLineDuringNoopImport = false
				routeLines.push({ id: `noop-source-change-${++nextPrimitive}`, net: 'Nextra', layer: 1, widthMil: 8, a: { x: -500, y: -500 }, b: { x: -450, y: -500 }, locked: false })
			}
			return sdkItem({ PrimitiveId: item.id })
		},
		delete: async ids => { calls.push('line-delete'); routeLines = routeLines.filter(item => !ids.includes(item.id)); return true },
	},
	pcb_PrimitiveVia: {
		getAll: async () => { hostRouteReadCount++; return routeVias.map(viaItem) },
		getAllPrimitiveId: async () => { calls.push('enumerate-vias'); return routeVias.map(item => item.id) },
		get: async id => { calls.push({ type: 'via-get', id }); const item = routeVias.find(via => via.id === id); return item ? viaItem(item) : undefined },
		create: async (net, x, y, holeDiameterMil, diameterMil) => {
			calls.push('via-create')
			const item = { id: `via-${++nextPrimitive}`, net, x, y, diameterMil, holeDiameterMil, viaType: 0, locked: false }
			routeVias.push(item)
			return sdkItem({ PrimitiveId: item.id })
		},
		delete: async ids => { calls.push('via-delete'); routeVias = routeVias.filter(item => !ids.includes(item.id)); return true },
	},
	pcb_PrimitiveArc: {
		getAll: async () => { hostRouteReadCount++; return [] },
		getAllPrimitiveId: async () => { calls.push('enumerate-arcs'); return [] },
		delete: async () => { calls.push('arc-delete'); return true },
	},
	pcb_Document: {
		startCalculatingRatline: async () => { calls.push('clear-start'); return true },
		importAutoRouteSesFile: async (file) => {
			calls.push('ses-import')
			if (failNextSesImport) {
				failNextSesImport = false
				if (mutateSourceOnFailedSesImport) { mutateSourceOnFailedSesImport = false; pouredPresent = false }
				return false
			}
			const importedText = await file.text()
			calls.push({ type: 'import-text', importedText })
			if (sesImportMode === 'delete-poured' || sesImportMode === 'delete-poured-noop') pouredPresent = false
			if (sesImportMode === 'noop' || sesImportMode === 'delete-poured-noop') {
				if (addLineDuringNoopImport) {
					addLineDuringNoopImport = false
					routeLines.push({ id: `noop-source-change-${++nextPrimitive}`, net: 'Nextra', layer: 1, widthMil: 8, a: { x: -500, y: -500 }, b: { x: -450, y: -500 }, locked: false })
				}
				return true
			}
			const expected = mapSesRoutes(parseAutoRouteSes(importedText), [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }, { id: 2, name: 'BottomLayer', type: 'SIGNAL' }])
			routeLines = expected.lines.map(line => ({ ...line, id: `line-${++nextPrimitive}`, locked: false }))
			routeVias = expected.vias.map(via => ({ ...via, id: `via-${++nextPrimitive}`, holeDiameterMil: 12, viaType: 0, locked: false }))
			return true
		},
	},
	pcb_Drc: { check: async (...args) => { calls.push({ type: 'drc-check', args }); if (drcThrows) throw new Error('DRC unavailable'); return [] } },
	sys_ClientUrl: {
		request: async (url, method, body) => {
			calls.push({ url, method, body })
			if (method === 'PUT' && url.endsWith('/cancel') && failCancelPut)
				throw new Error('cancel PUT failed')
			return {
				ok: true,
				status: 200,
				json: async () => {
					if (url.endsWith('/sessions/create')) { jobNumber++; return { id: `session-${String.fromCharCode(64 + jobNumber)}` } }
					if (url.endsWith('/jobs/enqueue')) return { id: `job-${String.fromCharCode(64 + jobNumber)}` }
					if (/\/jobs\/[^/]+$/.test(url)) {
						const id = url.slice(url.lastIndexOf('/') + 1)
						const states = statusSequences.get(id)
						if (states?.length) return { state: states.shift() }
						return { state: 'COMPLETED' }
					}
					if (/\/jobs\/job-[A-Z]\/output$/.test(url)) return { data: Buffer.from(realSes).toString('base64'), filename: 'route.ses' }
					return {}
				},
			}
		},
	},
}

await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
activeUuid = 'pcb-B'
const statusCommand = command('pcb.autoRouteStatus')
const assertStatusOnly = async (jobId, noImport) => {
	const before = { calls: calls.length, sources: documentSourceReads, snapshots: snapshotWrites.length, hostRoutes: hostRouteReadCount }
	const result = await statusCommand.handler({ jobId, ...(noImport === undefined ? {} : { noImport }) }, {})
	assert.equal(result.state, 'COMPLETED')
	assert.equal(result.imported, false)
	assert.equal(result.autoImportEnabled, false)
	assert.equal(typeof result.note, 'string')
	assert.match(result.note, /停用|关闭|仅查询|不自动回灌/)
	const afterCalls = calls.slice(before.calls)
	assert.equal(afterCalls.filter(call => typeof call === 'object' && call.url?.endsWith(`/jobs/${jobId}/output`)).length, 0, `noImport=${String(noImport)} does not fetch SES output`)
	assert.equal(afterCalls.some(call => ['enumerate-lines', 'enumerate-vias', 'enumerate-arcs', 'line-delete', 'via-delete', 'arc-delete', 'clear-start', 'ses-import', 'line-create', 'via-create'].includes(call) || call?.type === 'drc-check'), false, `noImport=${String(noImport)} performs no PCB write or DRC`)
	assert.equal(documentSourceReads, before.sources, `noImport=${String(noImport)} does not capture PCB source`)
	assert.equal(snapshotWrites.length, before.snapshots, `noImport=${String(noImport)} does not write recovery snapshots`)
	assert.equal(hostRouteReadCount, before.hostRoutes, `noImport=${String(noImport)} does not enumerate host route geometry`)
	return result
}

const completedWithoutImport = await assertStatusOnly('job-A', true)
assert.equal(calls.some(call => typeof call === 'object' && call.url?.endsWith('/jobs/job-A/output')), false, 'status-only query never reads SES output even when focus changed')
assert.equal(calls.includes('enumerate-lines'), false, 'status-only query never enumerates route primitives')

for (const noImport of [undefined, true, false]) {
	const started = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
	await assertStatusOnly(started.jobId, noImport)
}

const completedStopStart = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
const completedStopStatus = await assertStatusOnly(completedStopStart.jobId)
const cancelPutsBeforeCompletedStop = calls.filter(call => call?.method === 'PUT' && call.url.endsWith('/cancel')).length
const completedStop = await command('pcb.autoRouteStop').handler({ jobId: completedStopStart.jobId }, {})
assert.equal(completedStop.cancelled, false)
assert.equal(completedStop.jobId, completedStopStart.jobId)
assert.equal(calls.filter(call => call?.method === 'PUT' && call.url.endsWith('/cancel')).length, cancelPutsBeforeCompletedStop, 'COMPLETED stop sends no cancel PUT')
const nextAfterCompletedStop = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
assert.notEqual(nextAfterCompletedStop.jobId, completedStopStart.jobId, 'COMPLETED stop releases only the default current-job slot')
const oldJobStatus = await assertStatusOnly(completedStopStart.jobId, false)
assert.equal(oldJobStatus.jobId, completedStopStart.jobId, 'explicit completed job remains queryable after default slot is released')
await command('pcb.autoRouteStop').handler({ jobId: nextAfterCompletedStop.jobId }, {})

statusSequences.set('queued-cancel', ['QUEUED', 'CANCELLED'])
const queuedCancelled = await command('pcb.autoRouteStop').handler({ jobId: 'queued-cancel' }, {})
assert.equal(queuedCancelled.cancelled, true, 'QUEUED to CANCELLED confirms cancellation')
statusSequences.set('queued-pending', ['QUEUED', 'QUEUED'])
const queuedPending = await command('pcb.autoRouteStop').handler({ jobId: 'queued-pending' }, {})
assert.equal(queuedPending.cancelled, false)
assert.equal(queuedPending.outcome, 'cancel-request-pending')
assert.equal(queuedPending.jobId, 'queued-pending', 'a still-QUEUED task ID remains available for later polling')
statusSequences.set('queued-put-fail', ['QUEUED'])
failCancelPut = true
await assert.rejects(() => command('pcb.autoRouteStop').handler({ jobId: 'queued-put-fail' }, {}), /cancel PUT failed/)
failCancelPut = false

routeLines = routeLines.map(item => ({ ...item, locked: true }))
routeVias = routeVias.map(item => ({ ...item, locked: true }))
const noChangeStart = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
await assertStatusOnly(noChangeStart.jobId, true)
routeLines.push({ id: 'unlocked-extra', net: 'Nextra', layer: 1, widthMil: 10, a: { x: -100, y: -100 }, b: { x: -50, y: -100 }, locked: false })
const clearOnlyStart = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
await assertStatusOnly(clearOnlyStart.jobId, false)

routeLines = []
routeVias = []
const importCount = () => calls.filter(call => ['ses-import', 'line-create', 'via-create'].includes(call)).length
const mappedFixture = mapSesRoutes(parseAutoRouteSes(realSes), [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }, { id: 2, name: 'BottomLayer', type: 'SIGNAL' }])
const policyLine = { net: 'MANUAL_POLICY_LINE', layer: 1, widthMil: 10, a: { x: 1000, y: 1000 }, b: { x: 1010, y: 1000 } }
const policyManualSes = serializeSesSubset(realSes, { lines: [policyLine], vias: mappedFixture.vias })
const realBase64 = Buffer.from(policyManualSes).toString('base64')
const lineOnlySes = serializeSesSubset(realSes, { lines: [policyLine], vias: [] })
const lineOnlyBase64 = Buffer.from(lineOnlySes).toString('base64')
const beforeAppend = importCount()
const appended = await command('pcb.importAutoRouteSes').handler({ base64: lineOnlyBase64 }, {})
assert.equal(appended.imported, true)
assert.equal(appended.sesGeometryVerified, true)
assert.equal(appended.backend, 'direct-primitives')
const afterAppendWrites = importCount()
assert.ok(afterAppendWrites > beforeAppend, 'a valid append creates and verifies route primitives')
const duplicate = await command('pcb.importAutoRouteSes').handler({ base64: lineOnlyBase64 }, {})
assert.deepEqual({ imported: duplicate.imported, alreadyPresent: duplicate.alreadyPresent, sesGeometryVerified: duplicate.sesGeometryVerified }, { imported: false, alreadyPresent: true, sesGeometryVerified: true })
assert.equal(importCount(), afterAppendWrites, 'a repeated append performs no geometry write')

const boundaryLine = { net: 'MIN_LENGTH_BOUNDARY', layer: 1, widthMil: 10, a: { x: 2000, y: 2000 }, b: { x: 2001, y: 2000 } }
const oneMilSes = serializeSesSubset(realSes, { lines: [boundaryLine], vias: [] })
const beforeOneMilAppend = importCount()
const oneMilAppend = await command('pcb.importAutoRouteSes').handler({ base64: Buffer.from(oneMilSes).toString('base64') }, {})
assert.equal(oneMilAppend.imported, true, 'manual SES append accepts a segment exactly 1 mil long')
assert.ok(importCount() > beforeOneMilAppend, 'the 1 mil boundary segment is created and verified')

const tooShortBatch = serializeSesSubset(realSes, { lines: [
	{ net: 'MIN_LENGTH_BATCH', layer: 1, widthMil: 10, a: { x: 3000, y: 3000 }, b: { x: 3010, y: 3000 } },
	{ net: 'MIN_LENGTH_BATCH', layer: 1, widthMil: 10, a: { x: 4000, y: 4000 }, b: { x: 4000.999, y: 4000 } },
], vias: [] })
const beforeRejectedBatch = importCount()
await assert.rejects(() => command('pcb.importAutoRouteSes').handler({ base64: Buffer.from(tooShortBatch).toString('base64') }, {}), /1 mil|短线|长度/)
assert.equal(importCount(), beforeRejectedBatch, 'a batch containing a sub-1-mil segment is rejected before any geometry write')

routeLines.push({ id: 'delta-almost-covered', net: 'MIN_DELTA', layer: 1, widthMil: 10, a: { x: 6000, y: 6000 }, b: { x: 6009.5, y: 6000 }, locked: false })
const shortDeltaSes = serializeSesSubset(realSes, { lines: [{ net: 'MIN_DELTA', layer: 1, widthMil: 10, a: { x: 6000, y: 6000 }, b: { x: 6010, y: 6000 } }], vias: [] })
const beforeShortDelta = importCount()
await assert.rejects(() => command('pcb.importAutoRouteSes').handler({ base64: Buffer.from(shortDeltaSes).toString('base64') }, {}), /1 mil|短线|长度/)
assert.equal(importCount(), beforeShortDelta, 'a full SES line whose append difference is under 1 mil is rejected before writes')

const routeTrack = command('pcb.routeTrack').handler
const beforeRouteTrack = calls.filter(call => call === 'line-create').length
await assert.rejects(() => routeTrack({ net: 'MIN_LENGTH_BATCH', points: [[7000, 0], [7010, 0], [7010.999, 0]], width: 10 }, {}), /1 mil|短线|长度/)
assert.equal(calls.filter(call => call === 'line-create').length, beforeRouteTrack, 'routeTrack rejects its entire batch before creating a valid earlier segment')
const routeTrackBoundary = await routeTrack({ net: 'MIN_LENGTH_BOUNDARY', points: [[7100, 0], [7101, 0]], width: 10 }, {})
assert.equal(routeTrackBoundary.segmentIds.length, 1, 'routeTrack accepts and verifies a segment exactly 1 mil long')

const diagnosticRecord = error => {
	const reference = error?.cause?.sesDiagnostic
	assert.equal(typeof reference?.ref, 'string', 'failure includes a stable diagnostic reference')
	const key = reference.storageKey
	assert.equal(key, `ses-failure-diagnostic:${activeUuid}:${reference.ref}:afterRecovery`)
	assert.equal(reference.available, true, 'diagnostic storage write is readback verified')
	assert.equal(reference.persisted, true, 'diagnostic reference reports persisted status separately')
	assert.equal(typeof reference.record, 'object', 'the failed command response carries its diagnostic record inline')
	assert.deepEqual(reference.record, JSON.parse(storage.get(key)), 'inline and persisted diagnostic records match')
	return reference.record
}
activeUuid = 'pcb-diagnostic-unchanged'
routeLines = []
routeVias = []
pouredPresent = true
sesImportMode = 'noop'
let unchangedError
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}) }
catch (error) { unchangedError = error }
assert.match(unchangedError?.message ?? '', /SES 路由几何(?:读回不匹配|未通过验证)/)
let unchangedDiagnostic = diagnosticRecord(unchangedError)
assert.deepEqual(unchangedDiagnostic.sdk, { attempted: true, returned: true, threw: false, result: true })
assert.equal(unchangedDiagnostic.beforeRecovery.routeSnapshot.lines.length, 0, 'SDK true with unchanged geometry captures missing lines before recovery')
assert.equal(unchangedDiagnostic.beforeRecovery.routeSnapshot.vias.length, 0, 'SDK true with unchanged geometry captures missing vias before recovery')
const expectedDiagnosticGeometry = mapSesRoutes(parseAutoRouteSes(policyManualSes), [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }, { id: 2, name: 'BottomLayer', type: 'SIGNAL' }])
assert.equal(expectedDiagnosticGeometry.lines.length, 1, 'the manual fixture contains one policy-compliant routed segment')
assert.equal(unchangedDiagnostic.expectedGeometry.lines.length, expectedDiagnosticGeometry.lines.length, 'the diagnostic preserves every expected segment for comparison')
assert.equal(unchangedDiagnostic.beforeRecovery.routeSnapshot.lines.length, 0, 'all expected segments remain missing when the SDK returns true without writing')
assert.match(unchangedDiagnostic.sdkInput.text, /\(session/)
assert.equal(typeof unchangedDiagnostic.sdkInput.utf8Bytes, 'number')
assert.match(unchangedDiagnostic.sdkInputHash, /^[0-9a-f]{64}$/)
assert.equal(unchangedDiagnostic.afterRecovery.source.includes('POURED'), true)

activeUuid = 'pcb-diagnostic-five-missing'
routeLines = []
routeVias = []
pouredPresent = true
sesImportMode = 'noop'
let fiveMissingError
try { await command('pcb.importAutoRouteSes').handler({ base64: lineOnlyBase64 }, {}) }
catch (error) { fiveMissingError = error }
assert.match(fiveMissingError?.message ?? '', /SES 路由几何(?:读回不匹配|未通过验证)|未出现在完整 ID 列表|本批完整前缀几何不等价/)
const fiveMissingDiagnostic = diagnosticRecord(fiveMissingError)
assert.equal(fiveMissingDiagnostic.backend, 'direct-primitives')
assert.deepEqual(fiveMissingDiagnostic.sdk, { attempted: false, returned: false, threw: false }, 'direct primitive import does not claim the native SES SDK ran')
assert.equal(fiveMissingDiagnostic.deltaGeometry.lines.length, 1, 'the policy-compliant manual fixture requests one new line segment')
assert.equal(fiveMissingDiagnostic.beforeRecovery.routeSnapshot.lines.length, 0, 'unconfirmed direct writes leave the empty baseline unchanged')
assert.equal(fiveMissingDiagnostic.beforeRecovery.routeSnapshot.vias.length, 0, 'the empty baseline has no vias')

activeUuid = 'pcb-diagnostic-import-pour'
routeLines = []
routeVias = []
pouredPresent = true
sesImportMode = 'delete-poured-noop'
let importPourError
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}) }
catch (error) { importPourError = error }
assert.match(importPourError?.message ?? '', /专用恢复未能确认/)
const importPourDiagnostic = diagnosticRecord(importPourError)
assert.equal(importPourDiagnostic.beforeRecovery.source.includes('POURED'), false, 'the importer-phase evidence shows POURED missing before recovery')
assert.equal(importPourDiagnostic.afterRecovery.source.includes('POURED'), false, 'specialized route recovery does not claim to restore unrelated source changes')
assert.equal(importPourError.cause.partial, true)
assert.equal(importPourError.cause.restored, false)

activeUuid = 'pcb-diagnostic-recovery-pour'
routeLines = []
routeVias = []
pouredPresent = true
sesImportMode = 'noop'
recoveryStripPoured = true
addLineDuringNoopImport = true
let recoveryPourError
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}) }
catch (error) { recoveryPourError = error }
assert.match(recoveryPourError?.message ?? '', /(专用恢复未能确认|恢复未确认)/)
const recoveryPourDiagnostic = diagnosticRecord(recoveryPourError)
assert.equal(recoveryPourDiagnostic.beforeRecovery.source.includes('POURED'), true, 'the pre-recovery source proves the importer retained POURED')
assert.equal(recoveryPourDiagnostic.afterRecovery.source.includes('POURED'), true, 'the diagnostic confirms POURED remains when recovery refuses unrelated route drift')
assert.equal(recoveryPourError.cause.partial, true)
assert.equal(recoveryPourError.cause.restored, false)
recoveryStripPoured = false
sesImportMode = 'normal'

activeUuid = 'pcb-diagnostic-phase-timeout'
routeLines = []
routeVias = []
pouredPresent = true
sesImportMode = 'noop'
neverSourceReadAt = sourceReadCount + 5 // capture snapshot, native-import fresh snapshot, final verification, width-rule source-stability check, then the pre-recovery diagnostic source read
delayBeforeRecoveryDiagnosticWrite = true
const routeReadsBeforeTimeout = hostRouteReadCount
let timeoutDiagnosticError
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64, _timeoutMs: 4_000 }, {}) }
catch (error) { timeoutDiagnosticError = error }
neverSourceReadAt = -1
assert.match(timeoutDiagnosticError?.message ?? '', /SES 路由几何(?:读回不匹配|未通过验证)/)
const timeoutDiagnostic = diagnosticRecord(timeoutDiagnosticError)
assert.ok(timeoutDiagnostic.issues.some(issue => issue.includes('beforeRecovery-source-timeout')))
assert.ok(timeoutDiagnostic.issues.some(issue => issue.includes('beforeRecovery-storage-timeout')))
assert.equal(hostRouteReadCount - routeReadsBeforeTimeout, 20, 'helper readbacks run, but a timed-out diagnostic source phase prevents its later route reads')
const inlineDiagnosticBeforeLateCompletion = JSON.stringify(timeoutDiagnosticError.cause.sesDiagnostic.record)
const finalDiagnosticKey = timeoutDiagnosticError.cause.sesDiagnostic.storageKey
const finalDiagnosticTextBeforeLateCompletion = storage.get(finalDiagnosticKey)
const beforeDiagnosticKey = `ses-failure-diagnostic:${activeUuid}:${timeoutDiagnostic.ref}:beforeRecovery`
assert.notEqual(finalDiagnosticKey, beforeDiagnosticKey)
await new Promise(resolve => setTimeout(resolve, 300))
assert.equal(JSON.stringify(timeoutDiagnosticError.cause.sesDiagnostic.record), inlineDiagnosticBeforeLateCompletion, 'late source and storage completion cannot mutate the inline diagnostic record')
assert.equal(storage.get(finalDiagnosticKey), finalDiagnosticTextBeforeLateCompletion, 'the late before-recovery write cannot replace the final after-recovery record')
assert.equal(typeof storage.get(beforeDiagnosticKey), 'string', 'a late before-recovery write may complete under its own key')
assert.equal(JSON.parse(storage.get(finalDiagnosticKey)).afterRecovery.source.includes('POURED'), true)
assert.equal(JSON.parse(storage.get(beforeDiagnosticKey)).afterRecovery, undefined, 'the phase-specific before record stays separate')
sesImportMode = 'normal'

activeUuid = 'pcb-diagnostic-guard-reject'
routeLines = []
routeVias = []
pouredPresent = true
const importCountBeforeGuard = importCount()
focusSequence = [...Array(16).fill(activeUuid), 'pcb-diagnostic-guard-other']
let guardRejectedError
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}) }
catch (error) { guardRejectedError = error }
assert.match(guardRejectedError?.message ?? '', /焦点文档已变化/)
assert.equal(importCount(), importCountBeforeGuard, 'a focus rejection in the final write guard never calls the SDK importer')
const guardDiagnostic = diagnosticRecord(guardRejectedError)
assert.deepEqual(guardDiagnostic.sdk, { attempted: false, returned: false, threw: false }, 'a write-gate rejection preserves the unattempted SDK state')

const routeWriteCount = () => calls.filter(call => ['clear-start', 'line-delete', 'via-delete', 'arc-delete', 'ses-import', 'line-create', 'via-create'].includes(call)).length + calls.filter(call => call?.type === 'restore-source').length
const outputRequestCount = () => calls.filter(call => typeof call?.url === 'string' && call.url.endsWith('/output')).length
const drcCallCount = () => calls.filter(call => call?.type === 'drc-check').length

activeUuid = 'pcb-auto-status-isolation'
routeLines = []
routeVias = []
pouredPresent = true
failNextSesImport = false
mutateSourceOnFailedSesImport = false
recoveryWriteSucceeds = true
await assert.rejects(() => command('pcb.autoRouteStop').handler({}, {}), /没有进行中的布线任务/)
const isolatedStart = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
const beforeIsolatedStatus = { snapshots: snapshotWrites.length, writes: routeWriteCount(), sourceReads: documentSourceReads, outputs: outputRequestCount(), drc: drcCallCount(), hostRoutes: hostRouteReadCount }
const isolatedStatus = await command('pcb.autoRouteStatus').handler({ jobId: isolatedStart.jobId }, {})
assert.equal(isolatedStatus.state, 'COMPLETED')
assert.equal(isolatedStatus.imported, false)
assert.equal(isolatedStatus.autoImportEnabled, false)
assert.equal(snapshotWrites.length, beforeIsolatedStatus.snapshots, 'query-only status does not write recovery snapshots')
assert.equal(routeWriteCount(), beforeIsolatedStatus.writes, 'query-only status performs no PCB route or source write')
assert.equal(documentSourceReads, beforeIsolatedStatus.sourceReads)
assert.equal(outputRequestCount(), beforeIsolatedStatus.outputs, 'query-only status never fetches route output')
assert.equal(drcCallCount(), beforeIsolatedStatus.drc, 'query-only status never runs DRC')
assert.equal(hostRouteReadCount, beforeIsolatedStatus.hostRoutes, 'query-only status never snapshots PCB routes')
const manualAfterStatus = await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {})
assert.equal(manualAfterStatus.imported, true, 'a completed status query releases the default slot and leaves manual append available')
const beforeRepeatStatus = { snapshots: snapshotWrites.length, writes: routeWriteCount(), sourceReads: documentSourceReads, outputs: outputRequestCount(), drc: drcCallCount(), hostRoutes: hostRouteReadCount }
const repeatedStatus = await command('pcb.autoRouteStatus').handler({ jobId: isolatedStart.jobId }, {})
assert.equal(repeatedStatus.state, 'COMPLETED')
assert.equal(repeatedStatus.imported, false)
assert.equal(repeatedStatus.autoImportEnabled, false)
assert.equal(snapshotWrites.length, beforeRepeatStatus.snapshots)
assert.equal(routeWriteCount(), beforeRepeatStatus.writes)
assert.equal(documentSourceReads, beforeRepeatStatus.sourceReads)
assert.equal(outputRequestCount(), beforeRepeatStatus.outputs)
assert.equal(drcCallCount(), beforeRepeatStatus.drc)
assert.equal(hostRouteReadCount, beforeRepeatStatus.hostRoutes)

activeUuid = 'pcb-manual-recovery'
routeLines = []
routeVias = []
pouredPresent = true
failNextSesImport = true
mutateSourceOnFailedSesImport = true
recoveryWriteSucceeds = false
let manualFailure
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}) }
catch (error) { manualFailure = error }
assert.match(manualFailure?.message ?? '', /(专用恢复未能确认|恢复未确认)/)
assert.equal(manualFailure?.cause?.partial, true)
assert.equal(manualFailure?.cause?.restored, false)
assert.equal(manualFailure?.cause?.retryable, false)
const beforeManualRetry = { snapshots: snapshotWrites.length, writes: routeWriteCount(), sources: documentSourceReads, outputs: outputRequestCount(), drc: drcCallCount() }
assert.equal(manualFailure?.cause?.retryable, false, 'the failed operation itself remains non-retryable')
failNextSesImport = false
mutateSourceOnFailedSesImport = false
recoveryWriteSucceeds = true
const sameBoardAfterPartial = await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {})
assert.equal(sameBoardAfterPartial.imported, true, 'a new same-board request reaches normal validation/import after the prior partial failure')
assert.ok(snapshotWrites.length > beforeManualRetry.snapshots, 'the independent request captures fresh recovery snapshots')
assert.ok(routeWriteCount() > beforeManualRetry.writes, 'the independent request runs the ordinary import path')
assert.ok(documentSourceReads > beforeManualRetry.sources)
assert.ok(outputRequestCount() >= beforeManualRetry.outputs)
assert.equal(drcCallCount(), beforeManualRetry.drc, 'manual append does not add an unrelated DRC operation')

activeUuid = 'pcb-independent'
routeLines = []
routeVias = []
pouredPresent = true
failNextSesImport = false
mutateSourceOnFailedSesImport = false
recoveryWriteSucceeds = true
const independent = await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {})
assert.equal(independent.imported, true, 'an unrelated PCB UUID remains independently writable')

activeUuid = 'pcb-recovery-confirmed'
routeLines = []
routeVias = []
pouredPresent = true
failNextSesImport = true
mutateSourceOnFailedSesImport = false
recoveryWriteSucceeds = true
const beforeNoChangeRecovery = calls.filter(call => call?.type === 'restore-source').length
let noChangeImportError
try { await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}) }
catch (error) { noChangeImportError = error }
assert.match(noChangeImportError?.message ?? '', /导入|SES|路由几何/)
assert.equal(noChangeImportError?.cause?.restored, true)
assert.equal(noChangeImportError?.cause?.noRecoveryWriteNeeded, true)
assert.equal(noChangeImportError?.cause?.retryable, true)
assert.equal(calls.filter(call => call?.type === 'restore-source').length, beforeNoChangeRecovery, 'unchanged failed native import requires no source restore')
const retryAfterConfirmedRecovery = await command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {})
assert.equal(retryAfterConfirmedRecovery.imported, true, 'a confirmed no-change recovery leaves the same document retryable')

await assert.rejects(() => command('pcb.autoRouteStop').handler({}, {}), /没有进行中的布线任务/)
activeUuid = 'pcb-manual-preflight-A'
const manualPriorKey = 'ai-command-engine:destructive-recovery:pcb.importAutoRouteSes:locked-B'
storage.set(manualPriorKey, 'manual-prior-snapshot-bytes')
focusSequence = ['pcb-manual-preflight-A', 'locked-B']
const beforeManualPreflight = { writes: snapshotWrites.length, reads: documentSourceReads }
await assert.rejects(() => command('pcb.importAutoRouteSes').handler({ base64: realBase64 }, {}), /快照目标 UUID 与预期不一致/)
assert.equal(snapshotWrites.length, beforeManualPreflight.writes)
assert.equal(documentSourceReads, beforeManualPreflight.reads, 'manual capture rejects focus change before source reads')
assert.equal(storage.get(manualPriorKey), 'manual-prior-snapshot-bytes')

activeUuid = 'pcb-auto-preflight-A'
const autoPreflightStart = await command('pcb.autoRouteStart').handler({ skipDrc: true }, {})
const autoPriorKey = 'ai-command-engine:destructive-recovery:pcb.autoRouteStatus:locked-B'
storage.set(autoPriorKey, 'auto-prior-snapshot-bytes')
focusSequence = ['pcb-auto-preflight-A', 'locked-B']
const beforeAutoPreflight = { writes: routeWriteCount(), snapshots: snapshotWrites.length, reads: documentSourceReads, outputs: outputRequestCount(), drc: drcCallCount(), hostRoutes: hostRouteReadCount, pendingFocus: [...focusSequence] }
const autoPreflightStatus = await command('pcb.autoRouteStatus').handler({ jobId: autoPreflightStart.jobId }, {})
assert.equal(autoPreflightStatus.state, 'COMPLETED')
assert.equal(autoPreflightStatus.imported, false)
assert.equal(autoPreflightStatus.autoImportEnabled, false)
assert.equal(routeWriteCount(), beforeAutoPreflight.writes)
assert.equal(snapshotWrites.length, beforeAutoPreflight.snapshots)
assert.equal(documentSourceReads, beforeAutoPreflight.reads)
assert.equal(outputRequestCount(), beforeAutoPreflight.outputs)
assert.equal(drcCallCount(), beforeAutoPreflight.drc)
assert.equal(hostRouteReadCount, beforeAutoPreflight.hostRoutes)
assert.deepEqual(focusSequence, beforeAutoPreflight.pendingFocus, 'query-only status does not consume or inspect focused-document state')
assert.equal(storage.get(autoPriorKey), 'auto-prior-snapshot-bytes', 'query-only status preserves unrelated recovery storage')
focusSequence = []
console.log('PASS manual SES failure recovery stays isolated; autoRouteStatus performs query-only polling without writes')

