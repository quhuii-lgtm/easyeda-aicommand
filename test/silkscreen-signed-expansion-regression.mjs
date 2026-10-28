import assert from 'node:assert/strict'
import { analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'

const mmPerMil = 0.0254
const center = [100, 200]
const mm = value => (value * mmPerMil).toFixed(5)
const coord = value => String(Math.round(value * 2540))
const candidate = (rotationDegrees = 37.126, widthMil = 20, heightMil = 10) => ({
	sourceIdentity: { componentId: 'c1', footprintUuid: 'f1', localPrimitiveId: 'p1', source: 'document-embedded' },
	componentId: 'c1', padNumber: '1', layer: 'top',
	runtimePad: { id: 'runtime1', shape: 'RECT', rotation: rotationDegrees, boxMil: { minX: 90, minY: 195, maxX: 110, maxY: 205 }, centerMil: center },
	sourcePad: { shape: 'RECT', localCopperLayerId: 1, widthMil: 30, heightMil: 20, radiusMil: 0, sourceTopSolderExpansion: -5, sourceBottomSolderExpansion: 0, expansionMapping: 'local-layer1-follows-component-side', selectedExpansionField: 'topSolderExpansion', solderExpansionMil: -5 },
	copperGeometry: { centerMil: center, rotationDegrees, widthMil: 30, heightMil: 20, cornerPointsMil: [] },
	maskGeometry: { centerMil: center, rotationDegrees, coreWidthMil: widthMil, coreHeightMil: heightMil, coreCornerPointsMil: [], expansionRadiusMil: 0, pureRect: true, outerBoundsMil: { minX: 90, minY: 195, maxX: 110, maxY: 205 } },
})
const layerFor = (_candidateValue, apertures, flashes) => {
	const content = `%FSLAX45Y45*%\n%MOMM*%\n%AMRect*21,1,$1,$2,0,0,$3*%\n${apertures.join('\n')}\n${flashes.map(([d, x, y]) => `G54D${d}*G01X${coord(x)}Y${coord(y)}D03*`).join('\n')}\nM02*`
	return parseGerberLayerGeometry('GTS', 'Gerber_TopSolderMaskLayer.GTS', content)
}
const analyze = (candidateValue, layer) => analyzePadMaskOpeningAssociations({
	layers: [layer],
	padCandidates: { available: true, complete: false, sourceStable: true, scope: 'stable-footprint-pad-and-runtime-mask-candidates', modelAssumptions: [], candidates: [candidateValue], closed: [], skipped: [] },
	maskParticipation: { available: true, complete: false, scope: 'test', skipped: [], results: [] },
}).matches[0]

const base = candidate()
const quantized = analyze(base, layerFor(base, [`%ADD10Rect,${mm(20)}X${mm(10)}X37.13*%`], [[10, ...center]]))
assert.equal(quantized.association, 'geometry-correlated', 'two-decimal angle half-quantum accepts 37.126 as 37.13')
assert.equal(quantized.maskReferences.length, 1)

const rectLayer = layerFor(base, [`%ADD10Rect,${mm(20)}X${mm(10)}X37.13*%`], [[10, ...center]])
const rectReference = analyze(base, rectLayer).maskReferences[0]
const theta = base.maskGeometry.rotationDegrees * Math.PI / 180
const pointOnAxis = distance => [center[0] + distance * Math.cos(theta), center[1] + distance * Math.sin(theta)]
const participationAtBoundary = { available: true, complete: false, scope: 'test', skipped: [], results: [{ conflictIndex: 0, areaIndex: 0, layer: 'top', manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: pointOnAxis(10), mask: { necessaryContribution: true, necessaryContributorRefs: [rectReference] } } }] }
const boundaryResult = analyzePadMaskOpeningAssociations({ layers: [rectLayer], padCandidates: { available: true, complete: false, sourceStable: true, scope: 'stable-footprint-pad-and-runtime-mask-candidates', modelAssumptions: [], candidates: [base], closed: [], skipped: [] }, maskParticipation: participationAtBoundary }).matches[0]
assert.deepEqual(boundaryResult.witnessLinks, [], 'boundary witnesses are not reported as strictly inside the candidate')
participationAtBoundary.results[0].witness.pointMil = pointOnAxis(9.99)
const interiorResult = analyzePadMaskOpeningAssociations({ layers: [rectLayer], padCandidates: { available: true, complete: false, sourceStable: true, scope: 'stable-footprint-pad-and-runtime-mask-candidates', modelAssumptions: [], candidates: [base], closed: [], skipped: [] }, maskParticipation: participationAtBoundary }).matches[0]
assert.equal(interiorResult.witnessLinks.length, 1, 'strictly interior witnesses can link without asserting identity')

const axis = candidate(0, 40, 20)
const correctRect = `%ADD10Rect,${mm(40)}X${mm(20)}X0*%`
const wrongRect = `%ADD11Rect,${mm(60)}X${mm(10)}X37*%`
for (const apertures of [[correctRect, wrongRect], [wrongRect, correctRect]]) {
	const ordered = analyze(axis, layerFor(axis, apertures, [[10, ...center], [11, ...center]]))
	assert.equal(ordered.association, 'geometry-correlated')
	assert.equal(ordered.maskReferences.length, 1, 'a wrong flash cannot inherit a previous flash geometry match')
}

const rotated = candidate(0)
assert.equal(analyze(rotated, layerFor(rotated, [`%ADD10Rect,${mm(20)}X${mm(10)}X180.00*%`], [[10, ...center]])).association, 'geometry-correlated', '180 degrees is equivalent to zero')
const wrongSwap = layerFor(rotated, [`%ADD10Rect,${mm(10)}X${mm(20)}X0.00*%`], [[10, ...center]])
assert.notEqual(analyze(candidate(0, 20, 10), wrongSwap).association, 'geometry-correlated', 'same angle with exchanged dimensions is rejected')

const competitor = candidate(0)
const rCompetitor = layerFor(competitor, [`%ADD10Rect,${mm(20)}X${mm(10)}X0*%`, `%ADD11R,${mm(20)}X${mm(10)}*%`], [[10, ...center], [11, ...center]])
assert.equal(analyze(competitor, rCompetitor).association, 'ambiguous', 'same geometry R aperture competes with Rect macro')

const nonGridNear = layerFor(base, [`%ADD10Rect,${mm(20)}X${mm(10)}X37.123*%`], [[10, ...center]])
// The raw macro angle is parsed from the aperture body; non-grid nearby precision cannot be treated as quantized.
const uncertain = analyze(base, nonGridNear)
assert.equal(uncertain.association, 'geometry-match-uncertain')
assert.equal(uncertain.maskReferences.length, 0)
assert.equal(uncertain.uncertainMaskReferences.length, 1)
const uncertainWithValid = layerFor(base, [
	`%ADD10Rect,${mm(20)}X${mm(10)}X37.13*%`,
	`%ADD11Rect,${mm(20)}X${mm(10)}X37.123*%`,
], [[10, ...center], [11, ...center]])
const uncertainValidReference = { layer: 'GTS', fileName: uncertainWithValid.fileName, contentBytes: uncertainWithValid.contentBytes, shapeIndex: 0 }
const uncertainParticipation = { available: true, complete: false, scope: 'test', skipped: [], results: [{ conflictIndex: 0, areaIndex: 0, layer: 'top', manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: pointOnAxis(1), mask: { necessaryContribution: true, necessaryContributorRefs: [uncertainValidReference] } } }] }
const uncertainValidMatch = analyzePadMaskOpeningAssociations({ layers: [uncertainWithValid], padCandidates: { available: true, complete: false, sourceStable: true, scope: 'stable-footprint-pad-and-runtime-mask-candidates', modelAssumptions: [], candidates: [base], closed: [], skipped: [] }, maskParticipation: uncertainParticipation }).matches[0]
assert.equal(uncertainValidMatch.association, 'geometry-match-uncertain')
assert.deepEqual(uncertainValidMatch.necessaryMaskReferences, [], 'unknown competing flash blocks witness and necessary-ref attribution')
assert.deepEqual(uncertainValidMatch.witnessLinks, [])

console.log('silkscreen signed expansion regression passed')
