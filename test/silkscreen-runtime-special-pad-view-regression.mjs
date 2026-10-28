import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({ stdin: { contents: "import { extractFootprintPadMaskCandidates } from '../src/engine/footprintSilkscreen.ts'; import { analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'; export { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry }", resolveDir: resolve(root, 'test'), sourcefile: 'runtime-special-pad-view-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' })
const { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const mm = mil => (mil * 0.0254).toFixed(5)
const coord = mil => String(Math.round(mil * 2540))
const roundRectMacro = '%AMRoundRect*1,1,$1,$2,$3*1,1,$1,$4,$5*1,1,$1,0-$2,0-$3*1,1,$1,0-$4,0-$5*20,1,$1,$2,$3,$4,$5,0*20,1,$1,$4,$5,0-$2,0-$3,0*20,1,$1,0-$2,0-$3,0-$4,0-$5,0*20,1,$1,0-$4,0-$5,$2,$3,0*4,1,4,$2,$3,$4,$5,0-$2,0-$3,0-$4,0-$5,$2,$3,0*%'
const ovalMacro = '%AMOval*1,1,$1,$2,$3*1,1,$1,$4,$5*20,1,$1,$2,$3,$4,$5,0*%'

const sourceDefault = { padType: 'ELLIPSE', width: 44.125, height: 44.125, radius: 0 }
const sameRect = { padType: 'RECT', width: 50.125, height: 26.45, radius: 0 }
const physical2Oval = { padType: 'OVAL', width: 40.125, height: 20.125, radius: 0 }
const innerOval = { padType: 'OVAL', width: 44.125, height: 44.125, radius: 0 }
const baseSpecials = [
	{ startLayer: 1, endLayer: 2, pad: sameRect },
	{ startLayer: 1, endLayer: 1, pad: { ...sameRect } },
	{ startLayer: 12, endLayer: 12, pad: innerOval },
	{ startLayer: 2, endLayer: 2, pad: physical2Oval },
]
const normalizedTuples = [
	[2, 2, ['OVAL', 40.1, 20.1]],
	[12, 12, ['ELLIPSE', 44.1, 44.1]],
	[1, 1, ['RECT', 50.1, 26.5, 0]],
]
const unionShapes = [sameRect, sourceDefault, physical2Oval]

function projected(shape) {
	if (shape.padType === 'ELLIPSE') return { minX: -shape.width / 2, minY: -shape.width / 2, maxX: shape.width / 2, maxY: shape.width / 2 }
	if (shape.padType === 'OVAL') {
		const radius = Math.min(shape.width, shape.height) / 2
		const axis = Math.abs(shape.width - shape.height) / 2
		return { minX: -axis - radius, minY: -radius, maxX: axis + radius, maxY: radius }
	}
	return { minX: -shape.width / 2, minY: -shape.height / 2, maxX: shape.width / 2, maxY: shape.height / 2 }
}
function unionOf(shapes) {
	const boxes = shapes.map(projected)
	return { minX: Math.min(...boxes.map(b => b.minX)), minY: Math.min(...boxes.map(b => b.minY)), maxX: Math.max(...boxes.map(b => b.maxX)), maxY: Math.max(...boxes.map(b => b.maxY)) }
}
function fixture({ componentLayer = 1, specials = baseSpecials, tuples = normalizedTuples, shapeState = ['RECT', 50.1, 26.5, 0], bbox = unionOf(unionShapes), runtimePhysicalPadView, net = 'NET_R2', defaultShape = sourceDefault, localPadId = 'local-pad', nativeDsnText } = {}) {
	const componentId = 'component-r2'; const footprintUuid = 'footprint-r2'; const localId = localPadId; const center = [220, 180]
	const padData = { num: '1', layerId: 12, hole: { holeType: 'ROUND', width: 10, height: 10 }, defaultPad: defaultShape, specialPad: specials, padType: 'NORMAL', topSolderExpansion: 3, bottomSolderExpansion: 7, padLen: 0, padOffsetX: 0, padOffsetY: 0, relativeAngle: 0, plated: true }
	const source = [
		{ type: 'DOCHEAD', id: 'head', ticket: 0, data: { docType: 'FOOTPRINT', uuid: footprintUuid } },
		{ type: 'PAD', id: localId, ticket: 1, data: padData },
	].map(({ type, id, ticket, data }) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`).join('\n')
	const pcbRecords = [
		{ header: { type: 'COMPONENT', id: componentId, ticket: 1 }, data: { layerId: componentLayer, x: center[0], y: center[1], angle: 0 } },
		{ header: { type: 'ATTR', id: 'fp', ticket: 1 }, data: { key: 'Footprint', parentId: componentId, value: footprintUuid } },
		{ header: { type: 'PAD_NET', id: JSON.stringify(['PAD_NET', componentId, '1', localId]), ticket: 1 }, data: { padNet: '', padLen: null, attrsMap: {} } },
	]
	const box = { minX: center[0] + bbox.minX, minY: center[1] + bbox.minY, maxX: center[0] + bbox.maxX, maxY: center[1] + bbox.maxY }
	const snapshot = { id: 'runtime-r2', componentId, padNumber: '1', layer: 12, rotation: 0, shape: shapeState[0], shapeState, specialPadState: tuples, runtimePhysicalPadView, net, holeState: padData.hole, holeOffsetX: 0, holeOffsetY: 0, holeRotation: 0, metallization: true, box }
	return extractFootprintPadMaskCandidates({ pcbRecords, components: [{ getState_PrimitiveId: () => componentId }], footprintSources: [{ footprintUuid, documentSource: source }], projectLibrarySources: [], padSnapshots: [snapshot], sourceStable: true, ...(nativeDsnText === undefined ? {} : { nativeDsnText }) })
}

const normal = fixture()
assert.equal(normal.candidates.length, 2)
assert.deepEqual(normal.candidates.map(item => item.sourcePad.localSurface), [1, 2])
assert.ok(normal.candidates.every(item => item.runtimePad.runtimeBBoxModel === 'normalized-physical-1-12-2-union'))
assert.ok(normal.candidates.every(item => item.sourcePad.normalizedSpecialView?.bboxModel === 'normalized-physical-1-12-2-union'))
assert.deepEqual(normal.candidates[0].sourcePad.normalizedSpecialView.entries.map(item => item.startLayer), [1, 12, 2])
assert.deepEqual(normal.candidates[0].sourcePad.normalizedSpecialView.entries[0].sourceIndices, [0, 1], 'identical source geometries keep all source indices')
assert.equal(normal.candidates[0].sourcePad.normalizedSpecialView.entries[0].precision, 'rounded-0.1mil')
assert.equal(normal.candidates[0].sourcePad.widthMil, 50.125, 'candidate uses recovered full precision source geometry')
assert.equal(normal.candidates[1].sourcePad.widthMil, 40.125)
assert.deepEqual(normal.candidates.map(item => item.layer), ['top', 'bottom'])

const flipped = fixture({ componentLayer: 2, shapeState: ['OVAL', 40.1, 20.1] })
assert.equal(flipped.candidates.length, 2)
assert.deepEqual(flipped.candidates.map(item => item.layer), ['bottom', 'top'], 'local expansion side maps through component flip while effective shapes remain physical 1/2')
assert.deepEqual(flipped.candidates.map(item => item.sourcePad.selectedExpansionField), ['topSolderExpansion', 'bottomSolderExpansion'])
assert.deepEqual(flipped.candidates.map(item => item.sourcePad.shape), ['OVAL', 'RECT'], 'physical bottom is OVAL and physical top is RECT after component flip')
assert.deepEqual(flipped.candidates.map(item => item.sourcePad.solderExpansionMil), [3, 7], 'explicit expansion remains selected from the source local side')

function manufacturingMask(candidate) {
	const side = candidate.layer === 'top' ? 'GTS' : 'GBS'
	let macro = ''; let definition
	if (candidate.sourcePad.shape === 'OVAL') {
		macro = ovalMacro
		const [[x1, y1], [x2, y2]] = candidate.maskGeometry.axisEndpointsMil.map(([x, y]) => [x - candidate.maskGeometry.centerMil[0], y - candidate.maskGeometry.centerMil[1]])
		definition = `%ADD10Oval,${[candidate.maskGeometry.openingDiameterMil, x1, y1, x2, y2].map(mm).join('X')}*%`
	}
	else {
		macro = roundRectMacro
		const shape = candidate.sourcePad
		definition = `%ADD10RoundRect,${[2 * candidate.maskGeometry.expansionRadiusMil, -shape.widthMil / 2, -shape.heightMil / 2, shape.widthMil / 2, -shape.heightMil / 2].map(mm).join('X')}*%`
	}
	const center = candidate.maskGeometry.centerMil
	const name = `Gerber_${side === 'GTS' ? 'TopSolderMaskLayer' : 'BottomSolderMaskLayer'}.${side}`
	return parseGerberLayerGeometry(side, name, `%FSLAX45Y45*%\n%MOMM*%\n${macro}\n${definition}\nG54D10*G01X${coord(center[0])}Y${coord(center[1])}D03*\nM02*`)
}
const flippedAssociations = analyzePadMaskOpeningAssociations({ layers: flipped.candidates.map(manufacturingMask), padCandidates: flipped, maskParticipation: { available: true, complete: false, scope: 'test', skipped: [], results: [] } })
assert.deepEqual(flippedAssociations.matches.map(item => item.association), ['geometry-correlated', 'geometry-correlated'], 'both flipped physical-mask exports associate to their distinct geometry')
assert.deepEqual(flippedAssociations.matches.map(item => item.side), ['bottom', 'top'])
assert.deepEqual(flippedAssociations.matches.map(item => item.maskReferences[0].layer), ['GBS', 'GTS'])

const rangeOnly = fixture({ specials: [baseSpecials[0], baseSpecials[2], baseSpecials[3]] })
assert.equal(rangeOnly.candidates.length, 2, 'non-single source range uses runtime normalized view')

const collision = fixture({ specials: [...baseSpecials, { startLayer: 1, endLayer: 1, pad: { padType: 'RECT', width: 50.13, height: 26.45, radius: 0 } }] })
assert.equal(collision.candidates.length, 0, 'different complete source geometries that round to one getter value remain unresolved')
assert.ok(collision.skipped.some(item => item.reason.includes('有效形状视图')))

for (const tuples of [
	[[1, 1, ['RECT', 50.1, 26.5, 0]], [2, 2, ['OVAL', 40.1, 20.1]]],
	[[1, 1, ['RECT', 50.1, 26.5, 0]], [12, 12, ['ELLIPSE', 44.1, 44.1]], [2, 2, ['OVAL', 40.1, 20.1]], [3, 3, ['RECT', 1, 1, 0]]],
	[[1, 1, ['RECT', 50.1, 26.5, 0]], [1, 1, ['RECT', 50.1, 26.5, 0]], [12, 12, ['ELLIPSE', 44.1, 44.1]]],
]) {
	assert.equal(fixture({ tuples }).candidates.length, 0, 'missing, extra, or duplicate runtime layer tuples fail closed')
}
assert.equal(fixture({ shapeState: ['RECT', 50.1, 26.5, 1] }).candidates.length, 0, 'runtime PAD shape must match an effective outer physical shape')
assert.equal(fixture({ bbox: projected(sourceDefault) }).candidates.length, 0, 'source declaration union is not used as a fallback bbox')

const rangeAInner = { padType: 'OVAL', width: 80, height: 60, radius: 0 }
const rangeBInner = { padType: 'OVAL', width: 80, height: 60, radius: 0 }
const duplicateSpecials = [
	{ startLayer: 1, endLayer: 15, pad: rangeAInner },
	{ startLayer: 2, endLayer: 16, pad: rangeBInner },
]
const duplicateTuples = [[1, 1, ['ELLIPSE', 44.1, 44.1]], [1, 1, ['RECT', 50.1, 26.5, 0]], [2, 2, ['ELLIPSE', 44.1, 44.1]], [2, 2, ['RECT', 50.1, 26.5, 0]]]
const rawPhysical = { globalIndex: 'runtime-r2', parentId: 'component-r2', layerId: 12, pcbItemPrimitiveType: 'Pad', net: 'NET_R2', topType: 'ELLIPSE', topWidth: 3.2125, topHeight: 3.2125, topRatio: 0, bottomType: 'ELLIPSE', bottomWidth: 3.2125, bottomHeight: 3.2125, bottomRatio: 0, inner: { '1': { type: 'OVAL', width: 8, height: 6, ratio: 0, pl: null }, '2': { type: 'OVAL', width: 8, height: 6, ratio: 0, pl: null } } }
const physicalBbox = { minX: -40, minY: -30, maxX: 40, maxY: 30 }
const rawView = fixture({ specials: duplicateSpecials, tuples: duplicateTuples, defaultShape: { padType: 'ELLIPSE', width: 32.125, height: 32.125, radius: 0 }, shapeState: ['ELLIPSE', 32.1, 32.1], bbox: physicalBbox, runtimePhysicalPadView: { status: 'value', raw: rawPhysical } })
assert.equal(rawView.candidates.length, 2, 'duplicate SDK layer keys select complete raw physical view')
assert.deepEqual(rawView.candidates.map(item => item.sourcePad.shape), ['ELLIPSE', 'ELLIPSE'], 'named physical top/bottom shapes retain the default shape while inner shapes remain bbox-only')
assert.deepEqual(rawView.candidates.map(item => item.layer), ['top', 'bottom'])
assert.ok(rawView.candidates.every(item => item.runtimePad.runtimeBBoxModel === 'runtime-physical-top-bottom-all-inner-union'))
assert.ok(rawView.candidates.every(item => item.sourcePad.runtimePhysicalView.shapes.some(shape => shape.key === 'inner:1') && item.sourcePad.runtimePhysicalView.shapes.some(shape => shape.key === 'inner:2')), 'all inner shapes remain visible in the model provenance')
assert.ok(rawView.candidates.every(item => item.sourcePad.runtimePhysicalView.shapes.find(shape => shape.key.startsWith('inner:')).shape.width === 80))
assert.equal(fixture({ specials: duplicateSpecials, tuples: duplicateTuples, bbox: physicalBbox }).candidates.length, 0, 'missing raw view never falls back to duplicate normalized tuples')
for (const mutate of [
	value => { delete value.topType },
	value => { delete value.inner },
	value => { value.globalIndex = 17 },
	value => { value.globalIndex = 'different-pad' },
	value => { value.parentId = 'other-component' },
	value => { value.net = 'OTHER_NET' },
	value => { value.layerId = 1 },
	value => { value.topWidth = Infinity },
	value => { value.bottomType = 'UNKNOWN' },
	value => { value.pcbItemPrimitiveType = 'PAD' },
	value => { value.topRatio = 0.1 },
	value => { delete value.topRatio },
	value => { value.inner['1'].pl = 1 },
	value => { delete value.inner['1'].ratio },
]) {
	const broken = structuredClone(rawPhysical); mutate(broken)
	assert.equal(fixture({ specials: duplicateSpecials, tuples: duplicateTuples, bbox: physicalBbox, runtimePhysicalPadView: { status: 'value', raw: broken } }).candidates.length, 0, 'invalid raw physical identity or geometry fails closed')
}
const collisionSpecials = [...duplicateSpecials, { startLayer: 2, endLayer: 16, pad: { padType: 'OVAL', width: 80.0000000000001, height: 60, radius: 0 } }]
assert.equal(fixture({ specials: collisionSpecials, tuples: duplicateTuples, defaultShape: { padType: 'ELLIPSE', width: 32.125, height: 32.125, radius: 0 }, shapeState: ['ELLIPSE', 32.1, 32.1], bbox: physicalBbox, runtimePhysicalPadView: { status: 'value', raw: rawPhysical } }).candidates.length, 0, 'source geometries inside pure floating point tolerance remain ambiguous')
const coarseMismatchSpecials = duplicateSpecials.map(item => ({ ...item, pad: { ...item.pad, width: 80.04 } }))
assert.equal(fixture({ specials: coarseMismatchSpecials, tuples: duplicateTuples, defaultShape: { padType: 'ELLIPSE', width: 32.125, height: 32.125, radius: 0 }, shapeState: ['ELLIPSE', 32.1, 32.1], bbox: physicalBbox, runtimePhysicalPadView: { status: 'value', raw: rawPhysical } }).candidates.length, 0, 'raw precision does not inherit unverified 0.1 mil getter rounding')
assert.equal(fixture({ specials: duplicateSpecials, tuples: [[1, 1, ['ELLIPSE', 44.1, 44.1]], [12, 12, ['ELLIPSE', 44.1, 44.1]], [2, 2, ['OVAL', 80, 60]]], shapeState: ['ELLIPSE', 44.1, 44.1], bbox: physicalBbox, runtimePhysicalPadView: { status: 'value', raw: rawPhysical } }).candidates.length, 2, 'unique normalized 1/12/2 model is not overridden by available raw data')

const emptyNetQuery = { api: 'pcb_Net.getAllPrimitivesByNet', requestNetwork: { type: 'string', value: '' }, resultStatus: 'value', resultCount: 0, idMatchCount: 0, status: 'invalid', reason: 'empty network has no result' }
const dsnText = '(PCB "" (resolution mil 1000) (placement (component u1 (place u1 0 0 front 0))) (library (image u1 (pin pstack component-r27 220 180)) (padstack pstack (shape(circle TopLayer 44.13 0 0)) (shape(circle BottomLayer 44.13 0 0)))) )'
const dsnFallback = fixture({ specials: duplicateSpecials, tuples: [[1, 1, ['ELLIPSE', 44.1, 44.1]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['ELLIPSE', 44.1, 44.1]]], shapeState: ['ELLIPSE', 44.1, 44.1], bbox: physicalBbox, runtimePhysicalPadView: emptyNetQuery, net: '', localPadId: 'e7', nativeDsnText: dsnText })
assert.equal(dsnFallback.candidates.length, 2, 'only confirmed empty-net empty-array raw query can trigger DSN outer selection')
assert.ok(dsnFallback.candidates.every(item => item.sourcePad.runtimeBBoxModel === 'dsn-outer-and-runtime-special-union'))
assert.ok(dsnFallback.candidates.every(item => item.sourcePad.dsnPhysicalView?.top.state === 'selected' && item.sourcePad.dsnPhysicalView.bottom.state === 'selected'))
assert.ok(dsnFallback.candidates.every(item => item.sourcePad.dsnPhysicalView?.top.dsn.padstackName === 'pstack'))
assert.ok(dsnFallback.candidates.every(item => item.sourcePad.dsnPhysicalView?.rawQueryFailure.status === 'invalid'), 'successful DSN source reconstruction retains the failed raw empty-net query diagnostic')
assert.ok(dsnFallback.modelAssumptions.some(item => item.includes('aperture 0.1') && item.includes('Gerber制造关联保持独立')))
const dsnNoSource = fixture({ specials: duplicateSpecials, tuples: [[1, 1, ['ELLIPSE', 44.1, 44.1]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['ELLIPSE', 44.1, 44.1]]], shapeState: ['ELLIPSE', 44.1, 44.1], bbox: physicalBbox, runtimePhysicalPadView: emptyNetQuery, net: '', localPadId: 'e7' })
assert.equal(dsnNoSource.candidates.length, 0, 'confirmed empty-array query without native DSN preserves unknown geometry')
assert.ok(dsnNoSource.skipped[0].reason.includes('不符合经确认的空网空结果DSN选择触发条件'))
const wrongDsnBbox = fixture({ specials: duplicateSpecials, tuples: [[1, 1, ['ELLIPSE', 44.1, 44.1]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['ELLIPSE', 44.1, 44.1]]], shapeState: ['ELLIPSE', 44.1, 44.1], bbox: { minX: -45, minY: -30, maxX: 45, maxY: 30 }, runtimePhysicalPadView: emptyNetQuery, net: '', localPadId: 'e7', nativeDsnText: dsnText })
assert.equal(wrongDsnBbox.candidates.length, 0, 'DSN outer selection still rejects a runtime bbox that disagrees with all SDK special tuples')
assert.ok(wrongDsnBbox.skipped.some(item => item.reason.includes('bbox不匹配')))
const keyedTuples = [[15, 18, ['ELLIPSE', 44.1, 44.1]], [15, 18, ['OVAL', 80, 60]], [3, 9, ['ELLIPSE', 44.1, 44.1]]]
const ignoredTupleKeys = fixture({ specials: duplicateSpecials, tuples: keyedTuples, shapeState: ['ELLIPSE', 44.1, 44.1], bbox: physicalBbox, runtimePhysicalPadView: emptyNetQuery, net: '', localPadId: 'e7', nativeDsnText: dsnText })
assert.equal(ignoredTupleKeys.candidates.length, 2, 'DSN bbox union uses every SDK tuple geometry while ignoring tuple layer keys')
const wideDefault = { padType: 'ELLIPSE', width: 150, height: 150, radius: 0 }
const smallRect = { padType: 'RECT', width: 60, height: 40, radius: 0 }
const smallSpecials = [{ startLayer: 1, endLayer: 15, pad: smallRect }, { startLayer: 2, endLayer: 16, pad: smallRect }]
const smallTuples = [[1, 1, ['RECT', 60, 40, 0]], [1, 1, ['RECT', 60, 40, 0]], [2, 2, ['RECT', 60, 40, 0]]]
const smallBox = { minX: -30, minY: -20, maxX: 30, maxY: 20 }
const smallDsn = '(PCB "" (resolution mil 1000) (placement (component u1 (place u1 0 0 front 0))) (library (image u1 (pin pstack component-r27 220 180)) (padstack pstack (shape(polygon TopLayer 0.1 -30 -20 -30 20 30 20 30 -20)) (shape(polygon BottomLayer 0.1 -30 -20 -30 20 30 20 30 -20)))) )'
const noDefaultUnion = fixture({ specials: smallSpecials, tuples: smallTuples, defaultShape: wideDefault, shapeState: ['RECT', 60, 40, 0], bbox: smallBox, runtimePhysicalPadView: emptyNetQuery, net: '', localPadId: 'e7', nativeDsnText: smallDsn })
assert.equal(noDefaultUnion.candidates.length, 2, 'DSN outer selection supports special pads while source default is not a runtime tuple')
assert.ok(noDefaultUnion.candidates.every(item => item.sourcePad.widthMil === 60 && item.runtimePad.boxMil.maxX - item.runtimePad.boxMil.minX === 60), 'runtime union uses the SDK tuple shapes and does not add the unreturned 150mil default')
for (const [label, overrides] of [
	['nonempty network', { net: '+5V' }],
	['SDK error', { runtimePhysicalPadView: { ...emptyNetQuery, resultStatus: 'error' } }],
	['nonempty SDK result', { runtimePhysicalPadView: { ...emptyNetQuery, resultCount: 1, idMatchCount: 1 } }],
	['wrong query API', { runtimePhysicalPadView: { ...emptyNetQuery, api: 'pcb_Net.getNetPrimitives' } }],
]) {
	const blocked = fixture({ specials: duplicateSpecials, tuples: [[1, 1, ['ELLIPSE', 44.1, 44.1]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['ELLIPSE', 44.1, 44.1]]], shapeState: ['ELLIPSE', 44.1, 44.1], bbox: physicalBbox, runtimePhysicalPadView: emptyNetQuery, net: '', localPadId: 'e7', nativeDsnText: dsnText, ...overrides })
	assert.equal(blocked.candidates.length, 0, `${label} must not trigger the DSN fallback`)
}

const diagnosticOptions = { specials: duplicateSpecials, tuples: duplicateTuples, defaultShape: { padType: 'ELLIPSE', width: 32.125, height: 32.125, radius: 0 }, shapeState: ['ELLIPSE', 32.1, 32.1], bbox: physicalBbox, net: '' }
for (const supplemental of [
	{ status: 'invalid', requestNetwork: { type: 'string', value: '' }, resultCount: 0, idMatchCount: 0, reason: 'target absent' },
	{ status: 'sdk-error', requestNetwork: { type: 'string', value: '' }, reason: 'SDK failed' },
	{ status: 'invalid', bindingFailures: ['net'], rawNetwork: { present: true, type: 'null', value: null } },
	{ status: 'invalid', bindingFailures: ['net'], rawNetwork: { present: false, type: 'missing' } },
]) {
	const failed = fixture({ ...diagnosticOptions, runtimePhysicalPadView: supplemental })
	assert.equal(failed.candidates.length, 0)
	assert.deepEqual(failed.skipped[0].physicalPadViewDiagnostic.supplementalRead, supplemental)
	assert.equal(failed.skipped[0].physicalPadViewDiagnostic.parseFailure.category, 'supplemental-view-unavailable')
}
const missingInner = { ...rawPhysical, net: '' }; delete missingInner.inner
const missingInnerReport = fixture({ ...diagnosticOptions, runtimePhysicalPadView: { status: 'value', raw: missingInner } })
assert.equal(missingInnerReport.skipped[0].physicalPadViewDiagnostic.parseFailure.category, 'missing-or-invalid-inner')
assert.equal(missingInnerReport.skipped[0].physicalPadViewDiagnostic.parseFailure.field, 'raw.inner')
assert.equal(fixture({ ...diagnosticOptions, runtimePhysicalPadView: { status: 'value', raw: { ...rawPhysical, net: '' } } }).candidates.length, 2, 'explicit empty net still works when SDK actually returns a matching object')

console.log('silkscreen runtime special-pad view regression passed')
