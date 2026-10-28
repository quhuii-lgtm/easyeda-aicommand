import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({ stdin: { contents: "import { extractFootprintPadMaskCandidates } from '../src/engine/footprintSilkscreen.ts'; import { analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'; export { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry }", resolveDir: resolve(root, 'test'), sourcefile: 'silkscreen-multilayer-pad-mask-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' })
const { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const noWitnesses = { scope: 'test', available: true, complete: false, skipped: [], results: [] }
const mmPerMil = 0.0254
const mm = value => (value * mmPerMil).toFixed(5)
const coord = value => String(Math.round(value * 2540))
const roundRectMacro = '%AMRoundRect*1,1,$1,$2,$3*1,1,$1,$4,$5*1,1,$1,0-$2,0-$3*1,1,$1,0-$4,0-$5*20,1,$1,$2,$3,$4,$5,0*20,1,$1,$4,$5,0-$2,0-$3,0*20,1,$1,0-$2,0-$3,0-$4,0-$5,0*20,1,$1,0-$4,0-$5,$2,$3,0*4,1,4,$2,$3,$4,$5,0-$2,0-$3,0-$4,0-$5,$2,$3,0*%'
const ovalMacro = '%AMOval*1,1,$1,$2,$3*1,1,$1,$4,$5*20,1,$1,$2,$3,$4,$5,0*%'

function sourcePad({ localLayer = 12, defaultPad = { padType: 'RECT', width: 38.125, height: 26.45, radius: 0 }, specialPad = [], top = 3, bottom = 7, hole = { holeType: 'ROUND', width: 10, height: 10, cornerRadius: 11.811 }, attrsMap } = {}) {
	return { num: '1', layerId: localLayer, hole, defaultPad, specialPad, padType: 'NORMAL', topSolderExpansion: top, bottomSolderExpansion: bottom, padLen: 0, padOffsetX: 0.005, padOffsetY: 0, relativeAngle: 90, plated: true, ...(attrsMap === undefined ? {} : { attrsMap }) }
}

function fixture({ componentLayer = 1, angle = 0, pad = sourcePad(), runtimeShape, bboxMode = 'union', getterDelta = 0, getterValues, padOverride = false } = {}) {
	const componentId = 'component-ml'
	const center = [220, 180]
	const specials = pad.specialPad.map(item => item.pad)
	const shapeValues = [pad.defaultPad, ...specials]
	const theta = angle * Math.PI / 180
	const projected = shapeValues.map(shape => {
		const isCircle = shape.padType === 'ELLIPSE'
		if (isCircle) return { minX: -shape.width / 2, minY: -shape.width / 2, maxX: shape.width / 2, maxY: shape.width / 2 }
		if (shape.padType === 'OVAL') {
			const radius = Math.min(shape.width, shape.height) / 2
			const axis = Math.abs(shape.width - shape.height) / 2
			const axisTheta = theta + (shape.width >= shape.height ? 0 : Math.PI / 2)
			const dx = axis * Math.cos(axisTheta); const dy = axis * Math.sin(axisTheta)
			return { minX: -Math.abs(dx) - radius, minY: -Math.abs(dy) - radius, maxX: Math.abs(dx) + radius, maxY: Math.abs(dy) + radius }
		}
		const points = [[-shape.width / 2, -shape.height / 2], [shape.width / 2, -shape.height / 2], [shape.width / 2, shape.height / 2], [-shape.width / 2, shape.height / 2]].map(([x, y]) => [x * Math.cos(theta) - y * Math.sin(theta), x * Math.sin(theta) + y * Math.cos(theta)])
		return { minX: Math.min(...points.map(p => p[0])), minY: Math.min(...points.map(p => p[1])), maxX: Math.max(...points.map(p => p[0])), maxY: Math.max(...points.map(p => p[1])) }
	})
	const union = { minX: Math.min(...projected.map(b => b.minX)), minY: Math.min(...projected.map(b => b.minY)), maxX: Math.max(...projected.map(b => b.maxX)), maxY: Math.max(...projected.map(b => b.maxY)) }
	const selectedTop = pad.specialPad.find(item => item.startLayer === 1)?.pad ?? pad.defaultPad
	const selectedBottom = pad.specialPad.find(item => item.startLayer === 2)?.pad ?? pad.defaultPad
	const displayShape = runtimeShape ?? selectedTop
	const getterDefault = displayShape.padType === 'RECT'
		? [displayShape.padType, displayShape.width + getterDelta, displayShape.height + getterDelta, displayShape.radius ?? 0]
		: displayShape.padType === 'ELLIPSE'
			? [displayShape.padType, displayShape.width + getterDelta, displayShape.width + getterDelta]
			: [displayShape.padType, displayShape.width + getterDelta, displayShape.height + getterDelta]
	const stateShape = getterValues ?? getterDefault
	const box = bboxMode === 'union'
		? { minX: center[0] + union.minX, minY: center[1] + union.minY, maxX: center[0] + union.maxX, maxY: center[1] + union.maxY }
		: { minX: center[0] - pad.defaultPad.width / 2, minY: center[1] - pad.defaultPad.height / 2, maxX: center[0] + pad.defaultPad.width / 2, maxY: center[1] + pad.defaultPad.height / 2 }
	const footprintUuid = 'fp-ml'
	const localId = 'pad-ml'
	const padId = 'runtime-ml'
	const padRecord = JSON.stringify({ type: 'PAD', id: localId, ticket: 1 }) + '||' + JSON.stringify(pad) + '|'
	const source = [JSON.stringify({ type: 'DOCHEAD', id: 'head', ticket: 0 }) + '||' + JSON.stringify({ docType: 'FOOTPRINT', uuid: footprintUuid }) + '|', padRecord].join('\n')
	const pcbRecords = [
		{ header: { type: 'COMPONENT', id: componentId, ticket: 1 }, data: { layerId: componentLayer, x: center[0], y: center[1], angle } },
		{ header: { type: 'ATTR', id: 'footprint-attr', ticket: 1 }, data: { key: 'Footprint', parentId: componentId, value: footprintUuid } },
		{ header: { type: 'PAD_NET', id: JSON.stringify(['PAD_NET', componentId, '1', localId]), ticket: 1 }, data: { padNet: '', padLen: null, attrsMap: {} } },
	]
	if (padOverride) pcbRecords.push({ header: { type: 'PAD', id: padId, ticket: 2 }, data: { layerId: 12 } })
	const component = { getState_PrimitiveId: () => componentId }
	const padSnapshot = { id: padId, componentId, padNumber: '1', layer: 12, rotation: angle, shape: stateShape[0], shapeState: stateShape, holeState: pad.hole, specialPadState: pad.specialPad, holeOffsetX: pad.padOffsetX, holeOffsetY: pad.padOffsetY, holeRotation: pad.relativeAngle, metallization: pad.plated, box }
	const candidates = extractFootprintPadMaskCandidates({ pcbRecords, components: [component], footprintSources: [{ footprintUuid, documentSource: source }], projectLibrarySources: [], padSnapshots: [padSnapshot], sourceStable: true })
	return { center, pad, selectedTop, selectedBottom, box, snapshot: padSnapshot, candidates }
}

function maskLayer(candidate) {
	const side = candidate.layer === 'top' ? 'GTS' : 'GBS'
	const geometry = candidate.maskGeometry
	let definition; let macro = ''; let token
	if (candidate.sourcePad.shape === 'ELLIPSE') {
		token = mm(geometry.openingDiameterMil)
		definition = `%ADD10C,${token}*%`
	}
	else if (candidate.sourcePad.shape === 'OVAL') {
		macro = ovalMacro
		const [[x1, y1], [x2, y2]] = geometry.axisEndpointsMil.map(([x, y]) => [x - geometry.centerMil[0], y - geometry.centerMil[1]])
		token = [geometry.openingDiameterMil, x1, y1, x2, y2].map(mm).join('X')
		definition = `%ADD10Oval,${token}*%`
	}
	else {
		macro = roundRectMacro
		const shape = candidate.sourcePad
		const x1 = -shape.widthMil / 2; const y1 = -shape.heightMil / 2; const x2 = shape.widthMil / 2; const y2 = -shape.heightMil / 2
		token = [2 * geometry.expansionRadiusMil, x1, y1, x2, y2].map(mm).join('X')
		definition = `%ADD10RoundRect,${token}*%`
	}
	const fileName = `Gerber_${side}.${side}`
	const text = `%FSLAX45Y45*%\n%MOMM*%\n${macro}\n${definition}\nG54D10*G01X${coord(geometry.centerMil[0])}Y${coord(geometry.centerMil[1])}D03*\nM02*`
	return parseGerberLayerGeometry(side, fileName, text)
}

function associate(f) {
	return analyzePadMaskOpeningAssociations({ layers: f.candidates.candidates.map(maskLayer), padCandidates: f.candidates, maskParticipation: noWitnesses })
}
function circleLayer(candidate, diameterMil = candidate.maskGeometry.openingDiameterMil) {
	const side = candidate.layer === 'top' ? 'GTS' : 'GBS'
	const text = `%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,${mm(diameterMil)}*%\nG54D10*G01X${coord(candidate.maskGeometry.centerMil[0])}Y${coord(candidate.maskGeometry.centerMil[1])}D03*\nM02*`
	return parseGerberLayerGeometry(side, `Gerber_${side}.${side}`, text)
}
function ovalCircleMixedLayer(candidate, { order = ['C', 'Oval'], unknownEndpoint = false, wrongCircleDiameter = false } = {}) {
	const side = candidate.layer === 'top' ? 'GTS' : 'GBS'
	const d = candidate.maskGeometry.openingDiameterMil
	const circleD = wrongCircleDiameter ? d + 0.01 : d
	const macroX1 = unknownEndpoint ? '0.000001' : '0'
	const definitions = `%AMOval*1,1,$1,$2,$3*1,1,$1,$4,$5*20,1,$1,$2,$3,$4,$5,0*%\n%ADD10C,${mm(circleD)}*%\n%ADD11Oval,${mm(d)}X${macroX1}X0X0X0*%`
	const flashes = order.map(kind => `G54D${kind === 'C' ? 10 : 11}*G01X${coord(candidate.maskGeometry.centerMil[0])}Y${coord(candidate.maskGeometry.centerMil[1])}D03*`).join('\n')
	return parseGerberLayerGeometry(side, `Gerber_${side}.${side}`, `%FSLAX45Y45*%\n%MOMM*%\n${definitions}\n${flashes}\nM02*`)
}

const multiBase = fixture({ pad: sourcePad({ defaultPad: { padType: 'ELLIPSE', width: 44.125, height: 44.125, radius: 0 }, hole: { holeType: 'ROUND', width: 10, height: 10, cornerRadius: 11.811 } }) })
assert.equal(multiBase.candidates.candidates.length, 2)
assert.deepEqual(multiBase.candidates.candidates.map(c => c.sourcePad.localSurface), [1, 2])
assert.ok(multiBase.candidates.candidates.every(c => c.sourcePad.localCopperLayerId === 12 && c.runtimePad.layer === 12 && c.runtimePad.runtimeBBoxModel === 'default-and-special-union'))
assert.deepEqual(multiBase.candidates.candidates.map(c => c.layer), ['top', 'bottom'])
assert.deepEqual(multiBase.candidates.candidates.map(c => c.sourcePad.selectedExpansionField), ['topSolderExpansion', 'bottomSolderExpansion'])
assert.ok(multiBase.candidates.candidates.every(c => c.sourcePad.sourceDrillMetadata.sourceHole.width === 10 && c.sourcePad.sourceDrillMetadata.padOffsetX === 0.005 && c.sourcePad.sourceDrillMetadata.plated === true))
assert.ok(associate(multiBase).matches.every(match => match.association === 'geometry-correlated'))

for (const [width, localLayer, expansion, expectedDiameter] of [[32.125, 1, 3, 38.125], [28.4501, 2, 7, 42.4501]]) {
	const equalOval = fixture({ pad: sourcePad({ defaultPad: { padType: 'OVAL', width, height: width, radius: 0 }, top: localLayer === 1 ? expansion : 3, bottom: localLayer === 2 ? expansion : 7 }) })
	assert.equal(equalOval.candidates.candidates.length, 2)
	const selected = equalOval.candidates.candidates.find(candidate => candidate.sourcePad.localSurface === localLayer)
	assert.equal(selected.maskGeometry.axisHalfLengthMil, 0)
	const match = analyzePadMaskOpeningAssociations({ layers: [circleLayer(selected)], padCandidates: equalOval.candidates, maskParticipation: noWitnesses }).matches.find(item => item.sourcePadModel.localSurface === localLayer)
	assert.equal(match.association, 'geometry-correlated', 'equal-size source OVAL is associated with the observed C flash')
	assert.equal(match.geometryChecks.positiveDiameterMatched, true)
	assert.equal(selected.maskGeometry.openingDiameterMil, expectedDiameter)
	const mixedCandidates = fixture({ pad: sourcePad({ defaultPad: { padType: 'OVAL', width, height: width, radius: 0 }, top: localLayer === 1 ? expansion : 3, bottom: localLayer === 2 ? expansion : 7 }) }).candidates
	const mixedSourceCandidate = mixedCandidates.candidates.find(candidate => candidate.sourcePad.localSurface === localLayer)
	for (const order of [['C', 'Oval'], ['Oval', 'C']]) {
		const mixed = analyzePadMaskOpeningAssociations({ layers: [ovalCircleMixedLayer(mixedSourceCandidate, { order })], padCandidates: mixedCandidates, maskParticipation: noWitnesses }).matches.find(item => item.sourcePadModel.localSurface === localLayer)
		assert.equal(mixed.association, 'ambiguous', 'C and Oval references are both candidates and neither is silently preferred')
		assert.equal(mixed.maskReferences.length, 2)
	}
	const unknownOvalCompetition = analyzePadMaskOpeningAssociations({ layers: [ovalCircleMixedLayer(mixedSourceCandidate, { unknownEndpoint: true })], padCandidates: mixedCandidates, maskParticipation: noWitnesses }).matches.find(item => item.sourcePadModel.localSurface === localLayer)
	assert.equal(unknownOvalCompetition.association, 'geometry-match-uncertain', 'unknown-precision Oval endpoint blocks a valid C reference')
	const wrongCirclePlusCorrectOval = analyzePadMaskOpeningAssociations({ layers: [ovalCircleMixedLayer(mixedSourceCandidate, { wrongCircleDiameter: true })], padCandidates: mixedCandidates, maskParticipation: noWitnesses }).matches.find(item => item.sourcePadModel.localSurface === localLayer)
	assert.equal(wrongCirclePlusCorrectOval.association, 'geometry-correlated', 'wrong-diameter C is rejected while the exact Oval macro remains a candidate')
}

const nonCircleOval = fixture({ pad: sourcePad({ defaultPad: { padType: 'OVAL', width: 40, height: 20, radius: 0 } }) })
const nonCircleCandidate = nonCircleOval.candidates.candidates[0]
assert.ok(nonCircleCandidate.maskGeometry.axisHalfLengthMil > 0)
assert.equal(analyzePadMaskOpeningAssociations({ layers: [circleLayer(nonCircleCandidate)], padCandidates: nonCircleOval.candidates, maskParticipation: noWitnesses }).matches[0].association, 'not-matched', 'a nonzero-core OVAL must not be correlated to a C flash')

const flipped = fixture({ componentLayer: 2, pad: sourcePad({ defaultPad: { padType: 'RECT', width: 38.125, height: 26.45, radius: 0 } }) })
assert.deepEqual(flipped.candidates.candidates.map(c => c.layer), ['bottom', 'top'], 'localSurface mapping follows the component side and its opposite')
assert.ok(associate(flipped).matches.every(match => match.association === 'geometry-correlated'), JSON.stringify(associate(flipped).matches))

const specialPad = sourcePad({ defaultPad: { padType: 'ELLIPSE', width: 44.125, height: 44.125, radius: 0 }, specialPad: [
	{ startLayer: 1, endLayer: 1, pad: { padType: 'RECT', width: 50.125, height: 26.45, radius: 0 } },
	{ startLayer: 2, endLayer: 2, pad: { padType: 'OVAL', width: 36.125, height: 22.25, radius: 0 } },
] })
const specialFixture = fixture({ pad: specialPad })
assert.equal(specialFixture.candidates.candidates.length, 2)
assert.deepEqual(specialFixture.candidates.candidates.map(c => c.sourcePad.shape), ['RECT', 'OVAL'])
assert.ok(specialFixture.candidates.candidates.every(c => c.runtimePad.boxMil.maxX - c.runtimePad.boxMil.minX === 50.125 && c.runtimePad.boxMil.maxY - c.runtimePad.boxMil.minY === 44.125), 'bbox union retains default ELLIPSE even though both surfaces have special pads')
assert.ok(specialFixture.candidates.candidates.every(c => c.sourcePad.runtimeBBoxModel === 'default-and-special-union'))
assert.ok(associate(specialFixture).matches.every(match => match.association === 'geometry-correlated'))

const invalids = [
	fixture({ pad: sourcePad({ specialPad: [{ startLayer: 1, endLayer: 2, pad: { padType: 'RECT', width: 20, height: 10, radius: 0 } }] }) }),
	fixture({ pad: sourcePad({ specialPad: [{ startLayer: 1, endLayer: 1, pad: { padType: 'NGON', width: 20, height: 10 } }] }) }),
	fixture({ pad: sourcePad({ specialPad: [{ startLayer: 1, endLayer: 1, pad: { padType: 'RECT', width: 20, height: 10, radius: 0 } }, { startLayer: 1, endLayer: 1, pad: { padType: 'RECT', width: 24, height: 12, radius: 0 } }] }) }),
	fixture({ pad: sourcePad({ attrsMap: { width: 1 } }) }),
	fixture({ pad: sourcePad({ hole: { holeType: 'ROUND', width: 10, height: 9, cornerRadius: 0 } }) }),
	fixture({ pad: sourcePad(), getterDelta: 0.2 }),
	fixture({ pad: sourcePad({ specialPad: [{ startLayer: 1, endLayer: 1, pad: { padType: 'RECT', width: 50, height: 20, radius: 0 } }] }), bboxMode: 'default' }),
	fixture({ pad: sourcePad(), padOverride: true }),
]
assert.ok(invalids.every(f => f.candidates.candidates.length === 0 && f.candidates.skipped.length > 0), JSON.stringify(invalids.map(f => ({ count: f.candidates.candidates.length, skipped: f.candidates.skipped }))))
assert.equal(fixture({ pad: sourcePad(), getterValues: ['RECT', 38.1, 26.5, 0] }).candidates.candidates.length, 2, '0.1 mil-rounded getter fields are accepted')
assert.equal(fixture({ pad: sourcePad(), getterValues: ['RECT', 38.125, 26.45] }).candidates.candidates.length, 0, 'missing RECT radius is rejected')
assert.equal(fixture({ pad: sourcePad(), getterValues: ['RECT', 38.125, 26.45, 0, 9] }).candidates.candidates.length, 0, 'extra getter fields are rejected')
const unequalEllipsePad = sourcePad({ defaultPad: { padType: 'ELLIPSE', width: 30, height: 25, radius: 0 } })
assert.equal(fixture({ pad: unequalEllipsePad, getterValues: ['ELLIPSE', 30, 30] }).candidates.candidates.length, 2, 'ellipse getter checks use source width for both runtime axes')
assert.equal(fixture({ pad: unequalEllipsePad, getterValues: ['ELLIPSE', 30, 25] }).candidates.candidates.length, 0, 'ellipse getter source height is not the runtime circle dimension')
assert.equal(fixture({ pad: sourcePad({ localLayer: 2 }) }).candidates.candidates.length, 0)
const overflow = fixture({ pad: sourcePad({ top: Number.MAX_VALUE, specialPad: [{ startLayer: 1, endLayer: 1, pad: { padType: 'RECT', width: Number.MAX_VALUE, height: 20, radius: 0 } }] }), getterValues: ['RECT', Number.MAX_VALUE, 20, 0] })
assert.equal(overflow.candidates.candidates.length, 1, 'one overflowing mask side is skipped while the independent valid side remains')
assert.ok(overflow.candidates.skipped.some(item => item.reason.includes('溢出')))

console.log('silkscreen multilayer pad mask regression passed')
