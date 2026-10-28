import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const nodeRequire = createRequire(import.meta.url);
function loadTs(file) {
	const absolute = resolve(root, file);
	const compiled = ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
	const module = { exports: {} };
	const localRequire = id => id.startsWith('.') ? loadTs(resolve(dirname(absolute).slice(root.length + 1), id.endsWith('.ts') ? id : `${id}.ts`)) : nodeRequire(id);
	new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
	return module.exports;
}
const { locateManufacturingSourceCandidates } = loadTs('src/engine/silkscreenSourceLocations.ts');
const box = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });
const footprint = { coverage: { sourceStable: true }, strokes: [{ sourceIdentity: { componentId: 'C1', footprintUuid: 'FP', localPrimitiveId: 'p1', source: 'document-embedded' }, side: 'top', bbox: box(1, 1, 2, 2) }] };
const result = locateManufacturingSourceCandidates({
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1), box(100, 100, 101, 101)] }], potentialConflicts: [{ category: 'silk-to-mask-opening', layer: 'top', locationBoundsMil: [], locationTruncated: true }] },
	checkedObjects: [
		{ id: 'text1', type: 'text', layer: 'top', box: box(1, 1, 2, 2) },
		{ id: 'pad1', type: 'component-pad', layer: 'multi', box: box(1, 1, 2, 2) },
		{ id: 'other-side', type: 'text', layer: 'bottom', box: box(1, 1, 2, 2) },
	], footprintSilkscreen: footprint, minClearanceMil: 0,
});
assert.equal(result.complete, false);
assert.equal(result.locations[0].status, 'ambiguous');
assert.deepEqual(result.locations[0].candidates.map(item => item.channel), ['footprint-source', 'sdk-object']);
assert.equal(result.locations[0].candidates[0].bboxDistanceToLocationMil, 0);
assert.equal(result.locations[0].candidates[0].confirmed, false);
assert.equal(result.locations[1].status, 'unavailable');
assert.match(result.locations[1].reason, /未找到/);
assert.equal(result.locations[2].status, 'unavailable');
assert.equal(result.locations[2].locationTruncated, true);
assert.equal(result.locations[2].areaIndex, null);
assert.equal(locateManufacturingSourceCandidates({ checkedObjects: [], footprintSilkscreen: footprint, minClearanceMil: 0 }).available, false);
assert.equal(locateManufacturingSourceCandidates({ manufacturing: {}, checkedObjects: [], footprintSilkscreen: footprint, minClearanceMil: 0 }).available, false);
assert.equal(locateManufacturingSourceCandidates({ manufacturing: { confirmedConflicts: [] }, checkedObjects: [], footprintSilkscreen: footprint, minClearanceMil: 0 }).available, false);
assert.equal(locateManufacturingSourceCandidates({ manufacturing: { unavailableReason: 'export missing' }, checkedObjects: [], footprintSilkscreen: footprint, minClearanceMil: 0 }).unavailableReason, 'export missing');
const incomplete = { complete: false, confirmedConflicts: [], potentialConflicts: [], unknowns: ['G74 remains unsupported'] };
const incompleteLocations = locateManufacturingSourceCandidates({ manufacturing: incomplete, checkedObjects: [], footprintSilkscreen: footprint, minClearanceMil: 0 });
assert.equal(incompleteLocations.available, true, 'available means the report arrays are structurally readable, not that manufacturing coverage is complete');
assert.equal(incomplete.complete, false);
assert.deepEqual(incomplete.unknowns, ['G74 remains unsupported']);
assert.match(readFileSync(resolve(root, 'src/commands/silkscreenCheck.ts'), 'utf8'), /manufacturing\.complete === true[\s\S]*制造检查不可用或未完成；保留制造报告中的原始原因/);

const sourceUnstableFootprint = { coverage: { sourceStable: false }, strokes: footprint.strokes };
const unstableResult = locateManufacturingSourceCandidates({ manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1)] }], potentialConflicts: [] }, checkedObjects: [], footprintSilkscreen: sourceUnstableFootprint, minClearanceMil: 0 });
assert.equal(unstableResult.locations[0].candidateCount, 0, 'stale footprint strokes are excluded when sourceStable is false');

for (const [clearance, expected] of [[1.24, 'candidate'], [1.23, 'unavailable'], [1.25, 'candidate']]) {
	const edge = locateManufacturingSourceCandidates({
		manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1)] }], potentialConflicts: [] },
		checkedObjects: [{ id: 'near-edge', type: 'text', layer: 'top', box: box(2.25, 0, 3, 1) }], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: clearance,
	});
	assert.equal(edge.locations[0].status, expected, `SDK box distance 1.25mil is compared to clearance ${clearance} plus 0.01mil search margin`);
}

const multiSide = locateManufacturingSourceCandidates({
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-mask-opening', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1)] }, { category: 'silk-to-mask-opening', layer: 'bottom', locationBoundsMil: [box(0, 0, 1, 1)] }], potentialConflicts: [] },
	checkedObjects: [{ id: 'multi-pad', type: 'component-pad', layer: 'multi', box: box(0.5, 0.5, 1.5, 1.5) }], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
});
assert.deepEqual(multiSide.locations.map(item => item.candidates.map(candidate => candidate.channel === 'sdk-object' ? candidate.id : 'footprint')), [['multi-pad'], ['multi-pad']], 'multi-layer pad boxes are candidates on either board side for mask regions');

const invalidLocations = locateManufacturingSourceCandidates({
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top' }, { category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [box(2, 0, 1, 1)] }], potentialConflicts: [] },
	checkedObjects: [], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
});
assert.equal(invalidLocations.locations[0].areaIndex, null);
assert.match(invalidLocations.locations[0].reason, /省略|没有位置|bounds/i);
assert.equal(invalidLocations.locations[1].areaIndex, 0);
assert.match(invalidLocations.locations[1].reason, /invalid|无效|non-finite/i);
const witness = { distanceBound: 'lower', silkGeometry: 'outer-envelope', kind: 'nearest-points', silkPointMil: [2, 1], boardPointMil: [1, 1], measuredDistanceMil: 1 };
const witnessLocationResult = locateManufacturingSourceCandidates({
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [{ minX: 1, minY: 1, maxX: 2, maxY: 1 }], locationKind: 'distance-witness', locationEnumerationComplete: false, locationWitness: witness }], potentialConflicts: [] },
	checkedObjects: [], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
});
assert.equal(witnessLocationResult.locations[0].locationKind, 'distance-witness');
assert.equal(witnessLocationResult.locations[0].locationEnumerationComplete, false);
assert.deepEqual(witnessLocationResult.locations[0].locationWitness, witness, 'the locator carries witness metadata without making candidates confirmed');
const witnessUnavailable = locateManufacturingSourceCandidates({
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationUnavailable: true, locationUnavailableReason: 'distance mismatch exceeds 1e-9 mil' }], potentialConflicts: [] },
	checkedObjects: [], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
});
assert.equal(witnessUnavailable.locations[0].reason, 'distance mismatch exceeds 1e-9 mil', 'the explicit witness validation reason is preserved');
assert.throws(() => locateManufacturingSourceCandidates({ manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1)] }], potentialConflicts: [] }, checkedObjects: [{ id: 'budget-object', type: 'text', layer: 'top', box: box(0, 0, 1, 1) }], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0, checkBudget: () => { throw new Error('budget stopped'); } }), /budget stopped/, 'budget exceptions propagate');

const roleManufacturing = { confirmedConflicts: [], potentialConflicts: [{ category: 'silk-to-mask-opening', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1)] }] };
const roleCandidates = [
	{ id: 'text-role', type: 'text', layer: 'top', box: box(0, 0, 1, 1) },
	{ id: 'pad-role', type: 'component-pad', layer: 'top', box: box(0, 0, 1, 1) },
];
const roleResult = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing, checkedObjects: roleCandidates,
	footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
});
const roleLocation = roleResult.locations[0];
assert.equal(roleLocation.status, 'ambiguous', 'the legacy flat view still combines all nearby candidates');
assert.deepEqual(roleLocation.roleGroups.map(group => [group.role, group.status, group.candidateCount]), [
	['silkscreen-source', 'candidate', 1], ['mask-opening-owner-candidate', 'candidate', 1],
], 'a mask location reports separate silk-source and possible opening-owner groups');
assert.equal(roleLocation.roleGroups.every(group => group.candidateIndices.every(index => Number.isInteger(index) && index >= 0 && index < roleLocation.candidates.length)), true);
assert.deepEqual(roleLocation.roleGroups.flatMap(group => group.candidateIndices.map(index => roleLocation.candidates[index].role)), ['silkscreen-source', 'mask-opening-owner-candidate']);
assert.deepEqual(roleLocation.candidates.map(candidate => candidate.role), ['mask-opening-owner-candidate', 'silkscreen-source']);
assert.deepEqual(roleLocation.candidates.map(candidate => candidate.confirmed), [false, false]);
const repeatedRoleLocation = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing, checkedObjects: roleCandidates,
	footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
}).locations[0];
assert.deepEqual(repeatedRoleLocation.roleGroups, roleLocation.roleGroups, 'role groups use stable indices into the unchanged sorted flat candidate list');

const sameRoleAmbiguous = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing,
	checkedObjects: [
		{ id: 'text-a', type: 'text', layer: 'top', box: box(0, 0, 1, 1) },
		{ id: 'text-b', type: 'designator', layer: 'top', box: box(0, 0, 1, 1) },
	], footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
}).locations[0];
assert.equal(sameRoleAmbiguous.roleGroups[0].status, 'ambiguous');
assert.equal(sameRoleAmbiguous.roleGroups[0].candidateCount, 2);
assert.equal(sameRoleAmbiguous.roleGroups[1].status, 'unavailable');
assert.match(sameRoleAmbiguous.roleGroups[1].reason, /不证明|不表示/u);

const missingSilkRole = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing, checkedObjects: [roleCandidates[1]],
	footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
}).locations[0];
assert.deepEqual(missingSilkRole.roleGroups.map(group => group.status), ['unavailable', 'candidate']);
const missingOwnerRole = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing, checkedObjects: [roleCandidates[0]],
	footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
}).locations[0];
assert.deepEqual(missingOwnerRole.roleGroups.map(group => group.status), ['candidate', 'unavailable']);
assert.match(missingOwnerRole.roleGroups[1].reason, /铜对象候选|不证明/u);

const footprintRole = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing, checkedObjects: [roleCandidates[1]],
	footprintSilkscreen: { coverage: { sourceStable: true }, strokes: footprint.strokes }, minClearanceMil: 0,
}).locations[0];
const footprintCandidate = footprintRole.candidates.find(candidate => candidate.channel === 'footprint-source');
assert.equal(footprintCandidate.role, 'silkscreen-source');
assert.deepEqual(footprintCandidate.sourceIdentity, footprint.strokes[0].sourceIdentity, 'footprint source identity is preserved');
assert.deepEqual(footprintRole.roleGroups.map(group => [group.role, group.candidateCount]), [
	['silkscreen-source', 1], ['mask-opening-owner-candidate', 1],
]);

const edgeRole = locateManufacturingSourceCandidates({
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-board-edge', layer: 'top', locationBoundsMil: [box(0, 0, 1, 1)], locationKind: 'distance-witness', locationEnumerationComplete: false, locationWitness: witness }], potentialConflicts: [] },
	checkedObjects: [roleCandidates[0], roleCandidates[1]],
	footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
}).locations[0];
assert.deepEqual(edgeRole.candidates.map(candidate => candidate.id), ['text-role'], 'edge locations exclude nearby pad boxes');
assert.deepEqual(edgeRole.roleGroups.map(group => group.role), ['silkscreen-source'], 'edge locations expose only the silk-source role');
assert.deepEqual(edgeRole.roleGroups[0].candidateIndices, [0]);
assert.deepEqual(edgeRole.locationWitness, witness, 'role grouping does not alter the distance witness');

const unknownType = locateManufacturingSourceCandidates({
	manufacturing: roleManufacturing,
	checkedObjects: [{ id: 'unknown-type', type: 'future-object' /* runtime input intentionally outside the supported type union */, layer: 'top', box: box(0, 0, 1, 1) }],
	footprintSilkscreen: { coverage: { sourceStable: false }, strokes: [] }, minClearanceMil: 0,
}).locations[0];
assert.equal(unknownType.candidateCount, 0, 'unknown future SDK types are not assumed to be silk sources');
assert.deepEqual(unknownType.roleGroups.map(group => group.status), ['unavailable', 'unavailable']);
assert.match(unknownType.roleGroups[1].reason, /不表示没有制造风险/u);
console.log('ok silkscreen source-location candidates');
