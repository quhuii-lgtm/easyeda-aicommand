import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { fanoutCommands } from '../src/commands/fanout.ts'; import { planRouteDetailed } from '../src/pcb/fanout/fanout-routing.ts'; export { fanoutCommands, planRouteDetailed }`,
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
	const { fanoutCommands, planRouteDetailed } = await import(moduleUrl);
	const command = name => fanoutCommands.find(item => item.name === name);
	const docHead = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid, client: 'fanout-test' })}|`;
	const emptyRules = { config: { spacingMil: 8 }, name: 'test' };

	function pad(id, { x = 500, y = 500, layer = 1, net = 'N1', shape = ['ELLIPSE', 40, 40], rotation = 0, hole = null } = {}) {
		return {
			getState_PrimitiveId: () => id,
			getState_X: () => x,
			getState_Y: () => y,
			getState_Layer: () => layer,
			getState_PadNumber: () => '1',
			getState_Net: () => net,
			getState_Pad: () => shape,
			getState_SpecialPad: () => [],
			getState_Hole: () => hole,
			getState_Rotation: () => rotation,
			getState_ParentComponentPrimitiveId: () => undefined,
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

	function install({ pads = [pad('P1')], vias = [], fills = [], arcs = [], holeLines = [], rules = emptyRules, focusUuid = 'pcb-A', outline = true, outlineLines } = {}) {
		const state = { writes: [], reads: [], source: docHead(focusUuid), rules, pads: [...pads], vias: [...vias], fills: [...fills], arcs: [...arcs], holeLines: [...holeLines], lines: [], created: new Map(), nextId: 1, failCreate: undefined, mismatchReadback: false };
		if (outlineLines)
			state.lines = outlineLines;
		else if (outline)
			state.lines = [line('O1', 11, 0, 0, 1000, 0), line('O2', 11, 1000, 0, 1000, 1000), line('O3', 11, 1000, 1000, 0, 1000), line('O4', 11, 0, 1000, 0, 0)];
		const result = {
			state,
			sdk: {
				dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: focusUuid, documentType: 3 }) },
				sys_FileManager: { getDocumentSource: async () => state.source },
				pcb_Drc: { getCurrentRuleConfiguration: async () => state.rules },
				pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL' }, { id: 2, type: 'SIGNAL' }, { id: 15, type: 'SIGNAL' }, { id: 16, type: 'PLANE' }] },
				pcb_PrimitivePad: { getAll: async () => [...state.pads] },
				pcb_PrimitiveComponent: { getAll: async () => [] },
				pcb_PrimitiveLine: {
					getAll: async (_net, layer) => layer === 47 ? [...state.holeLines] : [...state.lines],
					create: async (net, layer, x1, y1, x2, y2, width) => {
						state.writes.push({ kind: 'line', layer, net });
						if (state.failCreate === 'line')
							return undefined;
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
				pcb_PrimitivePour: { getAll: async () => [] },
				pcb_PrimitivePoured: { getAll: async () => [] },
				pcb_PrimitiveRegion: { getAll: async () => [] },
				pcb_PrimitivePolyline: { getAll: async () => [] },
			},
		};
		globalThis.eda = result.sdk;
		return result;
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
	async function test(name, fn) {
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

	await test('through-hole via obstacles apply across layers and missing board boundary blocks', async () => {
		const f = install({ vias: [via('V-BOTTOM', 500, 600, 160)] });
		const plan = await runPlan(f);
		assert.equal(plan.executable, false);
		assert.equal(plan.groups[0].planned, false);
		assert.equal(plan.plannedPrimitives.length, 0);
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
