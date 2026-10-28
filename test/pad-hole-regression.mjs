import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: 'import { padHoleCommands } from \'../src/commands/padHole.ts\'; import { circlePolygonSource, padShapeForSdk, validatePlaceHole, validatePlacePad } from \'../src/engine/padHole.ts\'; export { padHoleCommands, circlePolygonSource, padShapeForSdk, validatePlaceHole, validatePlacePad }',
			resolveDir: resolve(root, 'test'),
			sourcefile: 'pad-hole-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { padHoleCommands, circlePolygonSource, padShapeForSdk, validatePlaceHole, validatePlacePad } = await import(moduleUrl);
	const command = name => padHoleCommands.find(item => item.name === name);
	const docHead = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid, client: 'pad-hole-test' })}|`;
	const rules = { design: { spacing: 8 } };
	const baselineRow = `${JSON.stringify({ type: 'TEXT', id: 'OLD-TEXT', ticket: 11 })}||${JSON.stringify({ text: 'preserve-me', layerId: 3 })}|`;
	// Exact target source fields extracted from the real mask-snapshot trial's createdSourceData.
	const compactTrialCreatedPad = { partitionId: '', groupId: 0, netName: '', layerId: 1, num: '', centerX: 300, centerY: 500, padAngle: 0, hole: null, defaultPad: { padType: 'ELLIPSE', width: 40, height: 40 }, specialPad: [], padOffsetX: 0, padOffsetY: 0, relativeAngle: null, plated: false, padType: 'NORMAL', topSolderExpansion: null, bottomSolderExpansion: null, topPasteExpansion: null, bottomPasteExpansion: null, locked: false, zIndex: -1, connectMode: null, spokeSpace: null, spokeWidth: null, spokeAngle: null, unusedInnerLayers: [], padLen: 0, propagationDelay: 0, attrsMap: {} };

	function polygon(source) {
		return { getSource: () => structuredClone(source) };
	}

	function padObject(id, values) {
		const state = { primitiveId: id, primitiveType: 'Pad', primitiveLock: false, padNumber: '', rotation: 0, holeOffsetX: 0, holeOffsetY: 0, holeRotation: 0, specialPad: undefined, heatWelding: null, ...values };
		const object = Object.fromEntries(Object.keys(state).map((key) => {
			const suffix = key[0].toUpperCase() + key.slice(1);
			return [`getState_${suffix}`, () => state[key]];
		}));
		Object.defineProperty(object, '__state', { value: state });
		return object;
	}

	function fillObject(id, values) {
		const state = { primitiveId: id, primitiveType: 'Fill', primitiveLock: false, fillMode: 0, lineWidth: 0, net: '', ...values };
		return Object.fromEntries(Object.entries(state).map(([key, value]) => [`getState_${key[0].toUpperCase() + key.slice(1)}`, () => value]));
	}

	function install({ compactTrialSource = false, failCreate = false, delayedCreate = false, delayedPadCreate = false, delayedPadModify = false, failPadModify = false, modifySourceMaskOverride, modifyReadbackMaskOverride, staleModifiedPadTicket = false, mutateNonTargetAfterTarget = false, freshDefaultsOverride, changeRulesOnFreshPadRead = false, delaySourceReadCall = 0, mutateSourceBeforeMaskModify = false, sourceReadDelayMs = 1200, badReadback = false, switchFocus = false, mutateNonTarget = false, mutateOldData = false, getAllMissingId = false, hostSourceFormat = true, reticketExisting = true, badEmptyNetAuxiliary = false, initialEmptyNetAuxiliary = false, duplicateEmptyNetAuxiliary = false, namedNetAuxiliary = false, badNamedNetAuxiliary = false, mismatchedNamedNetAuxiliary = false, extraNamedNetAuxiliary = false, initialNamedNetAuxiliary, mutateExistingNamedNet = false, docHeadVolatileMutation = false, docHeadUnknownMutation = false, holeOffsetReadbackOverride, holeOffsetSourceOverride, sourcePadRadiusOverride, getterGeometryOverride, sourceGeometryOverride, readbackRotationOverride, effectiveMask = { topSolderMask: 2, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 }, sourceMaskOverride, readbackMaskOverride, fillSourcePathMutation, fillSourceWidth = 1, fillReadbackWidth = 1 } = {}) {
		const state = {
			source: `${docHead('pcb-A')}\n${baselineRow}`,
			pads: new Map(),
			fills: new Map(),
			writes: [],
			padModifyCalls: [],
			events: [],
			focus: 'pcb-A',
			nextId: 1,
			nextTicket: 12,
			sourceReadCount: 0,
			padGetCount: 0,
			rules,
			badReadback,
			getAllMissingId,
		};
		const append = (type, id, data) => {
			state.source += `\n${JSON.stringify({ type, id, ticket: state.nextTicket++ })}||${JSON.stringify(data)}|`;
		};
		const mutateDocHead = (mutation) => {
			state.source = state.source.split(/\r?\n/).map((line) => {
				if (!line)
					return line;
				const separator = line.indexOf('||');
				const header = JSON.parse(line.slice(0, separator));
				if (header.type !== 'DOCHEAD')
					return line;
				const data = JSON.parse(line.slice(separator + 2, -1));
				Object.assign(data, mutation);
				return `${JSON.stringify(header)}||${JSON.stringify(data)}|`;
			}).join('\n');
		};
		const reticket = () => {
			let ticket = 1;
			state.source = state.source.split(/\r?\n/).map((line) => {
				if (!line)
					return line;
				const separator = line.indexOf('||');
				const header = JSON.parse(line.slice(0, separator));
				if (header.type !== 'DOCHEAD')
					header.ticket = ticket++;
				return `${JSON.stringify(header)}||${line.slice(separator + 2)}`;
			}).join('\n');
		};
		const addEmptyNetAuxiliary = () => {
			const netId = JSON.stringify(['NET', '']);
			const selectorId = JSON.stringify(['RULE_SELECTOR', ['NET', '']]);
			const sourceLines = state.source.split(/\r?\n/);
			const contains = (type, id) => sourceLines.some((line) => {
				const header = JSON.parse(line.slice(0, line.indexOf('||')));
				return header.type === type && header.id === id;
			});
			if (!contains('NET', netId)) {
				append('NET', netId, { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null });
				append('RULE_SELECTOR', selectorId, badEmptyNetAuxiliary
					? { ruleOrder: 4, ruleKeyValue: { TRACK: 'unexpected' }, copperValue: {}, innerPlaneValue: {}, parent: null }
					: { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null });
			}
		};
		const addNamedNetAuxiliary = (netName, { badData = false, extra = false } = {}) => {
			const netId = JSON.stringify(['NET', netName]);
			const selectorId = JSON.stringify(['RULE_SELECTOR', ['NET', netName]]);
			append('NET', netId, { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null });
			append('RULE_SELECTOR', selectorId, badData
				? { ruleOrder: 4, ruleKeyValue: { TRACK: 'unexpected' }, copperValue: {}, innerPlaneValue: {}, parent: null }
				: { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null });
			if (extra)
				append('TEXT', 'UNEXPECTED-NAMED-AUX', { text: 'unexpected-auxiliary' });
		};
		if (initialEmptyNetAuxiliary) {
			append('NET', JSON.stringify(['NET', '']), { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null });
			append('RULE_SELECTOR', JSON.stringify(['RULE_SELECTOR', ['NET', '']]), { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null });
		}
		if (initialNamedNetAuxiliary) {
			const netId = JSON.stringify(['NET', initialNamedNetAuxiliary]);
			const selectorId = JSON.stringify(['RULE_SELECTOR', ['NET', initialNamedNetAuxiliary]]);
			append('NET', netId, { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null });
			append('RULE_SELECTOR', selectorId, { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null });
		}
		const makePad = (layer, padNumber, x, y, rotation, pad, net, hole, holeOffsetX, holeOffsetY, holeRotation, metallization, padType, specialPad, mask, heatWelding, primitiveLock) => {
			const id = `PAD-${state.nextId++}`;
			const roundTenth = value => Math.round(value * 10) / 10;
			const getterPad = Array.isArray(pad) && pad[0] === 'ELLIPSE'
				? [pad[0], roundTenth(pad[1]), roundTenth(pad[2])]
				: pad;
			const values = {
				layer,
				padNumber,
				x: getterGeometryOverride?.x ?? roundTenth(x),
				y: getterGeometryOverride?.y ?? roundTenth(y),
				rotation: readbackRotationOverride ?? rotation,
				pad: getterGeometryOverride?.pad ?? getterPad,
				net: net || '',
				hole,
				holeOffsetX: holeOffsetReadbackOverride?.x ?? holeOffsetX,
				holeOffsetY: holeOffsetReadbackOverride?.y ?? holeOffsetY,
				holeRotation,
				metallization,
				padType,
				specialPad,
				solderMaskAndPasteMaskExpansion: { ...effectiveMask, ...mask, ...readbackMaskOverride },
				heatWelding,
				primitiveLock,
			};
			const object = padObject(id, {
				...values,
				...(state.badReadback ? { pad: ['ELLIPSE', 999, 999] } : {}),
			});
			state.pads.set(id, object);
			if (hostSourceFormat && (net ?? '') === '')
				addEmptyNetAuxiliary();
			else if (hostSourceFormat && namedNetAuxiliary && (net ?? '') !== '')
				addNamedNetAuxiliary(mismatchedNamedNetAuxiliary ? `${net}_OTHER` : net, { badData: badNamedNetAuxiliary, extra: extraNamedNetAuxiliary });
			if (mutateExistingNamedNet && initialNamedNetAuxiliary) {
				const existingNetId = JSON.stringify(['NET', initialNamedNetAuxiliary]);
				append('NET', existingNetId, { netType: null, specialColor: 'mutated', retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null });
			}
			const sourceHole = hole == null ? null : { holeType: hole[0], width: hole[1], height: hole[1], cornerRadius: 11.811 };
			const sourcePad = Array.isArray(pad) && (pad[0] === 'ELLIPSE' || pad[0] === 'RECT')
				? { padType: pad[0], width: pad[1], height: pad[2], ...(pad[0] === 'RECT' ? { radius: sourcePadRadiusOverride ?? pad[3] } : {}) }
				: pad;
			const sourceData = compactTrialSource
				? structuredClone(compactTrialCreatedPad)
				: {
						layerId: layer,
						num: padNumber,
						centerX: x,
						centerY: y,
						padAngle: rotation,
						defaultPad: sourcePad,
						hole: sourceHole,
						netName: net || '',
						plated: Boolean(metallization),
						padType: 'NORMAL',
						relativeAngle: layer === 12 ? 0 : null,
						padOffsetX: holeOffsetSourceOverride?.x ?? holeOffsetX,
						padOffsetY: holeOffsetSourceOverride?.y ?? holeOffsetY,
						topSolderExpansion: sourceMaskOverride?.topSolderExpansion ?? mask?.topSolderMask ?? null,
						bottomSolderExpansion: sourceMaskOverride?.bottomSolderExpansion ?? mask?.bottomSolderMask ?? null,
						topPasteExpansion: sourceMaskOverride?.topPasteExpansion ?? mask?.topPasteMask ?? null,
						bottomPasteExpansion: sourceMaskOverride?.bottomPasteExpansion ?? mask?.bottomPasteMask ?? null,
						locked: primitiveLock,
					};
			Object.assign(sourceData, sourceGeometryOverride);
			append('PAD', id, sourceData);
			if (mutateNonTarget)
				append('TEXT', 'UNRELATED', { text: 'changed-by-host' });
			if (mutateOldData) {
				state.source = state.source.replace('preserve-me', 'changed-old-data');
			}
			if (duplicateEmptyNetAuxiliary && hostSourceFormat && (net ?? '') === '') {
				append('NET', JSON.stringify(['NET', '']), { netType: null, specialColor: null, retLine: true, differentialName: null, isPositiveNet: false, equalLengthGroupName: null });
				append('RULE_SELECTOR', JSON.stringify(['RULE_SELECTOR', ['NET', '']]), { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null });
			}
			if (docHeadVolatileMutation)
				mutateDocHead({ client: 'new-client', updateTime: 123, version: 'new-version' });
			if (docHeadUnknownMutation)
				mutateDocHead({ unknownMutation: true });
			if (badEmptyNetAuxiliary && hostSourceFormat && (net ?? '') === '')
				append('TEXT', 'UNRELATED-AUX', { text: 'unexpected-auxiliary' });
			if (reticketExisting)
				reticket();
			if (switchFocus)
				state.focus = 'pcb-B';
			return object;
		};
		const modifyPadMask = async (id, patch) => {
			state.events.push({ type: 'modify', id, patch: structuredClone(patch) });
			state.padModifyCalls.push({ id, patch: structuredClone(patch) });
			if (failPadModify)
				throw new Error('mock pad modify failure');
			if (delayedPadModify)
				await new Promise(resolve => setTimeout(resolve, 1100));
			const object = state.pads.get(id);
			if (!object)
				throw new Error('mock pad missing for modify');
			Object.assign(object.__state, { solderMaskAndPasteMaskExpansion: { ...structuredClone(patch.solderMaskAndPasteMaskExpansion), ...modifyReadbackMaskOverride } });
			const lines = state.source.split(/\r?\n/);
			let targetLine = -1;
			let targetHeader;
			let targetData;
			for (let index = 0; index < lines.length; index++) {
				const separator = lines[index].indexOf('||');
				if (separator < 0)
					continue;
				const header = JSON.parse(lines[index].slice(0, separator));
				if (header.type === 'PAD' && header.id === id) {
					targetLine = index;
					targetHeader = header;
					targetData = JSON.parse(lines[index].slice(separator + 2, -1));
				}
			}
			if (targetLine < 0)
				throw new Error('mock source target PAD missing');
			const applied = patch.solderMaskAndPasteMaskExpansion;
			Object.assign(targetData, {
				topSolderExpansion: modifySourceMaskOverride?.topSolderExpansion ?? applied.topSolderMask,
				bottomSolderExpansion: modifySourceMaskOverride?.bottomSolderExpansion ?? applied.bottomSolderMask,
				topPasteExpansion: modifySourceMaskOverride?.topPasteExpansion ?? applied.topPasteMask,
				bottomPasteExpansion: modifySourceMaskOverride?.bottomPasteExpansion ?? applied.bottomPasteMask,
			});
			const priorTicket = targetHeader.ticket;
			if (compactTrialSource) {
				if (staleModifiedPadTicket)
					targetHeader.ticket = Number(priorTicket ?? 0) - 1;
				lines[targetLine] = `${JSON.stringify(targetHeader)}||${JSON.stringify(targetData)}|`;
			}
			else {
				targetHeader.ticket = staleModifiedPadTicket ? Number(priorTicket ?? 0) - 1 : state.nextTicket++;
				lines.push(`${JSON.stringify(targetHeader)}||${JSON.stringify(targetData)}|`);
			}
			state.source = lines.join('\n');
			if (mutateNonTargetAfterTarget)
				append('TEXT', 'TAIL-AFTER-PAD', { text: 'unexpected trailing record' });
			return object;
		};
		const makeFill = (layer, shape, net = '', fillMode = 0, _lineWidth = 0, primitiveLock = false) => {
			const id = `FILL-${state.nextId++}`;
			const values = { layer, complexPolygon: polygon(shape.getSource()), net, fillMode, lineWidth: fillReadbackWidth, primitiveLock };
			const object = fillObject(id, values);
			state.fills.set(id, object);
			const path = fillSourcePathMutation ?? [shape.getSource()];
			append('FILL', id, { path, layerId: layer, width: fillSourceWidth, fillStyle: 'SOLID', netName: net, locked: primitiveLock });
			if (mutateNonTarget)
				append('TEXT', 'UNRELATED', { text: 'changed-by-host' });
			if (reticketExisting)
				reticket();
			return object;
		};
		const sdk = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: state.focus, documentType: 3 }) },
			sys_FileManager: { getDocumentSource: async () => {
				state.sourceReadCount++;
				state.events.push({ type: 'source', count: state.sourceReadCount });
				if (mutateSourceBeforeMaskModify && state.sourceReadCount === 5)
					append('TEXT', 'UNRELATED-BEFORE-MODIFY', { text: 'changed-before-mask-modify' });
				if (state.sourceReadCount === delaySourceReadCall)
					await new Promise(resolve => setTimeout(resolve, sourceReadDelayMs));
				return state.source;
			} },
			pcb_Drc: { getCurrentRuleConfiguration: async () => state.rules },
			pcb_MathPolygon: { createPolygon: source => polygon(source) },
			pcb_PrimitivePad: {
				getAll: async () => [...state.pads.values()].filter(item => !state.getAllMissingId || item.getState_PrimitiveId() !== 'PAD-1'),
				get: async (id) => {
					state.padGetCount++;
					const object = state.pads.get(id);
					if (object && state.padGetCount === 2 && freshDefaultsOverride)
						Object.assign(object.__state, { solderMaskAndPasteMaskExpansion: { ...object.__state.solderMaskAndPasteMaskExpansion, ...freshDefaultsOverride } });
					if (object && state.padGetCount === 2 && changeRulesOnFreshPadRead)
						state.rules = { design: { spacing: 99 } };
					return object;
				},
				modify: modifyPadMask,
				create: async (...args) => {
					state.writes.push({ type: 'pad', args });
					if (failCreate)
						throw new Error('mock pad create failure');
					if (delayedPadCreate)
						await new Promise(resolve => setTimeout(resolve, 1100));
					const object = makePad(...args);
					state.events.push({ type: 'create', id: object.getState_PrimitiveId() });
					return object;
				},
			},
			pcb_PrimitiveFill: {
				getAll: async () => [...state.fills.values()],
				get: async id => state.fills.get(id),
				create: async (...args) => {
					state.writes.push({ type: 'fill', args });
					if (failCreate)
						throw new Error('mock fill create failure');
					if (delayedCreate)
						await new Promise(resolve => setTimeout(resolve, 1100));
					return makeFill(...args);
				},
			},
		};
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

	await test('registers only the two B3 commands and uses the formal CIRCLE source tuple', () => {
		assert.deepEqual(padHoleCommands.map(item => item.name), ['pcb.placeHole', 'pcb.placePad']);
		assert.deepEqual(circlePolygonSource(12, 34, 20), ['CIRCLE', 12, 34, 10]);
	});

	await test('validates NPTH/PTH hole and top/bottom SMD modes without manufacturing defaults', () => {
		assert.deepEqual(validatePlaceHole({ x: 10, y: 20, holeDiameter: 30, plated: false }), { x: 10, y: 20, holeDiameter: 30, plated: false });
		assert.deepEqual(validatePlaceHole({ x: 10, y: 20, holeDiameter: 30, padDiameter: 50, plated: true }), { x: 10, y: 20, holeDiameter: 30, padDiameter: 50, plated: true });
		assert.deepEqual(validatePlacePad({ x: 10, y: 20, layer: 'bottom', shape: 'rectangle', width: 40, height: 20 }), { x: 10, y: 20, layer: 'bottom', shape: 'rectangle', width: 40, height: 20, cornerRadius: 0 });
		assert.deepEqual(padShapeForSdk({ shape: 'rectangle', width: 60, height: 40, cornerRadius: 5 }), ['RECT', 60, 40, 25]);
		assert.deepEqual(padShapeForSdk({ shape: 'rectangle', width: 40, height: 60, cornerRadius: 5 }), ['RECT', 40, 60, 25]);
		assert.deepEqual(padShapeForSdk({ shape: 'rectangle', width: 60, height: 40, cornerRadius: 0 }), ['RECT', 60, 40, 0]);
		assert.deepEqual(padShapeForSdk({ shape: 'rectangle', width: 60, height: 40, cornerRadius: 20 }), ['RECT', 60, 40, 100]);
	});

	await test('invalid or ambiguous inputs reject before any EDA call or write', async () => {
		const invalid = [
			{ cmd: 'pcb.placeHole', params: { x: 10, y: 20, holeDiameter: 30, plated: 'false' } },
			{ cmd: 'pcb.placeHole', params: { x: 10, y: 20, holeDiameter: 30, plated: true } },
			{ cmd: 'pcb.placeHole', params: { x: 10, y: 20, holeDiameter: 30, padDiameter: 30, plated: false } },
			{ cmd: 'pcb.placeHole', params: { x: 10, y: 20, holeDiameter: 30, plated: false, net: 'GND' } },
			{ cmd: 'pcb.placeHole', params: { x: 10, y: 20, holeDiameter: 30, plated: false, solderMaskOpen: true } },
			{ cmd: 'pcb.placePad', params: { x: 10, y: 20, layer: 'multi', shape: 'circle', diameter: 20 } },
			{ cmd: 'pcb.placePad', params: { x: 10, y: 20, layer: 'top', shape: 'circle', width: 20, height: 20 } },
		];
		for (const item of invalid) {
			const f = install();
			await assert.rejects(() => command(item.cmd).handler(item.params));
			assert.equal(f.state.writes.length, 0);
		}
	});

	await test('creates exact circular no-copper mechanical NPTH as MULTI Fill and independently verifies SDK/source', async () => {
		const f = install();
		const result = await command('pcb.placeHole').handler({ __docUuid: 'pcb-A', x: 200, y: 300, holeDiameter: 32, plated: false });
		assert.equal(result.operation, 'placeHole');
		assert.equal(result.created[0].primitiveType, 'Fill');
		assert.equal(result.created[0].holeKind, 'mechanical-npth');
		assert.equal(result.created[0].holeDiameter, 32);
		assert.deepEqual(f.state.writes[0].args.slice(0, 1), [12]);
		assert.deepEqual(f.state.writes[0].args[1].getSource(), ['CIRCLE', 200, 300, 16]);
		assert.equal(result.saved, false);
		assert.equal(result.manufacturingExportVerified, false);
		assert.ok(result.verifiedIds.includes(result.created[0].id));
		assert.deepEqual(result.created[0].lineWidthNormalization, { submitted: 0, sdkReadback: 1, sourceReadback: 1, normalized: true });
	});

	await test('accepts inherited mask effective values from the host without hardcoding a rule result', async () => {
		const effectiveMask = { topSolderMask: 4, bottomSolderMask: 5, topPasteMask: 1, bottomPasteMask: 2 };
		const f = install({ effectiveMask });
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 });
		assert.deepEqual(result.created[0].solderMaskAndPasteMaskExpansion, {
			requested: null,
			mode: 'inherited',
			effective: effectiveMask,
			effectiveResolved: true,
			fields: {
				topSolderMask: { mode: 'inherited', requested: null, getter: 4, effectiveResolved: true },
				bottomSolderMask: { mode: 'inherited', requested: null, getter: 5, effectiveResolved: true },
				topPasteMask: { mode: 'inherited', requested: null, getter: 1, effectiveResolved: true },
				bottomPasteMask: { mode: 'inherited', requested: null, getter: 2, effectiveResolved: true },
			},
		});
		const padRow = f.state.source.split(/\r?\n/).map(line => line.includes('"type":"PAD"') ? JSON.parse(line.slice(line.indexOf('||') + 2, -1)) : null).find(Boolean);
		assert.equal(padRow.topSolderExpansion, null);
		assert.equal(padRow.bottomSolderExpansion, null);
	});

	await test('rejects inherited-mask readback when source unexpectedly stores an explicit value', async () => {
		const f = install({ sourceMaskOverride: { topSolderExpansion: 6 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 }), /源码几何\/孔\/层\/网络\/阻焊读回与请求不符/);
		assert.equal(f.state.writes.length, 1);
	});

	await test('rejects inherited-mask getter when any effective field is missing or non-finite', async () => {
		const f = install({ effectiveMask: { topSolderMask: 2, bottomSolderMask: 2, topPasteMask: 0 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 }), /独立 SDK 读回属性与请求不符/);
		assert.equal(f.state.writes.length, 1);
	});

	await test('partial mask uses the actual creation getter as defaults, while a final or complete explicit mismatch fails', async () => {
		const f = install({ readbackMaskOverride: { topSolderMask: 9 } });
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } });
		assert.equal(f.state.writes.length, 1);
		assert.deepEqual(result.created[0].solderMaskAndPasteMaskExpansion.defaultsReadback, { topSolderMask: 9, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 });
		assert.deepEqual(result.created[0].solderMaskAndPasteMaskExpansion.applied, { topSolderMask: 3, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 });

		const finalMismatch = install({ modifyReadbackMaskOverride: { topSolderMask: 9 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), /独立 SDK 读回属性与请求不符/);
		assert.equal(finalMismatch.state.padModifyCalls.length, 1);

		const fullMismatch = install({ readbackMaskOverride: { topSolderMask: 9 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 } }), /独立 SDK 读回属性与请求不符/);
		assert.equal(fullMismatch.state.padModifyCalls.length, 0);
	});

	await test('partial mask snapshots actual creation defaults and explicitly applies them with one same-ID modify', async () => {
		const effectiveMask = { topSolderMask: 7, bottomSolderMask: 5, topPasteMask: 1, bottomPasteMask: 2 };
		const f = install({ effectiveMask });
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } });
		const report = result.created[0].solderMaskAndPasteMaskExpansion;
		assert.deepEqual(f.state.writes[0].args[14], null);
		assert.equal(f.state.padModifyCalls.length, 1);
		assert.equal(f.state.padModifyCalls[0].id, result.created[0].id);
		assert.deepEqual(f.state.padModifyCalls[0].patch.solderMaskAndPasteMaskExpansion, { topSolderMask: 3, bottomSolderMask: 5, topPasteMask: 1, bottomPasteMask: 2 });
		assert.deepEqual(report, {
			mode: 'explicit-with-default-snapshot',
			requested: { topSolderMask: 3 },
			defaultsReadback: effectiveMask,
			applied: { topSolderMask: 3, bottomSolderMask: 5, topPasteMask: 1, bottomPasteMask: 2 },
			defaultedFields: ['bottomSolderMask', 'topPasteMask', 'bottomPasteMask'],
			semantics: '未提供字段已按创建时 getter 读回值显式固定，不是未来动态继承',
		});
		assert.equal(result.created[0].sourceReadback.sourceVerification.maskModify.sourceRecordCount, 2);
		const sequence = f.state.events.filter(item => ['create', 'source', 'modify'].includes(item.type));
		const createdIndex = sequence.findIndex(item => item.type === 'create' && item.id === 'PAD-1');
		const modifyIndex = sequence.findIndex(item => item.type === 'modify' && item.id === 'PAD-1');
		assert.ok(createdIndex >= 0 && modifyIndex > createdIndex);
		assert.ok(sequence.slice(createdIndex + 1, modifyIndex).some(item => item.type === 'source'));
		assert.ok(sequence.slice(modifyIndex + 1).some(item => item.type === 'source'));
		assert.equal(f.state.writes.length, 1);
		assert.equal(result.saved, false);
	});

	await test('accepts the real trial compact source shape and append-only PAD version shape', async () => {
		const f = install({ compactTrialSource: true });
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 300, y: 500, layer: 'top', shape: 'circle', diameter: 40, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } });
		assert.equal(result.created[0].sourceReadback.sourceVerification.maskModify.sourceRecordCount, 1);
		assert.equal(f.state.padModifyCalls.length, 1);
		assert.deepEqual(result.created[0].solderMaskAndPasteMaskExpansion.applied, { topSolderMask: 3, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 });
	});

	await test('partial-mask snapshot uses current defaults for every invocation and applies to PTH holes too', async () => {
		const defaultsA = { topSolderMask: 2, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 };
		const a = install({ effectiveMask: defaultsA });
		const first = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { bottomPasteMask: 4 } });
		assert.deepEqual(first.created[0].solderMaskAndPasteMaskExpansion.defaultsReadback, defaultsA);
		assert.deepEqual(a.state.padModifyCalls[0].patch.solderMaskAndPasteMaskExpansion, { topSolderMask: 2, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 4 });

		const defaultsB = { topSolderMask: 6, bottomSolderMask: 7, topPasteMask: 3, bottomPasteMask: 4 };
		const b = install({ effectiveMask: defaultsB });
		const second = await command('pcb.placeHole').handler({ __docUuid: 'pcb-A', x: 100, y: 120, holeDiameter: 20, padDiameter: 40, plated: true, net: '+5V', solderMaskAndPasteMaskExpansion: { topSolderMask: 8 } });
		assert.equal(second.created[0].holeKind, 'pth-pad-hole');
		assert.deepEqual(second.created[0].solderMaskAndPasteMaskExpansion.defaultsReadback, defaultsB);
		assert.deepEqual(b.state.padModifyCalls[0].patch.solderMaskAndPasteMaskExpansion, { topSolderMask: 8, bottomSolderMask: 7, topPasteMask: 3, bottomPasteMask: 4 });
	});

	await test('partial snapshot stops before modify when defaults are incomplete or the created baseline drifts', async () => {
		const incomplete = install({ effectiveMask: { topSolderMask: 2, bottomSolderMask: undefined, topPasteMask: 0, bottomPasteMask: 0 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			assert.equal(error.cause.created[0].status, 'created-unverified');
			return true;
		});
		assert.equal(incomplete.state.padModifyCalls.length, 0);

		const drift = install({ mutateSourceBeforeMaskModify: true });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(drift.state.padModifyCalls.length, 0);

		for (const options of [{ freshDefaultsOverride: { bottomSolderMask: 9 } }, { changeRulesOnFreshPadRead: true }]) {
			const changed = install(options);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
				assert.equal(error.cause.partial, true);
				assert.equal(error.cause.retryable, false);
				return true;
			});
			assert.equal(changed.state.padModifyCalls.length, 0);
		}
	});

	await test('partial-mask modify failure, late completion, and incorrect post-readback remain single non-cleaned failures', async () => {
		const failed = install({ failPadModify: true });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			assert.equal(error.cause.created[0].status, 'created-unverified');
			assert.deepEqual(error.cause.created[0].defaultsReadback, { topSolderMask: 2, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 });
			assert.deepEqual(error.cause.created[0].applied, { topSolderMask: 3, bottomSolderMask: 2, topPasteMask: 0, bottomPasteMask: 0 });
			return true;
		});
		assert.equal(failed.state.padModifyCalls.length, 1);

		const delayed = install({ delayedPadModify: true });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', _timeoutMs: 1000, x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			assert.equal(error.cause.created[0].status, 'created-unverified');
			return true;
		});
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(delayed.state.padModifyCalls.length, 1);

		for (const options of [{ modifyReadbackMaskOverride: { topSolderMask: 9 } }, { modifySourceMaskOverride: { topSolderExpansion: 9 } }]) {
			const mismatch = install(options);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
				assert.equal(error.cause.partial, true);
				assert.equal(error.cause.retryable, false);
				return true;
			});
			assert.equal(mismatch.state.padModifyCalls.length, 1);
		}

		for (const options of [{ staleModifiedPadTicket: true }, { mutateNonTargetAfterTarget: true }]) {
			const mismatch = install(options);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), (error) => {
				assert.equal(error.cause.partial, true);
				assert.equal(error.cause.retryable, false);
				return true;
			});
			assert.equal(mismatch.state.padModifyCalls.length, 1);
		}
	});

	await test('empty and complete mask objects retain one-stage creation without modify', async () => {
		for (const mask of [{}, { topSolderMask: 1, bottomSolderMask: 2, topPasteMask: 3, bottomPasteMask: 4 }]) {
			const f = install();
			const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: mask });
			assert.equal(f.state.writes.length, 1);
			assert.equal(f.state.padModifyCalls.length, 0);
			assert.deepEqual(f.state.writes[0].args[14], Object.keys(mask).length ? mask : null);
			assert.equal(result.created[0].solderMaskSource, Object.keys(mask).length ? 'explicit-expansion' : 'host-rule');
		}
	});

	await test('rejects explicit source mask mismatch and invalid omitted getter fields', async () => {
		const sourceMismatch = install({ sourceMaskOverride: { topSolderExpansion: 9 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), /源码几何\/孔\/层\/网络\/阻焊读回与请求不符/);
		assert.equal(sourceMismatch.state.writes.length, 1);

		for (const invalidValue of [undefined, 'NaN', Number.POSITIVE_INFINITY]) {
			const f = install({ effectiveMask: { topSolderMask: 2, bottomSolderMask: invalidValue, topPasteMask: null, bottomPasteMask: 0 } });
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, solderMaskAndPasteMaskExpansion: { topSolderMask: 3 } }), /独立 SDK 读回属性与请求不符/);
			assert.equal(f.state.writes.length, 1);
		}
	});

	await test('reports exact source verification for reticketed records and the narrowly allowed empty-net records', async () => {
		install();
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 });
		assert.equal(result.created[0].sourceReadback.sourceVerification.reticketedExistingRecordCount, 1);
		assert.deepEqual(result.created[0].sourceReadback.sourceVerification.allowedAuxiliaryRecords, [
			{ type: 'NET', id: '["NET",""]' },
			{ type: 'RULE_SELECTOR', id: '["RULE_SELECTOR",["NET",""]]' },
		]);
	});

	await test('allows only exact default NET and RULE_SELECTOR records for the newly requested net', async () => {
		const f = install({ namedNetAuxiliary: true });
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, net: 'NEW_NET' });
		assert.equal(result.created[0].net, 'NEW_NET');
		assert.deepEqual(result.created[0].sourceReadback.sourceVerification.allowedAuxiliaryRecords, [
			{ type: 'NET', id: '["NET","NEW_NET"]' },
			{ type: 'RULE_SELECTOR', id: '["RULE_SELECTOR",["NET","NEW_NET"]]' },
		]);
		assert.equal(f.state.writes.length, 1);
	});

	await test('rejects a named-net auxiliary with wrong data, wrong identity, extra records, or mutation of an existing NET', async () => {
		const cases = [
			{ options: { namedNetAuxiliary: true, badNamedNetAuxiliary: true }, params: { net: 'NEW_NET' } },
			{ options: { namedNetAuxiliary: true, mismatchedNamedNetAuxiliary: true }, params: { net: 'NEW_NET' } },
			{ options: { namedNetAuxiliary: true, extraNamedNetAuxiliary: true }, params: { net: 'NEW_NET' } },
			{ options: { initialNamedNetAuxiliary: 'EXISTING_NET', mutateExistingNamedNet: true }, params: { net: 'EXISTING_NET' } },
			{ options: { initialNamedNetAuxiliary: 'NEW_NET', namedNetAuxiliary: true }, params: { net: 'NEW_NET' } },
		];
		for (const item of cases) {
			const f = install(item.options);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24, ...item.params }), /源码包含未批准的新增记录/);
			assert.equal(f.state.writes.length, 1, 'unexpected default auxiliary remains a single uncleaned partial write');
		}
	});

	await test('allows only DOCHEAD client/updateTime/version volatility and preserves identity and unknown fields', async () => {
		const allowed = install({ docHeadVolatileMutation: true });
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 });
		assert.equal(result.operation, 'placePad');
		assert.equal(allowed.state.writes.length, 1);

		for (const mutation of [{ docHeadUnknownMutation: true }]) {
			const f = install(mutation);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 }), /DOCHEAD 的身份或非挥发字段/);
			assert.equal(f.state.writes.length, 1);
		}
	});

	await test('does not treat re-appended empty NET or RULE_SELECTOR identities as first-time auxiliaries', async () => {
		const f = install({ initialEmptyNetAuxiliary: true, duplicateEmptyNetAuxiliary: true });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 }), /源码包含未批准的新增记录/);
		assert.equal(f.state.writes.length, 1);
	});

	await test('creates PTH and copper-ring NPTH with explicit pad and hole diameters', async () => {
		for (const plated of [true, false]) {
			const f = install();
			const result = await command('pcb.placeHole').handler({ __docUuid: 'pcb-A', x: 200, y: 300, holeDiameter: 30, padDiameter: 52, plated });
			const item = result.created[0];
			assert.equal(item.primitiveType, 'Pad');
			assert.equal(item.holeKind, plated ? 'pth-pad-hole' : 'npth-pad-hole');
			assert.equal(item.plated, plated);
			assert.deepEqual(f.state.writes[0].args.slice(0, 4), [12, '', 200, 300]);
			assert.deepEqual(f.state.writes[0].args[7], ['ROUND', 30]);
			assert.equal(f.state.writes[0].args[11], plated);
			assert.deepEqual(f.state.writes[0].args[14], null);
		}
	});

	await test('rejects non-concentric hole offsets from either SDK getter or source record', async () => {
		for (const options of [{ holeOffsetReadbackOverride: { x: 1, y: 0 } }, { holeOffsetSourceOverride: { x: 1, y: 0 } }]) {
			const f = install(options);
			await assert.rejects(() => command('pcb.placeHole').handler({ __docUuid: 'pcb-A', x: 20, y: 30, holeDiameter: 12, padDiameter: 20, plated: true }));
			assert.equal(f.state.writes.length, 1);
		}
	});

	await test('creates circular and rectangular SMD pads on explicit top/bottom layers', async () => {
		const top = install();
		const circle = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 40, y: 60, layer: 'top', shape: 'circle', diameter: 70 });
		assert.equal(circle.created[0].layer, 'top');
		assert.deepEqual(top.state.writes[0].args.slice(0, 6), [1, '', 40, 60, 0, ['ELLIPSE', 70, 70]]);
		const bottom = install();
		const rect = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 140, y: 160, layer: 'bottom', shape: 'rectangle', width: 80, height: 40, cornerRadius: 5, net: 'GND', solderMaskAndPasteMaskExpansion: { topSolderMask: 2, bottomSolderMask: 3 } });
		assert.equal(rect.created[0].layer, 'bottom');
		assert.deepEqual(bottom.state.writes[0].args.slice(0, 7), [2, '', 140, 160, 0, ['RECT', 80, 40, 25], 'GND']);
		assert.equal(bottom.state.writes[0].args[14], null);
		assert.equal(bottom.state.padModifyCalls.length, 1);
		assert.deepEqual(bottom.state.padModifyCalls[0].patch.solderMaskAndPasteMaskExpansion, { topSolderMask: 2, bottomSolderMask: 3, topPasteMask: 0, bottomPasteMask: 0 });
		assert.equal(rect.created[0].solderMaskSource, 'explicit-with-default-snapshot');
		assert.equal(rect.created[0].requestedCornerRadiusMil, 5);
		assert.equal(rect.created[0].sdkRadiusValue, 25);
		assert.equal(rect.created[0].sdkRadiusRepresentation, 'percent-of-half-minimum-side');
	});

	await test('maps requested rectangular corner radius in mil to SDK percent for swapped dimensions, zero and maximum', async () => {
		for (const [width, height, radius, sdkRadius] of [[60, 40, 5, 25], [40, 60, 5, 25], [60, 40, 0, 0], [60, 40, 20, 100]]) {
			const f = install();
			const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 40, y: 60, layer: 'top', shape: 'rectangle', width, height, cornerRadius: radius });
			assert.equal(f.state.writes[0].args[5][3], sdkRadius);
			assert.equal(result.created[0].requestedCornerRadiusMil, radius);
			assert.equal(result.created[0].sdkRadiusValue, sdkRadius);
		}
	});

	await test('rejects unconverted getter radius 5 and source/getter radius disagreement', async () => {
		const wrongGetter = install({ getterGeometryOverride: { pad: ['RECT', 60, 40, 5] } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 40, y: 60, layer: 'top', shape: 'rectangle', width: 60, height: 40, cornerRadius: 5 }), /独立 SDK 读回属性与请求不符/);
		assert.equal(wrongGetter.state.writes[0].args[5][3], 25);

		const wrongSource = install({ sourcePadRadiusOverride: 5 });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 40, y: 60, layer: 'top', shape: 'rectangle', width: 60, height: 40, cornerRadius: 5 }), /源码几何\/孔\/层\/网络\/阻焊读回与请求不符/);
		assert.equal(wrongSource.state.writes[0].args[5][3], 25);
	});

	await test('accepts only the deterministic getter tenth-mil quantization when source keeps exact requested geometry', async () => {
		const f = install();
		const result = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 650.05, y: 30.05, layer: 'top', shape: 'circle', diameter: 30.05 });
		const item = result.created[0];
		assert.deepEqual(item.geometryReadback.requested, { x: 650.05, y: 30.05, shape: ['ELLIPSE', 30.05, 30.05] });
		assert.deepEqual(item.geometryReadback.actualGetter, { x: 650.1, y: 30.1, shape: ['ELLIPSE', 30.1, 30.1] });
		assert.deepEqual(item.geometryReadback.source, { x: 650.05, y: 30.05, shape: { padType: 'ELLIPSE', width: 30.05, height: 30.05 } });
		assert.deepEqual(item.geometryReadback.quantizedFields, ['x', 'y', 'shape.width', 'shape.height']);
		assert.equal(f.state.writes.length, 1);
	});

	await test('rejects non-deterministic getter values, rounded source geometry, missing source geometry, and stale non-target source', async () => {
		const invalidCases = [
			{ getterGeometryOverride: { x: 650.08 } },
			{ getterGeometryOverride: { x: 650.2 } },
			{ getterGeometryOverride: { pad: ['ELLIPSE', 30.08, 30.08] } },
			{ sourceGeometryOverride: { centerX: 650.1 } },
			{ sourceGeometryOverride: { centerX: undefined } },
			{ mutateOldData: true },
			{ readbackRotationOverride: 0.1 },
		];
		for (const options of invalidCases) {
			const f = install(options);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 650.05, y: 30.05, layer: 'top', shape: 'circle', diameter: 30.05 }));
			assert.equal(f.state.writes.length, 1);
		}

		const oneDecimalRequest = install({ getterGeometryOverride: { x: 650.2 } });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 650.1, y: 30.1, layer: 'top', shape: 'circle', diameter: 30.1 }));
		assert.equal(oneDecimalRequest.state.writes.length, 1);
	});

	await test('stops on fractional PAD source read timeout without claiming verified geometry', async () => {
		const f = install({ delaySourceReadCall: 4 });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', _timeoutMs: 1000, x: 650.05, y: 30.05, layer: 'top', shape: 'circle', diameter: 30.05 }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(f.state.writes.length, 1);
	});

	await test('matches RECT source radius including zero and rejects a different source radius', async () => {
		const zero = install();
		const zeroResult = await command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 40, y: 60, layer: 'top', shape: 'rectangle', width: 30, height: 20, cornerRadius: 0 });
		assert.deepEqual(zeroResult.created[0].sourceReadback.defaultPad, { padType: 'RECT', width: 30, height: 20, radius: 0 });
		assert.equal(zero.state.writes.length, 1);

		const mismatch = install({ sourcePadRadiusOverride: 6 });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 40, y: 60, layer: 'top', shape: 'rectangle', width: 30, height: 20, cornerRadius: 5 }), /源码几何\/孔\/层\/网络\/阻焊读回与请求不符/);
		assert.equal(mismatch.state.writes.length, 1);
	});

	await test('SDK create failure is reported once without retry or cleanup', async () => {
		const f = install({ failCreate: true });
		await assert.rejects(() => command('pcb.placeHole').handler({ __docUuid: 'pcb-A', x: 20, y: 30, holeDiameter: 20, plated: false }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(f.state.writes.length, 1);
	});

	await test('a delayed mutation after timeout is not retried or deleted', async () => {
		const f = install({ delayedCreate: true });
		await assert.rejects(() => command('pcb.placeHole').handler({ __docUuid: 'pcb-A', _timeoutMs: 1000, x: 20, y: 30, holeDiameter: 20, plated: false }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(f.state.writes.length, 1);
		assert.equal(f.state.fills.size, 1);
	});

	await test('wrong SDK readback, source mutation, or incomplete getAll is a single partial failure', async () => {
		for (const options of [{ badReadback: true }, { mutateNonTarget: true }, { mutateOldData: true }, { getAllMissingId: true }, { badEmptyNetAuxiliary: true }]) {
			const f = install(options);
			await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'top', shape: 'circle', diameter: 24 }), (error) => {
				assert.equal(error.cause.partial, true);
				assert.equal(error.cause.retryable, false);
				return true;
			});
			assert.equal(f.state.writes.length, 1);
		}
	});

	await test('rejects non-circular, multi-path, or unsupported-width mechanical cutout source', async () => {
		const basePath = [['CIRCLE', 200, 300, 10]];
		const invalid = [
			{ fillSourcePathMutation: [...basePath, ['CIRCLE', 230, 300, 2]] },
			{ fillSourcePathMutation: [['CIRCLE', 200, 300, 11]] },
			{ fillSourceWidth: 2, fillReadbackWidth: 2 },
		];
		for (const options of invalid) {
			const f = install(options);
			await assert.rejects(() => command('pcb.placeHole').handler({ __docUuid: 'pcb-A', x: 200, y: 300, holeDiameter: 20, plated: false }));
			assert.equal(f.state.writes.length, 1);
		}
	});

	await test('focus switch after create stops further work and does not retry', async () => {
		const f = install({ switchFocus: true });
		await assert.rejects(() => command('pcb.placePad').handler({ __docUuid: 'pcb-A', x: 20, y: 30, layer: 'bottom', shape: 'rectangle', width: 32, height: 16 }), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(f.state.writes.length, 1);
	});

	console.log(`\n${passed} B3 pad/hole regression tests passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
