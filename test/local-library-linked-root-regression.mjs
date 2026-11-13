import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLocalLibrary } from '../bridge/local-library.mjs'

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'module-library-linked-root-'))
const realRoot = path.join(sandbox, 'real-library')
const rootAlias = path.join(sandbox, 'library-alias')
const sourceFile = path.join(sandbox, 'module.epro2')
const sourceBytes = Buffer.from('independent module archive')
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

try {
	await mkdir(realRoot)
	await writeFile(sourceFile, sourceBytes)
	await symlink(realRoot, rootAlias, linkType)
	const library = createLocalLibrary(rootAlias)
	const input = {
		localId: 'linked-root-test', version: '1.0.0', source: { projectUuid: 'fixture-project' },
		files: [{ role: 'native', sourcePath: sourceFile, relativePath: 'module.epro2' }],
	}

	const imported = await library.importModule(input)
	assert.equal(imported.storagePath, path.join(rootAlias, 'modules', createHash('sha256').update(input.localId).digest('hex'), 'versions', createHash('sha256').update(input.version).digest('hex')))
	const stored = await library.get(input.localId, input.version)
	assert.deepEqual(stored.files[0].content, sourceBytes, 'stored native bytes and hash verification survive the root alias')
	assert.equal((await library.list()).length, 1)
	await assert.rejects(library.importModule(input), error => error.code === 'VERSION_EXISTS', 'same version is not overwritten')

	const escapeRoot = path.join(sandbox, 'outside-library')
	const escapedSegment = path.join(realRoot, 'modules', createHash('sha256').update('escaped-module').digest('hex'))
	await mkdir(escapeRoot)
	await mkdir(path.dirname(escapedSegment), { recursive: true })
	await symlink(escapeRoot, escapedSegment, linkType)
	await assert.rejects(library.importModule({
		...input, localId: 'escaped-module', version: '1.0.0',
	}), error => error.code === 'PATH_BOUNDARY', 'a child link escaping the selected library stays blocked')
	assert.deepEqual(await readdir(escapeRoot), [], 'a rejected child link receives no library files')
	assert.deepEqual((await readdir(realRoot)).sort(), ['catalog.json', 'modules'], 'the library root contains only its catalog and modules')
	assert.equal(await readFile(sourceFile, 'utf8'), sourceBytes.toString('utf8'), 'source fixture remains unchanged')
	console.log('PASS linked root import, hash-checked readback, duplicate protection and escaping child-link rejection')
}
finally {
	// Remove aliases first so recursive cleanup cannot traverse their targets.
	await rm(path.join(realRoot, 'modules', createHash('sha256').update('escaped-module').digest('hex')), { force: true, recursive: true }).catch(() => {})
	await rm(rootAlias, { force: true })
	await rm(sandbox, { recursive: true, force: true })
}
