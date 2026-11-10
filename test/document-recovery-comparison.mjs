import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const bundle = 'test/.document-recovery-comparison.mjs'
try {
	await build({ entryPoints: ['src/engine/documentRecovery.ts'], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' })
	const { assertSnapshotFocused, captureDocumentSnapshot, compareDocumentSources, withDocumentRecovery } = await import(pathToFileURL(resolve(bundle)).href)
	const checkEqual = (expected, actual, message) => assert.equal(compareDocumentSources(expected, actual).equal, true, message)
	const checkDifferent = (expected, actual, message) => assert.equal(compareDocumentSources(expected, actual).equal, false, message)
	const source = (head, records) => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0, id: 'head' })}||${JSON.stringify(head)}|\n${records.map(([header, data]) => `${JSON.stringify(header)}||${JSON.stringify(data)}|`).join('\n')}`
	const original = source(
		{ docType: 'SCH_PAGE', uuid: 'doc-1', client: 'old', updateTime: 1, version: '1', future: { keep: true } },
		[[{ type: 'RULE', ticket: 1, id: 'rule-1', extraHeader: 'kept' }, { rule: { width: 10, spacing: [1, 2] } }], [{ type: 'NET', ticket: 2, id: 'net-1' }, { name: 'N1' }]],
	)
	const reordered = source(
		{ version: '2', updateTime: 99, client: 'new', uuid: 'doc-1', future: { keep: true }, docType: 'SCH_PAGE' },
		[[{ id: 'net-1', type: 'NET', ticket: 99 }, { name: 'N1' }], [{ extraHeader: 'kept', id: 'rule-1', ticket: 88, type: 'RULE' }, { rule: { spacing: [1, 2], width: 10 } }]],
	)
	checkEqual(original, reordered, 'allow only DOCHEAD metadata, ticket, record order, and object-key order changes')

	const replace = (sourceText, from, to) => sourceText.replace(from, to)
	checkDifferent(original, replace(reordered, '"width":10', '"width":11'), 'reject changed payload')
	checkDifferent(original, replace(reordered, '"spacing":[1,2]', '"spacing":[2,1]'), 'preserve array order')
	checkDifferent(original, replace(reordered, '"future":{"keep":true}', '"future":{"keep":false}'), 'compare unknown DOCHEAD fields')
	checkDifferent(original, replace(reordered, '"uuid":"doc-1"', '"uuid":"doc-2"'), 'preserve UUID')
	checkDifferent(original, replace(reordered, '"docType":"SCH_PAGE"', '"docType":"PCB"'), 'preserve document type')
	checkDifferent(original, replace(reordered, '"type":"RULE"', '"type":"VIA"'), 'preserve record type')
	checkDifferent(original, `${original}\n{"type":"NEW","id":"new-1"}||{}|`, 'reject added record')
	checkDifferent(original, original.replace(/\n\{"type":"NET"[^\n]+/, ''), 'reject deleted record')
	const malformed = original.replace('"spacing":[1,2]', 'bad-json')
	checkDifferent(original, malformed, 'reject malformed readback source')
	assert.equal(compareDocumentSources(malformed, malformed).equal, true, 'identical malformed strings compare equal only by exact string identity')
	const arrayPayload = source({ docType: 'PCB', uuid: 'array-shape' }, [[{ type: 'DATA', id: 'payload' }, { value: [1] }]])
	const objectPayload = source({ docType: 'PCB', uuid: 'array-shape' }, [[{ type: 'DATA', id: 'payload' }, { value: { 0: 1 } }]])
	checkDifferent(arrayPayload, objectPayload, 'distinguish arrays from numeric-key objects')
	const protoHead = Object.create(null)
	Object.assign(protoHead, { docType: 'PCB', uuid: 'proto-key' })
	Object.defineProperty(protoHead, '__proto__', { value: { retained: 'before' }, enumerable: true })
	const changedProtoHead = Object.create(null)
	Object.assign(changedProtoHead, { docType: 'PCB', uuid: 'proto-key' })
	Object.defineProperty(changedProtoHead, '__proto__', { value: { retained: 'after' }, enumerable: true })
	checkDifferent(source(protoHead, []), source(changedProtoHead, []), 'preserve unknown own __proto__ field')
	const emptyNetId = '["RULE_SELECTOR",["NET",""]]'
	const emptyNetBefore = source({ docType: 'PCB', uuid: 'empty-net' }, [[{ type: 'RULE_SELECTOR', id: emptyNetId }, { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null }]])
	const emptyNetDefault = source({ docType: 'PCB', uuid: 'empty-net' }, [[{ type: 'RULE_SELECTOR', id: emptyNetId }, { ruleOrder: 4, ruleKeyValue: { NET_LENGTH_TOLERANCE: ['default', null] }, copperValue: {}, innerPlaneValue: {}, parent: null }]])
	const defaultResult = compareDocumentSources(emptyNetBefore, emptyNetDefault)
	assert.equal(defaultResult.equal, true, 'allow only canonical empty-net NET_LENGTH_TOLERANCE default')
	assert.deepEqual(defaultResult.normalizations, ['PCB empty-net default NET_LENGTH_TOLERANCE'], 'report the single applied normalization')
	checkDifferent(emptyNetBefore, source({ docType: 'PCB', uuid: 'empty-net' }, [[{ type: 'RULE_SELECTOR', id: emptyNetId }, { ruleOrder: 5, ruleKeyValue: { NET_LENGTH_TOLERANCE: ['default', null] }, copperValue: {}, innerPlaneValue: {}, parent: null }]]), 'keep other selector fields strict')
	for (const value of [['default', 0], ['default', null, 'extra'], null, 0]) {
		const wrongDefault = source({ docType: 'PCB', uuid: 'empty-net' }, [[{ type: 'RULE_SELECTOR', id: emptyNetId }, { ruleOrder: 4, ruleKeyValue: { NET_LENGTH_TOLERANCE: value }, copperValue: {}, innerPlaneValue: {}, parent: null }]])
		checkDifferent(emptyNetBefore, wrongDefault, `reject different default value ${JSON.stringify(value)}`)
	}
	checkDifferent(emptyNetBefore, source({ docType: 'SCH_PAGE', uuid: 'empty-net' }, [[{ type: 'RULE_SELECTOR', id: emptyNetId }, { ruleOrder: 4, ruleKeyValue: { NET_LENGTH_TOLERANCE: ['default', null] }, copperValue: {}, innerPlaneValue: {}, parent: null }]]), 'apply normalization to PCB only')
	const anotherNet = '["RULE_SELECTOR",["NET","NET_A"]]'
	checkDifferent(source({ docType: 'PCB', uuid: 'other-net' }, [[{ type: 'RULE_SELECTOR', id: anotherNet }, { ruleKeyValue: {} }]]), source({ docType: 'PCB', uuid: 'other-net' }, [[{ type: 'RULE_SELECTOR', id: anotherNet }, { ruleKeyValue: { NET_LENGTH_TOLERANCE: ['default', null] } }]]), 'keep other net selectors strict')
	const expectedAlreadyHas = source({ docType: 'PCB', uuid: 'reverse' }, [[{ type: 'RULE_SELECTOR', id: emptyNetId }, { ruleKeyValue: { NET_LENGTH_TOLERANCE: ['default', null] } }]])
	checkDifferent(expectedAlreadyHas, emptyNetBefore.replace('"uuid":"empty-net"', '"uuid":"reverse"'), 'do not normalize the reverse missing-key direction')
	const originalEda = globalThis.eda
	let currentSource = emptyNetBefore
	let recoveryWrites = 0
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'empty-net' }) },
		sys_FileManager: {
			setDocumentSource: async savedSource => {
				recoveryWrites++
				assert.equal(savedSource, emptyNetBefore)
				currentSource = emptyNetDefault
				return true
			},
			getDocumentSource: async () => currentSource,
		},
	}
	let recoveryError
	try {
		await withDocumentRecovery({ documentUuid: 'empty-net', documentType: 3, command: 'test', source: emptyNetBefore, storageKey: 'unused' }, async write => {
			await write(async () => { currentSource = emptyNetDefault.replace('"ruleOrder":4', '"ruleOrder":5'); throw new Error('simulated operation failure') })
		})
	}
	catch (error) {
		recoveryError = error
	}
	finally {
		if (originalEda === undefined)
			delete globalThis.eda
		else
			globalThis.eda = originalEda
	}
	assert.equal(recoveryError?.cause?.restored, true, 'mark normalized recovery as restored')
	assert.equal(recoveryError?.cause?.contentRestored, true, 'mark content restoration explicitly')
	assert.deepEqual(recoveryError?.cause?.normalizations, ['PCB empty-net default NET_LENGTH_TOLERANCE'], 'carry applied normalization in recovery cause')
	assert.equal(recoveryWrites, 1, 'a changed document follows the normal restore path')
	const pcbNoopSource = source({ docType: 'PCB', uuid: 'poured-noop' }, [[{ type: 'POURED', id: 'pour-1' }, { fill: [[1, 2, 3]] }]])
	let noopRestoreWrites = 0
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'poured-noop' }) },
		sys_FileManager: {
			getDocumentSource: async () => pcbNoopSource,
			setDocumentSource: async () => { noopRestoreWrites++; return true },
		},
	}
	let noopFailure
	try {
		await withDocumentRecovery({ documentUuid: 'poured-noop', documentType: 3, command: 'test', source: pcbNoopSource, storageKey: 'unused' }, async write => {
			await write(async () => { throw new Error('operation failed without changing the document') })
		})
	}
	catch (error) { noopFailure = error }
	assert.equal(noopFailure?.message.includes('读回确认原文档内容未变，未执行恢复写入'), true)
	assert.equal(noopFailure?.cause?.restored, true)
	assert.equal(noopFailure?.cause?.contentRestored, true)
	assert.equal(noopFailure?.cause?.noRecoveryWriteNeeded, true)
	assert.equal(noopFailure?.cause?.retryable, true)
	assert.equal(noopFailure?.cause?.operationError, 'operation failed without changing the document')
	assert.equal(noopFailure?.cause?.recovery?.source, pcbNoopSource)
	assert.equal(noopRestoreWrites, 0, 'an unchanged document with POURED does not need a recovery write')
	const schematicNoopSource = source({ docType: 'SCH_PAGE', uuid: 'schematic-noop' }, [[{ type: 'WIRE', id: 'wire-1' }, { net: 'N1', points: [[0, 0], [1, 1]] }]])
	let schematicNoopWrites = 0
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'schematic-noop' }) },
		sys_FileManager: { getDocumentSource: async () => schematicNoopSource, setDocumentSource: async () => { schematicNoopWrites++; return true } },
	}
	let schematicNoopFailure
	try {
		await withDocumentRecovery({ documentUuid: 'schematic-noop', documentType: 1, command: 'test', source: schematicNoopSource, storageKey: 'unused' }, async write => {
			await write(async () => { throw new Error('schematic operation failed') })
		})
	}
	catch (error) { schematicNoopFailure = error }
	assert.equal(schematicNoopFailure?.cause?.noRecoveryWriteNeeded, true, 'the unchanged-source shortcut validates SCH_PAGE against documentType=1')
	assert.equal(schematicNoopWrites, 0)

	for (const [type, id, data, changedData] of [
		['LINE', 'line-1', { net: 'N1', width: 8 }, { net: 'N1', width: 9 }],
		['NET', 'net-1', { name: 'N1' }, { name: 'N2' }],
		['POUR', 'pour-1', { layer: 1, net: 'GND' }, { layer: 1, net: 'VCC' }],
		['POURED', 'poured-1', { fill: [[1, 2, 3]] }, { fill: [[1, 2, 4]] }],
	]) {
		const beforeSource = source({ docType: 'PCB', uuid: `changed-${type}` }, [[{ type, id }, data]])
		const changedSource = source({ docType: 'PCB', uuid: `changed-${type}` }, [[{ type, id }, changedData]])
		let observedSource = changedSource
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: `changed-${type}` }) },
			sys_FileManager: {
				getDocumentSource: async () => observedSource,
				setDocumentSource: async savedSource => { writes++; observedSource = beforeSource; assert.equal(savedSource, beforeSource); return true },
			},
		}
		let changedFailure
		try {
			await withDocumentRecovery({ documentUuid: `changed-${type}`, documentType: 3, command: 'test', source: beforeSource, storageKey: 'unused' }, async write => {
				await write(async () => { throw new Error(`${type} changed`) })
			})
		}
		catch (error) { changedFailure = error }
		assert.equal(changedFailure?.cause?.restored, true, `${type} difference must restore the source`)
		assert.equal(changedFailure?.cause?.noRecoveryWriteNeeded, undefined)
		assert.equal(writes, 1, `${type} difference must invoke setDocumentSource`)
	}

	for (const [label, firstRead] of [
		['empty', ''],
		['invalid', 'not a source log'],
		['read exception', new Error('probe read failed')],
		['wrong UUID', source({ docType: 'PCB', uuid: 'other' }, [])],
		['wrong doc type', source({ docType: 'SCH_PAGE', uuid: 'invalid-check' }, [])],
	]) {
		const target = source({ docType: 'PCB', uuid: 'invalid-check' }, [])
		let reads = 0
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'invalid-check' }) },
			sys_FileManager: {
				getDocumentSource: async () => {
					const value = ++reads === 1 ? firstRead : target
					if (value instanceof Error) throw value
					return value
				},
				setDocumentSource: async savedSource => { writes++; assert.equal(savedSource, target); return true },
			},
		}
		let invalidFailure
		try {
			await withDocumentRecovery({ documentUuid: 'invalid-check', documentType: 3, command: 'test', source: target, storageKey: 'unused' }, async write => {
				await write(async () => { throw new Error(`${label} pre-restore source`) })
			})
		}
		catch (error) { invalidFailure = error }
		assert.equal(invalidFailure?.cause?.restored, true, `${label} probe must use the normal restore path`)
		assert.equal(invalidFailure?.cause?.noRecoveryWriteNeeded, undefined)
		assert.equal(writes, 1)
	}

	{
		const target = source({ docType: 'PCB', uuid: 'focus-race' }, [])
		const focus = [{ documentType: 3, uuid: 'focus-race' }, { documentType: 3, uuid: 'focus-race' }, { documentType: 3, uuid: 'other-doc' }, { documentType: 3, uuid: 'other-doc' }]
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => focus.shift() ?? { documentType: 3, uuid: 'other-doc' } },
			sys_FileManager: { getDocumentSource: async () => target, setDocumentSource: async () => { writes++; return true } },
		}
		let focusFailure
		try {
			await withDocumentRecovery({ documentUuid: 'focus-race', documentType: 3, command: 'test', source: target, storageKey: 'unused' }, async write => {
				await write(async () => { throw new Error('operation failed while focus changes') })
			})
		}
		catch (error) { focusFailure = error }
		assert.equal(focusFailure?.cause?.partial, true)
		assert.equal(focusFailure?.cause?.restored, false)
		assert.equal(writes, 0, 'a focus race must not write recovery source into the other document')
	}

	{
		const target = source({ docType: 'PCB', uuid: 'late-probe' }, [])
		let reads = 0
		let focusReads = 0
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => { focusReads++; return { documentType: 3, uuid: 'late-probe' } } },
			sys_FileManager: {
				getDocumentSource: async () => ++reads === 1 ? new Promise(resolve => setTimeout(() => resolve(target), 700)) : target,
				setDocumentSource: async savedSource => { writes++; assert.equal(savedSource, target); return true },
			},
		}
		let lateFailure
		try {
			await withDocumentRecovery({ documentUuid: 'late-probe', documentType: 3, command: 'test', source: target, storageKey: 'unused' }, async write => {
				await write(async () => { throw new Error('operation requires timeout fallback') })
			})
		}
		catch (error) { lateFailure = error }
		assert.equal(lateFailure?.cause?.restored, true, 'probe timeout continues into ordinary recovery')
		assert.equal(writes, 1)
		const focusReadsAfterReturn = focusReads
		const returnedCause = JSON.stringify(lateFailure.cause)
		await new Promise(resolve => setTimeout(resolve, 300))
		assert.equal(focusReads, focusReadsAfterReturn, 'a late source read cannot start a second focus check')
		assert.equal(JSON.stringify(lateFailure.cause), returnedCause, 'a late source read cannot change the returned recovery result')
	}
	{
		let sourceReads = 0
		const writes = []
		const key = 'ai-command-engine:destructive-recovery:pcb.importAutoRouteSes:locked-B'
		const saved = new Map([[key, 'original-B-snapshot-bytes']])
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'locked-B' }) },
			sys_FileManager: { getDocumentSource: async () => { sourceReads++; return source({ docType: 'PCB', uuid: 'locked-B' }, []) } },
			sys_Storage: {
				setExtensionUserConfig: async (storageKey, value) => { writes.push([storageKey, value]); saved.set(storageKey, value); return true },
				getExtensionUserConfig: storageKey => saved.get(storageKey),
			},
		}
		await assert.rejects(() => captureDocumentSnapshot('pcb.importAutoRouteSes', 3, 'preflight-A'), /快照目标 UUID 与预期不一致/)
		assert.equal(sourceReads, 0, 'reject focus change before reading the new document source')
		assert.equal(writes.length, 0, 'reject focus change before writing any snapshot')
		assert.equal(saved.get(key), 'original-B-snapshot-bytes', 'preserve the prior recovery snapshot byte-for-byte')
		const legacyCall = await captureDocumentSnapshot('legacy-command', 3)
		assert.equal(legacyCall.documentUuid, 'locked-B', 'calls without expected UUID retain the existing behavior')
		let tabId = 'locked-B@project-b'
		globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ documentType: 3, uuid: 'locked-B', tabId })
		await assert.rejects(() => captureDocumentSnapshot('pcb.importAutoRouteSes', 3, 'locked-B', 'locked-B@project-a'), /快照目标页签与预期不一致/)
		const bound = await captureDocumentSnapshot('pcb.importAutoRouteSes', 3, 'locked-B', tabId)
		tabId = 'locked-B@project-a'
		await assert.rejects(() => assertSnapshotFocused(bound), /焦点文档已变化/)
	}
	const ambiguous = source({ docType: 'PCB', uuid: 'doc-2' }, [[{ type: 'LINE', id: 'same', ticket: 1 }, {}], [{ type: 'LINE', id: 'same', ticket: 2 }, {}]])
	assert.equal(compareDocumentSources(ambiguous, ambiguous).equal, true, 'allow exact-string equality for repeated identities')
	assert.equal(compareDocumentSources(ambiguous, ambiguous.replace('"ticket":1', '"ticket":9')).equal, false, 'do not normalize repeated identities')

	const added = compareDocumentSources(original, `${original}\n{"type":"NEW","id":"new-1"}||{}|`)
	assert.match(added.difference, /added in readback/, 'identify added readback record')

	const evidenceRootArg = process.env.DOCUMENT_RECOVERY_EVIDENCE_ROOT ?? process.argv[2]
	if (evidenceRootArg) {
		const evidenceRoot = resolve(evidenceRootArg)
		const before = await readFile(join(evidenceRoot, 'installed-validation-20261007/recovery-before-source.txt'), 'utf8')
		const after = await readFile(join(evidenceRoot, 'installed-validation-20261007/recovery-after-source.txt'), 'utf8')
		checkEqual(before, after, 'accept both installed source samples as content-equivalent')
		const controlsBefore = JSON.parse(await readFile(join(evidenceRoot, 'move-api-repro-20261007/pcb-control-lines-before.json'), 'utf8'))
		const controlsAfter = JSON.parse(await readFile(join(evidenceRoot, 'move-api-repro-20261007/pcb-control-lines-after.json'), 'utf8'))
		// 4.1.60 normal save/close/open host samples: 148 records; getNetRules is empty and configuration matches.
		assert.deepEqual(controlsBefore.result.netRules, [])
		assert.deepEqual(controlsAfter.result.netRules, [])
		assert.deepEqual(controlsBefore.result.configuration, controlsAfter.result.configuration)
		const controlComparison = compareDocumentSources(controlsBefore.result.source, controlsAfter.result.source)
		assert.equal(controlComparison.equal, true, 'normalize normal-save empty-net selector default')
		assert.deepEqual(controlComparison.normalizations, ['PCB empty-net default NET_LENGTH_TOLERANCE'])
		const actualRuleMutation = controlsBefore.result.source.replace(/\{"type":"RULE"[^\n]*/, line => {
			const separator = line.indexOf('||')
			const header = line.slice(0, separator)
			const rawData = line.slice(separator + 2).replace(/\|$/, '')
			const data = JSON.parse(rawData)
			data.ruleState = 'RECOVERY_TEST_DIFFERENCE'
			return `${header}||${JSON.stringify(data)}|`
		})
		assert.notEqual(actualRuleMutation, controlsBefore.result.source, 'host source contains an editable RULE record')
		const actualRuleMismatch = compareDocumentSources(controlsBefore.result.source, actualRuleMutation)
		assert.equal(actualRuleMismatch.equal, false, 'reject a real PCB rule payload change')
		assert.match(actualRuleMismatch.difference, /RULE/, 'identify the changed real PCB rule')
		const probe = JSON.parse(await readFile(join(evidenceRoot, 'move-api-repro-20261007/pcb-recovery-probe.json'), 'utf8'))
		const probeComparison = compareDocumentSources(probe.result.error.cause.recovery.source, probe.result.afterSource)
		assert.equal(probeComparison.equal, true, 'accept PCB recovery probe after only canonical empty-net default')
		assert.deepEqual(probeComparison.normalizations, ['PCB empty-net default NET_LENGTH_TOLERANCE'])
		console.log(`PASS  real PCB source comparison applied ${controlComparison.normalizations.join(', ')}`)
	}
	else {
		console.log('SKIP real-host-fixtures (set DOCUMENT_RECOVERY_EVIDENCE_ROOT or pass evidenceRoot)')
	}
	console.log('PASS  document recovery comparison and installed-source checks')
}
finally {
	await rm(bundle, { force: true })
}
