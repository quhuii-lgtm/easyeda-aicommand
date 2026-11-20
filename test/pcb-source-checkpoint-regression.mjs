import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { pcbGroupingCommands } from '../src/commands/pcbGrouping.ts'; import { setProxyPort } from '../src/bridge/proxy-endpoint.ts'; export { pcbGroupingCommands, setProxyPort }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'pcb-source-checkpoint-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { pcbGroupingCommands, setProxyPort } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const checkpoint = pcbGroupingCommands.find(command => command.name === 'pcb.sourceCheckpoint').handler;
	const source = [
		'{"type":"DOCHEAD","ticket":0,"id":"head"}||{"docType":"PCB","uuid":"pcb-a","client":"host"}|',
		'{"type":"FILL","id":"fill-a","ticket":1}||{"netName":"GND","fillStyle":"SOLID","path":[0,0,10,10],"refs":null}|',
	].join('\n');
	const target = { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: 'pcb-a@project-a' };
	let focus = { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: target.tabId };
	const nestedBoard = () => ({
		itemType: 'Board',
		name: 'Board A',
		parentProjectUuid: 'project-a',
		schematic: null,
		pcb: { itemType: 'PCB', uuid: 'pcb-a', name: 'PCB A', parentProjectUuid: 'project-a', parentBoardName: 'Board A' },
	});
	const detachedPcb = () => ({ itemType: 'PCB', uuid: 'pcb-a', name: 'Copied PCB', parentProjectUuid: 'project-a' });
	let project = { uuid: 'project-a', friendlyName: 'Checkpoint Project', data: [nestedBoard()] };
	let currentSource = source;
	let targetChecks = 0;
	let sourceReads = 0;
	let sourceWrites = 0;
	let saves = 0;
	let proxyCreates = 0;
	let proxyReads = 0;
	let storageWrites = 0;
	let storedConfig = null;
	let rejectTarget = false;
	let responses = {};
	const context = {
		documentTarget: target,
		assertDocumentTarget: async () => {
			targetChecks++;
			if (rejectTarget)
				throw new Error('captured document target changed');
		},
	};
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => focus },
		dmt_Project: { getCurrentProjectInfo: async () => project },
		sys_FileManager: {
			getDocumentSource: async () => {
				sourceReads++;
				return currentSource;
			},
			setDocumentSource: async () => {
				sourceWrites++;
				return true;
			},
		},
		sys_ClientUrl: {
			request: async (url, method, body) => {
				const request = body ? JSON.parse(body) : undefined;
				if (url.endsWith('/source-backup') && method === 'POST') {
					proxyCreates++;
					responses.createRequest = request;
					return { text: async () => JSON.stringify(responses.create ?? { ok: true, backupId: 'project-a/checkpoint-1', file: 'backups/project-a/checkpoint-1.txt' }) };
				}
				if (url.endsWith('/source-backup/read') && method === 'POST') {
					proxyReads++;
					responses.readRequest = request;
					return { text: async () => JSON.stringify(responses.read ?? { ok: true, backupId: request.backupId, pcbUuid: 'pcb-a', source }) };
				}
				throw new Error(`unexpected proxy request: ${method} ${url}`);
			},
		},
		sys_Storage: {
			setExtensionUserConfig: async (key, value) => {
				storageWrites++;
				assert.equal(key, 'ai-command-engine:pcb-source-backup');
				storedConfig = value;
				return true;
			},
			getExtensionUserConfig: async (key) => {
				assert.equal(key, 'ai-command-engine:pcb-source-backup');
				return storedConfig;
			},
		},
		pcb_Document: {
			save: async () => {
				saves++;
				return true;
			},
		},
	};
	const resetCounters = () => {
		targetChecks = 0;
		sourceReads = 0;
		sourceWrites = 0;
		saves = 0;
		proxyCreates = 0;
		proxyReads = 0;
		storageWrites = 0;
		responses = {};
		currentSource = source;
		focus = { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: target.tabId };
		project = { uuid: 'project-a', friendlyName: 'Checkpoint Project', data: [nestedBoard()] };
		rejectTarget = false;
		storedConfig = null;
	};

	resetCounters();
	setProxyPort(49721);
	const proxyResult = await checkpoint({ note: 'before route change' }, context);
	assert.equal(proxyResult.backupId, 'project-a/checkpoint-1');
	assert.equal(proxyResult.location, 'proxy');
	assert.equal(proxyResult.file, 'backups/project-a/checkpoint-1.txt');
	assert.equal(proxyResult.pcbUuid, 'pcb-a');
	assert.equal(proxyResult.projectUuid, 'project-a');
	assert.equal(proxyResult.sourceSizeBytes, new TextEncoder().encode(source).byteLength);
	assert.equal(proxyResult.verified, true);
	assert.equal(proxyResult.backupState, 'created-and-read-back-verified');
	assert.equal(proxyResult.note, 'before route change');
	assert.equal(responses.createRequest.source, source);
	assert.equal(responses.createRequest.pcbUuid, 'pcb-a');
	assert.equal(responses.createRequest.note, 'before route change');
	assert.deepEqual(responses.readRequest, { backupId: 'project-a/checkpoint-1' });
	assert.ok(targetChecks >= 8, 'the captured document target is rechecked around host reads, backup creation, and backup readback');
	assert.equal(sourceReads, 1);
	assert.equal(proxyCreates, 1);
	assert.equal(proxyReads, 1);
	assert.equal(sourceWrites, 0, 'checkpoint does not modify PCB source');
	assert.equal(saves, 0, 'checkpoint does not save PCB');
	console.log('PASS source checkpoint uses proxy backup, target checks, exact readback, and no PCB write/save');

	resetCounters();
	setProxyPort(null);
	project = { ...project, data: [detachedPcb()] };
	const storageResult = await checkpoint({}, context);
	assert.equal(storageResult.backupId, 'storage:ai-command-engine:pcb-source-backup');
	assert.equal(storageResult.location, 'storage');
	assert.equal(storageResult.verified, true);
	assert.equal(storageWrites, 1);
	assert.equal(JSON.parse(storedConfig).source, source);
	assert.equal(JSON.parse(storedConfig).pcbUuid, 'pcb-a');
	assert.match(storageResult.backupNote[0], /单槽备份/);
	assert.equal(sourceWrites, 0);
	assert.equal(saves, 0);
	console.log('PASS source checkpoint supports a top-level detached PCB node and verifies the existing EDA storage slot by backup ID');

	resetCounters();
	setProxyPort(49721);
	project = { ...project, data: [{ ...detachedPcb(), parentProjectUuid: 'project-other' }] };
	await assert.rejects(checkpoint({}, context), /不属于当前工程/);
	assert.equal(sourceReads, 0);
	assert.equal(proxyCreates, 0, 'a same-UUID top-level PCB with another project owner is rejected');
	console.log('PASS top-level PCB support preserves parent project ownership checks');

	resetCounters();
	setProxyPort(49721);
	rejectTarget = true;
	await assert.rejects(checkpoint({}, context), /captured document target changed/);
	assert.equal(sourceReads, 0, 'a captured target mismatch blocks source access');
	assert.equal(proxyCreates, 0, 'a captured target mismatch blocks backup creation');
	assert.equal(storageWrites, 0);
	resetCounters();
	focus = { ...focus, uuid: 'pcb-other' };
	await assert.rejects(checkpoint({}, context), /焦点与检查点目标不符/);
	assert.equal(sourceReads, 0, 'a focused wrong PCB blocks source access');
	assert.equal(proxyCreates, 0);
	console.log('PASS wrong target is rejected before source read or backup write');

	resetCounters();
	setProxyPort(49721);
	responses.read = { ok: true, backupId: 'project-a/checkpoint-1', pcbUuid: 'pcb-a', source: `${source}\n` };
	await assert.rejects(checkpoint({}, context), (error) => {
		assert.equal(error.cause?.partial, true);
		assert.equal(error.cause?.retryable, false);
		assert.equal(error.cause?.phase, 'readback');
		assert.equal(error.cause?.backupState, 'uncertain');
		assert.equal(error.cause?.backupId, 'project-a/checkpoint-1');
		assert.equal(error.cause?.location, 'proxy');
		assert.match(error.message, /不会自动重试/);
		return true;
	});
	assert.equal(proxyCreates, 1, 'backup creation is issued once');
	assert.equal(proxyReads, 1, 'mismatched readback is not retried');
	assert.equal(sourceWrites, 0);
	assert.equal(saves, 0);
	console.log('PASS mismatched readback is reported as uncertain without an automatic retry');

	resetCounters();
	setProxyPort(49721);
	project = { ...project, uuid: 'project-other' };
	await assert.rejects(checkpoint({}, context), /当前工程与 PCB 目标不符/);
	assert.equal(sourceReads, 0);
	assert.equal(proxyCreates, 0);
	console.log('PASS project mismatch is rejected before source read or backup creation');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
