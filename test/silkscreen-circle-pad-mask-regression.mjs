import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({ stdin: { contents: "import { extractFootprintPadMaskCandidates } from '../src/engine/footprintSilkscreen.ts'; import { analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'; export { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry }", resolveDir: resolve(root, 'test'), sourcefile: 'silkscreen-circle-pad-mask-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' })
const { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const angles = [0, 90, 180, 270, 37]
const mmPerMil = 0.0254
const coordinate = mil => String(Math.round(mil * 2540))
const mmToken = mil => (mil * mmPerMil).toFixed(5)
const noWitnesses = { scope: 'test', available: true, complete: false, skipped: [], results: [] }

function footprintSource(uuid, { localLayer = 1, diameter = 32, height = diameter, top = 3, bottom = 7, radiusField = '"radius":0' } = {}) {
	const pad = { num: '1', layerId: localLayer, hole: null, defaultPad: { padType: 'ELLIPSE', width: diameter, height, ...(radiusField ? { radius: Number(radiusField.match(/-?\d+(?:\.\d+)?/u)?.[0]) } : {}) }, specialPad: [], padType: 'NORMAL', topSolderExpansion: top, bottomSolderExpansion: bottom, padLen: 0 }
	const records = [
		{ type: 'DOCHEAD', id: 'head', ticket: 0, data: { docType: 'FOOTPRINT', uuid } },
		{ type: 'PAD', id: 'local-circle', ticket: 1, data: pad },
	]
	return records.map(({ type, id, ticket, data }) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`).join('\n')
}

function makeFixture({ localLayer = 1, componentLayer = 1, diameter = 32, height = diameter, top = 3, bottom = 7, radiusField = '"radius":0', sourceStable = true, duplicateId = false, padOverride = false, snapshotLayer, angles: poses = angles } = {}) {
	const components = []
	const padSnapshots = []
	const pcbRecords = []
	const footprintSources = []
	const centers = []
	for (let index = 0; index < poses.length; index++) {
		const componentId = `component-${index}`
		const footprintUuid = `footprint-${index}`
		const angle = poses[index]
		const x = 120 + index * 150
		const y = 180 + index * 70
		const actualLayer = localLayer === 1 ? componentLayer : 3 - componentLayer
		const padId = duplicateId && index === 1 ? 'runtime-0' : `runtime-${index}`
		components.push({ getState_PrimitiveId: () => componentId })
		pcbRecords.push({ header: { type: 'COMPONENT', id: componentId, ticket: 1 }, data: { layerId: componentLayer, x, y, angle } })
		pcbRecords.push({ header: { type: 'ATTR', id: `fp-${index}`, ticket: 1 }, data: { key: 'Footprint', parentId: componentId, value: footprintUuid } })
		const sourcePad = footprintSource(footprintUuid, { localLayer, diameter, height, top, bottom, radiusField })
		footprintSources.push({ footprintUuid, documentSource: sourcePad })
		const center = [x + 25, y - 15]
		centers.push(center)
		const half = diameter / 2
		const box = { minX: center[0] - half, minY: center[1] - half, maxX: center[0] + half, maxY: center[1] + half }
		padSnapshots.push({ id: padId, componentId, padNumber: '1', layer: snapshotLayer ?? actualLayer, rotation: angle, shape: 'ELLIPSE', box })
		const localId = 'local-circle'
		const netId = JSON.stringify(['PAD_NET', componentId, '1', localId])
		pcbRecords.push({ header: { type: 'PAD_NET', id: netId, ticket: 1 }, data: { padNet: '', padLen: null, attrsMap: {} } })
		if (padOverride && index === 0)
			pcbRecords.push({ header: { type: 'PAD', id: padId, ticket: 1 }, data: { layerId: actualLayer } })
	}
	return { components, padSnapshots, pcbRecords, footprintSources, centers, projectLibrarySources: [], sourceStable }
}

function makeLayer(side, fixture, tokenForIndex, { centerOffset = () => [0, 0], duplicate = false, apertureSuffix = '' } = {}) {
	const statements = []
	const apertures = []
	const count = fixture.centers.length * (duplicate ? 2 : 1)
	for (let index = 0; index < count; index++) {
		const sourceIndex = duplicate ? Math.floor(index / 2) : index
		const copyIndex = duplicate ? index % 2 : 0
		const token = tokenForIndex(sourceIndex, copyIndex)
		const apertureId = 10 + index
		apertures.push(`%ADD${apertureId}C,${token}${index === 0 ? apertureSuffix : ''}*%`)
		const offset = centerOffset(sourceIndex)
		const center = fixture.centers[sourceIndex]
		statements.push(`G54D${apertureId}*G01X${coordinate(center[0] + offset[0])}Y${coordinate(center[1] + offset[1])}D03*`)
	}
	const content = `%FSLAX45Y45*%\n%MOMM*%\n${apertures.join('\n')}\n${statements.join('\n')}\nM02*`
	return parseGerberLayerGeometry(side, `Gerber_${side}.G${side}`, content)
}

function extract(fixture) {
	return extractFootprintPadMaskCandidates({ ...fixture, projectLibrarySources: [], sourceStable: fixture.sourceStable })
}

function associate(fixture, candidates, layer, participation = noWitnesses) {
	return analyzePadMaskOpeningAssociations({ layers: layer ? [layer] : [], padCandidates: candidates, maskParticipation: participation })
}

for (const localLayer of [1, 2]) {
	for (const componentLayer of [1, 2]) {
		for (const { expansion, bottom } of localLayer === 1 ? [{ expansion: 3, bottom: 7 }] : [{ expansion: 7, bottom: 7 }, { expansion: 11, bottom: 11 }]) {
			const fixture = makeFixture({ localLayer, componentLayer, top: 3, bottom })
			const candidates = extract(fixture)
			const actualLayer = localLayer === 1 ? componentLayer : 3 - componentLayer
			const side = actualLayer === 1 ? 'GTS' : 'GBS'
			const openingMil = 32 + 2 * expansion
			const layer = makeLayer(side, fixture, () => mmToken(openingMil))
			const result = associate(fixture, candidates, layer)
			assert.equal(candidates.candidates.length, 5)
			assert.equal(candidates.skipped.length, 0)
			assert.equal(result.matches.length, 5)
			assert.ok(result.matches.every(match => match.association === 'geometry-correlated' && match.side === (actualLayer === 1 ? 'top' : 'bottom')))
			assert.ok(result.matches.every(match => match.sourcePadModel.shape === 'ELLIPSE' && match.sourcePadModel.diameterMil === 32))
			assert.ok(result.matches.every(match => match.sourcePadModel.localCopperLayerId === localLayer))
			assert.ok(result.matches.every(match => match.sourcePadModel.selectedExpansionField === (localLayer === 1 ? 'topSolderExpansion' : 'bottomSolderExpansion')))
			assert.ok(result.matches.every(match => match.maskReferences.length === 1 && match.necessaryMaskReferences.length === 0 && match.witnessLinks.length === 0))
			assert.ok(result.matches.every(match => match.geometryChecks.circleOnly && match.geometryChecks.positiveDiameterMatched && match.geometryChecks.formatSupported))
			assert.ok(candidates.candidates.every(candidate => candidate.maskGeometry.openingDiameterMil === openingMil))
		}
	}
}

const radiusNonzero = makeFixture({ localLayer: 1, componentLayer: 1, radiusField: '"radius":9' })
assert.equal(extract(radiusNonzero).candidates.length, 5, 'circle ellipse does not use unrelated radius metadata')
const radiusMissing = makeFixture({ localLayer: 2, componentLayer: 2, radiusField: '' })
assert.equal(extract(radiusMissing).candidates.length, 5, 'circle ellipse does not require unrelated radius metadata')

const fractional = makeFixture({ localLayer: 1, componentLayer: 1, diameter: 32.125, top: 3, bottom: 7 })
const fractionalCandidates = extract(fractional)
const fractionalLayer = makeLayer('GTS', fractional, () => '0.96838')
const fractionalResult = associate(fractional, fractionalCandidates, fractionalLayer)
assert.ok(fractionalResult.matches.every(match => match.association === 'geometry-correlated' && match.geometryChecks.diameterRule === 'fixed-1e-5-mm-half-quantum'))
const quantizedDown = makeFixture({ localLayer: 2, componentLayer: 2, diameter: 28.4501, top: 3, bottom: 7 })
const quantizedDownCandidates = extract(quantizedDown)
const quantizedDownLayer = makeLayer('GTS', quantizedDown, () => '1.07823')
const quantizedDownResult = associate(quantizedDown, quantizedDownCandidates, quantizedDownLayer)
assert.ok(quantizedDownResult.matches.every(match => match.association === 'geometry-correlated' && match.geometryChecks.diameterRule === 'fixed-1e-5-mm-half-quantum'))

for (const token of ['0.96838', '0.968380', '0.9683800']) {
	const result = associate(fractional, fractionalCandidates, makeLayer('GTS', fractional, () => token))
	assert.ok(result.matches.every(match => match.association === 'geometry-correlated'), `${token} follows the same numeric grid rule regardless of trailing zeros`)
}
for (const token of ['0.96837', '0.96838']) {
	const result = associate(fractional, fractionalCandidates, makeLayer('GTS', fractional, () => token))
	assert.ok(result.matches.every(match => match.association === 'geometry-correlated'), `${token} is at the inclusive half-quantum boundary`)
}
for (const token of ['0.96836', '0.96839']) {
	const result = associate(fractional, fractionalCandidates, makeLayer('GTS', fractional, () => token))
	assert.ok(result.matches.every(match => match.association === 'not-matched'), `${token} is outside the fixed half-quantum boundary`)
}
const exactOffGrid = (42.4501 * 0.0254).toString()
const exactOffGridResult = associate(quantizedDown, quantizedDownCandidates, makeLayer('GTS', quantizedDown, () => exactOffGrid))
assert.ok(exactOffGridResult.matches.every(match => match.association === 'geometry-correlated' && match.geometryChecks.diameterRule === 'exact-epsilon-only'))
const unknownOffGrid = associate(quantizedDown, quantizedDownCandidates, makeLayer('GTS', quantizedDown, () => '1.078231'))
assert.ok(unknownOffGrid.matches.every(match => match.association === 'geometry-match-uncertain' && match.uncertainMaskReferences?.length === 1 && match.necessaryMaskReferences.length === 0 && match.witnessLinks.length === 0))
const knownPlusUnknown = makeLayer('GTS', quantizedDown, (_index, copyIndex) => copyIndex === 0 ? '1.07823' : '1.078231', { duplicate: true })
const knownPlusUnknownResult = associate(quantizedDown, quantizedDownCandidates, knownPlusUnknown)
assert.ok(knownPlusUnknownResult.matches.every(match => match.association === 'geometry-match-uncertain' && match.maskReferences.length === 1 && match.uncertainMaskReferences?.length === 1 && match.necessaryMaskReferences.length === 0))

const wrongCenter = associate(fractional, fractionalCandidates, makeLayer('GTS', fractional, () => '0.96838', { centerOffset: () => [0.01, 0] }))
assert.ok(wrongCenter.matches.every(match => match.association === 'not-matched' && !match.geometryChecks.flashCenterMatched))
const duplicate = associate(fractional, fractionalCandidates, makeLayer('GTS', fractional, () => '0.96838', { duplicate: true }))
assert.ok(duplicate.matches.every(match => match.association === 'ambiguous' && match.maskReferences.length === 2 && match.necessaryMaskReferences.length === 0))
const extraParameters = associate(fractional, fractionalCandidates, makeLayer('GTS', fractional, () => '0.96838', { apertureSuffix: 'X0.1' }))
assert.ok(extraParameters.matches.every(match => match.association !== 'geometry-correlated' && match.maskReferences.length === 0))
const wrongSide = associate(fractional, fractionalCandidates, makeLayer('GBS', fractional, () => '0.96838'))
assert.ok(wrongSide.matches.every(match => match.association === 'geometry-match-uncertain' && !match.geometryChecks.formatSupported))

const unequal = makeFixture({ localLayer: 1, componentLayer: 1, diameter: 32, height: 33 })
const unequalCandidates = extract(unequal)
assert.equal(unequalCandidates.candidates.length, 5, 'EDA 4.1.78 source ELLIPSE uses width to generate the runtime circle')
assert.equal(unequalCandidates.skipped.length, 0)
assert.ok(unequalCandidates.candidates.every(candidate => candidate.sourcePad.diameterMil === 32 && candidate.sourcePad.sourceHeightMil === 33 && candidate.sourcePad.shapeInterpretation === 'circle-width-based-runtime'))
const overflowFixture = makeFixture({ localLayer: 1, componentLayer: 1, top: Number.MAX_VALUE, angles: [0] })
const overflowCandidates = extract(overflowFixture)
assert.equal(overflowCandidates.candidates.length, 0, 'overflowing derived circle opening geometry is rejected')
assert.equal(overflowCandidates.skipped.length, 1)
assert.ok(overflowCandidates.skipped[0].reason.includes('派生中心、开窗直径或外包围盒'))
const overflowLayer = makeLayer('GTS', overflowFixture, () => '0.10000')
const overflowAssociation = associate(overflowFixture, overflowCandidates, overflowLayer)
assert.equal(overflowAssociation.available, true)
assert.equal(overflowAssociation.matches.length, 0, 'overflowing circle geometry cannot create a positive association')
assert.equal(extract(makeFixture({ localLayer: 1, componentLayer: 1, snapshotLayer: 2 })).candidates.length, 0, 'actual PAD face mismatch remains rejected')
assert.equal(extract(makeFixture({ localLayer: 1, componentLayer: 1, duplicateId: true })).candidates.length, 3, 'duplicate runtime identity is not selected')
assert.equal(extract(makeFixture({ localLayer: 1, componentLayer: 1, padOverride: true })).candidates.length, 4, 'effective PAD override stays skipped')
assert.equal(extract(makeFixture({ localLayer: 1, componentLayer: 1, sourceStable: false })).available, false, 'unstable source stays unavailable')
assert.throws(() => extractFootprintPadMaskCandidates({ ...fractional, checkBudget: () => { throw new Error('circle candidate budget stopped') } }), /circle candidate budget stopped/u)

const chosen = fractionalCandidates.candidates[0]
const fractionalReference = fractionalResult.matches[0].maskReferences[0]
const participationAtCenter = { ...noWitnesses, results: [{ conflictIndex: 0, areaIndex: 0, layer: chosen.layer, manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: [...chosen.maskGeometry.centerMil], mask: { necessaryContribution: true, necessaryContributorRefs: [fractionalReference] } } }] }
const linked = associate(fractional, fractionalCandidates, fractionalLayer, participationAtCenter).matches[0]
assert.equal(linked.necessaryMaskReferences.length, 1)
assert.equal(linked.witnessLinks.length, 1)
const outsidePoint = [chosen.maskGeometry.centerMil[0] + chosen.maskGeometry.openingDiameterMil / 2, chosen.maskGeometry.centerMil[1]]
const participationOutside = { ...participationAtCenter, results: [{ ...participationAtCenter.results[0], witness: { ...participationAtCenter.results[0].witness, pointMil: outsidePoint } }] }
const notLinked = associate(fractional, fractionalCandidates, fractionalLayer, participationOutside).matches[0]
assert.deepEqual(notLinked.necessaryMaskReferences, [])
assert.deepEqual(notLinked.witnessLinks, [])

const beforeSource = JSON.stringify(fractionalCandidates)
const beforeLayer = JSON.stringify(fractionalLayer)
const beforeParticipation = JSON.stringify(noWitnesses)
associate(fractional, fractionalCandidates, fractionalLayer)
assert.equal(JSON.stringify(fractionalCandidates), beforeSource, 'candidate source is unchanged')
assert.equal(JSON.stringify(fractionalLayer), beforeLayer, 'parsed manufacturing geometry is unchanged')
assert.equal(JSON.stringify(noWitnesses), beforeParticipation, 'participation report is unchanged')

const signedInset = makeFixture({ localLayer: 1, componentLayer: 1, top: -5 })
const signedInsetCandidates = extract(signedInset)
assert.equal(signedInsetCandidates.candidates.length, 5, 'negative expansion remains an opening when the derived circle diameter is positive')
assert.ok(signedInsetCandidates.candidates.every(item => item.maskGeometry.openingDiameterMil === 22))
const closed = makeFixture({ localLayer: 1, componentLayer: 1, diameter: 32, top: -16 })
const closedCandidates = extract(closed)
assert.equal(closedCandidates.candidates.length, 0)
assert.equal(closedCandidates.closed.length, 5, 'a zero derived diameter is represented as model-predicted closed')
const closedLayerText = '%FSLAX45Y45*%\n%MOMM*%\nM02*'
const emptyClosedLayer = parseGerberLayerGeometry('GTS', 'Gerber_TopSolderMaskLayer.GTS', closedLayerText)
const closedAssociations = analyzePadMaskOpeningAssociations({ layers: [emptyClosedLayer], padCandidates: closedCandidates, maskParticipation: noWitnesses })
assert.ok(closedAssociations.matches.every(item => item.association === 'model-predicted-closed' && item.manufacturingOpeningStatus === 'observed-no-positive-area-opening' && item.maskReferences.length === 0))
const positiveOverlap = analyzePadMaskOpeningAssociations({ layers: [makeLayer('GTS', closed, () => mmToken(1))], padCandidates: closedCandidates, maskParticipation: noWitnesses })
assert.ok(positiveOverlap.matches.every(item => item.manufacturingOpeningStatus === 'unattributed-opening-present' && item.maskReferences.length === 0), 'manufacturing opening evidence remains separate from source attribution')
const [darkClearX, darkClearY] = closed.centers[0]
const darkClearGerber = `%FSLAX45Y45*%\n%MOMM*%\n%ADD10R,${mmToken(32)}X${mmToken(32)}*%\n%LPD*%\nG54D10*G01X${coordinate(darkClearX)}Y${coordinate(darkClearY)}D03*\n%LPC*%\nG54D10*G01X${coordinate(darkClearX)}Y${coordinate(darkClearY)}D03*\n%LPD*%\nM02*`
const fullyClearedLayer = parseGerberLayerGeometry('GTS', 'Gerber_TopSolderMaskLayer.GTS', darkClearGerber)
const clearedAssociations = analyzePadMaskOpeningAssociations({ layers: [fullyClearedLayer], padCandidates: closedCandidates, maskParticipation: noWitnesses })
assert.ok(clearedAssociations.matches.every(item => item.manufacturingOpeningStatus === 'observed-no-positive-area-opening'), 'dark geometry fully erased by clear polarity is absent in finalPaint')
const missingClosedLayer = analyzePadMaskOpeningAssociations({ layers: [], padCandidates: closedCandidates, maskParticipation: noWitnesses })
assert.ok(missingClosedLayer.matches.every(item => item.manufacturingOpeningStatus === 'not-evaluated'))
const duplicateClosedLayer = analyzePadMaskOpeningAssociations({ layers: [emptyClosedLayer, emptyClosedLayer], padCandidates: closedCandidates, maskParticipation: noWitnesses })
assert.ok(duplicateClosedLayer.matches.every(item => item.manufacturingOpeningStatus === 'not-evaluated'), 'duplicate target layers are not selected arbitrarily')

console.log('silkscreen circle pad mask regression passed')
