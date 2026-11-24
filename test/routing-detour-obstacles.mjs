import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const bundled = await build({
		stdin: {
			contents: `export { assessRoutingDetour, evaluateRoutingDetour } from '../src/pcb/routingDetourObstacles.ts';`,
			resolveDir: import.meta.dirname,
			loader: 'ts',
		},
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
	});
	const { assessRoutingDetour } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
	const p = (x, y) => ({ x, y });
	const board = [p(0, 0), p(120, 0), p(120, 80), p(0, 80)];
	const base = {
		source: { id: 'old-path', objectIds: ['old-1', 'old-2'], net: 'SIG', layer: 1, widthMil: 4, points: [p(10, 20), p(50, 20), p(50, 60), p(100, 60)] },
		outline: [board],
		tracks: [],
		vias: [],
		pads: [],
		copper: [],
		keepouts: [],
		issues: [],
		rules: { clearanceMil: 6, edgeClearanceMil: 6 },
		obstacleCoverageComplete: true,
	};

	const open = assessRoutingDetour(base);
	assert(open.candidates.some(candidate => candidate.style !== 'direct' && candidate.decision === 'manual-review-candidate'));
	assert(open.candidates.some(candidate => candidate.style === 'direct' && candidate.decision === 'geometry-preview-only'));
	assert(open.candidates.every(candidate => candidate.savingsMil > 1));
	assert.equal(open.readOnly, true);
	assert.equal(open.noViaReductionClaim, true);

	const axisAligned = assessRoutingDetour({
		...base,
		source: { ...base.source, points: [p(10, 10), p(10, 40), p(100, 40), p(100, 10)] },
	});
	assert.equal(new Set(axisAligned.candidates.map(candidate => JSON.stringify(candidate.points))).size, axisAligned.candidates.length);
	assert.equal(axisAligned.candidates.filter(candidate => JSON.stringify(candidate.points) === JSON.stringify([p(10, 10), p(100, 10)])).length, 1);

	const nonFortyFive = assessRoutingDetour({
		...base,
		source: { ...base.source, points: [p(10, 10), p(10, 50), p(100, 50), p(100, 50), p(100, 50)] },
	});
	assert(nonFortyFive.candidates.some(candidate => candidate.style === 'direct' && candidate.decision === 'geometry-preview-only'));

	const blockedByForeignTrack = assessRoutingDetour({
		...base,
		tracks: [{ id: 'foreign', net: 'CLK', layer: 1, width: 8, a: p(50, 0), b: p(50, 80) }],
	});
	const direct = blockedByForeignTrack.candidates.find(candidate => candidate.style === 'direct');
	assert(direct?.blockers.some(blocker => blocker.objectId === 'foreign'));

	const blockedByThirdPartySameNet = assessRoutingDetour({
		...base,
		tracks: [{ id: 'branch', net: 'SIG', layer: 1, width: 8, a: p(60, 10), b: p(60, 30) }],
	});
	assert(blockedByThirdPartySameNet.candidates.some(candidate => candidate.blockers.some(blocker => blocker.code === 'unintended-same-net-contact')));

	const keepout = assessRoutingDetour({
		...base,
		keepouts: [{ id: 'ko', layer: 1, rings: [[p(45, 10), p(65, 10), p(65, 30), p(45, 30)]] }],
	});
	assert(keepout.candidates.some(candidate => candidate.blockers.some(blocker => blocker.objectId === 'ko')));

	const concaveBoard = [p(0, 0), p(100, 0), p(100, 100), p(60, 100), p(60, 40), p(40, 40), p(40, 100), p(0, 100)];
	const concave = assessRoutingDetour({
		...base,
		source: { ...base.source, points: [p(10, 80), p(10, 20), p(90, 20), p(90, 80)] },
		outline: [concaveBoard],
	});
	const crossesNotch = concave.candidates.find(candidate => candidate.style === 'direct');
	assert(crossesNotch?.blockers.some(blocker => blocker.code === 'outside-board'));

	const unknownRules = assessRoutingDetour({ ...base, rules: {} });
	assert(unknownRules.candidates.every(candidate => candidate.decision === 'geometry-preview-only'));
	const missingBoard = assessRoutingDetour({ ...base, outline: undefined });
	assert(missingBoard.candidates.every(candidate => candidate.decision === 'geometry-preview-only'));

	const preserved = assessRoutingDetour({
		...base,
		source: { ...base.source, points: [p(10, 20), p(50, 20), p(50, 60), p(100, 60)] },
		copper: [{ id: 'old-contact', net: 'SIG', layer: 1, rings: [[p(48, 30), p(52, 30), p(52, 35), p(48, 35)]] }],
	});
	assert(preserved.candidates.some(candidate => candidate.blockers.some(blocker => blocker.code === 'protected-contact-lost')));

	const uContact = assessRoutingDetour({
		...base,
		source: { ...base.source, points: [p(10, 50), p(45, 50), p(45, 35), p(55, 35), p(55, 50), p(90, 50)] },
		copper: [{ id: 'same-net-u-stroke', net: 'SIG', layer: 1, stroke: 10, rings: [[p(45, 20), p(45, 40), p(55, 40), p(55, 20)]] }],
	});
	const uDirect = uContact.candidates.find(candidate => candidate.style === 'direct');
	assert(uDirect?.blockers.some(blocker => blocker.code === 'protected-contact-lost' && blocker.objectId === 'same-net-u-stroke'));

	console.log('PASS shorter same-layer candidates, foreign/same-net obstacles, keepout, concave outline, unknown-rule downgrade, and old copper-contact preservation');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
