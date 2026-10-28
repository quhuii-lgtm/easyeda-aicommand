import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { buildSync } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = buildSync({
		stdin: {
			contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand, executeCommand } from '../src/engine/registry.ts'; export { schematicCommands, registerCommand, executeCommand }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'drawwire-registry-diagnostics-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { schematicCommands, registerCommand, executeCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	for (const command of schematicCommands)
		registerCommand(command);
	const drawWireCommand = schematicCommands.find(command => command.name === 'schematic.drawWire');

	function makeHarness({ create, hangSourceAfterCreate = false, driftExistingAttrZIndex = false } = {}) {
		const wires = new Map();
		const attributes = new Map();
		let creates = 0;
		let sourceReads = 0;
		let modelReads = 0;
		if (driftExistingAttrZIndex) {
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
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'registry-diagnostic-page' }) },
			sys_FileManager: {
				getDocumentSource: async () => {
					sourceReads++;
					if (hangSourceAfterCreate && creates > 0)
						return new Promise(() => {});
					const rows = ['{"type":"DOCHEAD","ticket":1}||{"docType":"SCH_PAGE","uuid":"registry-diagnostic-page","client":"test","version":1}'];
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
					if (driftExistingAttrZIndex && creates === 1)
						attributes.get('existing-attr').zIndex = 1;
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
			attributes,
			get creates() { return creates; },
			get sourceReads() { return sourceReads; },
			get modelReads() { return modelReads; },
		};
	}

	async function runDrawWire(options) {
		const harness = makeHarness(options);
		const startedAt = Date.now();
		const result = await executeCommand({ cmd: 'schematic.drawWire', params: { _timeoutMs: 1500, points: [[0, 0], [10, 0]] } });
		return { harness, result, elapsedMs: Date.now() - startedAt };
	}

	for (const [name, options, check] of [
		['create pending', { create: () => new Promise(() => {}) }, (diagnostic) => {
			assert.equal(diagnostic.createAttempted, true);
			assert.equal(diagnostic.createReturned, false);
			assert.equal(diagnostic.stage, 'create:pending');
		}],
		['create returned then read pending', { hangSourceAfterCreate: true }, (diagnostic) => {
			assert.equal(diagnostic.createAttempted, true);
			assert.equal(diagnostic.createReturned, true);
			assert.equal(diagnostic.lastReadLabel, '读取原理图源码');
		}],
		['stable post-write validation rejection', { driftExistingAttrZIndex: true }, (diagnostic) => {
			assert.equal(diagnostic.createReturned, true);
			assert.match(diagnostic.lastValidationError?.message ?? '', /existing-wire 的 ATTR zIndex/);
		}],
	]) {
		const { harness, result, elapsedMs } = await runDrawWire(options);
		assert.equal(result.ok, false, `${name} should fail`);
		assert.equal(result.error.cause?.partial, true, `${name} internal deadline marks a partial result; elapsed=${elapsedMs}ms error=${JSON.stringify(result.error)}`);
		assert.equal(result.error.cause?.source, undefined, `${name} should resolve through drawWire's inner deadline before the outer fuse`);
		assert.equal(result.error.cause?.drawWireDiagnosticSemantics, undefined, `${name} is not annotated as an outer heartbeat fuse`);
		assert.ok(result.error.cause?.drawWireDiagnostic, `${name} keeps its original handler diagnostic`);
		check(result.error.cause.drawWireDiagnostic);
		assert.equal(harness.creates, 1, `${name} only attempts one create`);
		assert.ok(elapsedMs >= 1100 && elapsedMs < 1500, `${name} elapsed=${elapsedMs}ms should return at the inner ~1350ms deadline`);
	}

	let originalDiagnostic;
	registerCommand({
		...drawWireCommand,
		handler: async (_params, context) => {
			originalDiagnostic = { stage: 'reported-before-hang', nested: { sampleAttempts: 2 } };
			context?.onProgress?.({ state: 'running', drawWireDiagnostic: originalDiagnostic });
			await new Promise(resolve => setTimeout(resolve, 550));
			originalDiagnostic = { stage: 'last-reported-before-hang', nested: { sampleAttempts: 3 } };
			context?.onProgress?.({ state: 'running', drawWireDiagnostic: originalDiagnostic });
			return new Promise(() => {});
		},
	});
	{
		const startedAt = Date.now();
		const result = await executeCommand({ cmd: 'schematic.drawWire', params: { _timeoutMs: 1000 } });
		const elapsedMs = Date.now() - startedAt;
		assert.equal(result.ok, false);
		assert.equal(result.error.cause?.partial, true);
		assert.equal(result.error.cause?.source, 'heartbeat-fuse');
		assert.equal(result.error.cause?.drawWireDiagnostic?.stage, 'last-reported-before-hang');
		assert.equal(result.error.cause?.drawWireDiagnostic?.nested?.sampleAttempts, 3);
		assert.equal(typeof result.error.cause?.drawWireDiagnosticReceivedAt, 'string');
		assert.ok(Number.isFinite(Date.parse(result.error.cause.drawWireDiagnosticReceivedAt)));
		assert.match(result.error.cause?.drawWireDiagnosticSemantics ?? '', /last-reported.*may not represent current state/);
		originalDiagnostic.stage = 'mutated-after-timeout';
		originalDiagnostic.nested.sampleAttempts = 99;
		assert.equal(result.error.cause.drawWireDiagnostic.stage, 'last-reported-before-hang', 'the outer-fuse error keeps an immutable deep copy');
		assert.equal(result.error.cause.drawWireDiagnostic.nested.sampleAttempts, 3, 'nested diagnostic values are also copied');
		assert.ok(elapsedMs >= 950 && elapsedMs < 1400, `without an external consumer the second internal report must not reset the fuse; elapsed=${elapsedMs}ms`);
	}

	registerCommand(drawWireCommand);
	{
		const progress = [];
		registerCommand({
			...drawWireCommand,
			handler: async (_params, context) => {
				context?.onProgress?.({ state: 'running', drawWireDiagnostic: { stage: 'first' } });
				await new Promise(resolve => setTimeout(resolve, 650));
				context?.onProgress?.({ state: 'running', drawWireDiagnostic: { stage: 'second' } });
				return new Promise(() => {});
			},
		});
		const startedAt = Date.now();
		const result = await executeCommand({ cmd: 'schematic.drawWire', params: { _timeoutMs: 1000 } }, { vars: {}, onProgress: patch => progress.push(patch) });
		const elapsedMs = Date.now() - startedAt;
		assert.equal(result.error?.cause?.source, 'heartbeat-fuse');
		assert.deepEqual(progress.map(patch => patch.drawWireDiagnostic.stage), ['first', 'second'], 'the external progress consumer still receives events');
		assert.equal(result.error.cause.drawWireDiagnostic.stage, 'second', 'the last consumer-visible diagnostic is retained');
		assert.ok(elapsedMs >= 1500 && elapsedMs < 2200, `consumer progress keeps resetting the fuse; elapsed=${elapsedMs}ms`);
	}

	console.log('drawwire-registry-diagnostics-regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
