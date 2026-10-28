import assert from 'node:assert/strict';
import { planPadBranches } from '../src/pcb/padBranchGeometry.ts';

function pad(id, net, center, shape = 'circle', extra = {}) {
	return shape === 'rect'
		? { id, net, layers: [1], kind: 'rect', center, width: 10, height: 10, rotation: 0, ...extra }
		: { id, net, layers: [1], kind: 'circle', center, radius: 5, ...extra };
}
function request(positive, negative, changes = {}) {
	return {
		pair: { positiveNet: 'P', negativeNet: 'N' },
		layer: 1,
		width: 2,
		clearanceMil: 2,
		positive: { joinPoint: [100, 50], branches: positive },
		negative: { joinPoint: [100, 0], branches: negative },
		...changes,
	};
}
const basicPads = [pad('p1', 'P', [0, 40]), pad('p2', 'P', [0, 60]), pad('n1', 'N', [0, 0]), pad('n2', 'N', [0, 10])];
const pBranches = [{ padId: 'p1' }, { padId: 'p2' }];
const nBranches = [{ padId: 'n1' }, { padId: 'n2' }];
const plan = (req, pads = basicPads, lines = [], contacts = [], check) => planPadBranches(req, pads, lines, contacts, check);

const y = plan(request(pBranches, nBranches), basicPads, [], basicPads);
assert.equal(y.positive.branches.length, 2);
assert.deepEqual(y.positive.branches[0].path, [[0, 40], [100, 50]]);
assert.equal(y.positive.branches[0].length, Math.hypot(100, 10));
assert.equal(y.positive.uniqueSegments.length, 2);

const sharedSuffix = plan(request(
	[{ padId: 'p1', waypoints: [[30, 40], [60, 50]] }, { padId: 'p2', waypoints: [[60, 70], [60, 50]] }],
	nBranches,
));
assert.equal(sharedSuffix.positive.branches.length, 2);

const differentSegmentation = plan(request(
	[{ padId: 'p1', waypoints: [[60, 50]] }, { padId: 'p2', waypoints: [[80, 50]] }],
	nBranches,
));
assert.equal(differentSegmentation.positive.uniqueSegments.length, 3, 'same-direction collinear waypoints normalize before write deduplication');

const thirdPad = pad('p3', 'P', [60, 50]);
const padAsSuffixStart = plan(request(
	[{ padId: 'p1', waypoints: [[60, 50]] }, { padId: 'p3' }],
	nBranches,
), [...basicPads, thirdPad], [], [thirdPad]);
assert.equal(padAsSuffixStart.positive.branches.length, 2);

const pth = pad('pth', 'P', [20, 50], 'circle', { radius: 8, holeRadius: 3 });
assert.equal(plan(request([{ padId: 'pth', waypoints: [[24, 50], [50, 50]] }], nBranches), [...basicPads, pth]).positive.branches.length, 1);
assert.throws(() => plan(request([{ padId: 'pth' }], nBranches, { positive: { joinPoint: [21.5, 50], branches: [{ padId: 'pth' }] } }), [...basicPads, pth]), /未穿过焊环/);
const delayedPth = pad('pth-delay', 'P', [650, 900], 'circle', { radius: 10, holeRadius: 6 });
const delayedRing = plan(request([], nBranches, {
	positive: { joinPoint: [750, 887], branches: [{ padId: 'pth-delay', waypoints: [[650, 902], [700, 887]] }] },
}), [...basicPads, delayedPth], [], []);
assert.equal(delayedRing.positive.branches[0].path[1][0], 650, 'THT connection is checked across a continuous multi-segment prefix');

const rotated = pad('p1', 'P', [0, 40], 'rect', { rotation: 45 });
assert.equal(plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches), [rotated, ...basicPads.slice(1)]).positive.branches.length, 2);

assert.throws(() => plan(request([{ padId: 'missing' }, { padId: 'p2' }], nBranches)), /找不到目标PAD/);
assert.throws(() => plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches, { clearanceMil: -1 })), /clearanceMil/);
assert.throws(() => plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches, { width: 0 })), /width/);
assert.equal(plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches, { width: 0.5 })).width, 0.5);
assert.throws(() => plan(request([{ padId: 'p1', waypoints: [[30, 40], [70, 40]] }, { padId: 'p2', waypoints: [[70, 60], [30, 60]] }], nBranches)), /交叉|共同后缀/);
assert.throws(() => plan(request([{ padId: 'p1', waypoints: [[30, 40], [70, 40], [30, 40]] }, { padId: 'p2' }], nBranches)), /回绕|交叉/);
assert.throws(() => plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches), basicPads.map(p => p.id === 'p1' ? { ...p, net: 'OTHER' } : p)), /网络为/);
assert.throws(() => plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches), basicPads, [{ id: 'short', net: 'N', layer: 1, width: 2, a: [50, 40], b: [50, 45] }]), /异网LINE/);
assert.throws(() => plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches), basicPads, [], [{ id: 'unknown', net: 'N', layers: [1], kind: 'unknown', bounds: { xMin: 48, xMax: 52, yMin: 44, yMax: 46 }, reason: 'fixture' }]), /无法确认/);
assert.throws(() => plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches, { clearanceMil: 0 }), basicPads, [], [{ id: 'touching', net: 'N', layers: [1], kind: 'circle', center: [50, 45], radius: 1 }]), /间距不足 0 mil/);
assert.equal(plan(request([{ padId: 'p1' }, { padId: 'p2' }], nBranches), basicPads, [], [{ id: 'known-same-net', net: 'P', layers: [1], kind: 'circle', center: [50, 45], radius: 4 }]).positive.additionalSameNetContacts.length, 1);
assert.throws(() => plan(request([{ padId: 'p1' }], [{ padId: 'n1' }], {
	negative: { joinPoint: [100, 49], branches: [{ padId: 'n1' }] },
}), basicPads), /正侧支路.*负侧支路.*间距不足/);
assert.throws(() => plan(request([{ padId: 'p1' }], [{ padId: 'n1' }], {
	clearanceMil: 0,
	positive: { joinPoint: [100, 50], branches: [{ padId: 'p1' }] },
	negative: { joinPoint: [100, 50], branches: [{ padId: 'n1' }] },
}), basicPads), /正侧支路.*负侧支路.*间距不足/);
const trunkLine = { id: 'trunk', net: 'P', layer: 1, width: 2, a: [100, 50], b: [200, 50] };
assert.equal(plan(request([{ padId: 'p1' }], nBranches, {
	positive: { joinPoint: [100, 50], branches: [{ padId: 'p1' }], trunk: { primitiveId: 'trunk', endpoint: 'start' } },
}), basicPads, [trunkLine]).positive.trunk.primitiveId, 'trunk');
assert.throws(() => plan(request([{ padId: 'p1' }], nBranches, {
	positive: { joinPoint: [100, 50], branches: [{ padId: 'p1' }], trunk: { primitiveId: 'trunk', endpoint: 'end' } },
}), basicPads, [trunkLine]), /端点不在汇合点/);

let checks = 0;
plan(request(pBranches, nBranches), basicPads, [], [], () => checks++);
assert.ok(checks > 0);

// Regression: overlapping trace copper before separation must not be accepted as a tree.
const nearTouchPads = [
	pad('pa', 'P', [0, 0], 'circle', { radius: 0.5 }),
	pad('pb', 'P', [0, 1.5], 'circle', { radius: 0.5 }),
	pad('na', 'N', [0, -100]),
];
assert.throws(() => plan(request([{ padId: 'pa', waypoints: [[20, 0], [40, 20]] }, { padId: 'pb', waypoints: [[20, 1.5], [40, 40], [60, 20]] }], [{ padId: 'na' }], {
	positive: { joinPoint: [100, 20], branches: [{ padId: 'pa', waypoints: [[20, 0], [40, 20]] }, { padId: 'pb', waypoints: [[20, 1.5], [40, 40], [60, 20]] }] },
	negative: { joinPoint: [100, -100], branches: [{ padId: 'na' }] },
}), nearTouchPads), /接触|共同后缀|铜/);

// Regression: a branch may touch its own start PAD only in one continuous prefix.
const reentryPad = pad('reentry', 'P', [0, 0], 'circle', { radius: 5 });
assert.throws(() => plan(request([{ padId: 'reentry', waypoints: [[10, 0], [10, 10], [0, 3]] }], [{ padId: 'na' }], {
	positive: { joinPoint: [20, 20], branches: [{ padId: 'reentry', waypoints: [[10, 0], [10, 10], [0, 3]] }] },
	negative: { joinPoint: [100, -100], branches: [{ padId: 'na' }] },
}), [reentryPad, ...nearTouchPads.filter(p => p.id === 'na')], [], [reentryPad]), /自身|回绕|重新接触|PAD/);

// Regression: same-net unknown copper within route bounds is not safe to wave through.
const relevantUnknown = { id: 'unknown-near', net: 'P', layers: [1], kind: 'unknown', bounds: { xMin: 30, xMax: 40, yMin: -5, yMax: 5 }, reason: 'fixture' };
const unknownPads = [pad('up', 'P', [0, 0]), pad('un', 'N', [0, -100])];
assert.throws(() => plan(request([{ padId: 'up' }], [{ padId: 'un' }], {
	positive: { joinPoint: [100, 0], branches: [{ padId: 'up' }] },
	negative: { joinPoint: [100, -100], branches: [{ padId: 'un' }] },
}), unknownPads, [], [relevantUnknown]), /无法确认/);
const remoteUnknown = { ...relevantUnknown, id: 'unknown-far', bounds: { xMin: 500, xMax: 510, yMin: 500, yMax: 510 } };
assert.equal(plan(request([{ padId: 'up' }], [{ padId: 'un' }], {
	positive: { joinPoint: [100, 0], branches: [{ padId: 'up' }] },
	negative: { joinPoint: [100, -100], branches: [{ padId: 'un' }] },
}), unknownPads, [], [remoteUnknown]).positive.branches.length, 1);

// Regression: cancellation is checked while normalizing a large input, before consuming it all.
const longWaypointCount = 3000;
let waypointReads = 0;
let cancellationChecks = 0;
const longWaypoints = new Proxy(Array.from({ length: longWaypointCount }, (_, i) => [i + 1, i % 2 ? 0.5 : -0.5]), {
	get(target, key, receiver) {
		if (typeof key === 'string' && /^\d+$/.test(key))
			waypointReads++;
		return Reflect.get(target, key, receiver);
	},
});
assert.throws(() => plan(request([{ padId: 'long', waypoints: longWaypoints }], [{ padId: 'na' }], {
	positive: { joinPoint: [longWaypointCount + 1, 0], branches: [{ padId: 'long', waypoints: longWaypoints }] },
	negative: { joinPoint: [100, -100], branches: [{ padId: 'na' }] },
}), [pad('long', 'P', [0, 0]), ...nearTouchPads.filter(p => p.id === 'na')], [], [], () => {
	cancellationChecks++;
	if (cancellationChecks === 3)
		throw new Error('cancelled-for-test');
}), /cancelled-for-test/);
assert.equal(cancellationChecks, 3);
assert.ok(waypointReads < longWaypointCount, `cancellation should stop before reading all waypoints; read ${waypointReads}`);
console.log('pad-branch-geometry-regression: all assertions passed');
