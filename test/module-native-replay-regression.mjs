import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixtureDir = join(here, 'fixtures', 'module-reuse')
const sourceBytes = new Uint8Array(await readFile(join(fixtureDir, 'A61-036-PERSISTENT-1206-VARIANT.epro2')))
const workcard = JSON.parse(await readFile(join(fixtureDir, 'A63-000-MCU-new-version-workcard.json'), 'utf8'))
const projectUuid = workcard.sourceProjectUuid
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const temp = await mkdtemp(join(tmpdir(), 'ace-module-native-replay-'))

try {
	const built = await build({
		entryPoints: [fileURLToPath(new URL('../src/modules/reuse/moduleExtraction.ts', import.meta.url))],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		write: false,
	})
	const modulePath = join(temp, 'module-extraction.mjs')
	await writeFile(modulePath, built.outputFiles[0].contents)
	const moduleExtraction = await import(pathToFileURL(modulePath).href)
	const storage = new Map()
	let exportCount = 0
	const eda = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: projectUuid, name: 'A61-036-PERSISTENT-1206-VARIANT' }) },
		sys_FileManager: { getProjectFile: async (...args) => {
			exportCount++
			assert.deepEqual(args, ['A61-036-PERSISTENT-1206-VARIANT', undefined, 'epro2'])
			return new File([sourceBytes], 'A61-036-PERSISTENT-1206-VARIANT.epro2', { type: 'application/octet-stream' })
		} },
		sys_Storage: {
			getExtensionUserConfig: key => storage.get(key),
			setExtensionUserConfig: async (key, value) => { storage.set(key, value); return true },
		},
	}
	globalThis.eda = eda
	globalThis.btoa ??= value => Buffer.from(value, 'binary').toString('base64')
	globalThis.atob ??= value => Buffer.from(value, 'base64').toString('binary')

	const captured = await moduleExtraction.captureExtractionSource({ projectUuid })
	assert.equal(captured.sourceSha, hash(sourceBytes), 'capture hash must cover exact archive bytes')
	assert.ok(captured.availableEpru.includes('MODULE-API-A61-PERSISTENT-DEVICE-20261015.epru'))
	assert.ok(captured.documentSummary.some(doc => doc.docType === 'PCB' && doc.uuid === workcard.pcbUuid))
	assert.equal(exportCount, 1)

	await assert.rejects(() => moduleExtraction.extractModuleArchive({
		operationId: 'bad-source-hash', projectUuid, captureId: captured.captureId,
		workcard: { ...workcard, sourceSha256: '0'.repeat(64) },
	}), /sourceSha256/)

	const args = { operationId: 'native-extract', projectUuid, captureId: captured.captureId, workcard }
	const result = await moduleExtraction.extractModuleArchive(args)
	assert.equal(result.state, 'extracted')
	assert.equal(result.outcome, 'confirmed')
	assert.equal(result.contentImported, false)
	assert.equal(result.sha256, hash(Buffer.from(result.base64, 'base64')), 'output archive SHA-256 must verify')
	const outputZip = await (await import('jszip')).default.loadAsync(Buffer.from(result.base64, 'base64'))
	assert.ok(outputZip.file('project2.json'))
	assert.ok(outputZip.file(workcard.outputEpru ?? 'STM32F030C8T6-MCU-CORE-R2-1206.epru'))
	const stateSizeBeforeReplay = storage.size
	const duplicate = await moduleExtraction.extractModuleArchive(args)
	assert.equal(JSON.stringify(duplicate), JSON.stringify(result), 'same operation must return cached extraction without rewriting EDA state')
	assert.equal(storage.size, stateSizeBeforeReplay)
	assert.equal(exportCount, 1)
	await assert.rejects(() => moduleExtraction.extractModuleArchive({
		...args,
		workcard: { ...workcard, newModule: { ...workcard.newModule, name: `${workcard.newModule.name}-different` } },
	}), /operationId.*不同/)

	console.log('module-native-replay-regression: real archive capture, parsing, extraction, hash, output ZIP, cached replay, and source-hash rejection passed')
}
finally {
	await rm(temp, { recursive: true, force: true })
}
