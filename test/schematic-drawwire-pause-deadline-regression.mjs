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
			contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand, executeCommand } from '../src/engine/registry.ts'; import { setDiagSink } from '../src/engine/diag.ts'; export { schematicCommands, registerCommand, executeCommand, setDiagSink }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'schematic-drawwire-pause-deadline-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { schematicCommands, registerCommand, executeCommand, setDiagSink } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	for (const command of schematicCommands)
		registerCommand(command);

	const diagnosticEvents = [];
	let activePauseControl;
	setDiagSink((event) => {
		if (event.cmd !== 'schematic.drawWire')
			return;
		diagnosticEvents.push(event);
		let detail;
		try {
			detail = JSON.parse(event.detail ?? 'null');
		}
		catch { return; }
		if (activePauseControl && detail?.lastValidationError && !activePauseControl.armed) {
			activePauseControl.armed = true;
			activePauseControl.onValidationFailure?.();
		}
	});

	function makeHarness({ staleModelReadsAfterCreate = 0, corruptExistingRelevance = false } = {}) {
		const wires = new Map();
		const attributes = new Map();
		const createCalls = [];
		let sourceReads = 0;
		let modelReads = 0;
		let postCreateModelReads = 0;
		let attributeReadCalls = 0;
		let labelWriteCalls = 0;
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
		const source = () => {
			sourceReads++;
			const rows = ['{"type":"DOCHEAD","ticket":1}||{"docType":"SCH_PAGE","uuid":"pause-deadline-page","client":"test","version":1}'];
			let ticket = 2;
			for (const item of wires.values()) {
				rows.push(`${JSON.stringify({ type: 'WIRE', id: item.id, ticket: ticket++ })}||${JSON.stringify({ zIndex: 0 })}`);
				for (let i = 0; i + 3 < item.line.length; i += 2)
					rows.push(`${JSON.stringify({ type: 'LINE', id: `line-${item.id}-${i}`, ticket: ticket++ })}||${JSON.stringify({ lineGroup: item.id, startX: item.line[i], startY: -item.line[i + 1], endX: item.line[i + 2], endY: -item.line[i + 3], strokeColor: item.color, strokeWidth: item.lineWidth, strokeStyle: 'SOLID' })}`);
			}
			for (const attribute of attributes.values())
				rows.push(`${JSON.stringify({ type: 'ATTR', id: attribute.id, ticket: ticket++ })}||${JSON.stringify(attribute)}`);
			return rows.join('\n');
		};
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'pause-deadline-page' }) },
			sys_FileManager: { getDocumentSource: async () => source() },
			sch_PrimitiveAttribute: {
				getAll: async () => {
					attributeReadCalls++;
					return [];
				},
				create: async () => {
					labelWriteCalls++;
					return undefined;
				},
				modify: async () => {
					labelWriteCalls++;
					return undefined;
				},
			},
			sch_PrimitiveNetLabel: {
				getAll: async () => [],
				create: async () => {
					labelWriteCalls++;
					return undefined;
				},
				modify: async () => {
					labelWriteCalls++;
					return undefined;
				},
			},
			sch_PrimitiveWire: {
				getAll: async () => {
					modelReads++;
					if (createCalls.length && postCreateModelReads < staleModelReadsAfterCreate) {
						postCreateModelReads++;
						return [];
					}
					return [...wires.values()].map(wire);
				},
				create: async (line, net) => {
					createCalls.push({ line: [...line], net });
					if (corruptExistingRelevance && createCalls.length === 1)
						attributes.get('existing-attr').value = '["corrupted"]';
					const item = { id: `wire-${createCalls.length}`, line, color: '#000000', lineWidth: 6, lineType: 0, net: net ?? '' };
					wires.set(item.id, item);
					if (net)
						attributes.set(`net-${item.id}`, { id: `net-${item.id}`, key: 'NET', value: net, parentId: item.id, zIndex: 5 });
					return wire(item);
				},
			},
		};
		return {
			wires,
			createCalls,
			get sourceReads() { return sourceReads; },
			get modelReads() { return modelReads; },
			get attributeReadCalls() { return attributeReadCalls; },
			get labelWriteCalls() { return labelWriteCalls; },
		};
	}

	function setPauseBehavior(mode) {
		const clockSetTimeout = globalThis.setTimeout;
		let pauseTriggered = false;
		activePauseControl = {
			armed: false,
			onValidationFailure: () => { pauseTriggered = true; },
		};
		globalThis.setTimeout = (callback, delay, ...args) => {
			if (pauseTriggered && Number(delay) === 40) {
				pauseTriggered = false;
				if (mode === 'never')
					return Number.MIN_SAFE_INTEGER;
				if (mode === 'late')
					return clockSetTimeout(callback, 2000, ...args);
			}
			return clockSetTimeout(callback, delay, ...args);
		};
		return () => {
			globalThis.setTimeout = clockSetTimeout;
			activePauseControl = undefined;
		};
	}

	function details(result) {
		return JSON.stringify({ result, diagnosticEvents, pauseControl: activePauseControl });
	}

	{
		const clock = installVirtualClock();
		const restorePause = setPauseBehavior('never');
		diagnosticEvents.length = 0;
		const diagnosticCountBefore = diagnosticEvents.length;
		const harness = makeHarness({ corruptExistingRelevance: true });
		try {
			const result = await executeCommand({ cmd: 'schematic.drawWire', params: { _timeoutMs: 1500, points: [[0, 0], [10, 0], [10, 10]] } });
			const events = diagnosticEvents.slice(diagnosticCountBefore);
			assert.equal(result.ok, false, `a permanently pending short pause must return an error: ${details(result)}`);
			assert.equal(result.error.cause?.source, undefined, `the shared inner deadline must beat the outer heartbeat fuse: ${details(result)}`);
			assert.equal(result.error.cause?.partial, true, `the inner deadline must return a structured partial: ${details(result)}`);
			const diagnostic = result.error.cause?.drawWireDiagnostic;
			assert.match(diagnostic?.lastValidationError?.message ?? '', /自动网络标签重建字段无效/, `the original post-write rejection remains visible: ${details(result)}`);
			assert.equal(result.error.cause?.result?.partial?.stoppedAtSegment, 1, `the partial identifies the stopped segment: ${details(result)}`);
			assert.ok(events.some(event => event.stage === 'timeout-fired'), `the deadline timer firing is logged: ${details(result)}`);
			assert.ok(events.some(event => event.stage === 'partial-assembly'), `partial assembly is logged after the timer event: ${details(result)}`);
			assert.equal(harness.createCalls.length, 1, `the next segment must not be created: ${details(result)}`);
			assert.equal(activePauseControl?.armed, true, `the injected pause follows a real validation rejection: ${details(result)}`);
		}
		finally {
			restorePause();
			clock.restore();
		}
	}

	{
		const clock = installVirtualClock();
		diagnosticEvents.length = 0;
		const harness = makeHarness({ staleModelReadsAfterCreate: 1 });
		const diagnosticCountBefore = diagnosticEvents.length;
		try {
			const result = await executeCommand({ cmd: 'schematic.drawWire', params: { _timeoutMs: 1500, points: [[0, 0], [10, 0]] } });
			const events = diagnosticEvents.slice(diagnosticCountBefore);
			assert.equal(result.ok, true, `a normal pause should allow the later synchronized sample to converge: ${details(result)}`);
			assert.equal(result.data.drawWireDiagnostic?.createReturned, true, `the create result remains recorded: ${details(result)}`);
			assert.ok(result.data.drawWireDiagnostic?.sampleAttempts >= 2, `at least two samples are needed to converge: ${details(result)}`);
			assert.equal(result.data.drawWireDiagnostic?.wireIdsSynchronized, true, `the final sample is synchronized: ${details(result)}`);
			assert.equal(harness.createCalls.length, 1, `sampling recovery must not repeat create: ${details(result)}`);
			assert.ok(events.some(event => event.stage === 'timeout-armed' && JSON.parse(event.detail ?? '{}').event === 'timeout-armed'), `the bounded pause/read waits remain visible: ${details(result)}`);
		}
		finally {
			clock.restore();
		}
	}

	{
		const clock = installVirtualClock();
		const restorePause = setPauseBehavior('late');
		diagnosticEvents.length = 0;
		const diagnosticCountBefore = diagnosticEvents.length;
		const harness = makeHarness({ corruptExistingRelevance: true });
		try {
			const result = await executeCommand({ cmd: 'schematic.drawWire', params: { _timeoutMs: 1500, points: [[0, 0], [10, 0], [10, 10]], net: 'SIG' } });
			const partial = result.error?.cause?.result?.partial;
			assert.equal(result.error?.cause?.partial, true, `the first segment pause deadline should return the structured partial: ${details(result)}`);
			assert.equal(partial?.stoppedAtSegment, 1, `the operation must stop at the first segment: ${details(result)}`);
			assert.equal(harness.createCalls.length, 1, `no second segment or naming create may start: ${details(result)}`);
			assert.equal(harness.createCalls[0]?.net, 'SIG', `only the first requested named write was attempted: ${details(result)}`);
			assert.equal(activePauseControl?.armed, true, `the late pause is injected only after an actual validation rejection: ${details(result)}`);
			const countsAtPartial = { source: harness.sourceReads, model: harness.modelReads, attrs: harness.attributeReadCalls, writes: harness.createCalls.length + harness.labelWriteCalls };
			assert.ok(countsAtPartial.source > 0 && countsAtPartial.model > 0, `the partial follows source/model readback: ${details(result)}`);
			await new Promise(resolve => setTimeout(resolve, 1000));
			await Promise.resolve();
			await Promise.resolve();
			const countsAfterLatePause = { source: harness.sourceReads, model: harness.modelReads, attrs: harness.attributeReadCalls, writes: harness.createCalls.length + harness.labelWriteCalls };
			assert.deepEqual(countsAfterLatePause, countsAtPartial, `a late pause completion must not start more reads, creates, or naming writes: ${details(result)}`);
			const events = diagnosticEvents.slice(diagnosticCountBefore);
			assert.ok(events.some(event => event.stage === 'wait-settled' && JSON.parse(event.detail ?? '{}').lateAfterTimeout === true), `the late pause settlement is logged without resuming the command: ${details(result)}`);
		}
		finally {
			restorePause();
			clock.restore();
		}
	}

	setDiagSink(undefined);
	console.log('schematic-drawwire-pause-deadline-regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
