import assert from 'node:assert/strict';

import { curveBounds, curveFromEndpoints, curveLength, planArcLengthTune, sampleCurves } from '../src/pcb/arcTuneGeometry.ts';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const base = {
	path: [[0, 0], [200, 0]],
	tuneSegmentIndex: 0,
	targetLength: 220,
	region: { xMin: -20, yMin: -100, xMax: 220, yMax: 100 },
	side: 'auto',
	width: 6,
	minSelfGap: 0,
	lengthTolerance: 0.001,
	bendRadius: 7,
};
const plan = (changes = {}, checkBudget) => planArcLengthTune({ ...base, ...changes }, checkBudget);

const arc = curveFromEndpoints([0, 0], [7, 7], 90);
close(arc.radius, 7);
close(curveLength(arc), 7 * Math.PI / 2);
const bounds = curveBounds(arc);
close(bounds.xMin, 0);
close(bounds.yMin, 0);
close(bounds.xMax, 7);
close(bounds.yMax, 7);
const samples = sampleCurves([arc], 0.001);
assert.ok(samples.points.length > 2);
assert.equal(samples.edgePrimitiveIndices.length, samples.points.length - 1);
assert.equal(samples.maxSagittaMil, 0.001);
assert.deepEqual(samples.points[0], arc.a);
assert.deepEqual(samples.points.at(-1), arc.b);

const one = plan();
assert.equal(one.changed, true);
assert.equal(one.selectedSide, 'left');
assert.equal(one.unitCount, 1);
assert.equal(one.localPrimitives.filter(curve => curve.type === 'arc').length, 4);
close(one.originalSelectedLength, 200);
close(one.plannedSelectedLength, 220);
close(one.plannedAddedLength, 20);
close(one.localPrimitives.reduce((sum, curve) => sum + curveLength(curve), 0), 220);
assert.deepEqual(one.localPrimitives[0].a, base.path[0]);
assert.deepEqual(one.localPrimitives.at(-1).b, base.path[1]);
for (let i = 1; i < one.localPrimitives.length; i++)
	assert.deepEqual(one.localPrimitives[i - 1].b, one.localPrimitives[i].a);
assert.equal(one.samples.edgePrimitiveIndices.length, one.samples.points.length - 1);
assert.ok(one.samples.maxSagittaMil <= 0.0001);
assert.deepEqual(one.samples.points[0], base.path[0]);
assert.deepEqual(one.samples.points.at(-1), base.path[1]);

const ratedGap = plan({ minSelfGap: 8 });
assert.equal(ratedGap.changed, true);
close(ratedGap.selfGapLowerBoundMil, 8);

const two = plan({ targetLength: 245, region: { xMin: -20, yMin: -20, xMax: 220, yMax: 25 } });
assert.equal(two.unitCount, 2);
close(two.plannedSelectedLength, 245);
assert.equal(two.localPrimitives.filter(curve => curve.type === 'arc').length, 8);

const roundedZeroRiseTarget = 200 + (2 * Math.PI - 4) * 7;
assert.ok((roundedZeroRiseTarget - 200) / ((2 * Math.PI - 4) * 7) < 1);
const zeroRise = plan({ targetLength: roundedZeroRiseTarget });
assert.equal(zeroRise.changed, true);
assert.equal(zeroRise.unitCount, 1);
assert.ok(zeroRise.localPrimitives.every(curve => curve.type === 'arc' || curve.a[1] === curve.b[1]));
close(zeroRise.plannedSelectedLength, roundedZeroRiseTarget, 1e-10);

const withTails = plan({
	path: [[0, 0], [30, 0], [230, 0], [260, 0]],
	tuneSegmentIndex: 1,
	targetLength: 280,
	region: { xMin: -20, yMin: -100, xMax: 280, yMax: 100 },
});
assert.deepEqual(withTails.samples.points[0], [30, 0]);
assert.deepEqual(withTails.samples.points.at(-1), [230, 0]);
assert.equal(withTails.replacement.length, withTails.localPrimitives.length + 2);
const unchangedWithTails = plan({
	path: [[0, 0], [30, 0], [230, 0], [260, 0]],
	tuneSegmentIndex: 1,
	targetLength: 260,
	region: { xMin: -20, yMin: -100, xMax: 280, yMax: 100 },
});
assert.equal(unchangedWithTails.changed, false);
assert.deepEqual(unchangedWithTails.samples.points[0], [30, 0]);
assert.deepEqual(unchangedWithTails.samples.points.at(-1), [230, 0]);

const right = plan({ side: 'right' });
assert.equal(right.selectedSide, 'right');
close(right.localPrimitives[0].a[1], 0);
assert.ok(right.localPrimitives.some(curve => curve.type === 'arc' && curve.center[1] < 0));
const rotated = plan({
	path: [[30, 40], [30, 240]],
	region: { xMin: -100, yMin: 20, xMax: 160, yMax: 260 },
});
assert.equal(rotated.selectedSide, 'left');
close(rotated.localPrimitives[0].a[0], 30);
close(rotated.localPrimitives.at(-1).b[1], 240);
assert.deepEqual(rotated.localPrimitives[0].a, [30, 40]);
assert.deepEqual(rotated.localPrimitives.at(-1).b, [30, 240]);
for (let i = 1; i < rotated.localPrimitives.length; i++)
	assert.deepEqual(rotated.localPrimitives[i - 1].b, rotated.localPrimitives[i].a);
const rotatedMultiUnit = plan({
	path: [[30, 40], [30, 240]],
	targetLength: 245,
	region: { xMin: 9, yMin: 20, xMax: 51, yMax: 260 },
});
assert.equal(rotatedMultiUnit.unitCount, 2);
assert.deepEqual(rotatedMultiUnit.localPrimitives[0].a, [30, 40]);
assert.deepEqual(rotatedMultiUnit.localPrimitives.at(-1).b, [30, 240]);
for (let i = 1; i < rotatedMultiUnit.localPrimitives.length; i++)
	assert.deepEqual(rotatedMultiUnit.localPrimitives[i - 1].b, rotatedMultiUnit.localPrimitives[i].a);

const unchanged = plan({ targetLength: 200 });
assert.equal(unchanged.changed, false);
assert.equal(unchanged.selectedSide, 'none');
assert.throws(() => plan({ targetLength: 199 }), /只能补长/);
assert.throws(() => plan({ bendRadius: 0 }), /必须为正/);
assert.throws(() => plan({ path: [[0, 0], [0, 0]], targetLength: 20 }), /长度为零/);
assert.throws(() => plan({ region: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 } }), /没有可行/);
let budgetCalls = 0;
assert.throws(() => plan({}, () => {
	if (++budgetCalls > 1)
		throw new Error('budget');
}), /budget/);

console.log('arc-tune-geometry-regression: passed');
