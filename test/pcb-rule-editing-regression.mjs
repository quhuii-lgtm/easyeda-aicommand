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
const safeCellFixture = JSON.parse(await readFile(new URL('./fixtures/pcb-safe-cell-roundtrip-4199.json', import.meta.url), 'utf8'))
const newTrackFixture = JSON.parse(await readFile(new URL('./fixtures/pcb-track-new-rule-core.json', import.meta.url), 'utf8'))
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
	const deleteTrackRule = pcbRuleCommands.find(command => command.name === 'pcb.deleteTrackRule').handler
	assert.equal(typeof deleteTrackRule, 'function', 'the narrowly scoped current-PCB TRACK definition delete command is registered')
	const clone = value => structuredClone(value)
	const reset = () => ({
		document: clone(fixture.document), configuration: clone(fixture.configuration), netRules: clone(fixture.netRules),
		writes: { configuration: 0, netRules: 0 }, reads: { configuration: 0, netRules: 0 },
		writeBehavior: { configuration: 'apply-true', netRules: 'apply-true' },
		configurationSetterInputs: [], readFailure: null, onNetRead: null, onConfigurationRead: null,
		configurationName: fixture.configuration.name, quantizePaths: [], expansionRoundtripPaths: [], driftSpacing: false, driftSpacingAfterWrite: false, sourceAfterConfigurationWrite: null, sourceAfterNetRuleWrite: null, configurationAfterWrite: null, preserveConfigurationName: false,
	})
	let state = reset()
	const toMil = (value, unit) => Math.round(value * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4
	const makeSource = () => {
		const rows = []
		const add = (type, id, data) => rows.push(`${JSON.stringify({ type, id, ticket: rows.length })}||${JSON.stringify(data)}|`)
		add('DOCHEAD', undefined, { docType: 'PCB', uuid: state.document.uuid })
		add('RULE_TEMPLATE', 'RULE_TEMPLATE', { name: state.configuration.name })
		for (const [name, rule] of Object.entries(state.configuration.config.Physics.Track)) {
			const content = Object.entries(rule.form.data).map(([layerId, values]) => ({ layerId: Number(layerId), stroMin: toMil(values.minValue, rule.unit), stroDef: toMil(values.defaultValue, rule.unit), stroMax: toMil(values.maxValue, rule.unit) }))
			add('RULE', JSON.stringify(['RULE', 'TRACK', name]), { ruleState: 'NORMAL', ruleContext: { unit: rule.unit, track: { isOpen: true, content } } })
		}
		for (const [name, rule] of Object.entries(state.configuration.config.Spacing['Safe Spacing'])) {
			const content = rule.tables['1'].content.map(row => row.map(value => toMil(value, rule.unit)))
			add('RULE', JSON.stringify(['RULE', 'SAFE', name]), { ruleState: 'NORMAL', ruleContext: { unit: rule.unit, safeSpacing: [{ layerId: 1, content }] } })
		}
		for (const [name, rule] of Object.entries(state.configuration.config.Spacing['Other Spacing']))
			add('RULE', JSON.stringify(['RULE', 'OTHER', name]), { ruleState: 'NORMAL', ruleContext: { unit: rule.unit, otherSpacing: clone(rule.form) } })
		for (const [group, rules] of Object.entries(state.configuration.config.Expansion)) {
			const family = group === 'Solder Mask Expansion' ? 'SOLDER' : group === 'Paste Mask Expansion' ? 'PASTE' : undefined
			if (!family) continue
			for (const [name, rule] of Object.entries(rules)) {
				const sourceFields = family === 'SOLDER'
					? { padToplayerExpansion: 'padTopExpan', padBottomlayerExpansion: 'padBotExpan', viaToplayerExpansion: 'viaTopExpan', viaBottomlayerExpansion: 'viaBotExpan', testPointToplayerExpansion: 'testPointTopExpan', testPointBottomlayerExpansion: 'testPointBotExpan' }
					: { padToplayerExpansion: 'padTopExpan', padBottomlayerExpansion: 'padBotExpan', testPointToplayerExpansion: 'testPointTopExpan', testPointBottomlayerExpansion: 'testPointBotExpan' }
				const ruleContext = { unit: rule.unit }
				for (const [field, sourceField] of Object.entries(sourceFields))
					if (Object.hasOwn(rule.form, field)) ruleContext[sourceField] = toMil(rule.form[field], rule.unit)
				add('RULE', JSON.stringify(['RULE', family, name]), { ruleState: 'DEFAULT', ruleContext })
			}
		}
		const emitRuleSelectors = rules => {
			for (const rule of rules) {
				const scope = rule.type === 'netClass' ? 'NET_CLASS' : rule.type === 'net' ? 'NET' : rule.type === 'equalLengthGroup' ? 'EQ_LEN_GRP' : undefined
				if (scope) {
					const ruleKeyValue = rule.Track && rule.Track !== 'default' ? { TRACK: rule.Track } : {}
					if (scope === 'EQ_LEN_GRP' && Object.hasOwn(rule, 'Net Length Tolerance'))
						ruleKeyValue.NET_LENGTH_TOLERANCE = ['netLengthTolerance', rule['Net Length Tolerance']]
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
				for (const path of state.expansionRoundtripPaths) {
					const [root, section, group, rule, form, field] = path
					const ruleConfig = state.configuration[root][section][group][rule]
					const mil = Math.round(ruleConfig[form][field] / 0.0254 * 1e4) / 1e4
					ruleConfig[form][field] = mil * 0.0254
				}
				state.configurationAfterWrite?.(state.configuration.config)
				if (!state.preserveConfigurationName) {
					state.configuration.name = '自定义配置1'
					state.configurationName = state.configuration.name
				}
				state.source = makeSource()
				if (state.sourceAfterConfigurationWrite) state.source = state.sourceAfterConfigurationWrite(state.source)
			}
			else {
				state.netRules = clone(value)
				state.source = makeSource()
				if (state.sourceAfterNetRuleWrite) state.source = state.sourceAfterNetRuleWrite(state.source)
			}
			if (state.driftSpacingAfterWrite) state.driftSpacing = true
		}
		if (behavior === 'apply-throw') throw new Error(`${phase} SDK throw after apply`)
		if (behavior === 'apply-false') return false
		if (behavior === 'noapply-false') return false
		return true
	}
	const context = () => ({ assertDocumentTarget: async () => {}, stopSignal: { assertActive() {} } })
	const updateSafeSource = (source, transform) => {
		const lines = source.split(/\r?\n/)
		const index = lines.findIndex(line => {
			const separator = line.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(line.slice(0, separator))
			if (header.type !== 'RULE') return false
			try { return JSON.stringify(JSON.parse(header.id)) === JSON.stringify(['RULE', 'SAFE', safeCellFixture.rule]) }
			catch { return false }
		})
		assert.notEqual(index, -1, 'SAFE source record is present')
		const separator = lines[index].indexOf('||')
		const header = JSON.parse(lines[index].slice(0, separator))
		const data = JSON.parse(lines[index].slice(separator + 2).replace(/\|$/, ''))
		lines[index] = `${JSON.stringify(header)}||${JSON.stringify(transform(data))}|`
		return lines.join('\n')
	}
	const safeSourceCell = (source, row, column) => {
		const line = source.split(/\r?\n/).find(value => {
			const separator = value.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(value.slice(0, separator))
			if (header.type !== 'RULE') return false
			try { return JSON.stringify(JSON.parse(header.id)) === JSON.stringify(['RULE', 'SAFE', safeCellFixture.rule]) }
			catch { return false }
		})
		assert.ok(line, 'SAFE source record is present')
		const data = JSON.parse(line.slice(line.indexOf('||') + 2).replace(/\|$/, ''))
		return data.ruleContext.safeSpacing[0].content[row][column]
	}
	const updateSourceSelector = (source, selectorType, name, update) => {
		const lines = source.split(/\r?\n/)
		const tuple = ['RULE_SELECTOR', [selectorType, name]]
		const index = lines.findIndex(line => {
			const separator = line.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(line.slice(0, separator))
			if (header.type !== 'RULE_SELECTOR') return false
			try { return JSON.stringify(JSON.parse(header.id)) === JSON.stringify(tuple) }
			catch { return false }
		})
		if (index < 0) {
			const data = update({ ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null })
			lines.push(`${JSON.stringify({ type: 'RULE_SELECTOR', ticket: 999999, id: JSON.stringify(tuple) })}||${JSON.stringify(data)}|`)
			return lines.join('\n')
		}
		const separator = lines[index].indexOf('||')
		const header = JSON.parse(lines[index].slice(0, separator))
		const data = JSON.parse(lines[index].slice(separator + 2).replace(/\|$/, ''))
		lines[index] = `${JSON.stringify(header)}||${JSON.stringify(update(data))}|`
		return lines.join('\n')
	}
	const updateTrackSource = (source, rule, update) => {
		const lines = source.split(/\r?\n/)
		const id = JSON.stringify(['RULE', 'TRACK', rule])
		const index = lines.findIndex(line => {
			const separator = line.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(line.slice(0, separator))
			return header.type === 'RULE' && header.id === id
		})
		assert.notEqual(index, -1, `TRACK source record ${rule} exists`)
		const separator = lines[index].indexOf('||')
		const header = JSON.parse(lines[index].slice(0, separator))
		const data = JSON.parse(lines[index].slice(separator + 2).replace(/\|$/, ''))
		lines[index] = `${JSON.stringify(header)}||${JSON.stringify(update(data))}|`
		return lines.join('\n')
	}
	const resolvedSourceForTest = source => {
		const records = new Map()
		for (const line of source.split(/\r?\n/)) {
			const separator = line.indexOf('||')
			if (separator < 0) continue
			const header = JSON.parse(line.slice(0, separator))
			if (!header.id) continue
			const key = `${header.type}\0${header.id}`
			const previous = records.get(key)
			if (!previous || Number(header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) {
				const dataText = line.slice(separator + 2).replace(/\|$/, '')
				if (dataText === '') records.delete(key)
				else records.set(key, { header, data: JSON.parse(dataText) })
			}
		}
		return records
	}
	const appendTrackSourceRecord = (baseline, generated, rule) => {
		const id = JSON.stringify(['RULE', 'TRACK', rule])
		const line = generated.split(/\r?\n/).find(value => {
			const separator = value.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(value.slice(0, separator))
			return header.type === 'RULE' && header.id === id
		})
		assert.ok(line, `generated TRACK source record ${rule} exists`)
		return `${baseline}\n${line}`
	}
	const appendRuleSourceRecords = (baseline, generated, tuples) => {
		const ids = new Set(tuples.map(([family, rule]) => JSON.stringify(['RULE', family, rule])))
		const lines = generated.split(/\r?\n/).filter(line => {
			const separator = line.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(line.slice(0, separator))
			return header.type === 'RULE' && ids.has(header.id)
		})
		assert.equal(lines.length, tuples.length, 'all explicitly selected raw rule records were generated')
		return `${baseline}\n${lines.join('\n')}`
	}
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

	const equalLengthName = 'CFG_EQ_20261114'
	const equalLengthTarget = { type: 'equalLengthGroup', name: equalLengthName, 'Net Length Tolerance': null }
	state = reset()
	state.netRules.push(equalLengthTarget)
	state.source = makeSource()
	const equalLengthApplied = await update({ dryRun: false, netRuleChanges: [{ type: 'equalLengthGroup', name: equalLengthName, values: { 'Net Length Tolerance': 'netLengthTolerance' } }] }, context())
	assert.equal(equalLengthApplied.netRules.status, 'applied', 'the exact EQ_LEN_GRP selector readback is accepted after full getter verification')
	assert.equal(state.netRules.find(row => row.type === 'equalLengthGroup' && row.name === equalLengthName)['Net Length Tolerance'], 'netLengthTolerance')
	assert.ok(equalLengthApplied.configuration.sourceRuleChanges.some(item => item.record.includes('EQ_LEN_GRP') && item.rawSourceFullyMapped === false), 'equal-length-group raw selector mapping remains explicitly partial')
	assert.equal(state.writes.netRules, 1)

	state = reset()
	state.netRules.push(equalLengthTarget, { type: 'equalLengthGroup', name: 'CFG_EQ_OTHER', 'Net Length Tolerance': null })
	state.source = makeSource()
	state.sourceAfterNetRuleWrite = source => updateSourceSelector(source, 'EQ_LEN_GRP', 'CFG_EQ_OTHER', data => ({ ...data, ruleKeyValue: { ...data.ruleKeyValue, NET_LENGTH_TOLERANCE: ['netLengthTolerance', 'unexpected'] } }))
	await assert.rejects(update({ dryRun: false, netRuleChanges: [{ type: 'equalLengthGroup', name: equalLengthName, values: { 'Net Length Tolerance': 'netLengthTolerance' } }] }, context()), /源码存在未授权变化/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 1 }, 'changes to another equal-length group are not covered by the selected identity')

	state = reset()
	state.netRules.push(equalLengthTarget)
	state.source = makeSource()
	const wrongTypeData = { ruleOrder: 4, ruleKeyValue: { TRACK: 'default' }, copperValue: {}, innerPlaneValue: {}, parent: null }
	state.source += `\n${JSON.stringify({ type: 'RULE_SELECTOR', ticket: 999998, id: JSON.stringify(['RULE_SELECTOR', ['NET_CLASS', equalLengthName]]) })}||${JSON.stringify(wrongTypeData)}|`
	state.sourceAfterNetRuleWrite = source => updateSourceSelector(source, 'NET_CLASS', equalLengthName, data => ({ ...data, ruleKeyValue: { ...data.ruleKeyValue, TRACK: 'changed' } }))
	await assert.rejects(update({ dryRun: false, netRuleChanges: [{ type: 'equalLengthGroup', name: equalLengthName, values: { 'Net Length Tolerance': 'netLengthTolerance' } }] }, context()), /源码存在未授权变化/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 1 }, 'same-name selector with a different raw type cannot be mistaken for EQ_LEN_GRP')

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
		{ path: ['config', 'Spacing', 'Safe Spacing', 'copperThickness1oz', 'tables', '1', 'content', '12', '0'], requested: 0.1759966, actual: 0.17599659999999998, normalizedMil: 6.929, sourceVerified: true, sourcePath: 'RULE SAFE copperThickness1oz.safeSpacing[layerId=1].content[12][0]', sourceBeforeMil: 6.929, sourceAfterMil: 6.929, sourceEvidence: '同名SAFE规则中唯一layerId的同一单元格在写入前后保持有限且严格相等，并与getter的expected/actual毫米值换算一致' },
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
	const safeGetterCellPath = ['config', 'Spacing', 'Safe Spacing', safeCellFixture.rule, 'tables', String(safeCellFixture.layerId), 'content', String(safeCellFixture.editedCell.row), String(safeCellFixture.editedCell.column)]
	assert.equal(safeSourceCell(state.source ?? makeSource(), safeCellFixture.getterCell.row, safeCellFixture.getterCell.column), safeCellFixture.sourceGetterCellMil.before, 'captured baseline raw getter cell agrees with the real source sample')
	assert.equal(safeSourceCell(state.source ?? makeSource(), safeCellFixture.editedCell.row, safeCellFixture.editedCell.column), safeCellFixture.editedCell.sourceBeforeMil, 'captured baseline target cell is 4.0157mil')
	const safeCellRoundtrip = await update({ dryRun: false, changes: [{ path: safeGetterCellPath, value: 0.254 }] }, context())
	assert.equal(safeCellRoundtrip.configuration.status, 'applied', 'the real SAFE source/getter pair permits only the proven readback tail')
	const safeCellGetterAfter = await get({}, context())
	assert.equal(safeCellGetterAfter.configuration.config.Spacing['Safe Spacing'][safeCellFixture.rule].tables[String(safeCellFixture.layerId)].content[safeCellFixture.getterCell.row][safeCellFixture.getterCell.column], safeCellFixture.getterCell.afterMm)
	assert.equal(safeSourceCell(state.source, safeCellFixture.getterCell.row, safeCellFixture.getterCell.column), safeCellFixture.sourceGetterCellMil.after, 'unrequested raw cell remains exactly 6.929mil')
	assert.equal(safeSourceCell(state.source, safeCellFixture.editedCell.row, safeCellFixture.editedCell.column), safeCellFixture.editedCell.sourceAfterMil, 'requested target cell changes to 10mil in the matching source record')
	const safeNoisePath = ['config', 'Spacing', 'Safe Spacing', safeCellFixture.rule, 'tables', String(safeCellFixture.layerId), 'content', String(safeCellFixture.getterCell.row), String(safeCellFixture.getterCell.column)]
	assert.ok(safeCellRoundtrip.configuration.normalizations.some(item => item.path.join('.') === safeNoisePath.join('.') && item.sourcePath === `RULE SAFE ${safeCellFixture.rule}.safeSpacing[layerId=${safeCellFixture.layerId}].content[${safeCellFixture.getterCell.row}][${safeCellFixture.getterCell.column}]` && item.sourceBeforeMil === 6.929 && item.sourceAfterMil === 6.929))

	for (const [label, alter] of [
		['raw cell changes', data => { data.ruleContext.safeSpacing[0].content[safeCellFixture.getterCell.row][safeCellFixture.getterCell.column] = 7 }],
		['layer is missing', data => { data.ruleContext.safeSpacing = [] }],
		['layer is duplicated', data => { data.ruleContext.safeSpacing.push(clone(data.ruleContext.safeSpacing[0])) }],
		['cell is missing', data => { data.ruleContext.safeSpacing[0].content[safeCellFixture.getterCell.row] = [] }],
	]) {
		state = reset()
		state.driftSpacingAfterWrite = true
		state.sourceAfterConfigurationWrite = source => updateSafeSource(source, data => alter(data) ?? data)
		await assert.rejects(update({ dryRun: false, changes: [{ path: safeGetterCellPath, value: 0.254 }] }, context()), /读回与预期不符/)
		assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, `${label} cannot be accepted as a SAFE getter normalization`)
	}

	const solderTopPadPath = ['config', 'Expansion', 'Solder Mask Expansion', 'solderMaskExpansion', 'form', 'padToplayerExpansion']
	state = reset()
	state.expansionRoundtripPaths = [solderTopPadPath]
	const solderTopPad = await update({ dryRun: false, changes: [{ path: solderTopPadPath, value: 0.0762 }] }, context())
	assert.equal(solderTopPad.configuration.status, 'applied', 'the captured SOLDER 2mil to 3mil readback verifies the exact raw field')
	assert.ok(solderTopPad.configuration.normalizations.some(item => item.path.join('.') === solderTopPadPath.join('.') && item.sourcePath === 'RULE SOLDER solderMaskExpansion.ruleContext.padTopExpan' && item.sourceBeforeMil === 2 && item.sourceAfterMil === 3 && item.actual === 3 * 0.0254))
	const solderRepeated = await update({ dryRun: false, changes: [{ path: solderTopPadPath, value: 0.0762 }] }, context())
	assert.equal(solderRepeated.configuration.status, 'skipped', 'repeating a source-equivalent SOLDER value does not write again')
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 })
	assert.ok(solderRepeated.configuration.normalizations.some(item => item.normalizedMil === 3 && item.sourceVerified === true))
	state.writeBehavior.configuration = 'noapply-false'
	await assert.rejects(update({ dryRun: false, changes: [{ path: solderTopPadPath, value: 0.0762005 }] }, context()), /读回与预期不符/)
	assert.deepEqual(state.writes, { configuration: 2, netRules: 0 }, '0.0762005mm is not conflated with the captured 3mil value and is not skipped as equivalent')

	state = reset()
	state.configuration.config.Expansion['Solder Mask Expansion'].solderMaskExpansion.form.padToplayerExpansion = 3 * 0.0254
	state.source = makeSource()
	state.source = state.source.replace('"unit":"mm","padTopExpan":3', '"unit":"mil","padTopExpan":3')
	state.writeBehavior.configuration = 'noapply-false'
	await assert.rejects(update({ dryRun: false, changes: [{ path: solderTopPadPath, value: 0.0762 }] }, context()), /读回与预期不符/)
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, 'non-mm raw SOLDER unit cannot authorize source-equivalent zero-write')

	state = reset()
	state.expansionRoundtripPaths = [solderTopPadPath]
	state.sourceAfterConfigurationWrite = source => {
		const lines = source.split(/\r?\n/)
		const index = lines.findIndex(line => {
			const separator = line.indexOf('||')
			if (separator < 0) return false
			const header = JSON.parse(line.slice(0, separator))
			return header.type === 'RULE' && JSON.stringify(JSON.parse(header.id)) === JSON.stringify(['RULE', 'SOLDER', 'solderMaskExpansion'])
		})
		assert.notEqual(index, -1)
		const separator = lines[index].indexOf('||')
		const header = JSON.parse(lines[index].slice(0, separator))
		const data = JSON.parse(lines[index].slice(separator + 2).replace(/\|$/, ''))
		data.ruleContext.padTopExpan = 4
		lines[index] = `${JSON.stringify(header)}||${JSON.stringify(data)}|`
		return lines.join('\n')
	}
	await assert.rejects(update({ dryRun: false, changes: [{ path: solderTopPadPath, value: 0.0762 }] }, context()), /读回与预期不符/)
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, 'a SOLDER raw value inconsistent with the getter is rejected')

	for (const [group, rule, family, fields] of [
		['Solder Mask Expansion', 'solderMaskExpansion', 'SOLDER', { padToplayerExpansion: 'padTopExpan', padBottomlayerExpansion: 'padBotExpan', viaToplayerExpansion: 'viaTopExpan', viaBottomlayerExpansion: 'viaBotExpan', testPointToplayerExpansion: 'testPointTopExpan', testPointBottomlayerExpansion: 'testPointBotExpan' }],
		['Paste Mask Expansion', 'pasteMaskExpansion', 'PASTE', { padToplayerExpansion: 'padTopExpan', padBottomlayerExpansion: 'padBotExpan', testPointToplayerExpansion: 'testPointTopExpan', testPointBottomlayerExpansion: 'testPointBotExpan' }],
	]) {
		for (const [field, sourceField] of Object.entries(fields)) {
			state = reset()
			const path = ['config', 'Expansion', group, rule, 'form', field]
			const current = state.configuration.config.Expansion[group][rule].form[field]
			const value = current < 0 ? -25.3746 : 0.0762
			state.expansionRoundtripPaths = [path]
			const result = await update({ dryRun: false, changes: [{ path, value }] }, context())
			assert.equal(result.configuration.status, 'applied', `${family}.${field} uses its captured source field mapping`)
			assert.ok(result.configuration.normalizations.some(item => item.path.join('.') === path.join('.') && item.sourcePath === `RULE ${family} ${rule}.ruleContext.${sourceField}`), `${family}.${field} normalization reports its exact raw field`)
		}
	}

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

	const newTrackPath = ['config', 'Physics', 'Track', newTrackFixture.ruleName]
	const newTrackGetterPath = [...newTrackPath, 'form', 'data', '1', 'minValue']
	state = reset()
	state.document.uuid = newTrackFixture.documentUuid
	state.source = makeSource()
	state.quantizePaths = [newTrackGetterPath]
	const newTrackSourceBaseline = state.source
	state.sourceAfterConfigurationWrite = generated => generated
	const createdTrackRule = await update({ dryRun: false, changes: [{ path: newTrackPath, value: clone(newTrackFixture.request) }] }, context())
	assert.equal(createdTrackRule.configuration.status, 'applied', 'a new complete TRACK rule accepts only the source-confirmed native value representation')
	assert.equal(state.configuration.config.Physics.Track[newTrackFixture.ruleName].form.data['1'].minValue, newTrackFixture.getterAfter.form.data['1'].minValue)
	assert.ok(createdTrackRule.configuration.normalizations.some(item => item.path.join('.') === newTrackGetterPath.join('.') && item.normalizedMil === 12 && item.sourceVerified === true))
	const oldSafeSourceLine = newTrackSourceBaseline.split(/\r?\n/).find(line => line.includes('[\\"RULE\\",\\"SAFE\\",\\"copperThickness1oz\\"]'))
	const newSafeSourceLine = state.source.split(/\r?\n/).find(line => line.includes('[\\"RULE\\",\\"SAFE\\",\\"copperThickness1oz\\"]'))
	assert.ok(oldSafeSourceLine && newSafeSourceLine && oldSafeSourceLine !== newSafeSourceLine, 'source tickets/line positions change when the SDK rewrites the log, even though SAFE data is unchanged')
	assert.deepEqual(createdTrackRule.configuration.sourceRuleChanges.find(item => item.record.includes(newTrackFixture.ruleName)), {
		record: createdTrackRule.configuration.sourceRuleChanges.find(item => item.record.includes(newTrackFixture.ruleName)).record,
		before: null,
		after: { ruleState: 'NORMAL', ruleContext: { unit: 'mm', track: { isOpen: true, content: newTrackFixture.sourceAfter.rows } } },
		rawSourceFullyMapped: false,
		reason: '新TRACK的全部层与min/default/max源码值均已核对；目标记录其余内部字段不作映射',
	})
	assert.equal(state.writes.configuration, 1)

	const prepareDeleteTrack = () => {
		state = reset()
		state.document.uuid = newTrackFixture.documentUuid
		state.configuration.config.Physics.Track[newTrackFixture.ruleName] = clone(newTrackFixture.getterAfter)
		state.preserveConfigurationName = true
		state.source = makeSource()
	}

	prepareDeleteTrack()
	const deletePreview = await deleteTrackRule({ name: newTrackFixture.ruleName }, context())
	assert.equal(deletePreview.dryRun, true, 'TRACK rule deletion defaults to preview')
	assert.equal(deletePreview.status, 'planned')
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'TRACK delete preview performs no SDK writes')

	prepareDeleteTrack()
	state.configuration.config.Physics.Track[newTrackFixture.ruleName].isSetDefault = true
	state.source = makeSource()
	await assert.rejects(deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context()), /非默认/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'default TRACK rule cannot be deleted')

	prepareDeleteTrack()
	state.netRules[0].Track = newTrackFixture.ruleName
	state.source = makeSource()
	await assert.rejects(deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context()), /仍被引用/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'getter binding reference blocks TRACK deletion')

	prepareDeleteTrack()
	state.source = updateSourceSelector(state.source, 'NET', 'UNBOUND_SOURCE_REFERENCE', data => ({
		...data, ruleKeyValue: { ...data.ruleKeyValue, TRACK: newTrackFixture.ruleName },
	}))
	await assert.rejects(deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context()), /仍被引用/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'explicit source reference blocks TRACK deletion even if getter binding is absent')

	prepareDeleteTrack()
	state.driftSpacingAfterWrite = true
	const deleteResult = await deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context())
	assert.equal(deleteResult.status, 'deleted')
	assert.equal(deleteResult.verified, true)
	assert.equal(deleteResult.saved, false, 'immediate readback does not claim saved persistence')
	assert.ok(deleteResult.normalizations.some(item => item.sourceVerified === true && item.normalizedMil === 6.929), 'deletion permits only the existing raw-stable SAFE getter tail normalization')
	assert.equal(Object.hasOwn(state.configuration.config.Physics.Track, newTrackFixture.ruleName), false)
	assert.equal(resolvedSourceForTest(state.source).has(`RULE\0${JSON.stringify(['RULE', 'TRACK', newTrackFixture.ruleName])}`), false)
	assert.deepEqual(state.netRules, fixture.netRules, 'deleting an unreferenced rule preserves all network bindings')
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, 'TRACK definition deletion uses one configuration write')

	prepareDeleteTrack()
	state.sourceAfterConfigurationWrite = generated => updateSafeSource(generated, data => {
		const content = data.ruleContext.safeSpacing[0].content.map(row => [...row])
		content[0][0] += 1
		return { ...data, ruleContext: { ...data.ruleContext, safeSpacing: [{ ...data.ruleContext.safeSpacing[0], content }] } }
	})
	await assert.rejects(deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context()), /无法确认删除结果/)
	assert.equal(state.writes.configuration, 1, 'non-target source mutation after delete is reported after the single dispatched write')

	prepareDeleteTrack()
	state.configurationAfterWrite = config => { config.Physics.Track[newTrackFixture.ruleName] = clone(newTrackFixture.getterAfter) }
	state.sourceAfterConfigurationWrite = generated => generated.split(/\r?\n/).filter(line => {
		const separator = line.indexOf('||')
		if (separator < 0) return true
		const header = JSON.parse(line.slice(0, separator))
		return !(header.type === 'RULE' && header.id === JSON.stringify(['RULE', 'TRACK', newTrackFixture.ruleName]))
	}).join('\n')
	await assert.rejects(deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context()), /getter 仍包含目标 TRACK/)
	assert.equal(state.writes.configuration, 1, 'a missing raw record cannot hide a stale getter definition')

	prepareDeleteTrack()
	state.writeBehavior.configuration = 'noapply-false'
	await assert.rejects(deleteTrackRule({ name: newTrackFixture.ruleName, dryRun: false }, context()), /无法确认删除结果/)
	assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, 'unknown TRACK delete outcome does not retry or roll back')

	state = reset()
	state.document.uuid = newTrackFixture.documentUuid
	state.source = makeSource()
	state.quantizePaths = [newTrackGetterPath]
	const combinedSafePath = ['config', 'Spacing', 'Safe Spacing', 'copperThickness1oz', 'tables', '1', 'content', '0', '0']
	const combinedSolderPath = ['config', 'Expansion', 'Solder Mask Expansion', 'solderMaskExpansion', 'form', 'padToplayerExpansion']
	state.expansionRoundtripPaths = [combinedSolderPath]
	const combinedSourceBaseline = state.source
	state.sourceAfterConfigurationWrite = generated => appendRuleSourceRecords(combinedSourceBaseline, generated, [
		['TRACK', newTrackFixture.ruleName],
		['SAFE', 'copperThickness1oz'],
		['SOLDER', 'solderMaskExpansion'],
	])
	const combinedRules = await update({ dryRun: false, changes: [
		{ path: newTrackPath, value: clone(newTrackFixture.request) },
		{ path: combinedSafePath, value: 0.2 },
		{ path: combinedSolderPath, value: 0.0762 },
	] }, context())
	assert.equal(combinedRules.configuration.status, 'applied', 'new TRACK creation can coexist with explicit SAFE and SOLDER changes')
	assert.ok(combinedRules.configuration.sourceRuleChanges.some(item => item.record.includes('SAFE') && item.rawSourceFullyMapped === false))
	assert.ok(combinedRules.configuration.sourceRuleChanges.some(item => item.record.includes('SOLDER') && item.rawSourceFullyMapped === false))
	assert.equal(state.writes.configuration, 1)

	const rejectedNewTrack = async (mutate, message) => {
		state = reset()
		state.document.uuid = newTrackFixture.documentUuid
		state.source = makeSource()
		state.quantizePaths = [newTrackGetterPath]
		const sourceBaseline = state.source
		mutate()
		const sourceMutation = state.sourceAfterConfigurationWrite
		state.sourceAfterConfigurationWrite = generated => sourceMutation?.(appendTrackSourceRecord(sourceBaseline, generated, newTrackFixture.ruleName)) ?? appendTrackSourceRecord(sourceBaseline, generated, newTrackFixture.ruleName)
		await assert.rejects(update({ dryRun: false, changes: [{ path: newTrackPath, value: clone(newTrackFixture.request) }] }, context()), /读回与预期不符|源码存在未授权变化/)
		assert.deepEqual(state.writes, { configuration: 1, netRules: 0 }, message)
	}
	await rejectedNewTrack(() => {
		state.sourceAfterConfigurationWrite = source => updateTrackSource(source, newTrackFixture.ruleName, data => {
			const content = data.ruleContext.track.content.map((row, index) => index ? row : { ...row, stroMin: 13 })
			return { ...data, ruleContext: { ...data.ruleContext, track: { ...data.ruleContext.track, content } } }
		})
	}, 'wrong raw TRACK value cannot normalize the getter difference')
	await rejectedNewTrack(() => {
		state.sourceAfterConfigurationWrite = source => source.split(/\r?\n/).filter(line => !line.includes(newTrackFixture.ruleName)).join('\n')
	}, 'missing raw new TRACK record is rejected')
	await rejectedNewTrack(() => {
		state.sourceAfterConfigurationWrite = source => updateTrackSource(source, newTrackFixture.ruleName, data => ({ ...data, ruleContext: { ...data.ruleContext, track: { ...data.ruleContext.track, content: [...data.ruleContext.track.content, clone(data.ruleContext.track.content[0])] } } }))
	}, 'duplicate layer row is rejected')
	for (const [label, change] of [
		['editName', rule => { rule.editName = 'OTHER_TRACK' }],
		['isSetDefault', rule => { rule.isSetDefault = true }],
		['form.status', rule => { rule.form.status = 0 }],
	]) {
		await rejectedNewTrack(() => { state.configurationAfterWrite = config => change(config.Physics.Track[newTrackFixture.ruleName]) }, `${label} readback remains strict`)
	}
	await rejectedNewTrack(() => {
		state.sourceAfterConfigurationWrite = source => updateTrackSource(source, 'copperThickness1oz', data => {
			const content = data.ruleContext.track.content.map((row, index) => index ? row : { ...row, stroMin: row.stroMin + 1 })
			return { ...data, ruleContext: { ...data.ruleContext, track: { ...data.ruleContext.track, content } } }
		})
	}, 'non-target TRACK source changes are rejected')

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
	const differentialMaxPath = ['config', 'Physics', 'Differential Pair', 'differentialPair', 'form', 'diffPairSpacingTables', 'data', '1', 'maxValue']
	const differentialMaxRulePath = ['config', 'Physics', 'Differential Pair', 'differentialPair']
	const differentialRuleWithMax = clone(fixture.configuration.config.Physics['Differential Pair'].differentialPair)
	differentialRuleWithMax.form.diffPairSpacingTables.data['1'].maxValue = 0.508
	for (const change of [
		{ path: differentialMaxPath, value: 0.508 },
		{ path: differentialMaxPath.slice(0, -1), value: { minValue: 0.15, defaultValue: 0.2, maxValue: 0.508 } },
		{ path: differentialMaxRulePath, value: differentialRuleWithMax },
	]) {
		state = reset()
		await assert.rejects(update({ dryRun: false, changes: [change] }, context()), /maxValue 当前没有对应的源码字段/)
		assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'non-null differential spacing max is rejected before any SDK write')
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
	let safeSourceReadCount = 0
	state.onConfigurationRead = () => {
		if (++safeSourceReadCount === 2)
			state.source = updateSafeSource(state.source ?? makeSource(), data => { data.ruleContext.safeSpacing[0].content[safeCellFixture.getterCell.row][safeCellFixture.getterCell.column] = 7; return data })
	}
	await assert.rejects(update({ dryRun: false, changes: [{ path: safeGetterCellPath, value: 0.254 }] }, context()), /原始快照已变化|快照已变化/)
	assert.deepEqual(state.writes, { configuration: 0, netRules: 0 }, 'a real SAFE source edit after the baseline is rejected before the writer')

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
