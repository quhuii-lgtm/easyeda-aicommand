import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({
	stdin: { contents: "export { padBranchCommands } from '../src/commands/padBranches.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'pad-branches-oval-arc-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
});
const { padBranchCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const command = padBranchCommands.find(item => item.name === 'pcb.routePadBranches');
assert.ok(command?.handler);
assert.match(command.summary, /普通无孔外层OVAL/);
assert.match(command.summary, /LINE\/ARC主干.*真实端点/);
assert.match(command.params.find(item => item.name === 'positive').description, /LINE或ARC.*真实端点/);
assert.match(command.params.find(item => item.name === 'negative').description, /LINE或ARC.*真实端点/);
assert.match(command.returns, /普通无孔外层OVAL接触按精确源码几何计算/);
assert.match(command.returns, /arcContactResolution/);
assert.match(command.returns, /旧补长功能范围未扩大/);

const uuid = 'b5-oval-arc-command';
const row = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
const head = row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid, client: 'offline-fixture', version: '1' });
function pad(id, net, center, shape, rotation = 0, extra = {}) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_X: () => center[0],
		getState_Y: () => center[1],
		getState_Layer: () => 1,
		getState_Pad: () => shape,
		getState_Hole: () => extra.hole ?? null,
		getState_HoleOffsetX: () => extra.holeOffsetX ?? 0,
		getState_HoleOffsetY: () => extra.holeOffsetY ?? 0,
		getState_Metallization: () => null,
		getState_SpecialPad: () => extra.special ?? null,
		getState_Rotation: () => rotation,
	};
}
function makeFixture(options = {}) {
	let source = head;
	let ticket = 1;
	let nextLine = 0;
	const writes = [];
	const pSourceShape = options.pSourceShape ?? ['OVAL', 80.1, 40.5, 0];
	const pSourceCenter = options.pSourceCenter ?? [50, 100];
	const pSource = pad('p-source-oval', 'P', pSourceCenter, pSourceShape, 0, options.pSourceExtra);
	const componentOval = pad(options.componentPadId ?? 'p-component-oval', 'P', options.componentCenter ?? [50, 140], ['OVAL', 44.1, 20.5, 0], 90, {
		...(options.componentSpecial ? { special: [[1, 1, ['OVAL', 44.1, 20.5, 0]]] } : {}),
		...(options.componentHole ? { hole: ['ROUND', 5] } : {}),
	});
	const nCircle = pad('n-circle', 'N', [50, 300], ['ELLIPSE', 12, 12, 0]);
	const pads = [pSource, componentOval, nCircle];
	const component = { id: 'component-oval', pins: [componentOval] };
	const arcJoinY = options.arcJoinY ?? 100;
	const reversed = options.arcEndpoint === 'end';
	const arcData = options.arcData ?? (reversed
		? { arcType: 'DOT', netName: 'P', layerId: 1, startX: 350, startY: arcJoinY - 50, endX: 300, endY: arcJoinY, angle: 90, width: 6 }
		: { arcType: 'DOT', netName: 'P', layerId: 1, startX: 300, startY: arcJoinY, endX: 350, endY: arcJoinY - 50, angle: -90, width: 6 });
	const oldLine = { netName: 'P', layerId: 1, startX: 700, startY: 700, endX: 720, endY: 700, width: 4, locked: true };
	const viaData = { netName: 'N', layerId: 1, x: 760, y: 760, diameter: 18, holeDiameter: 8, viaType: 0, locked: true };
	const originalRows = [
		row('PAD', 'p-source-oval', ++ticket, { layerId: 1, centerX: pSourceCenter[0], centerY: pSourceCenter[1], padAngle: 0, netName: 'P', defaultPad: { padType: 'OVAL', width: 80.125, height: 40.45 }, hole: null, plated: false, specialPad: [], padOffsetX: 0, padOffsetY: 0 }),
		row('PAD', 'n-circle', ++ticket, { layerId: 1, centerX: 50, centerY: 300, padAngle: 0, netName: 'N', defaultPad: { padType: 'ELLIPSE', width: 12, height: 12 }, hole: null, plated: false }),
		row('LINE', 'keep-line', ++ticket, oldLine),
		row('VIA', 'keep-via', ++ticket, viaData),
		row('ARC', 'arc-trunk', ++ticket, arcData),
	];
	for (const record of originalRows) source += `\n${record}`;
	const baseline = source;
	const lines = new Map([['keep-line', oldLine]]);
	const mkLine = (id, data) => ({
		getState_PrimitiveId: () => id, getState_Net: () => data.netName, getState_Layer: () => data.layerId,
		getState_StartX: () => data.startX, getState_StartY: () => data.startY, getState_EndX: () => data.endX,
		getState_EndY: () => data.endY, getState_LineWidth: () => data.width,
	});
	const arcGetter = {
		getState_PrimitiveId: () => 'arc-trunk', getState_PrimitiveType: () => 'Arc', getState_Net: () => 'P', getState_Layer: () => 1,
		getState_LineWidth: () => arcData.width, getState_StartX: () => arcData.startX, getState_StartY: () => arcData.startY,
		getState_EndX: () => arcData.endX, getState_EndY: () => arcData.endY, getState_ArcAngle: () => arcData.angle + (options.arcAngleDelta ?? 0),
	};
	const arcCounter = { getAll: 0, get: 0 };
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid }) },
		pcb_Net: { getAllNetsName: async () => ['P', 'N'] },
		pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL', layerStatus: 1, status: 1 }] },
		pcb_Drc: { getCurrentRuleConfiguration: async () => ({ clearance: 8, width: 6 }) },
		sys_FileManager: { getDocumentSource: async () => source },
		sys_Environment: { getEditorCurrentVersion: () => options.editorVersion ?? '4.1.78' },
		pcb_PrimitivePad: { getAll: async () => pads },
		pcb_PrimitiveComponent: { getAll: async () => [{ getState_PrimitiveId: () => component.id, getAllPins: async () => component.pins }] },
		pcb_PrimitiveVia: { getAll: async () => [{ getState_PrimitiveId: () => 'keep-via', getState_Net: () => 'N', getState_X: () => 760, getState_Y: () => 760, getState_Diameter: () => 18, getState_HoleDiameter: () => 8, getState_ViaType: () => 0 }] },
		pcb_PrimitiveArc: { getAll: async () => { arcCounter.getAll++; return [arcGetter]; }, get: async id => { arcCounter.get++; return id === 'arc-trunk' ? arcGetter : undefined; } },
		pcb_PrimitiveFill: { getAll: async () => [] }, pcb_PrimitivePour: { getAll: async () => [] },
		pcb_PrimitivePolyline: { getAll: async () => [] }, pcb_PrimitivePoured: { getAll: async () => [] },
		pcb_PrimitiveLine: {
			getAllPrimitiveId: async () => [...lines.keys()], get: async id => lines.has(id) ? mkLine(id, lines.get(id)) : undefined,
			create: async (netName, layerId, startX, startY, endX, endY, width) => {
				const data = { netName, layerId, startX, startY, endX, endY, width, locked: false };
				writes.push(data);
				const id = `new-line-${++nextLine}`;
				lines.set(id, data);
				source += `\n${row('LINE', id, ++ticket, data)}`;
				return mkLine(id, data);
			},
		},
	};
	return { pads, pSource, componentOval, writes, arcCounter, baseline, readSource: () => source };
}

function params({ dryRun = true, target = 'p-source-oval', joinX = 300, joinY = 100, arcEndpoint = 'start', trunk = true } = {}) {
	return {
		pair: { positiveNet: 'P', negativeNet: 'N' },
		positive: { joinPoint: [joinX, joinY], branches: [{ padId: target }], ...(trunk ? { trunk: { primitiveId: 'arc-trunk', endpoint: arcEndpoint } } : {}) },
		negative: { joinPoint: [300, 300], branches: [{ padId: 'n-circle' }] },
		layer: 'top', width: 6, clearanceMil: 8, dryRun,
	};
}
async function invoke(args) {
	try { return await command.handler(args); }
	catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
}

async function verifyWriteAndPreservation({ target = 'p-source-oval', joinY = 100, arcEndpoint = 'start' } = {}) {
	const fixture = makeFixture({ arcEndpoint, arcJoinY: joinY });
	const result = await invoke(params({ dryRun: false, target, joinY, arcEndpoint }));
	assert.equal(result.readbackVerified, true);
	assert.equal(result.sourceCoverage.verified, true);
	assert.equal(result.originalNonLineRecordsPreserved, true);
	assert.equal(result.arcContactResolution.find(item => item.id === 'arc-trunk').status, 'verified');
	assert.equal(fixture.arcCounter.getAll, 1, 'ARC object enumeration is performed once');
	assert.equal(fixture.arcCounter.get, 1, 'one ARC is read back once by ID');
	assert.ok(fixture.writes.length > 0);
	const before = fixture.baseline.split('\n').slice(1);
	const after = fixture.readSource().split('\n').slice(1).filter(line => !line.includes('new-line-'));
	assert.deepEqual(after, before, 'original PAD/LINE/VIA/ARC source records remain byte-identical');
	assert.equal(result.arcContactResolution[0].sdkEndpointMode, 'within-0.001');
	assert.ok(result.positive.additionalSameNetContacts.some(item => item.objectId === 'arc-trunk'), 'same-net trunk ARC contact is reported explicitly');
	return { fixture, result };
}

for (const dryRun of [true, false]) {
	const fixture = makeFixture({
		pSourceCenter: [-30, 0],
		componentPadId: 'arc-trunk',
		componentCenter: [0, 1000],
		arcData: { arcType: 'DOT', netName: 'P', layerId: 1, startX: -2, startY: 0, endX: 2, endY: 0, angle: 180, width: 1 },
	});
	await assert.rejects(invoke(params({ dryRun, joinX: 30, joinY: 0, trunk: false })), /PAD arc-trunk 与其他导电对象存在源码ID冲突/);
	assert.equal(fixture.writes.length, 0, `${dryRun ? 'dryRun' : 'write'} mode rejects non-target non-trunk PAD/ARC ID collision before any write`);
}

{
	const fixture = makeFixture();
	const result = await invoke(params({ dryRun: true }));
	assert.equal(result.created, false);
	assert.equal(fixture.writes.length, 0, 'dryRun is write-free');
	assert.equal(result.arcContactResolution[0].status, 'verified');
	assert.equal(result.arcContactResolution[0].sourceGeometry, 'effective-ARC-source-exact');
	assert.equal(fixture.arcCounter.getAll, 1);
	assert.equal(fixture.arcCounter.get, 1);
	const ovalProjection = result.independentPadProjectionReports.find(item => item.padId === 'p-source-oval').ovalShapeProjection;
	assert.equal(ovalProjection.status, 'sdk-0.1-projection');
	assert.deepEqual(ovalProjection.sourceDimensions, [80.125, 40.45]);
	assert.deepEqual(ovalProjection.getterDimensions, [80.1, 40.5]);
	assert.equal(ovalProjection.sourceGeometryUsedForPlanning, true);
	assert.match(result.geometrySource, /fresh getter尺寸须精确匹配/);
	assert.match(result.geometrySource, /4\.1\.78版本按0\.1尺寸投影并披露delta/);
	assert.match(result.contactVerificationScope, /有限弧几何及唯一源码\/getter读回/);
}

await verifyWriteAndPreservation({ arcEndpoint: 'start' });
await verifyWriteAndPreservation({ arcEndpoint: 'end' });

{
	const fixture = makeFixture({ arcJoinY: 140 });
	const result = await invoke(params({ dryRun: true, target: 'p-component-oval', joinY: 140 }));
	assert.equal(result.padAnchorResolution[0].source, 'component-getAllPins-SDK-global-anchor');
	assert.equal(result.created, false);
	assert.equal(fixture.writes.length, 0);
}

for (const options of [{ componentSpecial: true }, { componentHole: true }]) {
	const fixture = makeFixture({ ...options, arcJoinY: 140 });
	await assert.rejects(invoke(params({ dryRun: false, target: 'p-component-oval', joinY: 140 })), /外形无法确认/);
	assert.equal(fixture.writes.length, 0, 'special or holed OVAL remains rejected before writes');
}

{
	const fixture = makeFixture({ pSourceShape: ['OVAL', 80.2, 40.5, 0] });
	await assert.rejects(invoke(params({ dryRun: false })), /getter几何无法证明/);
	assert.equal(fixture.writes.length, 0, 'non-matching OVAL dimension getter must fail closed');
}

{
	const fixture = makeFixture({ editorVersion: '4.1.79' });
	await assert.rejects(invoke(params({ dryRun: false })), /getter几何无法证明/);
	assert.equal(fixture.writes.length, 0, '0.1 OVAL dimension projection is limited to the verified editor version');
}

{
	const fixture = makeFixture({ editorVersion: '4.1.79', pSourceShape: ['OVAL', 80.125, 40.45, 0] });
	const result = await invoke(params({ dryRun: true }));
	assert.equal(result.independentPadProjectionReports.find(item => item.padId === 'p-source-oval').ovalShapeProjection.status, 'exact');
	assert.equal(fixture.writes.length, 0);
}

{
	const fixture = makeFixture({ arcAngleDelta: 180 });
	await assert.rejects(invoke(params({ dryRun: false })), /未通过唯一来源和fresh getter几何验证/);
	assert.equal(fixture.writes.length, 0, 'ARC source/getter signed sweep conflict must be rejected before writes');
	assert.equal(fixture.arcCounter.getAll, 1, 'failed ARC verification must not enumerate ARC objects again');
	assert.equal(fixture.arcCounter.get, 1);
}

{
	const fixture = makeFixture();
	await assert.rejects(invoke(params({ dryRun: false, trunk: true, joinY: 105 })), /端点不在汇合点/);
	assert.equal(fixture.writes.length, 0, 'trunk join must equal the selected actual arc endpoint');
}

// A rejected input does not poison a later legal handler execution.
const legalAfterReject = await verifyWriteAndPreservation({ arcEndpoint: 'start' });
assert.equal(legalAfterReject.result.created, true);

console.log('pad-branches-oval-arc-command-regression: PASS');
