import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = await readFile(resolve(root, 'src', 'pcb', 'silkscreenGerber.ts'), 'utf8')
// Frozen unpruned oracle copied from before/v104/src/pcb/silkscreenGerber.ts (SHA-256 c956cd64ab9b8d7b952e529f4da69324c7477c61e0a5f41ab58e6c873755452b).
const oldImplementation = `
function unprunedPolygonsDistance(a: MultiPolygon, b: MultiPolygon, checkBudget?: () => void): number {
	if (!a.length || !b.length)
		return Number.POSITIVE_INFINITY;
	const intersection = intersectPolygons(a, b);
	if (intersection.length > 0)
		return 0;
	const aSegments = a.flatMap(poly => poly.flatMap(ringSegments));
	const bSegments = b.flatMap(poly => poly.flatMap(ringSegments));
	let best = Number.POSITIVE_INFINITY;
	let segmentCount = 0;
	for (const [a1, a2] of aSegments) {
		for (const [b1, b2] of bSegments) {
			if ((segmentCount++ & 1023) === 0)
				checkBudget?.();
			best = Math.min(best, segmentDistance(a1, a2, b1, b2));
			if (best <= 1e-9)
				return 0;
		}
	}
	return best;
}
`
const bundled = await build({
	stdin: {
		contents: `${source}\n${oldImplementation}\nexport { polygonsDistance, intersectPolygons, ringSegments, segmentDistance, unprunedPolygonsDistance };`,
		loader: 'ts',
		resolveDir: resolve(root, 'src', 'pcb'),
		sourcefile: 'silkscreenGerber-distance-pruning-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { polygonsDistance, unprunedPolygonsDistance } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

function rectangle(minX, minY, maxX, maxY) {
	return [[[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]]
}

function denseRectangle(minX, minY, maxX, maxY, divisions = 20) {
	const ring = []
	const edges = [
		[[minX, minY], [maxX, minY]],
		[[maxX, minY], [maxX, maxY]],
		[[maxX, maxY], [minX, maxY]],
		[[minX, maxY], [minX, minY]],
	]
	for (const [[x1, y1], [x2, y2]] of edges) {
		for (let index = 0; index < divisions; index++) {
			const t = index / divisions
			ring.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t])
		}
	}
	ring.push([...ring[0]])
	return [[ring]]
}

function compareBoth(a, b, expected, label) {
	const aBefore = structuredClone(a)
	const bBefore = structuredClone(b)
	const oldResult = unprunedPolygonsDistance(a, b)
	const newResult = polygonsDistance(a, b)
	assert.equal(newResult, oldResult, `${label}: pruned result matches the legacy unpruned implementation`)
	if (expected !== undefined)
		assert.equal(newResult, expected, `${label}: known geometric result`)
	assert.deepEqual(a, aBefore, `${label}: first input is unchanged`)
	assert.deepEqual(b, bBefore, `${label}: second input is unchanged`)
	return newResult
}

const knownCases = [
	{ a: denseRectangle(0, 0, 10, 10), b: denseRectangle(13, 0, 23, 10), expected: 3, label: 'parallel separation' },
	{ a: denseRectangle(0, 0, 10, 10), b: denseRectangle(13, 14, 23, 24), expected: 5, label: 'diagonal separation' },
	{ a: denseRectangle(-1000.25, 2000.5, -990.25, 2010.5), b: denseRectangle(-987.25, 2014.5, -977.25, 2024.5), expected: 5, label: 'translated coordinates' },
]

for (const { a, b, expected, label } of knownCases) {
	const aSegments = a.flatMap(poly => poly.flatMap(ring => ring.slice(1).map((end, index) => [ring[index], end])))
	const bSegments = b.flatMap(poly => poly.flatMap(ring => ring.slice(1).map((end, index) => [ring[index], end])))
	let actualCalls = 0
	let legacyCalls = 0
	const actual = polygonsDistance(a, b, () => { actualCalls++ })
	const legacy = unprunedPolygonsDistance(a, b, () => { legacyCalls++ })
	assert.equal(actual, expected, `${label}: pruning preserves the known exact distance`)
	assert.equal(actual, legacy, `${label}: pruning matches the legacy unpruned result`)
	assert.equal(actualCalls, Math.ceil(aSegments.length * bSegments.length / 1024), `${label}: budget sees every pair at the established cadence, including pruned pairs`)
	assert.equal(legacyCalls, actualCalls, `${label}: budget cadence matches the legacy implementation`)
}

compareBoth(rectangle(0, 0, 10, 10), rectangle(8, 4, 12, 6), 0, 'positive-area overlap')
compareBoth(rectangle(0, 0, 10, 10), rectangle(10, 2, 20, 8), 0, 'edge tangency')
compareBoth(rectangle(0, 0, 10, 10), rectangle(2, 2, 4, 4), 0, 'containment')
const holed = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]]
compareBoth(holed, rectangle(4.5, 4.5, 5.5, 5.5), 0.5, 'polygon hole distance')
assert.equal(compareBoth([], rectangle(0, 0, 1, 1), Number.POSITIVE_INFINITY, 'empty first multipolygon'), Number.POSITIVE_INFINITY)
assert.equal(compareBoth(rectangle(0, 0, 1, 1), [], Number.POSITIVE_INFINITY, 'empty second multipolygon'), Number.POSITIVE_INFINITY)
compareBoth(rectangle(0, 0, 1, 1), rectangle(1 + 0.5e-9, 0, 2, 1), 0, 'distance below 1e-9 cutoff')
const aboveCutoff = compareBoth(rectangle(0, 0, 1, 1), rectangle(1 + 2e-9, 0, 2, 1), undefined, 'distance above 1e-9 cutoff')
assert.ok(aboveCutoff > 1e-9 && Math.abs(aboveCutoff - 2e-9) < 2e-10)
compareBoth(rectangle(1e12, -1e12, 1e12 + 10, -1e12 + 10), rectangle(1e12 + 13, -1e12 + 14, 1e12 + 23, -1e12 + 24), 5, 'large coordinate scale')
const degenerate = [[[[0, 0], [1, 0], [1, 0], [0, 0]]]]
compareBoth(degenerate, rectangle(0, 2, 1, 3), undefined, 'degenerate and repeated vertices')

const budgetA = denseRectangle(0, 0, 10, 10, 24)
const budgetB = denseRectangle(13, 0, 23, 10, 24)
const budgetSentinel = new Error('budget sentinel')
for (const implementation of [polygonsDistance, unprunedPolygonsDistance]) {
	let callbacks = 0
	const beforeA = structuredClone(budgetA)
	const beforeB = structuredClone(budgetB)
	assert.throws(() => implementation(budgetA, budgetB, () => {
		callbacks++
		if (callbacks === 2)
			throw budgetSentinel
	}), error => error === budgetSentinel, 'budget exception propagates unchanged')
	assert.equal(callbacks, 2, 'budget callback runs after substantial pair enumeration and pruning')
	assert.deepEqual(budgetA, beforeA, 'budget exception leaves first input unchanged')
	assert.deepEqual(budgetB, beforeB, 'budget exception leaves second input unchanged')
}

console.log('silkscreen distance pruning regression passed')
