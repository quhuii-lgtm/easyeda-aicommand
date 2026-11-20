import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: { contents: 'export { pcbEditBatchCommands } from \'../src/commands/pcbEditBatch.ts\'; export { pcbPlacementPrimitiveCommands } from \'../src/commands/pcbPlacementPrimitives.ts\'; export { registerCommand, executeCommand } from \'../src/engine/registry.ts\';', resolveDir: resolve(root, 'test'), sourcefile: 'pcb-edit-batch-entry.ts' },
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { pcbEditBatchCommands, pcbPlacementPrimitiveCommands, registerCommand, executeCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const batchDefinition = pcbEditBatchCommands.find(item => item.name === 'pcb.runEditBatch');
	assert.ok(batchDefinition);
	const writeNames = pcbPlacementPrimitiveCommands.map(item => item.name).filter(name => /^pcb\.(?:place|modify)/.test(name));
	assert.ok(writeNames.length >= 2);

	let currentSource;
	let groupSource;
	let currentInfo;
	let mode = 'success';
	let writes = 0;
	let handlerCalls = [];
	let beginCalls = 0;
	let commitCalls = 0;
	let rollbackCalls = 0;
	let committed = true;
	let holdWriteTimer;
	const initialSource = () => `${JSON.stringify({ type: 'DOCHEAD', id: 'DOCHEAD' })}||${JSON.stringify({ docType: 'PCB', uuid: 'pcb-test', client: 'test' })}|\n${JSON.stringify({ type: 'CANVAS', id: 'CANVAS', ticket: 1 })}||${JSON.stringify({ originX: 0 })}|`;
	const changeSource = () => {
		writes++;
		currentSource += `\n${JSON.stringify({ type: 'TEST', id: `mutation-${writes}`, ticket: writes + 1 })}||${JSON.stringify({ value: writes })}|`;
	};
	const reset = (nextMode = 'success') => {
		currentSource = initialSource();
		groupSource = undefined;
		currentInfo = { documentType: 3, uuid: 'pcb-test', tabId: 'tab-test', parentProjectUuid: 'project-test' };
		mode = nextMode;
		writes = 0;
		handlerCalls = [];
		beginCalls = 0;
		commitCalls = 0;
		rollbackCalls = 0;
		committed = true;
	};

	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ ...currentInfo }) },
		sys_FileManager: { getDocumentSource: async () => currentSource },
		pcb_Document: {
			beginCommandGroup: async () => {
				beginCalls++;
				groupSource = currentSource;
				return { groupId: 'group-test' };
			},
			commitCommandGroup: async (id) => {
				assert.equal(id, 'group-test');
				commitCalls++;
				if (mode === 'tab-switch-during-commit')
					currentInfo = { ...currentInfo, tabId: 'tab-other' };
				if (mode === 'source-drift-during-commit')
					changeSource();
				return committed;
			},
			rollbackCommandGroup: async (id) => {
				assert.equal(id, 'group-test');
				rollbackCalls++;
				currentSource = groupSource;
				return true;
			},
		},
	};
	for (const name of writeNames) {
		registerCommand({
			name,
			summary: 'test primitive write',
			params: [],
			handler: async (_params, ctx) => {
				handlerCalls.push(name);
				await ctx.assertDocumentTarget();
				if (mode === 'second-before-write-fails' && handlerCalls.length === 2)
					throw new Error('validation rejected before write');
				if (mode === 'partial-second' && handlerCalls.length === 2) {
					changeSource();
					throw new Error('partial result', { cause: { partial: true, retryable: false } });
				}
				if (mode === 'timeout-second' && handlerCalls.length === 2) {
					await new Promise((resolveDelay) => {
						holdWriteTimer = setTimeout(() => {
							changeSource();
							resolveDelay();
						}, 1200);
					});
					return { lateWrite: true };
				}
				changeSource();
				if (mode === 'switch-tab-after-first' && handlerCalls.length === 1)
					currentInfo = { ...currentInfo, tabId: 'tab-other' };
				return { primitiveId: `item-${writes}`, readbackVerified: true };
			},
		});
	}
	registerCommand(batchDefinition);

	const call = async params => executeCommand({ cmd: 'pcb.runEditBatch', params });
	const twoSteps = [
		{ cmd: 'pcb.placeArc', params: { startX: 10, endX: 20 } },
		{ cmd: 'pcb.modifyArc', params: { primitiveId: 'item-1', lineWidth: 8 } },
	];

	reset();
	const dryRun = await call({ steps: twoSteps });
	assert.equal(dryRun.ok, true);
	assert.equal(dryRun.data.dryRun, true);
	assert.equal(dryRun.data.groupStarted, false);
	assert.equal(beginCalls, 0);
	assert.equal(handlerCalls.length, 0);

	reset();
	const success = await call({ steps: twoSteps, dryRun: false, name: 'two-step test' });
	assert.equal(success.ok, true, success.error?.message);
	assert.equal(success.data.groupId, 'group-test');
	assert.equal(success.data.committed, true);
	assert.equal(success.data.steps.length, 2);
	assert.equal(success.data.steps[0].result.ok, true);
	assert.equal(success.data.steps[0].result.data.primitiveId, 'item-1');
	assert.equal(beginCalls, 1);
	assert.equal(commitCalls, 1);
	assert.equal(rollbackCalls, 0);

	reset('second-before-write-fails');
	const rolledBack = await call({ steps: twoSteps, dryRun: false });
	assert.equal(rolledBack.ok, false);
	assert.equal(rolledBack.error.cause.status, 'rolled-back');
	assert.equal(rolledBack.error.cause.retryable, true);
	assert.equal(rollbackCalls, 1);
	assert.equal(writes, 1);
	assert.equal(handlerCalls.length, 2);

	reset('partial-second');
	const partial = await call({ steps: twoSteps, dryRun: false });
	assert.equal(partial.ok, false);
	assert.equal(partial.error.cause.status, 'unknown');
	assert.equal(partial.error.cause.partial, true);
	assert.equal(rollbackCalls, 0);
	assert.equal(handlerCalls.length, 2);

	reset('timeout-second');
	const timedOut = await call({ steps: [{ ...twoSteps[0] }, { ...twoSteps[1], params: { ...twoSteps[1].params, _timeoutMs: 1000 } }], dryRun: false });
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.error.cause.status, 'unknown');
	assert.equal(rollbackCalls, 0);
	assert.equal(handlerCalls.length, 2);
	await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
	assert.equal(writes, 2, 'the timed-out write can finish later; the batch does not roll it back');
	clearTimeout(holdWriteTimer);

	reset('switch-tab-after-first');
	const switched = await call({ steps: twoSteps, dryRun: false });
	assert.equal(switched.ok, false);
	assert.equal(switched.error.cause.status, 'unknown');
	assert.equal(handlerCalls.length, 1, 'tab change prevents the next step');
	assert.equal(rollbackCalls, 0, 'tab change prevents rollback against a different active page');

	reset('tab-switch-during-commit');
	const commitTabChanged = await call({ steps: twoSteps, dryRun: false });
	assert.equal(commitTabChanged.ok, false);
	assert.equal(commitTabChanged.error.cause.status, 'unknown');
	assert.equal(commitCalls, 1);
	assert.equal(rollbackCalls, 0, 'tab switch during commit is checked after commit and is not rolled back');

	reset('source-drift-during-commit');
	const commitSourceChanged = await call({ steps: twoSteps, dryRun: false });
	assert.equal(commitSourceChanged.ok, false);
	assert.equal(commitSourceChanged.error.cause.status, 'unknown');
	assert.equal(commitSourceChanged.error.cause.phase, 'post-commit-readback');
	assert.equal(commitSourceChanged.error.cause.committed, true);
	assert.equal(rollbackCalls, 0, 'post-commit source mismatch remains unknown without rollback');

	reset();
	const wrongTarget = await call({ steps: twoSteps, dryRun: false, __docUuid: 'other-pcb' });
	assert.equal(wrongTarget.ok, false);
	assert.equal(beginCalls, 0);
	assert.equal(handlerCalls.length, 0);
	assert.equal(writes, 0);

	console.log('PCB edit batch regression passed: dry-run, success, verified rollback, partial/timeout no rollback, tab switch stop, post-commit target/source checks, wrong-target zero-write.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
