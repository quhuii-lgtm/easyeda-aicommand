import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import { build, transform } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { autoCopperCommands } from '../src/commands/autoCopper.ts'; import { comparePolygonSource } from '../src/pcb/autoCopper/geometryReadback.ts'; import { configureCopperRuntime } from '../src/pcb/autoCopper/runtime.ts'; import namespace from '../src/pcb/autoCopper/namespace.ts'; export { autoCopperCommands, comparePolygonSource, configureCopperRuntime, namespace }`,
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
	const { autoCopperCommands, comparePolygonSource, configureCopperRuntime, namespace } = await import(moduleUrl);
	const coreSource = readFileSync(resolve(root, 'src/pcb/autoCopper/upstream/core.js'), 'utf8');
	const counterMarker = 'function countCoveredTargetContours(polygonPointsList, targetKeepInContours = []) {';
	const counterStart = coreSource.indexOf(counterMarker);
	assert.notEqual(counterStart, -1, 'production coverage counter must remain present');
	const bodyStart = counterStart + counterMarker.length;
	let bodyEnd = bodyStart;
	let braceDepth = 1;
	for (; bodyEnd < coreSource.length && braceDepth > 0; bodyEnd++) {
		if (coreSource[bodyEnd] === '{')
			braceDepth++;
		else if (coreSource[bodyEnd] === '}')
			braceDepth--;
	}
	assert.equal(braceDepth, 0, 'production coverage counter must be balanced');
	const countCoveredTargetContours = runInNewContext(
		`(function countCoveredTargetContours(polygonPointsList, targetKeepInContours = []) {${coreSource.slice(bodyStart, bodyEnd - 1)}})`,
		{ polygonCoversContour: namespace.AutoCopperPour.polygonUtils.polygonCoversContour, roundCoordinate: namespace.AutoCopperPour.geometryUtils.roundCoordinate },
	);
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
	function componentPad(id, options = {}) {
		return { ...pad(id, options), getState_PrimitiveType: () => 'ComponentPad' };
	}
	function line(id, x1, y1, x2, y2, width = 0.1, layer = 11, net = '') {
		return { getState_PrimitiveId: () => id, getState_PrimitiveType: () => 'Line', getState_Layer: () => layer, getState_StartX: () => x1, getState_StartY: () => y1, getState_EndX: () => x2, getState_EndY: () => y2, getState_LineWidth: () => width, getState_Net: () => net };
	}
	function via(id, x, y, net = 'N1', diameter = 24) {
		return { getState_PrimitiveId: () => id, getState_X: () => x, getState_Y: () => y, getState_Diameter: () => diameter, getState_Net: () => net, getState_ViaType: () => 0, getState_Layer: () => 12 };
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
	function install({ pads = [pad('LONG-PAD-1')], components = [], vias = [], pours = [], existingPoured = [], traces = [], outline = true, outlineOffset = { x: 0, y: 0 }, outlinePolylines = [], rulesValue = rules, badPadCollection = false, fillReadbackNet = undefined, pourReadbackSource = undefined, pourReadbackNet = undefined, pourReadbackLayer = undefined, parentReadbackId = undefined, parentReadbackNet = undefined, parentReadbackLayer = undefined, parentReadbackSource = undefined, pouredConfig = {}, rebuildResult = true, rebuildResultUndefined = false, rebuildReturnValue = undefined, rebuildThrows = false, createDelayMs = 0, editorVersion = '4.1.78' } = {}) {
		const state = { writes: [], deletions: 0, pads: [...pads], components: [...components], vias: [...vias], source: docHead('pcb-A'), rules: rulesValue, nextId: 1, pourGetCalls: new Map(), pours: new Map(pours.map(item => [item.getState_PrimitiveId(), item])), fills: new Map(), poured: [...existingPoured], rebuildResult, rebuildResultUndefined, rebuildReturnValue, rebuildThrows, pouredGetAllCalls: 0, fillReadbackNet, pourReadbackSource, pourReadbackNet, pourReadbackLayer, parentReadbackId, parentReadbackNet, parentReadbackLayer, parentReadbackSource, pouredConfig, createDelayMs };
		const x0 = outlineOffset.x;
		const y0 = outlineOffset.y;
		const outlineLines = outline ? [line('O1', x0, y0, x0 + 1000, y0), line('O2', x0 + 1000, y0, x0 + 1000, y0 + 1000), line('O3', x0 + 1000, y0 + 1000, x0, y0 + 1000), line('O4', x0, y0 + 1000, x0, y0)] : [];
		const polygon = source => ({ getSource: () => source });
		const sdk = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'pcb-A', documentType: 3 }) },
			sys_Environment: { getEditorCurrentVersion: () => editorVersion },
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
			pcb_PrimitivePolyline: { getAll: async () => [...outlinePolylines] },
			pcb_PrimitivePoured: {
				getAll: async () => {
					state.pouredGetAllCalls++;
					return [...state.poured];
				},
			},
			pcb_PrimitivePour: {
				getAll: async () => [...state.pours.values()],
				create: async (net, layer, complexPolygon) => {
					state.writes.push('pour.create');
					const id = `POUR-${state.nextId++}`;
					const obj = { getState_PrimitiveId: () => id, getState_Net: () => net, getState_Layer: () => layer, getState_ComplexPolygon: () => complexPolygon, rebuildCopperRegion: async () => {
						state.writes.push('pour.rebuild');
						if (state.rebuildThrows)
							throw new Error('rebuild transport failed');
						if (state.rebuildResult) {
							const config = state.pouredConfig;
							const source = typeof config.source === 'function' ? config.source(complexPolygon.getSource()) : config.source ?? complexPolygon.getSource();
							const region = config.region ?? { id: `REGION-${id}`, fill: true, lineWidth: 12, path: { getSource: () => source } };
							const item = { getState_PrimitiveId: () => `POURED-${id}`, getState_PourPrimitiveId: () => config.pourId ?? id, getState_PourFills: () => config.noFills ? [] : [region] };
							state.poured.push(item);
						}
						return state.rebuildResultUndefined ? undefined : state.rebuildReturnValue ?? state.rebuildResult;
					} };
					state.pours.set(id, obj);
					state.source += `\n${JSON.stringify({ type: 'POUR', id, ticket: 1 })}||${JSON.stringify({ order: 1, netName: net, layerId: layer, name: `Auto Copper ${net}` })}|`;
					return obj;
				},
				get: async (id) => {
					const original = state.pours.get(id);
					if (!original)
						return original;
					const getCount = (state.pourGetCalls.get(id) ?? 0) + 1;
					state.pourGetCalls.set(id, getCount);
					const createdPour = id.startsWith('POUR-');
					const useParentOverride = !createdPour || getCount >= 3;
					const readbackSource = useParentOverride && state.parentReadbackSource !== undefined ? state.parentReadbackSource : state.pourReadbackSource;
					const source = typeof readbackSource === 'function'
						? readbackSource(original.getState_ComplexPolygon().getSource())
						: readbackSource ?? original.getState_ComplexPolygon().getSource();
					const readbackId = useParentOverride ? state.parentReadbackId : undefined;
					const readbackNet = useParentOverride && state.parentReadbackNet !== undefined ? state.parentReadbackNet : state.pourReadbackNet;
					const readbackLayer = useParentOverride && state.parentReadbackLayer !== undefined ? state.parentReadbackLayer : state.pourReadbackLayer;
					if (readbackSource === undefined && readbackId === undefined && readbackNet === undefined && readbackLayer === undefined)
						return original;
					return {
						getState_PrimitiveId: () => readbackId ?? id,
						getState_Net: () => readbackNet ?? original.getState_Net(),
						getState_Layer: () => readbackLayer ?? original.getState_Layer(),
						getState_ComplexPolygon: () => polygon(source),
						rebuildCopperRegion: original.rebuildCopperRegion,
					};
				},
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
	function outlinePolyline(id, source, { layer = 11, width = 0.1, missingPolygonGetter = false } = {}) {
		return {
			getState_PrimitiveId: () => id,
			getState_Layer: () => layer,
			getState_LineWidth: () => width,
			...(!missingPolygonGetter ? { getState_Polygon: () => ({ getSource: () => source }) } : {}),
		};
	}
	function ringVertices(source) {
		const raw = Array.isArray(source[0]) ? source[0] : source;
		const points = [{ x: raw[0], y: raw[1] }];
		for (let index = 3; index < raw.length - 2; index += 2)
			points.push({ x: raw[index], y: raw[index + 1] });
		return points;
	}
	function ringSource(points, { close = true, wrap = false } = {}) {
		const last = close ? [points[0].x, points[0].y] : [];
		const source = [points[0].x, points[0].y, 'L', ...points.slice(1).flatMap(point => [point.x, point.y]), ...last];
		return wrap ? [source] : source;
	}
	function reorderedSource(source, { reverse = false, start = 0, wrap = false } = {}) {
		let points = ringVertices(source);
		if (reverse)
			points = [...points].reverse();
		points = [...points.slice(start), ...points.slice(0, start)];
		return ringSource(points, { wrap });
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
		assert.deepEqual(autoCopperCommands.map(item => item.name), ['pcb.getAutoCopperPlan', 'pcb.autoCopper', 'pcb.getPourFillReadback']);
		assert.equal(typeof command('pcb.getAutoCopperPlan').handler, 'function');
		assert.equal(typeof command('pcb.getPourFillReadback').handler, 'function');
	});

	await test('single-ring comparison accepts only exact cyclic or reversed vertices and keeps multi-ring sources strict', async () => {
		const ring = [0, 0, 'L', 20, 0, 20, 20, 0, 20, 0, 0];
		assert.deepEqual(comparePolygonSource(ring, reorderedSource(ring, { reverse: true })), { matches: true, mode: 'single-ring-cyclic-or-reversed' });
		assert.deepEqual(comparePolygonSource(ring, reorderedSource(ring, { start: 2, wrap: true })), { matches: true, mode: 'single-ring-cyclic-or-reversed' });
		const triangle = [0, 0, 'L', 20, 0, 20, 20, 0, 0];
		assert.deepEqual(comparePolygonSource(triangle, reorderedSource(triangle, { reverse: true })), { matches: true, mode: 'single-ring-cyclic-or-reversed' });
		assert.deepEqual(comparePolygonSource(triangle, reorderedSource(triangle, { start: 1, wrap: true })), { matches: true, mode: 'single-ring-cyclic-or-reversed' });
		const rings = [ring, [40, 0, 'L', 60, 0, 60, 20, 40, 20, 40, 0]];
		assert.deepEqual(comparePolygonSource(rings, rings), { matches: true, mode: 'strict-source' });
		assert.deepEqual(comparePolygonSource(rings, [...rings].reverse()), { matches: false, mode: 'strict-source-mismatch' });
		const microExpansion = [-0.0004, 0, 'L', 20, 0, 20, 20, 0, 20, -0.0004, 0];
		assert.deepEqual(comparePolygonSource(ring, microExpansion), { matches: false, mode: 'single-ring-cyclic-or-reversed' }, 'sub-mil differences must never be rounded into body equivalence');
		assert.deepEqual(comparePolygonSource(ring, [ring, rings[1]]), { matches: false, mode: 'strict-source-mismatch' }, 'an extra ring must prevent single-body equivalence');
	});

	await test('local exact decimal rectangle proof handles bounded decimal edges and rejects unsupported contours', async () => {
		const commandSource = readFileSync(resolve(root, 'src/commands/autoCopper.ts'), 'utf8');
		const extractFunction = name => {
			const marker = `function ${name}(`;
			const start = commandSource.indexOf(marker);
			assert.notEqual(start, -1, `production helper ${name} must remain present`);
			const bodyStart = commandSource.indexOf('{', start + marker.length);
			let bodyEnd = bodyStart;
			let depth = 0;
			for (; bodyEnd < commandSource.length; bodyEnd++) {
				if (commandSource[bodyEnd] === '{') depth++;
				else if (commandSource[bodyEnd] === '}' && --depth === 0) { bodyEnd++; break; }
			}
			assert.ok(bodyEnd > bodyStart, `production helper ${name} must be balanced`);
			return commandSource.slice(start, bodyEnd);
		};
		const helperSource = ['exactDecimal', 'addExactDecimals', 'negateExactDecimal', 'halfExactDecimal', 'compareExactDecimals', 'assessExactDecimalRectBody'].map(extractFunction).join('\n');
		const helperJs = (await transform(helperSource, { loader: 'ts' })).code;
		const assess = runInNewContext(`${helperJs}; assessExactDecimalRectBody`, { finite: value => typeof value === 'number' && Number.isFinite(value) });
		const zeroCrossing = [ -16, -16.5, 'L', 15, -16.5, 15, 16.5, -16, 16.5, -16, -16.5 ];
		assert.equal(assess({ x: -0.5, y: -0, shapeWidth: 31, shapeHeight: 33 }, zeroCrossing), 'equal');
		assert.equal(assess({ x: -0.5, y: -0, shapeWidth: 31, shapeHeight: 33 }, [15, 16.5, 'L', 15, -16.5, -16, -16.5, -16, 16.5, 15, 16.5]), 'equal', 'cyclic starts and reversed order are accepted');
		assert.equal(assess({ x: 1e-7, y: -1e-7, shapeWidth: 2e-7, shapeHeight: 4e-7 }, [0, -3e-7, 'L', 2e-7, -3e-7, 2e-7, 1e-7, 0, 1e-7, 0, -3e-7]), 'equal', 'scientific notation remains exact');
		assert.equal(assess({ x: 370.3004, y: 400, shapeWidth: 31.8, shapeHeight: 34 }, [354.4, 383, 'L', 386.2, 383, 386.2, 417, 354.4, 417, 354.4, 383]), 'different', 'a representable micro expansion is not shortened');
		assert.equal(assess({ x: 370.3, y: 400, shapeWidth: 31.8, shapeHeight: 34 }, [354.40000000000003, 383, 'L', 386.2, 383, 386.2, 417, 354.4, 417, 354.40000000000003, 383]), 'different', 'an explicit binary-artifact coordinate keeps its full Number string');
		assert.equal(assess({ x: 1, y: 1, shapeWidth: 0, shapeHeight: 2 }, [1, 0, 'L', 1, 0, 1, 2, 1, 2, 1, 0]), 'unsupported', 'degenerate body dimensions cannot prove equivalence');
		assert.equal(assess({ x: 0, y: 0, shapeWidth: 2, shapeHeight: 2 }, [ -1, -1, 'L', 1, -1, 1, 1, 0, 1, -1, 1, -1, -1 ]), 'unsupported', 'extra contour vertices cannot prove equivalence');
		assert.equal(assess({ x: 0, y: 0, shapeWidth: 2, shapeHeight: 2 }, [[-1, -1, 'L', 1, -1, 1, 1, -1, 1, -1, -1], [4, 4, 'L', 5, 4, 5, 5, 4, 5, 4, 4]]), 'unsupported', 'additional rings cannot prove equivalence');
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

	await test('24 mil via target at fractional-sensitive coordinates remains covered after clipping precision normalization', async () => {
		const f = install({ pads: [], vias: [via('V24', 1000, -748)], outlineOffset: { x: 500, y: -1248 } });
		const result = await plan(params({ targetIds: ['V24'], expansion: 30 }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.equal(result.targets[0].id, 'V24');
		assert.equal(f.state.writes.length, 0);
	});

	await test('24 mil via coverage remains stable under fractional coordinate translation', async () => {
		const shift = 0.0004;
		const f = install({ pads: [], vias: [via('V24-SHIFTED', 1000 + shift, -748 - shift)], outlineOffset: { x: 500 + shift, y: -1248 - shift } });
		const result = await plan(params({ targetIds: ['V24-SHIFTED'], expansion: 30 }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.equal(result.targets[0].id, 'V24-SHIFTED');
		assert.equal(f.state.writes.length, 0);
	});

	await test('clipping that removes part of the target contour remains uncovered after precision normalization', async () => {
		const polygonCoversContour = namespace.AutoCopperPour.polygonUtils.polygonCoversContour;
		const roundCoordinate = namespace.AutoCopperPour.geometryUtils.roundCoordinate;
		const targetContour = Array.from({ length: 12 }, (_, index) => {
			const angle = index * Math.PI / 6;
			return { x: 1000 + Math.cos(angle) * 12, y: -748 + Math.sin(angle) * 12 };
		});
		const completeRoundedRing = targetContour.map(point => ({ x: roundCoordinate(point.x), y: roundCoordinate(point.y) }));
		const clippedRingMissingArc = [{ x: 1000, y: -748 }, { x: 1013, y: -748 }, { x: 1013, y: -735 }, { x: 1000, y: -735 }, { x: 1000, y: -748 }];
		assert.equal(countCoveredTargetContours([completeRoundedRing], [targetContour], polygonCoversContour, roundCoordinate), 1);
		assert.equal(countCoveredTargetContours([clippedRingMissingArc], [targetContour], polygonCoversContour, roundCoordinate), 0);
	});

	await test('polygon-only R rectangle closes the board and reports its raw source', async () => {
		const f = install({ pads: [pad('CENTER-PAD', { x: 300, y: 0 })], outline: false, outlinePolylines: [outlinePolyline('BOARD-R', ['R', -200, 500, 1000, 1000, 0, 0])] });
		const result = await plan(params({ targetIds: ['CENTER-PAD'] }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.equal(result.coverage.boardOutline.lineRingCount, 1);
		assert.deepEqual(result.coverage.boardOutline.polylines, [{ id: 'BOARD-R', source: ['R', -200, 500, 1000, 1000, 0, 0], lineCount: 4 }]);
		assert.ok(result.plannedPrimitives.length > 0);
		assert.equal(f.state.writes.length, 0);
	});

	await test('multiple supported board polylines are read but remain rejected by the single-ring copper policy', async () => {
		const f = install({
			pads: [pad('CENTER-PAD', { x: 300, y: 0 })],
			outline: false,
			outlinePolylines: [
				outlinePolyline('BOARD-R1', ['R', -200, 500, 1000, 1000, 0, 0]),
				outlinePolyline('BOARD-R2', ['R', 2000, 500, 1000, 1000, 0, 0]),
			],
		});
		const result = await plan(params({ targetIds: ['CENTER-PAD'] }));
		assert.equal(result.executable, false);
		assert.equal(result.coverage.boardOutline.lineRingCount, 2);
		assert.equal(result.coverage.boardOutline.polylines.length, 2);
		assert.equal(f.state.writes.length, 0);
	});

	await test('R outline rejects outside and touching targets', async () => {
		for (const target of [
			pad('TOP-OUTSIDE', { x: 300, y: 510 }),
			pad('BOTTOM-OUTSIDE', { x: 300, y: -510 }),
			pad('LEFT-EDGE', { x: -200, y: 0 }),
		]) {
			const f = install({ pads: [target], outline: false, outlinePolylines: [outlinePolyline('BOARD-R', ['R', -200, 500, 1000, 1000, 0, 0])] });
			const result = await plan(params({ targetIds: [target.getState_PrimitiveId()] }));
			assert.equal(result.executable, false, JSON.stringify(result.coverage.unresolved));
			assert.equal(f.state.writes.length, 0);
		}
	});

	await test('unsupported, malformed, unavailable and additional board polylines block execution', async () => {
		for (const source of [
			['R', -200, 500, 1000, 1000, 15, 0],
			['R', -200, 500, 1000, 1000, 0, 5],
			['R', -200, 500, 0, 1000, 0, 0],
			['R', Number.MAX_VALUE, 500, 1000, 10, 0, 0],
		]) {
			const f = install({ outline: false, outlinePolylines: [outlinePolyline('BOARD-R', source)] });
			assert.equal((await plan(params())).executable, false);
			assert.equal(f.state.writes.length, 0);
		}
		const missingGetter = install({ outline: false, outlinePolylines: [outlinePolyline('NO-POLYGON', undefined, { missingPolygonGetter: true })] });
		assert.equal((await plan(params())).executable, false);
		assert.equal(missingGetter.state.writes.length, 0);
		const invalidId = install({ outline: false, outlinePolylines: [outlinePolyline(7, ['R', -200, 500, 1000, 1000, 0, 0])] });
		assert.equal((await plan(params())).executable, false);
		assert.equal(invalidId.state.writes.length, 0);
		const secondBoard = install({ outline: false, outlinePolylines: [
			outlinePolyline('BOARD-R', ['R', -200, 500, 1000, 1000, 0, 0]),
			outlinePolyline('BOARD-UNKNOWN', ['P', 0, 0, 1, 1]),
		] });
		assert.equal((await plan(params())).executable, false);
		assert.equal(secondBoard.state.writes.length, 0);
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

	await test('single-pad one-sided foreign obstacle reports blocker and rejects only proven pad-body-only pour', async () => {
		const f = install({
			pads: [
				pad('ACE_IN_A', { x: 500, y: 500, shape: ['RECT', 61.8, 100, 0] }),
				pad('FOREIGN-RIGHT', { x: 570, y: 500, net: 'net$1N1', shape: ['RECT', 40, 24, 0] }),
			],
			rulesValue: { config: { spacingMil: 10 } },
		});
		const result = await plan(params({ targetIds: ['ACE_IN_A'], expansion: 15 }));
		assert.equal(result.executable, false);
		assert.ok(result.coverage.unresolved.some(item => /ACE_IN_A.*15mil.*不满足局部扩铜目标/.test(item)));
		const reduction = result.warnings.find(item => item.code === 'upstreamExpansionReduced');
		assert.ok(reduction);
		const targetReduction = reduction.resolved.find(item => item.id === 'ACE_IN_A');
		assert.equal(targetReduction.boundaryMargin, 0);
		assert.deepEqual(targetReduction.blockers.map(item => ({ id: item.primitiveId, net: item.net, clearanceMil: item.clearanceMil, rulePath: item.clearanceRulePath })), [
			{ id: 'FOREIGN-RIGHT', net: 'net$1N1', clearanceMil: 10, rulePath: targetReduction.blockers[0].clearanceRulePath },
		]);
		assert.equal(targetReduction.blockers[0].trigger, 'firstTrigger');
		assert.ok(targetReduction.blockers[0].clearanceRulePath);
		assert.equal(result.warnings.find(item => item.code === 'localCopperExpansionAssessment').status, 'proven-no-expansion');
		const stablePlan = await plan(params({ targetIds: ['ACE_IN_A'], expansion: 15 }));
		assert.deepEqual(stablePlan, result, 'repeated plan generation must preserve blocker and equivalence evidence');
		const rejectedExecution = await execute(result).then(() => assert.fail('body-only local pour plan must not execute'), caught => caught);
		assert.match(rejectedExecution.message, /当前对象状态生成的计划不可执行/);
		assert.deepEqual(f.state.writes, [], 'non-executable plan must not write or rebuild');
	});

	await test('component pin with 50 mil request and zero margin is proven body-only and execution is rejected before writes', async () => {
		const targetOptions = { x: 370.3, y: 400, net: 'ACE_IN_A', shape: ['RECT', 31.8, 34, 0] };
		const blockerOptions = { x: 429.7, y: 400, net: '$1N1', shape: ['RECT', 31.8, 34, 0] };
		const targetPin = componentPad('COMPONENT-TARGET-PIN', targetOptions);
		const blockerPin = componentPad('COMPONENT-BLOCKER-PIN', blockerOptions);
		const component = { getState_PrimitiveId: () => 'COMPONENT-50MIL', getAllPins: async () => [targetPin, blockerPin] };
		const f = install({
			pads: [pad('COMPONENT-TARGET-PIN', targetOptions), pad('COMPONENT-BLOCKER-PIN', blockerOptions)],
			components: [component],
			rulesValue: { config: { spacingMil: 10 } },
		});
		const result = await plan(params({ targetIds: ['COMPONENT-50MIL'], net: 'ACE_IN_A', expansion: 50 }));
		const plannedTarget = result.targets.find(item => item.id === 'COMPONENT-TARGET-PIN');
		assert.ok(plannedTarget);
		assert.equal(plannedTarget.type, 'ComponentPad');
		assert.equal(plannedTarget.x, 370.3);
		assert.equal(plannedTarget.shapeWidth, 31.8);
		assert.equal(plannedTarget.shapeHeight, 34);
		assert.equal(result.executable, false, JSON.stringify({ targets: result.targets, groups: result.groups, coverage: result.coverage, warnings: result.warnings }));
		assert.ok(result.coverage.unresolved.some(item => /50mil.*不满足局部扩铜目标/.test(item)));
		const reduction = result.warnings.find(item => item.code === 'upstreamExpansionReduced');
		assert.ok(reduction);
		assert.equal(reduction.resolved.find(item => item.id === 'COMPONENT-TARGET-PIN').boundaryMargin, 0);
		assert.equal(result.warnings.find(item => item.code === 'localCopperExpansionAssessment').status, 'proven-no-expansion');
		const error = await execute(result).then(() => assert.fail('body-only component plan must not execute'), caught => caught);
		assert.match(error.message, /当前对象状态生成的计划不可执行/);
		assert.deepEqual(f.state.writes, [], 'rejected component plan must not create or rebuild');
	});

	await test('component pin with a real sub-mil expansion remains uncertain and executable', async () => {
		const targetOptions = { x: 370.3004, y: 400, net: 'ACE_IN_A', shape: ['RECT', 31.8, 34, 0] };
		const blockerOptions = { x: 429.7, y: 400, net: '$1N1', shape: ['RECT', 31.8, 34, 0] };
		const targetPin = componentPad('COMPONENT-MICRO-PIN', targetOptions);
		const blockerPin = componentPad('COMPONENT-MICRO-BLOCKER-PIN', blockerOptions);
		const component = { getState_PrimitiveId: () => 'COMPONENT-MICRO', getAllPins: async () => [targetPin, blockerPin] };
		install({
			pads: [pad('COMPONENT-MICRO-PIN', targetOptions), pad('COMPONENT-MICRO-BLOCKER-PIN', blockerOptions)],
			components: [component],
			rulesValue: { config: { spacingMil: 10 } },
		});
		const result = await plan(params({ targetIds: ['COMPONENT-MICRO'], net: 'ACE_IN_A', expansion: 50 }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		assert.equal(result.warnings.find(item => item.code === 'localCopperExpansionAssessment').status, 'uncertain');
		const bodyMinX = targetOptions.x - 31.8 / 2;
		const plannedMinX = Math.min(...result.plannedPrimitives[0].points.map(point => point.x));
		assert.ok(plannedMinX < bodyMinX && bodyMinX - plannedMinX < 0.001, `expected sub-mil extension, got ${bodyMinX - plannedMinX}mil`);
	});

	await test('sub-0.001 outward contour difference remains uncertain and is never rounded into body-only rejection', async () => {
		install({
			pads: [
				pad('MICRO-PAD', { x: 500.0004, y: 500, shape: ['RECT', 61.8, 100, 0] }),
				pad('MICRO-BLOCKER', { x: 570, y: 500, net: 'N2', shape: ['RECT', 40, 24, 0] }),
			],
			rulesValue: { config: { spacingMil: 10 } },
		});
		const result = await plan(params({ targetIds: ['MICRO-PAD'], expansion: 15 }));
		assert.equal(result.executable, true);
		const assessment = result.warnings.find(item => item.code === 'localCopperExpansionAssessment');
		assert.equal(assessment.status, 'uncertain');
		const bodyMinX = 500.0004 - 61.8 / 2;
		const plannedMinX = Math.min(...result.plannedPrimitives[0].points.map(point => point.x));
		assert.ok(plannedMinX < bodyMinX && bodyMinX - plannedMinX < 0.001, `expected micro extension, got ${bodyMinX - plannedMinX}mil`);
	});

	await test('multiple blocker attribution is stable across obstacle API order', async () => {
		const target = pad('ACE_IN_A', { x: 500, y: 500, shape: ['RECT', 61.8, 100, 0] });
		const blockerA = pad('A-BLOCKER', { x: 570, y: 500, net: 'N2', shape: ['RECT', 40, 24, 0] });
		const blockerZ = pad('Z-BLOCKER', { x: 575, y: 500, net: 'N3', shape: ['RECT', 40, 24, 0] });
		install({ pads: [target, blockerZ, blockerA], rulesValue: { config: { spacingMil: 10 } } });
		const first = await plan(params({ targetIds: ['ACE_IN_A'], expansion: 15 }));
		install({ pads: [target, blockerA, blockerZ], rulesValue: { config: { spacingMil: 10 } } });
		const second = await plan(params({ targetIds: ['ACE_IN_A'], expansion: 15 }));
		const firstBlocker = first.warnings.find(item => item.code === 'upstreamExpansionReduced').resolved.find(item => item.id === 'ACE_IN_A').blockers[0];
		const secondBlocker = second.warnings.find(item => item.code === 'upstreamExpansionReduced').resolved.find(item => item.id === 'ACE_IN_A').blockers[0];
		assert.equal(firstBlocker.primitiveId, 'A-BLOCKER');
		assert.equal(secondBlocker.primitiveId, 'A-BLOCKER');
		assert.equal(firstBlocker.trigger, 'firstTrigger');
		assert.deepEqual(firstBlocker, secondBlocker);
	});

	await test('ordinary no-blocker expansion remains executable and non-reduced', async () => {
		install({ pads: [pad('RECT-PAD', { x: 500, y: 500, shape: ['RECT', 61.8, 100, 0] })] });
		const result = await plan(params({ targetIds: ['RECT-PAD'], expansion: 15 }));
		assert.equal(result.executable, true);
		assert.equal(result.warnings.some(item => item.code === 'localCopperExpansionAssessment'), false);
		assert.equal(result.warnings.some(item => item.code === 'upstreamExpansionReduced'), false);
		assert.ok(result.plannedPrimitives.length > 0);
	});

	if (process.env.AUTO_COPPER_MARGIN_EXPERIMENT === '1') {
		await test('offline margin discriminator compares full expansion and in-memory pre-reduction bypass', async () => {
			const area = points => Math.abs(points.reduce((sum, point, index) => {
				const next = points[(index + 1) % points.length];
				return sum + point.x * next.y - next.x * point.y;
			}, 0) / 2);
			const clipRect = (points, rect) => {
				let output = points;
				for (const [inside, cross] of [
					[point => point.x >= rect.minX, (a, b) => ({ x: rect.minX, y: a.y + (b.y - a.y) * (rect.minX - a.x) / (b.x - a.x) })],
					[point => point.x <= rect.maxX, (a, b) => ({ x: rect.maxX, y: a.y + (b.y - a.y) * (rect.maxX - a.x) / (b.x - a.x) })],
					[point => point.y >= rect.minY, (a, b) => ({ x: a.x + (b.x - a.x) * (rect.minY - a.y) / (b.y - a.y), y: rect.minY })],
					[point => point.y <= rect.maxY, (a, b) => ({ x: a.x + (b.x - a.x) * (rect.maxY - a.y) / (b.y - a.y), y: rect.maxY })],
				]) {
					const input = output;
					output = [];
					if (!input.length)
						break;
					let previous = input[input.length - 1];
					for (const current of input) {
						const a = inside(previous);
						const b = inside(current);
						if (b) {
							if (!a)
								output.push(cross(previous, current));
							output.push(current);
						}
						else if (a) {
							output.push(cross(previous, current));
						}
						previous = current;
					}
				}
				return output;
			};
			const requireClearanceSafe = (measurement, label, toleranceMil2) => {
				assert.ok(measurement.rectangularForbiddenZoneModelIntersectionMil2 <= toleranceMil2, `${label} target body intersects the rectangular forbidden-zone model`);
			};
			const measure = (sources, body, forbidden) => {
				const fragments = sources.map((source) => {
					const parts = Array.isArray(source?.[0]) ? source : namespace.AutoCopperPour.polygonUtils.getPolygonSourceParts(source);
					return parts.map(part => namespace.AutoCopperPour.polygonUtils.makePointsFromFlatPolygonSource(part));
				});
				const signedRectIntersection = rect => fragments.reduce((total, rings) => total + rings.reduce((sum, ring, index) => {
					const clipped = clipRect(ring, rect);
					return sum + (index === 0 ? 1 : -1) * (clipped.length >= 3 ? area(clipped) : 0);
				}, 0), 0);
				const totalArea = fragments.reduce((total, rings) => total + rings.reduce((sum, ring, index) => sum + (index === 0 ? 1 : -1) * area(ring), 0), 0);
				const targetArea = (body.maxX - body.minX) * (body.maxY - body.minY);
				const targetCoveredArea = signedRectIntersection(body);
				const allPoints = fragments.flat(2);
				return {
					areaMil2: totalArea,
					copperOutsidePadBodyMil2: Math.max(0, totalArea - targetCoveredArea),
					rectangularForbiddenZoneModelIntersectionMil2: Math.max(0, signedRectIntersection(forbidden)),
					targetAreaMil2: targetArea,
					targetCoveredAreaMil2: targetCoveredArea,
					sourceCount: sources.length,
					fragmentCount: fragments.length,
					ringCount: fragments.reduce((sum, rings) => sum + rings.length, 0),
					holeCount: fragments.reduce((sum, rings) => sum + Math.max(0, rings.length - 1), 0),
					bounds: { minX: Math.min(...allPoints.map(point => point.x)), minY: Math.min(...allPoints.map(point => point.y)), maxX: Math.max(...allPoints.map(point => point.x)), maxY: Math.max(...allPoints.map(point => point.y)) },
					outsideBoardVertexCount: allPoints.filter(point => point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 1000).length,
				};
			};
			const narrowBoundaryPairs = (points) => {
				const segments = namespace.AutoCopperPour.polygonUtils.makeBoundarySegments(points);
				const pairs = [];
				let closestPair;
				let minWidthMil = Number.POSITIVE_INFINITY;
				const thresholdMil = namespace.AutoCopperPour.constants.MIN_AVOIDANCE_NECK_WIDTH;
				for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
					for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex++) {
						const indexDistance = Math.abs(firstIndex - secondIndex);
						if (indexDistance <= 1 || indexDistance === segments.length - 1)
							continue;
						const first = segments[firstIndex];
						const second = segments[secondIndex];
						const widthMil = namespace.AutoCopperPour.polygonUtils.segmentToSegmentDistance(first.start, first.end, second.start, second.end);
						if (widthMil < minWidthMil) {
							minWidthMil = widthMil;
							closestPair = { first: { index: firstIndex, start: first.start, end: first.end }, second: { index: secondIndex, start: second.start, end: second.end }, widthMil };
						}
						if (widthMil < thresholdMil) {
							pairs.push({
								first: { index: firstIndex, start: first.start, end: first.end },
								second: { index: secondIndex, start: second.start, end: second.end },
								widthMil,
							});
						}
					}
				}
				return { thresholdMil, pairs, closestPair, minWidthMil: Number.isFinite(minWidthMil) ? minWidthMil : null };
			};
			const forbiddenIntersectionToleranceMil2 = 0.01;
			const makeBodySource = body => [body.minX, body.minY, 'L', body.maxX, body.minY, body.maxX, body.maxY, body.minX, body.maxY, body.minX, body.minY];
			const targetHalfWidth = 31.8 / 2;
			const targetHalfHeight = 34 / 2;
			const obstacleHalfWidth = 31.8 / 2;
			const obstacleHalfHeight = 34 / 2;
			const runRawChain = async (sdk, target, expansion, skipPreReduction, usePadBodyProtection = false, body = undefined) => {
				const host = { documentUuid: 'pcb-A', read: async (_label, callback) => await callback(), checkBudget() {} };
				const { upstream, core } = configureCopperRuntime(sdk, host);
				const layer = 1;
				const net = target.net;
				const targets = [target];
				const drc = await upstream.drcRules.getPcbDrcRuleContext();
				const boundary = upstream.drcRules.applyDrcClearanceToObstacles(await upstream.targetCollectors.collectCopperObstacles(targets, net, layer), net, drc, 'boundary', { generationType: 'pour', layer });
				const avoidance = upstream.drcRules.applyDrcClearanceToObstacles(await upstream.targetCollectors.collectCopperObstacles(targets, net, layer, { includeMultiPads: true, includeRegions: true }), net, drc, 'avoidance', { generationType: 'pour', layer });
				const edgeShield = await upstream.targetCollectors.collectPadEdgeShieldObstacles(targets, layer);
				const trace = upstream.drcRules.applyDrcClearanceToObstacles(await upstream.targetCollectors.collectTraceClipObstacles(targets, net, layer), net, drc, 'trace clipping', { generationType: 'pour', layer });
				const copperArea = upstream.drcRules.applyDrcClearanceToObstacles(await upstream.targetCollectors.collectCopperAreaClipObstacles(targets, net, layer), net, drc, 'copper area clipping', { generationType: 'pour', layer });
				const config = { ...upstream.constants.DEFAULT_CONFIG, generationType: 'pour', targetLayer: layer, expansion, padBboxExpansion: expansion, enableChamfer: false, chamferType: 'straight', chamferWidth: 5 };
				const margin = core.applyDrcAwareTargetMargins(targets, config, avoidance.concat(trace, copperArea));
				const effectiveTargets = skipPreReduction ? targets : margin.targets;
				let data = core.makeCleanPourPolygonData(effectiveTargets, config, boundary, avoidance, trace, copperArea, { edgeShieldObstacles: edgeShield });
				const makeClipData = sourceData => usePadBodyProtection
					? { ...sourceData, coverageValidationContours: [[{ x: body.minX, y: body.minY }, { x: body.maxX, y: body.minY }, { x: body.maxX, y: body.maxY }, { x: body.minX, y: body.maxY }]] }
					: sourceData;
				let clipData = makeClipData(data);
				let clipObstacles = core.resolveCopperNodeClipObstacles(avoidance, data, 'pour');
				let clip = core.makeClearanceClippedPolygons(clipData, trace, copperArea, clipObstacles);
				let fallbackRetried = false;
				if ((!Array.isArray(clip.polygons) || clip.polygons.length === 0) && core.shouldRetryMultiPadHybridBridgeAfterClipping(data, clip)) {
					fallbackRetried = true;
					data = core.makeCleanPourPolygonData(effectiveTargets, config, boundary, avoidance, trace, copperArea, { edgeShieldObstacles: edgeShield, multiPadHybridForceBridge: true, allowMultiPadHybridBridgeRetry: false });
					clipData = makeClipData(data);
					clipObstacles = core.resolveCopperNodeClipObstacles(avoidance, data, 'pour');
					clip = core.makeClearanceClippedPolygons(clipData, trace, copperArea, clipObstacles);
				}
				return {
					margin: { reducedCount: margin.reducedCount, targets: margin.targets.map(item => ({ id: item.primitiveId, boundaryMargin: item.boundaryMargin, blockers: item.expansionBlockers })) },
					raw: { expansionMil: expansion, targetKeepInContours: data.targetKeepInContours, effectiveCoverageValidationContours: clipData.coverageValidationContours, bodyOnlyProtection: usePadBodyProtection, boundaryReducedExpansionCount: data.boundaryReducedExpansionCount, boundaryAvoidanceMode: data.boundaryAvoidanceMode, strategy: data.multiPadBoundaryStrategy ?? null },
					obstacles: avoidance.map(item => ({ id: item.primitiveId, net: item.net, clearanceMil: item.clearanceMil, rulePath: item.clearanceRulePath, forbiddenBounds: { minX: item.x - item.width / 2 - item.clearanceMil, minY: item.y - item.height / 2 - item.clearanceMil, maxX: item.x + item.width / 2 + item.clearanceMil, maxY: item.y + item.height / 2 + item.clearanceMil } })),
					clip: { used: clip.usedClipping, reason: clip.reason ?? null, debug: clip.debug ?? null, fallbackRetried, clipObstacles: clipObstacles.map(item => ({ id: item.primitiveId, x: item.x, y: item.y, width: item.width, height: item.height, shapeKind: item.shapeKind, clearanceMil: item.clearanceMil, polygonSource: item.polygonSource ?? null })) },
					sources: (clip.polygons ?? []).map(polygon => polygon.getSource()),
				};
			};
			for (const expansion of [18, 33]) {
				const targetPad = pad(`LEFT-${expansion}`, { x: 370.3, y: 400, net: 'N1', shape: ['RECT', 31.8, 34, 0] });
				const foreignPad = pad(`RIGHT-${expansion}`, { x: 429.7, y: 400, net: 'N2', shape: ['RECT', 31.8, 34, 0] });
				const fixture = install({ pads: [targetPad, foreignPad], rulesValue: { config: { spacingMil: 10 } } });
				const currentPlan = await plan(params({ targetIds: [targetPad.getState_PrimitiveId()], expansion, generationType: 'pour' }));
				assert.equal(currentPlan.executable, true, JSON.stringify(currentPlan.coverage.unresolved));
				const target = configureCopperRuntime(fixture.sdk, { read: async (_label, callback) => await callback(), checkBudget() {} }).upstream.primitiveTargets.makePadTarget(targetPad);
				const body = { minX: 370.3 - targetHalfWidth, minY: 400 - targetHalfHeight, maxX: 370.3 + targetHalfWidth, maxY: 400 + targetHalfHeight };
				const forbidden = { minX: 429.7 - obstacleHalfWidth - 10, minY: 400 - obstacleHalfHeight - 10, maxX: 429.7 + obstacleHalfWidth + 10, maxY: 400 + obstacleHalfHeight + 10 };
				const bodySource = makeBodySource(body);
				const current = await runRawChain(fixture.sdk, target, expansion, false);
				const bypassed = await runRawChain(fixture.sdk, target, expansion, true);
				const bodyBaseline = await runRawChain(fixture.sdk, target, expansion, true, true, body);
				const currentSources = currentPlan.plannedPrimitives.map(item => item.polygonSources);
				const currentMeasured = measure(currentSources, body, forbidden);
				const bypassedMeasured = measure(bypassed.sources, body, forbidden);
				const bodyBaselineMeasured = measure(bodyBaseline.sources, body, forbidden);
				assert.equal(current.sources.length, currentPlan.plannedPrimitives.length, `instrumented current chain fragment count differed at ${expansion}mil`);
				for (let index = 0; index < current.sources.length; index++)
					assert.equal(comparePolygonSource(current.sources[index], currentPlan.plannedPrimitives[index].polygonSources.length === 1 ? currentPlan.plannedPrimitives[index].polygonSources[0] : currentPlan.plannedPrimitives[index].polygonSources).matches, true, `instrumented current chain diverged from production plan at ${expansion}mil`);
				assert.equal(currentMeasured.sourceCount, 1, `current geometry must have one source at ${expansion}mil`);
				assert.equal(currentMeasured.ringCount, 1, `current geometry must have one outer ring at ${expansion}mil`);
				assert.equal(currentMeasured.holeCount, 0, `current geometry must have no holes at ${expansion}mil`);
				assert.equal(bypassedMeasured.sourceCount, 1, `bypassed geometry must have one source at ${expansion}mil`);
				assert.equal(bypassedMeasured.ringCount, 1, `bypassed geometry must have one outer ring at ${expansion}mil`);
				assert.equal(bypassedMeasured.holeCount, 0, `bypassed geometry must have no holes at ${expansion}mil`);
				assert.equal(bodyBaselineMeasured.sourceCount, 1, `body-protected geometry must have one source at ${expansion}mil`);
				assert.equal(bodyBaselineMeasured.fragmentCount, 1, `body-protected geometry must have one fragment at ${expansion}mil`);
				assert.equal(bodyBaselineMeasured.ringCount, 1, `body-protected geometry must have one outer ring at ${expansion}mil`);
				assert.equal(bodyBaselineMeasured.holeCount, 0, `body-protected geometry must have no holes at ${expansion}mil`);
				assert.ok(currentMeasured.targetCoveredAreaMil2 >= currentMeasured.targetAreaMil2 - 0.01, `current target coverage failed at ${expansion}mil`);
				assert.ok(bypassedMeasured.targetCoveredAreaMil2 >= bypassedMeasured.targetAreaMil2 - 0.01, `bypassed target coverage failed at ${expansion}mil`);
				assert.ok(bodyBaselineMeasured.targetCoveredAreaMil2 >= bodyBaselineMeasured.targetAreaMil2 - 0.01, `body-protected target coverage failed at ${expansion}mil`);
				requireClearanceSafe(currentMeasured, 'current', forbiddenIntersectionToleranceMil2);
				assert.ok(bypassedMeasured.rectangularForbiddenZoneModelIntersectionMil2 > 1, `bypassed rectangular forbidden-zone model overlap is not significant at ${expansion}mil`);
				requireClearanceSafe(bodyBaselineMeasured, 'body-protected', forbiddenIntersectionToleranceMil2);
				assert.equal(currentMeasured.outsideBoardVertexCount, 0);
				assert.equal(bypassedMeasured.outsideBoardVertexCount, 0);
				assert.equal(bodyBaselineMeasured.outsideBoardVertexCount, 0);
				assert.ok(bypassedMeasured.copperOutsidePadBodyMil2 > currentMeasured.copperOutsidePadBodyMil2 + 1, `bypass did not retain more copper at ${expansion}mil`);
				assert.ok(bodyBaselineMeasured.copperOutsidePadBodyMil2 > 1, `body protection did not preserve added copper at ${expansion}mil`);
				assert.deepEqual(fixture.state.writes, [], `offline experiment must remain read-only at ${expansion}mil`);
				const overlappingBodyCounterexample = measure([bodySource], body, { minX: body.maxX - 0.5, minY: body.minY, maxX: body.maxX + 0.5, maxY: body.maxY });
				assert.ok(overlappingBodyCounterexample.rectangularForbiddenZoneModelIntersectionMil2 > forbiddenIntersectionToleranceMil2);
				assert.throws(() => requireClearanceSafe(overlappingBodyCounterexample, 'negative-control', forbiddenIntersectionToleranceMil2), /target body intersects/);
				const finalVertices = namespace.AutoCopperPour.polygonUtils.makePointsFromFlatPolygonSource(bodyBaseline.sources[0]);
				const genericNeckDiagnostics = narrowBoundaryPairs(finalVertices);
				assert.ok(Math.abs(genericNeckDiagnostics.minWidthMil - bodyBaseline.clip.debug.neckMinWidthBefore) <= 0.01, `generic edge-pair recomputation differs from upstream detector minimum at ${expansion}mil`);
				assert.equal(genericNeckDiagnostics.pairs.length, expansion === 18 ? 2 : 0, `narrow pair count differs from expected diagnostic at ${expansion}mil`);
				console.log(`MARGIN_NECK_DIAGNOSTIC ${JSON.stringify({ expansion, vertices: finalVertices, thresholdMil: genericNeckDiagnostics.thresholdMil, minWidthMil: genericNeckDiagnostics.minWidthMil, closestPair: genericNeckDiagnostics.closestPair, narrowPairs: genericNeckDiagnostics.pairs, upstreamReportedMinimumWidthMil: bodyBaseline.clip.debug.neckMinWidthBefore, upstreamNarrowPairCount: bodyBaseline.clip.debug.neckNarrowCountBefore, detectorDefinition: 'All non-adjacent edge pairs of the final polygon outer ring; width is segmentToSegmentDistance; narrow iff width < MIN_AVOIDANCE_NECK_WIDTH. Upstream public debug reports only count/minimum, not pair coordinates.' })}`);
				console.log(`MARGIN_EXPERIMENT ${JSON.stringify({ scope: { rectangularForbiddenZoneModel: 'foreign pad axis-aligned body bounds expanded by resolved 10mil clearance; this is a model estimate', boardContainment: 'vertices checked against this fixture rectangular outline 0..1000 only', neckPairs: 'recomputed with the same exported makeBoundarySegments, segmentToSegmentDistance, non-adjacent edge filter, and MIN_AVOIDANCE_NECK_WIDTH; upstream debug does not expose pair coordinates or trace-specific pair filtering' }, expansion, forbiddenIntersectionToleranceMil2, finalVertices, genericNeckDiagnostics, detectorSummary: { neckNarrowCountBefore: bodyBaseline.clip.debug?.neckNarrowCountBefore, neckMinWidthBefore: bodyBaseline.clip.debug?.neckMinWidthBefore, neckRepairApplied: bodyBaseline.clip.debug?.neckRepairApplied, neckRepairReason: bodyBaseline.clip.debug?.neckRepairReason }, drc: current.obstacles.map(item => ({ id: item.id, net: item.net, clearanceMil: item.clearanceMil, rulePath: item.rulePath })), currentPlan: { executable: currentPlan.executable, warnings: currentPlan.warnings.filter(item => ['upstreamExpansionReduced', 'upstreamBoundaryResolution'].includes(item.code)) }, currentRaw: current.raw, currentClip: current.clip, currentIndependent: currentMeasured, bypassRaw: bypassed.raw, bypassClip: bypassed.clip, bypassIndependent: bypassedMeasured, bypassFinalContours: bypassed.sources, bodyBaselineRaw: bodyBaseline.raw, bodyBaselineClip: bodyBaseline.clip, bodyBaselineIndependent: bodyBaselineMeasured, bodyBaselineFinalContours: bodyBaseline.sources, writes: fixture.state.writes })}`);
			}

			const variantFailures = [];
			const variants = [
				{ name: 'mirrored-left', target: { x: 629.7, y: 400 }, blocker: { x: 570.3, y: 400 } },
				{ name: 'obstacle-above', target: { x: 500, y: 500 }, blocker: { x: 500, y: 559.4 } },
				{ name: 'obstacle-below', target: { x: 500, y: 500 }, blocker: { x: 500, y: 440.6 } },
				{ name: 'near-board-edge', target: { x: 55, y: 500 }, blocker: { x: 114.4, y: 500 } },
			];
			for (const variant of variants) {
				const targetPad = pad(`VAR-${variant.name}-TARGET`, { ...variant.target, net: 'N1', shape: ['RECT', 31.8, 34, 0] });
				const foreignPad = pad(`VAR-${variant.name}-BLOCKER`, { ...variant.blocker, net: 'N2', shape: ['RECT', 31.8, 34, 0] });
				const fixture = install({ pads: [targetPad, foreignPad], rulesValue: { config: { spacingMil: 10 } } });
				const target = configureCopperRuntime(fixture.sdk, { read: async (_label, callback) => await callback(), checkBudget() {} }).upstream.primitiveTargets.makePadTarget(targetPad);
				const currentPlan = await plan(params({ targetIds: [targetPad.getState_PrimitiveId()], expansion: 18, generationType: 'pour' }));
				const centerDelta = (variant.blocker.x !== variant.target.x ? { x: Math.sign(variant.blocker.x - variant.target.x), y: 0 } : { x: 0, y: Math.sign(variant.blocker.y - variant.target.y) });
				const body = { minX: variant.target.x - targetHalfWidth, minY: variant.target.y - targetHalfHeight, maxX: variant.target.x + targetHalfWidth, maxY: variant.target.y + targetHalfHeight };
				const raw = await runRawChain(fixture.sdk, target, 18, true, true, body);
				const forbidden = { minX: variant.blocker.x - obstacleHalfWidth - 10, minY: variant.blocker.y - obstacleHalfHeight - 10, maxX: variant.blocker.x + obstacleHalfWidth + 10, maxY: variant.blocker.y + obstacleHalfHeight + 10 };
				const measured = measure(raw.sources, body, forbidden);
				const variantResult = { name: variant.name, productionPlanExecutable: currentPlan.executable, testStage: 'same full-expansion chain with pre-reduction bypass and pad-body coverage protection', targetCovered: measured.targetCoveredAreaMil2 >= measured.targetAreaMil2 - 0.01, forbiddenIntersectionMil2: measured.rectangularForbiddenZoneModelIntersectionMil2, copperOutsidePadBodyMil2: measured.copperOutsidePadBodyMil2, outsideBoardVertexCount: measured.outsideBoardVertexCount, writes: fixture.state.writes, vertices: raw.sources[0] ? namespace.AutoCopperPour.polygonUtils.makePointsFromFlatPolygonSource(raw.sources[0]) : [], expectedObstacleDirection: centerDelta };
				try {
					assert.equal(raw.sources.length, 1, `${variant.name} must produce one polygon`);
					assert.ok(variantResult.targetCovered, `${variant.name} target body is not covered`);
					assert.ok(measured.rectangularForbiddenZoneModelIntersectionMil2 <= forbiddenIntersectionToleranceMil2, `${variant.name} output intersects the original rectangular forbidden-zone model`);
					assert.ok(measured.copperOutsidePadBodyMil2 > 1, `${variant.name} has no positive copper beyond target body`);
					assert.equal(measured.outsideBoardVertexCount, 0, `${variant.name} output is outside board bounds`);
					assert.deepEqual(fixture.state.writes, [], `${variant.name} offline experiment must remain read-only`);
				}
				catch (error) {
					variantFailures.push({ ...variantResult, failure: error.message });
				}
				console.log(`MARGIN_VARIANT ${JSON.stringify(variantResult)}`);
			}
			assert.deepEqual(variantFailures, [], `one-sided margin variants failed: ${JSON.stringify(variantFailures)}`);

			const targetPad = pad('BODY-OVERLAP-TARGET', { x: 500, y: 500, net: 'N1', shape: ['RECT', 31.8, 34, 0] });
			const foreignPad = pad('BODY-OVERLAP-FOREIGN', { x: 520, y: 500, net: 'N2', shape: ['RECT', 31.8, 34, 0] });
			const negativeFixture = install({ pads: [targetPad, foreignPad], rulesValue: { config: { spacingMil: 10 } } });
			const negativePlan = await plan(params({ targetIds: ['BODY-OVERLAP-TARGET'], expansion: 18, generationType: 'pour' }));
			const negativeTarget = configureCopperRuntime(negativeFixture.sdk, { read: async (_label, callback) => await callback(), checkBudget() {} }).upstream.primitiveTargets.makePadTarget(targetPad);
			const negativeBody = { minX: 500 - targetHalfWidth, minY: 500 - targetHalfHeight, maxX: 500 + targetHalfWidth, maxY: 500 + targetHalfHeight };
			const negativeForbidden = { minX: 520 - obstacleHalfWidth - 10, minY: 500 - obstacleHalfHeight - 10, maxX: 520 + obstacleHalfWidth + 10, maxY: 500 + obstacleHalfHeight + 10 };
			const negativeIntersection = measure([makeBodySource(negativeBody)], negativeBody, negativeForbidden);
			assert.ok(negativeIntersection.rectangularForbiddenZoneModelIntersectionMil2 > forbiddenIntersectionToleranceMil2, 'negative full-chain pad body must intersect foreign copper forbidden zone');
			const negativeRaw = await runRawChain(negativeFixture.sdk, negativeTarget, 18, false);
			assert.ok(negativeRaw.sources.length === 0 || measure(negativeRaw.sources, negativeBody, negativeForbidden).rectangularForbiddenZoneModelIntersectionMil2 > forbiddenIntersectionToleranceMil2, 'negative chain fixture must not silently claim a safe expanded final contour');
			assert.equal(negativePlan.executable, false, JSON.stringify(negativePlan.coverage.unresolved));
			assert.ok(negativePlan.coverage.unresolved.length > 0, 'negative full-chain plan must report a safety rejection');
			await assert.rejects(execute(negativePlan), /当前对象状态生成的计划不可执行/);
			assert.deepEqual(negativeFixture.state.writes, [], 'negative full-chain execution rejection must perform zero writes');
			console.log(`MARGIN_NEGATIVE ${JSON.stringify({ planExecutable: negativePlan.executable, unresolved: negativePlan.coverage.unresolved, targetBodyForbiddenIntersectionMil2: negativeIntersection.rectangularForbiddenZoneModelIntersectionMil2, finalSources: negativeRaw.sources, writes: negativeFixture.state.writes })}`);
		});

		await test('opt-in contour-width draft separates interior thin copper from short clearance steps and honors equality', async () => {
			const utils = namespace.AutoCopperPour.polygonUtils;
			const detectInteriorParallelWidths = (points, thresholdMil) => {
				assert.ok(Number.isFinite(thresholdMil) && thresholdMil > 0, 'fixture must pass an explicit positive width threshold');
				const segments = utils.makeBoundarySegments(points);
				const candidates = [];
				for (let firstIndex = 0; firstIndex < segments.length; firstIndex++) {
					for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex++) {
						const indexDistance = Math.abs(firstIndex - secondIndex);
						if (indexDistance <= 1 || indexDistance === segments.length - 1)
							continue;
						const first = segments[firstIndex];
						const second = segments[secondIndex];
						const firstVector = { x: first.end.x - first.start.x, y: first.end.y - first.start.y };
						const secondVector = { x: second.end.x - second.start.x, y: second.end.y - second.start.y };
						const firstLength = Math.hypot(firstVector.x, firstVector.y);
						const secondLength = Math.hypot(secondVector.x, secondVector.y);
						if (firstLength <= 0 || secondLength <= 0)
							continue;
						const tangent = { x: firstVector.x / firstLength, y: firstVector.y / firstLength };
						const parallelError = Math.abs(firstVector.x * secondVector.y - firstVector.y * secondVector.x) / (firstLength * secondLength);
						if (parallelError > 1e-9)
							continue;
						const project = point => point.x * tangent.x + point.y * tangent.y;
						const firstInterval = [project(first.start), project(first.end)].sort((a, b) => a - b);
						const secondInterval = [project(second.start), project(second.end)].sort((a, b) => a - b);
						const overlapStart = Math.max(firstInterval[0], secondInterval[0]);
						const overlapEnd = Math.min(firstInterval[1], secondInterval[1]);
						if (overlapEnd - overlapStart <= 1e-6)
							continue;
						const station = (overlapStart + overlapEnd) / 2;
						const firstPoint = { x: first.start.x + tangent.x * (station - project(first.start)), y: first.start.y + tangent.y * (station - project(first.start)) };
						const secondPoint = { x: second.start.x + tangent.x * (station - project(second.start)), y: second.start.y + tangent.y * (station - project(second.start)) };
						const widthMil = Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y);
						const midpoint = { x: (firstPoint.x + secondPoint.x) / 2, y: (firstPoint.y + secondPoint.y) / 2 };
						if (!utils.pointInPolygon(midpoint, points) || utils.pointOnPolygonBoundary(midpoint, points))
							continue;
						let chordCrossesOtherBoundary = false;
						for (const edge of segments) {
							if (edge.index === first.index || edge.index === second.index)
								continue;
							if (utils.segmentsIntersect(firstPoint, secondPoint, edge.start, edge.end)) {
								chordCrossesOtherBoundary = true;
								break;
							}
						}
						if (!chordCrossesOtherBoundary)
							candidates.push({ firstIndex, secondIndex, firstPoint, secondPoint, widthMil, narrow: widthMil < thresholdMil });
					}
				}
				return { thresholdMil, candidates, narrowCandidates: candidates.filter(candidate => candidate.narrow), status: candidates.length > 0 ? 'measured-for-these-rectilinear-fixtures' : 'unknown-for-general-contours' };
			};
			const bridge = [
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 10, y: 4 },
				{ x: 20, y: 4 },
				{ x: 20, y: 0 },
				{ x: 30, y: 0 },
				{ x: 30, y: 10 },
				{ x: 20, y: 10 },
				{ x: 20, y: 6 },
				{ x: 10, y: 6 },
				{ x: 10, y: 10 },
				{ x: 0, y: 10 },
			];
			const thinProtrusion = [
				{ x: 0, y: 0 },
				{ x: 20, y: 0 },
				{ x: 20, y: 9 },
				{ x: 35, y: 9 },
				{ x: 35, y: 11 },
				{ x: 20, y: 11 },
				{ x: 20, y: 20 },
				{ x: 0, y: 20 },
			];
			const shortStep = [
				{ x: 336.4, y: 365 },
				{ x: 404.2, y: 365 },
				{ x: 404.2, y: 373 },
				{ x: 403.8, y: 373 },
				{ x: 403.8, y: 427 },
				{ x: 404.2, y: 427 },
				{ x: 404.2, y: 435 },
				{ x: 336.4, y: 435 },
			];
			const equalBridge = [
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 10, y: 2 },
				{ x: 20, y: 2 },
				{ x: 20, y: 0 },
				{ x: 30, y: 0 },
				{ x: 30, y: 10 },
				{ x: 20, y: 10 },
				{ x: 20, y: 8 },
				{ x: 10, y: 8 },
				{ x: 10, y: 10 },
				{ x: 0, y: 10 },
			];
			const bridgeResult = detectInteriorParallelWidths(bridge, 6);
			const spurResult = detectInteriorParallelWidths(thinProtrusion, 6);
			const stepResult = detectInteriorParallelWidths(shortStep, 6);
			const equalityResult = detectInteriorParallelWidths(equalBridge, 6);
			assert.ok(bridgeResult.narrowCandidates.some(candidate => Math.abs(candidate.widthMil - 2) < 1e-9), 'interior two-mil bridge must be detected below the explicit six-mil threshold');
			assert.ok(spurResult.narrowCandidates.some(candidate => Math.abs(candidate.widthMil - 2) < 1e-9), 'interior two-mil protrusion must be detected below the explicit six-mil threshold');
			assert.equal(stepResult.narrowCandidates.length, 0, 'the 0.4-mil step has no positive-length opposite-edge overlap forming an interior chord');
			assert.ok(equalityResult.candidates.some(candidate => Math.abs(candidate.widthMil - 6) < 1e-9));
			assert.equal(equalityResult.narrowCandidates.length, 0, 'width exactly equal to the explicit threshold is not below threshold');
			console.log(`MARGIN_WIDTH_DRAFT ${JSON.stringify({ scope: 'test-only axis-aligned parallel-edge candidate detector; no claim of general polygon minimum-width proof', thresholdMil: 6, bridge: bridgeResult, thinProtrusion: spurResult, currentStepPositive: stepResult, equality: equalityResult, unknowns: ['non-parallel concave minima', 'curved geometry', 'holes or disconnected rings', 'numeric robustness outside these rectilinear fixtures'] })}`);
		});
	}

	await test('single pad reduction with a same-net via expansion remains executable when final geometry is uncertain', async () => {
		install({
			pads: [
				pad('ACE_IN_A', { x: 500, y: 500, shape: ['RECT', 61.8, 100, 0] }),
				pad('FOREIGN-RIGHT', { x: 570, y: 500, net: 'N2', shape: ['RECT', 40, 24, 0] }),
			],
			vias: [via('SAME-NET-VIA', 400, 500, 'N1', 24)],
			rulesValue: { config: { spacingMil: 10 } },
		});
		const result = await plan(params({ targetIds: ['ACE_IN_A', 'SAME-NET-VIA'], expansion: 15 }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		const assessment = result.warnings.find(item => item.code === 'localCopperExpansionAssessment');
		assert.equal(assessment.status, 'uncertain');
		assert.equal(assessment.targets[0].id, 'ACE_IN_A');
		assert.ok(assessment.targets[0].blockers.some(item => item.primitiveId === 'FOREIGN-RIGHT'));
		assert.ok(result.plannedPrimitives.length > 0);
		assert.ok(result.plannedPrimitives[0].points.some(point => point.x < 469.1), 'the via keeps actual planned copper beyond the reduced pad body');
	});

	await test('different-net single-pad groups remain executable when the whole plan has multiple targets', async () => {
		install({
			pads: [
				pad('PAD-N1', { x: 300, y: 500, net: 'N1', shape: ['RECT', 61.8, 100, 0] }),
				pad('PAD-N2', { x: 700, y: 500, net: 'N2', shape: ['RECT', 61.8, 100, 0] }),
				pad('BLOCK-N1', { x: 370, y: 500, net: 'N2', shape: ['RECT', 40, 24, 0] }),
				pad('BLOCK-N2', { x: 770, y: 500, net: 'N1', shape: ['RECT', 40, 24, 0] }),
			],
			rulesValue: { config: { spacingMil: 10 } },
		});
		const result = await plan(params({ targetIds: ['PAD-N1', 'PAD-N2'], expansion: 15 }));
		assert.equal(result.executable, true, JSON.stringify(result.coverage.unresolved));
		const assessments = result.warnings.filter(item => item.code === 'localCopperExpansionAssessment');
		assert.equal(assessments.length, 2);
		assert.ok(assessments.every(item => item.status === 'uncertain'));
		assert.equal(result.coverage.unresolved.some(item => /不满足局部扩铜目标/.test(item)), false);
	});

	await test('rotated and rounded pads with reduced expansion remain executable when body equivalence is uncertain', async () => {
		for (const target of [
			pad('ROTATED-PAD', { x: 500, y: 500, rotation: 90, shape: ['RECT', 61.8, 100, 0] }),
			pad('ROUNDED-PAD', { x: 500, y: 500, shape: ['RECT', 61.8, 100, 8] }),
			pad('CUSTOM-PAD', { x: 500, y: 500, shape: ['POLYGON', [470, 450, 'L', 530, 450, 530, 490, 510, 490, 510, 510, 530, 510, 530, 550, 470, 550, 470, 450]] }),
			pad('MULTI-RING-PAD', { x: 500, y: 500, shape: ['POLYGON', [[470, 450, 'L', 530, 450, 530, 550, 470, 550, 470, 450], [490, 480, 'L', 510, 480, 510, 520, 490, 520, 490, 480]]] }),
		]) {
			install({
				pads: [target, pad('FOREIGN-RIGHT', { x: 570, y: 500, net: 'N2', shape: ['RECT', 40, 24, 0] })],
				rulesValue: { config: { spacingMil: 10 } },
			});
			const result = await plan(params({ targetIds: [target.getState_PrimitiveId()], expansion: 15 }));
			assert.equal(result.executable, true, target.getState_PrimitiveId());
			const assessment = result.warnings.find(item => item.code === 'localCopperExpansionAssessment');
			assert.equal(assessment.status, 'uncertain', target.getState_PrimitiveId());
		}
	});

	await test('fill mode and explicit zero expansion are unaffected by the local-pour expansion gate', async () => {
		const pads = [
			pad('ACE_IN_A', { x: 500, y: 500, shape: ['RECT', 61.8, 100, 0] }),
			pad('FOREIGN-RIGHT', { x: 570, y: 500, net: 'N2', shape: ['RECT', 40, 24, 0] }),
		];
		install({ pads, rulesValue: { config: { spacingMil: 10 } } });
		const fillPlan = await plan(params({ targetIds: ['ACE_IN_A'], expansion: 15, generationType: 'fill' }));
		assert.equal(fillPlan.executable, true);
		assert.equal(fillPlan.warnings.some(item => item.code === 'localCopperExpansionAssessment'), false);
		install({ pads, rulesValue: { config: { spacingMil: 10 } } });
		const zeroExpansionPlan = await plan(params({ targetIds: ['ACE_IN_A'], expansion: 0, generationType: 'pour' }));
		assert.equal(zeroExpansionPlan.executable, true);
		assert.equal(zeroExpansionPlan.warnings.some(item => item.code === 'localCopperExpansionAssessment'), false);
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
		const f = install({ rebuildResult: { id: 'REBUILD-RESULT-1' } });
		const preview = await plan(params());
		assert.equal(preview.executable, true, JSON.stringify(preview.coverage.unresolved));
		const result = await execute(preview);
		assert.equal(result.created[0].status, 'created-border-and-rebuilt; fill read back');
		assert.equal(result.created[0].orderReadback.order, 1);
		assert.equal(result.created[0].fillReadback.netLayerSource, 'parent-pour');
		assert.equal(result.created[0].fillReadback.parent.net, 'N1');
		assert.equal(result.created[0].fillReadback.association.count, 1);
		assert.equal(result.created[0].filledReadback[0].pathGetter, 'function');
		assert.ok(result.created[0].filledReadback[0].pathSource.length > 0);
		assert.equal(result.created[0].geometryComparison.mode, 'single-ring-cyclic-or-reversed');
		assert.deepEqual(result.created[0].rebuildReturn, { present: true, type: 'object', id: 'REBUILD-RESULT-1' });
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
	});

	await test('undefined rebuild return succeeds when independent readback confirms the complete fill', async () => {
		const f = install({ rebuildResultUndefined: true });
		const preview = await plan(params());
		f.state.pouredGetAllCalls = 0;
		const result = await execute(preview);
		assert.deepEqual(result.created[0].rebuildReturn, { present: false, type: 'undefined', id: null });
		assert.equal(result.created[0].fillReadback.parent.id, 'POUR-1');
		assert.equal(result.created[0].fillReadback.parent.net, 'N1');
		assert.equal(result.created[0].fillReadback.parent.layer, 1);
		assert.equal(result.created[0].fillReadback.boundaryComparison.matches, true);
		assert.equal(result.created[0].fillReadback.association.count, 1);
		assert.ok(result.created[0].fillReadback.filledRegions.some(region => region.fill === true && region.pathGetter === 'function'));
		assert.equal(f.state.pouredGetAllCalls, 2, 'execution replan plus independent fill readback');
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
	});

	await test('read-only pour fill command uses parent net/layer and Poured association without writes', async () => {
		const borderSource = ringSource([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
		const f = install({ pours: [pour('EXISTING-POUR', 'N1', borderSource)] });
		f.state.poured.push({
			getState_PrimitiveId: () => 'EXISTING-POURED',
			getState_PourPrimitiveId: () => 'EXISTING-POUR',
			getState_PourFills: () => [{ id: 'R1', fill: true, lineWidth: 0, path: { getSource: () => [9, 9, 'L', 1, 9, 1, 1, 9, 1, 9, 9] } }],
		});
		const result = await command('pcb.getPourFillReadback').handler({ __docUuid: 'pcb-A', primitiveId: 'EXISTING-POUR', net: 'N1', layer: 'top' });
		assert.equal(result.parent.net, 'N1');
		assert.equal(result.netLayerSource, 'parent-pour');
		assert.equal(result.boundaryComparison.matches, null);
		assert.deepEqual(result.pouredNetLayerGetters, [{ pouredId: 'EXISTING-POURED', net: 'missing', layer: 'missing' }]);
		assert.deepEqual(result.association.matchedPouredIds, ['EXISTING-POURED']);
		assert.equal(result.filledRegions[0].pathGetter, 'function');
		assert.deepEqual(result.filledRegions[0].pathSource, [9, 9, 'L', 1, 9, 1, 1, 9, 1, 9, 9], 'raw SDK path is retained');
		assert.deepEqual(result.filledRegions[0].normalizedPathMil, [90, 90, 'L', 10, 90, 10, 10, 90, 10, 90, 90]);
		assert.equal(result.filledRegions[0].coordinateUnit, 'mil');
		assert.deepEqual(result.filledRegions[0].normalization, { status: 'normalized', reason: 'eda-4.1.78-zero-width-fill-path-10mil-to-mil', editorVersion: '4.1.78', conversionFactor: 10 });
		assert.deepEqual(f.state.writes, []);
	});

	await test('object rebuild result with invalid association fails after independent readback', async () => {
		const f = install({ rebuildResult: { id: 'REBUILD-RESULT-2' }, pouredConfig: { pourId: 'OTHER-POUR' } });
		const preview = await plan(params());
		f.state.pouredGetAllCalls = 0;
		const error = await execute(preview).then(() => assert.fail('unrelated fill must reject'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.equal(error.cause.fillReadback.association.count, 0);
		assert.deepEqual(error.cause.fillReadback.association.observedPouredIds, [{ id: 'POURED-POUR-1', pourId: 'OTHER-POUR' }]);
		assert.deepEqual(error.cause.created[0].rebuildReturn, { present: true, type: 'object', id: 'REBUILD-RESULT-2' });
		assert.equal(error.cause.created[0].fillReadback.association.count, 0);
		assert.equal(f.state.pouredGetAllCalls, 2, 'execution replan plus independent fill readback');
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		assert.equal(error.cause.created[0].status, 'border-read-back; fill readback failed');
	});

	await test('undefined rebuild return with no fill preserves border and reports readback evidence without further writes', async () => {
		const f = install({ pads: [pad('P1', { x: 420, net: 'N1' }), pad('P2', { x: 580, net: 'N2' })], rebuildResultUndefined: true, pouredConfig: { noFills: true } });
		const preview = await plan(params({ targetIds: ['P1', 'P2'] }));
		assert.ok(preview.plannedPrimitives.length > 1);
		f.state.pouredGetAllCalls = 0;
		const error = await execute(preview).then(() => assert.fail('missing fill must reject'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.equal(error.cause.created.length, 1);
		assert.equal(error.cause.created[0].id, 'POUR-1');
		assert.deepEqual(error.cause.created[0].rebuildReturn, { present: false, type: 'undefined', id: null });
		assert.equal(error.cause.created[0].fillReadback.association.count, 1);
		assert.deepEqual(error.cause.created[0].fillReadback.filledRegions, []);
		assert.match(error.cause.created[0].fillReadback.readError, /没有 fill=true/);
		assert.equal(error.cause.fillReadback.association.count, 1);
		assert.equal(f.state.pouredGetAllCalls, 3, 'two execution replans plus independent fill readback');
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		assert.equal(error.cause.unattemptedPrimitives.length, preview.plannedPrimitives.length - 1);
	});

	await test('undefined rebuild return with zero Poured association preserves evidence and does not clean up or continue', async () => {
		const f = install({
			pads: [pad('P1', { x: 420, net: 'N1' }), pad('P2', { x: 580, net: 'N2' })],
			rebuildResult: false,
			rebuildResultUndefined: true,
		});
		const preview = await plan(params({ targetIds: ['P1', 'P2'] }));
		assert.equal(preview.plannedPrimitives.length, 2);
		f.state.pouredGetAllCalls = 0;
		const error = await execute(preview).then(() => assert.fail('missing Poured association must reject'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause.retryable, false);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.equal(error.cause.created[0].id, 'POUR-1');
		assert.equal(error.cause.created[0].rebuildReturn.present, false);
		assert.equal(error.cause.created[0].fillReadback.association.count, 0);
		assert.deepEqual(error.cause.created[0].fillReadback.association.observedPouredIds, []);
		assert.deepEqual(error.cause.unattemptedPrimitives, preview.plannedPrimitives.slice(1).map((item, offset) => ({ index: offset + 1, net: item.net, layer: item.layer })));
		assert.equal(f.state.deletions, 0);
		assert.equal(f.state.pouredGetAllCalls, 3, 'two execution replans plus the independent fill readback');
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
	});

	await test('rebuild returning a preexisting Poured object never reports it as created', async () => {
		const oldId = 'POURED-OLD-A27';
		const oldPoured = {
			getState_PrimitiveId: () => oldId,
			getState_PourPrimitiveId: () => 'PREEXISTING-POUR',
			getState_PourFills: () => [],
		};
		const f = install({
			pads: [pad('P1', { x: 420, net: 'N1' }), pad('P2', { x: 580, net: 'N2' })],
			existingPoured: [oldPoured],
			rebuildResult: false,
			rebuildReturnValue: oldPoured,
		});
		const preview = await plan(params({ targetIds: ['P1', 'P2'] }));
		assert.equal(preview.plannedPrimitives.length, 2);
		f.state.pouredGetAllCalls = 0;
		const error = await execute(preview).then(() => assert.fail('preexisting unrelated Poured object must not verify this pour'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause.retryable, false);
		assert.deepEqual(error.cause.createdIds, ['POUR-1']);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.deepEqual(error.cause.created.map(item => item.id), ['POUR-1']);
		assert.equal(error.cause.created[0].rebuildReturn.id, oldId);
		assert.equal(error.cause.fillReadback.association.count, 0);
		assert.deepEqual(error.cause.fillReadback.association.observedPouredIds, [{ id: oldId, pourId: 'PREEXISTING-POUR' }]);
		assert.deepEqual(error.cause.unattemptedPrimitives, preview.plannedPrimitives.slice(1).map((item, offset) => ({ index: offset + 1, net: item.net, layer: item.layer })));
		assert.equal(f.state.poured.includes(oldPoured), true);
		assert.equal(f.state.deletions, 0);
		assert.equal(f.state.pouredGetAllCalls, 3, 'two execution replans plus independent fill readback');
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
	});

	await test('thrown rebuild retains unknown-write protection and skips readback and later writes', async () => {
		const f = install({ pads: [pad('P1', { x: 420, net: 'N1' }), pad('P2', { x: 580, net: 'N2' })], rebuildThrows: true });
		const preview = await plan(params({ targetIds: ['P1', 'P2'] }));
		f.state.pouredGetAllCalls = 0;
		const error = await execute(preview).then(() => assert.fail('thrown rebuild must fail'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause.retryable, false);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.equal(error.cause.created[0].id, 'POUR-1');
		assert.equal(f.state.pouredGetAllCalls, 2, 'execution replans run, but thrown rebuild skips independent fill readback');
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		assert.equal(error.cause.unattemptedPrimitives.length, preview.plannedPrimitives.length - 1);
	});

	await test('post-rebuild parent ID, network and layer mismatches retain observed values', async () => {
		for (const overrides of [{ parentReadbackId: 'WRONG-ID' }, { parentReadbackNet: 'WRONG-NET' }, { parentReadbackLayer: 2 }]) {
			const f = install(overrides);
			const preview = await plan(params());
			const error = await execute(preview).then(() => assert.fail('parent mismatch must reject'), caught => caught);
			assert.equal(error.cause?.partial, true);
			assert.deepEqual(error.cause.verifiedIds, []);
			assert.equal(error.cause.fillReadback.parent.id, overrides.parentReadbackId ?? 'POUR-1');
			assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		}
	});

	await test('empty fill path, throwing path getter and no fill=true reject with region evidence', async () => {
		const cases = [
			{ label: 'empty source', region: { id: 'EMPTY-REGION', fill: true, lineWidth: 12, path: { getSource: () => [] } }, expected: { pathSource: [] } },
			{ label: 'throwing getter', region: { id: 'THROW-REGION', fill: true, lineWidth: 12, path: { getSource: () => { throw new Error('path getter failed'); } } }, expected: { pathSource: { getSourceError: 'path getter failed' } } },
			{ label: 'no filled region', region: { id: 'UNFILLED-REGION', fill: false, lineWidth: 12, path: {} }, expected: { fill: false } },
		];
		for (const item of cases) {
			const f = install({ pouredConfig: { region: item.region } });
			const preview = await plan(params());
			const error = await execute(preview).then(() => assert.fail(`${item.label} must reject`), caught => caught);
			assert.equal(error.cause?.partial, true, item.label);
			assert.deepEqual(error.cause.verifiedIds, [], item.label);
			assert.equal(error.cause.fillReadback.filledRegions[0].id, item.region.id, item.label);
			for (const [key, value] of Object.entries(item.expected))
				assert.deepEqual(error.cause.fillReadback.filledRegions[0][key], value, item.label);
			assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild'], item.label);
		}
	});

	await test('post-rebuild border change rejects before fill verification', async () => {
		const f = install({ parentReadbackSource: (source) => {
			const changed = [...source];
			changed[0] += 1;
			return changed;
		} });
		const preview = await plan(params());
		const error = await execute(preview).then(() => assert.fail('changed parent border must reject'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause.fillReadback.boundaryComparison.matches, false);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
	});

	await test('first fill failure stops a two-pour batch and reports the remaining planned primitive', async () => {
		const f = install({ pads: [pad('P1', { x: 420, net: 'N1' }), pad('P2', { x: 580, net: 'N2' })], pouredConfig: { noFills: true } });
		const preview = await plan(params({ targetIds: ['P1', 'P2'] }));
		assert.ok(preview.plannedPrimitives.length > 1);
		const error = await execute(preview).then(() => assert.fail('first pour fill failure must reject the batch'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		assert.equal(error.cause.created[0].status, 'border-read-back; fill readback failed');
		assert.deepEqual(error.cause.unattemptedPrimitives, preview.plannedPrimitives.slice(1).map((item, offset) => ({ index: offset + 1, net: item.net, layer: item.layer })));
	});

	await test('read-only fill failures never write and return non-partial observed errors', async () => {
		const borderSource = ringSource([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
		const cases = [
			{ label: 'association', overrides: { pouredConfig: { pourId: 'OTHER-POUR' } } },
			{ label: 'parent values', overrides: { parentReadbackNet: 'WRONG-NET' } },
			{ label: 'empty source', overrides: { parentReadbackSource: [] } },
			{ label: 'path getter', overrides: { pouredConfig: { region: { id: 'READONLY-THROW', fill: true, lineWidth: 12, path: { getSource: () => { throw new Error('readonly path getter failed'); } } } } } },
		];
		for (const item of cases) {
			const f = install({ pours: [pour('EXISTING-POUR', 'N1', borderSource)], ...item.overrides });
			f.state.poured.push({ getState_PrimitiveId: () => 'EXISTING-POURED', getState_PourPrimitiveId: () => item.overrides.pouredConfig?.pourId ?? 'EXISTING-POUR', getState_PourFills: () => [item.overrides.pouredConfig?.region ?? { id: 'READONLY-REGION', fill: true, lineWidth: 12, path: { getSource: () => borderSource } }] });
			const error = await command('pcb.getPourFillReadback').handler({ __docUuid: 'pcb-A', primitiveId: 'EXISTING-POUR', net: 'N1', layer: 'top' }).then(() => assert.fail(`${item.label} must reject`), caught => caught);
			assert.notEqual(error.cause?.partial, true, item.label);
			assert.deepEqual(f.state.writes, [], item.label);
			assert.ok(error.cause?.fillReadback, item.label);
		}
	});

	await test('fill pending readback failure preserves actual fill evidence in partial result', async () => {
		const f = install({ pouredConfig: { region: { id: 'BROKEN-REGION', fill: true, lineWidth: 12, path: {} } } });
		const preview = await plan(params());
		const error = await execute(preview).then(() => assert.fail('missing fill must reject'), caught => caught);
		assert.equal(error.cause?.partial, true);
		assert.deepEqual(error.cause.verifiedIds, []);
		assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		assert.equal(error.cause.fillReadback.association.count, 1);
		assert.deepEqual(error.cause.fillReadback.filledRegions, [{ pouredId: 'POURED-POUR-1', id: 'BROKEN-REGION', fill: true, lineWidth: 12, pathGetter: 'missing', coordinateUnit: 'unknown', normalization: { status: 'unsupported', reason: 'path-not-read', editorVersion: '4.1.78', conversionFactor: null } }]);
	});

	await test('independent pour readback accepts reversed order and cyclic start with one-ring wrapper', async () => {
		for (const ordering of [{ reverse: true }, { start: 2, wrap: true }]) {
			const f = install({ pourReadbackSource: source => reorderedSource(source, ordering) });
			const preview = await plan(params());
			const result = await execute(preview);
			assert.equal(result.verifiedIds.length, 1);
			assert.equal(result.created[0].geometryComparison.mode, 'single-ring-cyclic-or-reversed');
			assert.deepEqual(f.state.writes, ['pour.create', 'pour.rebuild']);
		}
	});

	await test('changed, open, curved or additional-ring readback stops before verification and rebuild', async () => {
		const mutations = [
			(source) => {
				const points = ringVertices(source);
				points[0].x += 0.01;
				return ringSource(points);
			},
			(source) => {
				const points = ringVertices(source);
				points.splice(1, 0, { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
				return ringSource(points);
			},
			(source) => {
				const points = ringVertices(source);
				points.splice(1, 1);
				return ringSource(points);
			},
			source => ringSource(ringVertices(source), { close: false }),
			source => [source, source],
			(source) => {
				const changed = [...source];
				changed[2] = 'ARC';
				return changed;
			},
		];
		for (const mutation of mutations) {
			const f = install({ pourReadbackSource: mutation });
			const preview = await plan(params());
			const error = await execute(preview).then(() => assert.fail('changed polygon readback must fail'), caught => caught);
			assert.equal(error.cause?.partial, true);
			assert.equal(f.state.writes.length, 1);
			assert.deepEqual(error.cause.verifiedIds, []);
			assert.equal(error.cause.createdIds.length, 1);
			assert.deepEqual(f.state.writes, ['pour.create']);
			assert.ok(error.cause.geometryReadback.plannedSource);
			assert.ok(error.cause.geometryReadback.actualSource);
			assert.equal(typeof error.cause.geometryReadback.comparison, 'string');
		}
	});

	await test('network or layer mismatch retains both values and stops before rebuild', async () => {
		for (const overrides of [{ pourReadbackNet: 'WRONG' }, { pourReadbackLayer: 2 }]) {
			const f = install(overrides);
			const preview = await plan(params());
			const error = await execute(preview).then(() => assert.fail('network or layer mismatch must fail'), caught => caught);
			assert.equal(error.cause?.partial, true);
			assert.equal(f.state.writes.length, 1);
			assert.deepEqual(error.cause.verifiedIds, []);
			assert.equal(error.cause.geometryReadback.geometryMatches, true);
			assert.deepEqual(f.state.writes, ['pour.create']);
		}
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
