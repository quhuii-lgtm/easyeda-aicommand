import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

async function main() {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const bundle = await build({
		entryPoints: [path.join(repo, 'src/commands/pcbCanvasOrigin.ts')],
		bundle: true,
		platform: 'node',
		format: 'iife',
		globalName: 'canvasModule',
		write: false,
	});
	const sandbox = { exports: {}, module: { exports: {} }, eda: {} };
	vm.runInNewContext(bundle.outputFiles[0].text, sandbox);
	const commands = sandbox.canvasModule.pcbCanvasOriginCommands;
	const get = commands.find(command => command.name === 'pcb.getCanvasOrigin').handler;
	const set = commands.find(command => command.name === 'pcb.setCanvasOrigin').handler;
	const target = { documentType: 3, uuid: 'pcb-test' };
	let calls = 0;
	let origin = { offsetX: -120, offsetY: 65 };
	let setterResult = true;
	let postReadError = false;
	let guardCalls = 0;
	let changeTargetAtGuard;
	const context = {
		documentTarget: target,
		assertDocumentTarget: async () => {
			guardCalls++;
			if (changeTargetAtGuard === guardCalls)
				throw new Error('target changed');
		},
	};
	sandbox.eda.pcb_Document = {
		getCanvasOrigin: async () => {
			calls++;
			if (postReadError && calls > 1)
				throw new Error('readback failed');
			return { ...origin };
		},
		setCanvasOrigin: async (x, y) => {
			calls++;
			if (setterResult)
				origin = { offsetX: x, offsetY: y };
			return setterResult;
		},
	};

	assert.deepEqual(JSON.parse(JSON.stringify(await get({}, context))), {
		offsetX: -120,
		offsetY: 65,
		unit: 'mil',
		affectsPrimitiveCoordinates: false,
		manufacturingExportCoordinates: 'may-change',
		document: target,
	});

	const beforeNoop = calls;
	const noop = await set({ offsetX: -120, offsetY: 65 }, context);
	assert.equal(noop.changed, false);
	assert.equal(calls, beforeNoop + 1, 'same origin must avoid a write');

	const changed = await set({ offsetX: 0, offsetY: 0 }, context);
	assert.equal(changed.changed, true);
	assert.deepEqual(JSON.parse(JSON.stringify(changed.after)), { offsetX: 0, offsetY: 0 });
	assert.equal(changed.affectsPrimitiveCoordinates, false);

	const writesBeforeInvalid = calls;
	await assert.rejects(set({ offsetX: Number.NaN, offsetY: 0 }, context), /有限数值/);
	await assert.rejects(set({ offsetX: 0, offsetY: 1, unexpected: true }, context), /未知参数/);
	assert.equal(calls, writesBeforeInvalid, 'invalid arguments must be rejected before SDK calls');

	await assert.rejects(set({ offsetX: 1, offsetY: 2 }, { ...context, documentTarget: { documentType: 1, uuid: 'schematic' } }), /缺少当前 PCB/);

	setterResult = false;
	const priorFalseResult = { ...origin };
	await assert.rejects(set({ offsetX: 10, offsetY: 11 }, context), (error) => {
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.retryable, false);
		assert.equal(error.cause.sdkResult, false);
		return true;
	});
	assert.deepEqual(origin, priorFalseResult, 'false SDK result with unchanged origin must not be reported as success');
	setterResult = true;

	const guardWriteBefore = calls;
	guardCalls = 0;
	changeTargetAtGuard = 3;
	await assert.rejects(set({ offsetX: 20, offsetY: 21 }, context), /target changed/);
	assert.equal(calls, guardWriteBefore + 1, 'target change before write must prevent mutation');
	changeTargetAtGuard = undefined;

	postReadError = true;
	calls = 0;
	await assert.rejects(set({ offsetX: 30, offsetY: 31 }, context), (error) => {
		assert.equal(error.cause.partial, true);
		assert.equal(error.cause.retryable, false);
		assert.equal(error.cause.phase, 'setCanvasOrigin.readback');
		return true;
	});
	assert.deepEqual(origin, { offsetX: 30, offsetY: 31 }, 'write may succeed even when its readback fails');

	console.log('PCB canvas-origin regression passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
