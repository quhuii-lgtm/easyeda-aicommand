import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { fanoutCommands } from '../src/commands/fanout.ts'; import { normalizeRoute, planRouteDetailed } from '../src/pcb/fanout/fanout-routing.ts'; import { normalizeBoardOutlinePolylines } from '../src/pcb/boardOutline.ts'; import { planRouteDetailed as planRouteDetailedBefore } from './fixtures/fanout-routing-before.ts'; export { fanoutCommands, normalizeRoute, planRouteDetailed, planRouteDetailedBefore, normalizeBoardOutlinePolylines }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'fanout-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { fanoutCommands, normalizeRoute, planRouteDetailed, planRouteDetailedBefore, normalizeBoardOutlinePolylines } = await import(moduleUrl);
	const command = name => fanoutCommands.find(item => item.name === name);
	const docHead = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid, client: 'fanout-test' })}|`;
	const emptyRules = { config: { spacingMil: 8 }, name: 'test' };
	const holeSpacingRules = (value, unit = 'mm', isSetDefault = true) => ({ config: { Spacing: { 'Other Spacing': { otherClearance: { isSetDefault, unit, form: { hole2Hole: value } } } } } });
	const defaultHoleRules = holeSpacingRules(0.29972);

	function pad(id, { x = 500, y = 500, layer = 1, net = 'N1', shape = ['ELLIPSE', 40, 40], special = [], rotation = 0, hole = null, number = '1', componentId = undefined } = {}) {
		return {
			getState_PrimitiveId: () => id,
			getState_X: () => x,
			getState_Y: () => y,
			getState_Layer: () => layer,
			getState_PadNumber: () => number,
			getState_Net: () => net,
			getState_Pad: () => shape,
			getState_SpecialPad: () => special,
			getState_Hole: () => hole,
			getState_Rotation: () => rotation,
			getState_ParentComponentPrimitiveId: () => componentId,
		};
	}
	function line(id, layer, x1, y1, x2, y2, width = 1, net = '') {
		return {
			getState_PrimitiveId: () => id,
			getState_Layer: () => layer,
			getState_StartX: () => x1,
			getState_StartY: () => y1,
			getState_EndX: () => x2,
			getState_EndY: () => y2,
			getState_LineWidth: () => width,
			getState_Net: () => net,
			getState_ArcAngle: () => 0,
		};
	}
	function via(id, x, y, diameter = 24, holeDiameter = 12, type = 0, net = 'OLD') {
		return {
			getState_PrimitiveId: () => id,
			getState_X: () => x,
			getState_Y: () => y,
			getState_Diameter: () => diameter,
			getState_HoleDiameter: () => holeDiameter,
			getState_ViaType: () => type,
			getState_Net: () => net,
		};
	}
	function arc(id, layer, startX, startY, endX, endY, angle = 30, width = 8) {
		return {
			getState_PrimitiveId: () => id,
			getState_Layer: () => layer,
			getState_StartX: () => startX,
			getState_StartY: () => startY,
			getState_EndX: () => endX,
			getState_EndY: () => endY,
			getState_ArcAngle: () => angle,
			getState_LineWidth: () => width,
		};
	}
	function sourcePath(value) {
		const path = value?.getSource ? value.getSource() : value;
		return path;
	}
	function sourceRecord(type, id, data, ticket) {
		return `${JSON.stringify({ type, ticket, id })}||${JSON.stringify(data)}|`;
	}
	function poursAndPouredFromFixture(sample) {
		const pourRecords = sample.records.filter(record => record.header.type === 'POUR');
		const pouredRecords = sample.records.filter(record => record.header.type === 'POURED');
		const pours = sample.pours.map(item => ({
			getState_PrimitiveId: () => item.id,
			getState_Layer: () => item.layer,
			getState_Net: () => item.net,
			getState_PourFillMethod: () => 'solid',
			getState_ComplexPolygon: () => ({ getSource: () => item.path }),
		}));
		const poured = sample.poured.map(item => ({
			getState_PrimitiveId: () => JSON.stringify(['POURED', item.pourId]),
			getState_PourPrimitiveId: () => item.pourId,
			getState_PourFills: () => item.fills.map(fill => ({ id: fill.id, fill: fill.fill, lineWidth: fill.lineWidth, path: { getSource: () => fill.path } })),
		}));
		return { pours, poured, sourceText: `${docHead('pcb-A')}\n${[...pourRecords, ...pouredRecords].map(record => `${JSON.stringify(record.header)}||${JSON.stringify(record.data)}|`).join('\n')}` };
	}

	function install({ pads = [pad('P1')], components = [], tracks = [], vias = [], fills = [], pours = [], poured = [], arcs = [], holeLines = [], outlinePolylines = [], rules = emptyRules, focusUuid = 'pcb-A', outline = true, outlineLines, mergeCollinearLines = false, editorVersion = null, sourceText } = {}) {
		const state = { writes: [], reads: [], source: docHead(focusUuid), rules, pads: [...pads], components: [...components], vias: [...vias], fills: [...fills], arcs: [...arcs], holeLines: [...holeLines], lines: [...tracks], created: new Map(), nextId: 1, failCreate: undefined, mismatchReadback: false, mergeCollinearLines };
		let ticket = 1;
		for (const parent of pours) {
			const id = parent.getState_PrimitiveId();
			const path = sourcePath(parent.getState_ComplexPolygon());
			state.source += `\n${sourceRecord('POUR', id, { netName: parent.getState_Net?.() ?? '', layerId: parent.getState_Layer(), path: Array.isArray(path) && Array.isArray(path[0]) ? path : [path], pourType: { pourType: String(parent.getState_PourFillMethod?.() ?? 'solid').toUpperCase(), fineness: parent.fineness ?? 0 } }, ticket++)}`;
		}
		for (const item of poured) {
			const parentId = item.getState_PourPrimitiveId();
			const pourFill = item.getState_PourFills().map(fill => ({ id: fill.id, fill: fill.fill, strokeWidth: fill.lineWidth, path: [sourcePath(fill.path)] }));
			state.source += `\n${sourceRecord('POURED', JSON.stringify(['POURED', parentId]), { pourFill }, ticket++)}`;
		}
		if (typeof sourceText === 'string')
			state.source = sourceText;
		if (outlineLines)
			state.lines = [...tracks, ...outlineLines];
		else if (outline)
			state.lines = [...tracks, line('O1', 11, 0, 0, 1000, 0), line('O2', 11, 1000, 0, 1000, 1000), line('O3', 11, 1000, 1000, 0, 1000), line('O4', 11, 0, 1000, 0, 0)];
		const result = {
			state,
			sdk: {
				dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: focusUuid, documentType: 3 }) },
				sys_Environment: { getEditorCurrentVersion: () => editorVersion },
				sys_FileManager: { getDocumentSource: async () => state.source },
				pcb_Drc: { getCurrentRuleConfiguration: async () => state.rules },
				pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL' }, { id: 2, type: 'SIGNAL' }, { id: 15, type: 'SIGNAL' }, { id: 16, type: 'PLANE' }] },
				pcb_PrimitivePad: { getAll: async () => [...state.pads] },
				pcb_PrimitiveComponent: { getAll: async () => [...state.components] },
				pcb_PrimitiveLine: {
					getAll: async (_net, layer) => layer === 47 ? [...state.holeLines] : [...state.lines],
					create: async (net, layer, x1, y1, x2, y2, width) => {
						state.writes.push({ kind: 'line', layer, net, start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, width });
						if (state.failCreate === 'line')
							return undefined;
						if (state.mergeCollinearLines) {
							const previous = [...state.created.entries()].reverse().find(([, existing]) => {
								if (typeof existing.getState_StartX !== 'function' || existing.getState_Net() !== net || existing.getState_Layer() !== layer || existing.getState_LineWidth() !== width)
									return false;
								const ax = existing.getState_StartX();
								const ay = existing.getState_StartY();
								const bx = existing.getState_EndX();
								const by = existing.getState_EndY();
								const dx = x2 - x1;
								const dy = y2 - y1;
								const firstX = bx - ax;
								const firstY = by - ay;
								const directLength = Math.hypot(x2 - ax, y2 - ay);
								return Math.abs(bx - x1) <= 1e-9 && Math.abs(by - y1) <= 1e-9
									&& directLength > 1e-6
									&& Math.abs(firstX * dy - firstY * dx) / directLength <= 1e-6
									&& firstX * dx + firstY * dy > 0;
							});
							if (previous) {
								state.created.delete(previous[0]);
								return undefined;
							}
						}
						const id = `C${state.nextId++}`;
						const obj = line(id, layer, x1, y1, x2, y2, state.mismatchReadback ? width + 1 : width, net);
						state.created.set(id, obj);
						return obj;
					},
					get: async id => state.created.get(id),
				},
				pcb_PrimitiveArc: { getAll: async () => [...state.arcs] },
				pcb_PrimitiveVia: {
					getAll: async () => [...state.vias],
					create: async (net, x, y, holeDiameter, diameter, type) => {
						state.writes.push({ kind: 'via', type, net, x, y, holeDiameter, diameter });
						if (state.failCreate === 'via')
							return undefined;
						const id = `C${state.nextId++}`;
						const obj = via(id, x, y, diameter, holeDiameter, type, net);
						state.created.set(id, obj);
						return obj;
					},
					get: async id => state.created.get(id),
				},
				pcb_PrimitiveFill: { getAll: async () => [...state.fills] },
				pcb_PrimitivePour: { getAll: async () => pours },
				pcb_PrimitivePoured: { getAll: async () => poured },
				pcb_PrimitiveRegion: { getAll: async () => [] },
				pcb_PrimitivePolyline: { getAll: async () => [...outlinePolylines] },
			},
		};
		globalThis.eda = result.sdk;
		return result;
	}
	function outlinePolyline(id, source, { layer = 11, width = 0.1, missingPolygonGetter = false } = {}) {
		return {
			getState_PrimitiveId: () => id,
			getState_Layer: () => layer,
			getState_LineWidth: () => width,
			...(!missingPolygonGetter ? { getState_Polygon: () => ({ getSource: () => source }) } : {}),
		};
	}
	function params(extra = {}) {
		return { __docUuid: 'pcb-A', padIds: ['P1'], lineLength: 100, lineWidth: 8, viaDiameter: 24, holeDiameter: 12, clearance: 8, direction: 'N', ...extra };
	}
	async function runPlan(fixture, request = params()) {
		return command('pcb.getFanoutPlan').handler(request);
	}
	async function runExecute(fixture, plan, ctx) {
		return command('pcb.fanout').handler({ __docUuid: 'pcb-A', plan }, ctx);
	}
	let passed = 0;
	const testFilter = process.env.FANOUT_TEST_FILTER?.split('|').filter(Boolean);
	async function test(name, fn) {
		if (testFilter?.length && !testFilter.some(filter => name.startsWith(filter)))
			return;
		await fn();
		console.log(`PASS ${name}`);
		passed++;
	}

	await test('command contract, read-only plan, top layer and geometry', async () => {
		assert.ok(command('pcb.getFanoutPlan'));
		assert.ok(command('pcb.fanout'));
		const f = install();
		const plan = await runPlan(f);
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.units, 'mil');
		assert.equal(plan.plannedPrimitives.length, 2);
		assert.equal(plan.plannedPrimitives[0].layer, 1);
		assert.equal(plan.plannedPrimitives[0].net, 'N1');
		assert.equal(plan.plannedPrimitives[1].layer, 'all-copper');
		assert.equal(plan.coverage.geometryReview.status, 'complete-for-supported-local-geometry');
		assert.deepEqual(plan.coverage.geometryReview.readCounts, {
			standalonePads: 1,
			componentPins: 0,
			tracks: 0,
			arcs: 0,
			vias: 0,
			fills: 0,
			pours: 0,
			pouredObjects: 0,
			pouredFillChildren: 0,
			boardLines: 4,
			holeLines: 0,
			regions: 0,
		});
		assert.deepEqual(plan.coverage.geometryReview.warnings, plan.warnings.filter(item => item.startsWith('椭圆、圆角矩形')));
		assert.deepEqual(plan.coverage.geometryReview.nativeDrc, { status: 'not-run' });
		assert.match(plan.coverage.geometryReview.scope, /not native DRC/);
		assert.match(plan.coverage.geometryReview.precision, /PAD.*SDK对象getter.*未从原始源码读取PAD几何/);
		assert.match(plan.coverage.geometryReview.precision, /0\.001 mil/);
		assert.ok(plan.coverage.geometryReview.unknown.some(item => /原生 DRC 未调用/.test(item)));
		assert.equal(f.state.writes.length, 0);
	});

	await test('geometry coverage distinguishes embedded pads and combined layered obstacles', async () => {
		const componentPad = pad('CP1', { x: 200, y: 200, layer: 2, net: 'N2', componentId: 'C1' });
		const fill = {
			getState_PrimitiveId: () => 'F1',
			getState_Layer: () => 1,
			getState_LineWidth: () => 2,
			getState_ComplexPolygon: () => ({ getSource: () => [100, 100, 'L', 120, 100, 120, 120, 100, 120] }),
		};
		const pour = {
			getState_PrimitiveId: () => 'PO1',
			getState_Layer: () => 2,
			getState_Net: () => 'N2',
			getState_PourFillMethod: () => 'solid',
			getState_LineWidth: () => 0.2,
			getState_ComplexPolygon: () => ({ getSource: () => ['R', 660, 740, 80, 80, 0, 0] }),
		};
		const childFills = [{
				id: 'PF1',
				fill: true,
				lineWidth: 0,
				path: { getSource: () => [67, 67, 'L', 70, 67, 70, 70, 67, 70, 67, 67] },
			}, {
				id: 'PF2',
				fill: true,
				lineWidth: 0,
				path: { getSource: () => [70.5, 70.5, 'L', 73, 70.5, 73, 73, 70.5, 73, 70.5, 70.5] },
			}];
		const pouredObject = (fills = childFills) => ({
			getState_PrimitiveId: () => 'PR1',
			getState_PourPrimitiveId: () => 'PO1',
			getState_PourFills: () => fills,
		});
		const combined = {
			components: [{ getState_PrimitiveId: () => 'C1', getAllPins: async () => [componentPad] }],
			tracks: [line('T1', 1, 300, 350, 400, 350, 8, 'N2'), line('T2', 2, 300, 350, 400, 350, 8, 'N2')],
			vias: [via('V1', 800, 800, 24, 12, 0, 'N2')],
			arcs: [arc('A1', 1, 200, 200, 240, 200, 30, 8)],
			fills: [fill],
			pours: [pour],
		};
		const f = install({ ...combined, poured: [pouredObject()] });
		const plan = await runPlan(f, params({ padIds: undefined, componentIds: ['C1'], layer: 'bottom' }));
		const singleChild = await runPlan(install({ ...combined, poured: [pouredObject(childFills.slice(0, 1))] }), params({ padIds: undefined, componentIds: ['C1'], layer: 'bottom' }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.coverage.geometryReview.status, 'complete-for-supported-local-geometry');
		assert.deepEqual(plan.coverage.geometryReview.readCounts, {
			standalonePads: 1,
			componentPins: 1,
			tracks: 2,
			arcs: 1,
			vias: 1,
			fills: 1,
			pours: 1,
			pouredObjects: 1,
			pouredFillChildren: 2,
			boardLines: 4,
			holeLines: 0,
			regions: 0,
		});
		assert.deepEqual(plan.coverage.geometryReview.warnings, plan.warnings.filter(item => item.startsWith('椭圆、圆角矩形')));
		assert.equal(plan.coverage.obstacles, singleChild.coverage.obstacles + 1, 'two active fill children in one Poured object become two local obstacles');
		assert.equal(plan.coverage.geometryReview.nativeDrc.status, 'not-run');
		assert.equal(f.state.writes.length, 0, 'the combined geometry plan remains read-only');
	});

	await test('invalid fixed copper fill reports incomplete local geometry', async () => {
		const fill = {
			getState_PrimitiveId: () => 'F-invalid',
			getState_Layer: () => 1,
			getState_LineWidth: () => -1,
			getState_ComplexPolygon: () => ({ getSource: () => ['R', 400, 400, 80, 80, 0, 0] }),
		};
		const plan = await runPlan(install({ fills: [fill] }));
		assert.equal(plan.coverage.complete, false);
		assert.equal(plan.coverage.geometryReview.status, 'incomplete');
		assert.equal(plan.coverage.geometryReview.readCounts.fills, 1);
		assert.ok(plan.coverage.geometryReview.warnings.some(item => /填充\/覆铜线宽无效/.test(item)));
		assert.equal(plan.executable, false);
	});

	await test('different-net track collision is enforced only on the selected copper layer', async () => {
		const request = params({ direction: 'N', lineLength: 100, lineWidth: 8, viaDiameter: 24, holeDiameter: 12, clearance: 4 });
		const base = await runPlan(install({ pads: [pad('P1', { x: 500, y: 300 })] }), request);
		const otherLayer = await runPlan(install({ pads: [pad('P1', { x: 500, y: 300 })], tracks: [line('T-bottom', 2, 470, 350, 530, 350, 8, 'N2')] }), request);
		const sameLayer = await runPlan(install({ pads: [pad('P1', { x: 500, y: 300 })], tracks: [line('T-top', 1, 470, 350, 530, 350, 8, 'N2')] }), request);
		const arcLayer = await runPlan(install({ pads: [pad('P1', { x: 500, y: 300 })], arcs: [arc('A-top', 1, 470, 350, 530, 350, 0, 8)] }), request);
		assert.equal(base.executable, true, base.warnings.join('; '));
		assert.equal(otherLayer.executable, true, otherLayer.warnings.join('; '));
		assert.deepEqual(otherLayer.plannedPrimitives, base.plannedPrimitives, 'opposite-layer copper must not be treated as same-layer track collision');
		assert.equal(sameLayer.executable, true, sameLayer.warnings.join('; '));
		assert.notDeepEqual(sameLayer.plannedPrimitives, base.plannedPrimitives, 'different-net copper on the selected layer must obstruct the direct route');
		assert.equal(arcLayer.executable, true, arcLayer.warnings.join('; '));
		assert.notDeepEqual(arcLayer.plannedPrimitives, base.plannedPrimitives, 'same-layer arc geometry must be converted into a routing obstacle');
	});

	await test('source-matched SOLID POURED geometry normalizes independently of EDA version', async () => {
		const rectangle = ['R', 250, 450, 200, 100, 0, 0];
		const equivalent = [250, 450, 'L', 450, 450, 450, 350, 250, 350, 250, 450];
		const pour = (id, path, fineness = 0, net = 'N1') => ({ getState_PrimitiveId: () => id, getState_Layer: () => 2, getState_Net: () => net, getState_PourFillMethod: () => 'solid', getState_ComplexPolygon: () => ({ getSource: () => path }), fineness });
		const region = (parentId, width, path) => ({ getState_PrimitiveId: () => `poured-${parentId}`, getState_PourPrimitiveId: () => parentId, getState_PourFills: () => [{ id: `fill-${parentId}`, fill: true, lineWidth: width, path: { getSource: () => path } }] });
		const rawInner = [44.6, 35.4, 'L', 25.4, 35.4, 25.4, 44.6, 44.6, 44.6, 44.6, 35.4];
		const r = await runPlan(install({ pours: [pour('pour-host', rectangle)], poured: [region('pour-host', 0, rawInner)] }));
		const l = await runPlan(install({ pours: [pour('pour-host', equivalent)], poured: [region('pour-host', 0, rawInner)] }));
		assert.equal(r.coverage.complete, true, r.warnings.join('; '));
		assert.deepEqual(r.plannedPrimitives, l.plannedPrimitives, 'native R and equivalent closed L parent paths retain equivalent filled geometry');
		assert.equal(r.coverage.geometryReview.pouredNormalization.items[0].conversionFactor, 10);
		assert.equal(r.coverage.geometryReview.pouredNormalization.items[0].copperMarginMil, 0);
		assert.equal(r.coverage.obstacles, (await runPlan(install())).coverage.obstacles + 1, 'the active child polygon is an obstacle; its parent POUR outline is not treated as copper');
		const outside = [24.9, 45, 'L', 45, 45, 45, 35, 24.9, 35, 24.9, 45];
		const out = await runPlan(install({ pours: [pour('pour-host', rectangle)], poured: [region('pour-host', 0, outside)] }));
		assert.equal(out.coverage.complete, false, 'source-matched child polygon outside the parent outline is rejected');
		for (const width of [-1, undefined, '0', Number.NaN, Infinity]) {
			const invalid = await runPlan(install({ pours: [pour('pour-host', rectangle)], poured: [region('pour-host', width, rawInner)] }));
			assert.equal(invalid.coverage.complete, false);
		}
		for (const path of [['R', 250, 450, 200, 100, 90, 0], ['R', 250, 450, 200, 100, 0, 5]]) {
			const invalid = await runPlan(install({ pours: [pour('pour-host', path)], poured: [region('pour-host', 0, rawInner)] }));
			assert.equal(invalid.coverage.complete, false, 'unsupported parent geometry cannot pass source matching');
		}
		for (const editorVersion of [null, '4.1.78', '4.1.99', '4.2.0']) {
			const versionIndependent = await runPlan(install({ editorVersion, pours: [pour('pour-host', ['R', 100, 200, 200, 100, 0, 0])], poured: [region('pour-host', 0, [19.6, 10.4, 'L', 10.4, 10.4, 10.4, 19.6, 19.6, 19.6, 19.6, 10.4])] }));
			assert.equal(versionIndependent.coverage.complete, true, `matching geometry is accepted without an editor-version allowlist (${editorVersion})`);
		}
	});

	await test('matched unfilled POURED child with nonzero stroke keeps coverage incomplete', async () => {
		const parent = { getState_PrimitiveId: () => 'POUR-STROKE', getState_Layer: () => 2, getState_Net: () => 'N2', getState_PourFillMethod: () => 'solid', getState_ComplexPolygon: () => ({ getSource: () => ['R', 100, 200, 200, 100, 0, 0] }), fineness: 0 };
		const child = { id: 'FILL-STROKE', fill: false, lineWidth: 2, path: { getSource: () => [19.6, 10.4, 'L', 10.4, 10.4, 10.4, 19.6, 19.6, 19.6, 19.6, 10.4] } };
		const actual = { getState_PrimitiveId: () => 'POURED-STROKE', getState_PourPrimitiveId: () => 'POUR-STROKE', getState_PourFills: () => [child] };
		const fixture = install({ pours: [parent], poured: [actual] });
		const plan = await runPlan(fixture);
		assert.equal(plan.coverage.complete, false, 'a source-matched stroked child is not silently treated as absent copper');
		assert.equal(plan.executable, false);
		assert.equal(fixture.state.writes.length, 0);
		assert.ok(plan.coverage.geometryReview.pouredNormalization.items.some(item => item.fillId === 'FILL-STROKE' && item.status === 'unsupported'));
	});

	await test('real fineness 8 and 0 source, getter and Gerber fixtures replay with calibrated margin', async () => {
		const fixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/poured-solid-coordinate-4199.json'), 'utf8'));
		for (const sampleName of ['sample8', 'sample0']) {
			const sample = fixture[sampleName];
			const objects = poursAndPouredFromFixture(sample);
			const plan = await runPlan(install({ ...objects, editorVersion: '4.2.0' }));
			assert.equal(plan.coverage.complete, true, `${sampleName}: ${plan.warnings.join('; ')}`);
			const rows = plan.coverage.geometryReview.pouredNormalization.items.filter(item => item.status === 'normalized' && item.fillId !== '(empty-cache)');
			assert.equal(rows.length, 2);
			assert.ok(rows.every(item => item.conversionFactor === fixture.expected.conversionFactor));
			assert.equal(rows.find(item => item.pourId === 'be92d7bb24758417').copperMarginMil, fixture.expected.solidFineness8CopperMarginMil);
			assert.equal(rows.find(item => item.pourId === 'ca82d66c312ff6fc').copperMarginMil, sampleName === 'sample8' ? 4 : 0);
			for (const rawFill of sample.poured.flatMap(item => item.fills)) {
				const point = rawFill.path[0] * fixture.expected.conversionFactor;
				const gerberCoordinate = Math.round(point * 0.0254 * 100000);
				assert.ok(sample.gerberBottom.includes(`X${gerberCoordinate}Y`), `${sampleName}: normalized coordinate should occur in captured Gerber`);
			}
		}
	});

	await test('fineness edge band blocks only the calibrated copper margin, not the parent POUR outline', async () => {
		const parentPath = ['R', 600, 800, 200, 200, 0, 0];
		const childPath = [70, 70, 'L', 60, 70, 60, 80, 70, 80, 70, 70];
		const pourAt = fineness => ({ getState_PrimitiveId: () => 'POUR-A', getState_Layer: () => 2, getState_Net: () => 'N2', getState_PourFillMethod: () => 'solid', getState_ComplexPolygon: () => ({ getSource: () => parentPath }), fineness });
		const pouredAt = { getState_PrimitiveId: () => 'POURED-A', getState_PourPrimitiveId: () => 'POUR-A', getState_PourFills: () => [{ id: 'FILL-A', fill: true, lineWidth: 0, path: { getSource: () => childPath } }] };
		const options = { pads: [pad('P1', { x: 704.5, y: 750, layer: 2, shape: ['ELLIPSE', 1, 1], net: 'N1' })], pours: [], poured: [pouredAt] };
		const request = params({ direction: 'E', lineLength: 100, lineWidth: 2, viaDiameter: 12, holeDiameter: 4, clearance: 0.1 });
		const fineness8 = await runPlan(install({ ...options, pours: [pourAt(8)] }), request);
		const fineness0 = await runPlan(install({ ...options, pours: [pourAt(0)] }), request);
		assert.equal(fineness8.coverage.complete, true, fineness8.warnings.join('; '));
		assert.equal(fineness0.coverage.complete, true, fineness0.warnings.join('; '));
		assert.equal(fineness8.executable, false, 'the copper stroke margin pushes the effective boundary 4mil outward and blocks the 4.5mil start clearance');
		assert.equal(fineness0.executable, true, 'with the same parent, copper polygon and route, zero fineness adds no artificial edge band');
		assert.equal(fineness8.coverage.geometryReview.pouredNormalization.items[0].copperMarginMil, 4);
		assert.equal(fineness0.coverage.geometryReview.pouredNormalization.items[0].copperMarginMil, 0);
	});

	await test('POUR and POURED source association mismatches or missing cache fail closed', async () => {
		const parentPath = ['R', 100, 200, 200, 100, 0, 0];
		const childPath = [19.6, 10.4, 'L', 10.4, 10.4, 10.4, 19.6, 19.6, 19.6, 19.6, 10.4];
		const makeObjects = ({ net = 'N2', layer = 2, path = parentPath, fineness = 0, childId = 'FILL-A', childPath: fillPath = childPath, parentId = 'POUR-A' } = {}) => {
			const parent = { getState_PrimitiveId: () => parentId, getState_Layer: () => layer, getState_Net: () => net, getState_PourFillMethod: () => 'solid', getState_ComplexPolygon: () => ({ getSource: () => path }), fineness };
			const child = { id: childId, fill: true, lineWidth: 0, path: { getSource: () => fillPath } };
			const actual = { getState_PrimitiveId: () => `POURED-${parentId}`, getState_PourPrimitiveId: () => parentId, getState_PourFills: () => [child] };
			return { parent, actual };
		};
		const create = overrides => {
			const objects = makeObjects(overrides);
			return { objects, fixture: install({ pours: [objects.parent], poured: [objects.actual] }) };
		};
		const updateSourceRecord = (state, type, id, update) => {
			const lines = state.source.split(/\r?\n/);
			const index = lines.findIndex(line => {
				const separator = line.indexOf('||');
				if (separator < 0) return false;
				const header = JSON.parse(line.slice(0, separator));
				return header.type === type && header.id === id;
			});
			assert.notEqual(index, -1, `source fixture contains ${type}/${id}`);
			const separator = lines[index].indexOf('||');
			const header = JSON.parse(lines[index].slice(0, separator));
			const data = JSON.parse(lines[index].slice(separator + 2).replace(/\|$/, ''));
			lines[index] = `${JSON.stringify(header)}||${JSON.stringify(update(data))}|`;
			state.source = lines.join('\n');
		};
		const sourcePouredId = JSON.stringify(['POURED', 'POUR-A']);
		const cases = [
			['parent net', f => updateSourceRecord(f.state, 'POUR', 'POUR-A', data => ({ ...data, netName: 'WRONG' }))],
			['parent layer', f => updateSourceRecord(f.state, 'POUR', 'POUR-A', data => ({ ...data, layerId: 1 }))],
			['parent path', f => updateSourceRecord(f.state, 'POUR', 'POUR-A', data => ({ ...data, path: [['R', 101, 200, 200, 100, 0, 0]] }))],
			['child ID', f => updateSourceRecord(f.state, 'POURED', sourcePouredId, data => ({ ...data, pourFill: data.pourFill.map(fill => ({ ...fill, id: 'WRONG' })) }))],
			['child path', f => updateSourceRecord(f.state, 'POURED', sourcePouredId, data => ({ ...data, pourFill: data.pourFill.map(fill => ({ ...fill, path: [[...fill.path[0].slice(0, 4), 11.4, ...fill.path[0].slice(5)]] })) }))],
			['negative fineness', f => updateSourceRecord(f.state, 'POUR', 'POUR-A', data => ({ ...data, pourType: { ...data.pourType, fineness: -1 } }))],
			['nonfinite fineness', f => updateSourceRecord(f.state, 'POUR', 'POUR-A', data => ({ ...data, pourType: { ...data.pourType, fineness: null } }))],
		];
		for (const [label, mutate] of cases) {
			const { fixture } = create();
			mutate(fixture);
			const result = await runPlan(fixture);
			assert.equal(result.coverage.complete, false, `${label} mismatch must mark geometry incomplete`);
			assert.equal(result.executable, false, `${label} mismatch cannot produce an executable fanout`);
			assert.equal(fixture.state.writes.length, 0);
		}
		const wrongGetterParent = create();
		wrongGetterParent.objects.actual.getState_PourPrimitiveId = () => 'POUR-WRONG';
		const wrongParentResult = await runPlan(wrongGetterParent.fixture);
		assert.equal(wrongParentResult.coverage.complete, false, 'getter parent ID must match the tuple-keyed POURED record');
		const missingCache = create();
		missingCache.fixture.state.source = missingCache.fixture.state.source.split(/\r?\n/).filter(line => !line.includes('"POURED"')).join('\n');
		assert.equal((await runPlan(missingCache.fixture)).coverage.complete, false, 'missing POURED source record is not accepted');
		const wrongDocumentSource = create();
		wrongDocumentSource.fixture.state.source = wrongDocumentSource.fixture.state.source.replace('"uuid":"pcb-A"', '"uuid":"pcb-other"');
		await assert.rejects(runPlan(wrongDocumentSource.fixture), /源码 DOCHEAD 与 PCB pcb-A 不符/, 'POUR/POURED records from another document cannot be used even if primitive IDs match');
		const getterMissing = install({ pours: [makeObjects().parent], poured: [] });
		getterMissing.state.source += `\n${sourceRecord('POURED', sourcePouredId, { pourFill: [{ id: 'FILL-A', fill: true, strokeWidth: 0, path: [childPath] }] }, 500)}`;
		assert.equal((await runPlan(getterMissing)).coverage.complete, false, 'non-empty raw POURED without an SDK getter is incomplete');
		const knownEmpty = install({ pours: [makeObjects().parent], poured: [] });
		knownEmpty.state.source += `\n${sourceRecord('POURED', sourcePouredId, { pourFill: [] }, 500)}`;
		const emptyResult = await runPlan(knownEmpty);
		assert.equal(emptyResult.coverage.complete, true, 'an explicitly empty, source-matched cached region is known empty');
		assert.ok(emptyResult.coverage.geometryReview.pouredNormalization.items.some(item => item.normalization === 'source-matched-empty-poured-cache'));
	});

	await test('grid POUR methods remain incomplete with missing or existing unsupported POURED cache', async () => {
		for (const method of ['90grid', '45grid']) {
			const parentPath = ['R', 100, 200, 200, 100, 0, 0];
			const childPath = [19.6, 10.4, 'L', 10.4, 10.4, 10.4, 19.6, 19.6, 19.6, 19.6, 10.4];
			const parent = { getState_PrimitiveId: () => `POUR-${method}`, getState_Layer: () => 2, getState_Net: () => 'N2', getState_PourFillMethod: () => method, getState_ComplexPolygon: () => ({ getSource: () => parentPath }), fineness: 0 };
			const child = { id: `FILL-${method}`, fill: true, lineWidth: 0, path: { getSource: () => childPath } };
			const withoutCache = await runPlan(install({ pours: [parent], poured: [] }));
			assert.equal(withoutCache.coverage.complete, false, `${method} without a POURED getter must not be reported as empty`);
			assert.equal(withoutCache.executable, false);
			assert.ok(withoutCache.coverage.geometryReview.pouredNormalization.items.some(item => item.normalization === 'unsupported-pour-fill-method'));
			const withCache = await runPlan(install({ pours: [parent], poured: [{ getState_PrimitiveId: () => `POURED-${method}`, getState_PourPrimitiveId: () => `POUR-${method}`, getState_PourFills: () => [child] }] }));
			assert.equal(withCache.coverage.complete, false, `${method} geometry remains unsupported even when POURED exists`);
			assert.equal(withCache.executable, false);
		}
	});

	await test('polygon-only rectangular outline is normalized into the closed board boundary', async () => {
		const f = install({ pads: [pad('P1', { x: 300, y: 0 })], outline: false, outlinePolylines: [outlinePolyline('BOARD-R', ['R', -200, 500, 1000, 1000, 0, 0])] });
		const plan = await runPlan(f);
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.coverage.boardPolygons, 1);
		assert.equal(f.state.writes.length, 0);
	});

	await test('closed straight POLY concave outline supports fanout in both arms', async () => {
		const lShape = [0, 0, 'L', 0, 1000, 700, 1000, 700, 600, 1200, 600, 1200, 0, 0, 0];
		const normalized = normalizeBoardOutlinePolylines([outlinePolyline('BOARD-L', lShape)]);
		assert.deepEqual(normalized.issues, []);
		assert.equal(normalized.summaries[0].lineCount, 6);
		const lowerArm = await runPlan(install({ pads: [pad('P1', { x: 300, y: 800 })], outline: false, outlinePolylines: [outlinePolyline('BOARD-L', lShape)] }));
		assert.equal(lowerArm.executable, true, lowerArm.warnings.join('; '));
		assert.equal(lowerArm.coverage.boardPolygons, 1);
		const upperArm = await runPlan(install({ pads: [pad('P1', { x: 1000, y: 300 })], outline: false, outlinePolylines: [outlinePolyline('BOARD-L', lShape)] }));
		assert.equal(upperArm.executable, true, upperArm.warnings.join('; '));
		assert.equal(upperArm.coverage.boardPolygons, 1);
	});

	await test('closed straight POLY rejects concavity crossing and via edge intrusion', async () => {
		const lShape = [{ x: 0, y: 0 }, { x: 0, y: 1000 }, { x: 700, y: 1000 }, { x: 700, y: 600 }, { x: 1200, y: 600 }, { x: 1200, y: 0 }];
		const crossing = { start: { x: 500, y: 950 }, midpoint: { x: 850, y: 475 }, end: { x: 1200, y: 0 }, net: 'N1', lineWidth: 2, viaDiameter: 24, clearance: 0, maxEndOffset: 0, obstacles: [], boardPolygons: [lShape] };
		assert.ok(crossing.midpoint.x < 1200 && crossing.midpoint.y < 600, 'the segment midpoint is inside the upper arm');
		const normalized = normalizeRoute([crossing.start, crossing.midpoint, crossing.end], crossing);
		assert.equal(normalized.safeToExecute, false, 'the collinear segment crosses the concave notch boundary even though its midpoint is inside');
		const forbiddenVia = planRouteDetailed({ start: { x: 500, y: 400 }, desiredEnd: { x: 760, y: 590 }, net: 'N1', lineWidth: 2, viaDiameter: 24, clearance: 0, maxEndOffset: 0, obstacles: [], boardPolygons: [lShape] });
		assert.equal(forbiddenVia.route, null, 'via center is inside the board, but its 12mil radius overlaps the nearby notch edge');
	});

	await test('closed straight POLY rejects open, malformed, self-intersecting and curved sources', async () => {
		const invalidSources = [
			[0, 0, 'L', 0, 100, 100, 100, 100, 0], // open
			[0, 0, 'L', 0, 100, 100, 'ARC', 100, 0, 0, 0], // unsupported segment token
			[0, 0, 'L', 0, 100, Number.NaN, 100, 100, 0, 0, 0], // non-finite coordinate
			[0, 0, 'L', 100, 100, 0, 100, 100, 0, 0, 0], // bow-tie self intersection
		];
		for (const source of invalidSources) {
			const result = normalizeBoardOutlinePolylines([outlinePolyline('BOARD-BAD', source)]);
			assert.ok(result.issues.length > 0, `invalid source must be rejected: ${String(source)}`);
			assert.deepEqual(result.lines, []);
			const f = install({ outline: false, outlinePolylines: [outlinePolyline('BOARD-BAD', source)] });
			assert.equal((await runPlan(f)).executable, false);
			assert.equal(f.state.writes.length, 0);
		}
	});

	await test('multiple rectangular and concave board polylines remain separate routing regions', async () => {
		const f = install({
			pads: [pad('P1', { x: 300, y: 0 })],
			outline: false,
			outlinePolylines: [
				outlinePolyline('BOARD-R1', ['R', -200, 500, 1000, 1000, 0, 0]),
				outlinePolyline('BOARD-L2', [2000, 0, 'L', 2000, 1000, 2700, 1000, 2700, 600, 3200, 600, 3200, 0, 2000, 0]),
			],
		});
		const plan = await runPlan(f);
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.coverage.boardPolygons, 2);
		assert.equal(f.state.writes.length, 0);
	});

	await test('unsupported board polyline rectangles and additional board outlines fail closed', async () => {
		for (const source of [
			['R', -200, 500, 1000, 1000, 15, 0],
			['R', -200, 500, 1000, 1000, 0, 5],
			['R', -200, 500, 0, 1000, 0, 0],
			['R', Number.MAX_VALUE, 500, 1000, 10, 0, 0],
		]) {
			const f = install({ outline: false, outlinePolylines: [outlinePolyline('BOARD-R', source)] });
			assert.equal((await runPlan(f)).executable, false);
			assert.equal(f.state.writes.length, 0);
		}
		const missingGetter = install({ outline: false, outlinePolylines: [outlinePolyline('NO-POLYGON', undefined, { missingPolygonGetter: true })] });
		assert.equal((await runPlan(missingGetter)).executable, false);
		const invalidId = install({ outline: false, outlinePolylines: [outlinePolyline(7, ['R', -200, 500, 1000, 1000, 0, 0])] });
		assert.equal((await runPlan(invalidId)).executable, false);
		const secondBoard = install({ outline: false, outlinePolylines: [
			outlinePolyline('BOARD-R', ['R', -200, 500, 1000, 1000, 0, 0]),
			outlinePolyline('BOARD-UNKNOWN', ['P', 0, 0, 1, 1]),
		] });
		assert.equal((await runPlan(secondBoard)).executable, false);
		assert.equal(secondBoard.state.writes.length, 0);
	});

	await test('bottom SMT, pad rotation, and multilayer pad requires explicit layer', async () => {
		const bottom = install({ pads: [pad('P1', { layer: 2, y: 500 })] });
		assert.equal((await runPlan(bottom, params({ direction: 'E' }))).plannedPrimitives[0].layer, 2);
		const rotated = install({ pads: [pad('P1', { shape: ['RECTANGLE', 80, 30, 0], rotation: 90 })] });
		assert.equal((await runPlan(rotated, params({ direction: 'E' }))).groups[0].via.y > 500, true);
		const multilayer = install({ pads: [pad('P1', { layer: 12 })] });
		const implicit = await runPlan(multilayer);
		assert.equal(implicit.executable, false);
		assert.match(implicit.warnings.join(' '), /必须显式选择/);
		const explicit = await runPlan(multilayer, params({ layer: 'bottom' }));
		assert.equal(explicit.executable, true, explicit.warnings.join('; '));
		assert.equal(explicit.plannedPrimitives[0].layer, 2);
	});

	await test('SDK pad shape values support oval, rounded rect, ngon, straight polygon, special pad and reject curves or unknowns', async () => {
		for (const { shape, rotation = 0, layer = 1, label } of [
			{ shape: ['OVAL', 11.8, 63], rotation: 90, label: 'top rotated oval' },
			{ shape: ['OVAL', 11.8, 63], rotation: 0, layer: 2, label: 'bottom oval' },
			{ shape: ['RECT', 80, 30, 8], label: 'rounded rect' },
			{ shape: ['NGON', 50, 6], label: 'ngon' },
			{ shape: ['POLYGON', [0, 0, 50, 0, 50, 30, 0, 30]], label: 'straight polygon' },
		]) {
			const f = install({ pads: [pad('P1', { shape, rotation, layer })] });
			const plan = await runPlan(f, params({ ...(layer === 2 ? { layer: 'bottom' } : {}) }));
			assert.equal(plan.executable, true, `${label}: ${plan.warnings.join('; ')}`);
			if (label.includes('oval')) {
				const points = plan.targets[0].polygon.flat();
				const width = Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x));
				const height = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y));
				assert.ok(Math.abs(width - (rotation === 90 ? 63 : 11.8)) <= 1e-6, `${label}: polygon width ${width}`);
				assert.ok(Math.abs(height - (rotation === 90 ? 11.8 : 63)) <= 1e-6, `${label}: polygon height ${height}`);
				assert.ok(plan.plannedPrimitives.filter(item => item.type === 'line').every(item => item.layer === layer), `${label}: line layer does not match ${layer}`);
			}
		}
		const curved = install({ pads: [pad('P1', { shape: ['POLYGON', [0, 0, 50, 0, 'ARC', 90, 50, 30, 25, 30]] })] });
		assert.equal((await runPlan(curved)).executable, false);
		for (const specialShape of [
			['OVAL', 11.8, 63],
			['RECT', 80, 30, 8],
			['NGON', 50, 6],
			['POLYGON', [0, 0, 50, 0, 50, 30, 0, 30]],
		]) {
			const special = install({ pads: [pad('P1', { shape: ['RECT', 40, 40, 0], special: [[1, 1, specialShape]] })] });
			assert.equal((await runPlan(special)).executable, true, `special ${specialShape[0]}`);
		}
		const unknown = install({ pads: [pad('P1', { shape: ['UNKNOWN', 40, 40] })] });
		assert.equal((await runPlan(unknown)).executable, false);
		for (const alias of [['OBLONG', 40, 20], ['RECTANGLE', 80, 30, 8], ['REGULAR_POLYGON', 50, 6], ['POLYLINE_COMPLEX_POLYGON', [0, 0, 50, 0, 50, 30, 0, 30]]]) {
			const f = install({ pads: [pad('P1', { shape: alias })] });
			assert.equal((await runPlan(f)).executable, true, `legacy ${alias[0]}`);
		}
	});

	await test('net selectors separate actual nets and malformed or missing rule dimensions block', async () => {
		const f = install({ pads: [pad('P1', { net: 'N1', x: 400 }), pad('P2', { net: 'N2', x: 600 })] });
		const plan = await runPlan(f, params({ padIds: ['P1', 'P2'] }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.deepEqual(new Set(plan.plannedPrimitives.map(item => item.net)), new Set(['N1', 'N2']));
		assert.equal(plan.targets.length, 2);
		const unknown = install({ rules: { config: { clearance: 0.2, trackWidth: 0.25 } } });
		const noDimensions = await runPlan(unknown, { __docUuid: 'pcb-A', padIds: ['P1'] });
		assert.equal(noDimensions.executable, false);
		assert.match(noDimensions.warnings.join(' '), /viaDiameter/);
	});

	await test('rule fields are not guessed across network-specific DRC entries', async () => {
		const rules = { netRules: [{ net: 'N1', lineLengthMil: 100, trackWidthMil: 8 }, { net: 'N2', lineLengthMil: 200, trackWidthMil: 12 }], clearanceMil: 8, viaDiameterMil: 24, viaHoleDiameterMil: 12 };
		const f = install({ rules });
		const plan = await runPlan(f, { __docUuid: 'pcb-A', padIds: ['P1'], direction: 'N' });
		assert.equal(plan.executable, false);
		assert.match(plan.warnings.join(' '), /lineLength.*lineWidth/);
	});

	await test('hole-to-hole rule reads only supported defaults and reports verification scope', async () => {
		const mm = await runPlan(install({ rules: holeSpacingRules(0.29972, 'mm') }), params({ direction: 'N' }));
		assert.deepEqual(mm.coverage.holeToHoleRule, { verified: true, clearanceMil: 0.29972 * 1000 / 25.4 });
		const mil = await runPlan(install({ rules: holeSpacingRules(11.8, 'mil') }), params({ direction: 'N' }));
		assert.deepEqual(mil.coverage.holeToHoleRule, { verified: true, clearanceMil: 11.8 });
		const zero = await runPlan(install({ rules: holeSpacingRules(0, 'mil') }), params({ direction: 'N' }));
		assert.deepEqual(zero.coverage.holeToHoleRule, { verified: true, clearanceMil: 0 });
		const legacyVia = via('V-no-hole-rule', 900, 900, 10, 5, 0, 'N2');
		legacyVia.getState_HoleDiameter = () => {
			throw new Error('hole getter must not be required without a verified rule');
		};
		const missing = await runPlan(install({ rules: emptyRules, vias: [legacyVia] }), params({ direction: 'N' }));
		assert.equal(missing.executable, true, 'missing hole rule must preserve explicit-request planning');
		assert.deepEqual(missing.coverage.holeToHoleRule, { verified: false, status: 'unverified' });
		assert.match(missing.warnings.join(' '), /孔间距规则未核验.*现有孔间距未核验/);
		const nonDefault = await runPlan(install({ rules: holeSpacingRules(undefined, 'inch', false) }), params({ direction: 'N' }));
		assert.equal(nonDefault.executable, true, 'a non-default rule must not become a new planning precondition');
		assert.deepEqual(nonDefault.coverage.holeToHoleRule, { verified: false, status: 'unverified' });
		for (const rules of [holeSpacingRules(11.8, 'inch'), holeSpacingRules(undefined, 'mm')]) {
			const invalid = await runPlan(install({ rules }), params({ direction: 'N' }));
			assert.equal(invalid.executable, false, 'an unparseable rule explicitly marked as default must fail closed');
			assert.deepEqual(invalid.coverage.holeToHoleRule, { verified: false, status: 'invalid' });
			assert.match(invalid.warnings.join(' '), /默认.*规则错误/);
		}
	});

	await test('existing SDK through-vias contribute their drilled hole size to fanout planning', async () => {
		const existingVia = via('V-existing', 18.211, 80, 10, 12, 0, 'N2');
		const f = install({ vias: [existingVia], rules: holeSpacingRules(11.8, 'mil') });
		const plan = await runPlan(f, params({ direction: 'N', lineLength: 80, lineWidth: 1, viaDiameter: 14, holeDiameter: 8, clearance: 4 }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		const candidateVia = plan.plannedPrimitives.find(item => item.type === 'via');
		assert.ok(candidateVia);
		assert.ok(Math.hypot(candidateVia.center.x - 18.211, candidateVia.center.y - 80) + 1e-6 >= (candidateVia.holeDiameter + 12) / 2 + 11.8, 'a planned via must clear the existing SDK via hole regardless of shared copper clearance');
	});

	await test('planned through-vias enforce the same rule across selected targets', async () => {
		const f = install({
			pads: [pad('P1', { x: 500, y: 500, shape: ['ELLIPSE', 4, 4], net: 'N1' }), pad('P2', { x: 518.211, y: 500, shape: ['ELLIPSE', 4, 4], net: 'N2' })],
			rules: holeSpacingRules(11.8, 'mil'),
		});
		const plan = await runPlan(f, params({ padIds: ['P1', 'P2'], direction: 'N', lineLength: 80, lineWidth: 1, viaDiameter: 14, holeDiameter: 8, clearance: 4 }));
		assert.equal(plan.executable, true, `${plan.warnings.join('; ')} groups=${JSON.stringify(plan.groups)}`);
		const vias = plan.plannedPrimitives.filter(item => item.type === 'via');
		assert.equal(vias.length, 2);
		assert.ok(Math.hypot(vias[0].center.x - vias[1].center.x, vias[0].center.y - vias[1].center.y) + 1e-6 >= (vias[0].holeDiameter + vias[1].holeDiameter) / 2 + 11.8, 'later targets must clear the hole diameter of prior planned vias');
	});

	await test('route segments check minimum distance to every board edge', async () => {
		const edgeLines = [line('O1', 11, -10, -10, 110, -10), line('O2', 11, 110, -10, 110, 110), line('O3', 11, 110, 110, 30, 110), line('O4', 11, 30, 110, 30, 51), line('O5', 11, 30, 51, 20, 51), line('O6', 11, 20, 51, 20, 110), line('O7', 11, 20, 110, -10, 110), line('O8', 11, -10, 110, -10, -10)];
		const f = install({ pads: [pad('P1', { x: 0, y: 50, shape: ['ELLIPSE', 4, 4] })], outlineLines: edgeLines });
		const plan = await runPlan(f, params({ direction: 'E', lineWidth: 8, clearance: 1, viaDiameter: 10, holeDiameter: 5 }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		const pointDistance = (p, a, b) => {
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
			return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
		};
		const orientation = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
		const onSegment = (a, b, p) => p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9;
		const segmentsIntersect = (a, b, c, d) => {
			const o1 = orientation(a, b, c);
			const o2 = orientation(a, b, d);
			const o3 = orientation(c, d, a);
			const o4 = orientation(c, d, b);
			return (o1 * o2 < 0 && o3 * o4 < 0) || (Math.abs(o1) < 1e-9 && onSegment(a, b, c)) || (Math.abs(o2) < 1e-9 && onSegment(a, b, d)) || (Math.abs(o3) < 1e-9 && onSegment(c, d, a)) || (Math.abs(o4) < 1e-9 && onSegment(c, d, b));
		};
		for (const primitive of plan.plannedPrimitives.filter(item => item.type === 'line')) {
			for (const edge of edgeLines) {
				const a = { x: edge.getState_StartX(), y: edge.getState_StartY() };
				const b = { x: edge.getState_EndX(), y: edge.getState_EndY() };
				const distance = segmentsIntersect(primitive.start, primitive.end, a, b) ? 0 : Math.min(pointDistance(primitive.start, a, b), pointDistance(primitive.end, a, b), pointDistance(a, primitive.start, primitive.end), pointDistance(b, primitive.start, primitive.end));
				assert.ok(distance >= 5 - 1e-6, `planned segment is only ${distance} mil from board edge`);
			}
		}
	});

	await test('arc polygon and curved board or hole boundaries fail closed', async () => {
		const arcFill = { getState_PrimitiveId: () => 'F1', getState_Layer: () => 1, getState_LineWidth: () => 0, getState_ComplexPolygon: () => ({ getSource: () => [0, 0, 'ARC', 90, 10, 10, 20, 20, 30, 20] }) };
		const copper = await runPlan(install({ fills: [arcFill] }));
		assert.equal(copper.executable, false);

		const curvedOutline = [line('O1', 11, 0, 0, 1000, 0), line('O2', 11, 1000, 0, 1000, 1000), line('O3', 11, 1000, 1000, 0, 1000), line('O4', 11, 0, 1000, 0, 0)];
		curvedOutline[0] = { ...curvedOutline[0], getState_ArcAngle: () => 30 };
		assert.equal((await runPlan(install({ outlineLines: curvedOutline }))).executable, false);
		assert.equal((await runPlan(install({ holeLines: [line('H1', 47, 300, 300, 700, 300), { ...line('H2', 47, 700, 300, 700, 700), getState_ArcAngle: () => 45 }] }))).executable, false);
		const independentHoleArc = await runPlan(install({ arcs: [arc('A1', 47, 300, 300, 700, 300)] }));
		assert.equal(independentHoleArc.executable, false);
		assert.match(independentHoleArc.warnings.join(' '), /独立圆弧图元.*板框\/板内孔层/);
		assert.equal(independentHoleArc.coverage.geometryReview.status, 'incomplete');
		assert.ok(independentHoleArc.coverage.geometryReview.warnings.some(item => /独立圆弧图元/.test(item)));
		assert.equal((await runPlan(install({ arcs: [arc('A2', 11, 300, 300, 700, 300)] }))).executable, false);
	});

	await test('route search calls shared budget checks during candidate generation', async () => {
		let checks = 0;
		assert.throws(() => planRouteDetailed({ start: { x: 0, y: 0 }, desiredEnd: { x: 100, y: 0 }, net: 'N1', lineWidth: 8, viaDiameter: 24, clearance: 8, maxEndOffset: 100, obstacles: [], checkBudget: () => {
			if (++checks === 5)
				throw new Error('injected shared budget stop');
		} }), /injected shared budget stop/);
		assert.equal(checks, 5);
	});

	await test('final route normalization folds only forward collinear bends and checks the merged segment', async () => {
		const request = overrides => ({
			start: { x: 0, y: 0 },
			desiredEnd: { x: 20, y: 30 },
			net: 'N1',
			lineWidth: 2,
			viaDiameter: 4,
			clearance: 1,
			maxEndOffset: 100,
			obstacles: [],
			...overrides,
		});
		const point = (x, y) => ({ x, y });
		assert.deepEqual(normalizeRoute([point(0, 0), point(10, 10), point(20, 20), point(20, 30)], request({})).points, [point(0, 0), point(20, 20), point(20, 30)]);
		assert.deepEqual(normalizeRoute([point(0, 0), point(10, 10), point(20, 20), point(30, 30)], request({})).points, [point(0, 0), point(30, 30)]);
		assert.deepEqual(normalizeRoute([point(0, 0), point(10, 0), point(10, 10)], request({})).points, [point(0, 0), point(10, 0), point(10, 10)], 'a right-angle bend must remain');
		assert.deepEqual(normalizeRoute([point(0, 0), point(10, 10), point(20, 19)], request({})).points, [point(0, 0), point(10, 10), point(20, 19)], 'a real diagonal kink must remain');
		assert.deepEqual(normalizeRoute([point(0, 0), point(20, 20), point(10, 10)], request({})).points, [point(0, 0), point(20, 20), point(10, 10)], 'a reversed collinear leg must remain');

		const nearCollinear = [point(0, 0), point(10, 10), point(20, 20 + 5e-7)];
		const nearMidpoint = { x: 15, y: 15 + 3.75e-7 };
		const blockedMerge = normalizeRoute(nearCollinear, request({
			lineWidth: 1e-12,
			clearance: 0,
			obstacles: [{ type: 'circle', center: nearMidpoint, radius: 1e-7, net: 'N2' }],
		}));
		assert.deepEqual(blockedMerge.points, nearCollinear, 'the merged near-collinear segment must be rechecked against obstacles');
		assert.equal(blockedMerge.safeToExecute, false, 'a rejected near-collinear merge must block plan execution');

		const throwAtNormalizationCheck = () => {
			throw new Error('injected normalization budget stop');
		};
		assert.throws(() => normalizeRoute([point(0, 0), point(10, 10), point(20, 20)], request({ checkBudget: throwAtNormalizationCheck })), /injected normalization budget stop/);
	});

	await test('real 200-pad MCU automatic fanout completes uncapped search with safe routes', async () => {
		const fixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/fanout-mcu-200.json'), 'utf8'));
		const pads = fixture.pads.map(item => pad(item.id, item));
		const { maxX, minY } = fixture.outline;
		const outlineLines = [
			line('MCU-O1', 11, 0, 0, maxX, 0),
			line('MCU-O2', 11, maxX, 0, maxX, minY),
			line('MCU-O3', 11, maxX, minY, 0, minY),
			line('MCU-O4', 11, 0, minY, 0, 0),
		];
		const f = install({ pads, outlineLines, rules: defaultHoleRules });
		const startedAt = Date.now();
		const plan = await runPlan(f, {
			__docUuid: 'pcb-A',
			componentIds: [fixture.input.componentId],
			direction: fixture.input.direction,
			lineLength: fixture.input.lineLength,
			lineWidth: fixture.input.lineWidth,
			viaDiameter: fixture.input.viaDiameter,
			holeDiameter: fixture.input.holeDiameter,
			clearance: fixture.input.clearance,
			_timeoutMs: 60000,
		});
		console.log('MCU top full plan', JSON.stringify({ checkedCandidates: plan.coverage.checkedCandidates, plannedPrimitives: plan.plannedPrimitives.length, elapsedMs: Date.now() - startedAt }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.coverage.complete, true);
		assert.equal(plan.coverage.searchLimited, false);
		assert.equal(plan.coverage.pads, 200);
		assert.equal(plan.groups.length, 100);
		assert.ok(plan.groups.every(group => group.planned && !group.searchLimited && group.terminationReason === 'route-found'), 'every real MCU target must have a complete, safety-checked route');
		assert.ok(plan.coverage.checkedCandidates > 0);
		assert.ok(plan.plannedPrimitives.length > 0);
		assert.deepEqual(plan.coverage.holeToHoleRule, { verified: true, clearanceMil: 0.29972 * 1000 / 25.4 });
		const plannedVias = plan.plannedPrimitives.filter(item => item.type === 'via');
		for (let i = 0; i < plannedVias.length; i++) {
			for (let j = i + 1; j < plannedVias.length; j++) {
				const centerDistance = Math.hypot(plannedVias[i].center.x - plannedVias[j].center.x, plannedVias[i].center.y - plannedVias[j].center.y);
				assert.ok(centerDistance + 1e-6 >= (plannedVias[i].holeDiameter + plannedVias[j].holeDiameter) / 2 + plan.coverage.holeToHoleRule.clearanceMil, `via holes ${i}/${j} violate their edge clearance`);
			}
		}
		assert.equal(f.state.writes.length, 0, 'planning this fixture must remain read-only');
	});

	await test('real 200-pad MCU bottom routes pass geometry recheck and mock execution', async () => {
		const fixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/fanout-mcu-200.json'), 'utf8'));
		const pads = fixture.pads.map(item => pad(item.id, item));
		const { maxX, minY } = fixture.outline;
		const outlineLines = [
			line('MCU-O1', 11, 0, 0, maxX, 0),
			line('MCU-O2', 11, maxX, 0, maxX, minY),
			line('MCU-O3', 11, maxX, minY, 0, minY),
			line('MCU-O4', 11, 0, minY, 0, 0),
		];
		const f = install({ pads, outlineLines, mergeCollinearLines: true, rules: defaultHoleRules });
		const startedAt = Date.now();
		const plan = await runPlan(f, {
			__docUuid: 'pcb-A',
			componentIds: ['ie5'],
			direction: '8directions',
			lineLength: 80,
			lineWidth: 5,
			viaDiameter: 14,
			holeDiameter: 7,
			clearance: 4,
		});
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.coverage.pads, 200);
		assert.equal(plan.coverage.searchLimited, false);
		assert.equal(plan.groups.length, 100);
		assert.ok(plan.groups.every(group => group.planned && !group.searchLimited && group.terminationReason === 'route-found'));
		assert.deepEqual(plan.coverage.holeToHoleRule, { verified: true, clearanceMil: 0.29972 * 1000 / 25.4 });
		const plannedVias = plan.plannedPrimitives.filter(item => item.type === 'via');
		for (let i = 0; i < plannedVias.length; i++) {
			for (let j = i + 1; j < plannedVias.length; j++) {
				const centerDistance = Math.hypot(plannedVias[i].center.x - plannedVias[j].center.x, plannedVias[i].center.y - plannedVias[j].center.y);
				assert.ok(centerDistance + 1e-6 >= (plannedVias[i].holeDiameter + plannedVias[j].holeDiameter) / 2 + plan.coverage.holeToHoleRule.clearanceMil, `via holes ${i}/${j} violate their edge clearance`);
			}
		}
		const targetPrimitives = plan.plannedPrimitives.filter(item => item.targetId === 'ie5ie80');
		const targetLines = targetPrimitives.filter(item => item.type === 'line');
		assert.equal(targetLines.length, 2);
		assert.equal(targetPrimitives.filter(item => item.type === 'via').length, 1);
		assert.ok(targetLines.every(item => [item.start.x, item.start.y, item.end.x, item.end.y].every(Number.isFinite)));
		const result = await runExecute(f, plan);
		assert.equal(result.completed, plan.plannedPrimitives.length);
		console.log('MCU bottom full plan plus geometry recheck', JSON.stringify({ checkedCandidates: plan.coverage.checkedCandidates, plannedPrimitives: plan.plannedPrimitives.length, elapsedMs: Date.now() - startedAt }));
		const writtenTargetLines = f.state.writes.filter(item => item.kind === 'line' && item.net === 'U2_P075');
		assert.equal(writtenTargetLines.length, 2);
		assert.deepEqual(writtenTargetLines.map(item => ({ start: item.start, end: item.end })), targetLines.map(item => ({ start: item.start, end: item.end })));
	});

	await test('route search keeps direct routes, detours, endpoint offsets, no-route and budget outcomes correct', async () => {
		const request = overrides => ({ start: { x: 0, y: 0 }, desiredEnd: { x: 100, y: 0 }, net: 'N1', lineWidth: 2, viaDiameter: 4, clearance: 1, maxEndOffset: 100, obstacles: [], ...overrides });
		const epsilon = 1e-6;
		const best = { length: 100, pointCount: 4 };
		const controlledCandidates = [
			{ name: 'equal length, fewer bends', length: 100, pointCount: 2, improves: true },
			{ name: 'slightly longer within epsilon, fewer bends', length: 100 + epsilon / 2, pointCount: 2, improves: true },
			{ name: 'longer than epsilon', length: 100 + epsilon * 2, pointCount: 2, improves: false },
		];
		for (const candidate of controlledCandidates) {
			const admittedByPrune = candidate.length < best.length
				|| (Math.abs(candidate.length - best.length) <= epsilon && candidate.pointCount < best.pointCount);
			const acceptedByBestUpdate = candidate.length < best.length
				|| (Math.abs(candidate.length - best.length) <= epsilon && candidate.pointCount < best.pointCount);
			assert.equal(admittedByPrune, candidate.improves, `${candidate.name}: early prune must keep candidates accepted by the original best-route comparator`);
			assert.equal(acceptedByBestUpdate, candidate.improves, `${candidate.name}: best-route comparator outcome`);
		}
		const holeRouteRequest = (overrides = {}) => request({
			start: { x: 0, y: 0 },
			desiredEnd: { x: 0, y: 100 },
			lineWidth: 1,
			viaDiameter: 14,
			viaHoleDiameter: 8,
			viaHoleToHoleClearance: 11.8,
			clearance: 4,
			maxEndOffset: 0,
			obstacles: [{ type: 'circle', center: { x: 18.211, y: 100 }, radius: 5, holeRadius: 6, net: 'N2' }],
			...overrides,
		});
		const forbiddenHoleEdgeDistance = planRouteDetailed(holeRouteRequest());
		assert.equal(forbiddenHoleEdgeDistance.route, null, '18.211mil center distance clears copper geometry but violates the 21.8mil drilled-hole spacing');
		const sameNetHole = planRouteDetailed(holeRouteRequest({ obstacles: [{ type: 'circle', center: { x: 18.211, y: 100 }, radius: 5, holeRadius: 6, net: 'N1' }] }));
		assert.equal(sameNetHole.route, null, 'same-net vias still obey hole-to-hole spacing');
		const copperOnlyCircle = planRouteDetailed(holeRouteRequest({ obstacles: [{ type: 'circle', center: { x: 18.211, y: 100 }, radius: 5, net: 'N2' }] }));
		assert.equal(copperOnlyCircle.terminationReason, 'route-found', 'ordinary copper circles without drilled-hole geometry do not use this rule');
		const differentDrill = planRouteDetailed(holeRouteRequest({ viaHoleDiameter: 4 }));
		assert.equal(differentDrill.route, null, 'candidate and existing via drill sizes both contribute to edge spacing');
		const smallerExistingDrill = planRouteDetailed(holeRouteRequest({ obstacles: [{ type: 'circle', center: { x: 18.211, y: 100 }, radius: 5, holeRadius: 2, net: 'N2' }] }));
		assert.equal(smallerExistingDrill.terminationReason, 'route-found', 'a smaller actual existing drill reduces the required center spacing');
		const zeroRule = planRouteDetailed(holeRouteRequest({ viaHoleToHoleClearance: 0 }));
		assert.equal(zeroRule.terminationReason, 'route-found', 'explicit zero hole spacing is a valid rule value');
		const physicalViaObstacle = { type: 'circle', center: { x: 0, y: 0 }, radius: 7, holeRadius: 3.5, net: 'N2' };
		const endpointSeparatedRequest = request({
			start: { x: 10, y: -30 },
			desiredEnd: { x: 50, y: 0 },
			lineWidth: 2,
			viaDiameter: 14,
			viaHoleDiameter: 7,
			viaHoleToHoleClearance: 11.8,
			clearance: 1,
			obstacles: [physicalViaObstacle],
		});
		const legalNearHoleLine = normalizeRoute([{ x: 10, y: -30 }, { x: 10, y: -15 }, { x: 10, y: 0 }, { x: 50, y: 0 }], endpointSeparatedRequest);
		assert.equal(legalNearHoleLine.safeToExecute, true, 'a copper-clear line ending 10mil from a via hole is legal when the actual final via is 50mil away');
		assert.deepEqual(legalNearHoleLine.points.at(-1), { x: 50, y: 0 });
		const illegalViaEndpoint = planRouteDetailed(request({
			start: { x: 18.211, y: -30 },
			desiredEnd: { x: 18.211, y: 0 },
			lineWidth: 2,
			viaDiameter: 14,
			viaHoleDiameter: 7,
			viaHoleToHoleClearance: 11.8,
			clearance: 1,
			maxEndOffset: 0,
			obstacles: [physicalViaObstacle],
		}));
		assert.equal(illegalViaEndpoint.route, null, 'the 18.211mil endpoint must be rejected by the via hole check even though copper clearance passes');
		const abCases = [
			{ name: 'direct', params: {} },
			{ name: 'detour', params: { obstacles: [{ type: 'circle', center: { x: 50, y: 0 }, radius: 15, net: 'N2' }] } },
			{ name: 'no route', params: { obstacles: [{ type: 'segment', start: { x: 50, y: -1000 }, end: { x: 50, y: 1000 }, radius: 0, net: 'N2' }], maxEndOffset: 10 } },
			{ name: 'candidate limit', params: { desiredEnd: { x: 100, y: 40 }, maxCandidates: 5 } },
		];
		for (const { name, params } of abCases) {
			const input = request(params);
			const before = planRouteDetailedBefore(input);
			const after = planRouteDetailed(input);
			assert.deepEqual(after, before, `${name}: optimized collision pruning must preserve route, candidate count, and termination`);
		}
		const fineChannelRequest = request({
			lineWidth: 1,
			viaDiameter: 1,
			clearance: 0.1,
			maxEndOffset: 100,
			boardPolygons: [[{ x: -1, y: -10 }, { x: 101, y: -10 }, { x: 101, y: 6 }, { x: -1, y: 6 }]],
			obstacles: [{ type: 'segment', start: { x: 5, y: -10 }, end: { x: 5, y: 3 }, radius: 0, net: 'N2' }],
		});
		const fineChannel = planRouteDetailed(fineChannelRequest);
		assert.equal(fineChannel.terminationReason, 'route-found', 'fine samples must reach the narrow in-board channel above the obstacle');
		assert.ok(fineChannel.route.points.some(point => point.y >= 3.9 && point.y <= 5.4));
		assert.ok(100 / 6 > 5.4 && 100 / 8 > 5.4, 'the prior six bend and eight endpoint samples both fell outside this board window');
		assert.equal(normalizeRoute(fineChannel.route.points, fineChannelRequest).safeToExecute, true, 'the discovered fine-sample path must pass independent route geometry normalization');
		const direct = planRouteDetailed(request({}));
		assert.equal(direct.terminationReason, 'route-found');
		assert.equal(direct.checkedCandidates, 1);
		assert.deepEqual(direct.route.points, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
		for (const desiredEnd of [{ x: 0, y: 0 }, { x: 5e-7, y: 0 }]) {
			const degenerate = planRouteDetailed(request({ desiredEnd, maxEndOffset: 0 }));
			assert.equal(degenerate.route, null);
			assert.equal(degenerate.terminationReason, 'candidate-search-exhausted');
			assert.equal(degenerate.checkedCandidates, 0);
		}

		const detour = planRouteDetailed(request({ obstacles: [{ type: 'circle', center: { x: 50, y: 0 }, radius: 15 }] }));
		assert.equal(detour.terminationReason, 'route-found');
		assert.ok(detour.route.points.length >= 3, 'blocked direct path should use a bend');
		assert.ok(detour.checkedCandidates > 1);
		let segmentChecks = 0;
		const countingObstacle = {
			type: 'circle',
			center: { x: 50, y: 0 },
			radius: 15,
			net: 'N2',
			get trackCollision() {
				segmentChecks++;
				return undefined;
			},
		};
		const cachedRequest = request({ obstacles: [countingObstacle], maxEndOffset: 0 });
		const cachedDetour = planRouteDetailed(cachedRequest);
		assert.equal(cachedDetour.terminationReason, 'route-found');
		assert.ok(segmentChecks < cachedDetour.checkedCandidates, 'repeated directed segments should reuse exact clear/blocked results');
		const firstRequestChecks = segmentChecks;
		assert.equal(planRouteDetailed(cachedRequest).terminationReason, 'route-found');
		assert.equal(segmentChecks - firstRequestChecks, firstRequestChecks, 'identical later requests must perform their own segment checks');
		const noObstacle = planRouteDetailed(request({ maxEndOffset: 0 }));
		assert.equal(noObstacle.route.points.length, 2, 'a different request must not inherit the earlier blocked-segment result');

		let throwOnFirstGeometryCheck = true;
		let throwingGeometryReads = 0;
		const throwingObstacle = { type: 'circle', center: { x: 1000, y: 1000 }, radius: 1, net: 'N2', get trackCollision() {
			throwingGeometryReads++;
			if (throwOnFirstGeometryCheck) {
				throwOnFirstGeometryCheck = false;
				throw new Error('injected geometry failure');
			}
			return undefined;
		} };
		const retryRequest = request({ obstacles: [throwingObstacle], maxEndOffset: 0 });
		assert.throws(() => planRouteDetailed(retryRequest), /injected geometry failure/);
		assert.equal(planRouteDetailed(retryRequest).terminationReason, 'route-found');
		assert.equal(throwingGeometryReads, 2, 'a thrown geometry check must not become a cached result');

		const originalMapGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get');
		let cacheHitSeen = false;
		// The test temporarily instruments Map.get to observe the private segment cache without a production hook.
		// eslint-disable-next-line no-extend-native
		Object.defineProperty(Map.prototype, 'get', {
			...originalMapGet,
			value(key) {
				const result = originalMapGet.value.call(this, key);
				if (typeof result === 'boolean' && typeof key === 'string' && key.includes('>'))
					cacheHitSeen = true;
				return result;
			},
		});
		try {
			assert.throws(() => planRouteDetailed(request({
				obstacles: [{ type: 'circle', center: { x: 0, y: 0 }, radius: 15, net: 'N2' }],
				maxEndOffset: 0,
				checkBudget: () => {
					if (cacheHitSeen)
						throw new Error('injected cache-hit budget stop');
				},
			})), /injected cache-hit budget stop/);
			assert.equal(cacheHitSeen, true, 'the budget stop must occur after an exact segment-cache hit');
		}
		finally {
			// eslint-disable-next-line no-extend-native
			Object.defineProperty(Map.prototype, 'get', originalMapGet);
		}

		const offsetVia = planRouteDetailed(request({ obstacles: [{ type: 'circle', center: { x: 100, y: 0 }, radius: 15 }], viaDiameter: 10, clearance: 2, maxEndOffset: 40 }));
		assert.equal(offsetVia.terminationReason, 'route-found');
		assert.ok(offsetVia.route.endOffset > 0, 'blocked desired via should move to a valid endpoint');

		const blocked = planRouteDetailed(request({ obstacles: [{ type: 'segment', start: { x: 50, y: -1000 }, end: { x: 50, y: 1000 }, radius: 0 }], maxEndOffset: 10 }));
		assert.equal(blocked.route, null);
		assert.equal(blocked.searchLimited, false);
		assert.equal(blocked.terminationReason, 'candidate-search-exhausted');
		assert.ok(blocked.checkedCandidates > 0);

		const candidateLimited = planRouteDetailed(request({ desiredEnd: { x: 100, y: 40 }, maxCandidates: 1 }));
		assert.ok(candidateLimited.route, 'the best route found before the limit is retained');
		assert.equal(candidateLimited.checkedCandidates, 1);
		assert.equal(candidateLimited.searchLimited, true);
		assert.equal(candidateLimited.terminationReason, 'candidate-limit');

		const timeLimited = planRouteDetailed(request({ desiredEnd: { x: 100, y: 40 }, timeLimitMs: -1000 }));
		assert.equal(timeLimited.route, null);
		assert.equal(timeLimited.checkedCandidates, 0);
		assert.equal(timeLimited.searchLimited, true);
		assert.equal(timeLimited.terminationReason, 'candidate-limit');

		const originalNow = Date.now;
		let now = 1000;
		let budgetChecks = 0;
		Date.now = () => now;
		let timedAfterRoute;
		try {
			timedAfterRoute = planRouteDetailed(request({
				desiredEnd: { x: 100, y: 40 },
				maxEndOffset: 0,
				timeLimitMs: 10,
				checkBudget: () => {
					if (++budgetChecks === 675)
						now = 1011;
				},
			}));
		}
		finally {
			Date.now = originalNow;
		}
		assert.ok(timedAfterRoute.checkedCandidates > 1);
		assert.ok(timedAfterRoute.route, 'a valid best route remains available when the time limit interrupts later search');
		assert.equal(timedAfterRoute.searchLimited, true);
		assert.equal(timedAfterRoute.terminationReason, 'candidate-limit');
	});

	await test('through-hole via obstacles apply across layers and missing board boundary blocks', async () => {
		const f = install({ vias: [via('V-BOTTOM', 500, 600, 160)] });
		const plan = await runPlan(f);
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.groups[0].planned, true);
		const plannedVia = plan.plannedPrimitives.find(item => item.type === 'via');
		assert.ok(plannedVia);
		assert.ok(Math.hypot(plannedVia.center.x - 500, plannedVia.center.y - 600) > 100, 'the relocated via must clear the through-hole via obstacle');
		const noOutline = install({ outline: false });
		assert.equal((await runPlan(noOutline)).executable, false);
	});

	await test('batch target collisions are planned in order', async () => {
		const f = install({ pads: [pad('P1', { x: 400 }), pad('P2', { x: 600 })] });
		const plan = await runPlan(f, params({ padIds: ['P1', 'P2'], direction: 'N', viaDiameter: 24, staggerLength: 80 }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.groups.length, 2);
		assert.equal(plan.plannedPrimitives.filter(item => item.type === 'via').length, 2);
	});

	await test('baseline and edited plan are rejected before any write', async () => {
		const f = install();
		const plan = await runPlan(f);
		f.state.source += `\n${JSON.stringify({ type: 'TRACK', id: 'external', ticket: 1 })}||${JSON.stringify({ layer: 1 })}|`;
		await assert.rejects(runExecute(f, plan), /基线已变化/);
		assert.equal(f.state.writes.length, 0);
		const g = install();
		const tampered = await runPlan(g);
		tampered.plannedPrimitives[0].end.x += 1;
		await assert.rejects(runExecute(g, tampered), /当前 PCB 不一致/);
		assert.equal(g.state.writes.length, 0);
	});

	await test('document target guard catches same-UUID project or tab changes before and after first write', async () => {
		const before = install();
		const beforePlan = await runPlan(before);
		const capturedTarget = { projectUuid: 'project-A', documentUuid: 'pcb-A', tabId: 'pcb-A@project-A' };
		let currentTarget = { ...capturedTarget, projectUuid: 'project-B', tabId: 'pcb-A@project-B' };
		const beforeContext = {
			assertDocumentTarget: async () => {
				if (currentTarget.projectUuid !== capturedTarget.projectUuid || currentTarget.tabId !== capturedTarget.tabId)
					throw new Error('同 UUID 文档的项目或 tab 身份已变化');
			},
		};
		const prewriteError = await runExecute(before, beforePlan, beforeContext).then(() => assert.fail('changed project/tab must reject'), error => error);
		assert.match(prewriteError.message, /项目或 tab 身份已变化/);
		assert.equal(before.state.writes.length, 0);

		for (const changedField of ['projectUuid', 'tabId']) {
			const during = install();
			const duringPlan = await runPlan(during);
			let identity = { ...capturedTarget };
			during.sdk.dmt_SelectControl.getCurrentDocumentInfo = async () => {
				identity = { ...identity, [changedField]: 'changed-during-focus-read' };
				return { uuid: capturedTarget.documentUuid, documentType: 3 };
			};
			const context = { assertDocumentTarget: async () => {
				if (identity.projectUuid !== capturedTarget.projectUuid || identity.tabId !== capturedTarget.tabId)
					throw new Error('same UUID target changed during focus getter');
			} };
			const error = await runExecute(during, duringPlan, context).then(() => assert.fail('getter-time target change must reject'), caught => caught);
			assert.match(error.message, /target changed during focus getter/);
			assert.equal(during.state.writes.length, 0);
		}

		const after = install();
		const afterPlan = await runPlan(after);
		currentTarget = { ...capturedTarget };
		const afterContext = {
			assertDocumentTarget: async () => {
				if (after.state.writes.length > 0) {
					currentTarget = { ...capturedTarget, tabId: 'pcb-A@other-tab' };
					throw new Error('首写后同 UUID tab 身份已变化');
				}
			},
		};
		const postwriteError = await runExecute(after, afterPlan, afterContext).then(() => assert.fail('post-write target change must stop'), error => error);
		assert.match(postwriteError.message, /首写后同 UUID tab 身份已变化/);
		assert.equal(after.state.writes.length, 1);
		assert.equal(postwriteError.cause?.partial, true);
		assert.equal(postwriteError.cause?.retryable, false);

		const normal = install();
		const normalPlan = await runPlan(normal);
		let normalGuardCalls = 0;
		const normalResult = await runExecute(normal, normalPlan, { assertDocumentTarget: async () => { normalGuardCalls++; } });
		assert.ok(normalGuardCalls > 0);
		assert.equal(normalResult.completed, normalPlan.plannedPrimitives.length);
	});

	await test('readback mismatch or create failure stops later writes and reports partial state', async () => {
		const f = install();
		const plan = await runPlan(f);
		f.state.mismatchReadback = true;
		const error = await runExecute(f, plan).then(() => assert.fail('mismatched readback should fail'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(f.state.writes.length, 1);
		assert.equal(error.cause.createdIds.length, 1);
		assert.equal(error.cause.notAttemptedSteps, plan.plannedPrimitives.length - 1);
		assert.deepEqual(error.cause.notAttemptedIndices, Array.from({ length: plan.plannedPrimitives.length - 1 }, (_, index) => index + 1));

		const g = install();
		const otherPlan = await runPlan(g);
		g.state.failCreate = 'line';
		const failed = await runExecute(g, otherPlan).then(() => assert.fail('empty create should fail'), caught => caught);
		assert.match(failed.message, /创建返回空值/);
		assert.equal(g.state.writes.length, 1);
		assert.equal(failed.cause?.notAttemptedSteps, otherPlan.plannedPrimitives.length - 1);
	});

	await test('mocked SDK line and via requests match ID readback without inferring host persistence', async () => {
		const f = install({ pads: [pad('P1', { x: 410.125, y: 390.375 })] });
		const plan = await runPlan(f, params({ direction: 'N', lineLength: 31.625, lineWidth: 6.375, viaDiameter: 21.125, holeDiameter: 10.375, clearance: 3.125 }));
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		const result = await runExecute(f, plan);
		assert.equal(result.saved, false);
		assert.equal(result.readback.length, plan.plannedPrimitives.length);
		for (let index = 0; index < plan.plannedPrimitives.length; index++) {
			const primitive = plan.plannedPrimitives[index];
			const write = f.state.writes[index];
			const actual = result.readback[index].actual;
			assert.equal(result.readback[index].verified, true);
			if (primitive.type === 'line') {
				assert.deepEqual(write, { kind: 'line', layer: primitive.layer, net: primitive.net, start: primitive.start, end: primitive.end, width: primitive.lineWidth });
				assert.deepEqual(actual, { id: actual.id, net: primitive.net, layer: primitive.layer, startX: primitive.start.x, startY: primitive.start.y, endX: primitive.end.x, endY: primitive.end.y, lineWidth: primitive.lineWidth });
			}
			else {
				assert.deepEqual(write, { kind: 'via', type: 0, net: primitive.net, x: primitive.center.x, y: primitive.center.y, holeDiameter: primitive.holeDiameter, diameter: primitive.diameter });
				assert.deepEqual(actual, { id: actual.id, net: primitive.net, x: primitive.center.x, y: primitive.center.y, diameter: primitive.diameter, holeDiameter: primitive.holeDiameter, viaType: 0 });
			}
		}
	});

	console.log(`fanout regression passed: ${passed}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
