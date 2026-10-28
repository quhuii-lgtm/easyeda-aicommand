import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
  stdin: { contents: "export { libCommands } from '../src/commands/lib.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'footprint-get-source-library-regression-entry.ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { libCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const getSource = libCommands.find(command => command.name === 'lib.footprintGetSource').handler
const source = readFileSync(resolve(root, 'test/fixtures/footprint-220-project0402.sourcelog'), 'utf8')
const efooSource = readFileSync(resolve(root, 'test/fixtures/component-update-project-footprint.efoo'), 'utf8')
const a16ProjectSource = readFileSync(resolve(root, 'test/fixtures/ac-a16-explicit-project-footprint-source.sourcelog'), 'utf8')
const footprintUuid = '23cc3c617275a8b6'
const a16FootprintUuid = 'b11cd6ee16e22f94'
const encodeSourceWithUuid = uuid => source.replaceAll(footprintUuid, uuid)

{
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => { calls.push('project'); return 'project-lib' },
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push([uuid, libraryUuid]); return efooSource } },
  }
  const result = await getSource({ footprintUuid })
  assert.equal(result.libraryUuid, 'project-lib')
  assert.equal(result.source, efooSource)
  assert.deepEqual(result.query, {
    strategy: 'project-then-personal',
    projectLibrary: 'available',
    personalLibrary: 'not-queried',
    attempts: [{ libraryUuid: 'project-lib', status: 'found' }],
  })
  assert.deepEqual(calls, ['project', [footprintUuid, 'project-lib']])
}

{
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => { calls.push('project'); return 'project-lib' },
      getPersonalLibraryUuid: async () => { calls.push('personal'); throw new Error('must not query personal after project hit') },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push([uuid, libraryUuid]); return a16ProjectSource } },
  }
  const result = await getSource({ footprintUuid: a16FootprintUuid })
  assert.equal(result.libraryUuid, 'project-lib')
  assert.equal(result.source, a16ProjectSource)
  assert.deepEqual(result.query.attempts, [{ libraryUuid: 'project-lib', status: 'found' }])
  assert.deepEqual(calls, ['project', [a16FootprintUuid, 'project-lib']], 'real source with empty-data layer records must not fall back to personal library')
}

{
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => { calls.push('project'); return undefined },
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push([uuid, libraryUuid]); return source } },
  }
  const result = await getSource({ footprintUuid })
  assert.equal(result.libraryUuid, 'personal-lib')
  assert.equal(result.query.projectLibrary, 'unavailable')
  assert.equal(result.query.personalLibrary, 'available')
  assert.deepEqual(calls, ['project', 'personal', [footprintUuid, 'personal-lib']])
}

{
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => { calls.push('project'); return 'project-lib' },
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push([uuid, libraryUuid]); return libraryUuid === 'project-lib' ? undefined : source } },
  }
  const result = await getSource({ footprintUuid })
  assert.equal(result.libraryUuid, 'personal-lib')
  assert.deepEqual(result.query.attempts, [
    { libraryUuid: 'project-lib', status: 'empty' },
    { libraryUuid: 'personal-lib', status: 'found' },
  ])
  assert.deepEqual(calls, ['project', [footprintUuid, 'project-lib'], 'personal', [footprintUuid, 'personal-lib']])
}

{
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => { calls.push('project'); return 'project-lib' },
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push([uuid, libraryUuid]); return undefined } },
  }
  await assert.rejects(() => getSource({ footprintUuid, libraryUuid: 'explicit-lib' }), error => {
    assert.match(error.message, /未找到封装源码/)
    assert.deepEqual(error.cause.footprintSourceQuery.attempts, [{ libraryUuid: 'explicit-lib', status: 'empty' }])
    return true
  })
  assert.deepEqual(calls, [[footprintUuid, 'explicit-lib']], 'explicit library scope never queries or falls back')
}

{
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => 'project-lib',
      getPersonalLibraryUuid: async () => 'personal-lib',
    },
    lib_Footprint: { getDocumentSource: async () => '' },
  }
  await assert.rejects(() => getSource({ footprintUuid }), error => {
    assert.deepEqual(error.cause.footprintSourceQuery.attempts, [
      { libraryUuid: 'project-lib', status: 'empty' },
      { libraryUuid: 'personal-lib', status: 'empty' },
    ])
    return true
  })
}

{
  const sdkError = new Error('worker transport failed')
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => 'project-lib',
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push([uuid, libraryUuid]); throw sdkError } },
  }
  await assert.rejects(() => getSource({ footprintUuid }), error => {
    assert.match(error.message, /SDK 异常/)
    assert.equal(error.cause.sdkError, sdkError)
    assert.deepEqual(error.cause.footprintSourceQuery.attempts, [{ libraryUuid: 'project-lib', status: 'sdk-error' }])
    return true
  })
  assert.deepEqual(calls, [[footprintUuid, 'project-lib']], 'an SDK error is not treated as a missing project-library entry')
}

{
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => 'project-lib',
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { calls.push(libraryUuid); return encodeSourceWithUuid('different-footprint') } },
  }
  await assert.rejects(() => getSource({ footprintUuid }), error => {
    assert.match(error.message, /身份核验失败/)
    assert.deepEqual(error.cause.footprintSourceQuery.attempts, [{ libraryUuid: 'project-lib', status: 'identity-error' }])
    return true
  })
  assert.deepEqual(calls, ['project-lib'], 'source identity mismatch never falls through to another library')
}

for (const [name, invalidSource] of [
  ['wrong DOCHEAD document type', source.replaceAll('"docType":"FOOTPRINT"', '"docType":"SYMBOL"')],
  ['conflicting DOCHEAD UUID', `${source}\n{"type":"DOCHEAD","ticket":999}||{"docType":"FOOTPRINT","uuid":"different-footprint"}|`],
]) {
  const calls = []
  globalThis.eda = {
    lib_LibrariesList: {
      getProjectLibraryUuid: async () => 'project-lib',
      getPersonalLibraryUuid: async () => { calls.push('personal'); return 'personal-lib' },
    },
    lib_Footprint: { getDocumentSource: async () => { calls.push('project-source'); return invalidSource } },
  }
  await assert.rejects(() => getSource({ footprintUuid }), error => {
    assert.match(error.message, /身份核验失败/)
    assert.deepEqual(error.cause.footprintSourceQuery.attempts, [{ libraryUuid: 'project-lib', status: 'identity-error' }])
    return true
  }, name)
  assert.deepEqual(calls, ['project-source'], `${name} must fail without personal-library fallback`)
}

console.log('PASS footprint source query prefers project library, falls back only on empty results, and verifies library/source identity')
