import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({ stdin: { contents: "import { extractFootprintPadMaskCandidates } from '../src/engine/footprintSilkscreen.ts'; import { analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'; export { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry }", resolveDir: resolve(root, 'test'), sourcefile: 'silkscreen-oblong-pad-mask-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' })
const { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const mmPerMil = 0.0254
const coord = mil => String(Math.round(mil * 2540))
const mm = mil => (mil * mmPerMil).toFixed(5)
const noWitnesses = { scope: 'test', available: true, complete: false, skipped: [], results: [] }
const ovalMacro = '%AMOval*1,1,$1,$2,$3*1,1,$1,$4,$5*20,1,$1,$2,$3,$4,$5,0*%'

function fixture({ width = 44.125, height = 20.45, angle = 37, localLayer = 1, componentLayer = 1, expansion = 3, malformed = false } = {}) {
	const center = [210, 175]
	const rad = angle * Math.PI / 180
	const horizontal = width >= height
	const radius = Math.min(width, height) / 2
	const halfAxis = Math.abs(width - height) / 2
	const theta = rad + (horizontal ? 0 : Math.PI / 2)
	const dx = halfAxis * Math.cos(theta); const dy = halfAxis * Math.sin(theta)
	const boxWidth = 2 * (radius + halfAxis * Math.abs(Math.cos(theta)))
	const boxHeight = 2 * (radius + halfAxis * Math.abs(Math.sin(theta)))
	const actualLayer = localLayer === 1 ? componentLayer : 3 - componentLayer
	const pad = { num: '1', layerId: localLayer, hole: null, defaultPad: { padType: 'OVAL', width, height }, specialPad: [], padType: 'NORMAL', topSolderExpansion: expansion, bottomSolderExpansion: expansion, padLen: 0 }
	const source = [
		{ type: 'DOCHEAD', id: 'head', ticket: 0, data: { docType: 'FOOTPRINT', uuid: 'fp-oval' } },
		{ type: 'PAD', id: 'pad-local', ticket: 1, data: pad },
	].map(({ type, id, ticket, data }) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`).join('\n')
	const records = [
		{ header: { type: 'COMPONENT', id: 'comp', ticket: 1 }, data: { layerId: componentLayer, x: center[0], y: center[1], angle } },
		{ header: { type: 'ATTR', id: 'fp-attr', ticket: 1 }, data: { key: 'Footprint', parentId: 'comp', value: 'fp-oval' } },
		{ header: { type: 'PAD_NET', id: JSON.stringify(['PAD_NET', 'comp', '1', 'pad-local']), ticket: 1 }, data: { padNet: '', padLen: null, attrsMap: {} } },
	]
	const snapshots = [{ id: 'runtime-pad', componentId: 'comp', padNumber: '1', layer: actualLayer, rotation: angle, shape: 'OVAL', box: { minX: center[0] - boxWidth / 2, minY: center[1] - boxHeight / 2, maxX: center[0] + boxWidth / 2, maxY: center[1] + boxHeight / 2 } }]
	const candidates = extractFootprintPadMaskCandidates({ pcbRecords: records, components: [{ getState_PrimitiveId: () => 'comp' }], footprintSources: [{ footprintUuid: 'fp-oval', documentSource: source }], projectLibrarySources: [], padSnapshots: snapshots, sourceStable: true })
	const axis1 = [-dx, -dy]; const axis2 = [dx, dy]
	const openingDiameter = 2 * (radius + expansion)
	const targetSide = actualLayer === 1 ? 'GTS' : 'GBS'
	const aperture = malformed ? '%AMOval*1,1,$1,$2,$3*%' : ovalMacro
	const layerText = `%FSLAX45Y45*%\n%MOMM*%\n${aperture}\n%ADD10Oval,${[openingDiameter, axis1[0], axis1[1], axis2[0], axis2[1]].map(mm).join('X')}*%\nG54D10*G01X${coord(center[0])}Y${coord(center[1])}D03*\nM02*`
	return { center, openingDiameter, candidates, targetSide, layerText, layer: parseGerberLayerGeometry(targetSide, `Gerber_${targetSide}.G${targetSide}`, layerText) }
}

for (const [width, height, angle] of [[44.125, 20.45, 0], [44.125, 20.45, 90], [44.125, 20.45, 180], [44.125, 20.45, 270], [44.125, 20.45, 37], [19.2501, 38.125, 37]]) {
	const f = fixture({ width, height, angle })
	assert.equal(f.candidates.candidates.length, 1, `candidate ${width}x${height} at ${angle} degrees`)
	assert.equal(f.candidates.skipped.length, 0)
	const candidate = f.candidates.candidates[0]
	assert.equal(candidate.sourcePad.shape, 'OVAL')
	assert.equal(candidate.maskGeometry.openingDiameterMil, f.openingDiameter)
	assert.equal(candidate.maskGeometry.axisEndpointsMil.length, 2)
	const result = analyzePadMaskOpeningAssociations({ layers: [f.layer], padCandidates: f.candidates, maskParticipation: noWitnesses })
	assert.equal(result.matches.length, 1)
	assert.equal(result.matches[0].association, 'geometry-correlated', `${width}x${height} at ${angle}: ${JSON.stringify(result.matches[0])}`)
	assert.equal(result.matches[0].uniqueSourceAttribution, false)
	assert.equal(result.matches[0].geometryChecks.capsuleOnly, true)
}

const boundaryExpansion = ((0.671835 / mmPerMil) - 20.45) / 2
for (const token of ['0.67183', '0.67184']) {
	const boundary = fixture({ width: 44.125, height: 20.45, angle: 37, expansion: boundaryExpansion })
	const boundaryText = boundary.layerText.replace(/(%ADD10Oval,)[^X]+(X[^*]+\*%)/u, `$1${token}$2`)
	const boundaryLayer = parseGerberLayerGeometry(boundary.targetSide, boundary.layer.fileName, boundaryText)
	const boundaryResult = analyzePadMaskOpeningAssociations({ layers: [boundaryLayer], padCandidates: boundary.candidates, maskParticipation: noWitnesses })
	assert.equal(boundaryResult.matches[0].association, 'geometry-correlated', `inclusive half-quantum boundary ${token}`)
}

const bottom = fixture({ localLayer: 2, componentLayer: 2, width: 19.2501, height: 38.125, angle: 37 })
assert.equal(bottom.targetSide, 'GTS')
assert.equal(analyzePadMaskOpeningAssociations({ layers: [bottom.layer], padCandidates: bottom.candidates, maskParticipation: noWitnesses }).matches[0].association, 'geometry-correlated')

const wrongEndpoint = fixture({ angle: 37 })
const badEndpointText = wrongEndpoint.layerText.replace(/(%ADD10Oval,[^X]+X)([^X]+)(X[^X]+X[^X]+X[^*]+\*%)/u, (_all, prefix, x1, suffix) => `${prefix}${(Number(x1) + 0.01).toFixed(5)}${suffix}`)
const badEndpointLayer = parseGerberLayerGeometry(wrongEndpoint.targetSide, 'Gerber_GTS.GTS', badEndpointText)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [badEndpointLayer], padCandidates: wrongEndpoint.candidates, maskParticipation: noWitnesses }).matches[0].association, 'not-matched')

const reversedEndpoints = fixture({ angle: 37 })
const reversedText = reversedEndpoints.layerText.replace(/(%ADD10Oval,)([^X]+)X([^X]+)X([^X]+)X([^X]+)X([^*]+)(\*%)/u, (_all, prefix, d, x1, y1, x2, y2, suffix) => `${prefix}${d}X${x2}X${y2}X${x1}X${y1}${suffix}`)
const reversedLayer = parseGerberLayerGeometry(reversedEndpoints.targetSide, 'Gerber_GTS.GTS', reversedText)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [reversedLayer], padCandidates: reversedEndpoints.candidates, maskParticipation: noWitnesses }).matches[0].association, 'geometry-correlated')

const malformed = fixture({ malformed: true })
assert.equal(malformed.candidates.candidates.length, 1)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [malformed.layer], padCandidates: malformed.candidates, maskParticipation: noWitnesses }).matches[0].association, 'geometry-match-uncertain')
const ovalStroke = fixture({ angle: 37 })
const ovalStrokeLayer = parseGerberLayerGeometry(ovalStroke.targetSide, ovalStroke.layer.fileName, ovalStroke.layerText.replace('D03*', 'D01*'))
assert.ok(ovalStrokeLayer.unsupported.length > 0 || ovalStrokeLayer.complete === false, 'Oval macro is supported for flash only')

const standardO = fixture({ width: 40, height: 20, angle: 0 })
	const standardText = `%FSLAX45Y45*%\n%MOMM*%\n%ADD10O,${mm(46)}X${mm(26)}*%\nG54D10*G01X${coord(standardO.center[0])}Y${coord(standardO.center[1])}D03*\nM02*`
const standardLayer = parseGerberLayerGeometry('GTS', 'Gerber_GTS.GTS', standardText)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [standardLayer], padCandidates: standardO.candidates, maskParticipation: noWitnesses }).matches[0].association, 'geometry-correlated')
const standardLongAxisOut = parseGerberLayerGeometry('GTS', 'Gerber_GTS.GTS', standardText.replace(/%ADD10O,[^X]+X([^*]+)\*%/u, (_all, height) => `%ADD10O,1.16840X${(Number(height) + 0.00001).toFixed(5)}*%`))
assert.equal(analyzePadMaskOpeningAssociations({ layers: [standardLongAxisOut], padCandidates: standardO.candidates, maskParticipation: noWitnesses }).matches[0].association, 'not-matched', 'short axis stays within tolerance while independent long-axis parameter exceeds it')
const rotatedForStandardO = fixture({ width: 44.125, height: 20.45, angle: 37 })
const rotatedCandidate = rotatedForStandardO.candidates.candidates[0]
const bboxOText = `%FSLAX45Y45*%\n%MOMM*%\n%ADD10O,${mm(rotatedCandidate.maskGeometry.outerBoundsMil.maxX - rotatedCandidate.maskGeometry.outerBoundsMil.minX)}X${mm(rotatedCandidate.maskGeometry.outerBoundsMil.maxY - rotatedCandidate.maskGeometry.outerBoundsMil.minY)}*%\nG54D10*G01X${coord(rotatedForStandardO.center[0])}Y${coord(rotatedForStandardO.center[1])}D03*\nM02*`
const bboxOLayer = parseGerberLayerGeometry('GTS', 'Gerber_GTS.GTS', bboxOText)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [bboxOLayer], padCandidates: rotatedForStandardO.candidates, maskParticipation: noWitnesses }).matches[0].association, 'not-matched', '37 degree capsule with matching global bbox is not an axis-aligned standard O aperture')
const standardStroke = parseGerberLayerGeometry('GTS', 'Gerber_GTS.GTS', standardText.replace('D03*', 'D01*'))
assert.ok(standardStroke.unsupported.length > 0 || standardStroke.complete === false)
const standardWithHole = parseGerberLayerGeometry('GTS', 'Gerber_GTS.GTS', standardText.replace(/(%ADD10O,[^*]+)(\*%)/u, '$1X5.00000$2'))
assert.ok(standardWithHole.unsupported.length > 0 || standardWithHole.complete === false)

const duplicateFixture = fixture({ angle: 37 })
const duplicateText = duplicateFixture.layerText.replace('M02*', `${duplicateFixture.layerText.match(/G54D10\*G01[^*]+D03\*/u)[0]}\nM02*`)
const duplicateLayer = parseGerberLayerGeometry(duplicateFixture.targetSide, duplicateFixture.layer.fileName, duplicateText)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [duplicateLayer], padCandidates: duplicateFixture.candidates, maskParticipation: noWitnesses }).matches[0].association, 'ambiguous')

const unknownPrecision = fixture({ angle: 37 })
const unknownText = unknownPrecision.layerText.replace(/(%ADD10Oval,)([^X]+)(X[^*]+\*%)/u, (_all, prefix, diameter, suffix) => `${prefix}${(Number(diameter) + 0.000001).toFixed(6)}${suffix}`)
const unknownLayer = parseGerberLayerGeometry(unknownPrecision.targetSide, unknownPrecision.layer.fileName, unknownText)
const unknownMatch = analyzePadMaskOpeningAssociations({ layers: [unknownLayer], padCandidates: unknownPrecision.candidates, maskParticipation: noWitnesses }).matches[0]
assert.equal(unknownMatch.association, 'geometry-match-uncertain')
assert.equal(unknownMatch.geometryChecks.diameterRule, 'unverified-precision')
const unknownAperture = unknownPrecision.layerText.match(/%ADD10Oval,[^*]+\*%/u)[0].replace('%ADD10Oval,', '%ADD11Oval,').replace(/(%ADD11Oval,)([^X]+)(X[^*]+\*%)/u, (_all, prefix, diameter, suffix) => `${prefix}${(Number(diameter) + 0.000001).toFixed(6)}${suffix}`)
const duplicateFlash = unknownPrecision.layerText.match(/G54D10\*G01[^*]+D03\*/u)[0].replace('G54D10', 'G54D11')
const knownPlusUnknownText = unknownPrecision.layerText.replace('M02*', `${unknownAperture}\n${duplicateFlash}\nM02*`)
const knownPlusUnknownLayer = parseGerberLayerGeometry(unknownPrecision.targetSide, unknownPrecision.layer.fileName, knownPlusUnknownText)
const knownPlusUnknownMatch = analyzePadMaskOpeningAssociations({ layers: [knownPlusUnknownLayer], padCandidates: unknownPrecision.candidates, maskParticipation: noWitnesses }).matches[0]
assert.equal(knownPlusUnknownMatch.association, 'geometry-match-uncertain', 'unknown precision competitor blocks attribution of a valid match')
const unknownEndpointAperture = unknownPrecision.layerText.match(/%ADD10Oval,[^*]+\*%/u)[0].replace('%ADD10Oval,', '%ADD11Oval,').replace(/(%ADD11Oval,[^X]+X)([^X]+)(X[^*]+\*%)/u, (_all, prefix, x1, suffix) => `${prefix}${(Number(x1) + 0.000001).toFixed(6)}${suffix}`)
const unknownEndpointFlash = unknownPrecision.layerText.match(/G54D10\*G01[^*]+D03\*/u)[0].replace('G54D10', 'G54D11')
const correctPlusUnknownEndpointText = unknownPrecision.layerText.replace('M02*', `${unknownEndpointAperture}\n${unknownEndpointFlash}\nM02*`)
const correctPlusUnknownEndpointLayer = parseGerberLayerGeometry(unknownPrecision.targetSide, unknownPrecision.layer.fileName, correctPlusUnknownEndpointText)
const correctPlusUnknownEndpointMatch = analyzePadMaskOpeningAssociations({ layers: [correctPlusUnknownEndpointLayer], padCandidates: unknownPrecision.candidates, maskParticipation: noWitnesses }).matches[0]
assert.equal(correctPlusUnknownEndpointMatch.association, 'geometry-match-uncertain', 'six-digit non-grid endpoint competitor blocks attribution of a correct flash')

const witnessFixture = fixture({ angle: 37 })
const witnessRef = { layer: 'GTS', fileName: witnessFixture.layer.fileName, contentBytes: witnessFixture.layer.contentBytes, shapeIndex: 0 }
const participation = { ...noWitnesses, results: [{ conflictIndex: 0, areaIndex: 0, layer: 'top', manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: [...witnessFixture.candidates.candidates[0].maskGeometry.axisEndpointsMil[0]], mask: { necessaryContribution: true, necessaryContributorRefs: [witnessRef] } } }] }
const witnessMatch = analyzePadMaskOpeningAssociations({ layers: [witnessFixture.layer], padCandidates: witnessFixture.candidates, maskParticipation: participation }).matches[0]
assert.equal(witnessMatch.witnessLinks.length, 1)
const exchangedWitness = { ...participation, results: [{ ...participation.results[0], witness: { ...participation.results[0].witness, pointMil: [...witnessFixture.candidates.candidates[0].maskGeometry.axisEndpointsMil[1]] } }] }
assert.equal(analyzePadMaskOpeningAssociations({ layers: [witnessFixture.layer], padCandidates: witnessFixture.candidates, maskParticipation: exchangedWitness }).matches[0].witnessLinks.length, 1, 'capsule witness at either exchanged endpoint is inside the finite core segment plus radius')
const outsideParticipation = { ...participation, results: [{ ...participation.results[0], witness: { ...participation.results[0].witness, pointMil: [witnessFixture.center[0], witnessFixture.center[1] + 100] } }] }
assert.equal(analyzePadMaskOpeningAssociations({ layers: [witnessFixture.layer], padCandidates: witnessFixture.candidates, maskParticipation: outsideParticipation }).matches[0].witnessLinks.length, 0)

const huge = fixture({ width: 100, height: 20, expansion: Number.MAX_VALUE })
assert.equal(huge.candidates.candidates.length, 0, 'overflowed capsule geometry is skipped')
assert.equal(huge.candidates.skipped.length, 1)

console.log('silkscreen oblong pad mask regression passed')
