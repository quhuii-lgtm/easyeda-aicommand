import assert from 'node:assert/strict';
import process from 'node:process';

async function main() {
	const { planLengthTune } = await import(new URL('../src/pcb/lengthTuneGeometry.ts', import.meta.url));

	const region = { xMin: -10, yMin: -100, xMax: 210, yMax: 100 };
	function tune(changes = {}, checkBudget) {
		return planLengthTune({
			path: [[0, 0], [200, 0]],
			tuneSegmentIndex: 0,
			targetLength: 220,
			region,
			side: 'auto',
			width: 6,
			minSelfGap: 0,
			lengthTolerance: 0.001,
			...changes,
		}, checkBudget);
	}
	const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

	const singleWave = tune();
	const expectedAmplitude = Math.sqrt(2100);
	assert.equal(singleWave.changed, true);
	assert.equal(singleWave.selectedSide, 'left', 'auto chooses left deterministically when both sides fit');
	assert.equal(singleWave.selectedWaveSegments, 2);
	assert.equal(singleWave.normalizedWaveSegments, 2);
	assert.deepEqual(singleWave.localPath[0], [0, 0]);
	assert.deepEqual(singleWave.localPath[2], [200, 0]);
	close(singleWave.localPath[1][0], 100);
	close(singleWave.localPath[1][1], expectedAmplitude);
	close(Math.hypot(100, expectedAmplitude), 110);
	close(singleWave.originalSelectedLength, 200);
	close(singleWave.originalLocalLength, 200);
	close(singleWave.targetLength, 220);
	close(singleWave.plannedSelectedLength, 220);
	close(singleWave.plannedLocalLength, 220);
	close(singleWave.plannedAddedLength, 20);
	assert.equal(singleWave.minimumSelfGapMil, 'not-applicable');
	assert.match(singleWave.searchExplanation, /2 段、left侧/);
	assert.match(singleWave.searchExplanation, /不验证阻抗或整板避障/);

	const right = tune({ side: 'right' });
	assert.equal(right.selectedSide, 'right');
	close(right.localPath[1][1], -expectedAmplitude);

	const constrainedWave = tune({ region: { xMin: -10, yMin: -38, xMax: 210, yMax: 38 } });
	assert.equal(constrainedWave.selectedWaveSegments, 6, 'the region rejects m=2 and m=4 peaks and accepts m=6');
	assert.equal(constrainedWave.normalizedWaveSegments, 4, 'the constructed collinear outer points reduce six generated pieces to four output segments');
	assert.equal(constrainedWave.localPath.length, 5);
	close(Math.max(...constrainedWave.localPath.map(point => Math.abs(point[1]))), Math.sqrt(8400) / 3);
	for (let i = 0; i < constrainedWave.localPath.length - 2; i++) {
		const a = constrainedWave.localPath[i];
		const b = constrainedWave.localPath[i + 1];
		const c = constrainedWave.localPath[i + 2];
		const turn = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
		assert.notEqual(turn, 0, 'the normalized wave has no adjacent collinear interior point');
	}
	for (let i = 0; i < constrainedWave.localPath.length - 1; i++) {
		assert.ok(Math.hypot(constrainedWave.localPath[i + 1][0] - constrainedWave.localPath[i][0], constrainedWave.localPath[i + 1][1] - constrainedWave.localPath[i][1]) >= 1);
	}
	close(constrainedWave.plannedSelectedLength, 220);
	close(constrainedWave.plannedLocalLength, 220);
	assert.ok(constrainedWave.localPath.every(point => Math.abs(point[1]) <= 35 + 1e-8));

	const m6Boundary = tune({ region: { xMin: -10, yMin: -38, xMax: 210, yMax: 38 }, minSelfGap: 30.666666666666664 });
	assert.equal(m6Boundary.selectedWaveSegments, 6, 'm=6 remains feasible at the documented copper clearance boundary');
	close(m6Boundary.plannedSelectedLength, 220);

	const wholeChain = planLengthTune({
		path: [[-100, 0], [0, 0], [200, 0]],
		tuneSegmentIndex: 1,
		targetLength: 320,
		region: { xMin: -110, yMin: -100, xMax: 210, yMax: 100 },
		side: 'left',
		width: 6,
		minSelfGap: 0,
		lengthTolerance: 0.001,
	});
	close(wholeChain.originalSelectedLength, 300);
	close(wholeChain.originalLocalLength, 200);
	close(wholeChain.plannedSelectedLength, 320);
	close(wholeChain.plannedLocalLength, 220);
	close(wholeChain.plannedAddedLength, 20);

	const rotated = planLengthTune({
		path: [[0, 0], [120, 160]],
		tuneSegmentIndex: 0,
		targetLength: 220,
		region: { xMin: -100, yMin: -20, xMax: 130, yMax: 180 },
		side: 'left',
		width: 6,
		minSelfGap: 0,
		lengthTolerance: 0.001,
	});
	close(rotated.localPath[1][0], 60 - 0.8 * expectedAmplitude);
	close(rotated.localPath[1][1], 80 + 0.6 * expectedAmplitude);

	const unchanged = tune({ targetLength: 200.0005 });
	assert.equal(unchanged.changed, false);
	assert.deepEqual(unchanged.replacementPath, [[0, 0], [200, 0]]);
	assert.equal(unchanged.selectedSide, 'none');
	assert.equal(unchanged.selectedWaveSegments, 0);
	assert.throws(() => tune({ targetLength: 199 }), /只能补长/);

	const boundary = planLengthTune({
		path: [[3, 0], [197, 0]],
		tuneSegmentIndex: 0,
		targetLength: 214,
		region: { xMin: 0, yMin: -100, xMax: 200, yMax: 100 },
		side: 'left',
		width: 6,
		minSelfGap: 0,
		lengthTolerance: 0.001,
	});
	assert.deepEqual(boundary.localPath[0], [3, 0]);
	assert.deepEqual(boundary.localPath.at(-1), [197, 0]);
	assert.ok(boundary.localPath.every(([x, y]) => x >= 3 - 1e-8 && x <= 197 + 1e-8 && y >= -97 - 1e-8 && y <= 97 + 1e-8));
	assert.throws(() => tune({ region: { xMin: 5, yMin: -100, xMax: 210, yMax: 100 } }), /端点未完整落入/);
	assert.throws(() => tune({ region: { xMin: -10, yMin: -3.2, xMax: 210, yMax: 3.2 } }), /没有可行方案/);

	const exactMinimum = planLengthTune({
		path: [[0, 0], [1, 0]],
		tuneSegmentIndex: 0,
		targetLength: 2,
		region: { xMin: -10, yMin: -10, xMax: 10, yMax: 10 },
		side: 'left',
		width: 0.1,
		minSelfGap: 0,
		lengthTolerance: 1e-8,
	});
	assert.equal(exactMinimum.selectedWaveSegments, 2);
	assert.equal(Math.hypot(exactMinimum.localPath[1][0], exactMinimum.localPath[1][1]), 1);

	assert.throws(() => tune({ path: [[1e15, 0], [1e15 + 200, 0]], region: { xMin: 1e15 - 20, yMin: -100, xMax: 1e15 + 220, yMax: 100 } }), /精度不足/);
	assert.throws(() => tune({ minSelfGap: -1 }), /minSelfGap必须大于等于0/);
	assert.throws(() => tune({ minSelfGap: '0' }), /有限数值/);
	assert.throws(() => tune({ lengthTolerance: 0 }), /lengthTolerance必须大于0/);

	const longPath = [[0, 0], [200, 0], [200, 50], [0, 50]];
	const bypass = planLengthTune({
		path: longPath,
		tuneSegmentIndex: 0,
		targetLength: 470,
		region: { xMin: -10, yMin: -100, xMax: 210, yMax: 100 },
		side: 'left',
		width: 6,
		minSelfGap: 10,
		lengthTolerance: 0.001,
	});
	assert.ok(bypass.minimumSelfGapMil === 'not-applicable' || bypass.minimumSelfGapMil >= 10);
	assert.equal(bypass.replacementPath[0][0], longPath[0][0]);
	assert.deepEqual(bypass.replacementPath.slice(-2), longPath.slice(-2));
	assert.throws(() => planLengthTune({
		path: [[0, 0], [200, 0], [200, 10], [100, 10], [100, 40], [0, 40]],
		tuneSegmentIndex: 0,
		targetLength: 470,
		region: { xMin: -10, yMin: -100, xMax: 210, yMax: 100 },
		side: 'left',
		width: 6,
		minSelfGap: 0,
		lengthTolerance: 0.001,
	}), /没有可行方案/, 'a candidate wave that creates a bypass through another path segment is rejected');

	let budgetChecks = 0;
	tune({}, () => {
		budgetChecks++;
	});
	assert.ok(budgetChecks > 10, 'shared budget is checked during geometry construction and pair validation');

	console.log('length-tune-geometry-regression: all assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
