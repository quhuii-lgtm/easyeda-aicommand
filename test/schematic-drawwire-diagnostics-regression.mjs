import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { buildSync } from 'esbuild';
import { installVirtualClock } from './virtual-clock.mjs';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = buildSync({
		stdin: {
			contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand } from '../src/engine/registry.ts'; import { setDiagSink } from '../src/engine/diag.ts'; export { schematicCommands, registerCommand, setDiagSink }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'schematic-drawwire-diagnostics-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { schematicCommands, registerCommand, setDiagSink } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	for (const command of schematicCommands) registerCommand(command);
	const drawWireHandler = schematicCommands.find(item => item.name === 'schematic.drawWire').handler;
	const clock = installVirtualClock();
	const diagnosticEvents = [];
	setDiagSink(event => diagnosticEvents.push(event));

	function makeHarness({ create, hangSourceAfterCreate = false, corruptExistingRelevance = false, onProgress } = {}) {
		const wires = new Map();
		const attributes = new Map();
		let creates = 0;
		let sourceReads = 0;
		let modelReads = 0;
		if (corruptExistingRelevance) {
			wires.set('existing-wire', { id: 'existing-wire', line: [0, 0, 10, 0], color: '#000000', lineWidth: 6, lineType: 0, net: '' });
			attributes.set('existing-attr', { id: 'existing-attr', key: 'Relevance', value: '[]', parentId: 'existing-wire', zIndex: 0 });
		}
		const wire = item => ({
			getState_PrimitiveId: () => item.id,
			getState_Line: () => item.line,
			getState_Color: () => item.color,
			getState_LineWidth: () => item.lineWidth,
			getState_LineType: () => item.lineType,
			getState_Net: () => item.net ?? '',
		});
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'diagnostic-page' }) },
			sys_FileManager: {
				getDocumentSource: async () => {
					sourceReads++;
					if (hangSourceAfterCreate && creates > 0)
						return new Promise(() => {});
					const rows = ['{"type":"DOCHEAD","ticket":1}||{"docType":"SCH_PAGE","uuid":"diagnostic-page","client":"test","version":1}'];
					let ticket = 2;
					for (const item of wires.values()) {
						rows.push(`${JSON.stringify({ type: 'WIRE', id: item.id, ticket: ticket++ })}||${JSON.stringify({ zIndex: 0 })}`);
						for (let i = 0; i + 3 < item.line.length; i += 2)
							rows.push(`${JSON.stringify({ type: 'LINE', id: `line-${item.id}-${i}`, ticket: ticket++ })}||${JSON.stringify({ lineGroup: item.id, startX: item.line[i], startY: -item.line[i + 1], endX: item.line[i + 2], endY: -item.line[i + 3], strokeColor: item.color, strokeWidth: item.lineWidth, strokeStyle: 'SOLID' })}`);
					}
					for (const attribute of attributes.values())
						rows.push(`${JSON.stringify({ type: 'ATTR', id: attribute.id, ticket: ticket++ })}||${JSON.stringify(attribute)}`);
					return rows.join('\n');
				},
			},
			sch_PrimitiveAttribute: { getAll: async () => [] },
			sch_PrimitiveWire: {
				getAll: async () => {
					modelReads++;
					return [...wires.values()].map(wire);
				},
				create: async (line) => {
					creates++;
					if (corruptExistingRelevance && creates === 1)
						attributes.get('existing-attr').value = '["corrupted"]';
					if (create)
						return create({ line, wires, wire, creates });
					const item = { id: `wire-${creates}`, line, color: '#000000', lineWidth: 6, lineType: 0, net: '' };
					wires.set(item.id, item);
					return wire(item);
				},
			},
		};
		return {
			wires,
			get creates() { return creates; },
			get sourceReads() { return sourceReads; },
			get modelReads() { return modelReads; },
			context: { onProgress },
		};
	}

	async function failed(promise) {
		try {
			await promise;
		}
		catch (error) { return error; }
		assert.fail('expected drawWire to fail');
	}

	try {
		{
			const harness = makeHarness();
			const error = await failed(drawWireHandler({ _timeoutMs: 1000, points: [[0, 0]] }, harness.context));
			assert.equal(error.cause?.partial, undefined, 'write-free preflight failures are not mislabeled partial');
			assert.equal(error.cause?.drawWireDiagnostic?.createAttempted, false);
			assert.equal(harness.creates, 0);
		}

		{
			const harness = makeHarness({ create: ({ line, wires, wire }) => {
				const item = { id: 'wire-accessor-id', line, color: '#000000', lineWidth: 6, lineType: 0, net: '' };
				wires.set(item.id, item);
				const returned = wire(item);
				Object.defineProperty(returned, 'id', { get() {
					throw new Error('SDK id accessor must not be read');
				} });
				return returned;
			} });
			const result = await drawWireHandler({ _timeoutMs: 1000, points: [[0, 0], [10, 0]] }, harness.context);
			assert.equal(result.drawWireDiagnostic.createReturned, true);
			assert.equal(result.drawWireDiagnostic.stage, 'complete');
			assert.equal(result.drawWireDiagnostic.returnedId, undefined);
		}

		{
			const progress = [];
			diagnosticEvents.length = 0;
			const harness = makeHarness({ create: () => new Promise(() => {}), onProgress: detail => progress.push(detail.drawWireDiagnostic) });
			const error = await failed(drawWireHandler({ _timeoutMs: 1000, points: [[0, 0], [10, 0]] }, harness.context));
			const diagnostic = error.cause?.drawWireDiagnostic;
			assert.equal(error.cause?.partial, true);
			assert.equal(diagnostic?.stage, 'create:pending');
			assert.equal(diagnostic?.createAttempted, true);
			assert.equal(diagnostic?.createReturned, false);
			assert.equal(diagnostic?.documentUuid, 'diagnostic-page');
			assert.equal(diagnostic?.segmentIndex, 1);
			assert.equal(diagnostic?.segmentWasNamed, false);
			assert.equal(progress.find(item => item.stage === 'create:pending')?.createAttempted, true, 'pending progress records the attempt before reporting');
			const armed = diagnosticEvents.find(item => item.stage === 'timeout-armed' && JSON.parse(item.detail).label === '第 1 段 create');
			assert.ok(armed, 'the create wait emits a timeout-armed diagnostic');
			const armedDetail = JSON.parse(armed.detail);
			assert.equal(armedDetail.segmentIndex, 1);
			assert.ok(Number.isFinite(armedDetail.remainingMs));
			assert.ok(Number.isFinite(armedDetail.dateNow) && Number.isFinite(armedDetail.performanceNow));
			assert.ok(diagnosticEvents.some(item => item.stage === 'wait-settled' && JSON.parse(item.detail).label === '读取初始焦点'), 'completed waits emit one settled event');
			assert.ok(diagnosticEvents.some(item => item.stage === 'timeout-fired' && JSON.parse(item.detail).callId === armedDetail.callId));
			assert.ok(diagnosticEvents.some(item => item.stage === 'partial-assembly'), 'timeout during create is logged before partial result assembly');
			assert.ok(diagnosticEvents.some(item => item.stage === 'timeout-catch'), 'timeout reaching the command catch is logged');
			assert.ok(diagnostic.elapsedMs >= 800 && diagnostic.elapsedMs < 1000, `elapsedMs=${diagnostic?.elapsedMs}`);
		}

		{
			const harness = makeHarness({ hangSourceAfterCreate: true });
			const error = await failed(drawWireHandler({ _timeoutMs: 1000, points: [[0, 0], [10, 0]] }, harness.context));
			const diagnostic = error.cause?.drawWireDiagnostic;
			assert.equal(error.cause?.partial, true);
			assert.equal(diagnostic?.createAttempted, true);
			assert.equal(diagnostic?.createReturned, true);
			assert.equal(diagnostic?.lastReadLabel, '读取原理图源码');
			assert.equal(diagnostic?.sampleAttempts, 1);
			assert.ok(diagnostic?.lastCompletedSampleAt, 'pre-write source/model pair is retained as the last completed sample');
		}

		{
			const progress = [];
			diagnosticEvents.length = 0;
			const harness = makeHarness({ corruptExistingRelevance: true, onProgress: detail => progress.push(detail.drawWireDiagnostic) });
			const error = await failed(drawWireHandler({ _timeoutMs: 1000, points: [[0, 0], [10, 0], [10, 10]] }, harness.context));
			const diagnostic = error.cause?.drawWireDiagnostic;
			assert.equal(error.cause?.partial, true);
			assert.match(diagnostic?.lastValidationError?.message ?? '', /自动网络标签重建字段无效/);
			assert.equal(diagnostic?.lastValidationError?.validation?.ok, false);
			assert.equal(diagnostic?.lastValidationError?.validation?.state, 'partial');
			assert.equal(diagnostic?.lastValidationError?.validation?.reason, diagnostic?.lastValidationError?.message);
			assert.ok(progress.some(item => item.lastValidationError?.message === diagnostic.lastValidationError.message), 'the first distinct validation failure is reported');
			assert.equal(diagnostic?.createReturned, true);
			assert.ok(diagnostic?.sampleAttempts > 5, `expected repeated samples, got ${diagnostic?.sampleAttempts}`);
			assert.ok(progress.length <= 20, `progress should remain bounded across repeated stable rejection, got ${progress.length} events`);
			assert.ok(diagnosticEvents.filter(item => item.stage === 'timeout-armed').length <= 20, 'timeout arming is deduplicated by segment and label instead of logging every 40 ms sample');
		}

		{
			diagnosticEvents.length = 0;
			let resolveCreate;
			const harness = makeHarness({ create: ({ line, wires, wire }) => new Promise((resolve) => {
				resolveCreate = () => {
					const item = { id: 'late-wire', line, color: '#000000', lineWidth: 6, lineType: 0, net: '' };
					wires.set(item.id, item);
					resolve(wire(item));
				};
			}) });
			const error = await failed(drawWireHandler({ _timeoutMs: 1000, points: [[0, 0], [10, 0], [10, 10]] }, harness.context));
			assert.equal(error.cause?.drawWireDiagnostic?.createReturned, false);
			const readsAtFailure = { source: harness.sourceReads, model: harness.modelReads };
			resolveCreate();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(harness.creates, 1, 'the late create cannot enable a following segment write');
			assert.deepEqual({ source: harness.sourceReads, model: harness.modelReads }, readsAtFailure, 'the late result cannot start readback or turn the failure into success');
			assert.equal(error.cause?.drawWireDiagnostic?.createReturned, false, 'the returned diagnostic copy is immutable after timeout');
			assert.ok(diagnosticEvents.some(item => item.stage === 'wait-settled' && JSON.parse(item.detail).lateAfterTimeout === true), 'a late timed-out create settlement is logged');
		}
	}
	finally {
		clock.restore();
	}

	console.log('schematic-drawwire-diagnostics-regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
