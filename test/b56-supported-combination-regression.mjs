import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({
	stdin: { contents: "export { padBranchCommands } from '../src/commands/padBranches.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'b56-supported-combination-entry.ts' },
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
});
const { padBranchCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const command = padBranchCommands.find(item => item.name === 'pcb.routePadBranches');
assert.ok(command?.handler);

const uuid = 'b56-supported-combination';
const row = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
const head = row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid, client: 'offline-fixture', version: '1' });
function pad(id, net, x, y, shape = ['ELLIPSE', 12, 12, 0]) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_X: () => x,
		getState_Y: () => y,
		getState_Layer: () => 1,
		getState_Pad: () => shape,
		getState_Hole: () => null,
		getState_Metallization: () => null,
		getState_SpecialPad: () => null,
		getState_Rotation: () => 0,
	};
}
const pads = [
	pad('p-circle', 'P', 100, 100),
	pad('p-rect', 'P', 100, 140, ['RECT', 20, 12, 0]),
	pad('n-circle', 'N', 100, 300),
	pad('n-rect', 'N', 100, 340, ['RECT', 16, 24, 0]),
];
const component = { id: 'component-P', pins: [pads[0]] };
const initialLines = new Map([['keep-line', { netName: 'P', layerId: 1, startX: 700, startY: 700, endX: 720, endY: 700, width: 4, locked: true }]]);
const otherSourceRows = [
	row('LINE', 'keep-line', 1, initialLines.get('keep-line')),
	row('VIA', 'keep-via', 2, { netName: 'N', layerId: 1, x: 760, y: 760, diameter: 18, holeDiameter: 8, viaType: 0, locked: true }),
	row('ARC', 'keep-arc', 3, { netName: 'N', layerId: 1, startX: 800, startY: 800, endX: 820, endY: 800, angle: 90, width: 4, locked: true }),
];

function makeFixture({ unsupportedOval = false } = {}) {
	let source = head;
	let ticket = 10;
	let nextLine = 0;
	const lines = new Map(initialLines);
	const writes = [];
	const selectedPads = unsupportedOval ? [...pads.slice(0, 3), pad('n-oval', 'N', 100, 340, ['OVAL', 16, 24, 0])] : pads;
	if (unsupportedOval)
		selectedPads[3].getState_SpecialPad = () => [[1, 1, ['OVAL', 16, 24, 0]]];
	const components = unsupportedOval ? [component, { id: 'component-N', pins: [selectedPads[3]] }] : [component];
	for (const item of selectedPads) {
		const id = item.getState_PrimitiveId();
		if (components.some(c => c.pins.some(pin => pin.getState_PrimitiveId() === id))) continue;
		const shape = item.getState_Pad();
		const defaultPad = { padType: shape[0], width: shape[1], height: shape[2], ...(shape[0] === 'RECT' ? { radius: shape[3] ?? 0 } : {}) };
		source += `\n${row('PAD', id, ++ticket, { layerId: 1, centerX: item.getState_X(), centerY: item.getState_Y(), padAngle: 0, netName: item.getState_Net(), defaultPad, hole: null, plated: false })}`;
	}
	for (const existing of otherSourceRows) source += `\n${existing}`;
	const baselineSource = source;
	const mkLine = (id, data) => ({
		getState_PrimitiveId: () => id,
		getState_Net: () => data.netName,
		getState_Layer: () => data.layerId,
		getState_StartX: () => data.startX,
		getState_StartY: () => data.startY,
		getState_EndX: () => data.endX,
		getState_EndY: () => data.endY,
		getState_LineWidth: () => data.width,
	});
	const arc = {
		getState_PrimitiveId: () => 'keep-arc', getState_Net: () => 'N', getState_Layer: () => 1,
		getState_StartX: () => 800, getState_StartY: () => 800, getState_EndX: () => 820, getState_EndY: () => 800,
		getState_ArcAngle: () => 90, getState_LineWidth: () => 4,
	};
	const via = {
		getState_PrimitiveId: () => 'keep-via', getState_Net: () => 'N', getState_X: () => 760, getState_Y: () => 760,
		getState_Diameter: () => 18, getState_HoleDiameter: () => 8, getState_ViaType: () => 0,
	};
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid }) },
		pcb_Net: { getAllNetsName: async () => ['P', 'N'] },
		pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL', layerStatus: 1, status: 1 }] },
		pcb_Drc: { getCurrentRuleConfiguration: async () => ({ clearance: 8, width: 6 }) },
		sys_FileManager: { getDocumentSource: async () => source },
		sys_Environment: { getEditorCurrentVersion: () => '4.1.78' },
		pcb_PrimitivePad: { getAll: async () => selectedPads },
		pcb_PrimitiveComponent: { getAll: async () => components.map(c => ({ getState_PrimitiveId: () => c.id, getAllPins: async () => c.pins })) },
		pcb_PrimitiveVia: { getAll: async () => [via] },
		pcb_PrimitiveArc: { getAll: async () => [arc] },
		pcb_PrimitiveFill: { getAll: async () => [] },
		pcb_PrimitivePour: { getAll: async () => [] },
		pcb_PrimitivePolyline: { getAll: async () => [] },
		pcb_PrimitivePoured: { getAll: async () => [] },
		pcb_PrimitiveLine: {
			getAllPrimitiveId: async () => [...lines.keys()],
			get: async id => lines.has(id) ? mkLine(id, lines.get(id)) : undefined,
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
	return { selectedPads, writes, lines, baselineSource, readSource: () => source };
}

function params(dryRun = true, padIds = ['p-circle', 'p-rect', 'n-circle', 'n-rect']) {
	return {
		pair: { positiveNet: 'P', negativeNet: 'N' },
		positive: { joinPoint: [200, 120], branches: [{ padId: padIds[0] }, { padId: padIds[1] }] },
		negative: { joinPoint: [200, 320], branches: [{ padId: padIds[2] }, { padId: padIds[3] }] },
		layer: 'top', width: 6, clearanceMil: 8, dryRun,
	};
}

{
	const fixture = makeFixture();
	let result;
	try { result = await command.handler(params(true)); }
	catch (error) { console.error('B56 dryRun diagnostic:', error?.message); process.exit(1); }
	assert.equal(result.dryRun, true);
	assert.equal(result.created, false);
	assert.equal(fixture.writes.length, 0, 'dryRun must not write any route segments');
	assert.equal(result.padAnchorResolution.find(x => x.padId === 'p-circle').source, 'component-getAllPins-SDK-global-anchor', 'duplicate component/PAD identity must resolve through component SDK pin');
	assert.equal(result.padAnchorResolution.find(x => x.padId === 'p-rect').source, 'effective-PAD-source-exact');
	assert.equal(result.padAnchorResolution.find(x => x.padId === 'n-rect').source, 'effective-PAD-source-exact');
}

{
	const fixture = makeFixture();
	const result = await command.handler(params(false));
	assert.equal(result.readbackVerified, true);
	assert.equal(result.originalNonLineRecordsPreserved, true);
	assert.equal(result.originalLineGeometryAndAttributesPreserved, true);
	assert.ok(fixture.writes.length > 0);
	assert.equal(fixture.lines.get('keep-line').startX, 700);
	assert.equal(fixture.lines.get('keep-line').startY, 700);
	const finalRows = fixture.readSource().split('\n').slice(1);
	const beforeRows = fixture.baselineSource.split('\n').slice(1);
	const finalNonNew = finalRows.filter(line => !line.includes('new-line-'));
	assert.deepEqual(finalNonNew, beforeRows, 'original PAD, LINE, VIA and ARC source rows must remain byte-identical');
	assert.ok(finalRows.some(line => line.includes('"VIA","id":"keep-via"')));
	assert.ok(finalRows.some(line => line.includes('"ARC","id":"keep-arc"')));
	assert.equal(result.sourceCoverage.verified, true, 'handler SES line plan must be covered by actual source readback');
	assert.equal(result.sourceCoverage.differences.length, 0);
	assert.equal(result.writerReportedIds.length, fixture.writes.length);
	const expectedWrites = [...result.positive.uniqueSegments, ...result.negative.uniqueSegments].map(segment => ({ netName: segment.net, layerId: segment.layer, startX: segment.a[0], startY: segment.a[1], endX: segment.b[0], endY: segment.b[1], width: segment.width, locked: false }));
	assert.deepEqual(fixture.writes, expectedWrites, 'actual mock writer arguments must match the planned PAD branch geometry exactly');
	for (const write of fixture.writes) {
		assert.equal(write.layerId, 1);
		assert.equal(write.width, 6);
		assert.ok(Number.isFinite(write.startX) && Number.isFinite(write.startY) && Number.isFinite(write.endX) && Number.isFinite(write.endY));
	}
}

{
	const fixture = makeFixture({ unsupportedOval: true });
	await assert.rejects(command.handler(params(false, ['p-circle', 'p-rect', 'n-circle', 'n-oval'])), /外形无法确认/);
	assert.equal(fixture.writes.length, 0, 'unsupported OVAL target must be rejected before the first write');
}

console.log('b56-supported-combination-regression: PASS');
