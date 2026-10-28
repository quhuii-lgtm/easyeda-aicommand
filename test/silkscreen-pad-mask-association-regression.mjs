import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const built = await build({ stdin: { contents: "import { extractFootprintPadMaskCandidates } from '../src/engine/footprintSilkscreen.ts'; import { analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } from '../src/pcb/silkscreenGerber.ts'; export { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry }", resolveDir: resolve(root, 'test'), sourcefile: 'silkscreen-pad-mask-association-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' });
const { extractFootprintPadMaskCandidates, analyzePadMaskOpeningAssociations, parseGerberLayerGeometry } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const mm = mil => mil * 25.4 / 1000;
const mmText = value => Number(value.toFixed(5)).toFixed(5).replace(/0+$/u, '').replace(/\.$/u, '');
const coordinate = mil => String(Math.round(mil * 2540));
const angles = [0, 90, 180, 270, 37];
const padNumbers = ['1', '2'];
const widthMil = 31.751;
const heightMil = 34.016;
const expansionMil = 3;

function footprintSource(uuid, expansionSet = { top: 3, bottom: 7 }, localPadLayerId = 1) {
	const rows = [
		{ type: 'DOCHEAD', id: 'head', ticket: 0, data: { docType: 'FOOTPRINT', uuid } },
		...padNumbers.map((num, index) => ({ type: 'PAD', id: `local-${num}`, ticket: index + 1, data: { num, layerId: localPadLayerId, hole: null, defaultPad: { padType: 'RECT', width: widthMil, height: heightMil, radius: 0 }, specialPad: [], padType: 'NORMAL', topSolderExpansion: expansionSet.top, bottomSolderExpansion: expansionSet.bottom, padLen: 0 } })),
	];
	return rows.map(({ type, id, ticket, data }) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`).join('\n');
}

function makeFixture(poses = angles, customCenters = [], customBoxes = [], expansionSet = { top: 3, bottom: 7 }, componentLayers = [], localPadLayerId = 1) {
	const components = [];
	const padSnapshots = [];
	const pcbRecords = [];
	const footprintSources = [];
	const apertures = [];
	const flashStatements = { top: [], bottom: [] };
	for (let poseIndex = 0; poseIndex < poses.length; poseIndex++) {
		const componentId = `component-${poseIndex}`;
		const footprintUuid = `footprint-${poseIndex}`;
		const layerId = componentLayers[poseIndex] ?? (poseIndex === poses.length - 1 ? 2 : 1);
		const runtimeLayerId = localPadLayerId === 1 ? layerId : 3 - layerId;
		const side = runtimeLayerId === 1 ? 'top' : 'bottom';
		const faceExpansionMil = localPadLayerId === 1 ? expansionSet.top : expansionSet.bottom;
		const angle = poses[poseIndex];
		const center = customCenters[poseIndex] ?? [120 + poseIndex * 180, 190 + poseIndex * 70];
		components.push({ getState_PrimitiveId: () => componentId });
		pcbRecords.push({ header: { type: 'COMPONENT', id: componentId, ticket: 1 }, data: { layerId, x: center[0], y: center[1], angle } });
		pcbRecords.push({ header: { type: 'ATTR', id: `fp-attr-${poseIndex}`, ticket: 1 }, data: { key: 'Footprint', parentId: componentId, value: footprintUuid } });
		footprintSources.push({ footprintUuid, documentSource: footprintSource(footprintUuid, expansionSet, localPadLayerId) });
		const radians = angle * Math.PI / 180;
		const projectedWidth = Math.abs(widthMil * Math.cos(radians)) + Math.abs(heightMil * Math.sin(radians));
		const projectedHeight = Math.abs(widthMil * Math.sin(radians)) + Math.abs(heightMil * Math.cos(radians));
		for (let padIndex = 0; padIndex < padNumbers.length; padIndex++) {
			const padNumber = padNumbers[padIndex];
			const padId = `runtime-${poseIndex}-${padNumber}`;
			const padCenter = [center[0] + padIndex * 70, center[1] - padIndex * 30];
			const calculatedBox = { minX: padCenter[0] - projectedWidth / 2, minY: padCenter[1] - projectedHeight / 2, maxX: padCenter[0] + projectedWidth / 2, maxY: padCenter[1] + projectedHeight / 2 };
			const box = customBoxes[poseIndex]?.[padIndex] ?? calculatedBox;
			padSnapshots.push({ id: padId, componentId, padNumber, layer: runtimeLayerId, rotation: angle, shape: 'RECT', box });
			const localId = `local-${padNumber}`;
			const netId = JSON.stringify(['PAD_NET', componentId, padNumber, localId]);
			pcbRecords.push({ header: { type: 'PAD_NET', id: netId, ticket: 1 }, data: { padNet: '', padLen: null, attrsMap: {} } });
			const apertureId = 10 + poseIndex * padNumbers.length + padIndex;
			const coreCorners = [[-widthMil / 2, -heightMil / 2], [widthMil / 2, -heightMil / 2], [widthMil / 2, heightMil / 2], [-widthMil / 2, heightMil / 2]].map(([x, y]) => [padCenter[0] + x * Math.cos(radians) - y * Math.sin(radians), padCenter[1] + x * Math.sin(radians) + y * Math.cos(radians)]);
			const p1 = coreCorners[0];
			const p2 = coreCorners[1];
			const aperture = `${apertureId}RoundRect,${mmText(mm(faceExpansionMil * 2))}X${mmText(mm(p1[0] - padCenter[0]))}X${mmText(mm(p1[1] - padCenter[1]))}X${mmText(mm(p2[0] - padCenter[0]))}X${mmText(mm(p2[1] - padCenter[1]))}`;
			apertures.push(`%ADD${aperture}*%`);
			flashStatements[side].push(`G54D${apertureId}*G01X${coordinate(padCenter[0])}Y${coordinate(padCenter[1])}D03*`);
		}
	}
	return { components, padSnapshots, pcbRecords, footprintSources, apertures, flashStatements };
}

function makeLayer(layer, apertures, statements) {
	const macro = '%AMRoundRect*1,1,$1,$2,$3*1,1,$1,$4,$5*1,1,$1,0-$2,0-$3*1,1,$1,0-$4,0-$5*20,1,$1,$2,$3,$4,$5,0*20,1,$1,$4,$5,0-$2,0-$3,0*20,1,$1,0-$2,0-$3,0-$4,0-$5,0*20,1,$1,0-$4,0-$5,$2,$3,0*4,1,4,$2,$3,$4,$5,0-$2,0-$3,0-$4,0-$5,$2,$3,0*%';
	return parseGerberLayerGeometry(layer, `Gerber_${layer}.G${layer}`, `%FSLAX45Y45*%\n%MOMM*%\n${macro}\n${apertures.join('\n')}\n${statements.join('\n')}\nM02*`);
}

const fixture = makeFixture();
const candidates = extractFootprintPadMaskCandidates({ ...fixture, projectLibrarySources: [], sourceStable: true });
assert.equal(candidates.available, true);
assert.equal(candidates.candidates.length, 10);
assert.equal(candidates.skipped.length, 0);
assert.ok(candidates.candidates.every(candidate => candidate.sourceIdentity.localPrimitiveId && candidate.sourcePad.radiusMil === 0));
assert.ok(candidates.candidates.every(candidate => candidate.runtimePad.centerMil[0] === (candidate.runtimePad.boxMil.minX + candidate.runtimePad.boxMil.maxX) / 2));
assert.ok(candidates.candidates.every(candidate => candidate.maskGeometry.expansionRadiusMil === expansionMil));
assert.ok(candidates.candidates.every(candidate => candidate.sourcePad.solderExpansionMil === 3));
assert.ok(candidates.candidates.every(candidate => candidate.sourcePad.localCopperLayerId === 1 && candidate.sourcePad.expansionMapping === 'local-layer1-follows-component-side'));
assert.ok(candidates.candidates.every(candidate => candidate.sourcePad.selectedExpansionField === 'topSolderExpansion'));
assert.deepEqual(candidates.modelAssumptions, []);
const topLayer = makeLayer('GTS', fixture.apertures, fixture.flashStatements.top);
const bottomLayer = makeLayer('GBS', fixture.apertures, fixture.flashStatements.bottom);
const syntheticMaskParticipation = { scope: 'test', available: true, complete: false, skipped: [], results: [] };

const asymmetricSource = { ...fixture, footprintSources: fixture.footprintSources.map((item, index) => index === 0 ? { ...item, documentSource: item.documentSource.replaceAll('"bottomSolderExpansion":7', '"bottomSolderExpansion":5') } : item) };
const asymmetric = extractFootprintPadMaskCandidates({ ...asymmetricSource, projectLibrarySources: [], sourceStable: true });
const asymmetricTop = asymmetric.candidates.find(candidate => candidate.componentId === 'component-0' && candidate.padNumber === '1');
assert.equal(asymmetricTop.sourcePad.sourceTopSolderExpansion, 3);
assert.equal(asymmetricTop.sourcePad.sourceBottomSolderExpansion, 5);
assert.equal(asymmetricTop.sourcePad.selectedExpansionField, 'topSolderExpansion', 'local copper layer 1 uses the source top expansion on either board side');

const b311Fixture = makeFixture(angles, [], [], { top: 3, bottom: 11 });
const b311Candidates = extractFootprintPadMaskCandidates({ ...b311Fixture, projectLibrarySources: [], sourceStable: true });
const b311TopLayer = makeLayer('GTS', b311Fixture.apertures, b311Fixture.flashStatements.top);
const b311BottomLayer = makeLayer('GBS', b311Fixture.apertures, b311Fixture.flashStatements.bottom);
const b311Associations = analyzePadMaskOpeningAssociations({ layers: [b311TopLayer, b311BottomLayer], padCandidates: b311Candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(b311Candidates.candidates.length, 10);
assert.ok(b311Associations.matches.every(match => match.association === 'geometry-correlated'));
assert.ok(b311Associations.matches.every(match => match.sourcePadModel.sourceTopSolderExpansion === 3 && match.sourcePadModel.sourceBottomSolderExpansion === 11 && match.sourcePadModel.selectedExpansionField === 'topSolderExpansion' && match.sourcePadModel.solderExpansionMil === 3));

for (const expansionSet of [{ top: 3, bottom: 7 }, { top: 3, bottom: 11 }]) {
	for (const layerId of [1, 2]) {
		const sameSideFixture = makeFixture(angles, [], [], expansionSet, angles.map(() => layerId));
		const sameSideCandidates = extractFootprintPadMaskCandidates({ ...sameSideFixture, projectLibrarySources: [], sourceStable: true });
		const side = layerId === 1 ? 'top' : 'bottom';
		const gerberLayer = makeLayer(layerId === 1 ? 'GTS' : 'GBS', sameSideFixture.apertures, sameSideFixture.flashStatements[side]);
		const sameSideAssociations = analyzePadMaskOpeningAssociations({ layers: [gerberLayer], padCandidates: sameSideCandidates, maskParticipation: syntheticMaskParticipation });
		assert.equal(sameSideCandidates.candidates.length, 10);
		assert.equal(sameSideAssociations.matches.length, 10);
		assert.ok(sameSideAssociations.matches.every(match => match.association === 'geometry-correlated' && match.side === side));
		assert.ok(sameSideAssociations.matches.every(match => match.sourcePadModel.sourceTopSolderExpansion === 3 && match.sourcePadModel.sourceBottomSolderExpansion === expansionSet.bottom && match.sourcePadModel.selectedExpansionField === 'topSolderExpansion' && match.sourcePadModel.solderExpansionMil === 3));
	}
}

for (const expansionSet of [{ top: 3, bottom: 7 }, { top: 3, bottom: 11 }]) {
	for (const componentLayerId of [1, 2]) {
		const local2Fixture = makeFixture(angles, [], [], expansionSet, angles.map(() => componentLayerId), 2);
		const local2Candidates = extractFootprintPadMaskCandidates({ ...local2Fixture, projectLibrarySources: [], sourceStable: true });
		const actualLayerId = 3 - componentLayerId;
		const side = actualLayerId === 1 ? 'top' : 'bottom';
		const gerberLayer = makeLayer(actualLayerId === 1 ? 'GTS' : 'GBS', local2Fixture.apertures, local2Fixture.flashStatements[side]);
		const associations = analyzePadMaskOpeningAssociations({ layers: [gerberLayer], padCandidates: local2Candidates, maskParticipation: syntheticMaskParticipation });
		assert.equal(local2Candidates.candidates.length, 10);
		assert.equal(local2Candidates.skipped.length, 0);
		assert.equal(associations.matches.length, 10);
		assert.ok(associations.matches.every(match => match.association === 'geometry-correlated' && match.side === side));
		assert.ok(associations.matches.every(match => match.sourcePadModel.localCopperLayerId === 2 && match.sourcePadModel.expansionMapping === 'local-layer2-opposite-component-side'));
		assert.ok(associations.matches.every(match => match.sourcePadModel.sourceTopSolderExpansion === 3 && match.sourcePadModel.sourceBottomSolderExpansion === expansionSet.bottom && match.sourcePadModel.selectedExpansionField === 'bottomSolderExpansion' && match.sourcePadModel.solderExpansionMil === expansionSet.bottom));
	}
}

const local2WrongRuntimeFixture = makeFixture(angles, [], [], { top: 3, bottom: 7 }, angles.map(() => 1), 2);
local2WrongRuntimeFixture.padSnapshots[0].layer = 1;
const local2WrongRuntime = extractFootprintPadMaskCandidates({ ...local2WrongRuntimeFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(local2WrongRuntime.candidates.length, 9);
assert.ok(local2WrongRuntime.skipped.some(item => item.componentId === 'component-0' && item.reason.includes('局部层及父器件层关系')));

const symmetricFixture = makeFixture(angles, [], [], { top: 2, bottom: 2 });
const symmetricCandidates = extractFootprintPadMaskCandidates({ ...symmetricFixture, projectLibrarySources: [], sourceStable: true });
const symmetricTopLayer = makeLayer('GTS', symmetricFixture.apertures, symmetricFixture.flashStatements.top);
const symmetricBottomLayer = makeLayer('GBS', symmetricFixture.apertures, symmetricFixture.flashStatements.bottom);
const symmetricAssociations = analyzePadMaskOpeningAssociations({ layers: [symmetricTopLayer, symmetricBottomLayer], padCandidates: symmetricCandidates, maskParticipation: syntheticMaskParticipation });
assert.equal(symmetricAssociations.matches.length, 10);
assert.ok(symmetricAssociations.matches.every(match => match.association === 'geometry-correlated' && match.sourcePadModel.solderExpansionMil === 2));
assert.deepEqual(symmetricAssociations.modelAssumptions, []);

for (const localLayerId of [12, undefined, 'invalid']) {
	const replacement = localLayerId === undefined ? '' : `"layerId":${JSON.stringify(localLayerId)},`;
	const invalidLayerFixture = { ...fixture, footprintSources: fixture.footprintSources.map(item => ({ ...item, documentSource: item.documentSource.replaceAll('"layerId":1,', replacement) })) };
	const invalidLayerCandidates = extractFootprintPadMaskCandidates({ ...invalidLayerFixture, projectLibrarySources: [], sourceStable: true });
	assert.equal(invalidLayerCandidates.candidates.length, 0, `local footprint PAD layer ${String(localLayerId)} is not extrapolated`);
	assert.equal(invalidLayerCandidates.skipped.length, 10);
	assert.ok(invalidLayerCandidates.skipped.every(item => item.reason.includes('local layer')));
	const publicInvalidLayer = analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: invalidLayerCandidates, maskParticipation: syntheticMaskParticipation });
	assert.equal(publicInvalidLayer.matches.length, 0);
	assert.equal(publicInvalidLayer.skipped.length, 10);
	assert.ok(publicInvalidLayer.skipped.every(item => item.reason.includes('local layer')));
}

assert.ok(topLayer.shapes.every(shape => Array.isArray(shape.flashCenterMil)), 'parser retains exact D03 center metadata');
const originalMaskParticipation = JSON.stringify(syntheticMaskParticipation);
const originalCandidates = JSON.stringify(candidates);
const originalLayers = JSON.stringify([topLayer, bottomLayer]);
const associations = analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(associations.available, true);
assert.equal(associations.matches.length, 10);
assert.ok(associations.matches.every(match => match.association === 'geometry-correlated'));
assert.ok(associations.matches.every(match => match.uniqueSourceAttribution === false));
assert.ok(associations.matches.every(match => match.maskReferences.length === 1));
assert.ok(associations.matches.every(match => match.sourcePadModel.sourceTopSolderExpansion === 3 && match.sourcePadModel.sourceBottomSolderExpansion === 7));
assert.deepEqual(associations.modelAssumptions, []);
assert.equal(JSON.stringify(candidates), originalCandidates, 'source candidate input is unchanged');
assert.equal(JSON.stringify([topLayer, bottomLayer]), originalLayers, 'parsed manufacturing layers are unchanged');
assert.equal(JSON.stringify(syntheticMaskParticipation), originalMaskParticipation, 'existing mask participation report is unchanged');

const bottomCandidate = candidates.candidates.find(candidate => candidate.layer === 'bottom' && candidate.padNumber === '2');
const necessaryReference = associations.matches.find(match => match.runtimePadId === bottomCandidate.runtimePad.id).maskReferences[0];
const witnessPoint = [...bottomCandidate.maskGeometry.centerMil];
const withWitness = { ...syntheticMaskParticipation, results: [{ conflictIndex: 0, areaIndex: 0, layer: 'bottom', manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: witnessPoint, mask: { necessaryContribution: true, necessaryContributorRefs: [necessaryReference] } } }] };
const witnessAssociation = analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: candidates, maskParticipation: withWitness });
const linked = witnessAssociation.matches.find(match => match.runtimePadId === bottomCandidate.runtimePad.id);
assert.equal(linked.witnessLinks.length, 1);
assert.equal(linked.witnessLinks[0].insideCandidateMask, true);
const outsideNecessaryReport = { ...syntheticMaskParticipation, results: [{ conflictIndex: 4, areaIndex: 0, layer: 'bottom', manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: [0, 0], mask: { necessaryContribution: true, necessaryContributorRefs: [necessaryReference] } } }] };
const outsideNecessaryAssociation = analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: candidates, maskParticipation: outsideNecessaryReport });
const outsideNecessaryPad = outsideNecessaryAssociation.matches.find(match => match.runtimePadId === bottomCandidate.runtimePad.id);
assert.deepEqual(outsideNecessaryPad.necessaryMaskReferences, [], 'necessary ref is not linked when its witness is outside candidate mask geometry');
assert.deepEqual(outsideNecessaryPad.witnessLinks, [], 'outside witness produces no linked witness record');

const wrongCenterLayer = { ...topLayer, shapes: topLayer.shapes.map((shape, index) => index === 0 ? { ...shape, flashCenterMil: [0, 0] } : shape) };
const wrongCenter = analyzePadMaskOpeningAssociations({ layers: [wrongCenterLayer, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(wrongCenter.matches.find(match => match.side === 'top' && match.padNumber === '1').association, 'not-matched');

const wrongRadiusLayer = { ...topLayer, apertures: topLayer.apertures.map(aperture => aperture.id === 10 ? { ...aperture, parameters: [0.2032, ...aperture.parameters.slice(1)] } : aperture) };
const wrongRadius = analyzePadMaskOpeningAssociations({ layers: [wrongRadiusLayer, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(wrongRadius.matches.find(match => match.side === 'top' && match.padNumber === '1').association, 'not-matched');

const overHalfQuantumCenterLayer = { ...topLayer, shapes: topLayer.shapes.map((shape, index) => index === 0 ? { ...shape, flashCenterMil: [shape.flashCenterMil[0] + 0.0002, shape.flashCenterMil[1]] } : shape) };
const overHalfQuantumCenter = analyzePadMaskOpeningAssociations({ layers: [overHalfQuantumCenterLayer, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(overHalfQuantumCenter.matches.find(match => match.side === 'top' && match.padNumber === '1').association, 'not-matched', 'one-axis coordinate error beyond half FS45 quantum is rejected');

const overHalfQuantumCornerLayer = { ...topLayer, apertures: topLayer.apertures.map(aperture => aperture.id === 10 ? { ...aperture, parameters: [aperture.parameters[0], aperture.parameters[1] + 0.00001, ...aperture.parameters.slice(2)] } : aperture) };
const overHalfQuantumCorner = analyzePadMaskOpeningAssociations({ layers: [overHalfQuantumCornerLayer, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(overHalfQuantumCorner.matches.find(match => match.side === 'top' && match.padNumber === '1').association, 'not-matched', 'a core-corner component beyond half FS45 quantum is rejected');

const snapshotsChanged = { ...fixture, padSnapshots: fixture.padSnapshots.map((snapshot, index) => index === 0 ? { ...snapshot, rotation: snapshot.rotation + 1 } : snapshot) };
const changedPose = extractFootprintPadMaskCandidates({ ...snapshotsChanged, projectLibrarySources: [], sourceStable: true });
assert.equal(changedPose.candidates.length, 9, 'runtime rotation is validated against projected bbox');

const duplicateRuntimeIdFixture = { ...fixture, padSnapshots: fixture.padSnapshots.map((snapshot, index) => index === 1 ? { ...snapshot, id: fixture.padSnapshots[0].id } : snapshot) };
const duplicateRuntimeId = extractFootprintPadMaskCandidates({ ...duplicateRuntimeIdFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(duplicateRuntimeId.candidates.length, 8, 'duplicate runtime pad IDs do not create source associations');

const realScaleFixture = makeFixture([90], [[890, 210.34]]);
const realScaleCandidates = extractFootprintPadMaskCandidates({ ...realScaleFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(realScaleCandidates.candidates.length, 2);
assert.ok(Math.abs(realScaleCandidates.candidates[0].runtimePad.centerMil[0] - 890) < 1e-12);
assert.ok(Math.abs(realScaleCandidates.candidates[0].runtimePad.centerMil[1] - 210.34) < 1e-12);
const realCenter = realScaleCandidates.candidates[0].runtimePad.centerMil;
assert.ok(Math.abs(realScaleCandidates.candidates[0].copperGeometry.cornerPointsMil[0][0] - (realCenter[0] + heightMil / 2)) < 1e-9);
assert.ok(Math.abs(realScaleCandidates.candidates[0].copperGeometry.cornerPointsMil[0][1] - (realCenter[1] - widthMil / 2)) < 1e-9, 'rotated RECT corners use precise bbox center and SDK rotation');
const real37Center = [(750.3980628184714 + 802.226878725523) / 2, (656.0128592583756 + 708.287473568245) / 2];
const real37CoreBox = { minX: 753.3980628184714, maxX: 799.226878725523, minY: 659.0128592583756, maxY: 705.287473568245 };
const real37Fixture = makeFixture([37], [real37Center], [[real37CoreBox]]);
const real37Candidates = extractFootprintPadMaskCandidates({ ...real37Fixture, projectLibrarySources: [], sourceStable: true });
const real37Pad = real37Candidates.candidates.find(candidate => candidate.padNumber === '1');
assert.ok(real37Pad);
for (const [actual, expected] of Object.entries({ minX: 750.3980628184714, maxX: 802.226878725523, minY: 656.0128592583756, maxY: 708.287473568245 }))
	assert.ok(Math.abs(real37Pad.maskGeometry.outerBoundsMil[actual] - expected) < 1e-6, `37 degree rounded mask bound ${actual}`);
const real37Layer = makeLayer('GBS', real37Fixture.apertures, real37Fixture.flashStatements.bottom);
const real37Association = analyzePadMaskOpeningAssociations({ layers: [real37Layer], padCandidates: real37Candidates, maskParticipation: syntheticMaskParticipation });
assert.ok(real37Association.matches.every(match => match.association === 'geometry-correlated'), '37 degree FS45 macro is matched with per-axis half-quantum checks');

const largeWorldFixture = makeFixture([37], [[100000, -200000]]);
const largeWorldCandidates = extractFootprintPadMaskCandidates({ ...largeWorldFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(largeWorldCandidates.candidates.length, 2, 'large world coordinates allow only arithmetic rounding from bbox endpoint subtraction');

const excessiveExtentFixture = { ...realScaleFixture, padSnapshots: realScaleFixture.padSnapshots.map((snapshot, index) => index === 0 ? { ...snapshot, box: { ...snapshot.box, maxX: snapshot.box.maxX + 1e-7 } } : snapshot) };
const excessiveExtent = extractFootprintPadMaskCandidates({ ...excessiveExtentFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(excessiveExtent.candidates.length, 1, 'a real 1e-7mil dimension mismatch exceeds the derived floating point bound');
assert.ok(excessiveExtent.skipped.some(item => item.padNumber === '1' && item.reason.includes('投影尺寸')));

const wrongMaskSide = analyzePadMaskOpeningAssociations({ layers: [topLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(wrongMaskSide.matches.find(match => match.side === 'bottom').association, 'geometry-match-uncertain');

const duplicateLayer = makeLayer('GBS', fixture.apertures, [...fixture.flashStatements.bottom, fixture.flashStatements.bottom[0]]);
const duplicate = analyzePadMaskOpeningAssociations({ layers: [topLayer, duplicateLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(duplicate.matches.find(match => match.side === 'bottom' && match.padNumber === '1').association, 'ambiguous');
assert.equal(duplicate.matches.find(match => match.side === 'bottom' && match.padNumber === '2').association, 'geometry-correlated');
const ambiguousPad = duplicate.matches.find(match => match.side === 'bottom' && match.padNumber === '1');
const ambiguousNecessaryReport = { ...syntheticMaskParticipation, results: [{ conflictIndex: 3, areaIndex: 0, layer: 'bottom', manufacturingContribution: 'verified-at-witnesses', witness: { pointMil: [...bottomCandidate.maskGeometry.centerMil], mask: { necessaryContribution: true, necessaryContributorRefs: [ambiguousPad.maskReferences[0]] } } }] };
const ambiguousNecessaryAssociation = analyzePadMaskOpeningAssociations({ layers: [topLayer, duplicateLayer], padCandidates: candidates, maskParticipation: ambiguousNecessaryReport });
const ambiguousNecessaryPad = ambiguousNecessaryAssociation.matches.find(match => match.side === 'bottom' && match.padNumber === '1');
assert.equal(ambiguousNecessaryPad.maskReferences.length, 2);
assert.deepEqual(ambiguousNecessaryPad.necessaryMaskReferences, [], 'ambiguous geometry cannot claim one necessary reference');
assert.deepEqual(ambiguousNecessaryPad.witnessLinks, [], 'ambiguous geometry cannot produce a unique witness link');

const unstable = extractFootprintPadMaskCandidates({ ...fixture, projectLibrarySources: [], sourceStable: false });
assert.equal(unstable.available, false);
assert.equal(unstable.candidates.length, 0);

const changedSource = { ...fixture, footprintSources: fixture.footprintSources.map(item => ({ ...item, documentSource: item.documentSource.replace('"width":31.751', '"width":1250.03937007874') })) };
const changed = extractFootprintPadMaskCandidates({ ...changedSource, projectLibrarySources: [], sourceStable: true });
assert.equal(changed.candidates.length, 5, 'changed effective source no longer passes runtime bbox projection for the changed source PAD');
assert.equal(changed.skipped.length, 5);
const propagatedSkipped = analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: changed, maskParticipation: syntheticMaskParticipation });
assert.deepEqual(propagatedSkipped.skipped, changed.skipped, 'public association report retains extraction skips');
const unavailableWithSkipped = analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: { ...changed, available: false, unavailableReason: 'test unavailable' }, maskParticipation: syntheticMaskParticipation });
assert.deepEqual(unavailableWithSkipped.skipped, changed.skipped, 'unavailable association report retains extraction skips');

const covered = { ...fixture, footprintSources: fixture.footprintSources.map(item => ({ ...item, documentSource: item.documentSource.replace('"specialPad":[]', '"specialPad":[{}]') })) };
const overridden = extractFootprintPadMaskCandidates({ ...covered, projectLibrarySources: [], sourceStable: true });
assert.equal(overridden.candidates.length, 5, 'special PAD geometry is unsupported while unaffected source PADs remain available');

const withDuplicateNumber = { ...fixture, footprintSources: fixture.footprintSources.map(item => ({ ...item, documentSource: item.documentSource.replace('"num":"2"', '"num":"1"') })) };
const duplicatedNumber = extractFootprintPadMaskCandidates({ ...withDuplicateNumber, projectLibrarySources: [], sourceStable: true });
assert.equal(duplicatedNumber.candidates.length, 0, 'duplicate source pad numbers are not chosen arbitrarily');

const padNetGeometryCorrectionFixture = { ...fixture, pcbRecords: fixture.pcbRecords.map((record, index) => index === 2 ? { ...record, data: { ...record.data, padLen: 1 } } : record) };
const padNetGeometryCorrection = extractFootprintPadMaskCandidates({ ...padNetGeometryCorrectionFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(padNetGeometryCorrection.candidates.length, 9, 'non-null PAD_NET.padLen cannot be ignored as an instance geometry override');

const shadowedRuntimePadId = fixture.padSnapshots[0].id;
const independentPadShadowFixture = { ...fixture, pcbRecords: [...fixture.pcbRecords, { header: { type: 'PAD', id: shadowedRuntimePadId, ticket: 1 }, data: { layerId: 1 } }] };
const independentPadShadow = extractFootprintPadMaskCandidates({ ...independentPadShadowFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(independentPadShadow.candidates.length, 9);
assert.ok(independentPadShadow.skipped.some(item => item.reason.includes('effective PCB PAD记录覆盖')));

const deletedHistoricalPadFixture = { ...fixture, pcbRecords: [...fixture.pcbRecords, { header: { type: 'PAD', id: shadowedRuntimePadId, ticket: 1 }, data: { layerId: 1 } }, { header: { type: 'PAD', id: shadowedRuntimePadId, ticket: 2 }, data: '' }] };
const deletedHistoricalPad = extractFootprintPadMaskCandidates({ ...deletedHistoricalPadFixture, projectLibrarySources: [], sourceStable: true });
assert.equal(deletedHistoricalPad.candidates.length, 10, 'a deleted historical PAD record is not treated as an active override');

assert.throws(() => extractFootprintPadMaskCandidates({ ...fixture, projectLibrarySources: [], sourceStable: true, checkBudget: () => { throw new Error('budget stopped'); } }), /budget stopped/u);
assert.throws(() => analyzePadMaskOpeningAssociations({ layers: [topLayer, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation, checkBudget: () => { throw new Error('budget stopped'); } }), /budget stopped/u);

const unrecognizedFormat = { ...topLayer, format: { ...topLayer.format, coordinateFormat: 'unknown' } };
const unknown = analyzePadMaskOpeningAssociations({ layers: [unrecognizedFormat, bottomLayer], padCandidates: candidates, maskParticipation: syntheticMaskParticipation });
assert.equal(unknown.matches.find(match => match.side === 'top').association, 'geometry-match-uncertain');
assert.equal(unknown.matches.find(match => match.side === 'top').sourcePadModel.selectedExpansionField, 'topSolderExpansion', 'uncertain matches preserve the source expansion provenance');

console.log('ok silkscreen pad mask opening associations');
