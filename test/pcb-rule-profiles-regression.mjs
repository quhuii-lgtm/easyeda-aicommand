import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `export { pcbRuleProfileCommands } from '../src/commands/pcbRuleProfiles.ts'; export { compareDocumentSources } from '../src/engine/documentRecovery.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-rule-profiles-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { pcbRuleProfileCommands, compareDocumentSources } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const commands = new Map(pcbRuleProfileCommands.map(item => [item.name, item.handler]))
const clone = value => JSON.parse(JSON.stringify(value))
const customRecord = (name, config) => ({ name, config: clone(config), libraryKind: 'user' })
const systemRecord = (name, table) => ({ name, systemTable: clone(table), libraryKind: 'system' })
const sourceConfig = { Physics: { Track: { unit: 'mil', preferred: 20 } }, Spacing: { Safe: 5 }, Opaque: { keep: [1, 'x'] } }
const sourceLog = (ticket, width = 12) => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0, id: 'head' })}||${JSON.stringify({ docType: 'PCB', uuid: 'pcb-1' })}|\n${JSON.stringify({ type: 'RULE', ticket, id: 'rules' })}||${JSON.stringify({ width })}|`

const state = {
	document: { documentType: 3, uuid: 'pcb-1', tabId: 'tab-1', parentProjectUuid: 'project-1' },
	currentName: '自定义配置3',
	currentConfiguration: { Track: { width: 12 }, untouched: { exact: true } },
	currentSource: sourceLog(1),
	defaultName: '系统默认',
	profiles: [
		systemRecord('系统默认', { Physics: { Track: { preferred: 10 } }, systemOnly: true }),
		customRecord('自定义配置3', { Track: { width: 12 }, untouched: { exact: true } }),
		customRecord('源模板', sourceConfig),
	],
	writes: [],
	fault: undefined,
	switched: false,
}
const all = () => clone(state.profiles)
const custom = () => clone(state.profiles.filter(item => item.libraryKind === 'user'))
const getter = name => {
	const profile = state.profiles.find(item => item.name === name)
	if (!profile) return undefined
	if (profile.libraryKind === 'user') return clone(profile)
	return { name: profile.name, config: { Physics: { Track: { preferred: 10 } }, systemOnly: true } }
}

globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => clone(state.document) },
	sys_FileManager: { getDocumentSource: async () => state.currentSource },
	pcb_Drc: {
		getAllRuleConfigurations: async includeSystem => includeSystem === false ? custom() : all(),
		getRuleConfiguration: async name => getter(name),
		getCurrentRuleConfiguration: async () => ({ name: state.currentName, config: clone(state.currentConfiguration) }),
		getCurrentRuleConfigurationName: async () => state.currentName,
		getDefaultRuleConfigurationName: async () => {
			if (state.fault === 'default-read-error') throw new Error('default getter unavailable')
			return state.defaultName
		},
		saveRuleConfiguration: async (configuration, name, allowOverwrite) => {
			state.writes.push({ operation: 'save', name, allowOverwrite })
			const actualName = state.fault === 'rewrite-name' ? `${name}_HOST` : name
			const value = ['readback-mismatch', 'readback-mismatch-false'].includes(state.fault) ? { ...clone(configuration), hostChanged: true } : clone(configuration)
			state.profiles = state.profiles.filter(item => item.name !== actualName)
			state.profiles.push(customRecord(actualName, value))
			if (state.fault === 'mutate-nontarget') {
				const untouched = state.profiles.find(item => item.name === '源模板')
				untouched.config.changedByHost = true
			}
			if (state.fault === 'mutate-default') state.defaultName = 'unexpected-default'
			if (state.fault === 'switch-tab') state.switched = true
			if (state.fault === 'ticket-only') state.currentSource = sourceLog(99)
			if (state.fault === 'mutate-board-geometry') state.currentSource = sourceLog(99, 13)
			if (state.fault === 'throw-after-save') throw new Error('host dropped response after saving')
			return state.fault === 'readback-mismatch-false' ? false : true
		},
		renameRuleConfiguration: async (oldName, newName) => {
			state.writes.push({ operation: 'rename', oldName, newName })
			const index = state.profiles.findIndex(item => item.name === oldName)
			if (index < 0) return false
			state.profiles[index] = { ...state.profiles[index], name: newName }
			return true
		},
		deleteRuleConfiguration: async name => {
			state.writes.push({ operation: 'delete', name })
			state.profiles = state.profiles.filter(item => item.name !== name)
			return true
		},
	},
}

const context = () => ({
	vars: {}, stopped: undefined,
	assertDocumentTarget: async () => { if (state.switched) throw new Error('document target changed') },
	stopSignal: {
		assertActive() { if (state.switched) throw new Error('stopped') },
		stop(reason) { state.stopped = reason },
	},
})
const call = (name, params = {}, ctx = context()) => commands.get(`pcb.${name}`)(params, ctx)
const countWrites = () => state.writes.length
const resetFault = () => { state.fault = undefined; state.switched = false; state.stopped = undefined; state.defaultName = '系统默认'; state.currentSource = sourceLog(1) }

const listedDefault = await call('listRuleConfigurations')
assert.equal(listedDefault.configurations.length, 3, 'listing defaults to system plus custom profiles')
assert.equal(listedDefault.customCount, 2)
assert.equal(listedDefault.systemCount, 1)
assert.equal((await call('listRuleConfigurations', { includeSystem: false })).configurations.length, 2)
assert.deepEqual((await call('getRuleConfiguration', { name: '源模板' })).configuration, custom().find(item => item.name === '源模板'))

const beforeDefaultPreviewWrites = countWrites()
const defaultPreview = await call('saveRuleConfiguration', { name: '新模板' })
assert.equal(defaultPreview.dryRun, true)
assert.equal(defaultPreview.status, 'preview')
assert.equal(defaultPreview.currentPcbChanged, false)
assert.equal(defaultPreview.globalDefaultChanged, false)
assert.equal(countWrites(), beforeDefaultPreviewWrites, 'save defaults to preview and sends no SDK write')
await assert.rejects(call('saveRuleConfiguration', { name: '新模板', config: { malicious: true }, dryRun: false }), /不接受任意规则JSON/)
assert.equal(countWrites(), beforeDefaultPreviewWrites, 'arbitrary raw JSON is not accepted as a rule source')

const originalProfiles = all()
const originalBoardSource = state.currentSource
const created = await call('saveRuleConfiguration', { name: '复制当前板', dryRun: false })
assert.equal(created.status, 'saved')
assert.equal(created.verified, true)
assert.deepEqual(created.configuration, state.currentConfiguration)
assert.equal(state.profiles.find(item => item.name === '复制当前板').config.Track.width, 12)
assert.equal(state.currentName, '自定义配置3')
assert.equal(state.defaultName, '系统默认')
assert.equal(state.currentSource, originalBoardSource)
for (const before of originalProfiles) assert.deepEqual(state.profiles.find(item => item.name === before.name), before, `non-target profile ${before.name} remains unchanged`)
assert.equal(state.writes.at(-1).allowOverwrite, false, 'new names do not silently enable overwrite')

const copyFromProfile = await call('saveRuleConfiguration', { name: '复制源模板', sourceName: '源模板', dryRun: false })
assert.deepEqual(copyFromProfile.configuration, sourceConfig, 'named profile copy preserves its exact rules table')
const systemCopy = await call('saveRuleConfiguration', { name: '系统方案副本', sourceName: '系统默认', dryRun: false })
assert.deepEqual(systemCopy.configuration, { Physics: { Track: { preferred: 10 } }, systemOnly: true }, 'copying a system source preserves its getter payload')
await assert.rejects(call('saveRuleConfiguration', { name: '源模板', dryRun: false }), /默认拒绝覆盖/)
await assert.rejects(call('saveRuleConfiguration', { name: '系统默认', allowOverwrite: true, dryRun: false }), /系统规则方案.*不可覆盖/)

const overwritePreviewWrites = countWrites()
const overwritePreview = await call('saveRuleConfiguration', { name: '复制当前板', sourceName: '源模板', allowOverwrite: true })
assert.equal(overwritePreview.action, 'overwrite')
assert.equal(countWrites(), overwritePreviewWrites)
const overwritten = await call('saveRuleConfiguration', { name: '复制当前板', sourceName: '源模板', allowOverwrite: true, dryRun: false })
assert.deepEqual(overwritten.configuration, sourceConfig)

const renameDryWrites = countWrites()
const renamePreview = await call('renameRuleConfiguration', { name: '复制源模板', newName: '复制源模板B' })
assert.equal(renamePreview.status, 'preview')
assert.equal(renamePreview.configuration.Physics.Track.preferred, 20)
assert.equal(countWrites(), renameDryWrites)
await assert.rejects(call('renameRuleConfiguration', { name: '复制源模板', newName: '源模板', dryRun: false }), /目标名称.*已存在/)
await assert.rejects(call('renameRuleConfiguration', { name: '系统默认', newName: '系统默认改名', dryRun: false }), /系统规则方案.*不可重命名/)
const renamed = await call('renameRuleConfiguration', { name: '复制源模板', newName: '复制源模板B', dryRun: false })
assert.equal(renamed.status, 'renamed')
assert.deepEqual(state.profiles.find(item => item.name === '复制源模板B').config, sourceConfig)

const deleteDryWrites = countWrites()
const deletePreview = await call('deleteRuleConfiguration', { name: '复制源模板B' })
assert.deepEqual(deletePreview.configuration, sourceConfig, 'delete preview shows full affected config')
assert.equal(deletePreview.isCurrentBoardConfiguration, false)
assert.equal(deletePreview.isGlobalDefault, false)
assert.equal(countWrites(), deleteDryWrites)
await assert.rejects(call('deleteRuleConfiguration', { name: '系统默认', dryRun: false }), /系统规则方案.*不可删除/)
const deleted = await call('deleteRuleConfiguration', { name: '复制源模板B', dryRun: false })
assert.equal(deleted.status, 'deleted')
assert.equal(state.profiles.some(item => item.name === '复制源模板B'), false)

resetFault(); state.fault = 'default-read-error'
const defaultUnverified = await call('saveRuleConfiguration', { name: '默认读取未知时仍可保存', dryRun: false })
assert.equal(defaultUnverified.verified, true, 'an unavailable default-name getter does not block template CRUD')
assert.equal(defaultUnverified.globalDefaultChanged, null)
assert.equal(defaultUnverified.globalDefaultVerification, 'unknown')

resetFault(); state.fault = 'ticket-only'
assert.equal(compareDocumentSources(sourceLog(1), sourceLog(99)).equal, true, 'known source ticket-only changes are normalized')
const ticketOnlySave = await call('saveRuleConfiguration', { name: '票据重序仍可保存', dryRun: false })
assert.equal(ticketOnlySave.verified, true, 'ticket-only source reserialization must not look like board geometry mutation')
resetFault()

for (const fault of ['readback-mismatch', 'readback-mismatch-false', 'rewrite-name', 'mutate-nontarget', 'mutate-default', 'mutate-board-geometry', 'throw-after-save']) {
	resetFault(); state.fault = fault
	const failedContext = context()
	await assert.rejects(call('saveRuleConfiguration', { name: `故障模板-${fault}`, dryRun: false }, failedContext), error => {
		assert.equal(error.cause.partial, true, `${fault} must report partial state`)
		assert.equal(error.cause.outcome, 'unknown')
		const sdkExpected = fault === 'throw-after-save' ? undefined : fault === 'readback-mismatch-false' ? false : true
		assert.equal(error.cause.sdkReturned, sdkExpected !== undefined, `${fault} must record whether SDK returned`)
		if (sdkExpected !== undefined) assert.equal(error.cause.sdkResult, sdkExpected, `${fault} must preserve the returned SDK value`)
		return true
	})
	assert.ok(state.stopped, `${fault} must stop dependent macro steps`)
}
resetFault(); state.fault = 'switch-tab'
const switchedContext = context()
await assert.rejects(call('saveRuleConfiguration', { name: '切页后未知', dryRun: false }, switchedContext), error => {
	assert.equal(error.cause.partial, true)
	assert.equal(error.cause.outcome, 'unknown')
	return true
})
assert.ok(state.stopped, 'a tab switch after write stops dependent steps')
resetFault()

console.log('PASS PCB rule-profile CRUD previews, exact copies, system protection, and write-outcome verification')
