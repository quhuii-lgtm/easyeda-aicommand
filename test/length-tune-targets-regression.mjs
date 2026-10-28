import assert from 'node:assert/strict';
import { planArcLengthTune } from '../src/pcb/arcTuneGeometry.ts';
import { checkTuneAttachments, resolveTuneSelection } from '../src/pcb/lengthTuneTargets.ts';

const l = (id, a, b, changes = {}) => ({ id, net: 'N1', layer: 1, width: 1, a, b, ...changes });
const region = { xMin: -1, yMin: -2, xMax: 12, yMax: 2 };

const selection = resolveTuneSelection({
	net: 'N1',
	lines: [l('b', [5, 0], [10, 0]), l('a', [0, 0], [5, 0])],
	primitiveIds: ['b', 'a'],
	region,
});
assert.deepEqual(selection.orderedIds, ['a', 'b']);
assert.deepEqual(selection.path, [[0, 0], [5, 0], [10, 0]]);
assert.deepEqual(selection.tuneSegmentIndices, [0, 1]);
assert.equal(selection.tuneSegmentIndex, 0);
assert.equal(resolveTuneSelection({ net: 'N1', lines: [l('only', [0, 0], [10, 0])], region }).orderedIds[0], 'only');
const selectionWithGraphicLine = resolveTuneSelection({
	net: 'N1',
	lines: [l('target-with-graphic', [0, 0], [10, 0]), l('graphic', [0, -5], [10, -5], { net: '' })],
	primitiveIds: ['target-with-graphic'],
	region,
});
assert.deepEqual(selectionWithGraphicLine.orderedIds, ['target-with-graphic']);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [10, 0]), l('b', [0, 1], [10, 1])], region }), /明确提供primitiveIds.*a, b/);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [5, 0]), l('b', [5, 0], [10, 0]), l('branch', [5, 0], [5, 2])], primitiveIds: ['a', 'b', 'branch'], region }), /分叉/);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [10, 0]), l('b', [10, 0], [0, 0])], primitiveIds: ['a', 'b'], region }), /重复id|闭环/);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [10, 0], { net: 'N2' })], primitiveIds: ['a'], region }), /不同net/);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [5, 0]), l('b', [5, 0], [10, 0], { layer: 2 })], primitiveIds: ['a', 'b'], region }), /不同layer/);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [5, 0]), l('b', [5, 0], [10, 0], { width: 2 })], primitiveIds: ['a', 'b'], region }), /不同width/);
assert.throws(() => resolveTuneSelection({ net: 'N1', lines: [l('a', [0, 0], [5, 0]), l('b', [6, 0], [10, 0])], primitiveIds: ['a', 'b'], region }), /不是开放单链/);

const path = [[0, 0], [5, 4], [10, 0]];
function check(contacts = [], remainingLines = [], newLocalPath = path) {
	return checkTuneAttachments({
		targetLine: l('target', [0, 0], [10, 0]),
		remainingLines,
		newLocalPath,
		contacts,
	});
}
function checkLong(contacts = [], remainingLines = [], newLocalPath = [[0, 0], [50, 50], [100, 0]]) {
	return checkTuneAttachments({
		targetLine: l('target', [0, 0], [100, 0], { width: 2 }),
		remainingLines,
		newLocalPath,
		contacts,
	});
}
const startPad = check([{ id: 'pad-start', net: 'N1', layers: [1], kind: 'circle', center: [0, 0], radius: 2 }]);
assert.ok(startPad.endpointConnections.some(x => x.objectId === 'pad-start' && x.endpoint === 'start'));
assert.equal(startPad.interiorConnections.length, 0);
const rotatedRect = check([{ id: 'rect-start', net: 'N1', layers: [1], kind: 'rect', center: [0, 0], width: 3, height: 7, rotation: 37 }]);
assert.ok(rotatedRect.endpointConnections.some(x => x.objectId === 'rect-start' && x.endpoint === 'start'));

const middleLine = check([], [l('cross', [5, 2], [5, 6])]);
assert.ok(middleLine.interiorConnections.some(x => x.objectId === 'cross'));
const tee = check([], [l('tee', [5, 4], [5, 8])]);
assert.ok(tee.interiorConnections.some(x => x.objectId === 'tee'));
const otherLayer = check([{ id: 'other-layer', net: 'N1', layers: [2], kind: 'circle', center: [5, 4], radius: 2 }]);
assert.equal(otherLayer.endpointConnections.length, 0);
assert.equal(otherLayer.interiorConnections.length, 0);
assert.equal(otherLayer.coverage.checkedContacts, 0);
const graphicLine = check([], [l('unnetted-graphic', [5, 4], [5, 8], { net: '' })]);
assert.equal(graphicLine.interiorConnections.length, 0);
assert.equal(graphicLine.coverage.checkedLines, 0);
assert.equal(graphicLine.coverage.excludedDifferentNet, 1);

const viaAtEnd = check([{ id: 'via-end', net: 'N1', layers: [1], kind: 'circle', center: [0, 0], radius: 2, holeRadius: 1 }]);
assert.ok(viaAtEnd.endpointConnections.some(x => x.objectId === 'via-end'));
assert.equal(viaAtEnd.interiorConnections.length, 0);
const viaMiddle = check([{ id: 'via-mid', net: 'N1', layers: [1], kind: 'circle', center: [5, 4], radius: 1, holeRadius: 0.5 }]);
assert.ok(viaMiddle.interiorConnections.some(x => x.objectId === 'via-mid'));

const farUnknown = check([{ id: 'far-complex', net: 'N1', layers: null, kind: 'unknown', bounds: { xMin: 50, yMin: 50, xMax: 55, yMax: 55 } }]);
assert.equal(farUnknown.uncertainContacts.length, 0);
const nearUnknown = check([{ id: 'near-complex', net: 'N1', layers: null, kind: 'unknown', bounds: { xMin: 4, yMin: 3, xMax: 6, yMax: 5 } }]);
assert.ok(nearUnknown.uncertainContacts.some(x => x.objectId === 'near-complex'));
const bypassPad = check([{ id: 'both-ends', net: 'N1', layers: [1], kind: 'circle', center: [5, 2], radius: 7 }]);
assert.ok(bypassPad.bypassRisks.some(x => x.objectId === 'both-ends'));
const nonAdjacentBypass = check([], [l('multi-touch', [-1, 1], [11, 1])], [[0, 0], [2, 2], [4, 0], [6, 2], [8, 0], [10, 2]]);
assert.ok(nonAdjacentBypass.bypassRisks.some(x => x.objectId === 'multi-touch'));
const oldTee = checkLong([], [l('old-tee', [50, 0], [50, -20], { width: 2 })]);
assert.ok(oldTee.interiorConnections.some(x => x.objectId === 'old-tee'));
const oldCross = checkLong([], [l('old-cross', [50, -20], [50, 20], { width: 2 })]);
assert.ok(oldCross.interiorConnections.some(x => x.objectId === 'old-cross'));
const oldPad = checkLong([{ id: 'old-pad', net: 'N1', layers: [1], kind: 'circle', center: [50, 0], radius: 5 }]);
assert.ok(oldPad.interiorConnections.some(x => x.objectId === 'old-pad'));
const oldVia = checkLong([{ id: 'old-via', net: 'N1', layers: [1], kind: 'circle', center: [50, 0], radius: 4, holeRadius: 2 }]);
assert.ok(oldVia.interiorConnections.some(x => x.objectId === 'old-via'));
const oldNearUnknown = checkLong(
	[{ id: 'old-unknown', net: 'N1', layers: null, kind: 'unknown', bounds: { xMin: 48, yMin: -2, xMax: 52, yMax: 2 } }],
	[],
	[[0, 0], [25, 100], [75, 100], [100, 0]],
);
assert.ok(oldNearUnknown.uncertainContacts.some(x => x.objectId === 'old-unknown'));
const sameDirectionOverlap = checkLong([], [l('same-direction', [0, 0], [40, 40], { width: 2 })]);
assert.ok(sameDirectionOverlap.interiorConnections.some(x => x.objectId === 'same-direction' && /同向重叠/.test(x.reason)));
const reverseExtension = checkLong([], [l('reverse-extension', [0, 0], [-40, -40], { width: 2 })]);
assert.equal(reverseExtension.interiorConnections.length, 0);
assert.equal(reverseExtension.bypassRisks.length, 0);
const endpointPadAndReverseExtension = checkTuneAttachments({
	targetLine: l('target', [0, 0], [100, 0], { width: 2 }),
	remainingLines: [l('reverse-extension', [0, 0], [-40, -40], { width: 2 })],
	newLocalPath: [[0, 0], [50, 50], [100, 0]],
	contacts: [{ id: 'endpoint-pad', net: 'N1', layers: [1], kind: 'circle', center: [0, 0], radius: 5 }],
});
assert.equal(endpointPadAndReverseExtension.interiorConnections.length, 0);
assert.equal(endpointPadAndReverseExtension.bypassRisks.length, 0);
const reversedTargetPad = checkTuneAttachments({
	targetLine: l('target', [100, 0], [0, 0], { width: 2 }),
	remainingLines: [],
	newLocalPath: [[0, 0], [50, 50], [100, 0]],
	contacts: [{ id: 'reversed-pad', net: 'N1', layers: [1], kind: 'circle', center: [0, 0], radius: 5 }],
});
assert.equal(reversedTargetPad.interiorConnections.length, 0);
const reversedTargetTail = checkTuneAttachments({
	targetLine: l('target', [100, 0], [0, 0], { width: 2 }),
	remainingLines: [l('tail', [-20, 0], [0, 0], { width: 2 })],
	newLocalPath: [[0, 0], [50, 50], [100, 0]],
	contacts: [],
});
assert.equal(reversedTargetTail.interiorConnections.length, 0);
assert.equal(reversedTargetTail.bypassRisks.length, 0);
const arcSamples = Array.from({ length: 9 }, (_, i) => [10 * Math.cos(i * Math.PI / 16), 10 * Math.sin(i * Math.PI / 16)]);
const sampledArcPad = checkTuneAttachments({
	targetLine: l('arc-target', arcSamples[0], arcSamples.at(-1)),
	remainingLines: [],
	newLocalPath: arcSamples,
	newEdgePrimitiveIndices: Array.from({ length: 8 }).fill(12),
	curveSagittaMil: 0.02,
	contacts: [{ id: 'arc-start-pad', net: 'N1', layers: [1], kind: 'circle', center: arcSamples[0], radius: 3 }],
});
assert.equal(sampledArcPad.interiorConnections.length, 0, 'sample chords from one ARC are one continuous endpoint primitive');
assert.ok(sampledArcPad.endpointConnections.some(x => x.objectId === 'arc-start-pad' && x.endpoint === 'start'));
const sampledArcAnnulus = checkTuneAttachments({
	targetLine: l('arc-via-target', arcSamples[0], arcSamples.at(-1)),
	remainingLines: [],
	newLocalPath: arcSamples,
	newEdgePrimitiveIndices: Array.from({ length: 8 }).fill(21),
	curveSagittaMil: 0.02,
	contacts: [{ id: 'arc-start-via', net: 'N1', layers: [1], kind: 'circle', center: arcSamples[0], radius: 4, holeRadius: 1 }],
});
assert.ok(sampledArcAnnulus.endpointConnections.some(x => x.objectId === 'arc-start-via' && x.endpoint === 'start'), 'annulus contact can occur after initial samples pass through the hole');
assert.equal(sampledArcAnnulus.interiorConnections.length, 0);
const realArcPlan = planArcLengthTune({
	path: [[0, 0], [200, 0]],
	tuneSegmentIndex: 0,
	targetLength: 220,
	region: { xMin: -20, yMin: -100, xMax: 220, yMax: 100 },
	side: 'auto',
	width: 6,
	minSelfGap: 0,
	lengthTolerance: 0.001,
	bendRadius: 7,
});
function checkRealArcStartContact(contact) {
	return checkTuneAttachments({
		targetLine: l('real-arc-target', [0, 0], [200, 0], { width: 6 }),
		remainingLines: [],
		newLocalPath: realArcPlan.samples.points,
		newEdgePrimitiveIndices: realArcPlan.samples.edgePrimitiveIndices,
		curveSagittaMil: realArcPlan.samples.maxSagittaMil,
		contacts: [contact],
	});
}
const realArcStartPad = checkRealArcStartContact({ id: 'real-arc-start-pad', net: 'N1', layers: [1], kind: 'circle', center: [0, 0], radius: 12 });
assert.equal(realArcStartPad.interiorConnections.length, 0, 'real r7 sampled arcs and left leg remain a legal continuous PAD prefix');
assert.equal(realArcStartPad.bypassRisks.length, 0);
assert.ok(realArcStartPad.endpointConnections.some(x => x.objectId === 'real-arc-start-pad' && x.endpoint === 'start'));
const realArcStartVia = checkRealArcStartContact({ id: 'real-arc-start-via', net: 'N1', layers: [1], kind: 'circle', center: [0, 0], radius: 12, holeRadius: 6 });
assert.equal(realArcStartVia.interiorConnections.length, 0, 'real r7 sampled arcs leave the via hole through a continuous annulus prefix');
assert.equal(realArcStartVia.bypassRisks.length, 0);
assert.ok(realArcStartVia.endpointConnections.some(x => x.objectId === 'real-arc-start-via' && x.endpoint === 'start'));
const reenteredContact = checkTuneAttachments({
	targetLine: l('reenter-target', [0, 0], [4, 0], { width: 0.2 }),
	remainingLines: [],
	newLocalPath: [[0, 0], [2, 0], [4, 0], [2, 0], [0, 0]],
	newEdgePrimitiveIndices: [0, 1, 2, 3],
	contacts: [{ id: 'reentered-pad', net: 'N1', layers: [1], kind: 'circle', center: [1, 0], radius: 0.2 }],
});
assert.ok(reenteredContact.bypassRisks.some(x => x.objectId === 'reentered-pad'), 'separate contact intervals are a bypass risk');
const sampledOldTee = checkTuneAttachments({
	targetLine: l('sampled-old-target', [0, 0], [10, 0], { width: 0.2 }),
	remainingLines: [l('sampled-old-branch', [5, 0], [5, -5], { width: 0.2 })],
	newLocalPath: [[0, 0], [5, 1], [10, 0]],
	newEdgePrimitiveIndices: [0, 1],
	curveSagittaMil: 0.5,
	contacts: [{ id: 'sampled-old-unknown', net: 'N1', layers: null, kind: 'unknown', bounds: { xMin: 4.9, yMin: -0.2, xMax: 5.1, yMax: 0.2 } }],
});
assert.ok(sampledOldTee.interiorConnections.some(x => x.objectId === 'sampled-old-branch'), 'sagitta does not widen old target protection');
assert.ok(sampledOldTee.uncertainContacts.some(x => x.objectId === 'sampled-old-unknown'), 'unknown bounds cover old target and new path');
assert.throws(() => checkTuneAttachments({
	targetLine: l('bad-map-target', [0, 0], [10, 0]),
	remainingLines: [],
	newLocalPath: [[0, 0], [5, 1], [10, 0]],
	newEdgePrimitiveIndices: [0],
	contacts: [],
}), /newEdgePrimitiveIndices长度/);
assert.throws(() => checkTuneAttachments({
	targetLine: l('bad-map-target', [0, 0], [10, 0]),
	remainingLines: [],
	newLocalPath: [[0, 0], [5, 1], [10, 0]],
	newEdgePrimitiveIndices: [2, 1.5],
	contacts: [],
}), /非负整数/);
assert.throws(() => checkTuneAttachments({
	targetLine: l('bad-map-target', [0, 0], [10, 0]),
	remainingLines: [],
	newLocalPath: [[0, 0], [10, 0]],
	curveSagittaMil: -0.1,
	contacts: [],
}), /curveSagittaMil/);
for (const result of [startPad, rotatedRect, middleLine, tee, otherLayer, graphicLine, viaAtEnd, viaMiddle, farUnknown, nearUnknown, bypassPad, nonAdjacentBypass, oldTee, oldCross, oldPad, oldVia, oldNearUnknown, sameDirectionOverlap, reverseExtension, endpointPadAndReverseExtension, reversedTargetPad, reversedTargetTail, sampledArcPad, sampledArcAnnulus, realArcStartPad, realArcStartVia, reenteredContact, sampledOldTee]) {
	assert.equal(result.coverage.complete, false, 'the local attachment check never claims whole-board completion');
}
console.log('length-tune-targets-regression: all assertions passed');
