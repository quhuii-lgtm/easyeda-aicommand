import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';

const bundled = await build({
	stdin: {
		contents: "export { buildRoutingPaths } from '../src/pcb/routingDetourPaths.ts';",
		resolveDir: import.meta.dirname,
		loader: 'ts',
	},
	bundle: true,
	write: false,
	platform: 'node',
	format: 'esm',
	target: 'node24',
});
const { buildRoutingPaths } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const point = (x, y) => ({ x, y });
const track = (id, a, b, layer = 1, opts = {}) => ({ id, net: 'SIG', layer, width: 4, a: point(...a), b: point(...b), ...opts });
const empty = { vias: [], pads: [], copper: [] };

{
	const paths = buildRoutingPaths({ ...empty, tracks: [
		track('a', [0, 0], [10, 0]), track('b', [10, 0], [10, 10]),
	], pads: [
		{ id: 'p1', net: 'SIG', x: 0, y: 0, layers: [1], radius: 1 },
		{ id: 'p2', net: 'SIG', x: 10, y: 10, layers: [1], radius: 1 },
	] });
	assert.equal(paths.paths.length, 1);
	const [route] = paths.paths;
	assert.deepEqual(route.trackIds, ['a', 'b']);
	assert.equal(route.lengthMil, 20);
	assert.equal(route.turnCount, 1);
	assert.equal(route.turns[0].angleDegrees, 90);
	assert.deepEqual(route.start.padIds, ['p1']);
	assert.deepEqual(route.end.padIds, ['p2']);
	assert.equal(route.improvability, 'review-required', `a measurable route is a review candidate, not an automatic edit: ${JSON.stringify(route)}`);
}

{
	const result = buildRoutingPaths({ ...empty, tracks: [
		track('trunk', [0, 0], [20, 0]), track('branch', [10, 0], [10, 10]),
	] });
	assert.equal(result.paths.length, 3, 'T contact splits into independent arms');
	assert.ok(result.paths.every(path => path.status === 'branch-split'));
	assert.ok(result.issues.some(issue => issue.code === 'branch-junction' && issue.position.x === 10));
}

{
	const result = buildRoutingPaths({
		tracks: [track('top', [0, 0], [10, 0], 1), track('bottom', [10, 0], [20, 0], 2)],
		vias: [{ id: 'v1', net: 'SIG', x: 10, y: 0, diameter: 8, hole: 4, layers: [1, 2] }],
		pads: [], copper: [],
	});
	assert.equal(result.paths.length, 1);
	assert.deepEqual(result.paths[0].viaIds, ['v1']);
	assert.equal(result.paths[0].viaCount, 1);
	assert.equal(result.paths[0].layerSwitchCount, 1);
	assert.deepEqual(result.paths[0].vertices.map(vertex => vertex.layer), [1, 1, 2, 2]);
}

{
	const result = buildRoutingPaths({
		tracks: [track('top', [0, 0], [10, 0], 1), track('bottom', [10, 0], [20, 0], 2)],
		vias: [], pads: [],
		copper: [{ id: 'plane', net: 'SIG', layer: 1, rings: [[point(-10, -10), point(30, -10), point(30, 10), point(-10, 10)]] }],
	});
	assert.equal(result.paths.length, 2, 'a copper region does not create a guessed route or cross-layer path');
	assert.ok(result.paths.every(path => path.layerSwitchCount === 0));
	assert.equal(result.coverage.copperUsedForConnectivity, false);
}

{
	const result = buildRoutingPaths({ ...empty, tracks: [track('out', [0, 0], [10, 0]), track('back', [10, 0], [0, 1])] });
	assert.equal(result.paths.length, 1);
	assert.equal(result.paths[0].reversals.length, 1, 'near-180-degree direction change is reported as a reversal');
	assert.equal(result.paths[0].reversals[0].position.x, 10);
}

{
	const result = buildRoutingPaths({
		tracks: [track('a', [0, 0], [10, 0], 1), track('b', [5, 1], [5, 10], 1)],
		vias: [{ id: 'unknown', net: 'SIG', x: 10, y: 0, diameter: 8, hole: 4, layers: null }], pads: [], copper: [],
	});
	assert.equal(result.paths.length, 2, 'width-only track proximity never invents a cross-centerline join');
	assert.ok(result.paths.every(path => path.status === 'ambiguous'));
	assert.ok(result.issues.some(issue => issue.code === 'non-centerline-track-contact'));
	assert.ok(result.coverage.unknownViaSpanIds.includes('unknown'));
	assert.equal(result.coverage.copperUsedForConnectivity, false);
}

{
	const result = buildRoutingPaths({ ...empty, tracks: [track('arc', [0, 0], [10, 0], 1, { arc: 90 })] });
	assert.equal(result.paths[0].status, 'unsupported-arc');
	assert.ok(result.paths[0].constraints.some(reason => reason.includes('圆弧')));
	assert.ok(result.coverage.unsupportedArcIds.includes('arc'));
	assert.ok(result.paths[0].lengthMil > 10, 'sweep angle yields arc-length estimate rather than chord-only length');
}

{
	const result = buildRoutingPaths({ ...empty, tracks: [track('dup1', [0, 0], [10, 0]), track('dup2', [5, 0], [15, 0])] });
	assert.ok(result.paths.every(path => path.status === 'ambiguous'));
	assert.ok(result.issues.some(issue => issue.code === 'collinear-centerline-overlap'));
}

console.log('PASS routing detour path tracing: endpoints, bends, T split, via layer switch, reversal, conservative ambiguity, unknown span, arcs');
