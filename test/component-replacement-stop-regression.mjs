import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'ace-replacement-stop-'))
try {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/modules/reuse/componentReplacement.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
  const path = join(temp, 'component-replacement.mjs')
  await writeFile(path, bundle.outputFiles[0].contents)
  const { createComponentReplacementService } = await import(pathToFileURL(path))
  const records = new Map()
  const plan = { schema: 1, planId: 'plan-1', projectUuid: 'project-1', boardUuid: 'board-1', inputFingerprint: 'fingerprint', createdAt: 1, prepared: { replacements: [{ localRoutes: [], schematicParts: [{}] }] } }
  records.set('plan:plan-1', plan)
  const writes = []
  let resolveStage
  const stageGate = new Promise(resolve => { resolveStage = resolve })
  const host = {
    readPlan: async id => records.get(`plan:${id}`), writePlan: async value => records.set(`plan:${value.planId}`, value),
    readOperation: async id => records.get(`operation:${id}`), writeOperation: async value => records.set(`operation:${value.operationId}`, JSON.parse(JSON.stringify(value))),
    assertPlanStillCurrent: async () => {},
    performStage: async (_prepared, _index, stage, context) => {
      writes.push(`start:${stage}`)
      context.assertActive?.()
      await stageGate
      context.assertActive?.()
      writes.push(`complete:${stage}`)
      return { stage }
    },
    saveCloseReopen: async () => ({ saved: true }), verifyFinal: async () => ({ ok: true }),
  }
  const service = createComponentReplacementService(host, () => 'fixed-id')
  let stopped = false
  const stopSignal = { assertActive() { if (stopped) throw new Error('stopped') } }
  const running = service.executeReplacement({ planId: 'plan-1', operationId: 'op-1' }, stopSignal)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(writes, ['start:pcb_create_candidate'])
  stopped = true
  resolveStage()
  await running
  assert.deepEqual(writes, ['start:pcb_create_candidate'], 'must not run later stage after the delayed write returns')
  const operation = records.get('operation:op-1')
  assert.equal(operation.status, 'unknown')
  assert.equal(operation.phase, '0:pcb_create_candidate')
  assert.equal(operation.writeAttempted, true)
  console.log('PASS delayed replacement stage observes latched stop; no later stage starts; operation remains unknown')

  const finalRecords = new Map([['plan:plan-2', { ...plan, planId: 'plan-2' }]])
  let stoppedDuringConfirmation = false
  const finalHost = {
    readPlan: async id => finalRecords.get(`plan:${id}`), writePlan: async value => finalRecords.set(`plan:${value.planId}`, value),
    readOperation: async id => finalRecords.get(`operation:${id}`),
    writeOperation: async value => {
      finalRecords.set(`operation:${value.operationId}`, JSON.parse(JSON.stringify(value)))
      if (value.status === 'confirmed') stoppedDuringConfirmation = true
    },
    assertPlanStillCurrent: async () => {}, performStage: async (_prepared, _index, stage) => ({ stage }),
    saveCloseReopen: async () => ({ saved: true }), verifyFinal: async () => ({ ok: true }),
  }
  const finalService = createComponentReplacementService(finalHost, () => 'fixed-id')
  const finalSignal = { assertActive() { if (stoppedDuringConfirmation) throw new Error('timeout during confirmation persistence') } }
  const finalOperation = await finalService.executeReplacement({ planId: 'plan-2', operationId: 'op-final' }, finalSignal)
  assert.equal(finalOperation.status, 'unknown', 'late stop during confirmation cannot return confirmed')
  assert.equal(finalRecords.get('operation:op-final').status, 'unknown', 'confirmed marker is corrected back to unknown')
  console.log('PASS stop during final confirmation persistence yields unknown, not confirmed')

  const integrated = await build({ stdin: { contents: `export * from './src/engine/registry.ts'; export { hasActiveModuleExecution } from './src/engine/moduleExecution.ts'`, resolveDir: process.cwd(), sourcefile: 'replacement-stop-registry-entry.ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false })
  const integratedPath = join(temp, 'registry-integrated.mjs')
  await writeFile(integratedPath, integrated.outputFiles[0].contents)
  const registry = await import(pathToFileURL(integratedPath))
  const integrationRecords = new Map([['plan:plan-registry', { ...plan, planId: 'plan-registry' }]])
  const integrationStages = []
  let releaseRegistryStage
  const registryGate = new Promise(resolve => { releaseRegistryStage = resolve })
  const integrationHost = {
    readPlan: async id => integrationRecords.get(`plan:${id}`), writePlan: async value => integrationRecords.set(`plan:${value.planId}`, value),
    readOperation: async id => integrationRecords.get(`operation:${id}`), writeOperation: async value => integrationRecords.set(`operation:${value.operationId}`, JSON.parse(JSON.stringify(value))),
    assertPlanStillCurrent: async () => {},
    performStage: async (_prepared, _index, stage, context) => {
      integrationStages.push(stage)
      await registryGate
      context.assertActive?.()
      return { stage }
    },
    saveCloseReopen: async () => ({ saved: true }), verifyFinal: async () => ({ ok: true }),
  }
  const integrationService = createComponentReplacementService(integrationHost, () => 'fixed-id')
  registry.registerCommand({ name: 'module.executeReplacement', summary: '', params: [], returns: '', handler: (params, context) => integrationService.executeReplacement(params, context.stopSignal) })
  const registryResult = await registry.executeCommand({ cmd: 'module.executeReplacement', params: { planId: 'plan-registry', operationId: 'op-registry', _timeoutMs: 1000 } })
  assert.equal(registryResult.ok, false)
  assert.equal(registryResult.error.cause.source, 'heartbeat-fuse')
  assert.equal(registry.hasActiveModuleExecution(), true, 'raw module execution remains protected after fuse response')
  releaseRegistryStage()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(registry.hasActiveModuleExecution(), false, 'raw execution protection releases only after delayed handler settles')
  assert.deepEqual(integrationStages, ['pcb_create_candidate'], 'no delete or schematic stage starts after fuse')
  assert.equal(integrationRecords.get('operation:op-registry').status, 'unknown')
  console.log('PASS registry fuse + executeReplacement stop signal prevents dependent PCB/SCH stages and holds raw execution guard until settle')
} finally {
  await rm(temp, { recursive: true, force: true })
}
