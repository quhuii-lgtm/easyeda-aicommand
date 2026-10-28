import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import process from 'node:process';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier))
			return nextResolve(`${specifier}.ts`, context);
		return nextResolve(specifier, context);
	},
});

async function main() {
	const { identifyOldBypassFragments, oldBypassFragmentSdkMatches } = await import('../src/pcb/oldBypassFragments.ts');
	const target = { header: { type: 'LINE', id: 'old' }, data: { partitionId: '', groupId: 0, netName: 'N', layerId: 1, startX: 0, startY: 0, endX: 200, endY: 0, width: 6, locked: false, zIndex: -1 } };
	const fragment = (id, startX, endX, extra = {}) => ({ header: { type: 'LINE', id }, data: { ...target.data, startX, endX, ...extra } });
	const beforeRecords = new Map([['LINE\0old', target]]);
	const writer = { header: { type: 'ARC', id: 'writer' }, data: {} };
	const planned = [{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'line', a: [100, 0], b: [200, 0] }];
	const valid = new Map([['LINE\0frag-a', fragment('frag-a', 0, 100)], ['LINE\0frag-b', fragment('frag-b', 100, 200)], ['ARC\0writer', writer]]);

	assert.deepEqual(identifyOldBypassFragments({ targetId: 'old', target, beforeRecords, afterRecords: valid, writerKeys: new Set(['ARC\0writer']), planned }).fragmentIds, ['frag-a', 'frag-b']);
	assert.deepEqual(identifyOldBypassFragments({ targetId: 'old', target, beforeRecords, afterRecords: new Map([['LINE\0old', target], ['ARC\0writer', writer]]), writerKeys: new Set(['ARC\0writer']), planned }), { split: false, fragmentIds: [], expectedEndpoints: [] });

	const invalidCases = [
		new Map([['LINE\0frag-a', fragment('frag-a', 0, 100)], ['ARC\0writer', writer]]),
		new Map([...valid, ['LINE\0extra', fragment('extra', 0, 200)]]),
		new Map([['LINE\0frag-a', fragment('frag-a', 0, 99)], ['LINE\0frag-b', fragment('frag-b', 100, 200)], ['ARC\0writer', writer]]),
		new Map([['LINE\0frag-a', fragment('frag-a', 0, 100, { zIndex: 8 })], ['LINE\0frag-b', fragment('frag-b', 100, 200)], ['ARC\0writer', writer]]),
		new Map([['LINE\0frag-a', fragment('frag-a', 0, 100)], ['LINE\0frag-b', fragment('frag-b', 101, 200)], ['ARC\0writer', writer]]),
		new Map([['LINE\0frag-a', fragment('frag-a', 0, 100.0009)], ['LINE\0frag-b', fragment('frag-b', 99.9991, 200)], ['ARC\0writer', writer]]),
		new Map([['LINE\0frag-a', fragment('frag-a', 0, 99.9991)], ['LINE\0frag-b', fragment('frag-b', 100.0009, 200)], ['ARC\0writer', writer]]),
		new Map([...valid, ['LINE\0writer', fragment('writer', 0, 100)]]),
		new Map([['LINE\0frag-a', { ...fragment('frag-a', 0, 100), header: { type: 'ARC', id: 'wrong' } }], ['LINE\0frag-b', fragment('frag-b', 100, 200)], ['ARC\0writer', writer]]),
		new Map([['LINE\0frag-a', { ...fragment('frag-a', 0, 100), data: { ...fragment('frag-a', 0, 100).data, startY: 0.00005 } }], ['LINE\0frag-b', fragment('frag-b', 100, 200)], ['ARC\0writer', writer]]),
	];
	for (const afterRecords of invalidCases)
		assert.throws(() => identifyOldBypassFragments({ targetId: 'old', target, beforeRecords, afterRecords, writerKeys: new Set(['ARC\0writer']), planned }));

	const longTarget = { header: { type: 'LINE', id: 'long' }, data: { ...target.data, endX: 10_000 } };
	const longBefore = new Map([['LINE\0long', longTarget]]);
	const longAfter = new Map([['LINE\0left', { header: { type: 'LINE', id: 'left' }, data: { ...longTarget.data, endX: 500 } }], ['LINE\0right', { header: { type: 'LINE', id: 'right' }, data: { ...longTarget.data, startX: 500 } }], ['ARC\0writer', writer]]);
	assert.deepEqual(identifyOldBypassFragments({ targetId: 'long', target: longTarget, beforeRecords: longBefore, afterRecords: longAfter, writerKeys: new Set(['ARC\0writer']), planned: [{ type: 'line', a: [0, 0], b: [500, 0] }, { type: 'line', a: [500, 0], b: [10_000, 0] }] }).fragmentIds, ['left', 'right']);
	const diagonalTarget = { header: { type: 'LINE', id: 'diagonal' }, data: { ...target.data, endX: 1000, endY: 1000 } };
	const diagonalBefore = new Map([['LINE\0diagonal', diagonalTarget]]);
	const diagonalAfter = new Map([
		['LINE\0diagonal-left', { header: { type: 'LINE', id: 'diagonal-left' }, data: { ...diagonalTarget.data, endX: 500, endY: 500.00005 } }],
		['LINE\0diagonal-right', { header: { type: 'LINE', id: 'diagonal-right' }, data: { ...diagonalTarget.data, startX: 500, startY: 500.00005 } }],
		['ARC\0writer', writer],
	]);
	assert.deepEqual(identifyOldBypassFragments({ targetId: 'diagonal', target: diagonalTarget, beforeRecords: diagonalBefore, afterRecords: diagonalAfter, writerKeys: new Set(['ARC\0writer']), planned: [{ type: 'line', a: [0, 0], b: [500, 500] }, { type: 'line', a: [500, 500], b: [1000, 1000] }] }).fragmentIds, ['diagonal-left', 'diagonal-right']);
	const q4Source = { id: 'q4', net: 'N', layer: 1, width: 6, start: [100, 209.0089], end: [200, 209.0089] };
	assert.equal(oldBypassFragmentSdkMatches(q4Source, { id: 'q4', type: 'Line', net: 'N', layer: 1, width: 6, start: [100, 209.008851], end: [200, 209.008851] }), true, 'fresh SDK precision may differ from four-decimal source by less than 0.001 mil');
	assert.equal(oldBypassFragmentSdkMatches(q4Source, { id: 'q4', type: 'Line', net: 'N', layer: 1, width: 6, start: [100, 209.1089], end: [200, 209.1089] }), false, 'LINE does not accept a 0.1 mil projection');

	console.log('old-bypass-fragments-regression: all assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
