import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';
import JSZip from 'jszip';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: "import { silkscreenCheckCommands } from '../src/commands/silkscreenCheck.ts'; import { collectPotentialConflicts, normalizeSdkBox, sdkBoxDistanceMil, validateSilkscreenCheckParams } from '../src/engine/silkscreenCheck.ts'; export { silkscreenCheckCommands, collectPotentialConflicts, normalizeSdkBox, sdkBoxDistanceMil, validateSilkscreenCheckParams }",
			resolveDir: resolve(root, 'test'),
			sourcefile: 'silkscreen-check-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { silkscreenCheckCommands, collectPotentialConflicts, normalizeSdkBox, sdkBoxDistanceMil, validateSilkscreenCheckParams } = await import(moduleUrl);
	const command = name => silkscreenCheckCommands.find(item => item.name === name);
	const rules = { design: { spacing: 8 } };
	const docHead = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid, client: 'silkscreen-check-test' })}|`;
	const sourceFixture = ({ includeSecondComponent = false } = {}) => {
		const records = [
			docHead('pcb-A'),
			`${JSON.stringify({ type: 'COMPONENT', id: 'COMP-1', ticket: 1 })}||${JSON.stringify({ attrs: { Designator: 'U1' }, x: 300, y: 400, layerId: 1 })}|`,
			`${JSON.stringify({ type: 'ATTR', id: 'ATTR-U1', ticket: 2 })}||${JSON.stringify({ parentId: 'COMP-1', layerId: 3, key: 'Designator', value: 'U1', keyVisible: false, valueVisible: true })}|`,
			`${JSON.stringify({ type: 'ATTR', id: 'ATTR-HIDDEN', ticket: 3 })}||${JSON.stringify({ parentId: 'COMP-1', layerId: 3, key: 'Value', value: 'X', keyVisible: false, valueVisible: false })}|`,
			`${JSON.stringify({ type: 'ATTR', id: 'ATTR-OTHER', ticket: 4 })}||${JSON.stringify({ parentId: 'COMP-1', layerId: 3, key: 'Name', value: 'visible-name', keyVisible: true, valueVisible: false })}|`,
		];
		if (includeSecondComponent) {
			records.push(
				`${JSON.stringify({ type: 'COMPONENT', id: 'COMP-2', ticket: 5 })}||${JSON.stringify({ attrs: { Designator: 'U2' }, x: 500, y: 600, layerId: 1 })}|`,
				`${JSON.stringify({ type: 'ATTR', id: 'ATTR-U2', ticket: 6 })}||${JSON.stringify({ parentId: 'COMP-2', layerId: 3, key: 'Designator', value: 'U2', keyVisible: false, valueVisible: true })}|`,
			);
		}
		return records.join('\n');
	};

	function object(id, values) {
		return Object.fromEntries(Object.entries({ primitiveId: id, ...values }).map(([key, value]) => [`getState_${key[0].toUpperCase()}${key.slice(1)}`, () => value]));
	}
	const text = (id, layer, value = id) => object(id, { primitiveType: 'String', layer, text: value });
	const stroke = (id, layer, primitiveType = 'Line') => object(id, { primitiveType, layer });
	const pad = (id, layer, parent = undefined) => object(id, { primitiveType: 'Pad', layer, ...(parent ? { parentComponentPrimitiveId: parent } : {}) });
	const component = id => object(id, { primitiveType: 'Component' });

	function install({ strings, polylines, lines, arcs, independentPads, componentPads, componentPadsById, componentsList, boxes, boxErrorId, switchFocusAfterId, mutateSourceOnRead = false, mutateDocHead, includeSecondComponent = false, includeHiddenLayerText = false } = {}) {
		const state = {
			source: sourceFixture({ includeSecondComponent }),
			sourceReads: 0,
			strings: strings ?? [text('STR-TOP', 3, '5V'), text('STR-BOTTOM', 4, 'GND')],
			polylines: polylines ?? [],
			lines: lines ?? [],
			arcs: arcs ?? [],
			independentPads: independentPads ?? [pad('PAD-TOP', 1), pad('PAD-BOTTOM', 2), pad('PAD-MULTI', 12)],
			componentPads: componentPads ?? [pad('CPAD-1', 2, 'COMP-1')],
			boxes: boxes ?? new Map([
				['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
				['ATTR-U1', { minX: 10, minY: 5, maxX: 25, maxY: 15 }],
				['PAD-TOP', { minX: 12, minY: 6, maxX: 18, maxY: 12 }],
				['PAD-BOTTOM', { minX: 0, minY: 0, maxX: 1, maxY: 1 }],
				['PAD-MULTI', { minX: 200, minY: 200, maxX: 204, maxY: 204 }],
				['CPAD-1', { minX: 202, minY: 202, maxX: 210, maxY: 210 }],
			]),
			boxCalls: [],
			writes: [],
			focus: 'pcb-A',
			focusCalls: 0,
			getAllCalls: [],
			layerVisibilityCalls: 0,
			boxErrorId,
			switchFocusAfterId,
			mutateSourceOnRead,
		};
		const sdk = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => { state.focusCalls++; return { uuid: state.focus, documentType: 3 }; } },
			sys_FileManager: { getDocumentSource: async () => {
				state.sourceReads++;
				if (mutateDocHead) {
					const lines = state.source.split(/\r?\n/);
					const index = lines.findIndex(line => line.includes('||') && JSON.parse(line.slice(0, line.indexOf('||'))).type === 'DOCHEAD');
					const [header, payload] = lines[index].split('||');
					const data = JSON.parse(payload.slice(0, -1));
					if (mutateDocHead === 'volatile')
						Object.assign(data, { client: `client-${state.sourceReads}`, updateTime: state.sourceReads, version: `version-${state.sourceReads}` });
					else
						data.unknownMarker = state.sourceReads;
					lines[index] = `${header}||${JSON.stringify(data)}|`;
					state.source = lines.join('\n');
				}
				return state.source;
			} },
			pcb_Drc: { getCurrentRuleConfiguration: async () => rules },
			pcb_PrimitiveString: {
				getAll: async () => {
					state.getAllCalls.push('strings');
					if (state.mutateSourceOnRead)
						state.source += `\n${JSON.stringify({ type: 'TEXT', id: 'MUTATED', ticket: 5 })}||${JSON.stringify({ text: 'unexpected' })}|`;
					return state.strings;
				},
			},
			pcb_PrimitivePolyline: {
				getAll: async () => {
					state.getAllCalls.push('polylines');
					return state.polylines;
				},
			},
			pcb_PrimitiveLine: {
				getAll: async () => {
					state.getAllCalls.push('lines');
					return state.lines;
				},
			},
			pcb_PrimitiveArc: {
				getAll: async () => {
					state.getAllCalls.push('arcs');
					return state.arcs;
				},
			},
			pcb_PrimitivePad: { getAll: async () => { state.getAllCalls.push('pads'); return state.independentPads; } },
			pcb_PrimitiveComponent: {
				getAll: async () => { state.getAllCalls.push('components'); return componentsList ?? [component('COMP-1')]; },
				getAllPinsByPrimitiveId: async id => componentPadsById?.[id] ?? (id === 'COMP-1' ? state.componentPads : []),
			},
			pcb_Primitive: {
				getPrimitivesBBox: async ids => {
					assert.equal(ids.length, 1, 'request bbox with a real single primitive ID');
					const id = typeof ids[0] === 'string' ? ids[0] : ids[0].getState_PrimitiveId();
					state.boxCalls.push(id);
					if (id === state.boxErrorId)
						throw new Error('mock bbox SDK failure');
					if (id === state.switchFocusAfterId)
						state.focus = 'pcb-B';
					return state.boxes.get(id);
				},
			},
		};
		if (includeHiddenLayerText)
			state.strings.push(text('STR-HIDDEN-LAYER', 3, 'hidden-but-enumerated'));
		if (includeHiddenLayerText)
			state.boxes.set('STR-HIDDEN-LAYER', { minX: 400, minY: 400, maxX: 420, maxY: 408 });
		globalThis.eda = sdk;
		return { state, sdk };
	}

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

	await test('registers one read-only candidate-check command and validates minClearance', () => {
		assert.deepEqual(silkscreenCheckCommands.map(item => item.name), ['pcb.checkSilkscreen']);
		assert.deepEqual(validateSilkscreenCheckParams({}), { minClearance: 0 });
		assert.deepEqual(validateSilkscreenCheckParams({ minClearance: 2.5 }), { minClearance: 2.5 });
		for (const value of [-1, Infinity, NaN, '0'])
			assert.throws(() => validateSilkscreenCheckParams({ minClearance: value }));
		assert.throws(() => validateSilkscreenCheckParams({ unknown: true }));
	});

	await test('invalid thresholds are rejected before any SDK call', async () => {
		const f = install();
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ minClearance: -0.1 }));
		assert.equal(f.state.focusCalls, 0);
		assert.deepEqual(f.state.getAllCalls, []);
		assert.equal(f.state.writes.length, 0);
	});

	await test('uses full-precision SDK boxes and returns only explicitly unconfirmed candidates', async () => {
		const f = install();
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.complete, false);
		assert.equal(Object.hasOwn(result, 'clean'), false, 'an incomplete candidate check must not imply a board-level clean/dirty verdict');
		assert.equal(result.saved, false);
		assert.equal(result.sourceStable, true);
		assert.equal(result.coverage.minClearanceMil, 0);
		assert.ok(result.checkedObjects.some(item => item.id === 'ATTR-U1' && item.type === 'designator' && item.designator === 'U1'));
		assert.ok(result.checkedObjects.some(item => item.id === 'STR-TOP' && item.text === '5V'));
		assert.ok(result.checkedObjects.some(item => item.id === 'PAD-MULTI' && item.layer === 'multi'));
		assert.equal(result.checkedObjects.some(item => item.id === 'ATTR-HIDDEN'), false);
		assert.ok(result.unsupported.some(item => item.id === 'ATTR-OTHER' && item.type === 'visible-attribute'));
		assert.ok(result.unsupported.some(item => item.componentId === 'COMP-1' && item.type === 'component-footprint-silk'));
		assert.ok(result.potentialConflicts.some(item => item.a.id === 'STR-TOP' && item.b.id === 'PAD-TOP' && item.category === 'silk-to-pad-copper' && item.confirmed === false && item.evidence === 'BOX_NEIGHBOR'));
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('STR-TOP') && [item.a.id, item.b.id].includes('ATTR-U1') && item.category === 'silk-to-silk'));
		assert.ok(result.potentialConflicts.some(item => item.a.id === 'STR-BOTTOM' && item.b.id === 'PAD-MULTI'));
		assert.equal(result.potentialConflicts.some(item => item.a.id === 'STR-TOP' && item.b.id === 'PAD-BOTTOM'), false);
		assert.equal(f.state.boxCalls.includes('ATTR-HIDDEN'), false);
		assert.equal(f.state.writes.length, 0);
	});

	await test('same-side line and arc boxes join text/designator and PAD as unconfirmed candidates', async () => {
		const f = install({
			lines: [stroke('SILK-LINE-TOP', 3)],
			arcs: [stroke('SILK-ARC-TOP', 3, 'Arc')],
			boxes: new Map([
				['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
				['ATTR-U1', { minX: 22, minY: 3, maxX: 28, maxY: 6 }],
				['PAD-TOP', { minX: 12, minY: 6, maxX: 18, maxY: 12 }],
				['PAD-BOTTOM', { minX: 0, minY: 0, maxX: 1, maxY: 1 }],
				['PAD-MULTI', { minX: 200, minY: 200, maxX: 204, maxY: 204 }],
				['CPAD-1', { minX: 202, minY: 202, maxX: 210, maxY: 210 }],
				['SILK-LINE-TOP', { minX: 19, minY: 3, maxX: 25, maxY: 6 }],
				['SILK-ARC-TOP', { minX: 22, minY: 3, maxX: 28, maxY: 6 }],
			]),
		});
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A', minClearance: 2 });
		assert.ok(result.checkedObjects.some(item => item.id === 'SILK-LINE-TOP' && item.type === 'silk-line'));
		assert.ok(result.checkedObjects.some(item => item.id === 'SILK-ARC-TOP' && item.type === 'silk-arc'));
		for (const [a, b] of [['STR-TOP', 'SILK-LINE-TOP'], ['ATTR-U1', 'SILK-ARC-TOP'], ['SILK-LINE-TOP', 'SILK-ARC-TOP']])
			assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes(a) && [item.a.id, item.b.id].includes(b) && item.confirmed === false));
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('SILK-LINE-TOP') && [item.a.id, item.b.id].includes('PAD-TOP') && item.category === 'silk-to-pad-copper'));
		assert.ok(result.potentialConflicts.every(item => item.confirmed === false));
		assert.equal(result.coverage.checkedSilkLineCount, 1);
		assert.equal(result.coverage.checkedSilkArcCount, 1);
		assert.equal(result.coverage.complete, false);
		assert.equal(f.state.writes.length, 0);
	});

	await test('observed native POLY silk line uses one whole-path bbox and joins text, designator, pad, line, and arc candidates', async () => {
		const polylineId = '3b6b0cee6e4c6c5b';
		const f = install({
			polylines: [stroke(polylineId, 3, 'Polyline')],
			lines: [stroke('SUPPLEMENTAL-LINE-TOP', 3)],
			arcs: [stroke('SUPPLEMENTAL-ARC-TOP', 3, 'Arc')],
			boxes: new Map([
				['STR-TOP', { minX: 545, minY: 580, maxX: 715, maxY: 580 }],
				['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
				['ATTR-U1', { minX: 545, minY: 580, maxX: 715, maxY: 580 }],
				['PAD-TOP', { minX: 545, minY: 580, maxX: 715, maxY: 580 }],
				['PAD-BOTTOM', { minX: 200, minY: 200, maxX: 204, maxY: 204 }],
				['PAD-MULTI', { minX: 300, minY: 300, maxX: 304, maxY: 304 }],
				['CPAD-1', { minX: 400, minY: 400, maxX: 410, maxY: 410 }],
				[polylineId, { minX: 545, minY: 580, maxX: 715, maxY: 580 }],
				['SUPPLEMENTAL-LINE-TOP', { minX: 545, minY: 580, maxX: 715, maxY: 580 }],
				['SUPPLEMENTAL-ARC-TOP', { minX: 545, minY: 580, maxX: 715, maxY: 580 }],
			]),
		});
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		const polyline = result.checkedObjects.find(item => item.id === polylineId);
		assert.deepEqual(polyline, { id: polylineId, type: 'silk-polyline', layer: 'top', box: { minX: 545, minY: 580, maxX: 715, maxY: 580 } });
		for (const peer of ['STR-TOP', 'ATTR-U1', 'PAD-TOP', 'SUPPLEMENTAL-LINE-TOP', 'SUPPLEMENTAL-ARC-TOP'])
			assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes(polylineId) && [item.a.id, item.b.id].includes(peer) && item.confirmed === false));
		assert.equal(result.coverage.checkedSilkPolylineCount, 1);
		assert.equal(result.coverage.polylineSourceEvidence, 'native-silkscreen-line-observed-as-POLY');
		assert.equal(result.coverage.polylineSourceMapping, 'unknown');
		assert.equal(result.coverage.polylineEnumerationCompleteness, 'not-verified');
		assert.equal(result.coverage.polylineMayIncludeFootprintObjects, true);
		assert.equal(result.complete, false);
		assert.equal(f.state.writes.length, 0);
	});

	await test('SDK-enumerated footprint-like stroke remains only an unconfirmed box candidate with unknown source mapping', async () => {
		const f = install({ lines: [stroke('FOOTPRINT-LIKE-LINE', 3)] });
		f.state.boxes.set('FOOTPRINT-LIKE-LINE', { minX: 18, minY: 3, maxX: 24, maxY: 6 });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(result.checkedObjects.some(item => item.id === 'FOOTPRINT-LIKE-LINE' && item.type === 'silk-line'));
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('FOOTPRINT-LIKE-LINE') && [item.a.id, item.b.id].includes('STR-TOP') && item.confirmed === false));
		assert.equal(result.coverage.lineArcSourceMapping, 'unknown');
		assert.equal(result.coverage.lineArcEnumerationCompleteness, 'not-verified');
		assert.equal(result.coverage.lineArcMayIncludeFootprintObjects, true);
		assert.ok(result.unsupported.some(item => item.type === 'component-footprint-silk' && /来源映射/.test(item.reason)));
		assert.equal(result.complete, false);
		assert.equal(f.state.writes.length, 0);
	});

	await test('line and arc candidates exclude copper layers and the opposite silk side', async () => {
		const f = install({
			polylines: [stroke('POLY-COPPER', 1, 'Polyline'), stroke('POLY-BOTTOM', 4, 'Polyline')],
			lines: [stroke('LINE-COPPER', 1), stroke('LINE-BOTTOM', 4)],
			arcs: [stroke('ARC-COPPER', 2, 'Arc'), stroke('ARC-TOP', 3, 'Arc')],
			boxes: new Map([
				['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['STR-BOTTOM', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['ATTR-U1', { minX: 100, minY: 100, maxX: 110, maxY: 110 }],
				['PAD-TOP', { minX: 50, minY: 50, maxX: 60, maxY: 60 }],
				['PAD-BOTTOM', { minX: 50, minY: 50, maxX: 60, maxY: 60 }],
				['PAD-MULTI', { minX: 200, minY: 200, maxX: 204, maxY: 204 }],
				['CPAD-1', { minX: 202, minY: 202, maxX: 210, maxY: 210 }],
				['POLY-COPPER', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['POLY-BOTTOM', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['LINE-COPPER', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['LINE-BOTTOM', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['ARC-COPPER', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['ARC-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
			]),
		});
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.checkedObjects.some(item => ['POLY-COPPER', 'LINE-COPPER', 'ARC-COPPER'].includes(item.id)), false);
		assert.ok(result.checkedObjects.some(item => item.id === 'POLY-BOTTOM' && item.type === 'silk-polyline'));
		assert.ok(result.checkedObjects.some(item => item.id === 'LINE-BOTTOM'));
		assert.ok(result.checkedObjects.some(item => item.id === 'ARC-TOP'));
		assert.equal(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('STR-TOP') && [item.a.id, item.b.id].includes('LINE-BOTTOM')), false);
		assert.equal(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('STR-BOTTOM') && [item.a.id, item.b.id].includes('ARC-TOP')), false);
		assert.equal(f.state.boxCalls.includes('POLY-COPPER'), false);
		assert.equal(f.state.boxCalls.includes('LINE-COPPER'), false);
		assert.equal(f.state.boxCalls.includes('ARC-COPPER'), false);
	});

	await test('line and arc threshold uses SDK box distance at and outside the limit', async () => {
		const f = install({
			lines: [stroke('LINE-INSIDE', 3), stroke('LINE-EDGE', 3), stroke('LINE-OUTSIDE', 3)],
			arcs: [stroke('ARC-EDGE', 3, 'Arc')],
			boxes: new Map([
				['STR-TOP', { minX: 0, minY: 0, maxX: 10, maxY: 10 }],
				['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
				['ATTR-U1', { minX: 100, minY: 100, maxX: 110, maxY: 110 }],
				['PAD-TOP', { minX: 300, minY: 300, maxX: 310, maxY: 310 }],
				['PAD-BOTTOM', { minX: 320, minY: 320, maxX: 330, maxY: 330 }],
				['PAD-MULTI', { minX: 400, minY: 400, maxX: 404, maxY: 404 }],
				['CPAD-1', { minX: 402, minY: 402, maxX: 410, maxY: 410 }],
				['LINE-EDGE', { minX: 12, minY: 0, maxX: 18, maxY: 5 }],
				['LINE-INSIDE', { minX: 11, minY: 0, maxX: 18, maxY: 5 }],
				['LINE-OUTSIDE', { minX: 13, minY: 0, maxX: 18, maxY: 5 }],
				['ARC-EDGE', { minX: 0, minY: 12, maxX: 5, maxY: 18 }],
			]),
		});
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A', minClearance: 2 });
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('LINE-EDGE') && item.sdkBoxDistanceMil === 2));
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('LINE-INSIDE') && item.sdkBoxDistanceMil === 1));
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('ARC-EDGE') && item.sdkBoxDistanceMil === 2));
		assert.equal(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('LINE-OUTSIDE') && [item.a.id, item.b.id].includes('STR-TOP')), false);
		assert.equal(f.state.writes.length, 0);
	});

	await test('missing polyline/line/arc APIs and invalid IDs or boxes are disclosed as unsupported', async () => {
		const f = install({ lines: [object(undefined, { layer: 3 })], arcs: [stroke('ARC-NO-BOX', 4, 'Arc')] });
		delete f.sdk.pcb_PrimitivePolyline;
		delete f.sdk.pcb_PrimitiveLine;
		f.sdk.pcb_PrimitiveArc.getAll = undefined;
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(result.unsupported.some(item => item.type === 'silk-polyline' && /getAll/.test(item.reason)));
		assert.ok(result.unsupported.some(item => item.type === 'silk-line' && /getAll/.test(item.reason)));
		assert.ok(result.unsupported.some(item => item.type === 'silk-arc' && /getAll/.test(item.reason)));
		assert.equal(result.coverage.unsupportedSilkPolylineCount, 1);
		assert.equal(result.coverage.unsupportedSilkLineCount, 1);
		assert.equal(result.coverage.unsupportedSilkArcCount, 1);
		assert.equal(f.state.writes.length, 0);

		const noId = install({ lines: [object(undefined, { layer: 3 })] });
		const noIdResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(noIdResult.unsupported.some(item => item.type === 'silk-line' && /ID/.test(item.reason)));
		assert.equal(noId.state.boxCalls.includes(undefined), false);
		const polylineNoId = install({ polylines: [object(undefined, { layer: 3 })] });
		const polylineNoIdResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(polylineNoIdResult.unsupported.some(item => item.type === 'silk-polyline' && /ID/.test(item.reason)));
		assert.equal(polylineNoId.state.boxCalls.includes(undefined), false);
		const polylineMissingIdGetter = install({ polylines: [{ getState_Layer: () => 3 }] });
		const polylineMissingIdGetterResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(polylineMissingIdGetterResult.unsupported.some(item => item.type === 'silk-polyline' && /getState_PrimitiveId/.test(item.reason)));
		assert.equal(polylineMissingIdGetter.state.boxCalls.includes(undefined), false);
		const polylineMissingLayerGetter = install({ polylines: [{ getState_PrimitiveId: () => 'POLY-NO-LAYER' }] });
		const polylineMissingLayerGetterResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(polylineMissingLayerGetterResult.unsupported.some(item => item.id === 'POLY-NO-LAYER' && /getState_Layer/.test(item.reason)));
		assert.equal(polylineMissingLayerGetter.state.boxCalls.includes('POLY-NO-LAYER'), false);
		const missingIdGetter = install({ lines: [{ getState_Layer: () => 3 }] });
		const missingIdGetterResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(missingIdGetterResult.unsupported.some(item => item.type === 'silk-line' && /getState_PrimitiveId/.test(item.reason)));
		assert.equal(missingIdGetter.state.boxCalls.includes(undefined), false);

		const missingGetter = install({ lines: [{ getState_PrimitiveId: () => 'LINE-NO-LAYER' }] });
		const missingGetterResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(missingGetterResult.unsupported.some(item => item.id === 'LINE-NO-LAYER' && /getState_Layer/.test(item.reason)));
		assert.equal(missingGetter.state.boxCalls.includes('LINE-NO-LAYER'), false);

		const noBBox = install({ lines: [stroke('LINE-NO-BBOX', 3)] });
		delete noBBox.sdk.pcb_Primitive.getPrimitivesBBox;
		const noBBoxResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(noBBoxResult.unsupported.some(item => item.id === 'LINE-NO-BBOX' && /getPrimitivesBBox/.test(item.reason)));
		assert.equal(noBBoxResult.checkedObjects.length, 0);
		assert.equal(noBBox.state.writes.length, 0);
		const polylineNoBBox = install({ polylines: [stroke('POLY-NO-BBOX', 3, 'Polyline')] });
		const polylineNoBBoxResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(polylineNoBBoxResult.unsupported.some(item => item.id === 'POLY-NO-BBOX' && /包围盒/.test(item.reason)));
		assert.equal(polylineNoBBoxResult.checkedObjects.some(item => item.id === 'POLY-NO-BBOX'), false);
		assert.equal(polylineNoBBox.state.writes.length, 0);

		const badBox = install({ arcs: [stroke('ARC-BAD-BOX', 3, 'Arc')], boxes: new Map([['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }], ['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }], ['ATTR-U1', { minX: 10, minY: 5, maxX: 25, maxY: 15 }], ['PAD-TOP', { minX: 12, minY: 6, maxX: 18, maxY: 12 }], ['PAD-BOTTOM', { minX: 0, minY: 0, maxX: 1, maxY: 1 }], ['PAD-MULTI', { minX: 200, minY: 200, maxX: 204, maxY: 204 }], ['CPAD-1', { minX: 202, minY: 202, maxX: 210, maxY: 210 }], ['ARC-BAD-BOX', { minX: 4, minY: 0, maxX: 1, maxY: 1 }]]) });
		const badBoxResult = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(badBoxResult.unsupported.some(item => item.id === 'ARC-BAD-BOX' && /包围盒/.test(item.reason)));
		assert.equal(badBoxResult.checkedObjects.some(item => item.id === 'ARC-BAD-BOX'), false);
		assert.equal(badBox.state.writes.length, 0);
	});

	await test('duplicate polyline/line/arc identity conflicts are excluded and box neighbors never become confirmed collisions', async () => {
		const f = install({ polylines: [stroke('DUP-STROKE', 3, 'Polyline')], lines: [stroke('DUP-STROKE', 3)], arcs: [stroke('DUP-STROKE', 3, 'Arc')], boxes: new Map([
			['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
			['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
			['ATTR-U1', { minX: 10, minY: 5, maxX: 25, maxY: 15 }],
			['PAD-TOP', { minX: 12, minY: 6, maxX: 18, maxY: 12 }],
			['PAD-BOTTOM', { minX: 0, minY: 0, maxX: 1, maxY: 1 }],
			['PAD-MULTI', { minX: 200, minY: 200, maxX: 204, maxY: 204 }],
			['CPAD-1', { minX: 202, minY: 202, maxX: 210, maxY: 210 }],
			['DUP-STROKE', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
		]) });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.checkedObjects.some(item => item.id === 'DUP-STROKE'), false);
		assert.equal(result.potentialConflicts.some(item => item.a.id === 'DUP-STROKE' || item.b.id === 'DUP-STROKE'), false);
		assert.ok(result.unsupported.some(item => item.type === 'ambiguous-object' && item.id === 'DUP-STROKE'));
		assert.ok(result.potentialConflicts.every(item => item.confirmed === false));
		assert.equal(f.state.writes.length, 0);
	});

	await test('text-text candidates remain an independent comparison', async () => {
		const f = install({ strings: [text('TEXT-A', 3), text('TEXT-B', 3)], boxes: new Map([
			['TEXT-A', { minX: 0, minY: 0, maxX: 10, maxY: 5 }],
			['TEXT-B', { minX: 11, minY: 0, maxX: 20, maxY: 5 }],
			['ATTR-U1', { minX: 100, minY: 100, maxX: 110, maxY: 110 }],
			['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
			['PAD-TOP', { minX: 300, minY: 300, maxX: 310, maxY: 310 }],
			['PAD-BOTTOM', { minX: 300, minY: 300, maxX: 310, maxY: 310 }],
			['PAD-MULTI', { minX: 400, minY: 400, maxX: 404, maxY: 404 }],
			['CPAD-1', { minX: 402, minY: 402, maxX: 410, maxY: 410 }],
		]) });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A', minClearance: 2 });
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('TEXT-A') && [item.a.id, item.b.id].includes('TEXT-B') && item.category === 'silk-to-silk'));
		assert.equal(f.state.writes.length, 0);
	});

	await test('designator-designator candidates remain an independent comparison', async () => {
		const f = install({ includeSecondComponent: true, boxes: new Map([
			['STR-TOP', { minX: 300, minY: 300, maxX: 310, maxY: 308 }],
			['STR-BOTTOM', { minX: 320, minY: 320, maxX: 330, maxY: 328 }],
			['ATTR-U1', { minX: 0, minY: 0, maxX: 10, maxY: 10 }],
			['ATTR-U2', { minX: 11, minY: 0, maxX: 21, maxY: 10 }],
			['PAD-TOP', { minX: 500, minY: 500, maxX: 510, maxY: 510 }],
			['PAD-BOTTOM', { minX: 520, minY: 520, maxX: 530, maxY: 530 }],
			['PAD-MULTI', { minX: 600, minY: 600, maxX: 604, maxY: 604 }],
			['CPAD-1', { minX: 602, minY: 602, maxX: 610, maxY: 610 }],
		]) });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A', minClearance: 2 });
		assert.ok(result.potentialConflicts.some(item => [item.a.id, item.b.id].includes('ATTR-U1') && [item.a.id, item.b.id].includes('ATTR-U2') && item.category === 'silk-to-silk'));
		assert.equal(f.state.writes.length, 0);
	});

	await test('distance helper does not round and distinguishes overlap, edge contact, and gap', () => {
		const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
		assert.equal(sdkBoxDistanceMil(a, { minX: 10, minY: 10, maxX: 20, maxY: 20 }), 0);
		assert.equal(sdkBoxDistanceMil(a, { minX: 13, minY: 14, maxX: 20, maxY: 20 }), 5);
		assert.deepEqual(normalizeSdkBox({ minX: 0.1234, minY: 0, maxX: 1, maxY: 2 }), { minX: 0.1234, minY: 0, maxX: 1, maxY: 2 });
		assert.equal(normalizeSdkBox({ minX: 2, minY: 1, maxX: 1, maxY: 2 }), undefined);
		assert.equal(normalizeSdkBox({ minX: 0, minY: 0, maxX: Infinity, maxY: 2 }), undefined);
	});

	await test('a positive minClearance includes nearby boxes only on matching silk side', async () => {
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A', minClearance: 4 });
		assert.ok(result.potentialConflicts.some(item => item.a.id === 'STR-TOP' && item.b.id === 'PAD-BOTTOM') === false);
		assert.ok(result.potentialConflicts.every(item => item.sdkBoxDistanceMil <= 4));
	});

	await test('duplicate primitive IDs are deduplicated and component pad identity wins', async () => {
		const duplicate = pad('DUP-PAD', 1, 'COMP-1');
		const f = install({ independentPads: [pad('DUP-PAD', 1)], componentPads: [duplicate], boxes: new Map([
			['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
			['STR-BOTTOM', { minX: 200, minY: 200, maxX: 220, maxY: 208 }],
			['ATTR-U1', { minX: 30, minY: 30, maxX: 40, maxY: 40 }],
			['DUP-PAD', { minX: 2, minY: 2, maxX: 5, maxY: 5 }],
		]) });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		const matches = result.checkedObjects.filter(item => item.id === 'DUP-PAD');
		assert.equal(matches.length, 1);
		assert.equal(matches[0].type, 'component-pad');
		assert.equal(matches[0].componentId, 'COMP-1');
		assert.equal(f.state.boxCalls.filter(id => id === 'DUP-PAD').length, 2, 'one initial deduplicated box plus one fresh pad-mask readback');
	});

	await test('conflicting primitive layer identities are excluded from all candidates', async () => {
		const f = install({
			independentPads: [pad('DUP-LAYER', 1), pad('DUP-LAYER', 2)],
			componentPads: [],
			boxes: new Map([
				['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['ATTR-U1', { minX: 30, minY: 30, maxX: 40, maxY: 40 }],
				['DUP-LAYER', { minX: 2, minY: 2, maxX: 5, maxY: 5 }],
			]),
		});
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.checkedObjects.some(item => item.id === 'DUP-LAYER'), false);
		assert.equal(result.potentialConflicts.some(item => item.a.id === 'DUP-LAYER' || item.b.id === 'DUP-LAYER'), false);
		assert.ok(result.unsupported.some(item => item.id === 'DUP-LAYER' && item.type === 'ambiguous-object'));
		assert.equal(f.state.boxCalls.filter(id => id === 'DUP-LAYER').length, 1);
	});

	await test('conflicting parent component identities are excluded from all candidates', async () => {
		const f = install({
			includeSecondComponent: true,
			componentsList: [component('COMP-1'), component('COMP-2')],
			componentPadsById: {
				'COMP-1': [pad('DUP-PARENT', 1, 'COMP-1')],
				'COMP-2': [pad('DUP-PARENT', 1, 'COMP-2')],
			},
			boxes: new Map([
				['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
				['ATTR-U1', { minX: 30, minY: 30, maxX: 40, maxY: 40 }],
				['DUP-PARENT', { minX: 2, minY: 2, maxX: 5, maxY: 5 }],
			]),
		});
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.checkedObjects.some(item => item.id === 'DUP-PARENT'), false);
		assert.equal(result.potentialConflicts.some(item => item.a.id === 'DUP-PARENT' || item.b.id === 'DUP-PARENT'), false);
		assert.ok(result.unsupported.some(item => item.id === 'DUP-PARENT' && item.type === 'ambiguous-object'));
		assert.equal(f.state.boxCalls.filter(id => id === 'DUP-PARENT').length, 1);
	});

	await test('hidden layer visibility does not suppress objects returned by the layer getters', async () => {
		const f = install({ includeHiddenLayerText: true });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(result.checkedObjects.some(item => item.id === 'STR-HIDDEN-LAYER'));
		assert.equal(result.coverage.layerVisibilityChecked, false);
		assert.equal(f.state.layerVisibilityCalls, 0);
	});

	await test('invalid boxes become unsupported and never appear as empty coverage', async () => {
		const f = install({ boxes: new Map([
			['STR-TOP', { minX: 0, minY: 0, maxX: 20, maxY: 8 }],
			['STR-BOTTOM', undefined],
			['ATTR-U1', { minX: 10, minY: 5, maxX: 25, maxY: 15 }],
			['PAD-TOP', { minX: 12, minY: 6, maxX: 18, maxY: 12 }],
			['PAD-BOTTOM', { minX: 0, minY: 0, maxX: 1, maxY: 1 }],
			['PAD-MULTI', { minX: 200, minY: 200, maxX: 204, maxY: 204 }],
			['CPAD-1', { minX: 202, minY: 202, maxX: 210, maxY: 210 }],
		]) });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.ok(result.unsupported.some(item => item.id === 'STR-BOTTOM'));
		assert.equal(result.checkedObjects.some(item => item.id === 'STR-BOTTOM'), false);
		assert.equal(f.state.writes.length, 0);
	});

	await test('SDK bbox error stops subsequent reads and propagates as one read-only failure', async () => {
		const f = install({ boxErrorId: 'STR-TOP' });
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), error => {
			assert.equal(error.cause, undefined);
			return /mock bbox SDK failure/.test(error.message);
		});
		assert.deepEqual(f.state.boxCalls, ['ATTR-U1', 'STR-TOP']);
		assert.equal(f.state.writes.length, 0);
	});

	await test('focus switch during bbox reads stops the check immediately', async () => {
		const f = install({ switchFocusAfterId: 'ATTR-U1' });
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), error => /焦点已离开 PCB/.test(error.message));
		assert.deepEqual(f.state.boxCalls, ['ATTR-U1']);
		assert.equal(f.state.writes.length, 0);
	});

	await test('source change during read-only inspection invalidates the result', async () => {
		const f = install({ mutateSourceOnRead: true });
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), error => /基线已变化|源码发生变化/.test(error.message));
		assert.equal(f.state.writes.length, 0);
	});

	await test('volatile DOCHEAD client, updateTime, and version changes do not invalidate a stable read-only result', async () => {
		const f = install({ mutateDocHead: 'volatile' });
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.sourceStable, true);
		assert.ok(f.state.sourceReads >= 3);
		assert.equal(f.state.writes.length, 0);
	});

	await test('unknown DOCHEAD field changes invalidate a read-only result', async () => {
		const f = install({ mutateDocHead: 'unknown' });
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), /源码发生变化/);
		assert.equal(f.state.writes.length, 0);
	});

	await test('missing Gerber API is explicit without losing source-object candidates', async () => {
		install();
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.manufacturing.complete, false);
		assert.match(result.manufacturing.unavailableReason, /Gerber/);
		assert.equal(result.manufacturingSourceLocations.available, false);
		assert.equal(result.manufacturingMaskOverlapParticipation.available, false);
		assert.match(result.message, /制造检查不可用或未完成/);
		assert.ok(result.potentialConflicts.length > 0);
	});

	const gerberFixture = async () => {
		const zip = new JSZip();
		const header = '%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.2*%\nG75*\nG54D10*\n';
		zip.file('Gerber_TopSilkscreenLayer.GTO', header + 'G01X100000Y100000D02*\nG01X200000Y100000D01*\nM02*\n');
		zip.file('Gerber_BottomSilkscreenLayer.GBO', header + 'M02*\n');
		zip.file('Gerber_TopSolderMaskLayer.GTS', '%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,1*%\nG54D10*\nG01X150000Y100000D03*\nM02*\n');
		zip.file('Gerber_BottomSolderMaskLayer.GBS', header + 'M02*\n');
		zip.file('Gerber_BoardOutlineLayer.GKO', header + 'G01X0Y0D02*\nG01X1000000Y0D01*\nG01X1000000Y1000000D01*\nG01X0Y1000000D01*\nG01X0Y0D01*\nM02*\n');
		return new Blob([await zip.generateAsync({ type: 'uint8array' })]);
	};

	await test('official export is checked as a separate manufacturing result without design writes', async () => {
		const f = install();let exported = 0;
		f.sdk.pcb_ManufactureData = { getGerberFile: async () => { exported++;return await gerberFixture(); } };
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(exported, 1);
		assert.equal(result.manufacturing.scope, 'exported-manufacturing-only');
		assert.equal(result.manufacturing.complete, true);
		assert.ok(result.manufacturing.confirmedConflicts.length > 0);
		assert.equal(result.confirmedConflictCount, result.manufacturing.confirmedConflicts.length);
		assert.equal(result.manufacturingSourceLocations.complete, false);
		assert.equal(result.manufacturingSourceLocations.available, true);
		const maskParticipation = result.manufacturingMaskOverlapParticipation;
		assert.equal(maskParticipation.complete, false);
		assert.equal(maskParticipation.available, true);
		assert.ok(maskParticipation.results.some(item => item.manufacturingContribution === 'verified-at-witnesses'));
		assert.ok(maskParticipation.results.every(item => item.uniqueSourceAttribution === false));
		assert.match(result.message, /按面与类别统计/);
		assert.equal(result.designBoundingBoxConfirmedConflictCount, 0);
		assert.equal(result.complete, false);
		assert.equal(result.sourceStable, true);
		assert.equal(f.state.writes.length, 0);
	});

	await test('incomplete G74 export preserves manufacturing unknowns and is explicit in the command message', async () => {
		const f = install();
		f.sdk.pcb_ManufactureData = { getGerberFile: async () => {
			const zip = await JSZip.loadAsync(await gerberFixture());
			const silk = await zip.file('Gerber_TopSilkscreenLayer.GTO').async('string');
			zip.file('Gerber_TopSilkscreenLayer.GTO', silk.replace(/G01X100000Y100000D02\*\nG01X200000Y100000D01\*\n/, 'G01X100000Y0D02*\nG74*\nG02X0Y-100000I-100000J0D01*\n'));
			return new Blob([await zip.generateAsync({ type: 'uint8array' })]);
		} };
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.manufacturing.complete, false);
		assert.ok(Array.isArray(result.manufacturing.confirmedConflicts));
		assert.ok(Array.isArray(result.manufacturing.potentialConflicts));
		assert.ok(result.manufacturing.unknowns.some(item => /G75/.test(item)), 'G74 single-quadrant arc remains an explicit unsupported manufacturing unknown');
		assert.match(result.message, /制造检查不可用或未完成；保留制造报告中的原始原因/);
		assert.equal(result.sourceStable, true);
		assert.equal(f.state.writes.length, 0);
	});

	await test('switching documents during official export invalidates all results', async () => {
		const f = install();
		f.sdk.pcb_ManufactureData = { getGerberFile: async () => { const file = await gerberFixture();f.state.focus = 'pcb-B';return file; } };
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), /焦点已离开 PCB/);
		assert.equal(f.state.writes.length, 0);
	});

	await test('independent rule changes invalidate a read-only result even when source is unchanged', async () => {
		const f = install();let reads = 0;
		f.sdk.pcb_Drc.getCurrentRuleConfiguration = async () => ++reads === 1 ? { design: { spacing: 8 }, layers: [1, 2] } : { design: { spacing: 9 }, layers: [1, 2] };
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), /设计规则发生变化/);
		assert.equal(f.state.writes.length, 0);
	});

	await test('rule object key ordering is immaterial but rule arrays preserve their order', async () => {
		let f = install();let reads = 0;
		f.sdk.pcb_Drc.getCurrentRuleConfiguration = async () => ++reads === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 };
		let result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.rulesStable, true);
		assert.ok(result.sourceComparison.final.matches);
		f = install();reads = 0;
		f.sdk.pcb_Drc.getCurrentRuleConfiguration = async () => ({ layers: ++reads === 1 ? [1, 2] : [2, 1] });
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), /设计规则发生变化/);
	});

	await test('runtime pad snapshot changes invalidate only the new pad-mask association', async () => {
		const f = install(); let calls = 0; const original = f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
		f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId = async (...args) => { const pads = await original(...args); calls++; return pads.map(p => ({ ...p, getState_Rotation: () => calls === 1 ? 0 : 90 })); };
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.padMaskOpeningAssociations.sourceStable, false);
		assert.equal(result.padMaskOpeningAssociations.matches.length, 0);
		assert.equal(result.sourceStable, true);
		assert.equal(f.state.writes.length, 0);
	});

	for (const [getter, beforeValue, afterValue] of [
		['Hole', ['ROUND', 10, 10], ['ROUND', 12, 12]],
		['SpecialPad', [], [[1, 1, ['RECT', 44, 22, 0]]]],
		['HoleOffsetX', 0, 1], ['HoleOffsetY', 0, 1],
		['HoleRotation', 0, 90], ['Metallization', true, false],
		['SolderMaskAndPasteMaskExpansion', { topSolderMask: 0, bottomSolderMask: 7 }, { topSolderMask: 5, bottomSolderMask: 7 }],
		['SolderMaskAndPasteMaskExpansion', null, { topSolderMask: 0, bottomSolderMask: 7 }],
	]) {
		await test(`multi-layer ${getter} snapshot changes invalidate pad-mask association`, async () => {
			const f = install({ componentPads: [pad('CPAD-1', 12, 'COMP-1')] });
			let calls = 0;
			const original = f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
			f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId = async (...args) => {
				const values = await original(...args);
				calls++;
				return values.map(value => ({ ...value, [`getState_${getter}`]: () => calls === 1 ? beforeValue : afterValue }));
			};
			const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
			assert.equal(result.padMaskOpeningAssociations.sourceStable, false);
			assert.equal(result.padMaskOpeningAssociations.matches.length, 0);
			assert.equal(result.sourceStable, true);
			assert.equal(f.state.writes.length, 0);
		});
	}

	await test('source changes during new pad snapshot readback invalidate the read-only result', async () => {
		const f = install(); let calls = 0; const original = f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId;
		f.sdk.pcb_PrimitiveComponent.getAllPinsByPrimitiveId = async (...args) => { const pads = await original(...args); if (++calls === 2) f.state.source += '\n'+JSON.stringify({type:'TEXT',id:'LATE-MUTATION',ticket:99})+'||'+JSON.stringify({text:'changed'})+'|'; return pads; };
		await assert.rejects(() => command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' }), /源码发生变化/);
		assert.equal(f.state.writes.length, 0);
	});
	for (const net of ['ACE_MASK', '']) {
		await test(`duplicate special keys read named physical views once per network and phase (${net || 'empty net'})`, async () => {
			const values = ['CPAD-1', 'CPAD-2'].map(id => object(id, { primitiveType: 'Pad', layer: 12, parentComponentPrimitiveId: 'COMP-1', net, specialPad: [[1, 1, ['RECT', 20, 10, 0]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['RECT', 20, 10, 0]]] }));
			const f = install({ componentPads: values }); f.state.boxes.set('CPAD-2', f.state.boxes.get('CPAD-1')); f.sdk.sys_FileManager.getDocumentFootprintSources = async () => [];
			const queries = [];
			f.sdk.pcb_Net = { getAllPrimitivesByNet: async query => { queries.push(query); return values.map((_, i) => ({ globalIndex: `CPAD-${i + 1}`, parentId: 'COMP-1', layerId: 12, pcbItemPrimitiveType: 'Pad', net, topType: 'RECT', topWidth: 2, topHeight: 1, topRatio: 0, bottomType: 'RECT', bottomWidth: 2, bottomHeight: 1, bottomRatio: 0, inner: { 1: { type: 'OVAL', width: 8, height: 6, ratio: 0 } } })); } };
			const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
			assert.deepEqual(queries, [net, net]); assert.equal(result.padMaskOpeningAssociations.sourceStable, true); assert.equal(f.state.writes.length, 0);
		});
	}
	await test('named physical view changes invalidate associations while retaining manufacturing data', async () => {
		const value = object('CPAD-1', { primitiveType: 'Pad', layer: 12, parentComponentPrimitiveId: 'COMP-1', net: 'ACE_MASK', specialPad: [[1, 1, ['RECT', 20, 10, 0]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['RECT', 20, 10, 0]]] });
		const f = install({ componentPads: [value] }); f.sdk.sys_FileManager.getDocumentFootprintSources = async () => []; let reads = 0;
		f.sdk.pcb_Net = { getAllPrimitivesByNet: async () => [{ globalIndex: 'CPAD-1', parentId: 'COMP-1', layerId: 12, pcbItemPrimitiveType: 'Pad', net: 'ACE_MASK', topType: 'RECT', topWidth: ++reads === 1 ? 2 : 3, topHeight: 1, topRatio: 0, bottomType: 'RECT', bottomWidth: 2, bottomHeight: 1, bottomRatio: 0, inner: { 1: { type: 'OVAL', width: 8, height: 6, ratio: 0 } } }] };
		const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
		assert.equal(result.padMaskOpeningAssociations.sourceStable, false); assert.equal(result.padMaskOpeningAssociations.matches.length, 0); assert.equal(result.sourceStable, true); assert.equal(f.state.writes.length, 0);
	});

	for (const mode of ['empty-result', 'sdk-error', 'null-net', 'missing-net', 'wrong-parent', 'missing-top', 'valid-empty-net']) {
		await test(`failed physical view details survive the public command: ${mode}`, async () => {
			const value = object('CPAD-1', { primitiveType: 'Pad', layer: 12, parentComponentPrimitiveId: 'COMP-1', padNumber: '1', rotation: 0, pad: ['ELLIPSE', 20, 20], net: '', specialPad: [[1, 1, ['ELLIPSE', 20, 20]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['ELLIPSE', 20, 20]]] });
			const f = install({ componentPads: [value] }); f.state.boxes.set('CPAD-1', { minX: 160, minY: 170, maxX: 240, maxY: 230 });
			f.state.source += '\n' + JSON.stringify({ type: 'ATTR', id: 'FP-ATTR', ticket: 20 }) + '||' + JSON.stringify({ key: 'Footprint', parentId: 'COMP-1', value: 'FP-TEST' }) + '|';
			f.state.source += '\n' + JSON.stringify({ type: 'PAD_NET', id: JSON.stringify(['PAD_NET', 'COMP-1', '1', 'local-pad']), ticket: 21 }) + '||' + JSON.stringify({ padNet: '', padLen: null, attrsMap: {} }) + '|';
			const fp = JSON.stringify({ type: 'DOCHEAD', ticket: 0 }) + '||' + JSON.stringify({ uuid: 'FP-TEST', docType: 'FOOTPRINT' }) + '|\n' + JSON.stringify({ type: 'PAD', id: 'local-pad', ticket: 1 }) + '||' + JSON.stringify({ num: '1', layerId: 12, padType: 'NORMAL', padLen: 0, hole: { holeType: 'ROUND', width: 10, height: 10 }, defaultPad: { padType: 'ELLIPSE', width: 20, height: 20, radius: 0 }, specialPad: [{ startLayer: 1, endLayer: 15, pad: { padType: 'OVAL', width: 80, height: 60, radius: 0 } }], topSolderExpansion: 3, bottomSolderExpansion: 7 }) + '|';
			f.sdk.sys_FileManager.getDocumentFootprintSources = async () => [{ footprintUuid: 'FP-TEST', documentSource: fp }];
			const raw = { globalIndex: 'CPAD-1', parentId: 'COMP-1', layerId: 12, pcbItemPrimitiveType: 'Pad', net: '', topType: 'ELLIPSE', topWidth: 2, topHeight: 2, topRatio: 0, bottomType: 'ELLIPSE', bottomWidth: 2, bottomHeight: 2, bottomRatio: 0, inner: { 1: { type: 'OVAL', width: 8, height: 6, ratio: 0, pl: null } } };
			if (mode === 'null-net') raw.net = null;
			if (mode === 'missing-net') delete raw.net;
			if (mode === 'wrong-parent') raw.parentId = 'OTHER';
			if (mode === 'missing-top') delete raw.topType;
			const queries = [];
			f.sdk.pcb_Net = { getAllPrimitivesByNet: async net => { queries.push(net); if (mode === 'sdk-error') throw new Error('native empty-net failed'); return mode === 'empty-result' ? [] : [raw]; } };
			const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
			assert.deepEqual(queries, ['', '']); assert.equal(result.sourceStable, true); assert.equal(f.state.writes.length, 0);
			if (mode === 'valid-empty-net') { assert.equal(result.padMaskOpeningAssociations.matches.length, 2); return; }
			const diagnostic = result.padMaskOpeningAssociations.skipped.find(item => item.componentId === 'COMP-1' && item.padNumber === '1')?.physicalPadViewDiagnostic;
			assert(diagnostic, JSON.stringify(result.padMaskOpeningAssociations.skipped));
			assert.deepEqual(diagnostic.supplementalRead.requestNetwork, { type: 'string', value: '' });
			if (mode === 'empty-result') { assert.equal(diagnostic.supplementalRead.resultCount, 0); assert.equal(diagnostic.supplementalRead.idMatchCount, 0); }
			if (mode === 'sdk-error') { assert.equal(diagnostic.supplementalRead.status, 'sdk-error'); assert.match(diagnostic.supplementalRead.reason, /native empty-net failed/); }
			if (mode === 'null-net') { assert.deepEqual(diagnostic.supplementalRead.bindingFailures, ['net']); assert.deepEqual(diagnostic.supplementalRead.rawNetwork, { present: true, type: 'null', value: null }); }
			if (mode === 'missing-net') assert.deepEqual(diagnostic.supplementalRead.rawNetwork, { present: false, type: 'missing' });
			if (mode === 'wrong-parent') assert.deepEqual(diagnostic.supplementalRead.bindingFailures, ['parentId']);
			if (mode === 'missing-top') assert.equal(diagnostic.parseFailure.category, 'unsupported-shape-or-invalid-dimensions');
		});
	}

	for (const mode of ['stable', 'changed', 'first-export-error', 'second-export-error', 'missing-export', 'nonempty-network', 'wrong-parent']) {
		await test(`native DSN outer selection reads and stability: ${mode}`, async () => {
			const net = mode === 'nonempty-network' ? 'N1' : '';
			const value = object('CPAD-1', { primitiveType: 'Pad', layer: 12, parentComponentPrimitiveId: 'COMP-1', net, specialPad: [[1, 1, ['RECT', 20, 10, 0]], [1, 1, ['OVAL', 80, 60]], [2, 2, ['RECT', 20, 10, 0]]] });
			const f = install({ componentPads: [value] }); f.sdk.sys_FileManager.getDocumentFootprintSources = async () => [];
			f.sdk.pcb_Net = { getAllPrimitivesByNet: async () => mode === 'wrong-parent' ? [{ globalIndex: 'CPAD-1', parentId: 'OTHER', layerId: 12, pcbItemPrimitiveType: 'Pad', net }] : [] };
			let reads = 0;
			if (mode !== 'missing-export') f.sdk.pcb_ManufactureData = { getDsnFile: async name => {
				assert.equal(name, 'silkscreen-pad-outer'); reads++;
				if (mode === 'first-export-error' || (mode === 'second-export-error' && reads === 2)) throw Error('native DSN failure');
				const text = mode === 'changed' && reads === 2 ? '(PCB "changed")' : '(PCB "")';
				return { arrayBuffer: async () => new TextEncoder().encode(text).buffer };
			} };
			const result = await command('pcb.checkSilkscreen').handler({ __docUuid: 'pcb-A' });
			assert.equal(result.sourceStable, true); assert.equal(f.state.writes.length, 0);
			const status = result.nativeDsnOuterSelection;
			if (mode === 'nonempty-network' || mode === 'wrong-parent') { assert.equal(reads, 0); assert.equal(status.status, 'not-needed'); }
			else if (mode === 'stable') { assert.equal(reads, 2); assert.equal(status.status, 'stable'); assert.equal(status.stable, true); }
			else { assert.equal(reads, mode === 'missing-export' ? 0 : mode === 'first-export-error' ? 1 : 2); assert.equal(status.status, 'unavailable'); assert.equal(status.stable, false); assert(status.reason); }
		});
	}

	console.log(`\n${passed} silkscreen check regression tests passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
