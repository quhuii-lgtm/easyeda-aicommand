import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "import { pcbCommands } from '../src/commands/pcb.ts'; import { applySesViaHoleDiameters, mapSesRoutes, parseAutoRouteSes, serializeSesSubset } from '../src/engine/autoRouteSes.ts'; export { pcbCommands, applySesViaHoleDiameters, mapSesRoutes, parseAutoRouteSes, serializeSesSubset }", resolveDir: resolve(root, 'test'), sourcefile: 'ses-route-hole-diameter-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { pcbCommands, applySesViaHoleDiameters, mapSesRoutes, parseAutoRouteSes, serializeSesSubset } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const command = pcbCommands.find(item => item.name === 'pcb.importAutoRouteSes')
const sesText = await readFile(resolve(root, 'test/fixtures/auto-route-inner-host-v062.ses'), 'utf8')
const widthsSesText = await readFile(resolve(root, 'test/fixtures/auto-route-inner-host-v063-exact-widths.ses'), 'utf8')
const layers = JSON.parse(await readFile(resolve(root, 'test/fixtures/auto-route-inner-host-v062-layers.json'), 'utf8'))
const baseExpected = mapSesRoutes(parseAutoRouteSes(sesText), layers)
const widthsExpected = mapSesRoutes(parseAutoRouteSes(widthsSesText), layers)
assert.equal(baseExpected.lines.length, 10)
assert.equal(baseExpected.vias.length, 4)
assert.equal(widthsExpected.lines.length, 10)
assert.deepEqual(new Set(widthsExpected.lines.map(line => `${line.net}:${line.widthMil}`)), new Set(['+5V:10.05', 'ACE_VIA:7.536']))
const viasOnlySes = serializeSesSubset(sesText, { ...baseExpected, lines: [], vias: baseExpected.vias })
const encode = text => Buffer.from(text, 'utf8').toString('base64')

let uuid = 'hole-diameter-board'
let focusUuid = uuid
let lineRows = []
let viaRows = []
let nativeCalls = 0
let lineCreates = 0
let viaCreates = 0
let lineDeletes = 0
let viaDeletes = 0
let failNextViaCreate = false
let ratlineCalls = 0
let ratlineBehavior = 'accept'
let events = []
let nextId = 0
const storage = new Map()
const stateItem = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]))
const lineItem = line => stateItem({ PrimitiveId: line.id, Net: line.net, Layer: line.layer, LineWidth: line.widthMil, StartX: line.a.x, StartY: line.a.y, EndX: line.b.x, EndY: line.b.y, PrimitiveLock: line.locked ?? false })
const viaItem = via => ({ ...stateItem({ PrimitiveId: via.id, Net: via.net, X: via.x, Y: via.y, Diameter: via.diameterMil, HoleDiameter: via.holeDiameterMil, ViaType: via.viaType ?? 0, PrimitiveLock: via.locked ?? false }) })
const sourceRecord = (type, id, data) => `${JSON.stringify({ type, id })}||${JSON.stringify(data)}`
const source = () => [
	`${JSON.stringify({ type: 'DOCHEAD' })}||${JSON.stringify({ docType: 'PCB', uuid })}`,
	...lineRows.map(line => sourceRecord('LINE', line.id, { net: line.net, layer: line.layer, widthMil: line.widthMil, a: line.a, b: line.b })),
	...viaRows.map(via => sourceRecord('VIA', via.id, { net: via.net, x: via.x, y: via.y, diameterMil: via.diameterMil, holeDiameterMil: via.holeDiameterMil ?? null })),
].join('|\n') + '|'

globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: focusUuid }) },
	sys_FileManager: { getDocumentSource: async () => source() },
	sys_Storage: { setExtensionUserConfig: async (key, value) => { storage.set(key, value); return true }, getExtensionUserConfig: key => storage.get(key) },
	pcb_Layer: { getAllLayers: async () => layers },
	pcb_PrimitiveLine: {
		getAll: async () => lineRows.map(lineItem),
		getAllPrimitiveId: async () => lineRows.map(line => line.id),
		get: async id => { const line = lineRows.find(item => item.id === id); return line ? lineItem(line) : undefined },
		create: async (net, layer, x1, y1, x2, y2, widthMil) => {
			lineCreates++
			events.push('line-create')
			const line = { id: `line-${++nextId}`, net, layer, a: { x: x1, y: y1 }, b: { x: x2, y: y2 }, widthMil }
			lineRows.push(line)
			return stateItem({ PrimitiveId: line.id })
		},
		delete: async ids => { events.push('line-delete'); lineDeletes += ids.length; lineRows = lineRows.filter(line => !ids.includes(line.id)); return true },
	},
	pcb_PrimitiveVia: {
		getAll: async () => viaRows.map(viaItem),
		getAllPrimitiveId: async () => viaRows.map(via => via.id),
		get: async id => { events.push('via-read'); const via = viaRows.find(item => item.id === id); return via ? viaItem(via) : undefined },
		create: async (net, x, y, holeDiameterMil, diameterMil) => {
			events.push('via-create')
			if (failNextViaCreate) { failNextViaCreate = false; throw new Error('injected direct via create failure') }
			viaCreates++
			const via = { id: `via-${++nextId}`, net, x, y, holeDiameterMil, diameterMil, viaType: 0 }
			viaRows.push(via)
			return stateItem({ PrimitiveId: via.id })
		},
		delete: async ids => { events.push('via-delete'); viaDeletes += ids.length; viaRows = viaRows.filter(via => !ids.includes(via.id)); return true },
	},
	pcb_PrimitiveArc: { getAll: async () => [], getAllPrimitiveId: async () => [], delete: async () => true },
	pcb_Document: { startCalculatingRatline: async () => {
		ratlineCalls++
		events.push('ratline')
		if (ratlineBehavior === 'throw') throw new Error('injected ratline failure')
		if (ratlineBehavior === 'false') return false
		if (typeof ratlineBehavior === 'number') return await new Promise(resolve => setTimeout(() => resolve(true), ratlineBehavior))
		return true
	}, importAutoRouteSesFile: async file => {
		nativeCalls++
		const imported = mapSesRoutes(parseAutoRouteSes(await file.text()), layers)
		lineRows.push(...imported.lines.map(line => ({ ...line, id: `line-${++nextId}`, locked: false })))
		viaRows.push(...imported.vias.map(via => ({ ...via, id: `via-${++nextId}`, viaType: 0 })))
		return true
	} },
}

const lineKey = line => JSON.stringify({ net: line.net, layer: line.layer, widthMil: line.widthMil, endpoints: [line.a, line.b].map(point => [point.x, point.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) })
const viaKey = via => JSON.stringify({ net: via.net, x: via.x, y: via.y, diameterMil: via.diameterMil, holeDiameterMil: via.holeDiameterMil })
const assertLinesMatch = (actual, expected, message) => {
	assert.equal(actual.length, expected.length, message)
	for (const line of expected) {
		const match = actual.find(candidate => candidate.net === line.net && candidate.layer === line.layer && candidate.widthMil === line.widthMil && [candidate.a, candidate.b].every(point => [line.a, line.b].some(target => Math.hypot(point.x - target.x, point.y - target.y) <= 0.001)))
		assert.ok(match && [match.a, match.b].every(point => [line.a, line.b].some(target => Math.hypot(point.x - target.x, point.y - target.y) <= 0.001)), message)
	}
}
const emptyBoard = id => { uuid = id; focusUuid = id; lineRows = []; viaRows = []; events = []; ratlineBehavior = 'accept' }
const beforeWrites = () => ({ lineCreates, viaCreates, lineDeletes, viaDeletes, nativeCalls, ratlineCalls })
const assertNoWrites = before => assert.deepEqual(beforeWrites(), before, 'preflight failure performs no SDK primitive writes or native SES import')

emptyBoard('native-sample-high-precision')
const preciseResult = await command.handler({ base64: encode(sesText), viaHoleDiametersMil: { via0: 12 } }, {})
assert.equal(preciseResult.backend, 'direct-primitives')
assert.equal(preciseResult.created.lines, 10)
assert.equal(preciseResult.created.vias, 4)
assert.equal(nativeCalls, 0)
assertLinesMatch(lineRows, baseExpected.lines, 'direct SDK readback retains every original high-precision route coordinate, inner layer and 10 mil width')
const expectedCallerVias = applySesViaHoleDiameters(baseExpected, { via0: 12 }).vias
assert.deepEqual(viaRows.map(viaKey).sort(), expectedCallerVias.map(viaKey).sort())
assert.deepEqual(preciseResult.holeDiameterSources, ['caller-specified'])
assert.equal(baseExpected.holeDiameterStatus, 'not-specified-by-ses', 'caller drill input does not change the SES evidence status')
assert.equal(ratlineCalls, 4, 'manual direct import recalculates ratlines once after each of the four via readbacks')
assert.deepEqual(events.slice(0, 12), Array.from({ length: 4 }, () => ['via-create', 'via-read', 'ratline']).flat(), 'each verified via is followed by its own ratline request before route creation')
assert.equal(events.slice(12).filter(event => event === 'line-create').length, 10)
assert.ok(events.indexOf('line-create') > events.lastIndexOf('ratline'), 'all vias and ratline requests finish before any line is created')

emptyBoard('native-width-sample')
const widthsResult = await command.handler({ base64: encode(widthsSesText), viaHoleDiametersMil: { via0: 12 } }, {})
assert.equal(widthsResult.backend, 'direct-primitives')
assert.equal(nativeCalls, 0)
assertLinesMatch(lineRows, widthsExpected.lines, 'SDK create/readback keeps source +5V 10.05 mil and ACE_VIA 7.536 mil widths within the existing strict verifier')
assert.ok(lineRows.some(line => line.net === '+5V' && line.widthMil === 10.05))
assert.ok(lineRows.some(line => line.net === 'ACE_VIA' && line.widthMil === 7.536))
assert.equal(widthsResult.created.vias, 4)

emptyBoard('invalid-hole-maps')
for (const invalid of [null, [], { via0: '12' }, { via0: Number.NaN }, { via0: 24 }, { unknown: 12 }]) {
	const before = beforeWrites()
	await assert.rejects(() => command.handler({ base64: encode(viasOnlySes), viaHoleDiametersMil: invalid }, {}))
	assertNoWrites(before)
}
const uncoveredBefore = beforeWrites()
await assert.rejects(() => command.handler({ base64: encode(viasOnlySes), viaHoleDiametersMil: {} }, {}), /缺少可信孔径/)
assertNoWrites(uncoveredBefore)

const explicit = applySesViaHoleDiameters(baseExpected, { via0: 12 })
const seedBoardVias = hole => explicit.vias.map((via, index) => ({ ...via, id: `seed-${index}`, ...(hole === 'unknown' ? { holeDiameterMil: undefined } : { holeDiameterMil: hole }), viaType: 0 }))
emptyBoard('same-existing-drill')
viaRows = seedBoardVias(12)
const beforeIdempotent = beforeWrites()
const sameHoleResult = await command.handler({ base64: encode(viasOnlySes), viaHoleDiametersMil: { via0: 12 } }, {})
assert.equal(sameHoleResult.alreadyPresent, true)
assert.deepEqual(sameHoleResult.holeDiameterSources, ['caller-specified', 'existing-board-readback'])
assertNoWrites(beforeIdempotent)
for (const priorHole of [13, 'unknown']) {
	emptyBoard(`conflicting-existing-drill-${String(priorHole)}`)
	viaRows = seedBoardVias(priorHole)
	const beforeConflict = beforeWrites()
	await assert.rejects(() => command.handler({ base64: encode(viasOnlySes), viaHoleDiametersMil: { via0: 12 } }, {}), /孔径与现有同位置过孔孔径不一致或不可读/)
	assertNoWrites(beforeConflict)
}

emptyBoard('legacy-unspecified-hole')
const legacyResult = await command.handler({ base64: encode(viasOnlySes) }, {})
assert.equal(legacyResult.backend, 'native-ses', 'without caller input, SES unknown-drill behavior still selects the native importer')
assert.equal(legacyResult.holeDiameterStatus, 'not-specified-by-ses')
assert.deepEqual(legacyResult.holeDiameterSources, [])
assert.equal(nativeCalls, 1)

emptyBoard('direct-failure-no-native-retry')
failNextViaCreate = true
const beforeFailedDirect = beforeWrites()
let directFailure
try { await command.handler({ base64: encode(sesText), viaHoleDiametersMil: { via0: 12 } }, {}) }
catch (error) { directFailure = error }
assert.ok(directFailure)
assert.match(directFailure.message, /injected direct via create failure/)
assert.equal(directFailure.cause?.partial, true)
assert.equal(directFailure.cause?.retryable, false)
assert.equal(directFailure.cause?.compensation, 'skipped-unsettled-or-delete-started-or-budget')
assert.equal(directFailure.cause?.journal?.phase, 'create-via')
const failedWrites = directFailure.cause.journal.writes
assert.equal(failedWrites.filter(write => write.kind === 'create-line').length, 0, 'the failed via-first attempt never reaches line writes')
assert.equal(failedWrites.at(-1).kind, 'create-via')
assert.equal(failedWrites.at(-1).attempted, true)
assert.equal(failedWrites.at(-1).settlement, 'threw')
assert.equal(failedWrites.at(-1).confirmed, false)
assert.equal(failedWrites.some(write => write.kind.startsWith('compensate-')), false)
assert.equal(lineRows.length, 0, 'the failed first via leaves no route lines')
assert.equal(viaRows.length, 0)
assert.equal(nativeCalls, beforeFailedDirect.nativeCalls, 'a failed direct attempt is never retried through native SES')
assert.equal(viaCreates, beforeFailedDirect.viaCreates, 'no subsequent via create is attempted after the unsettled write')
assert.equal(ratlineCalls, beforeFailedDirect.ratlineCalls, 'ratline is not requested for a via whose create did not return')
assert.deepEqual(events, ['via-create'], 'failure on first via stops before line creation, ratline, or later vias')
assert.equal(lineDeletes, beforeFailedDirect.lineDeletes, 'no old route record is deleted during this failed append')
assert.equal(viaDeletes, beforeFailedDirect.viaDeletes, 'no old via record is deleted during this failed append')

emptyBoard('ratline-false-compensates-confirmed-new-via')
ratlineBehavior = 'false'
const beforeRejectedRatline = beforeWrites()
let rejectedRatline
try { await command.handler({ base64: encode(sesText), viaHoleDiametersMil: { via0: 12 } }, {}) }
catch (error) { rejectedRatline = error }
assert.ok(rejectedRatline)
assert.equal(rejectedRatline.cause?.partial, false, 'a false returned ratline result is compensated after the created via was verified')
assert.equal(rejectedRatline.cause?.retryable, true)
assert.equal(rejectedRatline.cause?.compensation, 'exact-new-route-primitives-deleted')
assert.equal(rejectedRatline.cause?.journal?.writes?.some(write => write.kind === 'calculate-ratline' && write.result === false && !write.confirmed), true)
assert.equal(lineRows.length, 0)
assert.equal(viaRows.length, 0)
assert.equal(events.includes('line-create'), false, 'false ratline result stops before every line and later via')
assert.equal(events.filter(event => event === 'via-create').length, 1)
assert.equal(events.filter(event => event === 'ratline').length, 1)
assert.equal(events.includes('via-delete'), true, 'only the verified new via is eligible for exact compensation')
assert.equal(nativeCalls, beforeRejectedRatline.nativeCalls)

emptyBoard('ratline-threw-stops-with-partial-via')
ratlineBehavior = 'throw'
const beforeThrownRatline = beforeWrites()
let thrownRatline
try { await command.handler({ base64: encode(sesText), viaHoleDiametersMil: { via0: 12 } }, {}) }
catch (error) { thrownRatline = error }
assert.ok(thrownRatline)
assert.equal(thrownRatline.cause?.partial, true)
assert.equal(thrownRatline.cause?.retryable, false)
assert.equal(thrownRatline.cause?.compensation, 'skipped-unsettled-or-delete-started-or-budget')
assert.equal(thrownRatline.cause?.journal?.writes?.some(write => write.kind === 'calculate-ratline' && write.settlement === 'threw'), true)
assert.equal(viaRows.length, 1, 'thrown ratline leaves the already-created via for inspection')
assert.equal(lineRows.length, 0)
assert.equal(events.filter(event => event === 'via-create').length, 1)
assert.equal(events.filter(event => event === 'ratline').length, 1)
assert.equal(events.includes('line-create'), false)
assert.equal(events.includes('via-delete'), false, 'unsettled ratline outcome is not compensated')
assert.equal(nativeCalls, beforeThrownRatline.nativeCalls)

emptyBoard('ratline-timeout-late-resolution-stops')
ratlineBehavior = 600
const beforeLateRatline = beforeWrites()
let lateRatlineFailure
try { await command.handler({ base64: encode(sesText), viaHoleDiametersMil: { via0: 12 }, _timeoutMs: 300 }, {}) }
catch (error) { lateRatlineFailure = error }
assert.ok(lateRatlineFailure)
assert.equal(lateRatlineFailure.cause?.partial, true)
assert.equal(lateRatlineFailure.cause?.retryable, false)
assert.equal(lateRatlineFailure.cause?.compensation, 'skipped-unsettled-or-delete-started-or-budget')
const afterTimeoutEvents = [...events]
await new Promise(resolve => setTimeout(resolve, 650))
assert.deepEqual(events, afterTimeoutEvents, 'late ratline completion does not unlock subsequent vias, lines, retries, or compensation')
assert.equal(viaRows.length, 1)
assert.equal(lineRows.length, 0)
assert.equal(events.filter(event => event === 'via-create').length, 1)
assert.equal(events.filter(event => event === 'ratline').length, 1)
assert.equal(events.includes('line-create'), false)
assert.equal(nativeCalls, beforeLateRatline.nativeCalls)
console.log('PASS caller-specified via drill mapping validates before writes, selects direct import, preserves source geometry/width, checks existing-hole conflicts and never native-retries')



