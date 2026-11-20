import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

let state;
let pcbPadPairCommands;
let executeCommand;
let registerCommand;
const rows = () => structuredClone(state.groups);

function install(options = {}) {
	state = {
		groups: structuredClone(options.groups ?? [{ name: 'KEEP', padPairs: [['R1:1', 'R2:1']] }]),
		calls: [],
		readCount: 0,
		focus: 'pcb-A',
	};
	const call = async (name, action) => {
		state.calls.push(name);
		if (options.throwOn === name)
			throw new Error(`${name} failed`);
		if (options.mutateOtherOn === name) {
			state.groups.find(group => group.name === 'KEEP').padPairs.push(['R3:1', 'R4:1']);
		}
		if (options.returnFalse === name)
			return false;
		if (options.noMutation === name)
			return true;
		const result = action();
		if (options.reorderGroupsAfterRename === name)
			state.groups.reverse();
		if (options.switchFocusOn === name)
			state.focus = 'pcb-B';
		return options.returnFalseAfterMutation === name ? false : (options.returnFalse === name ? false : result);
	};
	const sdk = {
		pcb_Drc: {
			getAllPadPairGroups: async () => {
				state.calls.push('getAllPadPairGroups');
				state.readCount++;
				if (options.driftBeforeWrite && state.readCount === 2)
					state.groups.push({ name: 'EXTERNAL', padPairs: [['A:1', 'B:1']] });
				if (options.reorderBeforeWrite && state.readCount === 2)
					state.groups.reverse();
				return rows();
			},
			createPadPairGroup: (name, pairs) => call('createPadPairGroup', () => {
				state.groups.push({ name, padPairs: structuredClone(pairs) });
				return true;
			}),
			modifyPadPairGroupName: (oldName, newName) => call('modifyPadPairGroupName', () => {
				state.groups.find(group => group.name === oldName).name = newName;
				if (options.reorderMembersOnRename)
					state.groups.find(group => group.name === newName).padPairs.reverse();
				return true;
			}),
			deletePadPairGroup: name => call('deletePadPairGroup', () => {
				state.groups = state.groups.filter(group => group.name !== name);
				return true;
			}),
			addPadPairToPadPairGroup: (name, pairs) => call('addPadPairToPadPairGroup', () => {
				state.groups.find(group => group.name === name).padPairs.push(...structuredClone(pairs));
				return true;
			}),
			removePadPairFromPadPairGroup: (name, pairs) => call('removePadPairFromPadPairGroup', () => {
				const keys = new Set(pairs.map(pair => JSON.stringify(pair)));
				state.groups.find(group => group.name === name).padPairs = state.groups.find(group => group.name === name).padPairs.filter(pair => !keys.has(JSON.stringify(pair)));
				return true;
			}),
			getPadPairGroupMinWireLength: async () => [{ padPair: ['C6:1', 'C7:1'], minWireLength: 10.25 }],
		},
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: state.focus, parentProjectUuid: 'project-A', tabId: `${state.focus}@project-A` }) },
		sys_FileManager: { getDocumentSource: async () => '{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"pcb-A"}|' },
	};
	globalThis.eda = sdk;
	return state;
}

const command = name => pcbPadPairCommands.find(item => item.name === name);
const params = extra => ({ __docUuid: 'pcb-A', __projectUuid: 'project-A', ...extra });
const checks = [];
async function test(name, fn) {
	await fn();
	checks.push(name);
	console.log(`PASS ${name}`);
}

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `export { pcbPadPairCommands } from '../src/commands/pcbPadPairs.ts'; export { executeCommand, registerCommand } from '../src/engine/registry.ts'`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'pcb-pad-pairs-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	({ pcbPadPairCommands, executeCommand, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`));
	await test('registers all seven pad-pair group commands', () => {
		assert.deepEqual(pcbPadPairCommands.map(item => item.name), [
			'pcb.listPadPairGroups',
			'pcb.createPadPairGroup',
			'pcb.renamePadPairGroup',
			'pcb.deletePadPairGroup',
			'pcb.addPadsToPadPairGroup',
			'pcb.removePadsFromPadPairGroup',
			'pcb.getPadPairGroupMinWireLengths',
		]);
	});

	await test('list returns complete raw groups for the target PCB', async () => {
		install();
		const result = await command('pcb.listPadPairGroups').handler(params({}));
		assert.equal(result.complete, true);
		assert.equal(result.documentUuid, 'pcb-A');
		assert.deepEqual(result.groups, [{ name: 'KEEP', padPairs: [['R1:1', 'R2:1']] }]);
	});

	await test('create, rename, add, remove and delete read back each target and preserve other groups', async () => {
		install();
		let result = await command('pcb.createPadPairGroup').handler(params({ name: 'C6-C7', pairs: [['C6:1', 'C7:1']] }));
		assert.equal(result.sdkResult, true);
		assert.equal(result.verified, true);
		assert.equal(result.changed, true);
		assert.deepEqual(result.groups.find(group => group.name === 'C6-C7').padPairs, [['C6:1', 'C7:1']]);
		result = await command('pcb.renamePadPairGroup').handler(params({ oldName: 'C6-C7', newName: 'CAP_PAIR' }));
		assert.equal(result.verified, true);
		assert.deepEqual(result.groups[1], { name: 'CAP_PAIR', padPairs: [['C6:1', 'C7:1']] });
		result = await command('pcb.addPadsToPadPairGroup').handler(params({ name: 'CAP_PAIR', pairs: [['C8:1', 'C9:1']] }));
		assert.equal(result.verified, true);
		assert.equal(result.groups[1].padPairs.length, 2);
		result = await command('pcb.removePadsFromPadPairGroup').handler(params({ name: 'CAP_PAIR', pairs: [['C8:1', 'C9:1']] }));
		assert.equal(result.verified, true);
		assert.deepEqual(result.groups[1].padPairs, [['C6:1', 'C7:1']]);
		result = await command('pcb.deletePadPairGroup').handler(params({ name: 'CAP_PAIR' }));
		assert.equal(result.verified, true);
		assert.equal(result.groups.some(group => group.name === 'CAP_PAIR'), false);
		assert.deepEqual(result.groups, [{ name: 'KEEP', padPairs: [['R1:1', 'R2:1']] }]);
	});

	await test('rename verifies groups by unique name across host reordering and returns host order unchanged', async () => {
		const f = install({
			groups: [
				{ name: 'ACE_PAIR_MANAGE', padPairs: [['C6:1', 'C7:1']] },
				{ name: 'ACE_PAIR_SAVED', padPairs: [['R1:1', 'R2:1']] },
			],
			reorderGroupsAfterRename: 'modifyPadPairGroupName',
		});
		const result = await command('pcb.renamePadPairGroup').handler(params({ oldName: 'ACE_PAIR_MANAGE', newName: 'ACE_PAIR_RENAMED_ONLY' }));
		assert.equal(result.sdkResult, true);
		assert.equal(result.verified, true);
		assert.deepEqual(result.groups.map(group => group.name), ['ACE_PAIR_SAVED', 'ACE_PAIR_RENAMED_ONLY']);
		assert.deepEqual(result.groups[1].padPairs, [['C6:1', 'C7:1']]);
		assert.deepEqual(f.groups.map(group => group.name), result.groups.map(group => group.name), 'return order must remain the actual SDK order');
	});

	await test('member order remains strict when comparing a reordered group', async () => {
		install({
			groups: [
				{ name: 'MANAGE', padPairs: [['C6:1', 'C7:1'], ['C8:1', 'C9:1']] },
				{ name: 'SAVED', padPairs: [['R1:1', 'R2:1']] },
			],
			reorderMembersOnRename: true,
		});
		await assert.rejects(() => command('pcb.renamePadPairGroup').handler(params({ oldName: 'MANAGE', newName: 'RENAMED' })), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
	});

	await test('duplicate add and no-member remove perform zero writes', async () => {
		const f = install({ groups: [{ name: 'G', padPairs: [['C6:1', 'C7:1']] }] });
		const before = f.calls.filter(name => name === 'addPadPairToPadPairGroup').length;
		const result = await command('pcb.addPadsToPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] }));
		assert.equal(result.sdkResult, null);
		assert.equal(result.verified, true);
		assert.equal(result.changed, false);
		assert.equal(f.calls.filter(name => name === 'addPadPairToPadPairGroup').length, before);
		const removed = await command('pcb.removePadsFromPadPairGroup').handler(params({ name: 'G', pairs: [['X:1', 'Y:1']] }));
		assert.equal(removed.sdkResult, null);
		assert.equal(removed.changed, false);
		assert.equal(f.calls.filter(name => name === 'removePadPairFromPadPairGroup').length, 0);
	});

	await test('SDK false is not treated as success unless full readback verifies the requested state', async () => {
		install({ returnFalseAfterMutation: 'createPadPairGroup' });
		const applied = await command('pcb.createPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] }));
		assert.equal(applied.sdkResult, false);
		assert.equal(applied.verified, true);
		install({ returnFalse: 'createPadPairGroup' });
		await assert.rejects(() => command('pcb.createPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] })), (error) => {
			assert.equal(error.cause.partial, false);
			assert.equal(error.cause.retryable, false);
			assert.equal(error.cause.source, 'pad-pair-operation-not-applied');
			return true;
		});
	});

	await test('confirmed non-application fails the command and stops a macro before its next write', async () => {
		for (const definition of pcbPadPairCommands)
			registerCommand(definition);
		const f = install({ returnFalse: 'createPadPairGroup' });
		const result = await executeCommand({ cmd: 'macro', params: { steps: [
			{ cmd: 'pcb.createPadPairGroup', params: params({ name: 'G', pairs: [['C6:1', 'C7:1']] }) },
			{ cmd: 'pcb.createPadPairGroup', params: params({ name: 'NEXT', pairs: [['C8:1', 'C9:1']] }) },
		] } });
		assert.equal(result.ok, false);
		assert.equal(f.calls.filter(name => name === 'createPadPairGroup').length, 1, 'the second macro step must not run');
		assert.equal(state.groups.some(group => group.name === 'NEXT'), false);
	});

	await test('rename/create conflicts, invalid pairs and unknown arguments reject before writes', async () => {
		const cases = [
			['pcb.createPadPairGroup', { name: 'KEEP', pairs: [['C6:1', 'C7:1']] }],
			['pcb.renamePadPairGroup', { oldName: 'KEEP', newName: 'KEEP', extra: true }],
			['pcb.createPadPairGroup', { name: 'G', pairs: [['C6:1', 'C6:1']] }],
			['pcb.createPadPairGroup', { name: 'G', pairs: [['C6:1', 'C7:1'], ['C6:1', 'C7:1']] }],
			['pcb.createPadPairGroup', { name: 'G', pairs: [['C6:1']] }],
		];
		for (const [name, input] of cases) {
			const f = install();
			await assert.rejects(() => command(name).handler(params(input)));
			assert.equal(f.calls.some(callName => !['getAllPadPairGroups'].includes(callName)), false);
		}
	});

	await test('pre-write group drift stops without calling a mutator', async () => {
		const f = install({ driftBeforeWrite: true });
		await assert.rejects(() => command('pcb.createPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] })), /写入前发生变化/);
		assert.equal(f.calls.includes('createPadPairGroup'), false);
	});

	await test('non-target group changes and unexpected partial mutations become non-retryable partial failures', async () => {
		const f = install({ mutateOtherOn: 'createPadPairGroup' });
		await assert.rejects(() => command('pcb.createPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] })), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(f.calls.filter(name => name === 'createPadPairGroup').length, 1);
		const partial = install({ noMutation: 'createPadPairGroup' });
		await assert.rejects(() => command('pcb.createPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] })), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(partial.calls.filter(name => name === 'createPadPairGroup').length, 1);
	});

	await test('target switch after write prevents later readback and another write', async () => {
		const f = install({ switchFocusOn: 'createPadPairGroup' });
		await assert.rejects(() => command('pcb.createPadPairGroup').handler(params({ name: 'G', pairs: [['C6:1', 'C7:1']] })), (error) => {
			assert.equal(error.cause.partial, true);
			assert.equal(error.cause.retryable, false);
			return true;
		});
		assert.equal(f.calls.filter(name => name === 'createPadPairGroup').length, 1);
		assert.equal(f.calls.filter(name => name === 'getAllPadPairGroups').length, 2, 'pre-read and immediate pre-write read only');
	});

	await test('minimum length returns raw host value and leaves unit unknown', async () => {
		install({ groups: [{ name: 'G', padPairs: [['C6:1', 'C7:1']] }] });
		const result = await command('pcb.getPadPairGroupMinWireLengths').handler(params({ name: 'G' }));
		assert.deepEqual(result.reportedValues, [{ padPair: ['C6:1', 'C7:1'], minWireLength: 10.25 }]);
		assert.equal(result.unit, 'unknown');
	});

	console.log(`\n${checks.length} PCB pad-pair regression tests passed.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
