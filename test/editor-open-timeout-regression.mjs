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
		const state = {
			projectUuid: 'project-a',
			focus: { documentType: 3, uuid: 'active-doc', tabId: 'active-tab', parentProjectUuid: 'project-a' },
			opened: [], activated: [], openImpl: async uuid => `${uuid}@project-a`, activateImpl: async tabId => {
				state.focus = { documentType: 3, uuid: 'target-doc', tabId, parentProjectUuid: 'project-a' };
				return true;
			},
		};
		globalThis.eda = {
			dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: state.projectUuid }) },
			dmt_SelectControl: { getCurrentDocumentInfo: async () => state.focus },
			dmt_EditorControl: {
				openDocument: async (uuid) => {
					state.opened.push(uuid);
					return await state.openImpl(uuid);
				},
				activateDocument: async (tabId) => {
					state.activated.push(tabId);
					return await state.activateImpl(tabId);
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
		assert.deepEqual(result, {
			tabId: 'target-doc@project-a', activated: true, sdkActivated: true,
			observed: { projectUuid: 'project-a', documentUuid: 'target-doc', tabId: 'target-doc@project-a', parentProjectUuid: 'project-a' },
		});
		assert.deepEqual(state.opened, ['target-doc']);
		assert.deepEqual(state.activated, ['target-doc@project-a']);
	}

	{
		const state = makeFixture();
		state.focus = { documentType: 3, uuid: 'page-a', tabId: 'page-a-tab', parentProjectUuid: 'project-a' };
		state.openImpl = async () => 'page-a@project-a';
		state.activateImpl = async () => {
			// Two projects can contain pages with the same display title. The connected focus
			// has the other project's UUID, so an SDK success value alone must not pass.
			state.focus = { documentType: 3, uuid: 'page-b', title: 'Main', tabId: 'page-b@project-b', parentProjectUuid: 'project-b' };
			return true;
		};
		await assert.rejects(
			openCommand.handler({ uuid: 'page-a', __projectUuid: 'project-a' }, context()),
			error => error.cause?.partial === true
				&& error.cause?.retryable === false
				&& error.cause?.phase === 'openDocument.activationUnconfirmed'
				&& error.cause?.observed?.documentUuid === 'page-b'
				&& /焦点归属与绑定目标不同/.test(error.message),
		);
		assert.deepEqual(state.activated, ['page-a@project-a']);
	}

	{
		const state = makeFixture();
		state.activateImpl = async () => {
			// openDocument/activateDocument claim success, but the focused page remains stale.
			return true;
		};
		await assert.rejects(
			openCommand.handler({ uuid: 'target-doc', __projectUuid: 'project-a' }, context()),
			error => error.cause?.phase === 'openDocument.activationUnconfirmed'
				&& error.cause?.observed?.documentUuid === 'active-doc'
				&& /焦点未确认/.test(error.message),
		);
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
		await assert.rejects(openCommand.handler({ uuid: 'target-doc', __projectUuid: 'project-a' }, context()), error => error.cause?.partial === true && error.cause?.outcome === 'unknown' && error.cause?.retryable === false && error.cause?.phase === 'openDocument.outcomeUnknown' && error.cause?.tabId === undefined);
		assert.deepEqual(state.activated, []);
	}

	console.log('editor open timeout regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
