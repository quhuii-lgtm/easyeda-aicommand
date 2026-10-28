import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'
import JSZip from 'jszip'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const fixturePath = resolve(root, 'test', 'fixtures', 'silkscreen-gerber-v073.zip')
const source = await readFile(resolve(root, 'src', 'pcb', 'silkscreenGerber.ts'), 'utf8')
assert.match(source, /export async function analyzeSilkscreenGerber/u)
const built = await build({
	stdin: {
		contents: `export { analyzeSilkscreenGerber, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'silkscreen-gerber-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { analyzeSilkscreenGerber, parseGerberLayerGeometry } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function coordinate(mil) { return String(Math.round(mil * 25.4 * 100000 / 1000)) }
function makeGerber({ gto = '', gbo = '', gts = '', gbs = '', gko = 'G54D10*G01X0Y0D02*G01X2540000Y0D01*G01X2540000Y2540000D01*G01X0Y2540000D01*G01X0Y0D01*', extraApertures = '' } = {}) {
	const header = `%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.254*%\n${extraApertures}\nG75*\n`
	const zip = new JSZip()
	zip.file('Gerber_TopSilkscreenLayer.GTO', `${header}${gto}\nM02*`)
	zip.file('Gerber_BottomSilkscreenLayer.GBO', `${header}${gbo}\nM02*`)
	zip.file('Gerber_TopSolderMaskLayer.GTS', `${header}${gts}\nM02*`)
	zip.file('Gerber_BottomSolderMaskLayer.GBS', `${header}${gbs}\nM02*`)
	zip.file('Gerber_BoardOutlineLayer.GKO', `${header}${gko}\nM02*`)
	return zip.generateAsync({ type: 'uint8array' })
}
async function analyzeSynthetic(args, clearance = 0) {
	return analyzeSilkscreenGerber(await makeGerber(args), clearance)
}
function layer(report, name) { return report.files.find(item => item.layer === name) }

const realZip = new Uint8Array(await readFile(fixturePath))
const real = await analyzeSilkscreenGerber(realZip, 0)
const gerberZip = await JSZip.loadAsync(realZip)
const realGboEntry = gerberZip.file('Gerber_BottomSilkscreenLayer.GBO')
const realGtsEntry = gerberZip.file('Gerber_TopSolderMaskLayer.GTS')
const realGbo = parseGerberLayerGeometry('GBO', realGboEntry.name, await realGboEntry.async('string'))
const realGts = parseGerberLayerGeometry('GTS', realGtsEntry.name, await realGtsEntry.async('string'))
assert.equal(real.scope, 'exported-manufacturing-only')
assert.equal(real.complete, true, `real ZIP is fully supported: ${real.unknowns.join('; ')}`)
assert.deepEqual(real.files.map(item => item.layer).sort(), ['GBO', 'GBS', 'GKO', 'GTO', 'GTS'])
assert.deepEqual(layer(real, 'GTO').counts, { draws: 20, moves: 10, flashes: 0, regions: 0, regionContours: 0, dark: 20, clear: 0 })
assert.equal(layer(real, 'GBO').counts.draws, 585)
assert.equal(layer(real, 'GBO').counts.regions, 9)
assert.equal(layer(real, 'GBO').counts.regionContours, 9)
assert.equal(layer(real, 'GTS').counts.flashes, 18)
assert.equal(layer(real, 'GBS').counts.flashes, 9)
assert.deepEqual(layer(real, 'GKO').boardOutlineBoundsMil, { minX: 0, minY: 0, maxX: 1200, maxY: 1000 })
assert.equal(layer(real, 'GTS').usedMacros.includes('RoundRect'), true)
assert.equal(real.coverage.boardOutline, 'single-simple-closed-loop')
assert.equal(real.polygonApproximation.targetSagittaMil, 0.01)
assert.equal(real.polygonApproximation.numericDistanceMarginMil, 0.01)
assert.equal('shapes' in real.files[0], false, 'production response keeps polygon point arrays out of the response')
const installedFixturePath = resolve(root, 'test', 'fixtures', 'silkscreen-gerber-v094.zip')
const installedGeometryPath = resolve(root, 'test', 'fixtures', 'silkscreen-gerber-v094-arc-oracle.json')
const installedZipBytes = new Uint8Array(await readFile(installedFixturePath))
const installedEdgeReport = await analyzeSilkscreenGerber(installedZipBytes, 0)
const installedZip = await JSZip.loadAsync(installedZipBytes)
const installedOracle = JSON.parse(await readFile(installedGeometryPath, 'utf8'))
const oracleArcs = installedOracle.observations.flatMap(item => item.segments
	.filter(segment => segment.local.type === 'arc')
	.map(segment => ({ layer: item.layer, ...segment.manufacturing.actual })))
assert.equal(oracleArcs.length, 25, 'the installed fixture oracle covers 25 verified manufactured arcs')
const installedParsed = new Map()
const installedSources = new Map()
for (const name of ['GTO', 'GBO', 'GTS', 'GBS', 'GKO']) {
	const side = name === 'GTO' || name === 'GTS' ? 'Top' : name === 'GBO' || name === 'GBS' ? 'Bottom' : 'BoardOutline'
	const entry = installedZip.file(`Gerber_${side}${name === 'GTO' || name === 'GBO' ? 'SilkscreenLayer' : name === 'GTS' || name === 'GBS' ? 'SolderMaskLayer' : 'Layer'}.${name}`)
	assert.ok(entry, `installed fixture contains ${name}`)
	const gerberSource = await entry.async('string')
	installedSources.set(name, gerberSource)
	installedParsed.set(name, parseGerberLayerGeometry(name, entry.name, gerberSource))
}
const installedArcResults = ['GTO', 'GBO'].flatMap(name => installedParsed.get(name).shapes.filter(shape => shape.arcApproximation).map(shape => ({ layer: name, approximation: shape.arcApproximation })))
assert.equal(installedArcResults.length, 25, 'all real exported circular strokes produce arc geometry')
assert.equal(installedEdgeReport.confirmedConflicts.length, 3, 'the added witness does not change real confirmed conflict count')
assert.equal(installedEdgeReport.potentialConflicts.length, 1, 'the added witness does not change the real potential conflict count')
const installedBoardEdge = installedEdgeReport.potentialConflicts.find(item => item.category === 'silk-to-board-edge' && item.layer === 'top')
assert.ok(installedBoardEdge, 'the real top board-edge candidate is preserved')
assert.deepEqual({ lower: installedBoardEdge.distanceLowerBoundMil, upper: installedBoardEdge.distanceUpperBoundMil, status: installedBoardEdge.status, confirmed: installedBoardEdge.confirmed }, { lower: 0, upper: 0, status: 'potential', confirmed: false }, 'distance, status and confirmed fields remain unchanged for the real candidate')
assert.equal(installedBoardEdge.locationKind, 'distance-witness')
assert.equal(installedBoardEdge.locationEnumerationComplete, false)
assert.ok(installedBoardEdge.locationWitness)
assert.ok(Math.abs(installedBoardEdge.locationWitness.boardPointMil[0] - 1200) <= 1e-9, 'the real witness is on the x=1200mil board edge')
assert.ok(Math.abs(installedBoardEdge.locationWitness.measuredDistanceMil - installedBoardEdge.distanceLowerBoundMil) <= 1e-9)
assert.equal(installedBoardEdge.locationUnavailable, undefined)
const unmatchedInstalledArcs = [...installedArcResults]
for (const expected of oracleArcs) {
	const resultIndex = unmatchedInstalledArcs.findIndex(item => item.layer === expected.layer
		&& Math.hypot(item.approximation.start[0] - expected.a[0], item.approximation.start[1] - expected.a[1]) < 0.002
		&& Math.hypot(item.approximation.end[0] - expected.b[0], item.approximation.end[1] - expected.b[1]) < 0.002)
	assert.ok(resultIndex >= 0, `manufactured arc endpoints exist on ${expected.layer}`)
	const result = unmatchedInstalledArcs.splice(resultIndex, 1)[0]
	assert.ok(result, `manufactured arc start exists on ${expected.layer}`)
	assert.ok(Math.hypot(result.approximation.end[0] - expected.b[0], result.approximation.end[1] - expected.b[1]) < 0.002, 'arc endpoint matches installed geometry oracle')
	assert.ok(Math.hypot(result.approximation.center[0] - expected.center[0], result.approximation.center[1] - expected.center[1]) < 0.002, 'arc center matches installed geometry oracle')
	assert.ok(Math.abs(result.approximation.radiusMil - expected.radius) < 0.002, 'arc radius matches installed geometry oracle within manufacturing quantization')
	assert.ok(Math.abs(result.approximation.sweepDegrees - expected.sweepDegrees) < 0.002, 'arc direction and sweep match installed geometry oracle')
}
assert.equal(installedParsed.get('GTS').shapes.some(shape => shape.apertureId === 11), true, 'rotated installed RoundRect aperture is decoded')
assert.equal(installedParsed.get('GBS').shapes.some(shape => shape.apertureId === 10 || shape.apertureId === 12), true, 'bottom installed RoundRect apertures are decoded')
function pointInRing([x, y], ring) {
	let inside = false
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i], b = ring[j]
		if (((a[1] > y) !== (b[1] > y)) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
	}
	return inside
}
function pointInPolygons(point, polygons) {
	return polygons.some(poly => pointInRing(point, poly[0]) && !poly.slice(1).some(hole => pointInRing(point, hole)))
}
function exposureContains(layerReport, point, polarity, bound = 'lower') {
	const geometryKey = bound === 'lower' ? 'geometryLower' : 'geometryUpper'
	return layerReport.shapes.filter(shape => shape.polarity === polarity).some(shape => pointInPolygons(point, shape[geometryKey]))
}
const milPoint = ([x, y]) => [x * 1000 / 25.4, y * 1000 / 25.4]
const offsetCoordinate = coordinate
function boundsOf(polygons) {
	const points = polygons.flatMap(poly => poly.flatMap(ring => ring))
	return { minX: Math.min(...points.map(p => p[0])), minY: Math.min(...points.map(p => p[1])), maxX: Math.max(...points.map(p => p[0])), maxY: Math.max(...points.map(p => p[1])) }
}
function distanceToSegment(p, a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1]
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
	return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
function roundedRhombusContains(p, center, p1, p2, radius) {
	const q = [p1, p2, [-p1[0], -p1[1]], [-p2[0], -p2[1]]].map(([x, y]) => [center[0] + x, center[1] + y])
	const translated = [p[0] - center[0], p[1] - center[1]]
	const localQ = [p1, p2, [-p1[0], -p1[1]], [-p2[0], -p2[1]]]
	if (pointInRing(translated, [...localQ, localQ[0]])) return true
	return q.some((a, index) => distanceToSegment(p, a, q[(index + 1) % q.length]) <= radius)
}
for (const [name, apertureIds] of [['GTS', [11]], ['GBS', [10, 12]]]) {
	const parsed = installedParsed.get(name)
	for (const apertureId of apertureIds) {
		const shape = parsed.shapes.find(item => item.kind === 'flash' && item.apertureId === apertureId)
		assert.ok(shape, `${name} D${apertureId} RoundRect flash exists`)
		const aperture = parsed.apertures.find(item => item.id === apertureId)
		assert.ok(aperture && aperture.shape === 'RoundRect')
		const [diameter, x1, y1, x2, y2] = aperture.parameters.map(value => value * 1000 / 25.4)
		const p1 = [x1, y1], p2 = [x2, y2], radius = diameter / 2
		const upperBounds = boundsOf(shape.geometryUpper)
		const lowerBounds = boundsOf(shape.geometryLower)
		const center = [(upperBounds.minX + upperBounds.maxX) / 2, (upperBounds.minY + upperBounds.maxY) / 2]
		const vertices = [p1, p2, [-x1, -y1], [-x2, -y2]]
		const theoretical = {
			minX: center[0] + Math.min(...vertices.map(p => p[0])) - radius,
			minY: center[1] + Math.min(...vertices.map(p => p[1])) - radius,
			maxX: center[0] + Math.max(...vertices.map(p => p[0])) + radius,
			maxY: center[1] + Math.max(...vertices.map(p => p[1])) + radius,
		}
		assert.ok(upperBounds.minX <= theoretical.minX && upperBounds.minY <= theoretical.minY && upperBounds.maxX >= theoretical.maxX && upperBounds.maxY >= theoretical.maxY, `${name} D${apertureId} upper bbox encloses the independent Minkowski bound`)
		assert.ok(lowerBounds.minX >= theoretical.minX - 1e-6 && lowerBounds.minY >= theoretical.minY - 1e-6 && lowerBounds.maxX <= theoretical.maxX + 1e-6 && lowerBounds.maxY <= theoretical.maxY + 1e-6, `${name} D${apertureId} lower bbox stays within the exact Minkowski bound`)
		const q = [p1, p2, [-x1, -y1], [-x2, -y2]]
		const midpoints = q.map((p, index) => [(p[0] + q[(index + 1) % 4][0]) / 2, (p[1] + q[(index + 1) % 4][1]) / 2])
		const oraclePoints = [[0, 0], ...q, ...midpoints]
		for (const [x, y] of oraclePoints) {
			const target = [center[0] + x, center[1] + y]
			assert.equal(roundedRhombusContains(target, center, p1, p2, radius), true, 'independent oracle point belongs to rounded polygon')
			assert.equal(pointInPolygons(target, shape.geometryUpper), true, `${name} D${apertureId} outer geometry contains the oracle point`)
		}
		const farOutside = [theoretical.maxX + 1, theoretical.maxY + 1]
		assert.equal(pointInPolygons(farOutside, shape.geometryUpper), false, `${name} D${apertureId} outer geometry does not grow beyond its exact bound`)
	}
}
const gtsSource = installedSources.get('GTS')
const macroToken = gtsSource.match(/%AMRoundRect\*[\s\S]*?%/u)?.[0]
assert.ok(macroToken, 'the exact RoundRect macro body is present in the installed fixture')
const changedMacroToken = macroToken.replace('1,1,$1', '2,1,$1')
assert.notEqual(changedMacroToken, macroToken)
const changedMacro = parseGerberLayerGeometry('GTS', 'changed-macro.GTS', gtsSource.replace(macroToken, changedMacroToken))
assert.ok(changedMacro.unsupported.some(item => item.includes('未经精确确认的RoundRect宏')))
assert.equal(changedMacro.shapes.some(shape => shape.apertureId === 11), false, 'a changed macro body is never evaluated as known geometry')
const collinearRoundRect = parseGerberLayerGeometry('GTS', 'collinear-roundrect.GTS', gtsSource.replace('%ADD11RoundRect,0.1016X-0.432X-0.40324X-0.432X0.40324*%', '%ADD11RoundRect,0.1016X-0.432X-0.40324X-0.864X-0.80648*%'))
assert.equal(collinearRoundRect.shapes.some(shape => shape.apertureId === 11), false, 'collinear Q vertices are rejected instead of convex-hull repaired')
assert.ok(collinearRoundRect.unsupported.some(item => item.includes('D11')))
const nonfiniteRoundRect = parseGerberLayerGeometry('GTS', 'nonfinite-roundrect.GTS', gtsSource.replace('%ADD11RoundRect,0.1016X-0.432X-0.40324X-0.432X0.40324*%', '%ADD11RoundRect,0.1016XInfinityX-0.40324X-0.432X0.40324*%'))
assert.equal(nonfiniteRoundRect.shapes.some(shape => shape.apertureId === 11), false, 'non-finite RoundRect parameters are rejected')
const zeroRoundRect = parseGerberLayerGeometry('GTS', 'zero-roundrect.GTS', gtsSource.replace('%ADD11RoundRect,0.1016X-0.432X-0.40324X-0.432X0.40324*%', '%ADD11RoundRect,0X-0.432X-0.40324X-0.432X0.40324*%'))
assert.equal(zeroRoundRect.shapes.some(shape => shape.apertureId === 11), false, 'zero-diameter RoundRect apertures are rejected')
const negativeRoundRect = parseGerberLayerGeometry('GTS', 'negative-roundrect.GTS', gtsSource.replace('%ADD11RoundRect,0.1016X-0.432X-0.40324X-0.432X0.40324*%', '%ADD11RoundRect,-0.1016X-0.432X-0.40324X-0.432X0.40324*%'))
assert.equal(negativeRoundRect.shapes.some(shape => shape.apertureId === 11), false, 'negative-diameter RoundRect apertures are rejected')
function parseInstalledSource(layerName, body) {
	const sourceHeader = `%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.254*%\nG75*\n`
	return parseGerberLayerGeometry(layerName, `synthetic.${layerName}`, `${sourceHeader}${body}\nM02*`)
}
const syntheticArcCases = [
	{ name: 'ccw90', direction: 'G03', end: [0, 100], offset: [-100, 0], sweep: 90 },
	{ name: 'cw90', direction: 'G02', end: [0, -100], offset: [-100, 0], sweep: -90 },
	{ name: 'ccw180', direction: 'G03', end: [-100, 0], offset: [-100, 0], sweep: 180 },
	{ name: 'cw180', direction: 'G02', end: [-100, 0], offset: [-100, 0], sweep: -180 },
	{ name: 'ccw270', direction: 'G03', end: [0, -100], offset: [-100, 0], sweep: 270 },
	{ name: 'cw270', direction: 'G02', end: [0, 100], offset: [-100, 0], sweep: -270 },
	{ name: 'ccw-full', direction: 'G03', end: [100, 0], offset: [0, 100], sweep: 360 },
	{ name: 'cw-full', direction: 'G02', end: [100, 0], offset: [0, 100], sweep: -360 },
]
for (const item of syntheticArcCases) {
	const body = `G54D10*G01X${coordinate(100)}Y${coordinate(0)}D02*${item.direction}X${coordinate(item.end[0])}Y${coordinate(item.end[1])}I${offsetCoordinate(item.offset[0])}J${offsetCoordinate(item.offset[1])}D01*`
	const parsed = parseInstalledSource('GTO', body)
	assert.equal(parsed.complete, true, `${item.name} is accepted: ${parsed.unsupported.join('; ')}`)
	assert.equal(parsed.counts.draws, 1)
	assert.equal(parsed.arcApproximation.arcCount, 1)
	assert.ok(Math.abs(parsed.shapes[0].arcApproximation.sweepDegrees - item.sweep) < 1e-8, `${item.name} sweep is correct`)
	assert.ok(parsed.shapes[0].arcApproximation.maxSagittaMil <= 0.0100001, `${item.name} records actual adaptive sagitta`)
}
const modalArc = parseInstalledSource('GTO', `G54D10*G01X${coordinate(100)}Y0D02*G03*X0Y${coordinate(100)}I-${coordinate(100)}J0D01*G03*X${coordinate(110)}Y${coordinate(100)}D01*G01X${coordinate(120)}Y${coordinate(100)}D01*`)
assert.equal(modalArc.arcApproximation.arcCount, 1, 'G03 is modal and I/J belong only to their own arc record')
assert.ok(modalArc.unsupported.some(item => item.includes('圆弧D01必须在同一记录显式包含I和J')), 'a following arc cannot inherit I/J')
assert.equal(modalArc.shapes.filter(shape => shape.kind === 'stroke').length, 1, 'the failed inherited-I/J arc and post-error G01 line are not emitted')
assert.ok(modalArc.unsupported.some(item => item.includes('直到下一个D02')), 'position trust remains cleared after an unsupported arc')
const d02Recovery = parseInstalledSource('GTO', `G54D10*G01X${coordinate(100)}Y0D02*G03X0Y${coordinate(100)}I-${coordinate(100)}J0D01*G03X${coordinate(120)}Y${coordinate(100)}I-${coordinate(120)}D01*G01X${coordinate(125)}Y${coordinate(100)}D01*G01X${coordinate(120)}Y${coordinate(100)}D02*G01X${coordinate(130)}Y${coordinate(100)}D01*`)
assert.equal(d02Recovery.complete, false, 'the malformed arc keeps the file incomplete')
assert.equal(d02Recovery.shapes.filter(shape => shape.kind === 'stroke').length, 2, 'the malformed dependent line is skipped, leaving one arc and one D02-recovered line')
assert.equal(d02Recovery.arcApproximation.arcCount, 1)
assert.ok(d02Recovery.unsupported.some(item => item.includes('必须在同一记录显式包含I和J')))
assert.ok(d02Recovery.unsupported.some(item => item.includes('直到下一个D02')))
const recoveredLine = d02Recovery.shapes.filter(shape => shape.kind === 'stroke' && shape.centerline).at(-1)
assert.ok(Math.hypot(recoveredLine.centerline[0][0] - 120, recoveredLine.centerline[0][1] - 100) < 0.002, 'the recovered line starts at the D02 position in mils')
assert.ok(Math.hypot(recoveredLine.centerline[1][0] - 130, recoveredLine.centerline[1][1] - 100) < 0.002, 'the recovered line ends at its target in mils')

for (const [field, repeatedRecord] of [
	['I', `G03X0Y${coordinate(100)}I-${coordinate(100)}I999999J0D01*`],
	['X', `G01X${coordinate(105)}X${coordinate(106)}Y${coordinate(100)}D01*`],
]) {
	const duplicate = parseInstalledSource('GTO', `G54D10*G01X${coordinate(100)}Y0D02*${repeatedRecord}G01X${coordinate(110)}Y${coordinate(100)}D01*G01X${coordinate(120)}Y${coordinate(100)}D02*G01X${coordinate(130)}Y${coordinate(100)}D01*`)
	assert.equal(duplicate.complete, false, `repeated ${field} marks the record unsupported`)
	assert.ok(duplicate.unsupported.some(item => item.includes(`重复字段 ${field}`)))
	assert.equal(duplicate.shapes.filter(shape => shape.kind === 'stroke').length, 1, `the post-error drawing is skipped until D02 for repeated ${field}`)
	assert.ok(Math.hypot(duplicate.shapes[0].centerline[0][0] - 120, duplicate.shapes[0].centerline[0][1] - 100) < 0.002, `D02 recovers the line start after repeated ${field}`)
	assert.ok(Math.hypot(duplicate.shapes[0].centerline[1][0] - 130, duplicate.shapes[0].centerline[1][1] - 100) < 0.002, `D02 recovers the line endpoint after repeated ${field}`)
	assert.ok(duplicate.unsupported.some(item => item.includes('直到下一个D02')))
}

const lowerArcBody = `G54D10*G01X${coordinate(100)}Y${coordinate(200)}D02*G03X${coordinate(300)}Y${coordinate(200)}I${coordinate(100)}J0D01*`
const actualArcClearance = await analyzeSynthetic({ gto: lowerArcBody, gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*` }, 0)
assert.equal(actualArcClearance.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), false, 'a mask flash on the chord but far from the actual lower semicircle is not a conflict')
const actualArcOverlap = await analyzeSynthetic({ gto: lowerArcBody, gts: `G54D10*G01X${coordinate(200)}Y${coordinate(100)}D03*` }, 0)
assert.equal(actualArcOverlap.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), true, 'silk near the actual curved body is detected')

const g74Arc = parseInstalledSource('GTO', `G54D10*G01X${coordinate(100)}Y0D02*G74*G02X0Y${coordinate(-100)}I-${coordinate(100)}J0D01*`)
assert.equal(g74Arc.arcApproximation.arcCount, 0)
assert.ok(g74Arc.unsupported.some(item => item.includes('G75')))
const noG75Body = `G54D10*G01X${coordinate(100)}Y0D02*G02X0Y${coordinate(-100)}I-${coordinate(100)}J0D01*`
const noG75 = parseGerberLayerGeometry('GTO', 'no-g75.GTO', `%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.254*%\n${noG75Body}M02*`)
assert.ok(noG75.unsupported.some(item => item.includes('G75')))
const nonCircularArc = parseGerberLayerGeometry('GTO', 'non-circular.GTO', `%FSLAX45Y45*%\n%MOMM*%\n%ADD11R,0.254X0.508*%\nG75*G54D11*G01X${coordinate(100)}Y0D02*G02X0Y${coordinate(-100)}I-${coordinate(100)}J0D01*M02*`)
assert.ok(nonCircularArc.unsupported.some(item => item.includes('C光圈')))
const invalidIJ = parseInstalledSource('GTO', `G54D10*G01X${coordinate(100)}Y0D02*G03X0Y${coordinate(100)}I-${coordinate(100)}D01*`)
assert.equal(invalidIJ.arcApproximation.arcCount, 0)
assert.ok(invalidIJ.unsupported.some(item => item.includes('显式包含I和J')))
const zeroRadius = parseInstalledSource('GTO', `G54D10*G01X${coordinate(100)}Y0D02*G03X${coordinate(100)}Y0I0J0D01*`)
assert.equal(zeroRadius.arcApproximation.arcCount, 0)
assert.ok(zeroRadius.unsupported.some(item => item.includes('几何参数无效')))
const regionArc = parseInstalledSource('GTO', `G36*G54D10*G01X${coordinate(100)}Y0D02*G03X0Y${coordinate(100)}I-${coordinate(100)}J0D01*G37*`)
assert.equal(regionArc.shapes.length, 0, 'an unsupported arc invalidates the complete region')
assert.ok(regionArc.unsupported.some(item => item.includes('区域圆弧')))
const malformedRegionArc = parseInstalledSource('GTO', `G36*G01X0Y0D02*X${coordinate(100)}Y0D01*G03X${coordinate(100)}Y${coordinate(100)}IbadJ0D01*G01X${coordinate(100)}Y${coordinate(100)}D01*X0Y${coordinate(100)}D01*X0Y0D01*G37*`)
assert.equal(malformedRegionArc.complete, false)
assert.equal(malformedRegionArc.shapes.filter(shape => shape.kind === 'region').length, 0, 'an unparseable graphic record invalidates the whole open region')
assert.ok(malformedRegionArc.unsupported.some(item => item.includes('不支持的Gerber命令')))
assert.ok(malformedRegionArc.unsupported.some(item => item.includes('不支持记录的区域')))
const outlineArc = parseGerberLayerGeometry('GKO', 'outline-arc.GKO', `%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.254*%\nG75*G54D10*G01X${coordinate(100)}Y0D02*G02X0Y${coordinate(-100)}I-${coordinate(100)}J0D01*M02*`)
assert.ok(outlineArc.unsupported.some(item => item.includes('GKO圆弧')))
assert.equal(outlineArc.boardOutline.length, 0)
for (const point of [[14.6, 12.56], [14.6, 12.88]]) {
	assert.equal(exposureContains(realGbo, milPoint(point), 'dark'), true, 'the dark substrate is present before LPC clear subtraction')
	assert.equal(exposureContains(realGbo, milPoint(point), 'clear', 'upper'), true, 'both exported LPC holes are represented on native bottom-side coordinates')
}
assert.equal(exposureContains(realGbo, milPoint([14.6, 12.72]), 'dark'), true, 'the bottom-side stroke remains between the LPC holes')
assert.equal(exposureContains(realGbo, milPoint([14.6, 12.72]), 'clear', 'upper'), false)
const d17 = realGts.shapes.find(shape => shape.apertureId === 17)
assert.ok(d17, 'the D17 RoundRect flash exists')
const d17TrueBounds = { minX: 938, minY: 358, maxX: 1062, maxY: 442 }
const d17LowerBounds = boundsOf(d17.geometryLower)
const d17UpperBounds = boundsOf(d17.geometryUpper)
assert.ok(d17UpperBounds.minX <= d17TrueBounds.minX && d17TrueBounds.minX <= d17LowerBounds.minX, 'D17 lower and upper bounds bracket the exact minimum X')
assert.ok(d17UpperBounds.minY <= d17TrueBounds.minY && d17TrueBounds.minY <= d17LowerBounds.minY, 'D17 lower and upper bounds bracket the exact minimum Y')
assert.ok(d17LowerBounds.maxX <= d17TrueBounds.maxX && d17TrueBounds.maxX <= d17UpperBounds.maxX, 'D17 lower and upper bounds bracket the exact maximum X')
assert.ok(d17LowerBounds.maxY <= d17TrueBounds.maxY && d17TrueBounds.maxY <= d17UpperBounds.maxY, 'D17 lower and upper bounds bracket the exact maximum Y')
for (const target of [[1000, 400], [1000, 430], [1050, 400]])
	assert.equal(pointInPolygons(target, d17.geometryLower), true, `D17 lower geometry includes expected interior point ${target.join(',')}`)

const touching = await analyzeSynthetic({
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D02*G01X${coordinate(220)}Y${coordinate(200)}D01*`,
	gts: `G54D10*G01X${coordinate(224)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(touching.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), true, 'positive-area overlap of inner polygons is confirmed at zero threshold')

const contact = await analyzeSynthetic({
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D02*G01X${coordinate(220)}Y${coordinate(200)}D01*`,
	gts: `G54D10*G01X${coordinate(230)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(contact.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), false, 'zero-area contact is not a confirmed clash')
assert.equal(contact.potentialConflicts.some(item => item.category === 'silk-to-mask-opening'), true, 'zero-area contact remains a potential candidate')

const spaced = await analyzeSynthetic({
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D02*G01X${coordinate(220)}Y${coordinate(200)}D01*`,
	gts: `G54D10*G01X${coordinate(233)}Y${coordinate(200)}D03*`,
}, 5)
assert.equal(spaced.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), true, 'distance upper bound below threshold is confirmed')

const outsideBoard = await analyzeSynthetic({
	gto: `G54D10*G01X${coordinate(1200)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(outsideBoard.confirmedConflicts.some(item => item.category === 'silk-outside-board'), true, 'silk fully outside the nominal board polygon is detected even when far from the outline')

const safeClearance = await analyzeSynthetic({
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D02*G01X${coordinate(220)}Y${coordinate(200)}D01*`,
	gts: `G54D10*G01X${coordinate(235)}Y${coordinate(200)}D03*`,
}, 4)
assert.equal(safeClearance.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), false)
assert.equal(safeClearance.potentialConflicts.some(item => item.category === 'silk-to-mask-opening'), false, 'clearance above the requested threshold yields no conflict candidate')

const clearCutout = await analyzeSynthetic({
	extraApertures: '%ADD11C,0.3048*%\n',
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*%LPC*%\nG54D11*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
	gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(clearCutout.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), false, 'LPC removes a larger opening from the dark silkscreen exposure')

const repaintedAfterClear = await analyzeSynthetic({
	extraApertures: '%ADD11C,0.508*%\n',
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*%LPC*%G54D11*G01X${coordinate(200)}Y${coordinate(200)}D03*%LPD*%G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
	gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(repaintedAfterClear.complete, true, `repaint exposure sequence parses: ${repaintedAfterClear.unknowns.join('; ')}`)
assert.equal(layer(repaintedAfterClear, 'GTO').counts.flashes, 3)
assert.equal(repaintedAfterClear.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), true, 'a later dark exposure repaints a previously cleared area')
const clearedAfterDark = await analyzeSynthetic({
	extraApertures: '%ADD11C,0.508*%\n',
	gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*%LPC*%G54D11*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
	gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(clearedAfterDark.complete, true, `clear-after-dark sequence parses: ${clearedAfterDark.unknowns.join('; ')}`)
assert.equal(layer(clearedAfterDark, 'GTO').counts.flashes, 3)
assert.equal(clearedAfterDark.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), false, 'a later clear exposure removes earlier dark exposures')

const standaloneD03 = await analyzeSynthetic({ gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D02*D03*` }, 0)
const explicitD03 = await analyzeSynthetic({ gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*` }, 0)
assert.equal(standaloneD03.complete, true, `standalone D03 parses: ${standaloneD03.unknowns.join('; ')}`)
assert.equal(explicitD03.complete, true, `explicit D03 parses: ${explicitD03.unknowns.join('; ')}`)
assert.equal(layer(standaloneD03, 'GTS').counts.flashes, layer(explicitD03, 'GTS').counts.flashes, 'standalone D03 flashes at the known current coordinate')
assert.equal(layer(standaloneD03, 'GTS').counts.dark, layer(explicitD03, 'GTS').counts.dark)
assert.deepEqual(standaloneD03.confirmedConflicts, explicitD03.confirmedConflicts)
const unknownPositionD03 = await analyzeSynthetic({ gts: 'G54D10*D03*' }, 0)
assert.equal(unknownPositionD03.complete, false, 'standalone D03 without a known position is incomplete')

const areaEpsilon = real.polygonApproximation.numericAreaEpsilonMil2
const tinyAreaCases = [
	{ edgeMm: 0.00003, status: 'confirmed', bucket: 'confirmedConflicts' },
	{ edgeMm: 0.00001, status: 'potential', bucket: 'potentialConflicts' },
]
for (const item of tinyAreaCases) {
	const theoreticalAreaMil2 = (item.edgeMm * 1000 / 25.4) ** 2
	assert.equal(theoreticalAreaMil2 > areaEpsilon, item.status === 'confirmed', 'the synthetic overlap area straddles the report epsilon as intended')
	const tinyContainedIntersection = await analyzeSynthetic({
		extraApertures: `%ADD11R,${item.edgeMm}X${item.edgeMm}*%\n`,
		gto: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
		gts: `G54D11*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
	}, 0)
	assert.equal(tinyContainedIntersection.complete, true, `tiny overlap parses: ${tinyContainedIntersection.unknowns.join('; ')}`)
	const tinyOverlap = tinyContainedIntersection[item.bucket].find(conflict => conflict.category === 'silk-to-mask-opening')
	assert.ok(tinyOverlap, `a tiny fully contained rectangle remains a ${item.status} overlap`)
	assert.equal(tinyOverlap.status, item.status)
	assert.equal(tinyOverlap.distanceLowerBoundMil, 0, 'any polygon intersection has zero distance regardless of the area epsilon')
}

const regionUnion = await analyzeSynthetic({
	gto: `G36*G01X${coordinate(100)}Y${coordinate(100)}D02*G01X${coordinate(300)}Y${coordinate(100)}D01*G01X${coordinate(300)}Y${coordinate(300)}D01*G01X${coordinate(100)}Y${coordinate(300)}D01*G01X${coordinate(100)}Y${coordinate(100)}D01*G01X${coordinate(150)}Y${coordinate(150)}D02*G01X${coordinate(250)}Y${coordinate(150)}D01*G01X${coordinate(250)}Y${coordinate(250)}D01*G01X${coordinate(150)}Y${coordinate(250)}D01*G01X${coordinate(150)}Y${coordinate(150)}D01*G37*`,
	gts: `G54D10*G01X${coordinate(200)}Y${coordinate(200)}D03*`,
}, 0)
assert.equal(regionUnion.complete, true, 'multiple G36 D02 contours are accepted as independent filled regions')
assert.equal(layer(regionUnion, 'GTO').counts.regions, 1)
assert.equal(layer(regionUnion, 'GTO').counts.regionContours, 2)
assert.equal(regionUnion.confirmedConflicts.some(item => item.category === 'silk-to-mask-opening'), true, 'nested region contours are union-filled rather than treated as an even-odd hole')

function outlineMil(x0, y0, x1, y1) {
	return `G54D10*G01X${coordinate(x0)}Y${coordinate(y0)}D02*G01X${coordinate(x1)}Y${coordinate(y0)}D01*G01X${coordinate(x1)}Y${coordinate(y1)}D01*G01X${coordinate(x0)}Y${coordinate(y1)}D01*G01X${coordinate(x0)}Y${coordinate(y0)}D01*`
}
function edgeConflict(report) {
	return [...report.confirmedConflicts, ...report.potentialConflicts].find(item => item.category === 'silk-to-board-edge' && item.layer === 'top')
}
function assertWitnessMatchesBounds(conflict, tolerance = 1e-9) {
	assert.equal(conflict.locationKind, 'distance-witness')
	assert.equal(conflict.locationEnumerationComplete, false)
	assert.ok(conflict.locationWitness)
	const witness = conflict.locationWitness
	assert.deepEqual(conflict.locationBoundsMil, [{
		minX: Math.min(witness.silkPointMil[0], witness.boardPointMil[0]),
		minY: Math.min(witness.silkPointMil[1], witness.boardPointMil[1]),
		maxX: Math.max(witness.silkPointMil[0], witness.boardPointMil[0]),
		maxY: Math.max(witness.silkPointMil[1], witness.boardPointMil[1]),
	}])
	assert.ok(Math.abs(Math.hypot(witness.silkPointMil[0] - witness.boardPointMil[0], witness.silkPointMil[1] - witness.boardPointMil[1]) - witness.measuredDistanceMil) <= tolerance)
	assert.ok(Math.abs(conflict.distanceLowerBoundMil - witness.measuredDistanceMil) <= tolerance)
}

const crossingEdge = edgeConflict(await analyzeSynthetic({
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D10*G01X${coordinate(20)}Y${coordinate(-10)}D02*G01X${coordinate(20)}Y${coordinate(10)}D01*`,
}, 0))
assert.ok(crossingEdge)
assertWitnessMatchesBounds(crossingEdge)
assert.equal(crossingEdge.locationWitness.kind, 'intersection', 'a true silk outer-envelope/board-edge crossing has a shared point')
assert.equal(crossingEdge.locationWitness.measuredDistanceMil, 0)

const collinearEdge = edgeConflict(await analyzeSynthetic({
	extraApertures: '%ADD11R,0.254X0.254*%',
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D11*G01X${coordinate(25)}Y${coordinate(-5)}D03*`,
}, 0))
assert.ok(collinearEdge)
assertWitnessMatchesBounds(collinearEdge)
assert.equal(collinearEdge.locationWitness.kind, 'intersection', 'collinear outer-envelope and GKO segments share a point')
assert.equal(collinearEdge.locationWitness.silkPointMil[1], 0)
assert.ok(collinearEdge.locationWitness.silkPointMil[0] >= 20 && collinearEdge.locationWitness.silkPointMil[0] <= 30)

const endpointEdge = edgeConflict(await analyzeSynthetic({
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D10*G01X${coordinate(-5)}Y0D02*G01X0Y0D01*`,
}, 0))
assert.ok(endpointEdge)
assertWitnessMatchesBounds(endpointEdge)
assert.ok(['intersection', 'contained-point'].includes(endpointEdge.locationWitness.kind), 'endpoint contact is represented by an actual shared/contained point')

const degenerateEdge = edgeConflict(await analyzeSynthetic({
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D10*G01X0Y${coordinate(50)}D02*G01X0Y${coordinate(50)}D01*`,
}, 0))
assert.ok(degenerateEdge, 'a degenerate zero-length D01 still yields its manufactured flash-like stroke witness')
assertWitnessMatchesBounds(degenerateEdge)

const containedEdge = edgeConflict(await analyzeSynthetic({
	extraApertures: '%ADD11C,0.508*%',
	gko: outlineMil(0, 0, 10, 10),
	gto: `G54D11*G01X${coordinate(5)}Y${coordinate(5)}D03*`,
}, 0))
assert.ok(containedEdge)
assertWitnessMatchesBounds(containedEdge)
assert.equal(containedEdge.locationWitness.kind, 'contained-point', 'a board-edge point inside the outer envelope is reported as contained')

const holeBoardEdge = edgeConflict(await analyzeSynthetic({
	gko: outlineMil(40, 40, 60, 60),
	gto: `G54D10*%LPD*%G36*G01X${coordinate(-20)}Y${coordinate(-20)}D02*G01X${coordinate(120)}Y${coordinate(-20)}D01*G01X${coordinate(120)}Y${coordinate(120)}D01*G01X${coordinate(-20)}Y${coordinate(120)}D01*G01X${coordinate(-20)}Y${coordinate(-20)}D01*G37*%LPC*%G36*G01X${coordinate(30)}Y${coordinate(30)}D02*G01X${coordinate(70)}Y${coordinate(30)}D01*G01X${coordinate(70)}Y${coordinate(70)}D01*G01X${coordinate(30)}Y${coordinate(70)}D01*G01X${coordinate(30)}Y${coordinate(30)}D01*G37*`,
}, 11))
assert.ok(holeBoardEdge)
assertWitnessMatchesBounds(holeBoardEdge)
assert.equal(holeBoardEdge.locationWitness.kind, 'nearest-points', 'clear-paint holes are excluded from containment and distance is measured to the remaining ring')
assert.ok(Math.abs(holeBoardEdge.locationWitness.measuredDistanceMil - 10) <= 1e-9)

const nonzeroEdge = edgeConflict(await analyzeSynthetic({
	extraApertures: '%ADD11R,0.508X0.254*%',
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D11*G01X${coordinate(115)}Y${coordinate(50)}D03*`,
}, 6))
assert.ok(nonzeroEdge)
assertWitnessMatchesBounds(nonzeroEdge)
assert.equal(nonzeroEdge.locationWitness.kind, 'nearest-points')
assert.ok(Math.abs(nonzeroEdge.locationWitness.measuredDistanceMil - 5) <= 1e-9)
assert.equal(nonzeroEdge.locationWitness.silkPointMil[0], 105)
assert.equal(nonzeroEdge.locationWitness.boardPointMil[0], 100)
assert.ok(nonzeroEdge.locationWitness.silkPointMil[1] >= 45 && nonzeroEdge.locationWitness.silkPointMil[1] <= 55)
assert.ok(nonzeroEdge.locationWitness.boardPointMil[1] >= 45 && nonzeroEdge.locationWitness.boardPointMil[1] <= 55)

const clearedEdge = await analyzeSynthetic({
	extraApertures: '%ADD11R,0.254X0.254*%',
	gko: outlineMil(0, 0, 100, 100),
	gto: `%LPD*%G54D11*G01X0Y${coordinate(50)}D03*%LPC*%G54D11*G01X0Y${coordinate(50)}D03*`,
}, 0)
assert.equal(edgeConflict(clearedEdge), undefined, 'clear-paint removal means no edge witness is emitted for removed ink')

const multipleEdge = edgeConflict(await analyzeSynthetic({
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D10*G01X${coordinate(20)}Y${coordinate(-10)}D02*G01X${coordinate(20)}Y${coordinate(10)}D01*G01X${coordinate(80)}Y${coordinate(-10)}D02*G01X${coordinate(80)}Y${coordinate(10)}D01*`,
}, 0))
assert.ok(multipleEdge)
assertWitnessMatchesBounds(multipleEdge)
assert.equal(multipleEdge.locationBoundsMil.length, 1, 'multiple edge contacts still report one witness, not all conflict locations')
assert.equal(multipleEdge.locationEnumerationComplete, false)

const nearTouchEdge = edgeConflict(await analyzeSynthetic({
	extraApertures: '%ADD11R,0.2539999999746X0.254*%',
	gko: outlineMil(0, 0, 100, 100),
	gto: `G54D11*G01X${coordinate(105)}Y${coordinate(50)}D03*`,
}, 0))
assert.ok(nearTouchEdge)
assert.equal(nearTouchEdge.locationWitness?.kind, 'nearest-points', 'a numeric near-contact is never relabeled as an intersection')
assert.ok(nearTouchEdge.locationWitness.measuredDistanceMil > 0, 'the tiny nonzero geometric gap is retained in the witness')
assert.ok(nearTouchEdge.locationWitness.measuredDistanceMil <= 1e-9, 'the near-contact gap stays within the documented witness agreement tolerance')
assert.ok(Math.abs(nearTouchEdge.locationWitness.measuredDistanceMil - 4.999947122996673e-10) <= 1e-12)
assert.ok(Math.abs(nearTouchEdge.locationWitness.silkPointMil[0] - 100.0000000005) <= 1e-10)
assert.equal(nearTouchEdge.locationWitness.boardPointMil[0], 100)
assertWitnessMatchesBounds(nearTouchEdge)

let edgeWitnessBudgetCalls = 0
await assert.rejects(() => analyzeSilkscreenGerber(installedZipBytes, 0, () => { if (++edgeWitnessBudgetCalls === 1) throw new Error('edge-witness-budget-stop') }), /edge-witness-budget-stop/u)

const unknownArc = await analyzeSynthetic({ gto: 'G02X100Y100D01*' }, 0)
assert.equal(unknownArc.complete, false)
assert.equal(unknownArc.confirmedConflicts.length, 0, 'unsupported commands invalidate all collision conclusions')
assert.ok(unknownArc.unknowns.some(item => item.includes('当前位置未知') || item.includes('圆弧缺少G75')))

const unknownPolarity = await analyzeSynthetic({ gto: '%LPX*%' }, 0)
assert.equal(unknownPolarity.complete, false)
assert.equal(unknownPolarity.confirmedConflicts.length, 0)

const badGko = await analyzeSynthetic({ gko: 'G54D10*G01X0Y0D02*G01X2540000Y2540000D01*' }, 0)
assert.equal(badGko.complete, false)
assert.equal(badGko.coverage.boardOutline, 'incomplete')
assert.equal(badGko.confirmedConflicts.length, 0)

const outline = 'G54D10*G01X0Y0D02*G01X2540000Y0D01*G01X2540000Y2540000D01*G01X0Y2540000D01*G01X0Y0D01*'
const regionOnOutline = `G36*G01X${coordinate(100)}Y${coordinate(100)}D02*G01X${coordinate(200)}Y${coordinate(100)}D01*G01X${coordinate(200)}Y${coordinate(200)}D01*G01X${coordinate(100)}Y${coordinate(200)}D01*G01X${coordinate(100)}Y${coordinate(100)}D01*G37*`
const clearOnOutline = `%LPC*%G54D10*G01X${coordinate(100)}Y${coordinate(100)}D02*G01X${coordinate(200)}Y${coordinate(100)}D01*`
for (const extra of [`G54D10*G01X${coordinate(100)}Y${coordinate(100)}D03*`, regionOnOutline, clearOnOutline]) {
	const invalidOutline = await analyzeSynthetic({ gko: `${outline}${extra}` }, 0)
	assert.equal(invalidOutline.complete, false, 'GKO flashes, regions, and clear drawings invalidate the outline interpretation')
	assert.equal(invalidOutline.coverage.boardOutline, 'incomplete')
}

const drawBeforeUnitChange = await analyzeSynthetic({ gto: `G54D10*G01X${coordinate(100)}Y${coordinate(100)}D02*G01X${coordinate(120)}Y${coordinate(100)}D01*%MOIN*%` }, 0)
assert.equal(drawBeforeUnitChange.complete, false, 'unit declarations after drawing invalidate interpretation')
const drawBeforePrecisionChange = await analyzeSynthetic({ gto: `G54D10*G01X${coordinate(100)}Y${coordinate(100)}D02*G01X${coordinate(120)}Y${coordinate(100)}D01*%FSLAX34Y34*%` }, 0)
assert.equal(drawBeforePrecisionChange.complete, false, 'coordinate precision changes after drawing invalidate interpretation')
const g01FlashBeforeFormat = parseGerberLayerGeometry('GTS', 'late-fs.GTS', `%MOMM*%\n%ADD10C,0.254*%\nG54D10*\nG01X${coordinate(100)}Y${coordinate(100)}D03*\n%FSLAX45Y45*%\nM02*`)
assert.equal(g01FlashBeforeFormat.complete, false, 'a G01 coordinate flash before the only FS declaration is incomplete')
assert.ok(g01FlashBeforeFormat.unsupported.includes('首次绘制前没有坐标格式声明'))
const g01FlashBeforeUnits = parseGerberLayerGeometry('GTS', 'late-mo.GTS', `%FSLAX45Y45*%\n%ADD10C,0.254*%\nG54D10*\nG01X${coordinate(100)}Y${coordinate(100)}D03*\n%MOMM*%\nM02*`)
assert.equal(g01FlashBeforeUnits.complete, false, 'a G01 coordinate flash before the only MO declaration is incomplete')
assert.ok(g01FlashBeforeUnits.unsupported.includes('首次绘制前没有单位声明'))

let budgetCalls = 0
await assert.rejects(() => analyzeSilkscreenGerber(realZip, 0, () => { if (++budgetCalls === 5) throw new Error('budget-stop') }), /budget-stop/u)
assert.ok(budgetCalls >= 5, 'budget callback is periodically checked and exceptions are not swallowed')

await assert.rejects(() => analyzeSilkscreenGerber(realZip, -1), /non-negative/u)
await assert.rejects(() => analyzeSilkscreenGerber(new Uint8Array(), 0), /non-empty/u)

console.log('silkscreen Gerber regression passed: real export and parser controls')
