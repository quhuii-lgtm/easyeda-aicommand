import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const bundle = 'test/.pcb-source-rollback-regression.mjs'
try {
	await build({
		stdin: {
			contents: `import { rollbackPcbSource } from '../src/pcb/sourceRollback.ts'; import { pcbGroupingCommands } from '../src/commands/pcbGrouping.ts'; import { registerCommand, executeCommand } from '../src/engine/registry.ts'; export { rollbackPcbSource, pcbGroupingCommands, registerCommand, executeCommand }`,
			resolveDir: resolve('test'),
			sourcefile: 'pcb-source-rollback-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: true,
		outfile: bundle,
		target: 'node24',
	})
	const { rollbackPcbSource, pcbGroupingCommands, registerCommand, executeCommand } = await import(pathToFileURL(resolve(bundle)).href)
	const source = (records, uuid = 'pcb-a') => [
		`${JSON.stringify({ type: 'DOCHEAD', ticket: 0, id: 'head' })}||${JSON.stringify({ docType: 'PCB', uuid })}|`,
		...records.map(([type, id, data], index) => `${JSON.stringify({ type, id, ticket: index + 1 })}||${JSON.stringify(data)}|`),
	].join('\n')
	const backupSource = source([
		['COMPONENT', 'comp-1', { x: 10, y: 20, angle: 0 }],
		['ATTR', 'attr-1', { parentId: 'comp-1', key: 'Designator', value: 'U1' }],
		['NET', 'net-1', { name: 'GND', net: 'GND' }],
		['PAD_NET', 'padnet-1', { parentId: 'comp-1', pad: '1', net: 'GND' }],
		['RULE', 'rule-1', { name: 'Clearance', value: 8 }],
		['RULE_SELECTOR', 'rule-selector-1', { ruleOrder: 1, ruleKeyValue: { width: 8 } }],
		['LAYER', 'layer-1', { name: 'TopLayer', layerId: 1 }],
	])
	const changedNetworkSource = source([
		['COMPONENT', 'comp-1', { x: 10, y: 20, angle: 0 }],
		['ATTR', 'attr-1', { parentId: 'comp-1', key: 'Designator', value: 'U1' }],
		['NET', 'net-1', { name: 'GND', net: 'POWER' }],
		['PAD_NET', 'padnet-1', { parentId: 'comp-1', pad: '1', net: 'POWER' }],
		['RULE', 'rule-1', { name: 'Clearance', value: 8 }],
		['RULE_SELECTOR', 'rule-selector-1', { ruleOrder: 1, ruleKeyValue: { width: 8 } }],
		['LAYER', 'layer-1', { name: 'TopLayer', layerId: 1 }],
	])
	const changedRuleSource = source([
		['COMPONENT', 'comp-1', { x: 10, y: 20, angle: 0 }],
		['ATTR', 'attr-1', { parentId: 'comp-1', key: 'Designator', value: 'U1' }],
		['NET', 'net-1', { name: 'GND', net: 'GND' }],
		['PAD_NET', 'padnet-1', { parentId: 'comp-1', pad: '1', net: 'GND' }],
		['RULE', 'rule-1', { name: 'Clearance', value: 12 }],
		['RULE_SELECTOR', 'rule-selector-1', { ruleOrder: 1, ruleKeyValue: { width: 8 } }],
		['LAYER', 'layer-1', { name: 'TopLayer', layerId: 1 }],
	])
	const backup = { backupId: 'fixture/backup', pcbUuid: 'pcb-a', source: backupSource }
	const createApi = (options = {}) => {
		let currentSource = options.initialSource ?? changedNetworkSource
		let tabPresent = true
		const calls = { assert: 0, writes: 0, saves: 0, closes: 0, opens: 0, activates: 0 }
		return {
			calls,
			api: {
				assertTarget: async () => { calls.assert++ },
				readSource: async () => currentSource,
				writeSource: async value => {
					calls.writes++
					if (options.writeBehavior === 'throw-after-effect') { currentSource = value; throw new Error('synthetic post-effect error') }
					if (options.writeBehavior === 'false-after-effect') { currentSource = value; return false }
					if (options.writeBehavior === 'false-no-effect') return false
					currentSource = value
					return true
				},
				save: async () => { calls.saves++; return options.saveResult ?? true },
				getTabs: async () => ({ tabs: tabPresent ? [{ tabId: 'pcb-a@project-a' }] : [] }),
				closeDocument: async tabId => {
					calls.closes++
					assert.equal(tabId, 'pcb-a@project-a')
					if (options.closeError) throw new Error('synthetic close failure')
					if (!options.closeStaysOpen) tabPresent = false
					return true
				},
				openDocument: async uuid => { calls.opens++; assert.equal(uuid, 'pcb-a'); if (options.openError) throw new Error('synthetic open failure'); tabPresent = true; if (options.reopenSource !== undefined) currentSource = options.reopenSource; return { tabId: 'pcb-a@project-a' } },
				activateDocument: async tabId => { calls.activates++; assert.equal(tabId, 'pcb-a@project-a'); return true },
			},
			get source() { return currentSource },
		}
	}
	const run = (state, props = {}) => rollbackPcbSource(backup, 'pcb-a', 'pcb-a@project-a', true, { ...state.api, ...props })

	for (const writeBehavior of ['success', 'false-after-effect', 'throw-after-effect']) {
		const state = createApi({ writeBehavior })
		const result = await run(state)
		assert.equal(result.restored, true, `${writeBehavior} has verified content`)
		assert.equal(result.contentVerified, true)
		assert.equal(result.saved, true)
		assert.equal(result.persistenceVerified, true)
		assert.equal(state.source, backupSource)
		assert.equal(result.phases.write, writeBehavior === 'success' ? 'acknowledged-and-verified' : 'sdk-nontrue-or-threw-but-readback-verified')
	}
	console.log('PASS source rollback accepts false/throw only when full PCB source readback proves the write')

	{
		const state = createApi({ writeBehavior: 'false-no-effect' })
		await assert.rejects(run(state), error => {
			assert.equal(error.cause?.partial, true)
			assert.equal(error.cause?.phase, 'readback-source')
			return true
		})
		assert.equal(state.calls.writes, 1)
		assert.equal(state.calls.saves, 0)
		assert.equal(state.calls.closes, 0)
	}
	console.log('PASS unverified write stops before save, close, or reopen')

	{
		const state = createApi()
		let reads = 0
		const api = { ...state.api, readSource: async () => { if (++reads === 2) throw new Error('synthetic post-write read failure'); return changedNetworkSource } }
		await assert.rejects(() => rollbackPcbSource(backup, 'pcb-a', 'pcb-a@project-a', true, api), error => {
			assert.equal(error.cause?.partial, true)
			assert.equal(error.cause?.phase, 'readback-source')
			return true
		})
		assert.equal(state.calls.writes, 1)
		assert.equal(state.calls.saves, 0, 'unknown post-write readback blocks save')
		assert.equal(state.calls.closes, 0, 'unknown post-write readback keeps the page open')
	}
	console.log('PASS unknown post-write readback is partial and prevents dependent save/close')

	{
		const state = createApi({ initialSource: backupSource })
		const result = await run(state)
		assert.equal(result.phases.write, 'skipped-already-equal')
		assert.equal(state.calls.writes, 0, 'repeat restore of already-equal content performs no source write')
		assert.equal(result.persistenceVerified, true)
	}
	console.log('PASS repeated rollback skips setDocumentSource when content already matches')

	{
		const state = createApi({ saveResult: false })
		const result = await run(state)
		assert.equal(result.contentVerified, true)
		assert.equal(result.saved, false)
		assert.equal(result.saveAcknowledged, false)
		assert.equal(result.persistenceVerified, false)
		assert.equal(state.calls.closes, 0, 'save false must not close a changed document')
	}
	console.log('PASS save false remains unacknowledged and keeps the document open')

	for (const scenario of [
		{ name: 'close error', options: { closeError: true }, phase: 'close-document', open: 0 },
		{ name: 'close not observed', options: { closeStaysOpen: true }, phase: 'read-tabs-after-close', open: 0 },
		{ name: 'open error', options: { openError: true }, phase: 'open-document', open: 1 },
		{ name: 'persistent source changed', options: { reopenSource: changedRuleSource }, phase: 'read-persisted-source', open: 1 },
	]) {
		const state = createApi(scenario.options)
		await assert.rejects(run(state), error => {
			assert.equal(error.cause?.partial, true, scenario.name)
			assert.equal(error.cause?.phase, scenario.phase)
			return true
		})
		assert.equal(state.calls.opens, scenario.open, scenario.name)
	}
	console.log('PASS close/open/reopen persistence failures retain phase-specific partial state')

	{
		const state = createApi()
		await assert.rejects(() => rollbackPcbSource({ ...backup, pcbUuid: 'other-pcb' }, 'pcb-a', 'pcb-a@project-a', true, state.api), /metadata pcbUuid/)
		assert.equal(state.calls.writes, 0, 'metadata conflict is rejected before source writes')
		await assert.rejects(() => rollbackPcbSource({ ...backup, source: source([], 'other-pcb') }, 'pcb-a', 'pcb-a@project-a', true, state.api), /不是目标 PCB/)
		assert.equal(state.calls.writes, 0, 'source identity mismatch is rejected before source writes')
		await assert.rejects(() => rollbackPcbSource(backup, 'pcb-a', 'pcb-a@project-a', true, { ...state.api, readSource: async () => source([], 'other-pcb') }), /当前源码身份不符/)
		assert.equal(state.calls.writes, 0, 'focused PCB/source UUID mismatch is rejected before source writes')
	}
	console.log('PASS backup metadata/source and current document identity conflicts are rejected before writes')

	{
		const state = createApi()
		const handler = pcbGroupingCommands.find(command => command.name === 'pcb.sourceRollback').handler
		let sourceReads = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-other', tabId: 'pcb-a@project-other' }) },
			sys_FileManager: { getDocumentSource: async () => { sourceReads++; return changedNetworkSource }, setDocumentSource: async () => { state.calls.writes++; return true } },
			pcb_Document: { save: async () => true },
			dmt_EditorControl: {},
		}
		await assert.rejects(() => handler({ backupId: 'unused' }, { assertDocumentTarget: async () => { throw new Error('project/document target mismatch') } }), /project\/document target mismatch/)
		assert.equal(sourceReads, 0, 'target mismatch blocks source read before any write')
		assert.equal(state.calls.writes, 0, 'wrong target project/page blocks all writes')
	}
	console.log('PASS target project/page mismatch stops before source access or write')

	{
		const state = createApi()
		const handler = pcbGroupingCommands.find(command => command.name === 'pcb.sourceRollback').handler
		let sourceReads = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: 'pcb-a@project-a' }) },
			dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'project-a' }) },
			sys_FileManager: { getDocumentSource: async () => { sourceReads++; return changedNetworkSource }, setDocumentSource: async () => { state.calls.writes++; return true } },
			sys_Storage: { getExtensionUserConfig: async () => JSON.stringify({ pcbUuid: 'pcb-other', source: backupSource }) },
			pcb_Document: { save: async () => true },
			dmt_EditorControl: {},
		}
		await assert.rejects(() => handler({ backupId: 'storage:ai-command-engine:pcb-source-backup' }, { assertDocumentTarget: async () => {} }), /metadata pcbUuid/)
		assert.equal(sourceReads, 1, 'one current-document identity read occurs before backup validation')
		assert.equal(state.calls.writes, 0, 'conflicting project/document backup metadata blocks write')
	}
	console.log('PASS sourceRollback rejects conflicting backup metadata before setDocumentSource')

	{
		const state = createApi()
		let followupWrites = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: 'pcb-a@project-a' }) },
			dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: 'project-a' }) },
			sys_FileManager: {
				getDocumentSource: async () => state.source,
				setDocumentSource: async () => { state.calls.writes++; return false },
			},
			pcb_Document: { save: async () => { state.calls.saves++; return true } },
			sys_Storage: { getExtensionUserConfig: async () => JSON.stringify({ pcbUuid: 'pcb-a', source: backupSource, createdAt: 'fixture' }) },
			dmt_EditorControl: {},
		}
		registerCommand(pcbGroupingCommands.find(command => command.name === 'pcb.sourceRollback'))
		registerCommand({ name: 'test.sourceRollback.followup', summary: 'test', params: [], returns: 'test', handler: async () => { followupWrites++; return true } })
		const macro = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'pcb.sourceRollback', params: { backupId: 'storage:ai-command-engine:pcb-source-backup' } },
			{ cmd: 'test.sourceRollback.followup' },
		] } })
		assert.equal(macro.ok, false)
		assert.equal(macro.error?.cause?.partial, true)
		assert.equal(macro.data?.stoppedReason, 'partial')
		assert.equal(followupWrites, 0, 'stopOnError=false cannot continue after unknown rollback write')
	}
	console.log('PASS registry macro stops after an unknown rollback write even with stopOnError=false')

	for (const scenario of [
		{ name: 'reopened source read throws', readFailure: true },
		{ name: 'project guard changes after close', projectChangeAfterClose: true },
	]) {
		let sourceReads = 0
		let projectReads = 0
		let active = true
		let currentSource = changedNetworkSource
		let followupWrites = 0
		let opens = 0
		let closes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => active
				? ({ documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: 'pcb-a@project-a' })
				: ({ documentType: 3, uuid: 'other-pcb', parentProjectUuid: 'project-a', tabId: 'other-pcb@project-a' }) },
			dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: scenario.projectChangeAfterClose && ++projectReads >= 2 ? 'project-other' : 'project-a' }) },
			sys_FileManager: {
				getDocumentSource: async () => {
					sourceReads++
					if (scenario.readFailure && sourceReads === 4) throw new Error('synthetic reopened-source failure')
					return currentSource
				},
				setDocumentSource: async value => { currentSource = value; return true },
			},
			pcb_Document: { save: async () => true },
			sys_Storage: { getExtensionUserConfig: async () => JSON.stringify({ pcbUuid: 'pcb-a', source: backupSource }) },
			dmt_EditorControl: {
				getSplitScreenTree: async () => ({ tabs: active ? [{ tabId: 'pcb-a@project-a' }] : [] }),
				closeDocument: async () => { closes++; active = false; return true },
				openDocument: async () => { opens++; active = true; return 'pcb-a@project-a' },
				activateDocument: async () => true,
			},
		}
		registerCommand({ name: 'test.sourceRollback.failureFollowup', summary: 'test', params: [], returns: 'test', handler: async () => { followupWrites++; return true } })
		const macro = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'pcb.sourceRollback', params: { backupId: 'storage:ai-command-engine:pcb-source-backup' } },
			{ cmd: 'test.sourceRollback.failureFollowup' },
		] } })
		assert.equal(macro.ok, false, scenario.name)
		assert.equal(macro.error?.cause?.partial, true, scenario.name)
		assert.equal(macro.data?.stoppedReason, 'partial', scenario.name)
		assert.equal(followupWrites, 0, `${scenario.name} stops dependent macro step`)
		if (scenario.readFailure) {
			assert.equal(closes, 1)
			assert.equal(opens, 1)
		}
		else {
			assert.equal(closes, 1)
			assert.equal(opens, 0, 'project mismatch after close prevents opening into another project')
		}
	}
	console.log('PASS real sourceRollback macro preserves partial state after reopen-read and post-close project-guard failures')
}
finally {
	try { await (await import('node:fs/promises')).rm(bundle, { force: true }) }
	catch { /* Preserve the primary test failure. */ }
}
