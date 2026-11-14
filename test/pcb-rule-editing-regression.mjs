import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const fixturePath = new URL('./fixtures/pcb-design-rules-4199.json', import.meta.url)
const fixtureBytes = await readFile(fixturePath)
const fixture = JSON.parse(fixtureBytes.toString('utf8'))
const manifest = JSON.parse(await readFile(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'))
const fixtureEntry = manifest.entries.find(entry => entry.fixture === 'pcb-design-rules-4199.json')
assert.ok(fixtureEntry, 'captured live getter sample is registered in fixture manifest')
const fixtureHash = createHash('sha256').update(fixtureBytes).digest('hex')
assert.equal(fixtureHash, fixtureEntry.fixtureSha256, 'fixture hash matches manifest')
assert.equal(fixtureBytes.length, fixtureEntry.bytes, 'fixture byte count matches manifest')

const temp = await mkdtemp(join(tmpdir(), 'ace-pcb-rule-editing-'))
try {
	const bundle = await build({
		entryPoints: [fileURLToPath(new URL('../src/commands/pcbRules.ts', import.meta.url))],
		bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false,
	})
	const registryBundle = await build({
		entryPoints: [fileURLToPath(new URL('../src/engine/registry.ts', import.meta.url))],
		bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false,
	})
	const modulePath = join(temp, 'pcbRules.mjs')
	await writeFile(modulePath, bundle.outputFiles[0].contents)
	const { pcbRuleCommands } = await import(pathToFileURL(modulePath))
	const registryPath = join(temp, 'registry.mjs')
	await writeFile(registryPath, registryBundle.outputFiles[0].contents)
	const registry = await import(pathToFileURL(registryPath))
	const get = pcbRuleCommands.find(command => command.name === 'pcb.getDesignRules').handler
	const update = pcbRuleCommands.find(command => command.name === 'pcb.updateDesignRules').handler
	const clone = value => structuredClone(value)
	const reset = () => ({
		document: clone(fixture.document), configuration: clone(fixture.configuration), netRules: clone(fixture.netRules),
		writes: { configuration: 0, netRules: 0 }, reads: { configuration: 0, netRules: 0 },
		writeBehavior: { configuration: 'apply-true', netRules: 'apply-true' },
		configurationSetterInputs: [], readFailure: null, onNetRead: null, onConfigurationRead: null,
		configurationName: fixture.configuration.name, quantizePaths: [], driftSpacing: false, driftSpacingAfterWrite: false,
	})
	let state = reset()
	const toMil = (value, unit) => Math.round(value * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4
	const makeSource = () => {
		const rows = []
		const add = (type, id, data) => rows.push(`${JSON.stringify({ type, id, ticket: rows.length })}||${JSON.stringify(data)}|`)
		add('DOCHEAD', undefined, { docType: 'PCB', uuid: fixture.document.uuid })
		add('RULE_TEMPLATE', 'RULE_TEMPLATE', { name: state.configuration.name })
		for (const [name, rule] of Object.entries(state.configuration.config.Physics.Track)) {
			const content = Object.entries(rule.form.data).map(([layerId, values]) => ({ layerId: Number(layerId), stroMin: toMil(values.minValue, rule.unit), stroDef: toMil(values.defaultValue, rule.unit), stroMax: toMil(values.maxValue, rule.unit) }))
			add('RULE', JSON.stringify(['RULE', 'TRACK', name]), { ruleState: 'NORMAL', ruleContext: { unit: rule.unit, track: { isOpen: true, content } } })
		}
		for (const [name, rule] of Object.entries(state.configuration.config.Spacing['Safe Spacing']))
			add('RULE', JSON.stringify(['RULE', 'SAFE', name]), { ruleState: 'NORMAL', ruleContext: { unit: rule.unit, safeSpacing: [{ layerId: 1, content: clone(rule.tables['1'].content) }] } })
		for (const [name, rule] of Object.entries(state.configuration.config.Spacing['Other Spacing']))
			add('RULE', JSON.stringify(['RULE', 'OTHER', name]), { ruleState: 'NORMAL', ruleContext: { unit: rule.unit, otherSpacing: clone(rule.form) } })
		const emitRuleSelectors = rules => {
			for (const rule of rules) {
				const scope = rule.type === 'netClass' ? 'NET_CLASS' : rule.type === 'net' ? 'NET' : undefined
				if (scope) {
					const ruleKeyValue = rule.Track && rule.Track !== 'default' ? { TRACK: rule.Track } : {}
					add('RULE_SELECTOR', JSON.stringify(['RULE_SELECTOR', [scope, rule.name]]), { ruleOrder: 4, ruleKeyValue, copperValue: {}, innerPlaneValue: {}, parent: null })
				}
				if (Array.isArray(rule.sub)) emitRuleSelectors(rule.sub)
			}
		}
		emitRuleSelectors(state.netRules)
		return rows.join('\n')
	}
	const canonicalNetRules = () => {
		const base = clone(fixture.netRules)
		const brake1 = base.find(row => row.name === 'B_BRAKE1_PWM')
		const brake2 = base.find(row => row.name === 'B_BRAKE2_PWM')
		return [
			{ type: 'netClass', name: 'Brake Class', Track: 'default', customMetadata: { keep: true }, sub: [brake1, brake2] },
			{ type: 'netClass', name: 'Other Class', Track: 'default', sub: [base.find(row => row.name === 'B_GND')] },
			...base.filter(row => !['B_BRAKE1_PWM', 'B_BRAKE2_PWM', 'B_GND'].includes(row.name)),
		]
	}
	state.source = makeSource()
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => clone(state.document) },
		sys_FileManager: { getDocumentSource: async () => { state.source ??= makeSource(); return state.source } },
		pcb_Drc: {
			getCurrentRuleConfiguration: async () => {
				state.reads.configuration++; state.onConfigurationRead?.(); if (state.readFailure === 'configuration') throw new Error('configuration read failed')
				const result = clone(state.configuration)
				if (state.driftSpacing) result.config.Spacing['Safe Spacing'].copperThickness1oz.tables['1'].content[12][0] = 0.17599659999999998
				return result
			},
			getCurrentRuleConfigurationName: async () => state.configurationName,
			getNetRules: async () => { state.reads.netRules++; state.onNetRead?.(); if (state.readFailure === 'netRules') throw new Error('net rules read failed'); return clone(state.netRules) },
			overwriteCurrentRuleConfiguration: async value => {
				state.configurationSetterInputs.push(clone(value))
				if (!value || typeof value !== 'object' || Array.isArray(value) || 'config' in value || 'name' in value)
					throw new Error('official setter contract expects configuration.config inner object')
				return write('configuration', value)
			},
			overwriteNetRules: async value => write('netRules', value),
		},
	}
	function write(phase, value) {
		state.writes[phase]++
		const behavior = state.writeBehavior[phase]
		if (behavior.startsWith('apply')) {
			if (phase === 'configuration') {
				state.configuration.config = clone(value)
				for (const path of state.quantizePaths) {
					const [root, section, group, rule, form, data, layer, field] = path
					const ruleConfig = state.configuration[root][section][group][rule]
					const current = ruleConfig[form][data][layer][field]
					ruleConfig[form][data][layer][field] = toMil(current, ruleConfig.unit) * (ruleConfig.unit === 'mm' ? 0.0254 : 1)
				}
				state.configuration.name = '自定义配置1'
				state.configurationName = state.configuration.name
				state.source = makeSource()
			}
			else { state.netRules = clone(value); state.source = makeSource() }
			if (state.driftSpacingAfterWrite) state.driftSpacing = true
		}
		if (behavior === 'apply-throw') throw new Error(`${phase} SDK throw after apply`)
		if (behavior === 'apply-false') return false
		if (behavior === 'noapply-false') return false
		return true
	}
	const context = () => ({ assertDocumentTarget: async () => {}, stopSignal: { assertActive() {} } })
	const configPath = ['config', 'Physics', 'Track', 'copperThickness1oz', 'form', 'data', '1', 'defaultValue']
	const otherConfigPath = ['config', 'Physics', 'Track', 'copperThickness2oz', 'form', 'data', '1', 'defaultValue']
	const changedValue = 0.3048

	state = reset()
	const readResult = await get({}, context())
	assert.deepEqual(readResult.configuration, fixture.configuration, 'getter returns full captured configuration')
	assert.equal(readResult.configurationName, fixture.configuration.name, 'public getter returns the selected configuration name')
	assert.deepEqual(readResult.netRules, fixture.netRules, 'getter returns all captured network binding rows')
	assert.equal(Object.hasOwn(readResult, 'source'), false, 'internal source log is not exposed in the public getter result')

	state = reset()
	const preview = await update({ changes: [{ path: configPath, value: changedValue }], netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: null } }] }, context())
	assert.equal(preview.dryRun, true, 'dryRun defaults to true')
	assert.equal(preview.configuration.status, 'planned')
	assert.equal(preview.netRules.status, 'planned')
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'dryRun performs no SDK writes')

	state = reset()
	const fullBefore = clone({ configuration: state.configuration, netRules: state.netRules })
	const applied = await update({ dryRun: false, changes: [{ path: configPath, value: changedValue }], netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'custom-track' } }] }, context())
	assert.equal(applied.verified, true, 'both requested phases verified')
	assert.equal(applied.configuration.status, 'applied')
	assert.equal(applied.netRules.status, 'applied')
	assert.equal(state.configuration.config.Physics.Track.copperThickness1oz.form.data['1'].defaultValue, changedValue)
	assert.equal(state.configuration.config.Physics.Track.copperThickness2oz.form.data['1'].defaultValue, fullBefore.configuration.config.Physics.Track.copperThickness2oz.form.data['1'].defaultValue, 'non-target configuration kept')
	assert.equal(state.configurationName, state.configuration.name, 'SDK generated configuration name is returned by its read-only getter')
	assert.equal(applied.configuration.metadata.nameIsSdkGeneratedMetadata, true, 'SDK-generated name change is reported as metadata')
	assert.deepEqual(state.configurationSetterInputs[0], state.configuration.config, 'official setter receives only updated configuration.config, never the getter wrapper')
	assert.equal(state.netRules.find(row => row.name === 'B_GND').Track, 'custom-track')
	assert.equal(state.netRules.find(row => row.name === 'B_GND')['Copper Safe Spacing'], null, 'unselected null binding kept')
	assert.deepEqual(state.netRules.filter(row => row.name !== 'B_GND'), fullBefore.netRules.filter(row => row.name !== 'B_GND'), 'other net rows kept')
	assert.deepEqual(state.writes, { configuration: 1, netRules: 1 })

	state = reset()
	state.netRules = canonicalNetRules()
	state.source = makeSource()
	const classAndExplicit = [
		{ type: 'netClass', name: 'Brake Class', values: { Track: 'copperThickness2oz' } },
		{ type: 'net', name: 'B_BRAKE1_PWM', values: { Track: 'copperThickness1oz' } },
	]
	const previewClassFirst = await update({ netRuleChanges: classAndExplicit }, context())
	state = reset()
	state.netRules = canonicalNetRules()
	state.source = makeSource()
	const previewNetFirst = await update({ netRuleChanges: [...classAndExplicit].reverse() }, context())
	assert.deepEqual(previewNetFirst.netRules.diff, previewClassFirst.netRules.diff, 'class propagation and explicit net override do not depend on request order')
	assert.equal(previewClassFirst.netRules.diff.find(row => row.type === 'net' && row.name === 'B_BRAKE1_PWM').values.Track.after, 'copperThickness1oz', 'explicit NET value overrides the class value')
	assert.equal(previewClassFirst.netRules.diff.find(row => row.type === 'net' && row.name === 'B_BRAKE2_PWM').values.Track.before, 'default')
	assert.equal(previewClassFirst.netRules.diff.find(row => row.type === 'net' && row.name === 'B_BRAKE2_PWM').values.Track.after, 'copperThickness2oz')
	assert.equal(previewClassFirst.netRules.diff.find(row => row.type === 'net' && row.name === 'B_BRAKE2_PWM').fromClass, 'Brake Class', 'automatic member change records its class source')

	state = reset()
	const beforeCanonical = canonicalNetRules()
	beforeCanonical[0].sub[0].customNetMetadata = { preserve: true }
	state.netRules = beforeCanonical
	state.source = makeSource()
	const classResult = await update({ dryRun: false, netRuleChanges: [
		{ type: 'netClass', name: 'Brake Class', values: { Track: 'copperThickness2oz' } },
		{ type: 'net', name: 'B_BRAKE1_PWM', values: { Track: 'copperThickness1oz' } },
	] }, context())
	assert.equal(classResult.netRules.status, 'applied', 'canonical netClass and a nested net can be updated in one pass')
	assert.equal(state.writes.netRules, 1)
	const brakeClass = state.netRules.find(row => row.name === 'Brake Class')
	assert.equal(brakeClass.Track, 'copperThickness2oz')
	assert.equal(classResult.netRules.diff.find(row => row.type === 'netClass' && row.name === 'Brake Class').values.Track.before, 'default')
	assert.equal(brakeClass.customMetadata.keep, true, 'unknown class metadata is preserved')
	assert.equal(brakeClass.sub.find(row => row.name === 'B_BRAKE1_PWM').Track, 'copperThickness1oz', 'explicit net value overrides class propagation')
	assert.equal(brakeClass.sub.find(row => row.name === 'B_BRAKE2_PWM').Track, 'copperThickness2oz', 'unselected sibling inherits the changed class rule')
	assert.equal(brakeClass.sub.find(row => row.name === 'B_BRAKE1_PWM').targetNet, beforeCanonical[0].sub[0].targetNet, 'net identity metadata is preserved')
	assert.deepEqual(brakeClass.sub.find(row => row.name === 'B_BRAKE1_PWM').customNetMetadata, { preserve: true }, 'unknown member metadata is preserved')
	assert.deepEqual(state.netRules.find(row => row.name === 'Other Class'), beforeCanonical.find(row => row.name === 'Other Class'), 'other classes and their member networks are preserved')
	assert.deepEqual(state.netRules.filter(row => row.type === 'net'), beforeCanonical.filter(row => row.type === 'net'), 'class assignment leaves standalone networks unchanged')
	assert.equal(classResult.netRules.diff.find(row => row.type === 'net' && row.name === 'B_BRAKE2_PWM').values.Track.before, 'default', 'diff records the original member value, not the propagation intermediate')
	assert.equal(classResult.netRules.diff.find(row => row.type === 'net' && row.name === 'B_BRAKE2_PWM').fromClass, 'Brake Class')
	const classRepeat = await update({ dryRun: false, netRuleChanges: [
		{ type: 'netClass', name: 'Brake Class', values: { Track: 'copperThickness2oz' } },
		{ type: 'net', name: 'B_BRAKE1_PWM', values: { Track: 'copperThickness1oz' } },
	] }, context())
	assert.equal(classRepeat.netRules.status, 'skipped', 'repeating nested class/net values is a zero-write skip')
	assert.equal(state.writes.netRules, 1)

	state = reset()
	state.netRules = canonicalNetRules()
	state.netRules[0].Track = 'copperThickness2oz'
	state.netRules[0].sub[1].Track = 'default'
	state.source = makeSource()
	const reapplySameClass = await update({ dryRun: false, netRuleChanges: [{ type: 'netClass', name: 'Brake Class', values: { Track: 'copperThickness2oz' } }] }, context())
	assert.equal(reapplySameClass.netRules.status, 'applied', 'reselecting an unchanged class repairs an out-of-sync member')
	assert.equal(state.netRules[0].sub[1].Track, 'copperThickness2oz')
	assert.equal(reapplySameClass.netRules.diff[0].values.Track.before, 'default')

	state = reset()
	state.netRules = canonicalNetRules()
	delete state.netRules[0].sub[1].Track
	state.source = makeSource()
	await assert.rejects(update({ dryRun: false, netRuleChanges: [{ type: 'netClass', name: 'Brake Class', values: { Track: 'copperThickness2oz' } }] }, context()), /字段不存在/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'class binding missing on a member is rejected before write')

	state = reset()
	const duplicateNet = clone(state.netRules.find(row => row.name === 'B_GND'))
	const duplicateFixtureNet = state.netRules.find(row => row.name === 'B_3V3')
	state.netRules = [
		{ type: 'netClass', name: 'Power Class', Track: 'default', sub: [duplicateNet] },
		clone(duplicateNet),
		duplicateFixtureNet,
	]
	state.source = makeSource()
	await assert.rejects(update({ dryRun: false, netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'other-track' } }] }, context()), /必须唯一匹配/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'ambiguous nested selectors fail before any write')

	for (const field of ['sub', 'targetNet']) {
		state = reset()
		await assert.rejects(update({ dryRun: false, netRuleChanges: [{ type: 'net', name: 'B_GND', values: { [field]: null } }] }, context()), /身份字段/)
		assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, `${field} cannot be changed as a binding`)
	}
	state = reset()
	state.netRules[0].Track = 17
	state.source = makeSource()
	await assert.rejects(update({ dryRun: false, netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'new-track' } }] }, context()), /不是字符串或 null/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'non-string existing bindings are rejected before write')

	state = reset()
	const normalizedTrackPath = ['config', 'Physics', 'Track', 'copperThickness2oz', 'form', 'data', '1', 'minValue']
	state.quantizePaths = [normalizedTrackPath]
	state.driftSpacingAfterWrite = true
	const normalizedTrack = await update({ dryRun: false, changes: [{ path: normalizedTrackPath, value: 0.3 }] }, context())
	assert.equal(normalizedTrack.configuration.status, 'applied', 'known track value is compared at the documented native precision')
	assert.deepEqual(normalizedTrack.configuration.normalizations, [
		{ path: ['config', 'Spacing', 'Safe Spacing', 'copperThickness1oz', 'tables', '1', 'content', '12', '0'], requested: 0.1759966, actual: 0.17599659999999998, normalizedMil: 6.929, sourceVerified: true },
		{ path: normalizedTrackPath, requested: 0.3, actual: 0.29999939999999997, normalizedMil: 11.811, sourceVerified: true },
	])
	assert.deepEqual(normalizedTrack.configuration.metadata, {
		configurationNameBefore: fixture.configuration.name,
		getterNameBefore: fixture.configuration.name,
		configurationNameAfter: '自定义配置1',
		getterNameAfter: '自定义配置1',
		nameIsSdkGeneratedMetadata: true,
	})
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 })

	state = reset()
	state.driftSpacingAfterWrite = true
	const safeTargetPath = ['config', 'Spacing', 'Safe Spacing', 'copperThickness2oz', 'tables', '1', 'content', '0', '0']
	const safeEditWithGetterTail = await update({ dryRun: false, changes: [{ path: safeTargetPath, value: 0.12 }] }, context())
	assert.equal(safeEditWithGetterTail.configuration.status, 'applied', 'a normal SAFE edit is not blocked by the unrelated SAFE getter tail')
	assert.ok(safeEditWithGetterTail.configuration.sourceRuleChanges.some(item => item.record.includes('copperThickness2oz') && item.rawSourceFullyMapped === false), 'raw SAFE rule change is reported separately without claiming full hidden-field mapping')

	state = reset()
	state.driftSpacingAfterWrite = true
	const otherSpacingPath = ['config', 'Spacing', 'Other Spacing', 'otherClearance', 'form', 'device2device']
	const otherSpacing = await update({ dryRun: false, changes: [{ path: otherSpacingPath, value: 0.12 }] }, context())
	assert.equal(otherSpacing.configuration.status, 'applied', 'a full getter match must not depend on guessing source rule family names')
	assert.ok(otherSpacing.configuration.sourceRuleChanges.some(item => item.record.includes('OTHER') && item.before.ruleContext.otherSpacing.device2device === 0 && item.after.ruleContext.otherSpacing.device2device === 0.12 && item.rawSourceFullyMapped === false))

	state = reset()
	const readUnmodifiedSource = globalThis.eda.sys_FileManager.getDocumentSource
	globalThis.eda.sys_FileManager.getDocumentSource = async () => {
		const source = await readUnmodifiedSource()
		if (!state.writes.configuration) return source
		return source + '\n' + JSON.stringify({ type: 'NET', id: '["NET","UNEXPECTED"]', ticket: 999999 }) + '||' + JSON.stringify({ name: 'UNEXPECTED' }) + '|'
	}
	try {
		await assert.rejects(update({ dryRun: false, changes: [{ path: otherSpacingPath, value: 0.12 }] }, context()), /源码存在未授权变化/)
		assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, 'unselected non-rule source changes stop the operation even when the configuration getter matches')
	}
	finally { globalThis.eda.sys_FileManager.getDocumentSource = readUnmodifiedSource }

	state = reset()
	state.configuration.config.Physics.Track.copperThickness2oz.form.data['1'].minValue = 0.29999939999999997
	state.source = makeSource()
	const equivalentExisting = await update({ dryRun: false, changes: [{ path: normalizedTrackPath, value: 0.3 }] }, context())
	assert.equal(equivalentExisting.configuration.status, 'skipped', 'a request already represented by the existing native mil value is a zero-write no-op')
	assert.deepEqual(equivalentExisting.configuration.normalizations, [{ path: normalizedTrackPath, requested: 0.3, actual: 0.29999939999999997, normalizedMil: 11.811, sourceVerified: true }])
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 })

	state = reset()
	const addedLayerPath = ['config', 'Physics', 'Track', 'copperThickness2oz', 'form', 'data', '3']
	const addedLayerValue = { minValue: 0.3, defaultValue: 0.508, maxValue: 0.889 }
	state.quantizePaths = [[...addedLayerPath, 'minValue']]
	const addedLayer = await update({ dryRun: false, changes: [{ path: addedLayerPath, value: addedLayerValue }] }, context())
	assert.equal(addedLayer.configuration.status, 'applied', 'a new row can verify a quantized leaf by its raw native mil value')
	assert.ok(addedLayer.configuration.normalizations.some(item => item.path.join('.') === [...addedLayerPath, 'minValue'].join('.') && item.normalizedMil === 11.811))
	assert.equal(state.configuration.config.Physics.Track.copperThickness2oz.form.data['3'].minValue, 0.29999939999999997)
	const repeatedLayer = await update({ dryRun: false, changes: [{ path: addedLayerPath, value: addedLayerValue }] }, context())
	assert.equal(repeatedLayer.configuration.status, 'skipped', 'repeating a new-row request is zero-write after native precision normalization')
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 })

	state = reset()
	state.driftSpacingAfterWrite = true
	const noiseOnly = await update({ dryRun: false, netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'custom-track' } }] }, context())
	assert.equal(noiseOnly.netRules.status, 'applied', 'read-only spacing display tail is accepted only when its raw SAFE source rule stays unchanged')
	assert.ok(noiseOnly.configuration.normalizations.some(item => item.sourceVerified === true && item.normalizedMil === 6.929))
	assert.deepEqual(state.writes, { configuration: 0, netRules: 1 })

	state = reset()
	const addedLeafPath = ['config', 'Physics', 'Track', 'copperThickness1oz', 'form', 'data', '1', 'explicitNewField']
	const addedLeaf = await update({ dryRun: false, changes: [{ path: addedLeafPath, value: { min: 0.2, default: 0.25, max: 0.4 } }] }, context())
	assert.equal(addedLeaf.configuration.status, 'applied', 'explicit leaf value can be added under existing parent')
	assert.deepEqual(state.configuration.config.Physics.Track.copperThickness1oz.form.data['1'].explicitNewField, { min: 0.2, default: 0.25, max: 0.4 })

	state = reset()
	const matrixPath = ['config', 'Spacing', 'Safe Spacing', 'copperThickness1oz', 'tables', '1', 'content', '0', '0']
	const matrixEdit = await update({ dryRun: false, changes: [{ path: matrixPath, value: 0.12 }] }, context())
	assert.equal(matrixEdit.configuration.status, 'applied', 'existing matrix array cells are addressable')
	assert.equal(state.configuration.config.Spacing['Safe Spacing'].copperThickness1oz.tables['1'].content[0][0], 0.12)

	for (const invalid of [
		{ changes: [{ path: [], value: 1 }] },
		{ changes: [{ path: ['config', '__proto__', 'polluted'], value: true }] },
		{ changes: [{ path: ['config', 'missing', 'child'], value: 1 }] },
		{ changes: [{ path: ['name'], value: 'renamed' }] },
		{ changes: [{ path: ['config'], value: { Physics: {} } }] },
		{ changes: [{ path: configPath, value: Number.POSITIVE_INFINITY }] },
		{ changes: [{ path: configPath, value: undefined }] },
		{ dryRun: 'false', changes: [{ path: configPath, value: changedValue }] },
		{ netRuleChanges: [{ type: 'net', name: 'absent', values: { Track: 'x' } }] },
		{ netRuleChanges: [{ type: 'net', name: 'B_GND', values: { unknownBinding: 'x' } }] },
		{ netRuleChanges: [{ type: 'net', name: 'B_GND', values: { type: 'class' } }] },
	]) {
		state = reset()
		await assert.rejects(update({ dryRun: false, ...invalid }, context()), undefined, 'invalid target or value is rejected')
		assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'invalid input rejected before either writer')
	}
	for (const malformed of [
		{ ...clone(fixture.configuration), config: { ...clone(fixture.configuration.config), unsafeUnknown: Number.NaN } },
		{ ...clone(fixture.configuration), config: { ...clone(fixture.configuration.config), unsafeUnknown: undefined } },
		{ name: fixture.configuration.name },
		{ ...clone(fixture.configuration), config: null },
	]) {
		state = reset(); state.source = makeSource(); state.configuration = malformed
		await assert.rejects(update({ dryRun: false, changes: [{ path: ['config', 'Physics', 'Track'], value: 1 }] }, context()), /有限数值|undefined|有效 configuration\.config/)
		assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'invalid host snapshot is rejected before clone/write')
	}

	state = reset()
	let configReadCount = 0
	state.onConfigurationRead = () => { if (++configReadCount === 2) state.configuration.config.Physics.Track.copperThickness1oz.form.data['1'].defaultValue = 0.38 }
	await assert.rejects(update({ dryRun: false, changes: [{ path: configPath, value: changedValue }] }, context()), /snapshot changed|快照已变化/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'fresh read blocks write after UI rule edit')

	state = reset()
	let stagedConfigReads = 0
	state.onConfigurationRead = () => { if (++stagedConfigReads === 4) state.configuration.config.Physics.Track.copperThickness2oz.form.data['1'].defaultValue = 0.38 }
	await assert.rejects(update({ dryRun: false, changes: [{ path: configPath, value: changedValue }], netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'custom-track' } }] }, context()), /快照已变化/)
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, 'net phase rechecks the full configuration after the first phase before its write')

	for (const mode of ['apply-false', 'apply-throw']) {
		state = reset(); state.writeBehavior.configuration = mode
		const result = await update({ dryRun: false, changes: [{ path: configPath, value: changedValue }] }, context())
		assert.equal(result.configuration.status, 'applied', `${mode} is accepted after matching full readback`)
		assert.ok(result.configuration.sdkWarning, 'SDK acknowledgement anomaly disclosed')
	}

	state = reset(); state.writeBehavior.configuration = 'noapply-false'
	await assert.rejects(update({ dryRun: false, changes: [{ path: configPath, value: changedValue }] }, context()), error => {
		assert.equal(error.cause?.outcome, 'unknown')
		assert.equal(error.cause?.partial, true, 'first dispatched write with unknown readback is partial')
		assert.equal(error.cause?.stages.configuration.status, 'outcomeunknown')
		return true
	})
	assert.equal(state.writes.configuration, 1)

	state = reset(); state.writeBehavior.configuration = 'noapply-false'
	registry.registerCommand(pcbRuleCommands.find(command => command.name === 'pcb.updateDesignRules'))
	let macroFollowupWrites = 0
	registry.registerCommand({ name: 'test.ruleFollowup', summary: '', params: [], returns: '', handler: async () => { macroFollowupWrites++; return { ok: true } } })
	const macroResult = await registry.executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
		{ cmd: 'pcb.updateDesignRules', params: { dryRun: false, changes: [{ path: configPath, value: changedValue }] } },
		{ cmd: 'test.ruleFollowup' },
	] } })
	assert.equal(macroResult.ok, false)
	assert.equal(macroResult.data.stoppedAtStep, 1, 'registry stops macro at first rule write with unknown outcome')
	assert.equal(macroResult.data.unexecutedSteps, 1)
	assert.equal(macroResult.error.cause.partial, true)
	assert.equal(macroFollowupWrites, 0, 'stopOnError:false cannot run a dependent command after unknown rule write')

	state = reset(); state.writeBehavior.netRules = 'noapply-false'
	await assert.rejects(update({ dryRun: false, changes: [{ path: configPath, value: changedValue }], netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'custom-track' } }] }, context()), error => {
		assert.equal(error.cause?.partial, true, 'first applied phase disclosed as partial')
		assert.equal(error.cause?.stages.configuration.status, 'applied')
		assert.equal(error.cause?.stages.netRules.status, 'outcomeunknown')
		return true
	})
	assert.deepEqual(state.writes, { configuration: 1, netRules: 1 }, 'unknown second phase stops after one write attempt')

	state = reset()
	// Allow the reads needed before the first write, then fail the post-write readback.
	let netReads = 0
	state.onNetRead = () => { if (++netReads >= 3) state.readFailure = 'netRules' }
	await assert.rejects(update({ dryRun: false, changes: [{ path: configPath, value: changedValue }] }, context()), error => {
		assert.equal(error.cause?.outcome, 'unknown')
		assert.equal(error.cause?.phase, 'configuration')
		return true
	})
	assert.equal(state.writes.configuration, 1, 'incomplete readback stops after first writer')

	state = reset()
	const same = state.configuration.config.Physics.Track.copperThickness1oz.form.data['1'].defaultValue
	const skipped = await update({ dryRun: false, changes: [{ path: configPath, value: same }], netRuleChanges: [{ type: 'net', name: 'B_GND', values: { Track: 'default' } }] }, context())
	assert.equal(skipped.configuration.status, 'skipped')
	assert.equal(skipped.netRules.status, 'skipped')
	assert.equal(skipped.verified, true)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'repeated target values are zero-write skips')

	console.log('PASS design-rule getters, safe merge previews, staged writes, readback outcomes, and preservation cases')
} finally { await rm(temp, { recursive: true, force: true }) }
