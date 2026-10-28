import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = buildSync({
	stdin: {
		contents: `import { schematicCommands } from '../src/commands/schematic.ts'; export { schematicCommands }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-connectpin-precision-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { schematicCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const connectPin = schematicCommands.find(item => item.name === 'schematic.connectPin')?.handler
assert.equal(typeof connectPin, 'function', 'real schematic.connectPin handler is registered')

async function exercisePin(pin, { existingNet = false } = {}) {
	let captured
	const pinState = {
		getState_PinNumber: () => pin.number,
		getState_PinName: () => pin.name,
		getState_X: () => pin.x,
		getState_Y: () => pin.y,
		getState_Rotation: () => pin.rotation,
		getState_PinLength: () => pin.length,
	}
	globalThis.eda = {
		sch_PrimitiveComponent: {
			getAllPinsByPrimitiveId: async () => [pinState],
		},
		sch_PrimitiveWire: {
			getAll: async () => existingNet ? [{ getState_Net: () => 'VCC' }] : [],
			create: async (line, net) => {
				captured = { line, net }
				return { getState_PrimitiveId: () => `wire-${pin.number}` }
			},
		},
		sch_PrimitiveAttribute: { getAll: async () => [] },
	}
	const result = await connectPin({ primitiveId: 'component-1', pin: pin.number, net: 'VCC' })
	return { result, captured }
}

const cases = [
	{ name: 'origin rotation 0', number: 'O0', x: 0, y: 0, rotation: 0, length: 10, expectedLine: [40, 0, 0, 0] },
	{ name: 'origin rotation 90', number: 'O90', x: 0, y: 0, rotation: 90, length: 10, expectedLine: [0, 40, 0, 0] },
	{ name: 'origin rotation 180', number: 'O180', x: 0, y: 0, rotation: 180, length: 10, expectedLine: [-40, 0, 0, 0] },
	{ name: 'origin rotation 270', number: 'O270', x: 0, y: 0, rotation: 270, length: 10, expectedLine: [0, -40, 0, 0] },
	{ name: 'integer rotation 0', number: 'I0', x: 100, y: 200, rotation: 0, length: 10, expectedLine: [140, 200, 100, 200] },
	{ name: 'integer rotation 90', number: 'I90', x: 100, y: 200, rotation: 90, length: 10, expectedLine: [100, 240, 100, 200] },
	{ name: 'integer rotation 180', number: 'I180', x: 100, y: 200, rotation: 180, length: 10, expectedLine: [60, 200, 100, 200] },
	{ name: 'integer rotation 270', number: 'I270', x: 100, y: 200, rotation: 270, length: 10, expectedLine: [100, 160, 100, 200] },
	{ name: 'half-grid rotation 0', number: 'H0', x: 100.5, y: 200.5, rotation: 0, length: 10, expectedLine: [140.5, 200.5, 100.5, 200.5] },
	{ name: 'half-grid rotation 90', number: 'H90', x: 100.5, y: 200.5, rotation: 90, length: 10, expectedLine: [100.5, 240.5, 100.5, 200.5] },
	{ name: 'half-grid rotation 180', number: 'H180', x: 100.5, y: 200.5, rotation: 180, length: 10, expectedLine: [60.5, 200.5, 100.5, 200.5] },
	{ name: 'half-grid rotation 270', number: 'H270', x: 100.5, y: 200.5, rotation: 270, length: 10, expectedLine: [100.5, 160.5, 100.5, 200.5] },
	{ name: 'normalized rotation -90', number: 'N-90', x: 0, y: 0, rotation: -90, length: 10, expectedLine: [0, -40, 0, 0] },
	{ name: 'normalized rotation 450', number: 'N450', x: 0, y: 0, rotation: 450, length: 10, expectedLine: [0, 40, 0, 0] },
	{ name: 'non-orthogonal rotation remains trigonometric', number: 'N30', x: 1.25, y: 2.75, rotation: 30, length: 10, expectedLine: [1.25 + Math.cos(Math.PI / 6) * 40, 2.75 + Math.sin(Math.PI / 6) * 40, 1.25, 2.75] },
]

for (const pin of cases) {
	const { result, captured } = await exercisePin(pin)
	assert.deepEqual(captured.line, pin.expectedLine, `${pin.name}: wire.create receives the exact expected endpoints`)
	assert.equal(captured.net, 'VCC', `${pin.name}: a new network is passed to wire.create`)
	assert.deepEqual(result.from, { x: pin.expectedLine[0], y: pin.expectedLine[1] }, `${pin.name}: returned from endpoint matches creation`)
	assert.deepEqual(result.to, { x: pin.x, y: pin.y }, `${pin.name}: returned to endpoint preserves the exact pin origin`)
	assert.equal(result.net, 'VCC')
	assert.equal(result.named, true)
}

{
	const pin = { name: 'existing named net', number: 'R1', x: 300.5, y: 400.5, rotation: 90, length: 10, expectedLine: [300.5, 440.5, 300.5, 400.5] }
	const { result, captured } = await exercisePin(pin, { existingNet: true })
	assert.deepEqual(captured.line, pin.expectedLine, 'existing-net path retains exact endpoints')
	assert.equal(captured.net, undefined, 'existing named network is not re-applied to the wire')
	assert.equal(result.net, 'VCC')
	assert.equal(result.named, false)
}

console.log('schematic-connectpin-precision-regression: PASS')
