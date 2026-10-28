import assert from 'node:assert/strict'
import { parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'

const MM_PER_MIL = 0.0254
const toMm = mil => (mil * MM_PER_MIL).toFixed(5)
const toCoord = mil => String(Math.round(mil * 2540))
const macro = '%AMRect*21,1,$1,$2,0,0,$3*%'
function parseWithAperture(aperture, operations, { macroBody = macro, includeMacro = true } = {}) {
	const definitions = `${includeMacro ? `${macroBody}\n` : ''}${aperture}`
	return parseGerberLayerGeometry('GTS', 'Gerber_TopSolderMaskLayer.GTS', `%FSLAX45Y45*%\n%MOMM*%\n${definitions}\n${operations}\nM02*`)
}
function flash(code, center, operation = 'D03') { return `G54D${code}*G01X${toCoord(center[0])}Y${toCoord(center[1])}${operation}*` }
function polygonArea(ring) {
	let twice = 0
	for (let index = 0; index < ring.length - 1; index++) twice += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1]
	return Math.abs(twice) / 2
}
function close(actual, expected, tolerance = 1e-9) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`) }

const center = [123, 87]
const width = 37
const height = 24.25
const rect = parseWithAperture(`%ADD10Rect,${toMm(width)}X${toMm(height)}X0*%`, flash(10, center))
const rectangle = parseWithAperture(`%ADD10R,${toMm(width)}X${toMm(height)}*%`, flash(10, center), { includeMacro: false })
assert.equal(rect.complete, true)
assert.deepEqual(rect.shapes[0].geometryLower, rectangle.shapes[0].geometryLower, 'zero-degree Rect macro follows the existing R flash geometry')
assert.deepEqual(rect.shapes[0].geometryUpper, rectangle.shapes[0].geometryUpper)
assert.deepEqual(rect.apertures[0].parameters, [Number(toMm(width)), Number(toMm(height)), 0], 'original three macro parameters remain available')
assert.deepEqual(rect.usedMacros, ['Rect'])
close(polygonArea(rect.shapes[0].geometryLower[0][0]), width * height)

const angle = 37
const rotated = parseWithAperture(`%ADD10Rect,${toMm(width)}X${toMm(height)}X${angle}*%`, flash(10, center))
assert.equal(rotated.complete, true)
const theta = angle * Math.PI / 180
const localCorners = [[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2, height / 2], [-width / 2, height / 2]]
const expectedCorners = localCorners.map(([x, y]) => [center[0] + x * Math.cos(theta) - y * Math.sin(theta), center[1] + x * Math.sin(theta) + y * Math.cos(theta)])
const observedCorners = rotated.shapes[0].geometryLower[0][0].slice(0, -1)
assert.equal(observedCorners.length, 4)
for (const [x, y] of expectedCorners) assert.ok(observedCorners.some(([actualX, actualY]) => Math.hypot(actualX - x, actualY - y) < 1e-9), '37 degree corners are independently rotated around the macro origin')
close(polygonArea(rotated.shapes[0].geometryLower[0][0]), width * height)
const equivalentAngle = parseWithAperture(`%ADD10Rect,${toMm(width)}X${toMm(height)}X397*%`, flash(10, center))
assert.deepEqual(equivalentAngle.shapes[0].geometryLower, rotated.shapes[0].geometryLower, 'angles normalize over full revolutions')

const negativeNinety = parseWithAperture(`%ADD10Rect,${toMm(30)}X${toMm(10)}X-90*%`, flash(10, center))
const negativeBox = negativeNinety.shapes[0].geometryLower[0][0]
const xs = negativeBox.map(point => point[0]); const ys = negativeBox.map(point => point[1])
close(Math.max(...xs) - Math.min(...xs), 10)
close(Math.max(...ys) - Math.min(...ys), 30)
close(polygonArea(negativeBox), 300)

const badCases = [
	{ aperture: '%ADD10Rect,0.9X0.5X*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,0.9X0.5*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,0.9X0.5X0X4*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,0X0.5X0*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,0.9X-0.5X0*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,0.9X0.5XNaN*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,1e308X0.5X0*%', operations: flash(10, center) },
	{ aperture: '%ADD10Rect,0.9X0.5X0*%', operations: flash(10, center, 'D01') },
]
for (const { aperture, operations } of badCases) {
	const parsed = parseWithAperture(aperture, operations)
	assert.equal(parsed.complete, false, aperture)
	assert.equal(parsed.shapes.length, 0, 'unsupported Rect never emits partial geometry')
}
const wrongBody = parseWithAperture('%ADD10Rect,0.9X0.5X0*%', flash(10, center), { macroBody: '%AMRect*21,1,$1,$2,0,0,$3*21,1,$1,$2,0,0,$3*%' })
assert.equal(wrongBody.complete, false, 'macro name alone does not authorize different semantics')
assert.equal(wrongBody.shapes.length, 0)

const paintOrder = parseWithAperture(`%ADD10Rect,${toMm(30)}X${toMm(20)}X37*%\n%ADD11Rect,${toMm(10)}X${toMm(8)}X-90*%`, `${flash(10, center)}\n%LPC*%\n${flash(11, center)}`)
assert.equal(paintOrder.complete, true)
assert.deepEqual(paintOrder.shapes.map(shape => shape.polarity), ['dark', 'clear'], 'clear paint stays after dark paint in source order')
assert.equal(paintOrder.shapes[0].kind, 'flash')
assert.equal(paintOrder.shapes[1].kind, 'flash')
assert.ok(polygonArea(paintOrder.shapes[0].geometryLower[0][0]) > polygonArea(paintOrder.shapes[1].geometryLower[0][0]))

console.log('silkscreen Rect macro regression passed')
