import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: { contents: 'export { padBranchCommands } from \'../src/commands/padBranches.ts\'', resolveDir: resolve(root, 'test'), sourcefile: 'pad-branches-command-regression-entry.ts' },
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { padBranchCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const command = padBranchCommands.find(item => item.name === 'pcb.routePadBranches');
	assert.ok(command?.handler);

	const uuid = 'branch-board';
	const row = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
	const head = row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid, client: 'test', version: '1' });
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
	function params(extra = {}) {
		return {
			pair: { positiveNet: 'P', negativeNet: 'N' },
			positive: { joinPoint: [200, 120], branches: [{ padId: 'p1' }, { padId: 'p2' }] },
			negative: { joinPoint: [200, 320], branches: [{ padId: 'n1' }, { padId: 'n2' }] },
			layer: 'top',
			width: 6,
			clearanceMil: 8,
			dryRun: true,
			...extra,
		};
	}

	function install(options = {}) {
		let source = options.source ?? head;
		let nextId = 0;
		let ticket = 1;
		const lines = new Map();
		const created = [];
		const pads = options.pads ?? [pad('p1', 'P', 100, 100), pad('p2', 'P', 100, 140), pad('n1', 'N', 100, 300), pad('n2', 'N', 100, 340)];
		const componentPinIds = new Set((options.components ?? []).flatMap(component => component.pins.map(pin => pin.getState_PrimitiveId())));
		const counters = { getAllPins: 0 };
		if (!options.source) {
			for (const item of pads) {
				const id = item.getState_PrimitiveId();
				if (componentPinIds.has(id))
					continue;
				const data = { layerId: options.sourcePadOverrides?.[id]?.layer ?? 1, centerX: options.sourcePadOverrides?.[id]?.x ?? item.getState_X(), centerY: item.getState_Y(), padAngle: 0, netName: options.sourcePadOverrides?.[id]?.net ?? item.getState_Net(), defaultPad: { padType: 'ELLIPSE', width: 12, height: 12 }, hole: null, plated: false };
				source += `\n${row('PAD', id, ++ticket, data)}`;
			}
		}
		const mkLine = (id, d) => ({
			getState_PrimitiveId: () => id,
			getState_Net: () => d.netName,
			getState_Layer: () => d.layerId,
			getState_StartX: () => d.startX,
			getState_StartY: () => d.startY,
			getState_EndX: () => d.endX,
			getState_EndY: () => d.endY,
			getState_LineWidth: () => d.width,
		});
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid }) },
			pcb_Net: { getAllNetsName: async () => ['P', 'N'] },
			pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL', layerStatus: 1, status: 1 }] },
			pcb_Drc: { getCurrentRuleConfiguration: async () => ({ clearance: 8, width: 6 }) },
			sys_FileManager: { getDocumentSource: async () => source },
			sys_Environment: { getEditorCurrentVersion: () => '4.1.78' },
			pcb_PrimitivePad: { getAll: async () => pads },
			pcb_PrimitiveComponent: { getAll: async () => (options.components ?? []).map(component => ({
				getState_PrimitiveId: () => component.id,
				getAllPins: async () => {
					counters.getAllPins++;
					return component.pins;
				},
			})) },
			pcb_PrimitiveVia: { getAll: async () => [] },
			pcb_PrimitiveArc: { getAll: async () => [] },
			pcb_PrimitiveFill: { getAll: async () => [] },
			pcb_PrimitivePour: { getAll: async () => [] },
			pcb_PrimitivePolyline: { getAll: async () => [] },
			pcb_PrimitivePoured: { getAll: async () => [] },
			pcb_PrimitiveLine: {
				getAllPrimitiveId: async () => [...lines.keys()],
				get: async id => lines.has(id) ? mkLine(id, lines.get(id)) : undefined,
				create: async (netName, layerId, startX, startY, endX, endY, width) => {
					created.push({ netName, layerId, startX, startY, endX, endY, width });
					if (options.failCreateAt === created.length)
						throw new Error('mock create failed');
					const id = `line-${++nextId}`;
					const d = { netName, layerId, startX, startY, endX, endY, width, locked: false };
					lines.set(id, d);
					source += `\n${row('LINE', id, ++ticket, d)}`;
					if (options.extraLineAt === created.length) {
						const extra = { ...d, customRouteFlag: 'unexpected' };
						source += `\n${row('LINE', 'unexpected-line', ++ticket, extra)}`;
					}
					if (options.nativeSplitAt === created.length) {
						const prior = lines.get('line-1');
						assert.ok(prior, 'native split fixture needs the earlier writer ID');
						lines.delete('line-1');
						source += `\n${JSON.stringify({ type: 'LINE', id: 'line-1', ticket: ++ticket })}|||`;
						const middle = (prior.startX + prior.endX) / 2;
						for (const [fragmentId, x1, x2] of [['native-fragment-a', prior.startX, middle], ['native-fragment-b', middle, prior.endX]]) {
							const fragment = { ...prior, startX: x1, endX: x2 };
							lines.set(fragmentId, fragment);
							source += `\n${row('LINE', fragmentId, ++ticket, fragment)}`;
						}
					}
					return mkLine(id, d);
				},
			},
		};
		return { created, counters };
	}

	{
		const mock = install({ nativeSplitAt: 2, pads: [pad('p1', 'P', 100, 100), pad('p2', 'P', 100, 250), pad('n1', 'N', 100, 400), pad('n2', 'N', 100, 500)] });
		const result = await command.handler(params({ dryRun: false, positive: { joinPoint: [300, 150], branches: [{ padId: 'p1', waypoints: [[200, 100], [200, 150]] }, { padId: 'p2', waypoints: [[200, 250], [200, 150]] }] }, negative: { joinPoint: [300, 450], branches: [{ padId: 'n1' }, { padId: 'n2' }] }	}));
		assert.equal(result.readbackVerified, true);
		assert.ok(result.hostLineIdentityChanges.writerReportedIdsMissingAtFinal.includes('line-1'), 'a writer ID may disappear after a later legal native split');
		assert.deepEqual(result.hostLineIdentityChanges.writerReportedIdsMissingAtFinal.sort(), ['line-1']);
		assert.equal(result.sourceCoverage.verified, true, 'final source must preserve the written geometry through complete attribute coverage');
		assert.ok(mock.created.length > 2);
	}

	{
		const mock = install();
		const result = await command.handler(params());
		assert.equal(result.dryRun, true);
		assert.equal(result.created, false);
		assert.equal(mock.created.length, 0, 'dryRun must not write');
		assert.equal(result.positive.branches.length, 2);
		assert.equal(result.negative.branches.length, 2);
		assert.ok(result.positive.branches.every(branch => Number.isFinite(branch.length)));
	}
	{
		install({ pads: [pad('p1', 'P', 100, 100), pad('p2', 'P', 100, 140), pad('n1', 'N', 100, 300), pad('n2', 'N', 100, 340)], sourcePadOverrides: { p1: { x: 100.04 } } });
		const result = await command.handler(params());
		assert.equal(result.positive.branches[0].path[0][0], 100.04, 'independent PAD planning must use precise effective-source center rather than a rounded SDK getter');
		assert.equal(result.padAnchorResolution.find(item => item.padId === 'p1').source, 'effective-PAD-source-exact');
		assert.ok(Math.abs(result.independentPadProjectionReports.find(item => item.padId === 'p1').getterProjectionDifferences.x + 0.04) < 1e-12, 'nearest 0.1mil getter projection is reported explicitly');
	}
	for (const [field, getter] of [['Net', () => 'wrong-net'], ['Layer', () => 2]]) {
		const p1 = pad('p1', 'P', 100, 100);
		p1[`getState_${field}`] = getter;
		const mock = install({ pads: [p1, pad('p2', 'P', 100, 140), pad('n1', 'N', 100, 300), pad('n2', 'N', 100, 340)], sourcePadOverrides: { p1: { net: 'P', layer: 1 } } });
		await assert.rejects(command.handler(params({ dryRun: false })), /源码网络\/层\/角度与当前SDK对象不一致/);
		assert.equal(mock.created.length, 0, `getter ${field} mismatch must be rejected before writes`);
	}
	{
		const p1 = pad('p1', 'P', 100, 100);
		const component = { id: 'component-1', pins: [p1] };
		const mock = install({ components: [component] });
		const result = await command.handler(params());
		assert.equal(result.padAnchorResolution.find(item => item.padId === 'p1').source, 'component-getAllPins-SDK-global-anchor');
		assert.equal(mock.counters.getAllPins, 1, 'getAllPins should be collected once');
		assert.equal(mock.created.length, 0, 'component duplicate enumeration dryRun must perform zero writes');
		assert.ok(result.positive.branches[0].length > 0, 'component PAD duplicated by PAD.getAll is planned through the component SDK model');
	}
	{
		const mock = install({ source: head });
		await assert.rejects(command.handler(params({ dryRun: false })), /目标独立PAD p1 缺少可确认的源码锚点几何/);
		assert.equal(mock.created.length, 0, 'a standalone PAD without an effective source anchor remains write-free');
	}
	{
		const mock = install();
		await assert.rejects(command.handler(params({ positive: { joinPoint: [200, 120], branches: [{ padId: 'missing' }] } })), /找不到目标PAD/);
		assert.equal(mock.created.length, 0, 'invalid pad must be rejected before writes');
	}
	{
		const mock = install({ pads: [pad('p1', 'P', 100, 100), pad('p2', 'P', 100, 140), pad('n1', 'N', 100, 300), pad('n2', 'N', 100, 340), pad('foreign', 'X', 150, 110)] });
		await assert.rejects(command.handler(params({ dryRun: false })), /异网导电对象|异网LINE/);
		assert.equal(mock.created.length, 0, 'foreign copper spacing failure must be write-free');
	}
	{
		const mock = install({ failCreateAt: 2 });
		await assert.rejects(command.handler(params({ dryRun: false })), (error) => {
			assert.equal(error.cause?.partial, true);
			assert.equal(error.cause?.retryable, false);
			assert.equal(error.cause?.saved, false);
			return true;
		});
		assert.equal(mock.created.length, 2, 'a failed write stops immediately without retry');
	}
	{
		const mock = install({ extraLineAt: 1 });
		await assert.rejects(command.handler(params({ dryRun: false })), /属性未预期的LINE/);
		assert.equal(mock.created.length, 1, 'unexpected LINE with changed full attributes is detected after first write');
	}

	console.log('pad-branches-command-regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
