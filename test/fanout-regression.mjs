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
			contents: `import { fanoutCommands } from '../src/commands/fanout.ts'; import { normalizeRoute, planRouteDetailed } from '../src/pcb/fanout/fanout-routing.ts'; import { planRouteDetailed as planRouteDetailedBefore } from '../../fanout-mcu-20261011/129-before/fanout-routing.ts'; export { fanoutCommands, normalizeRoute, planRouteDetailed, planRouteDetailedBefore }`,
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
	const { fanoutCommands, normalizeRoute, planRouteDetailed, planRouteDetailedBefore } = await import(moduleUrl);
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

	function install({ pads = [pad('P1')], vias = [], fills = [], pours = [], poured = [], arcs = [], holeLines = [], outlinePolylines = [], rules = emptyRules, focusUuid = 'pcb-A', outline = true, outlineLines, mergeCollinearLines = false, editorVersion = null } = {}) {
		const state = { writes: [], reads: [], source: docHead(focusUuid), rules, pads: [...pads], vias: [...vias], fills: [...fills], arcs: [...arcs], holeLines: [...holeLines], lines: [], created: new Map(), nextId: 1, failCreate: undefined, mismatchReadback: false, mergeCollinearLines };
		if (outlineLines)
			state.lines = outlineLines;
		else if (outline)
			state.lines = [line('O1', 11, 0, 0, 1000, 0), line('O2', 11, 1000, 0, 1000, 1000), line('O3', 11, 1000, 1000, 0, 1000), line('O4', 11, 0, 1000, 0, 0)];
		const result = {
			state,
			sdk: {
				dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: focusUuid, documentType: 3 }) },
				sys_Environment: { getEditorCurrentVersion: () => editorVersion },
				sys_FileManager: { getDocumentSource: async () => state.source },
				pcb_Drc: { getCurrentRuleConfiguration: async () => state.rules },
				pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL' }, { id: 2, type: 'SIGNAL' }, { id: 15, type: 'SIGNAL' }, { id: 16, type: 'PLANE' }] },
				pcb_PrimitivePad: { getAll: async () => [...state.pads] },
				pcb_PrimitiveComponent: { getAll: async () => [] },
				pcb_PrimitiveLine: {
					getAll: async (_net, layer) => layer === 47 ? [...state.holeLines] : [...state.lines],
					create: async (net, layer, x1, y1, x2, y2, width) => {
						state.writes.push({ kind: 'line', layer, net, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
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
						state.writes.push({ kind: 'via', type, net });
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
	async function runExecute(fixture, plan) {
		return command('pcb.fanout').handler({ __docUuid: 'pcb-A', plan });
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
		assert.equal(f.state.writes.length, 0);
	});

	await test('native R bounds and zero-width poured copper keep coordinate coverage explicit', async () => {
		const rectangle = ['R', 250, 450, 200, 100, 0, 0];
		const equivalent = [250, 450, 'L', 450, 450, 450, 350, 250, 350, 250, 450];
		const pour = path => ({ getState_PrimitiveId: () => 'pour-host', getState_Layer: () => 2, getState_LineWidth: () => 0.2, getState_ComplexPolygon: () => ({ getSource: () => path }) });
		const region = (width, path, coordinateUnit = 'mil') => ({ getState_PrimitiveId: () => 'poured-host', getState_PourPrimitiveId: () => 'pour-host', getState_PourFills: () => [{ id: 'fill-host', fill: true, lineWidth: width, ...(coordinateUnit ? { coordinateUnit } : {}), path: { getSource: () => path } }] });
		const inner = [446, 354, 'L', 254, 354, 254, 446, 446, 446, 446, 354];
		const r = await runPlan(install({ pours: [pour(rectangle)], poured: [region(0, inner)] }));
		const l = await runPlan(install({ pours: [pour(equivalent)], poured: [region(0, inner)] }));
		assert.equal(r.coverage.complete, true, r.warnings.join('; '));
		assert.equal(r.coverage.obstacles, l.coverage.obstacles);
		assert.deepEqual(r.plannedPrimitives, l.plannedPrimitives, 'native R and equivalent L must produce the same obstacle location');
		assert.equal(r.coverage.obstacles, (await runPlan(install())).coverage.obstacles + 2, 'width zero retains the filled polygon as an obstacle');
		assert.equal((await runPlan(install({ pours: [pour(rectangle)], poured: [region(0, equivalent)] }))).coverage.complete, true, 'points on the parent boundary remain readable');
		const outside = [249, 450, 'L', 450, 450, 450, 350, 249, 350, 249, 450];
		assert.equal((await runPlan(install({ pours: [pour(rectangle)], poured: [region(0, outside)] }))).coverage.complete, false, 'clearly outside points must not be accepted');
		for (const width of [-1, undefined, '0', NaN, Infinity]) {
			const invalid = await runPlan(install({ pours: [pour(rectangle)], poured: [region(width, inner)] }));
			assert.equal(invalid.coverage.complete, false);
		}
		const observedScale = [44.6, 35.4, 'L', 25.4, 35.4, 25.4, 44.6, 44.6, 44.6, 44.6, 35.4];
		const unverified = await runPlan(install({ pours: [pour(rectangle)], poured: [region(0, observedScale)] }));
		assert.equal(unverified.coverage.complete, false);
		assert.equal(unverified.executable, false);
		assert.match(unverified.warnings.join('; '), /归一化后与父边框坐标不一致/);
		for (const path of [['R', 250, 450, 200, 100, 90, 0], ['R', 250, 450, 200, 100, 0, 5]]) {
			assert.equal((await runPlan(install({ pours: [pour(path)] }))).coverage.complete, false, 'unverified rotation or rounding must not be approximated as a rectangle');
		}
		const rawFirst = [29.6, 10.4, 'L', 10.399999999999995, 10.4, 10.4, 19.6, 29.60000000000001, 19.6, 29.6, 10.4];
		const first10Mil = await runPlan(install({ editorVersion: '4.1.78', pours: [pour(['R', 100, 200, 200, 100, 0, 0])], poured: [region(0, rawFirst, null)] }));
		assert.equal(first10Mil.coverage.complete, true, first10Mil.warnings.join('; '));
		const rawSecond = [89.6, 10.4, 'L', 60.4, 10.4, 60.4, 24.6, 89.6, 24.6, 89.6, 10.4];
		const second10Mil = await runPlan(install({ editorVersion: '4.1.78', pours: [pour(['R', 600, 250, 300, 150, 0, 0])], poured: [region(0, rawSecond, null)] }));
		assert.equal(second10Mil.coverage.complete, true, second10Mil.warnings.join('; '));
		const oldTranslated10Mil = await runPlan(install({ editorVersion: '4.1.78', pours: [pour(rectangle)], poured: [region(0, [44.6, 35.4, 'L', 25.4, 35.4, 25.4, 44.6, 44.6, 44.6, 44.6, 35.4], null)] }));
		assert.equal(oldTranslated10Mil.coverage.complete, true, oldTranslated10Mil.warnings.join('; '));
		const unverifiedVersion = await runPlan(install({ editorVersion: '4.2.0', pours: [pour(['R', 100, 200, 200, 100, 0, 0])], poured: [region(0, rawFirst, null)] }));
		assert.equal(unverifiedVersion.coverage.complete, false, 'EDA 4.2 path units are not guessed');
		assert.match(unverifiedVersion.warnings.join('; '), /host-version-unverified-for-conversion/);
		const unverifiedStroke = await runPlan(install({ editorVersion: '4.1.78', pours: [pour(['R', 100, 200, 200, 100, 0, 0])], poured: [region(0.1, rawFirst, null)] }));
		assert.equal(unverifiedStroke.coverage.complete, false, 'nonzero fill stroke remains unsupported');
	});

	await test('polygon-only rectangular outline is normalized into the closed board boundary', async () => {
		const f = install({ pads: [pad('P1', { x: 300, y: 0 })], outline: false, outlinePolylines: [outlinePolyline('BOARD-R', ['R', -200, 500, 1000, 1000, 0, 0])] });
		const plan = await runPlan(f);
		assert.equal(plan.executable, true, plan.warnings.join('; '));
		assert.equal(plan.coverage.boardPolygons, 1);
		assert.equal(f.state.writes.length, 0);
	});

	await test('multiple supported board polylines remain separate closed routing regions', async () => {
		const f = install({
			pads: [pad('P1', { x: 300, y: 0 })],
			outline: false,
			outlinePolylines: [
				outlinePolyline('BOARD-R1', ['R', -200, 500, 1000, 1000, 0, 0]),
				outlinePolyline('BOARD-R2', ['R', 2000, 500, 1000, 1000, 0, 0]),
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

	console.log(`fanout regression passed: ${passed}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
