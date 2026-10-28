import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import process from 'node:process';

async function main() {
	const mocks = String.raw`
const state = () => globalThis.__tuneMock
function active(state, type) {
  const rows = new Map()
  for (const text of state.source.split(/\r?\n/)) {
    const sep = text.indexOf('||')
    if (sep < 0) continue
    const header = JSON.parse(text.slice(0, sep))
    if (header.type !== type) continue
    const data = JSON.parse(text.slice(sep + 2).replace(/\|$/, ''))
    if (data === '') rows.delete(header.id)
    else rows.set(header.id, data)
  }
  return [...rows].map(([id, data]) => ({ id, data }))
}
export async function createGeometryHost(sdk) {
  return {
    documentUuid: state().uuid, sdk,
    read: async (_label, fn) => await fn(), write: async (_label, fn) => await fn(),
    checkBudget() {}, recordCreated() {}, recordVerified() {},
    async getBaseline() { return { source: state().source, rules: { min: 1 } } },
    async assertBaseline() {}, async finish() {},
    fail(error, extra) { error.cause = { ...(error.cause ?? {}), ...extra }; throw error },
  }
}
export async function readTuneContacts() {
  return state().mode === 'left-contact' ? [{ id: 'left-only-copper', net: 'N', layers: [1], kind: 'circle', center: [100, 12], radius: 3 }] : []
}
export async function writeTuneCurves(_host, request) {
  const createdPrimitives = []
  const actualPrimitives = []
  const quantize = value => Math.round(value * 10000) / 10000
  const quantizedCurve = primitive => {
    const a = primitive.a.map(quantize)
    const b = primitive.b.map(quantize)
    if (primitive.type === 'line') return { ...primitive, a, b }
    const theta = primitive.sweepDegrees * Math.PI / 180
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const chord = Math.hypot(dx, dy)
    const offset = chord / (2 * Math.tan(theta / 2))
    const center = [(a[0] + b[0]) / 2 - dy / chord * offset, (a[1] + b[1]) / 2 + dx / chord * offset]
    return { ...primitive, a, b, center, radius: Math.hypot(a[0] - center[0], a[1] - center[1]) }
  }
  for (let i = 0; i < request.primitives.length; i++) {
    const primitive = request.primitives[i]
    const type = primitive.type
    const storedCurve = state().mode === 'quantized' ? quantizedCurve(primitive) : primitive
    const id = 'new-' + type + '-' + (i + 1)
    const data = { netName: request.net, layerId: request.layer, width: request.width, startX: storedCurve.a[0], startY: storedCurve.a[1], endX: storedCurve.b[0], endY: storedCurve.b[1], locked: false }
    if (type === 'arc') { data.arcType = 'DOT'; data.angle = primitive.sweepDegrees }
    if (state().mode === 'arc-reverse-source' && type === 'arc') {
      const reverseStart = primitive.b
      const reverseEnd = primitive.a
      data.startX = reverseStart[0]
      data.startY = reverseStart[1]
      data.endX = reverseEnd[0]
      data.endY = reverseEnd[1]
      data.angle *= -1
    }
    if (state().mode === 'source-invalid' && type === 'arc') data.angle = null
    if (state().mode === 'arc-sign-error' && type === 'arc') data.angle *= -1
    state().source += '\n' + state().row(type.toUpperCase(), id, state().nextTicket(), data)
    const created = { type, id }
    createdPrimitives.push(created)
    actualPrimitives.push(storedCurve)
    if (state().mode === 'arc-partial') {
      const error = new Error('curve writer partial')
      error.cause = { partial: true, createdPrimitives: [...createdPrimitives], actualPrimitives: [...actualPrimitives], candidatePrimitive: { type, id } }
      throw error
    }
  }
  if (state().mode === 'non-target-change') state().source += '\n' + state().row('NET', 'net-1', state().nextTicket(), { name: 'N', retained: false })
  if (state().mode.startsWith('native-split')) {
    const original = active(state(), 'LINE').find(line => line.id === 'target')
    const a = [original.data.startX, original.data.startY]
    const b = [original.data.endX, original.data.endY]
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy
    const cuts = []
    for (const primitive of request.primitives) for (const point of [primitive.a, primitive.b]) {
      const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2
      const projected = [a[0] + t * dx, a[1] + t * dy]
      if (t > 0.001 && t < 0.999 && Math.hypot(point[0] - projected[0], point[1] - projected[1]) <= 0.001 && !cuts.some(item => Math.hypot(item[0] - point[0], item[1] - point[1]) <= 0.001)) cuts.push(point)
    }
    cuts.sort((left, right) => ((left[0] - a[0]) * dx + (left[1] - a[1]) * dy) - ((right[0] - a[0]) * dx + (right[1] - a[1]) * dy))
    if (!cuts.length) cuts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
    state().source += '\n' + state().row('LINE', 'target', state().nextTicket(), '')
    const points = [a, ...cuts, b]
    points.slice(1).forEach((point, index) => {
      const start = points[index], end = point
      const id = 'native-fragment-' + (index + 1)
      const data = { ...original.data, startX: start[0], startY: start[1], endX: end[0], endY: end[1] }
      if (state().mode === 'native-split-unknown-attr' && index === 0) data.zIndex = 7
      if (state().mode === 'native-split-wrong-cut' && index === 0) data.endX += 0.1
      state().source += '\n' + state().row('LINE', id, state().nextTicket(), data)
    })
    if (state().mode === 'native-split-missing') state().source += '\n' + state().row('LINE', 'native-fragment-2', state().nextTicket(), '')
    if (state().mode === 'native-split-extra') state().source += '\n' + state().row('LINE', 'mystery-fragment', state().nextTicket(), { ...original.data, startX: a[0], startY: a[1], endX: b[0], endY: b[1] })
    if (state().mode === 'native-split-other-change') state().source += '\n' + state().row('NET', 'net-1', state().nextTicket(), { name: 'N', retained: false })
  }
  return { createdPrimitives, actualPrimitives }
}
`;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const mockName = specifier.split('/').at(-1);
			if (['geometryHost', 'lengthTuneContacts', 'curveTuneWriter'].includes(mockName))
				return { url: `mock:${mockName}`, shortCircuit: true };
			if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier))
				return nextResolve(`${specifier}.ts`, context);
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url.startsWith('mock:'))
				return { format: 'module', source: mocks, shortCircuit: true };
			return nextLoad(url, context);
		},
	});
	const { lengthTuneCommands } = await import('../src/commands/tuneLength.ts');
	const { identifyOldBypassFragments } = await import('../src/pcb/oldBypassFragments.ts');
	const command = lengthTuneCommands.find(item => item.name === 'pcb.tuneLength');
	const inspectCommand = lengthTuneCommands.find(item => item.name === 'pcb.inspectCurveReadback');
	assert.ok(command?.handler);
	assert.ok(inspectCommand?.handler);
	assert.deepEqual(command.params.filter(param => param.required).map(param => param.name), ['net', 'targetLength', 'region', 'minSelfGap', 'lengthTolerance', 'bendRadius']);
	{
		const target = { header: { type: 'LINE', id: 'old' }, data: { partitionId: '', groupId: 0, netName: 'N', layerId: 1, startX: 0, startY: 0, endX: 200, endY: 0, width: 6, locked: false, zIndex: -1 } };
		const fragment = (id, startX, endX) => ({ header: { type: 'LINE', id }, data: { ...target.data, startX, endX } });
		const beforeRecords = new Map([['LINE\0old', target]]);
		const afterRecords = new Map([['LINE\0f1', fragment('f1', 0, 100)], ['LINE\0f2', fragment('f2', 100, 200)], ['ARC\0writer', { header: { type: 'ARC', id: 'writer' }, data: {} }]]);
		const recognized = identifyOldBypassFragments({ targetId: 'old', target, beforeRecords, afterRecords, writerKeys: new Set(['ARC\0writer']), planned: [{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'line', a: [100, 0], b: [200, 0] }] });
		assert.deepEqual(recognized.fragmentIds, ['f1', 'f2'], 'two exact fragments fully cover the original target at a planned join');
		for (const broken of [
			new Map([['LINE\0f1', fragment('f1', 0, 100)], ['ARC\0writer', { header: { type: 'ARC', id: 'writer' }, data: {} }]]),
			new Map([...afterRecords, ['LINE\0extra', fragment('extra', 0, 200)]]),
			new Map([['LINE\0f1', fragment('f1', 0, 99)], ['LINE\0f2', fragment('f2', 100, 200)], ['ARC\0writer', { header: { type: 'ARC', id: 'writer' }, data: {} }]]),
			new Map([['LINE\0f1', { ...fragment('f1', 0, 100), data: { ...fragment('f1', 0, 100).data, mystery: true } }], ['LINE\0f2', fragment('f2', 100, 200)], ['ARC\0writer', { header: { type: 'ARC', id: 'writer' }, data: {} }]]),
		]) {
			assert.throws(() => identifyOldBypassFragments({ targetId: 'old', target, beforeRecords, afterRecords: broken, writerKeys: new Set(['ARC\0writer']), planned: [{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'line', a: [100, 0], b: [200, 0] }] }));
		}
	}

	const uuid = 'tune-board';
	const row = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
	function active(state, type) {
		const rows = new Map();
		for (const text of state.source.split(/\r?\n/)) {
			const sep = text.indexOf('||');
			if (sep < 0)
				continue;
			const header = JSON.parse(text.slice(0, sep));
			if (header.type !== type)
				continue;
			const data = JSON.parse(text.slice(sep + 2).replace(/\|$/, ''));
			if (data === '')
				rows.delete(header.id);
			else
				rows.set(header.id, data);
		}
		return [...rows].map(([id, data]) => ({ id, data }));
	}
	function sdkObject(type, id, data) {
		const stateForSdk = globalThis.__tuneMock;
		const project = value => stateForSdk.mode === 'final-quantized' && type === 'ARC' ? Math.round(value * 10) / 10 : value;
		const values = {
			PrimitiveId: id,
			PrimitiveType: type === 'ARC' ? 'Arc' : 'Line',
			Net: data.netName,
			Layer: data.layerId,
			LineWidth: data.width,
			StartX: project(data.startX),
			StartY: project(data.startY),
			EndX: project(data.endX),
			EndY: project(data.endY),
			ArcAngle: data.angle,
			PrimitiveLock: false,
		};
		return Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]));
	}
	function setup(mode = 'success') {
		const state = { uuid, mode, source: '', deleted: [], row, nextTicket() {
			return Math.max(1, ...this.source.split(/\r?\n/).map((line) => {
				try {
					return JSON.parse(line.slice(0, line.indexOf('||'))).ticket ?? 0;
				}
				catch { return 0; }
			})) + 1;
		} };
		state.source = [row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid, client: 'mock' }), row('NET', 'net-1', 1, { name: 'N', retained: true }), row('LINE', 'target', 2, { netName: 'N', layerId: 1, width: 6, startX: 0, startY: 0, endX: 200, endY: 0, locked: false })].join('\n');
		globalThis.__tuneMock = state;
		const all = type => active(state, type).map(({ id, data }) => {
			const object = sdkObject(type, id, data);
			if (mode === 'sdk-nan' && type === 'ARC' && id === 'new-arc-1')
				return { ...object, getState_LineWidth: () => Number.NaN };
			return object;
		});
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: () => ({ documentType: 3, uuid }) },
			sys_FileManager: { getDocumentSource: () => state.source },
			pcb_Drc: { getCurrentRuleConfiguration: () => ({ min: 1 }) },
			pcb_Layer: { getAllLayers: () => [{ id: 1, type: 'SIGNAL', status: 1 }] },
			pcb_PrimitiveLine: {
				get: (id) => {
					const item = active(state, 'LINE').find(line => line.id === id);
					return item ? { ...sdkObject('LINE', id, item.data), getState_PrimitiveLock: () => false } : undefined;
				},
				getAll: () => mode === 'enum-conflict' ? [...all('LINE'), sdkObject('LINE', 'target', { netName: 'N', layerId: 1, width: 6, startX: 0, startY: 0, endX: 200, endY: 0 })] : all('LINE'),
				delete: (ids) => {
					for (const id of Array.isArray(ids) ? ids : [ids]) {
						state.deleted.push(id);
						if (state.mode !== 'delete-noop' && !(state.mode === 'native-split-delete-residual' && id === 'native-fragment-2'))
							state.source += `\n${row('LINE', id, state.nextTicket(), '')}`;
					}
					return true;
				},
			},
			pcb_PrimitiveArc: {
				get: (id) => {
					const item = active(state, 'ARC').find(arc => arc.id === id);
					return item ? sdkObject('ARC', id, item.data) : undefined;
				},
				getAll: () => all('ARC'),
			},
		};
		return state;
	}
	const args = { net: 'N', targetLength: 220, region: { xMin: -10, yMin: -100, xMax: 210, yMax: 100 }, minSelfGap: 0, lengthTolerance: 0.001, bendRadius: 7 };

	{
		const state = setup();
		const result = await command.handler({ ...args, dryRun: true });
		assert.equal(result.dryRun, true);
		assert.equal(result.changed, false);
		assert.equal(result.plan.primitives.filter(curve => curve.type === 'arc').length, 4);
		assert.equal(result.plan.plannedFamilySelfGapLowerBoundMil, 8);
		assert.equal(result.plan.samplePointCount > 0, true);
		assert.equal('samples' in result.plan, false, 'preview returns a compact typed plan rather than sampled point arrays');
		assert.deepEqual(state.deleted, []);
		assert.equal(active(state, 'ARC').length, 0);
	}
	{
		const state = setup('left-contact');
		const result = await command.handler({ ...args, dryRun: true, side: 'auto' });
		assert.equal(result.plan.selectedSide, 'right', 'auto falls through to the opposite side when contacts block left');
		assert.equal(result.attachmentCheck.interiorConnections.length, 0);
		assert.deepEqual(state.deleted, []);
		assert.equal(active(state, 'ARC').length, 0);
	}
	{
		const state = setup();
		const result = await command.handler(args);
		assert.equal(result.changed, true);
		assert.ok(Math.abs(result.actualSelectedLength - 220) <= args.lengthTolerance);
		assert.equal(result.actualPrimitives.filter(curve => curve.type === 'arc').length, 4);
		assert.equal(result.createdPrimitives.filter(item => item.type === 'arc').length, 4);
		assert.equal(result.plannedFamilySelfGapLowerBoundMil, 8);
		assert.ok(Math.abs(result.sourceFamilySelfGapLowerBoundMil - 8) < 1e-8);
		assert.match(result.familySelfGapMeaning, /不是全链或整板实测最小值/);
		assert.equal(result.originalTargetId, 'target');
		assert.deepEqual(result.nativeReplacedOriginalIds, []);
		assert.deepEqual(result.oldBypassFragmentIds, []);
		assert.deepEqual(result.attemptedDeletedIds, ['target']);
		assert.deepEqual(state.deleted, ['target']);
		assert.equal(active(state, 'LINE').some(item => item.id === 'target'), false);
		assert.equal(active(state, 'ARC').length, 4);
	}
	for (const mode of ['native-split-missing', 'native-split-extra', 'native-split-wrong-cut', 'native-split-unknown-attr', 'native-split-other-change']) {
		const state = setup(mode);
		await assert.rejects(command.handler(args), error => error.cause?.partial === true && error.cause?.attemptedDeletedIds?.length === 0);
		assert.deepEqual(state.deleted, [], `${mode} rejects before fragment deletion`);
		assert.equal(active(state, 'LINE').some(item => item.id === 'target'), false, 'native target disappearance is reported without deleting untrusted lines');
	}
	{
		setup('final-quantized');
		const result = await command.handler(args);
		assert.equal(result.changed, true);
		assert.equal(result.finalArcReadback.length, 4);
		assert.ok(result.finalArcReadback.every(item => item.readbackMode === 'final-sdk' && ['sdk-0.1-projection', 'within-0.001'].includes(item.endpointMode) && item.differences.length === 0));
		assert.ok(result.finalArcReadback.some(item => item.endpointMode === 'sdk-0.1-projection'));
		assert.deepEqual(result.actualPrimitives.filter(curve => curve.type === 'arc').map(curve => curve.a), result.finalArcReadback.map(item => item.source.start), 'reported actual ARC geometry comes from source, not projected SDK values');
	}
	{
		const state = setup();
		state.source += `\n${row('ARC', 'arc-inspect', 3, { netName: 'N', layerId: 1, width: 6, startX: 10, startY: 0, endX: 0, endY: 10, angle: 90, arcType: 'DOT' })}`;
		const before = state.source;
		const result = await inspectCommand.handler({ primitiveIds: [{ type: 'line', id: 'target' }, { type: 'arc', id: 'arc-inspect' }] });
		assert.equal(result.readOnly, true);
		assert.equal(result.results.length, 2);
		assert.ok(result.results.every(item => item.readbackMode === 'fresh-getter' && item.differences.length === 0 && item.rawSDK.PrimitiveId));
		assert.equal(result.results[1].source.arcType, 'DOT');
		assert.deepEqual(state.deleted, []);
		assert.equal(state.source, before, 'inspectCurveReadback performs no source write');
		await assert.rejects(inspectCommand.handler({ primitiveIds: [{ type: 'arc', id: 'arc-inspect', code: 'not-allowed' }] }), /只包含 type/);
	}
	{
		const state = setup('quantized');
		const strictArgs = { ...args, lengthTolerance: 1e-6 };
		await assert.rejects(command.handler(strictArgs), (error) => {
			assert.match(error.message, /源码读回总长超出 lengthTolerance/);
			assert.equal(error.cause?.partial, true);
			assert.equal(error.cause?.oldBypassState, true);
			assert.deepEqual(error.cause?.deletedIds, []);
			assert.ok(error.cause?.createdPrimitives?.length > 0, 'typed creation evidence is retained');
			const actualLength = Number(error.message.match(/实际 ([\d.]+) mil/)?.[1]);
			assert.ok(Number.isFinite(actualLength) && Math.abs(actualLength - 220) > strictArgs.lengthTolerance && Math.abs(actualLength - 220) < 0.001, 'quantization error is below the join tolerance but above lengthTolerance');
			return true;
		});
		assert.deepEqual(state.deleted, [], 'quantized source length failure keeps the old LINE and does not retry deletion');
		assert.equal(active(state, 'LINE').some(item => item.id === 'target'), true);
	}
	{
		const state = setup('arc-reverse-source');
		const result = await command.handler(args);
		assert.equal(result.changed, true, 'equivalent reverse endpoint storage with opposite angle retains planned chain orientation');
		assert.deepEqual(state.deleted, ['target']);
	}
	{
		const state = setup('arc-sign-error');
		await assert.rejects(command.handler(args), /几何与规划不符/);
		assert.deepEqual(state.deleted, [], 'an ARC sign mismatch must leave the old target untouched');
	}
	{
		const state = setup('source-invalid');
		await assert.rejects(command.handler(args), /ARC .*源码属性不完整/);
		assert.deepEqual(state.deleted, []);
	}
	{
		const state = setup('arc-partial');
		await assert.rejects(command.handler(args), error => error.cause?.partial === true && error.cause?.createdPrimitives?.[0]?.type === 'arc' && error.cause?.createdIds?.includes('new-arc-1') && error.cause?.oldBypassState === 'unknown');
		assert.deepEqual(state.deleted, [], 'partial typed creation never deletes the old LINE');
	}
	{
		const state = setup('enum-conflict');
		await assert.rejects(command.handler(args), error => /SDK枚举或源码仍包含旧target/.test(error.message) && error.cause.oldBypassState === 'unknown');
		assert.deepEqual(state.deleted, ['target']);
	}
	{
		const state = setup('sdk-nan');
		await assert.rejects(command.handler(args), error => /SDK线宽无效/.test(error.message) && error.cause.oldBypassState === false && error.cause.deletedIds.includes('target'));
		assert.deepEqual(state.deleted, ['target']);
	}
	{
		const state = setup('delete-noop');
		await assert.rejects(command.handler(args), /删除后仍存在/);
		assert.deepEqual(state.deleted, ['target']);
	}
	{
		const state = setup('non-target-change');
		await assert.rejects(command.handler(args), /创建后既有记录 NET/);
		assert.deepEqual(state.deleted, [], 'an unrelated source mutation prevents deletion of the old LINE');
	}
	{
		const state = setup();
		state.source = state.source.replace(/\n\{"type":"LINE".*$/, '');
		state.source += `\n${row('LINE', 'target', 2, { netName: 'N', layerId: 1, width: 6, startX: 0, startY: 0, endX: 200, endY: 0, locked: false })}`;
		state.source += `\n${row('LINE', 'foldback', 3, { netName: 'N', layerId: 1, width: 6, startX: 200, startY: 0, endX: 0, endY: 20, locked: false })}`;
		const total = 200 + Math.hypot(200, 20);
		await assert.rejects(command.handler({ ...args, primitiveIds: ['target', 'foldback'], tunePrimitiveId: 'target', targetLength: total + 20, side: 'left' }), /所有调节候选均不可行/);
		assert.deepEqual(state.deleted, [], 'a selected-chain tail crossing the new U top is checked before any write');
		assert.equal(active(state, 'ARC').length, 0);
	}
	for (const badArgs of [
		{ ...args, bendRadius: Number.NaN },
		{ ...args, targetLength: 199 },
		{ ...args, region: { xMin: 0, yMin: 0, xMax: 10, yMax: 10 } },
	]) {
		const state = setup();
		await assert.rejects(command.handler(badArgs));
		assert.deepEqual(state.deleted, []);
		assert.equal(active(state, 'ARC').length, 0);
	}
	let touched = false;
	globalThis.eda = new Proxy({}, { get() {
		touched = true;
		throw new Error('EDA must not be accessed during argument validation');
	} });
	await assert.rejects(command.handler({ net: 'N', targetLength: 220, region: args.region, minSelfGap: 0, lengthTolerance: 0.001 }), /缺少必需参数 bendRadius/);
	assert.equal(touched, false);

	console.log('length-tune-command-regression: all assertions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
