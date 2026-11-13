import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const temp = await mkdtemp(join(tmpdir(), 'ace-registry-stop-'))
try {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/engine/registry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
  const path = join(temp, 'registry.mjs')
  await writeFile(path, bundle.outputFiles[0].contents)
  const registry = await import(pathToFileURL(path))
  let releaseLegacy
  const legacyPending = new Promise(resolve => { releaseLegacy = resolve })
  let legacyDependentWrites = 0
  registry.registerCommand({ name: 'test.legacyTimeout', summary: '', params: [], returns: '', handler: async () => {
    await legacyPending
    legacyDependentWrites++
  } })
  const legacyTimeout = await registry.executeCommand({ cmd: 'test.legacyTimeout', params: { _timeoutMs: 1000 } })
  assert.equal(legacyTimeout.ok, false, 'legacy fuse returns timeout to caller')
  releaseLegacy()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(legacyDependentWrites, 1, 'reproduces old behavior: raw handler continues after timeout response')

  let release
  const pending = new Promise(resolve => { release = resolve })
  let laterWrites = 0
  registry.registerCommand({ name: 'test.latchedStop', summary: '', params: [], returns: '', handler: async (_params, context) => {
    await pending
    try { context.stopSignal.assertActive() } catch { return { stopped: true } }
    laterWrites++
  } })
  const resultPromise = registry.executeCommand({ cmd: 'test.latchedStop', params: { _timeoutMs: 1000 } })
  const result = await resultPromise
  assert.equal(result.ok, false, 'heartbeat fuse returns timeout to caller')
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(laterWrites, 0, 'latched stop blocks dependent work after await')
  console.log('PASS reproduced unguarded late continuation after timeout; guarded replacement continuation stops before dependent work')
} finally { await rm(temp, { recursive: true, force: true }) }

