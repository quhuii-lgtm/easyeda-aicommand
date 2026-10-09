import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { autoCopperCommands } from '../src/commands/autoCopper.ts'; export { autoCopperCommands }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'auto-copper-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { autoCopperCommands } = await import(moduleUrl);
	const command = name => autoCopperCommands.find(item => item.name === name);
	const docHead = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid, client: 'auto-copper-test' })}|`;
	const rules = { config: { spacingMil: 8 } };

	function pad(id, { x = 500, y = 500, layer = 1, net = 'N1', shape = ['RECT', 40, 24, 0], rotation = 0 } = {}) {
		return {
			getState_PrimitiveId: () => id,
			getState_PrimitiveType: () => 'Pad',
			getState_X: () => x,
			getState_Y: () => y,
			getState_Layer: () => layer,
			getState_Net: () => net,
			getState_Pad: () => shape,
			getState_SpecialPad: () => [],
			getState_Hole: () => null,
			getState_Rotation: () => rotation,
			getState_PadNumber: () => '1',
		};
	}
	function line(id, x1, y1, x2, y2, width = 0.1, layer = 11, net = '') {
		return { getState_PrimitiveId: () => id, getState_PrimitiveType: () => 'Line', getState_Layer: () => layer, getState_StartX: () => x1, getState_StartY: () => y1, getState_EndX: () => x2, getState_EndY: () => y2, getState_LineWidth: () => width, getState_Net: () => net };
	}
	function pour(id, net, source) {
		return {
			getState_PrimitiveId: () => id,
			getState_PrimitiveType: () => 'Pour',
			getState_Net: () => net,
			getState_Layer: () => 1,
			getState_LineWidth: () => 12,
			getState_ComplexPolygon: () => ({ getSource: () => source }),
		};
	}
	function install({ pads = [pad('LONG-PAD-1')], components = [], vias = [], pours = [], traces = [], outline = true, rulesValue = rules, badPadCollection = false, fillReadbackNet = undefined, rebuildResult = true, createDelayMs = 0 } = {}) {
		const state = { writes: [], deletions: 0, pads: [...pads], components: [...components], vias: [...vias], source: docHead('pcb-A'), rules: rulesValue, nextId: 1, pours: new Map(pours.map(item => [item.getState_PrimitiveId(), item])), fills: new Map(), poured: [], rebuildResult, fillReadbackNet, createDelayMs };
		const outlineLines = outline ? [line('O1', 0, 0, 1000, 0), line('O2', 1000, 0, 1000, 1000), line('O3', 1000, 1000, 0, 1000), line('O4', 0, 1000, 0, 0)] : [];
		const polygon = source => ({ getSource: () => source });
		const sdk = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'pcb-A', documentType: 3 }) },
			sys_FileManager: { getDocumentSource: async () => state.source },
			pcb_Drc: {
				getCurrentRuleConfiguration: async () => state.rules,
				getNetRules: async () => [],
				getNetByNetRules: async () => ({}),
				getAllNetClasses: async () => [],
				getCurrentRuleConfigurationName: async () => 'Default',
			},
			pcb_MathPolygon: { createPolygon: source => polygon(source), createComplexPolygon: source => polygon(source) },
			pcb_PrimitivePad: { getAll: async () => badPadCollection ? undefined : [...state.pads] },
			pcb_PrimitiveComponent: { getAll: async () => [...state.components], getAllPinsByPrimitiveId: async () => [] },
			pcb_PrimitiveVia: { getAll: async () => [...state.vias] },
			pcb_PrimitiveLine: { getAll: async (_net, layer) => layer === 11 ? outlineLines : layer === 1 ? [...traces] : [] },
			pcb_PrimitiveArc: { getAll: async () => [] },
			pcb_PrimitiveRegion: { getAll: async () => [] },
			pcb_PrimitivePolyline: { getAll: async () => [] },
			pcb_PrimitivePoured: { getAll: async () => [...state.poured] },
			pcb_PrimitivePour: {
				getAll: async () => [...state.pours.values()],
				create: async (net, layer, complexPolygon) => {
					state.writes.push('pour.create');
					const id = `POUR-${state.nextId++}`;
					const obj = { getState_PrimitiveId: () => id, getState_Net: () => net, getState_Layer: () => layer, getState_ComplexPolygon: () => complexPolygon, rebuildCopperRegion: async () => {
						state.writes.push('pour.rebuild');
						if (state.rebuildResult)
							state.poured.push({ getState_PrimitiveId: () => `POURED-${id}`, getState_PourPrimitiveId: () => id, getState_Net: () => net, getState_Layer: () => layer, getState_PourFills: () => [{ fill: true, path: complexPolygon.getSource(), lineWidth: 12 }] });
						return state.rebuildResult;
					} };
					state.pours.set(id, obj);
					state.source += `\n${JSON.stringify({ type: 'POUR', id, ticket: 1 })}||${JSON.stringify({ order: 1, netName: net, layerId: layer, name: `Auto Copper ${net}` })}|`;
					return obj;
				},
				get: async id => state.pours.get(id),
			},
			pcb_PrimitiveFill: {
				getAll: async () => [...state.fills.values()],
				create: async (layer, complexPolygon, net) => {
					state.writes.push('fill.create');
					if (state.createDelayMs)
						await new Promise(resolve => setTimeout(resolve, state.createDelayMs));
					const id = `FILL-${state.nextId++}`;
					const obj = { getState_PrimitiveId: () => id, getState_Net: () => state.fillReadbackNet ?? net, getState_Layer: () => layer, getState_ComplexPolygon: () => complexPolygon };
					state.fills.set(id, obj);
					return obj;
				},
				get: async id => state.fills.get(id),
			},
		};
		globalThis.eda = sdk;
		return { state, sdk };
	}
	const params = (extra = {}) => ({ __docUuid: 'pcb-A', targetIds: ['LONG-PAD-1'], layer: 'top', expansion: 5, ...extra });
	const plan = request => command('pcb.getAutoCopperPlan').handler(request);
	const execute = (value, extra = {}) => command('pcb.autoCopper').handler({ __docUuid: 'pcb-A', ...extra, plan: JSON.parse(JSON.stringify(value)) });
	let passed = 0;
	async function test(name, fn) {
		try {
			await fn();
			console.log(`PASS ${name}`);
			passed++;
		}
		catch (error) {
			console.error(`FAIL ${name}: ${error?.message ?? error}`);
			process.exitCode = 1;
		}
	}

	await test('static extraction imports without EDA/UI and registers read/write handlers', async () => {
		assert.deepEqual(autoCopperCommands.map(item => item.name), ['pcb.getAutoCopperPlan', 'pcb.autoCopper']);
		assert.equal(typeof command('pcb.getAutoCopperPlan').handler, 'function');
	});

	await test('single rotated pad, complete plan contract and zero writes in preview', async () => {
		const f = install({ pads: [pad('LONG-PAD-1', { rotation: 90 })] });
		const result = await plan(params());
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.equal(result.units, 'mil');
		assert.ok(result.inputs && result.baseline && result.excludedTargets);
		assert.equal(result.targets[0].rotation, 90);
		assert.ok(result.plannedPrimitives.length > 0);
		assert.equal('polygons' in result.groups[0].resolved.clearance, false);
		assert.ok(Array.isArray(result.groups[0].resolved.clearance.polygonSources));
		assert.equal(f.state.writes.length, 0);
		assert.equal(result.provenance.commit, '98317b6b5941977a3ae90948a05295f9d8b1169f');
	});

	await test('component getAllPins accepts short-to-long identity mapping and de-duplicates explicit pad', async () => {
		const componentPin = pad('PAD-LONG-002', { net: 'N2', x: 560 });
		const component = { getState_PrimitiveId: () => 'COMP-1', getAllPins: async () => [componentPin] };
		const f = install({ pads: [pad('PAD-LONG-002', { net: 'N2', x: 560 })], components: [component] });
		const result = await plan(params({ targetIds: ['COMP-1', 'PAD-LONG-002'] }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.equal(result.targets.length, 1);
		assert.equal(result.targets[0].id, 'PAD-LONG-002');
		assert.equal(result.targets[0].net, 'N2');
		assert.equal(f.state.writes.length, 0);
	});

	await test('top/bottom filtering, through via, invalid inputs, missing arrays and missing outline are explicit', async () => {
		install();
		const bottom = await plan(params({ layer: 'bottom', targetIds: ['LONG-PAD-1'] }));
		assert.equal(bottom.executable, false);
		assert.ok(bottom.excludedTargets.length);
		const throughVia = { getState_PrimitiveId: () => 'V1', getState_X: () => 450, getState_Y: () => 520, getState_Diameter: () => 24, getState_Net: () => 'N1', getState_ViaType: () => 0, getState_Layer: () => 12 };
		install({ vias: [throughVia] });
		const viaPlan = await plan(params({ layer: 'bottom', targetIds: ['V1'] }));
		assert.equal(viaPlan.targets[0].id, 'V1');
		assert.equal(viaPlan.targets[0].layerId, 12);
		await assert.rejects(plan(params({ expansion: -1 })), /expansion/);
		await assert.rejects(plan(params({ targetIds: [''] })), /targetIds/);
		const malformed = install({ badPadCollection: true });
		await assert.rejects(plan(params()), /未完整返回数组/);
		install({ outline: false });
		const noOutline = await plan(params());
		assert.ok(noOutline.coverage.unresolved.some(item => /闭环数 0/.test(item)));
		assert.equal(malformed.state.writes.length, 0);
	});

	await test('unknown foreign copper geometry and missing applicable DRC rule block execution', async () => {
		const malformedCopper = { getState_PrimitiveId: () => 'BAD-POUR', getState_Net: () => 'N2', getState_Layer: () => 1, getState_ComplexPolygon: () => undefined, getState_LineWidth: () => 12 };
		install({ pours: [malformedCopper] });
		await assert.rejects(plan(params()), /BAD-POUR.*缺失或无法解析/);
		const noRules = install({ rulesValue: { config: {} } });
		const result = await plan(params());
		assert.equal(result.executable, false);
		assert.ok(result.coverage.unresolved.some(item => /无法从完整 DRC 配置解析铜层异网间距规则/.test(item)));
		assert.equal(noRules.state.writes.length, 0);
	});

	await test('a malformed foreign copper area among valid areas blocks clipping with its ID', async () => {
		install({ pours: [
			pour('GOOD-POUR', 'N2', [530, 480, 550, 480, 550, 520, 530, 520]),
			pour('SHORT-RING-POUR', 'N3', [540, 480, 560, 500]),
		] });
		const result = await plan(params());
		assert.equal(result.executable, false);
		assert.ok(result.coverage.unresolved.some(item => /SHORT-RING-POUR.*clip ring/.test(item)));
	});

	await test('foreign pad obstacles enter the official avoidance and clipping chain; shape fallback is visible', async () => {
		install({ pads: [pad('LONG-PAD-1'), pad('FOREIGN-PAD', { x: 570, net: 'N2' })] });
		const result = await plan(params());
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.ok(result.groups[0].resolved.obstacles.avoidance.some(item => item.id === 'FOREIGN-PAD'));
		assert.ok(result.groups[0].resolved.clearance && typeof result.groups[0].resolved.clearance.usedClipping === 'boolean');
		install({ pads: [pad('ODD-PAD', { shape: ['UNKNOWN', 40, 24] })] });
		const fallback = await plan(params({ targetIds: ['ODD-PAD'] }));
		assert.equal(fallback.executable, false);
		assert.ok(fallback.warnings.some(item => item.code === 'unresolvedPadGeometry'));
	});

	await test('missing pad coordinates and via diameter are reported and block planning', async () => {
		const missingX = pad('NO-X');
		missingX.getState_X = () => undefined;
		install({ pads: [missingX] });
		const missingPadPlan = await plan(params({ targetIds: ['NO-X'] }));
		assert.equal(missingPadPlan.executable, false);
		assert.ok(missingPadPlan.coverage.unresolved.some(item => /NO-X.*X\/Y/.test(item)));
		const missingDiameter = { getState_PrimitiveId: () => 'NO-DIAM', getState_X: () => 500, getState_Y: () => 500, getState_Diameter: () => undefined, getState_Net: () => 'N1', getState_ViaType: () => 0, getState_Layer: () => 12 };
		install({ vias: [missingDiameter] });
		const missingViaPlan = await plan(params({ targetIds: ['NO-DIAM'] }));
		assert.equal(missingViaPlan.executable, false);
		assert.ok(missingViaPlan.coverage.unresolved.some(item => /NO-DIAM.*Diameter/.test(item)));
	});

	await test('residual trace-neck degradation after official repair passes appears in warnings', async () => {
		install({
			pads: [pad('P1', { x: 450 }), pad('P2', { x: 570 })],
			traces: [line('TRACE-NECK', 475, 487, 545, 487, 8, 1, 'N2')],
		});
		const result = await plan(params({ targetIds: ['P1', 'P2'] }));
		const warning = result.warnings.find(item => item.code === 'upstreamNarrowNeckResolution');
		assert.ok(warning);
		assert.ok(warning.narrowCountAfter > 0 || warning.repairReason);
		assert.ok(warning.debug.neckRepairPassCount > 0);
	});

	await test('distinct-net planned regions that collide after DRC spacing expansion are rejected', async () => {
		install({ pads: [pad('P1', { x: 500, net: 'N1' }), pad('P2', { x: 500, net: 'N2' })] });
		const result = await plan(params({ targetIds: ['P1', 'P2'] }));
		assert.equal(result.executable, false);
		assert.ok(result.coverage.unresolved.some(item => /不同网络 N1\/N2.*包围框相交/.test(item)));
		assert.ok(result.coverage.crossGroupClearance.some(item => item.resolved === true && item.clearanceMil > 0));
	});

	await test('fill execution reads back planned geometry and stops on changed baseline', async () => {
		const f = install();
		const preview = await plan(params({ generationType: 'fill' }));
		assert.equal(preview.executable, true, JSON.stringify(preview.coverage.unresolved));
		const executed = await execute(preview);
		assert.equal(executed.created[0].status, 'created-and-read-back-fixed-fill');
		assert.equal(executed.created[0].net, 'N1');
		assert.equal(f.state.writes.length, 1);
		const other = install();
		const stale = await plan(params({ generationType: 'fill' }));
		other.state.source += `\n${JSON.stringify({ type: 'PAD', id: 'X', ticket: 1 })}||{}|`;
		await assert.rejects(execute(stale), /基线已变化/);
		assert.equal(other.state.writes.length, 0);
	});

	await test('pour success independently verifies source order and filled-region geometry', async () => {
		const f = install();
		const preview = await plan(params());
		assert.equal(preview.executable, true, JSON.stringify(preview.coverage.unresolved));
		const result = await execute(preview);
		assert.equal(result.created[0].status, 'created-border-and-rebuilt; fill read back');
		assert.equal(result.created[0].orderReadback.order, 1);
		assert.equal(result.created[0].filledReadback[0].net, 'N1');
		assert.equal(result.created[0].filledReadback[0].layer, 1);
		assert.ok(result.created[0].filledReadback[0].geometry[0].length > 0);
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
	});

	await test('independent primitive mismatch stops before subsequent writes and preserves partial state', async () => {
		const f = install({ fillReadbackNet: 'WRONG' });
		const preview = await plan(params({ generationType: 'fill' }));
		const error = await execute(preview).then(() => assert.fail('mismatched readback should fail'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(f.state.writes.length, 1);
		assert.equal(error.cause.verifiedIds.length, 0);
	});

	await test('write timeout remains uncertain, latches follow-up work and never deletes', async () => {
		const f = install({ createDelayMs: 1200 });
		const preview = await plan(params({ generationType: 'fill' }));
		const error = await execute(preview, { _timeoutMs: 1000 }).then(() => assert.fail('timed out write should fail'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause.retryable, false);
		await new Promise(resolve => setTimeout(resolve, 300));
		assert.equal(f.state.deletions, 0);
		assert.deepEqual(f.state.writes, ['fill.create']);
	});

	await test('pour rebuild false leaves created geometry in place and does not attempt later items', async () => {
		const f = install({ pads: [pad('P1', { x: 420, net: 'N1' }), pad('P2', { x: 580, net: 'N2' })] });
		f.state.rebuildResult = false;
		const preview = await plan(params({ targetIds: ['P1', 'P2'] }));
		assert.equal(preview.executable, true, JSON.stringify(preview.coverage.unresolved));
		const error = await execute(preview).then(() => assert.fail('false rebuild should reject'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		assert.equal(f.state.pours.size, 1);
		assert.equal(error.cause.unattemptedPrimitives.length, preview.plannedPrimitives.length - 1);
	});

	console.log(`auto copper regression passed: ${passed}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
