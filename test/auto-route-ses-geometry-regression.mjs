import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { parseAutoRouteSes, mapSesRoutes, planSesImport, verifySesImport, serializeSesSubset } from '../src/engine/autoRouteSes.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'auto-route-ses-geometry-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { parseAutoRouteSes, mapSesRoutes, planSesImport, verifySesImport, serializeSesSubset } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const realSource = await readFile(resolve(root, 'test/fixtures/auto-route-real-v223.ses'), 'utf8')
const real = parseAutoRouteSes(realSource)
assert.equal(real.wires.length, 8)
assert.equal(real.vias.length, 1)
assert.equal(real.padstacks.length, 1, 'identical repeated via0 definitions merge')
assert.deepEqual(real.placements, [{ componentId: 'u1', placeId: 'u1', xMil: 0, yMil: 0, side: 'front', rotation: 0 }])
assert.equal(real.padstacks[0].holeDiameterMil, null)
assert.equal(real.padstacks[0].holeDiameterStatus, 'not-provided-by-ses')
assert.deepEqual(real.wires[0].points, [{ xMil: 370.3, yMil: 400 }, { xMil: 370.34, yMil: 400 }])
assert.equal(real.vias[0].xMil, 300)

const ses = ({ unit = 'mil', ticks = 1000, netName = 'NET', routeGeometry = '(wire (path "Top Layer" 5000 12000 34000 13000 35000 18000 32000))', padDiameter = 24000, extra = '', libraryExtra = '', placement = '(component U1 (place U1 12345 67890 back 90))' } = {}) => `
(session "quoted (session) name"
  (placement (resolution ${unit} ${ticks}) ${placement})
  (was_is)
  (routes
    (resolution ${unit} ${ticks})
    (library_out (padstack viaA (shape (circle TopLayer ${padDiameter} 0 0))) ${libraryExtra})
    (network_out (net "${netName}" ${routeGeometry} ${extra}))
  )
)
`

const quoted = parseAutoRouteSes(ses({ netName: 'NET with (quoted) name', routeGeometry: '(wire (path "Top Layer" 5000 12000 34000 13000 35000 18000 32000))' }))
assert.equal(quoted.wires[0].net, 'NET with (quoted) name')
assert.equal(quoted.wires[0].layerName, 'Top Layer')
assert.deepEqual(quoted.wires[0].points, [
	{ xMil: 12, yMil: 34 },
	{ xMil: 13, yMil: 35 },
	{ xMil: 18, yMil: 32 },
], 'asymmetric polyline vertices are preserved in order')
assert.deepEqual(quoted.placements[0], { componentId: 'U1', placeId: 'U1', xMil: 12.345, yMil: 67.89, side: 'back', rotation: 90 })

const parenthesisValues = parseAutoRouteSes(ses({ netName: '(', placement: '(component ")" (place "(" 1 2 front 0))' }))
assert.equal(parenthesisValues.wires[0].net, '(')
assert.equal(parenthesisValues.placements[0].componentId, ')')
assert.equal(parenthesisValues.placements[0].placeId, '(')

const inch = parseAutoRouteSes(ses({ unit: 'inch', ticks: 10000, routeGeometry: '(wire (path TopLayer 1000 5000 7000 10000 13000))', placement: '(component U2 (place U2 5000 7000 front 180))' }))
assert.deepEqual(inch.wires[0].points, [{ xMil: 500, yMil: 700 }, { xMil: 1000, yMil: 1300 }])
assert.equal(inch.wires[0].widthMil, 100)
assert.deepEqual(inch.placements[0], { componentId: 'U2', placeId: 'U2', xMil: 500, yMil: 700, side: 'front', rotation: 180 })

const millimeter = parseAutoRouteSes(ses({ unit: 'mm', ticks: 1000, routeGeometry: '(wire (path BottomLayer 25400 25400 50800 76200 101600))', placement: '(component U3 (place U3 25400 50800 front 270))' }))
assert.equal(millimeter.wires[0].widthMil, 1000)
assert.deepEqual(millimeter.wires[0].points, [{ xMil: 1000, yMil: 2000 }, { xMil: 3000, yMil: 4000 }])
assert.deepEqual(millimeter.placements[0], { componentId: 'U3', placeId: 'U3', xMil: 1000, yMil: 2000, side: 'front', rotation: 270 })

const shortSource = ses({ unit: 'mil', ticks: 1000000, routeGeometry: '(wire (path TopLayer 500 0 0 500 0))', placement: '(component U1 (place U1 0 0 front 0))' }).replace('(shape (circle TopLayer 24000 0 0)))', '(shape (circle TopLayer 24000 0 0)) (shape (circle BottomLayer 24000 0 0)))')
const shortModel = parseAutoRouteSes(shortSource)
const shortLayers = [{ id: 1, name: 'Top Layer', type: 'SIGNAL' }, { id: 2, name: 'Bottom Layer', type: 'SIGNAL' }]
const shortExpected = mapSesRoutes(shortModel, shortLayers)
assert.equal(shortExpected.lines[0].b.x - shortExpected.lines[0].a.x, 0.0005, 'nonzero 0.0005 mil SES segment maps successfully')
const shortPlan = planSesImport(shortExpected, { documentUuid: 'short-board', lines: [], vias: [] }, 'append')
assert.equal(shortPlan.lineToleranceUsedMil, 0.000125, 'short-segment comparison budget is capped at one quarter of its length')
assert.equal(verifySesImport(shortPlan, { documentUuid: 'short-board', lines: shortPlan.targetLines, vias: [] }).verified, true)
assert.equal(verifySesImport(shortPlan, { documentUuid: 'short-board', lines: [], vias: [] }).verified, false, 'present expectation cannot pass with empty actual geometry')
assert.equal(verifySesImport(shortPlan, { documentUuid: 'short-board', lines: [], vias: [] }).coverage.lineToleranceUsedMil, 0.000125)
const shortSubset = serializeSesSubset(shortSource, shortExpected)
assert.equal(parseAutoRouteSes(shortSubset).wires[0].points[1].xMil, 0.0005, 'serializer round-trips a nonzero 0.0005 mil line')
const partialShortPlan = planSesImport(shortExpected, { documentUuid: 'short-board', lines: [{ net: shortExpected.lines[0].net, layer: shortExpected.lines[0].layer, widthMil: shortExpected.lines[0].widthMil, a: { x: 0, y: 0 }, b: { x: 0.0002, y: 0 } }], vias: [] }, 'append')
assert.equal(partialShortPlan.deltaLines.length, 1)
assert.ok(partialShortPlan.deltaLines[0].b.x - partialShortPlan.deltaLines[0].a.x > 0, 'partial subtraction preserves a nonzero short remainder')
assert.throws(() => mapSesRoutes(parseAutoRouteSes(ses({ unit: 'mil', ticks: 1000000, routeGeometry: '(wire (path TopLayer 500 0 0 0 0))' }).replace('(shape (circle TopLayer 24000 0 0)))', '(shape (circle TopLayer 24000 0 0)) (shape (circle BottomLayer 24000 0 0)))')), shortLayers), /零长线/)

assert.throws(() => parseAutoRouteSes(ses().replace('(resolution mil 1000)', '(resolution mil 0)')), /ticksPerUnit 必须大于 0/)
assert.throws(() => parseAutoRouteSes(ses().replace('    (resolution mil 1000)\n    (library_out', '    (library_out')), /routes 缺少 resolution/)
assert.throws(() => parseAutoRouteSes(ses().slice(0, -3)), /未闭合|不完整/)
assert.throws(() => parseAutoRouteSes(`${ses()} (trailing)`), /恰有一个根表达式/)
assert.throws(() => parseAutoRouteSes(ses({ routeGeometry: '(wire (arc TopLayer 1 2 3))' })), /缺少 path 几何|不支持的几何/)
assert.throws(() => parseAutoRouteSes(ses({ routeGeometry: '(wire (path TopLayer 1 1 2 3 4) unexpected)' })), /不支持的标量字段/)
assert.throws(() => parseAutoRouteSes(ses({ routeGeometry: '(via viaA 1 2 unexpected)' })), /不支持的标量字段/)
assert.throws(() => parseAutoRouteSes(ses({ extra: '(area TopLayer 1 2 3)' })), /不支持的 routes 几何/)
assert.throws(() => parseAutoRouteSes(ses({ routeGeometry: '(via missingVia 1 2)' })), /未定义 padstack missingVia/)
assert.throws(() => parseAutoRouteSes(ses({ padDiameter: 24000, libraryExtra: '(padstack viaA (shape (circle TopLayer 25000 0 0)))' })), /重复定义冲突/)
assert.throws(() => parseAutoRouteSes(ses({ placement: '(component U1 (place U1 1 2 left 0))' })), /不支持 placement side/)
assert.throws(() => parseAutoRouteSes(ses({ placement: '(component U1 (place U1 1 2 front))' })), /缺少 id\/x\/y\/side\/rotation/)

const layers = [
	{ id: 1, name: 'Top Layer', type: 'SIGNAL' },
	{ id: 2, name: 'Bottom Layer', type: 'SIGNAL' },
]
const mapped = mapSesRoutes(real, layers)
assert.equal(mapped.lines.length, 8)
assert.ok(mapped.lines.every(line => line.layer === 1))
assert.equal(mapped.vias[0].diameterMil, 24)
assert.equal(mapped.vias[0].holeDiameterMil, undefined, 'SES does not invent a hole diameter')
assert.equal(mapped.coordinateMapping, 'easyeda-pro-4.1.78-direct-xy')
assert.throws(() => mapSesRoutes(real, [{ id: 1, name: 'Top Layer', type: 'SIGNAL' }]), /未能唯一映射/)
assert.throws(() => mapSesRoutes(real, [{ id: 1, name: 'Top Layer', type: 'SIGNAL' }, { id: 2, name: 'Bottom Layer', type: 'DOCUMENT' }]), /不是 SIGNAL/)

const existingLines = mapped.lines.filter(line => Math.abs(line.widthMil - 12) < 0.001).map((line, index) => ({ ...line, id: `existing-${index}`, locked: false }))
assert.equal(existingLines.length, 3)
const existingVias = [{ ...mapped.vias[0], id: 'existing-via', holeDiameterMil: 12, viaType: 0, locked: false }]
const before = { documentUuid: 'board-A', lines: existingLines, vias: existingVias, source: 'baseline-source' }
const appendPlan = planSesImport(mapped, before, 'append')
assert.equal(appendPlan.deltaLines.length, 5, 'subtracting three existing long paths leaves five short lines')
assert.equal(appendPlan.deltaVias.length, 0, 'existing 24/12 via is retained')
assert.equal(appendPlan.alreadyPresent, false)
assert.equal(appendPlan.targetVias[0].holeDiameterMil, 12)
const verifiedAppend = verifySesImport(appendPlan, { ...before, lines: appendPlan.targetLines, vias: appendPlan.targetVias })
assert.equal(verifiedAppend.verified, true)
assert.equal(verifiedAppend.coverage.toleranceMil, 0.001)
assert.equal(verifiedAppend.coverage.holeDiameterVerified, true)

const alreadyPlan = planSesImport(mapped, { documentUuid: 'board-A', lines: mapped.lines, vias: [{ ...mapped.vias[0], holeDiameterMil: 12 }] }, 'append')
assert.equal(alreadyPlan.deltaLines.length, 0)
assert.equal(alreadyPlan.deltaVias.length, 0)
assert.equal(alreadyPlan.alreadyPresent, true, 'fully present input needs no SDK import')

const replacePlan = planSesImport(mapped, before, 'replace-unlocked')
assert.equal(replacePlan.deleteLines.length, 3)
assert.equal(replacePlan.deleteVias.length, 1)
assert.equal(replacePlan.deltaLines.length, 8)
assert.equal(replacePlan.deltaVias.length, 1)
assert.equal(replacePlan.deltaVias[0].holeDiameterMil, 12, 'same known via retains its known drill expectation')
assert.equal(verifySesImport(replacePlan, { ...before, lines: replacePlan.targetLines, vias: replacePlan.targetVias.map(via => ({ ...via, viaType: 0 })) }).verified, true)

const lockedBaseline = {
	documentUuid: 'board-A',
	lines: [{ ...mapped.lines[0], locked: true, id: 'locked' }, { ...mapped.lines[1], locked: false, id: 'unlocked' }],
	vias: [],
}
const lockedPlan = planSesImport(mapped, lockedBaseline, 'replace-unlocked')
assert.deepEqual(lockedPlan.retainedLines.map(line => line.id), ['locked'])
assert.deepEqual(lockedPlan.deleteLines.map(line => line.id), ['unlocked'])
assert.equal(lockedPlan.deltaLines.length, 7, 'expected geometry covered by locked line is not duplicated')

const partialSource = parseAutoRouteSes(ses({ routeGeometry: '(wire (path TopLayer 1000 0 0 10000 0 20000 0))', placement: '(component U1 (place U1 0 0 front 0))' }))
const partialExpected = mapSesRoutes(partialSource, layers)
const partialPlan = planSesImport(partialExpected, {
	documentUuid: 'board-A',
	lines: [{ net: 'NET', layer: 1, widthMil: 1, a: { x: 4, y: 0 }, b: { x: 6, y: 0 } }],
	vias: [],
}, 'append')
assert.equal(partialPlan.deltaLines.length, 3, 'subtracts covered middle intervals without dropping uncovered path portions')
assert.throws(() => planSesImport(partialExpected, { documentUuid: 'board-A', lines: [{ net: 'OTHER', layer: 1, widthMil: 1, a: { x: 4, y: 0 }, b: { x: 6, y: 0 } }], vias: [] }, 'append'), /不同网络\/层\/线宽/)
const otherLayerPlan = planSesImport(partialExpected, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 2, widthMil: 1, a: { x: 4, y: 0 }, b: { x: 6, y: 0 } }], vias: [] }, 'append')
assert.equal(otherLayerPlan.deltaLines.length, 2, 'identical XY geometry on another copper layer does not block either expected path')
assert.throws(() => planSesImport(partialExpected, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 4, y: 0 }, b: { x: 6, y: 0 } }], vias: [] }, 'append'), /不同网络\/层\/线宽/)

const simpleExpected = { ...mapped, lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] }
const simplePlan = planSesImport(simpleExpected, { documentUuid: 'board-A', lines: [], vias: [] }, 'append')
const splitReverse = verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [
	{ net: 'NET', layer: 1, widthMil: 2, a: { x: 5, y: 0 }, b: { x: 0, y: 0 } },
	{ net: 'NET', layer: 1, widthMil: 2, a: { x: 10, y: 0 }, b: { x: 5, y: 0 } },
], vias: [] })
assert.equal(splitReverse.verified, true, 'reversed and split collinear lines retain equivalent coverage')
const quantizedSesPlan = planSesImport({ ...mapped, lines: [{ id: 'expected-1005', net: 'NET', layer: 1, widthMil: 10.05, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] }, { documentUuid: 'board-A', lines: [], vias: [] }, 'append')
const quantizedReadback = verifySesImport(quantizedSesPlan, { documentUuid: 'board-A', lines: [{ id: 'actual-10', net: 'NET', layer: 1, widthMil: 10, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] })
assert.equal(quantizedReadback.verified, false, '10.05 mil expected versus 10 mil readback remains a strict verification failure')
assert.deepEqual(quantizedReadback.differences.map(item => item.code), ['lineWidthMismatch'], 'complete same-net/same-layer geometry gets a width-only diagnostic')
assert.equal(quantizedReadback.differences[0].expectedWidthMil, 10.05)
assert.equal(quantizedReadback.differences[0].actualWidthMil, 10)
assert.ok(Math.abs(quantizedReadback.differences[0].differenceMil + 0.05) < 1e-12)
assert.equal(quantizedReadback.differences[0].expectedLineId, 'expected-1005')
assert.equal(quantizedReadback.differences[0].actualLineId, 'actual-10')
const largeWidthMismatch = verifySesImport(planSesImport({ ...mapped, lines: [{ id: 'expected-7536', net: 'NET', layer: 1, widthMil: 7.536, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] }, { documentUuid: 'board-A', lines: [], vias: [] }, 'append'), { documentUuid: 'board-A', lines: [{ id: 'actual-10-large', net: 'NET', layer: 1, widthMil: 10, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] })
assert.equal(largeWidthMismatch.verified, false, '7.536 mil expected versus 10 mil readback is never tolerated')
assert.equal(largeWidthMismatch.differences[0].code, 'lineWidthMismatch')
assert.ok(Math.abs(largeWidthMismatch.differences[0].differenceMil - 2.464) < 1e-12)
const geometryMissingWithWidthDrift = verifySesImport(quantizedSesPlan, { documentUuid: 'board-A', lines: [{ id: 'short-actual', net: 'NET', layer: 1, widthMil: 10, a: { x: 0, y: 0 }, b: { x: 9.9, y: 0 } }], vias: [] })
assert.ok(geometryMissingWithWidthDrift.differences.some(item => item.code === 'lineCoverageMissing'), 'a real 0.1 mil geometry gap remains a coverage failure')
assert.ok(geometryMissingWithWidthDrift.differences.some(item => item.code === 'lineWidthMismatch'), 'covered portion still reports its width drift')
const wrongNetReadback = verifySesImport(quantizedSesPlan, { documentUuid: 'board-A', lines: [{ id: 'wrong-net', net: 'OTHER', layer: 1, widthMil: 10.05, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] })
assert.ok(wrongNetReadback.differences.some(item => item.code === 'lineCoverageMissing'))
assert.ok(wrongNetReadback.differences.some(item => item.code === 'lineCoverageUnexpected'))
assert.ok(!wrongNetReadback.differences.some(item => item.code === 'lineWidthMismatch'), 'different-net geometry is not misclassified as a width-only mismatch')
const wrongLayerReadback = verifySesImport(quantizedSesPlan, { documentUuid: 'board-A', lines: [{ id: 'wrong-layer', net: 'NET', layer: 2, widthMil: 10.05, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] })
assert.ok(wrongLayerReadback.differences.some(item => item.code === 'lineCoverageMissing'))
assert.ok(wrongLayerReadback.differences.some(item => item.code === 'lineCoverageUnexpected'))
assert.ok(!wrongLayerReadback.differences.some(item => item.code === 'lineWidthMismatch'), 'different-layer geometry is not misclassified as a width-only mismatch')
const repeatedReadback = verifySesImport(quantizedSesPlan, { documentUuid: 'board-A', lines: [
	{ id: 'actual-10-duplicate-a', net: 'NET', layer: 1, widthMil: 10, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
	{ id: 'actual-10-duplicate-b', net: 'NET', layer: 1, widthMil: 10, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
], vias: [] })
assert.ok(repeatedReadback.differences.some(item => item.code === 'lineCoverageUnexpected'), 'duplicate geometry remains an unexpected multiplicity failure')
assert.ok(!repeatedReadback.differences.some(item => item.code === 'lineWidthMismatch'), 'duplicate multiplicity is not hidden behind a width diagnosis')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2.0006, a: { x: 0, y: 0.0006 }, b: { x: 10, y: 0.0006 } }], vias: [] }).verified, true, 'width and support offsets within tolerance pass across fixed-quantum bucket boundaries')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2.0011, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] }).verified, false, 'width outside tolerance fails')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0.0011 }, b: { x: 10, y: 0.0011 } }], vias: [] }).verified, false, 'support offset outside tolerance fails')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 10, y: 0.0006 } }], vias: [] }).verified, true, 'endpoint remains within perpendicular support tolerance despite slight angle')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 10, y: 0.0011 } }], vias: [] }).verified, false, 'endpoint outside perpendicular support tolerance fails')
const hundredMilExpected = { ...simpleExpected, lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }] }
const hundredMilPlan = planSesImport(hundredMilExpected, { documentUuid: 'board-A', lines: [], vias: [] }, 'append')
assert.equal(verifySesImport(hundredMilPlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 99.9985, y: 0 } }], vias: [] }).verified, false, 'tail coverage gap greater than tolerance is detected')
assert.equal(verifySesImport(hundredMilPlan, { documentUuid: 'board-A', lines: [{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 99.9994, y: 0 } }], vias: [] }).verified, true, 'tail coverage gap within tolerance is accepted')
assert.equal(verifySesImport(hundredMilPlan, { documentUuid: 'board-A', lines: [
	{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 49.99925, y: 0 } },
	{ net: 'NET', layer: 1, widthMil: 2, a: { x: 50.00075, y: 0 }, b: { x: 100, y: 0 } },
], vias: [] }).verified, false, 'middle coverage gap greater than tolerance is detected')
assert.equal(verifySesImport(hundredMilPlan, { documentUuid: 'board-A', lines: [
	{ net: 'NET', layer: 1, widthMil: 2, a: { x: 0, y: 0 }, b: { x: 49.9997, y: 0 } },
	{ net: 'NET', layer: 1, widthMil: 2, a: { x: 50.0003, y: 0 }, b: { x: 100, y: 0 } },
], vias: [] }).verified, true, 'middle coverage gap within tolerance is accepted')
for (const changed of [
	{ net: 'WRONG', layer: 1, widthMil: 2 },
	{ net: 'NET', layer: 2, widthMil: 2 },
	{ net: 'NET', layer: 1, widthMil: 3 },
]) {
	const failed = verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [{ ...changed, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], vias: [] })
	assert.equal(failed.verified, false)
}
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [], vias: [] }).verified, false, 'zero SDK geometry cannot satisfy a non-empty expectation')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [...simplePlan.targetLines, { net: 'NET', layer: 1, widthMil: 2, a: { x: 20, y: 0 }, b: { x: 20.0005, y: 0 } }], vias: [] }).verified, false, 'unexpected nonzero 0.0005 mil line is detected')
assert.equal(verifySesImport(simplePlan, { documentUuid: 'board-A', lines: [...simplePlan.targetLines, { ...simplePlan.targetLines[0], id: 'overlap-short', a: { x: 5, y: 0 }, b: { x: 5.0005, y: 0 } }], vias: [] }).verified, false, 'overlaid nonzero 0.0005 mil line is detected as extra multiplicity')
assert.equal(verifySesImport(appendPlan, { ...before, lines: appendPlan.targetLines.filter(line => !(Math.abs(line.widthMil - 10.05) < 0.001 && line.net === 'ACE_IN_A')), vias: appendPlan.targetVias }).verified, false, 'missing .04 mil short segment is detected')
assert.equal(verifySesImport(appendPlan, { ...before, lines: [...appendPlan.targetLines, appendPlan.deltaLines[0]], vias: appendPlan.targetVias }).verified, false, 'duplicate overlay increases coverage multiplicity and is detected')

const viaOnlyExpected = { ...mapped, lines: [], vias: [mapped.vias[0]] }
const viaPlan = planSesImport(viaOnlyExpected, { documentUuid: 'board-A', lines: [], vias: [] }, 'append')
assert.equal(verifySesImport(viaPlan, { documentUuid: 'board-A', lines: [], vias: [viaPlan.deltaVias[0], viaPlan.deltaVias[0]] }).verified, false, 'overlapping duplicate vias are detected as a multiset difference')
const knownHolePlan = planSesImport(viaOnlyExpected, { documentUuid: 'board-A', lines: [], vias: [{ ...mapped.vias[0], holeDiameterMil: 12 }] }, 'replace-unlocked')
assert.equal(verifySesImport(knownHolePlan, { documentUuid: 'board-A', lines: [], vias: [{ ...knownHolePlan.deltaVias[0], holeDiameterMil: 10 }] }).differences[0].code, 'viaHoleDiameterChanged')
for (const missingHole of [undefined, Number.NaN]) {
	const result = verifySesImport(knownHolePlan, { documentUuid: 'board-A', lines: [], vias: [{ ...knownHolePlan.deltaVias[0], holeDiameterMil: missingHole }] })
	assert.equal(result.verified, false, 'missing or non-finite known hole diameter cannot pass verification')
	assert.ok(result.differences.some(item => item.code === 'viaHoleDiameterChanged'))
}

const subsetText = serializeSesSubset(realSource, { ...mapped, lines: appendPlan.deltaLines, vias: appendPlan.deltaVias })
const subsetModel = parseAutoRouteSes(subsetText)
assert.equal(subsetModel.wires.length, 5, 'serialized append SES contains only the five uncovered paths')
assert.ok(appendPlan.deltaLines.every(line => Math.abs(line.widthMil - 10.05) < 1e-9), 'fixture delta retains the five 0.04 mil paths at width 10.05 mil')
assert.equal(subsetModel.vias.length, 0)
assert.deepEqual(subsetModel.placements, real.placements, 'serializer preserves placement metadata without inferring movement')
assert.equal(subsetModel.padstacks.length, real.padstacks.length)
assert.equal((subsetText.match(/\(wire\s*\r?\n/g) ?? []).length, 5, 'wire and path headers are emitted on distinct lines')
assert.doesNotMatch(subsetText, /\(wire[ \t]+\(path/, 'wire/path must not be serialized inline')
assert.equal((subsetText.match(/^\s+\(path (?:TopLayer|BottomLayer) [\d.eE+-]+\r?$/gm) ?? []).length, 5, 'each wire has a separately indented path line')
assert.equal((subsetText.match(/^\s+[\d.eE+-]+ [\d.eE+-]+\s*$/gm) ?? []).length, 10, 'each path coordinate pair has its own line')
assert.match(subsetText, /\(net "?ACE_IN_A"?\r?\n/, 'net and route boundaries are multiline')
const quotedSubset = serializeSesSubset(ses(), { ...partialExpected, lines: [{ net: '(', layer: 1, widthMil: 1, a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }], vias: [] })
assert.equal(parseAutoRouteSes(quotedSubset).wires[0].net, '(', 'serializer quotes parenthesis route names correctly')
const unicodeNet = '中文 "网"(A)'
const unicodeSource = ses({ netName: unicodeNet.replace(/"/g, '\\"') })
const unicodeSubset = serializeSesSubset(unicodeSource, { ...partialExpected, lines: [{ net: unicodeNet, layer: 1, widthMil: 1, a: { x: 1, y: 2 }, b: { x: 3, y: 4 } }], vias: [] })
assert.equal(parseAutoRouteSes(unicodeSubset).wires[0].net, unicodeNet, 'Chinese, quotes, and parentheses survive multiline serialization')
console.log('PASS SES geometry parser consumes complete input and preserves route, via, padstack, and placement expectations')
