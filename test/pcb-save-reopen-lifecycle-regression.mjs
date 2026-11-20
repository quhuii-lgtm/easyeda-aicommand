import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { pcbCommands } from '../src/commands/pcb.ts'; export { pcbCommands }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'pcb-save-reopen-lifecycle-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { pcbCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const save = pcbCommands.find(command => command.name === 'pcb.save').handler;
	const getRevision = pcbCommands.find(command => command.name === 'pcb.getRevision').handler;
	const source = [
		'{"type":"DOCHEAD","ticket":0,"id":"head"}||{"docType":"PCB","uuid":"pcb-a","client":"host"}|',
		'{"type":"LINE","id":"line-a","ticket":1}||{"startX":1,"startY":2,"endX":3,"endY":4}|',
	].join('\n');
	const originalTabId = 'pcb-a@project-a';
	const reopenedTabId = 'pcb-a@project-a-reopened';
	const projectData = [{ uuid: 'pcb-a' }];

	const setup = ({ deferOpen = false, switchProjectAfterClose = false, switchProjectAtOpenGuard = false } = {}) => {
		let activeTabId = originalTabId;
		let focus = { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: originalTabId };
		let projectUuid = 'project-a';
		let projectReads = 0;
		let stopRequested = false;
		let openCalls = 0;
		let activateCalls = 0;
		let closeCalls = 0;
		let sourceReads = 0;
		let sourceWrites = 0;
		let saveCalls = 0;
		let releaseOpen;
		let signalOpenStarted;
		const openStarted = new Promise((resolveStarted) => {
			signalOpenStarted = resolveStarted;
		});
		const context = {
			documentTarget: { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: originalTabId },
			vars: { probe: 'kept' },
			onProgress: () => {},
			stopSignal: {
				assertActive: () => {
					if (stopRequested)
						throw new Error('command stop requested');
				},
				stop: () => { stopRequested = true; },
			},
			assertDocumentTarget: async () => {
				if (stopRequested)
					throw new Error('command stop requested');
				if (focus?.documentType !== 3 || focus.uuid !== 'pcb-a' || focus.tabId !== originalTabId || projectUuid !== 'project-a')
					throw new Error('original document target changed');
			},
		};
		globalThis.eda = {
			sys_Environment: { getEditorCurrentVersion: () => '4.1.99' },
			sys_FileManager: {
				getDocumentSource: async () => {
					sourceReads++;
					return source;
				},
				setDocumentSource: async () => {
					sourceWrites++;
					return true;
				},
			},
			pcb_Document: {
				save: async () => {
					saveCalls++;
					return true;
				},
			},
			pcb_Drc: { getCurrentRuleConfiguration: async () => undefined },
			dmt_SelectControl: { getCurrentDocumentInfo: async () => focus },
			dmt_Project: {
				getCurrentProjectInfo: async () => {
					projectReads++;
					const readUuid = switchProjectAtOpenGuard && projectReads === 2 ? 'project-other' : projectUuid;
					return { uuid: readUuid, data: projectData };
				},
			},
			dmt_EditorControl: {
				getSplitScreenTree: async () => ({ tabs: activeTabId ? [{ tabId: activeTabId }] : [] }),
				closeDocument: async (tabId) => {
					closeCalls++;
					assert.equal(tabId, originalTabId);
					activeTabId = undefined;
					focus = undefined;
					if (switchProjectAfterClose)
						projectUuid = 'project-other';
					return true;
				},
				openDocument: async (uuid) => {
					openCalls++;
					assert.equal(uuid, 'pcb-a');
					signalOpenStarted();
					const finish = () => {
						activeTabId = reopenedTabId;
						focus = { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: reopenedTabId };
						return reopenedTabId;
					};
					if (!deferOpen)
						return finish();
					return new Promise((resolveOpen) => {
						releaseOpen = () => resolveOpen(finish());
					});
				},
				activateDocument: async (tabId) => {
					activateCalls++;
					assert.equal(tabId, reopenedTabId);
					return true;
				},
			},
		};
		return {
			context,
			openStarted,
			get releaseOpen() { return releaseOpen; },
			get openCalls() { return openCalls; },
			get activateCalls() { return activateCalls; },
			get closeCalls() { return closeCalls; },
			get sourceReads() { return sourceReads; },
			get sourceWrites() { return sourceWrites; },
			get saveCalls() { return saveCalls; },
			stop: () => { stopRequested = true; },
			get activeTabId() { return activeTabId; },
		};
	};

	{
		const state = setup();
		const expectedDigest = (await getRevision({}, state.context)).digest;
		const result = await save({ verifyReopen: true, expectedDigest }, state.context);
		assert.equal(result.persistenceVerified, true);
		assert.equal(result.phases.closed, true);
		assert.equal(result.phases.reopenedTabId, reopenedTabId);
		assert.equal(state.closeCalls, 1);
		assert.equal(state.openCalls, 1);
		assert.equal(state.activateCalls, 1);
		assert.equal(state.saveCalls, 1);
		assert.equal(state.sourceWrites, 0);
	}
	console.log('PASS normal save-close-open passes project binding, preserves context, and verifies reopened PCB on its new tab');

	{
		const state = setup({ deferOpen: true });
		const expectedDigest = (await getRevision({}, state.context)).digest;
		const sourceReadsBeforeSave = state.sourceReads;
		const pending = save({ verifyReopen: true, expectedDigest }, state.context);
		await state.openStarted;
		state.stop();
		state.releaseOpen();
		await assert.rejects(pending, (error) => {
			assert.equal(error.cause?.phase, 'reopen');
			assert.equal(error.cause?.partial, true);
			return /command stop requested/.test(error.message);
		});
		assert.equal(state.openCalls, 1, 'one open attempt is not automatically retried');
		assert.equal(state.activateCalls, 0, 'late open after stop is not activated');
		assert.equal(state.sourceReads, sourceReadsBeforeSave + 2, 'late open after stop does not perform persistence comparison reads');
		assert.equal(state.sourceWrites, 0, 'late open after stop does not continue with a dependent write');
		assert.equal(state.saveCalls, 1);
	}
	console.log('PASS stop during a pending reopen prevents late activation, comparison, retry, and later writes');

	{
		const state = setup({ switchProjectAfterClose: true });
		const expectedDigest = (await getRevision({}, state.context)).digest;
		const sourceReadsBeforeSave = state.sourceReads;
		await assert.rejects(save({ verifyReopen: true, expectedDigest }, state.context), (error) => {
			assert.equal(error.cause?.phase, 'reopen');
			assert.equal(error.cause?.partial, true);
			return /指定工程/.test(error.message);
		});
		assert.equal(state.closeCalls, 1);
		assert.equal(state.openCalls, 0, 'project switch after close blocks the open request');
		assert.equal(state.activateCalls, 0);
		assert.equal(state.sourceReads, sourceReadsBeforeSave + 2);
		assert.equal(state.sourceWrites, 0);
	}
	console.log('PASS project change after close is rejected before opening a document');

	{
		const state = setup({ switchProjectAtOpenGuard: true });
		const expectedDigest = (await getRevision({}, state.context)).digest;
		await assert.rejects(save({ verifyReopen: true, expectedDigest }, state.context), (error) => {
			assert.equal(error.cause?.phase, 'reopen');
			return /工程 UUID 与指令绑定工程不一致/.test(error.message);
		});
		assert.equal(state.openCalls, 0, 'editor.openDocument receives the original __projectUuid and rejects a project switch before SDK open');
		assert.equal(state.activateCalls, 0);
	}
	console.log('PASS editor open project binding rejects a switch between save-level check and open request');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
