import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const fixture = JSON.parse(await readFile(resolve(root, 'test/fixtures/pcb-save-fill-refs-real-sample.json'), 'utf8'));
	const built = await build({
		stdin: {
			contents: `export { pcbCommands } from '../src/commands/pcb.ts'`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'pcb-save-fill-refs-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { pcbCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const command = name => pcbCommands.find(item => item.name === name);
	const save = command('pcb.save').handler;
	const getRevision = command('pcb.getRevision').handler;

	function makeSource(fills, extraRecords = []) {
		return [
			'{"type":"DOCHEAD"}||{"docType":"PCB","client":"host","uuid":"ddb10f8eead3e93c","updateTime":1,"version":"1"}|',
			...fills.map(({ header, data }) => `${JSON.stringify(header)}||${JSON.stringify(data)}|`),
			...extraRecords.map(({ header, data }) => `${JSON.stringify(header)}||${JSON.stringify(data)}|`),
		].join('\n');
	}

	const sourceFrom = key => fixture.records[key].map(item => ({ header: item.header, data: structuredClone(item.data) }));
	const expectedFills = sourceFrom('before');
	const reopenedFills = sourceFrom('after');
	const baselineSource = makeSource(expectedFills);
	const reopenedSource = makeSource(reopenedFills);

	let source = baselineSource;
	let afterOpenSource;
	let opened = true;
	const saveAccepted = true;
	const target = {
		uuid: 'ddb10f8eead3e93c',
		documentType: 3,
		parentProjectUuid: 'project-placement',
		tabId: 'pcb-placement@project-placement',
	};
	globalThis.eda = {
		sys_Environment: { getEditorCurrentVersion: () => '4.1.99' },
		sys_FileManager: { getDocumentSource: async () => source },
		pcb_Drc: { getCurrentRuleConfiguration: async () => undefined },
		pcb_Document: { save: async () => saveAccepted },
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: target.parentProjectUuid, data: [{ uuid: target.uuid }] }) },
		dmt_EditorControl: {
			getSplitScreenTree: async () => ({ tabs: opened ? [{ tabId: target.tabId }] : [] }),
			closeDocument: async (tabId) => {
				assert.equal(tabId, target.tabId);
				opened = false;
				return true;
			},
			openDocument: async (uuid) => {
				assert.equal(uuid, target.uuid);
				opened = true;
				source = afterOpenSource ?? baselineSource;
				return target.tabId;
			},
			activateDocument: async () => true,
		},
	};
	const context = {
		documentTarget: target,
		assertDocumentTarget: async () => assert.equal(opened, true),
	};

	async function verify(reopened) {
		source = baselineSource;
		afterOpenSource = reopened;
		opened = true;
		const expectedDigest = (await getRevision({}, context)).digest;
		return save({ verifyReopen: true, expectedDigest }, context);
	}

	const verified = await verify(reopenedSource);
	assert.equal(verified.persistenceVerified, true, 'real host FILL refs [null] → null roundtrip is accepted');
	assert.equal(verified.comparison.equal, true);
	assert.equal(verified.comparison.originalRecordsDiffer, true);
	assert.match(verified.comparison.rawDifference, /FILL|record/);
	assert.deepEqual(verified.comparison.normalizationDetails.map(item => item.recordId).sort(), ['7227b213a3c2e5d3', 'dadb2652b6f492e3']);
	assert.ok(verified.comparison.normalizationDetails.every(item => item.recordType === 'FILL' && /refs \[null\] as null/.test(item.reason)));

	const actualPadReference = sourceFrom('after');
	actualPadReference[0].data.refs = ['pad-actual-reference'];
	await assert.rejects(verify(makeSource(actualPadReference)), (error) => {
		assert.equal(error.cause.phase, 'compare');
		assert.equal(error.cause.phases.comparison.equal, false);
		return /不一致/.test(error.message);
	}, 'a real pad ID lost to null is not normalized');

	const changedPathAndOtherObject = sourceFrom('after');
	changedPathAndOtherObject[0].data.path[0][1] += 1;
	const ellipse = { header: { type: 'ELLIPSE', ticket: 200, id: 'ellipse-unchanged' }, data: { x: 20, y: 30, radius: 7 } };
	await assert.rejects(verify(makeSource(changedPathAndOtherObject, [ellipse])), (error) => {
		assert.equal(error.cause.phase, 'compare');
		assert.equal(error.cause.phases.comparison.equal, false);
		return /不一致/.test(error.message);
	}, 'a path change and an unrelated ellipse rollback remain failures even when another FILL qualifies');

	console.log('PASS: save/reopen narrowly accepts only the two evidenced named SOLID FILL refs conversions and rejects actual reference/path/object changes');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
