import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const bundle = 'test/.document-recovery-comparison.mjs'
try {
	await build({ entryPoints: ['src/engine/documentRecovery.ts'], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node24' })
	const { compareDocumentSources, withDocumentRecovery } = await import(pathToFileURL(resolve(bundle)).href)
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
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'empty-net' }) },
		sys_FileManager: {
			setDocumentSource: async savedSource => {
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
			await write(async () => { throw new Error('simulated operation failure') })
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
