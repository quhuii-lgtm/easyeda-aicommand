import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({
	stdin: { contents: "export { branchPointContactDistance, branchSegmentContactDistance, branchSegmentContactIntervals, branchPathContactIntervals } from '../src/pcb/branchContactGeometry.ts'; export { curveFromEndpoints } from '../src/pcb/arcTuneGeometry.ts'; export { planPadBranches } from '../src/pcb/padBranchGeometry.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'branch-contact-geometry-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const { branchPointContactDistance: pointDistance, branchSegmentContactDistance: segmentDistance, branchSegmentContactIntervals: segmentIntervals, branchPathContactIntervals: pathIntervals, curveFromEndpoints, planPadBranches } = api;
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const capsule = (id, width, height, rotation = 0, center = [0, 0]) => ({ id, net: 'P', layers: [1], kind: 'capsule', width, height, rotation, center });
const arc = (id, a, b, sweepDegrees, width = 0) => ({ id, net: 'P', layers: [1], kind: 'arc', curve: curveFromEndpoints(a, b, sweepDegrees), width });

{
	const horizontal = capsule('horizontal', 20, 10);
	close(pointDistance([0, 7], horizontal), 2);
	close(pointDistance([12, 0], horizontal), 2);
	close(segmentDistance([-20, 0], [20, 0], horizontal), 0);
	assert.deepEqual(segmentIntervals([-20, 0], [20, 0], horizontal, 0), [[10, 30]]);
	assert.equal(pathIntervals([[0, 0], [20, 0], [0, 0]], horizontal, 0).length, 2, 'a re-entering route retains two disjoint capsule contacts');
	assert.deepEqual(segmentIntervals([0, -10], [0, 10], horizontal, 0), [[5, 15]]);
	assert.deepEqual(segmentIntervals([-20, 6], [20, 6], horizontal, 1), [[15, 25]], 'capsule side tangency must be retained as a closed contact interval');
}

{
	const vertical = capsule('vertical', 10, 20, 0);
	assert.deepEqual(segmentIntervals([-10, 0], [10, 0], vertical, 0), [[5, 15]]);
	const rotated = capsule('rotated', 20, 10, 37);
	const angle = 37 * Math.PI / 180;
	const axis = [Math.cos(angle), Math.sin(angle)];
	const across = [-Math.sin(angle), Math.cos(angle)];
	const start = [-axis[0] * 20, -axis[1] * 20];
	const end = [axis[0] * 20, axis[1] * 20];
	close(segmentDistance(start, end, rotated), 0);
	const sideA = [across[0] * 6 - axis[0] * 5, across[1] * 6 - axis[1] * 5];
	const sideB = [across[0] * 6 + axis[0] * 5, across[1] * 6 + axis[1] * 5];
	assert.deepEqual(segmentIntervals(sideA, sideB, rotated, 1).map(([a, b]) => [Number(a.toFixed(6)), Number(b.toFixed(6))]), [[0, 10]], 'rotated straight side contact at exact clearance is retained');
	const equal = capsule('equal', 12, 12, 37);
	close(pointDistance([0, 7], equal), 1, 1e-9);
	assert.deepEqual(segmentIntervals([-10, 0], [10, 0], equal, 0), [[4, 16]], 'equal-size capsule degenerates to a circle independent of rotation');
	assert.deepEqual(segmentIntervals([-10_000_000, 0], [10_000_000, 0], capsule('small-equal', 2, 2), 0), [[9_999_999, 10_000_001]], 'long routes preserve the small capsule chord without a global discriminant cancellation');
	const extreme = segmentIntervals([-1_000_000_000_000_000, 0], [1_000_000_000_000_000, 0], capsule('extreme-small-equal', 2, 2), 0);
	assert.equal(extreme.length, 1, 'extreme-length route retains one contact interval');
	close(extreme[0][0], 999_999_999_999_999, 0.2, 'extreme-scale entry remains within one representable step');
	close(extreme[0][1], 1_000_000_000_000_001, 0.2, 'extreme-scale exit remains within one representable step');
	assert.ok(extreme[0][1] > extreme[0][0], 'distinct extreme-scale intersections stay distinct');
	const shallow = segmentIntervals([-1_000_000_000_000, 0.9999995], [1_000_000_000_000, 0.9999995], capsule('shallow-small-equal', 2, 2), 0);
	assert.equal(shallow.length, 1, 'near-tangent circle overlap on a long route remains one interval');
	assert.ok(shallow[0][1] > shallow[0][0], 'distinct shallow-overlap intersections are not collapsed to a point');
}

{
	const quarter = arc('quarter', [10, 0], [0, 10], 90);
	close(segmentDistance([Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], quarter), 0);
	close(segmentDistance([-8, 8], [-8, 8], quarter), Math.hypot(8, 2));
	const tangent = segmentIntervals([-20, 10], [20, 10], quarter, 0);
	assert.equal(tangent.length, 1, 'circle tangent at an arc interior point is retained');
	close(tangent[0][0], 20, 1e-6);
	close(tangent[0][1], 20, 1e-6);
	assert.deepEqual(segmentIntervals([-20, 1], [20, 1], capsule('exact-circle-tangent', 2, 2), 0), [[20, 20]], 'an exact circle tangent remains a single closed point');
	const nearTangent = segmentIntervals([-20, 0.99999999], [20, 0.99999999], capsule('short-positive-circle-overlap', 2, 2), 0);
	assert.equal(nearTangent.length, 1);
	assert.ok(nearTangent[0][1] > nearTangent[0][0], 'a short positive circle overlap is not rounded to a point');
	assert.deepEqual(segmentIntervals([-2, 0], [2, 0], quarter, 1), [], 'opposite half-circle does not create a false contact');
	const upperHalf = arc('upper-half', [10, 0], [-10, 0], 180);
	const lowerHalf = arc('lower-half', [10, 0], [-10, 0], -180);
	close(pointDistance([0, 10], upperHalf), 0);
	close(pointDistance([0, 10], lowerHalf), Math.hypot(10, 10));
	for (const sweep of [90, -90, 180, -180, 270, -270]) {
		let a;
		let b;
		if (Math.abs(sweep) === 90) { a = [10, 0]; b = [0, Math.sign(sweep) * 10]; }
		else if (Math.abs(sweep) === 180) { a = [10, 0]; b = [-10, 0]; }
		else if (sweep > 0) { a = [-Math.SQRT1_2 * 10, -Math.SQRT1_2 * 10]; b = [-Math.SQRT1_2 * 10, Math.SQRT1_2 * 10]; }
		else { a = [-Math.SQRT1_2 * 10, Math.SQRT1_2 * 10]; b = [-Math.SQRT1_2 * 10, -Math.SQRT1_2 * 10]; }
		const sweepArc = arc(`sweep-${sweep}`, a, b, sweep);
		const midpointAngle = Math.atan2(a[1] - sweepArc.curve.center[1], a[0] - sweepArc.curve.center[0]) + sweep * Math.PI / 360;
		const midpoint = [sweepArc.curve.center[0] + sweepArc.curve.radius * Math.cos(midpointAngle), sweepArc.curve.center[1] + sweepArc.curve.radius * Math.sin(midpointAngle)];
		close(pointDistance(midpoint, sweepArc), 0, 1e-7, `signed sweep ${sweep} midpoint lies on the arc`);
	}
}

{
	const threeQuarter = arc('three-quarter', [10, 0], [0, -10], 270);
	const separated = segmentIntervals([-20, 0], [20, 0], threeQuarter, 1);
	assert.equal(separated.length, 2, 'one straight path may contact two separated portions of a major arc');
	assert.ok(separated[0][1] < separated[1][0]);
	const vertexArc = arc('vertex', [10, 0], [0, 10], 90, 2);
	const merged = pathIntervals([[8, 0], [10, 0], [12, 0]], vertexArc, 1);
	assert.equal(merged.length, 1, 'contact intervals touching at a path vertex merge into one continuous interval');
	close(merged[0][0], 0);
	close(merged[0][1], 4);
}

{
	const circle = (id, net, center) => ({ id, net, layers: [1], kind: 'circle', center, radius: 6 });
	const plan = (arcContact, request, pads, clearance = 2) => planPadBranches({
		pair: { positiveNet: 'P', negativeNet: 'N' }, layer: 1, width: 4, clearanceMil: clearance,
		positive: request.positive,
		negative: request.negative ?? { joinPoint: [20, 100], branches: [{ padId: 'n' }] },
	}, pads, [], [...pads, arcContact], undefined, [arcContact]);
	const major = arc('major', [20, 0], [0, -20], 270, 2);
	const through = { positive: { joinPoint: [20, 0], branches: [{ padId: 'p' }] }, negative: { joinPoint: [20, 100], branches: [{ padId: 'n' }] } };
	assert.throws(() => plan(major, through, [circle('p', 'P', [-30, 0]), circle('n', 'N', [-30, 100])], 2), /分离接触多次/, 'non-trunk same-net arc contact re-entry is rejected');
	assert.throws(() => plan(major, { ...through, positive: { ...through.positive, trunk: { primitiveId: 'major', endpoint: 'start' } } }, [circle('p', 'P', [-30, 0]), circle('n', 'N', [-30, 100])], 2), /单一连续末端后缀/, 'ARC trunk cannot be touched early and re-entered near the join');
	assert.throws(() => plan(major, { ...through, positive: { ...through.positive, branches: [{ padId: 'major' }] } }, [circle('major', 'P', [-30, 0]), circle('n', 'N', [-30, 100])], 2), /跨类型ID冲突/, 'ARC cannot alias a target PAD');

	const quarter = arc('quarter-trunk', [100, 100], [110, 110], 90, 2);
	const oneTouch = plan(quarter, { positive: { joinPoint: [100, 100], branches: [{ padId: 'p' }] } }, [circle('p', 'P', [50, 100]), circle('n', 'N', [50, 200])]);
	assert.ok(oneTouch.positive.additionalSameNetContacts.some(item => item.objectId === 'quarter-trunk' && item.branchPadId === 'p'), 'one continuous same-net ARC contact is reported');

	const clearanceArc = { ...arc('foreign-clearance', [65, 117], [85, 117], 180, 6), net: 'N' };
	const atClearance = plan(clearanceArc, { positive: { joinPoint: [100, 100], branches: [{ padId: 'p' }] } }, [circle('p', 'P', [50, 100]), circle('n', 'N', [50, 200])], 2);
	assert.ok(atClearance.positive.branches.length === 1, 'exact configured ARC clearance is accepted');
	assert.throws(() => plan(clearanceArc, { positive: { joinPoint: [100, 100], branches: [{ padId: 'p' }] } }, [circle('p', 'P', [50, 100]), circle('n', 'N', [50, 200])], 2.001), /异网导电对象/, 'insufficient signed ARC clearance is rejected');
}

console.log('branch-contact-geometry-regression: PASS');
