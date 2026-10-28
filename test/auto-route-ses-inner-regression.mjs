import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { parseAutoRouteSes, mapSesRoutes, planSesImport, verifySesImport, serializeSesSubset } from '../src/engine/autoRouteSes.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'auto-route-ses-inner-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { parseAutoRouteSes, mapSesRoutes, planSesImport, verifySesImport, serializeSesSubset } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

// Source evidence: feedback-fix-20261020/evidence/ac-20261021-a8-native.ses and
// ac-20261021-a8-layers.json; the layer fixture contains the relevant original result.data rows.
const sesText = await readFile(resolve(root, 'test/fixtures/auto-route-inner-host-v062.ses'), 'utf8')
const layers = JSON.parse(await readFile(resolve(root, 'test/fixtures/auto-route-inner-host-v062-layers.json'), 'utf8'))
const model = parseAutoRouteSes(sesText)
assert.equal(model.wires.length, 9)
assert.equal(model.vias.length, 4)
assert.equal(model.padstacks.length, 1)
assert.equal(model.padstacks[0].holeDiameterStatus, 'not-provided-by-ses')

const expected = mapSesRoutes(model, layers)
assert.equal(expected.lines.length, 10)
assert.equal(expected.vias.length, 4)
assert.ok(expected.lines.some(line => line.layer === 16))
assert.deepEqual(expected.sesLayerNamesById, { 16: 'Inner2', 1: 'TopLayer', 15: 'Inner1', 2: 'BottomLayer' })
assert.ok(expected.vias.every(via => via.diameterMil === 24 && via.holeDiameterMil === undefined), 'copper diameter is never used to invent a drill size')

const before = { documentUuid: 'a8-board', lines: [], vias: [] }
const plan = planSesImport(expected, before, 'append')
const delta = { ...expected, lines: plan.deltaLines, vias: plan.deltaVias }
const serialized = serializeSesSubset(sesText, delta)
const reparsed = parseAutoRouteSes(serialized)
const remapped = mapSesRoutes(reparsed, layers)
const lineKey = line => JSON.stringify({ net: line.net, layer: line.layer, widthMil: line.widthMil, endpoints: [line.a, line.b].map(point => [point.x, point.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) })
assert.equal(reparsed.wires.length, 10, 'each expanded line is serialized as one route wire')
assert.equal(reparsed.vias.length, 4)
assert.deepEqual(remapped.lines.map(lineKey).sort(), expected.lines.map(lineKey).sort(), 'all SES routes preserve network, layer, coordinates and width through serialization')
assert.deepEqual(remapped.vias, expected.vias, 'all vias preserve network, coordinates, padstack and copper diameter')
assert.deepEqual(reparsed.padstacks, model.padstacks, 'all per-layer padstack circles survive the round trip')
assert.equal(reparsed.padstacks[0].holeDiameterStatus, 'not-provided-by-ses')
assert.equal(verifySesImport(plan, { ...before, lines: remapped.lines, vias: remapped.vias }).verified, true)

const twoLayerSource = await readFile(resolve(root, 'test/fixtures/auto-route-real-v223.ses'), 'utf8')
const twoLayerModel = parseAutoRouteSes(twoLayerSource)
const twoLayerExpected = mapSesRoutes(twoLayerModel, [
	{ id: 1, name: 'Top Layer', type: 'SIGNAL' },
	{ id: 2, name: 'Bottom Layer', type: 'SIGNAL' },
	{ id: 15, name: 'Inner1', type: 'SIGNAL', layerStatus: 1 },
	{ id: 16, name: 'Inner2', type: 'SIGNAL', layerStatus: 1 },
])
assert.ok(twoLayerExpected.lines.every(line => line.layer === 1))
assert.deepEqual(twoLayerExpected.sesLayerNamesById, { 1: 'TopLayer', 2: 'BottomLayer' })

const rejectMapping = (source, candidateLayers, pattern) => {
	const candidate = parseAutoRouteSes(source)
	let failure
	try { mapSesRoutes(candidate, candidateLayers) }
	catch (error) { failure = error }
	assert.ok(failure instanceof Error, `expected SES mapping rejection matching ${pattern}`)
	assert.match(failure.message, pattern)
}
rejectMapping(sesText, layers.map(layer => layer.id === 16 ? { ...layer, layerStatus: 0 } : layer), /未确认启用/)
rejectMapping(sesText, layers.map(layer => layer.id === 16 ? { id: layer.id, name: layer.name, type: layer.type } : layer), /未确认启用/)
rejectMapping(sesText, layers.filter(layer => layer.id !== 16), /未能唯一映射/)
rejectMapping(sesText, [...layers, { id: 99, name: 'Top Layer', type: 'SIGNAL', layerStatus: 1 }], /未能唯一映射/)
rejectMapping(sesText.replace('(path TopLayer 10000', '(path "Top Layer" 10000'), layers, /多个 SES 层名映射到同一 PCB 层 ID/)
rejectMapping(sesText.replace('(path Inner2 10000', '(path UnknownInner 10000'), layers, /当前不支持/)

const unequalPadstack = sesText.replace('(circle Inner2 24000 0 0)', '(circle Inner2 25000 0 0)')
rejectMapping(unequalPadstack, layers, /各层圆直径不一致/)
const eccentricPadstack = sesText.replace('(circle Inner2 24000 0 0)', '(circle Inner2 24000 10 0)')
rejectMapping(eccentricPadstack, layers, /偏心形状/)
const missingOuterPadstack = sesText.replace(/\s+\(shape\s+\(circle BottomLayer 24000 0 0\)\s+\)/, '')
assert.equal(parseAutoRouteSes(missingOuterPadstack).padstacks[0].shapesByLayer.some(shape => shape.layerName === 'BottomLayer'), false)
rejectMapping(missingOuterPadstack, layers, /TopLayer\/BottomLayer 通孔形状/)
const unknownPadstackLayer = sesText.replace('(circle Inner2 24000 0 0)', '(circle WeirdCopper 24000 0 0)')
rejectMapping(unknownPadstackLayer, layers, /跨层形状|层名/)
const duplicateMappedPadstackLayer = sesText.replace('(circle Inner2 24000 0 0)', '(circle Inner1 24000 0 0)')
rejectMapping(duplicateMappedPadstackLayer, layers, /重复定义形状/)

const innerWithoutMap = { ...expected, sesLayerNamesById: undefined }
assert.throws(() => serializeSesSubset(sesText, innerWithoutMap), /不支持 PCB 层 ID 16/)
console.log('PASS actual four-layer SES maps, serializes and reparses inner-layer routes and padstack geometry with unknown drill preserved')
