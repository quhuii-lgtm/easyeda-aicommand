import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const bundlePath = resolve(root, 'test/.editor-open-timeout-regression-bundle.mjs');

async function main() {
	await build({ entryPoints: [resolve(root, 'src/commands/editor.ts')], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm' });
	const { editorCommands } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
	const openCommand = editorCommands.find(command => command.name === 'editor.openDocument');
	assert.ok(openCommand);

	function makeFixture() {
		const state = { projectUuid: 'project-a', opened: [], activated: [], openImpl: async uuid => `${uuid}@project-a` };
		globalThis.eda = {
			dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: state.projectUuid }) },
			dmt_EditorControl: {
				openDocument: async (uuid) => {
					state.opened.push(uuid);
					return await state.openImpl(uuid);
				},
				activateDocument: async (tabId) => {
					state.activated.push(tabId);
					return true;
				},
			},
		};
		return state;
	}
	function context(projectUuid = 'project-a') {
		return {
			stopSignal: { assertActive() {} },
			documentTarget: { documentType: 3, uuid: 'active-doc', parentProjectUuid: projectUuid },
		};
	}

	{
		const state = makeFixture();
		const result = await openCommand.handler({ uuid: 'target-doc', __projectUuid: 'project-a' }, context());
		assert.deepEqual(result, { tabId: 'target-doc@project-a', activated: true });
		assert.deepEqual(state.opened, ['target-doc']);
		assert.deepEqual(state.activated, ['target-doc@project-a']);
	}

	{
		const state = makeFixture();
		let releaseOpen;
		state.openImpl = () => new Promise((resolveOpen) => {
			releaseOpen = resolveOpen;
		});
		let stopped = false;
		const ctx = context();
		ctx.stopSignal.assertActive = () => {
			if (stopped)
				throw new Error('command timed out');
		};
		const pending = openCommand.handler({ uuid: 'target-doc', __projectUuid: 'project-a' }, ctx);
		await new Promise(resolveTick => setImmediate(resolveTick));
		assert.deepEqual(state.opened, ['target-doc']);
		stopped = true;
		releaseOpen('target-doc@project-a');
		await assert.rejects(pending, error => error.cause?.partial === true && error.cause?.retryable === false && error.cause?.phase === 'openDocument.beforeActivate' && error.cause?.tabId === 'target-doc@project-a');
		assert.deepEqual(state.activated, [], 'a late open result after stop must not activate');
	}

	{
		const state = makeFixture();
		let releaseOpen;
		state.openImpl = () => new Promise((resolveOpen) => {
			releaseOpen = resolveOpen;
		});
		const pending = openCommand.handler({ uuid: 'target-doc', __projectUuid: 'project-a' }, context());
		await new Promise(resolveTick => setImmediate(resolveTick));
		state.projectUuid = 'project-b';
		releaseOpen('target-doc@project-a');
		await assert.rejects(pending, error => error.cause?.partial === true && error.cause?.retryable === false && error.cause?.phase === 'openDocument.beforeActivate' && error.cause?.tabId === 'target-doc@project-a');
		assert.deepEqual(state.activated, [], 'a project switch while open is pending must prevent activation');
	}

	{
		const state = makeFixture();
		state.openImpl = async () => {
			throw new Error('host timeout');
		};
		await assert.rejects(openCommand.handler({ uuid: 'target-doc', __projectUuid: 'project-a' }, context()), error => error.cause?.partial === true && error.cause?.retryable === false && error.cause?.phase === 'openDocument.outcomeUnknown' && error.cause?.tabId === undefined);
		assert.deepEqual(state.activated, []);
	}

	console.log('editor open timeout regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
