import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `import { projectCommands } from '../src/commands/project.ts'; import { executeCommand, registerCommand } from '../src/engine/registry.ts'; export { projectCommands, executeCommand, registerCommand };`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'project-mutation-outcome-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { projectCommands, executeCommand, registerCommand } = await import(moduleUrl)
for (const command of projectCommands) registerCommand(command)

const definitions = Object.fromEntries(projectCommands.map(command => [command.name, command]))
const clone = value => structuredClone(value)

function makeState() {
	const page = (uuid, parentSchematicUuid) => ({ itemType: 'Schematic Page', uuid, name: uuid, parentSchematicUuid })
	const schematic = (uuid, pages, parentBoardName) => ({ itemType: 'Schematic', uuid, name: uuid, parentProjectUuid: 'project-1', parentBoardName, page: pages })
	const pcb = (uuid, parentBoardName) => ({ itemType: 'PCB', uuid, name: uuid, parentProjectUuid: 'project-1', parentBoardName })
	const project = {
		uuid: 'project-1', teamUuid: 'team-1', folderUuid: 'folder-old',
		data: [
			{ itemType: 'Board', name: 'Board1', parentProjectUuid: 'project-1', schematic: schematic('sch-1', [page('page-1', 'sch-1')], 'Board1'), pcb: pcb('pcb-1', 'Board1') },
			{ itemType: 'Board', name: 'Board2', parentProjectUuid: 'project-1', schematic: schematic('sch-2', [page('page-2', 'sch-2')], 'Board2'), pcb: null },
			{ itemType: 'Panel', name: 'Board3', uuid: 'panel-3', parentProjectUuid: 'project-1' },
			{ itemType: 'Schematic', uuid: 'sch-free', name: 'sch-free', parentProjectUuid: 'project-1', parentBoardName: '', page: [page('page-free', 'sch-free')] },
			{ itemType: 'PCB', uuid: 'pcb-free', name: 'pcb-free', parentProjectUuid: 'project-1', parentBoardName: '' },
		],
	}
	const state = {
		project,
		folderUuid: 'folder-old',
		folderTeam: 'team-1',
		deletePageResult: true,
		deletePcbResult: true,
		deleteBoardResult: true,
		deletePageRemoves: true,
		deletePageSideEffect: false,
		deletePcbRemoves: true,
		deleteBoardRemoves: true,
		failTreeReadback: false,
		currentProjectReads: 0,
		currentProjectReadDelayMs: 0,
		failProjectInfoReadback: false,
		projectInfoReads: 0,
		moveChangesTeam: false,
		moveApplies: true,
		focus: { uuid: 'page-1', documentType: 1 },
		focusAfterSource: undefined,
		sourceText: '{"page":"page-1"}',
		sourceThrows: false,
		copyResult: 'page-copy',
		copyThrows: false,
		copyPcbResult: 'pcb-copy',
		copyPcbAttach: true,
		copyPcbThrows: false,
		createSchematicResult: 'sch-new',
		createPcbResult: 'pcb-new',
		createThrows: false,
		calls: { copy: 0, copyPcb: 0, pageDelete: 0, pcbDelete: 0, boardDelete: 0, move: 0, createSchematic: 0, createPcb: 0, source: 0 },
	}
	const updateTree = fn => { fn(state.project.data) }
	globalThis.eda = {
		dmt_Project: {
			getCurrentProjectInfo: async () => {
				state.currentProjectReads++
				if (state.currentProjectReadDelayMs)
					await new Promise(resolve => timers.setTimeout(resolve, state.currentProjectReadDelayMs))
				if (state.failTreeReadback && state.currentProjectReads > 2) throw new Error('tree readback unavailable')
				return clone(state.project)
			},
			getProjectInfo: async uuid => {
				state.projectInfoReads++
				if (state.failProjectInfoReadback && state.projectInfoReads > 1) throw new Error('project readback unavailable')
				return uuid === 'project-1' ? { uuid, teamUuid: state.moveChangesTeam && state.calls.move > 0 ? 'team-2' : 'team-1', folderUuid: state.folderUuid } : undefined
			},
			moveProjectToFolder: async (uuid, folderUuid) => { state.calls.move++; if (uuid !== 'project-1') throw Error('wrong project'); if (state.moveApplies) state.folderUuid = folderUuid; return true },
		},
		dmt_Folder: { getFolderInfo: async (team, uuid) => uuid === 'folder-ok' ? { uuid, teamUuid: state.folderTeam } : undefined },
		dmt_Schematic: {
			copySchematicPage: async (source, target) => {
				state.calls.copy++
				if (state.copyThrows) throw new Error('copy timeout')
				if (state.copyResult) {
					const targetUuid = target ?? 'sch-1'
					const targetNode = state.project.data.flatMap(node => [node, node.schematic].filter(Boolean)).find(node => node.itemType === 'Schematic' && node.uuid === targetUuid)
					targetNode.page.push({ itemType: 'Schematic Page', uuid: state.copyResult, name: 'copied', parentSchematicUuid: targetUuid })
				}
				return state.copyResult
			},
			getSchematicPageInfo: async uuid => state.project.data.flatMap(node => [node, node.schematic].filter(Boolean)).flatMap(node => node.page ?? []).find(item => item.uuid === uuid),
			deleteSchematicPage: async uuid => {
				state.calls.pageDelete++
				if (state.deletePageSideEffect) {
					const board = state.project.data.find(node => node.name === 'Board2')
					board.name = 'Board2-mutated'
					if (board.schematic) board.schematic.parentBoardName = board.name
					if (board.pcb) board.pcb.parentBoardName = board.name
				}
				if (state.deletePageRemoves) updateTree(data => {
					for (const node of data) {
						if (node.schematic) node.schematic.page = node.schematic.page.filter(item => item.uuid !== uuid)
						if (node.itemType === 'Schematic') node.page = node.page.filter(item => item.uuid !== uuid)
					}
				})
				return state.deletePageResult
			},
			createSchematic: async boardName => {
				state.calls.createSchematic++
				if (state.createThrows) throw new Error('create timeout')
				const created = { itemType: 'Schematic', uuid: state.createSchematicResult, name: state.createSchematicResult, parentProjectUuid: 'project-1', parentBoardName: boardName, page: [] }
				if (boardName) state.project.data.find(node => node.itemType === 'Board' && node.name === boardName).schematic = created
				else state.project.data.push(created)
				return state.createSchematicResult
			},
		},
		dmt_Pcb: {
			copyPcb: async (source, boardName) => {
				state.calls.copyPcb++
				if (state.copyPcbThrows) throw new Error('copy PCB timeout')
				const created = { itemType: 'PCB', uuid: state.copyPcbResult, name: state.copyPcbResult, parentProjectUuid: 'project-1', ...(boardName && state.copyPcbAttach ? { parentBoardName: boardName } : {}) }
				if (boardName && state.copyPcbAttach) state.project.data.find(node => node.itemType === 'Board' && node.name === boardName).pcb = created
				else state.project.data.push(created)
				return state.copyPcbResult
			},
			deletePcb: async uuid => {
				state.calls.pcbDelete++
				if (state.deletePcbRemoves) updateTree(data => { for (const node of data) if (node.pcb?.uuid === uuid) node.pcb = null })
				return state.deletePcbResult
			},
			createPcb: async boardName => {
				state.calls.createPcb++
				if (state.createThrows) throw new Error('create timeout')
				const created = { itemType: 'PCB', uuid: state.createPcbResult, name: state.createPcbResult, parentProjectUuid: 'project-1', parentBoardName: boardName }
				if (boardName) state.project.data.find(node => node.itemType === 'Board' && node.name === boardName).pcb = created
				else state.project.data.push(created)
				return state.createPcbResult
			},
			getAllPcbsInfo: async () => [],
		},
		dmt_Board: {
			deleteBoard: async name => {
				state.calls.boardDelete++
				if (state.deleteBoardRemoves) state.project.data = state.project.data.filter(node => !(node.itemType === 'Board' && node.name === name))
				return state.deleteBoardResult
			},
		},
		dmt_SelectControl: {
			getCurrentDocumentInfo: async () => state.focus ? clone(state.focus) : undefined,
		},
		sys_FileManager: {
			getDocumentSource: async () => {
				state.calls.source++
				if (state.sourceThrows) throw new Error('source unavailable')
				if (state.focusAfterSource !== undefined) state.focus = state.focusAfterSource ? clone(state.focusAfterSource) : undefined
				return state.sourceText
			},
		},
	}
	return state
}

const timers = { setTimeout: globalThis.setTimeout }
globalThis.setTimeout = (callback, ms, ...args) => ms <= 1500 ? setImmediate(callback, ...args) : timers.setTimeout(callback, ms, ...args)
try {
	{
		const state = makeState()
		await assert.rejects(() => definitions['project.copySchematicPage'].handler({ pageUuid: 'missing', schematicUuid: 'sch-2' }), /不属于当前工程/)
		assert.equal(state.calls.copy, 0, 'invalid source fails before SDK write')
		const copied = await definitions['project.copySchematicPage'].handler({ pageUuid: 'page-1', schematicUuid: 'sch-2' })
		assert.deepEqual(copied, { pageUuid: 'page-copy', name: 'copied', parentSchematicUuid: 'sch-2', sourcePageUuid: 'page-1' })
		assert.equal(state.calls.copy, 1)
	}
	{
		let toJSONCalls = 0
		const circular = { toJSON() { toJSONCalls++; throw new Error('toJSON must not run') } }
		circular.self = circular
		const invalidResults = [
			{ value: undefined, type: 'undefined' },
			{ value: null, type: 'null', hasValue: true, expectedValue: null },
			{ value: '', type: 'string', hasValue: true, expectedValue: '' },
			{ value: false, type: 'boolean', hasValue: true, expectedValue: false },
			{ value: 0, type: 'number', hasValue: true, expectedValue: 0 },
			{ value: Number.NaN, type: 'number', hasValue: true, expectedValue: 'NaN' },
			{ value: Number.POSITIVE_INFINITY, type: 'number', hasValue: true, expectedValue: 'Infinity' },
			{ value: 'page-1', type: 'string', hasValue: true, expectedValue: 'page-1', isSourceUuid: true },
			{ value: circular, type: 'object' },
			{ value: () => undefined, type: 'function' },
		]
		for (const item of invalidResults) {
			const state = makeState()
			state.copyResult = item.value
			let error
			let response
			if (item.value === circular) {
				response = await executeCommand({ cmd: 'project.copySchematicPage', params: { pageUuid: 'page-1' } })
				assert.equal(response.ok, false)
				error = response.error
			}
			else {
				error = await definitions['project.copySchematicPage'].handler({ pageUuid: 'page-1' }).catch(err => err)
			}
			assert.equal(error.cause?.partial, true)
			assert.equal(error.cause?.retryable, false)
			assert.equal(error.cause?.sdkResultType, item.type)
			assert.equal(Object.hasOwn(error.cause, 'sdkResultValue'), item.hasValue ?? false)
			if (item.hasValue) assert.equal(error.cause.sdkResultValue, item.expectedValue)
			assert.equal(error.cause?.sdkResultIsSourceUuid, item.isSourceUuid ?? false)
			assert.match(error.message, /返回空 UUID 或复用了源 UUID/, 'legacy error core stays readable')
			assert.doesNotThrow(() => JSON.stringify(error.cause), 'diagnostic cause remains JSON-safe')
			if (response) {
				assert.doesNotThrow(() => JSON.stringify(response), 'registry response retains a JSON-safe cause')
				assert.equal(toJSONCalls, 0, 'unexpected object results are not traversed or serialized')
			}
			assert.equal(state.calls.copy, 1, 'invalid SDK return is not retried')
		}
	}
	{
		const state = makeState()
		await assert.rejects(() => definitions['project.deleteSchematicPage'].handler({ pageUuid: 'absent' }), /不存在图页/)
		assert.equal(state.calls.pageDelete, 0)
		state.deletePageResult = false
		state.deletePageRemoves = false
		const failed = await definitions['project.deleteSchematicPage'].handler({ pageUuid: 'page-1' }).catch(err => err)
		assert.equal(failed.cause?.partial, false)
		assert.equal(failed.cause?.retryable, false)
		state.deletePageRemoves = true
		const inconsistent = await definitions['project.deleteSchematicPage'].handler({ pageUuid: 'page-2' }).catch(err => err)
		assert.equal(inconsistent.cause?.retryable, false)
		assert.equal(state.calls.pageDelete, 2)
	}
	{
		const state = makeState()
		state.deletePageResult = false
		state.deletePageRemoves = false
		state.deletePageSideEffect = true
		const error = await definitions['project.deleteSchematicPage'].handler({ pageUuid: 'page-1' }).catch(err => err)
		assert.equal(error.cause?.partial, true, 'false plus a changed document tree is not reported as a no-effect failure')
		assert.equal(error.cause?.treeUnchanged, false)
	}
	{
		const state = makeState()
		state.failTreeReadback = true
		const error = await definitions['project.deleteSchematicPage'].handler({ pageUuid: 'page-1' }).catch(err => err)
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(state.calls.pageDelete, 1, 'failed readback never causes a second delete')
	}
	{
		const state = makeState()
		state.deletePcbResult = false
		state.deletePcbRemoves = false
		const failed = await definitions['project.deletePcb'].handler({ pcbUuid: 'pcb-1' }).catch(err => err)
		assert.equal(failed.cause?.partial, false)
		assert.equal(failed.cause?.retryable, false)
		assert.equal(state.calls.pcbDelete, 1)
	}
	{
		const state = makeState()
		state.deletePcbResult = false
		state.deletePcbRemoves = true
		const error = await definitions['project.deletePcb'].handler({ pcbUuid: 'pcb-1' }).catch(err => err)
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(state.calls.pcbDelete, 1)
		await assert.rejects(() => definitions['project.deletePcb'].handler({ pcbUuid: 'missing' }), /不存在 PCB/)
		assert.equal(state.calls.pcbDelete, 1)
	}
	{
		const state = makeState()
		await assert.rejects(() => definitions['project.copyPcb'].handler({ pcbUuid: 'missing', boardName: 'Board2' }), /不属于当前工程/)
		await assert.rejects(() => definitions['project.copyPcb'].handler({ pcbUuid: 'pcb-1', boardName: 'Board1' }), /PCB 槽已占用/)
		await assert.rejects(() => definitions['project.copyPcb'].handler({ pcbUuid: 'pcb-1', boardName: 'Board3' }), /不存在精确匹配的 Board/)
		assert.equal(state.calls.copyPcb, 0, 'invalid source, occupied PCB slot, and Panel all fail before copy')
		assert.deepEqual(await definitions['project.copyPcb'].handler({ pcbUuid: 'pcb-1', boardName: 'Board2' }), { pcbUuid: 'pcb-copy' })
		state.copyPcbResult = 'pcb-copy-free'
		assert.deepEqual(await definitions['project.copyPcb'].handler({ pcbUuid: 'pcb-1' }), { pcbUuid: 'pcb-copy-free' }, 'omitted Board keeps the unlinked-copy path')
		assert.equal(state.calls.copyPcb, 2)
	}
	{
		const state = makeState()
		state.copyPcbAttach = false
		const error = await definitions['project.copyPcb'].handler({ pcbUuid: 'pcb-1', boardName: 'Board2' }).catch(err => err)
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(state.calls.copyPcb, 1, 'wrong target readback is never retried')
	}
	{
		const state = makeState()
		state.deleteBoardResult = false
		state.deleteBoardRemoves = false
		const failed = await definitions['project.deleteBoard'].handler({ boardName: 'Board1' }).catch(err => err)
		assert.equal(failed.cause?.partial, false)
		assert.equal(failed.cause?.diagnostics?.boardExists, true, 'false-return diagnostics remain attached to the error')
		state.deleteBoardRemoves = true
		const error = await definitions['project.deleteBoard'].handler({ boardName: 'Board2' }).catch(err => err)
		assert.equal(error.cause?.retryable, false)
		assert.equal(state.calls.boardDelete, 2)
	}
	{
		const state = makeState()
		state.folderTeam = 'team-2'
		await assert.rejects(() => definitions['project.moveToFolder'].handler({ projectUuid: 'project-1', folderUuid: 'folder-ok' }), /不属于工程当前团队/)
		assert.equal(state.calls.move, 0)
		state.folderTeam = 'team-1'
		assert.deepEqual(await definitions['project.moveToFolder'].handler({ projectUuid: 'project-1', folderUuid: 'folder-ok' }), { moved: true })
		assert.equal(state.folderUuid, 'folder-ok')
		assert.deepEqual(await definitions['project.moveToFolder'].handler({ projectUuid: 'project-1' }), { moved: true })
		assert.equal(state.folderUuid, undefined)
		assert.equal(state.calls.move, 2)
	}
	{
		const state = makeState()
		state.moveApplies = false
		const error = await definitions['project.moveToFolder'].handler({ projectUuid: 'project-1', folderUuid: 'folder-ok' }).catch(err => err)
		assert.equal(error.cause?.retryable, false)
		assert.equal(state.calls.move, 1, 'misplaced SDK success is not retried')
	}
	{
		const state = makeState()
		state.failProjectInfoReadback = true
		const error = await definitions['project.moveToFolder'].handler({ projectUuid: 'project-1', folderUuid: 'folder-ok' }).catch(err => err)
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(state.calls.move, 1, 'unknown move readback is not retried')
	}
	{
		const state = makeState()
		state.moveChangesTeam = true
		const error = await definitions['project.moveToFolder'].handler({ projectUuid: 'project-1', folderUuid: 'folder-ok' }).catch(err => err)
		assert.equal(error.cause?.partial, true, 'a team identity change after the write is an unknown move result')
		assert.equal(state.calls.move, 1)
	}
	{
		const state = makeState()
		await assert.rejects(() => definitions['project.createPcb'].handler({ boardName: 'Board1' }), /PCB 槽已占用/)
		await assert.rejects(() => definitions['project.createPcb'].handler({ boardName: 'Board3' }), /不存在精确匹配的 Board/)
		assert.equal(state.calls.createPcb, 0)
		assert.equal((await definitions['project.createPcb'].handler({ boardName: 'Board2' })).pcbUuid, 'pcb-new', 'occupied schematic slot does not block empty PCB slot')
		assert.equal(state.calls.createPcb, 1)
		assert.equal((await definitions['project.createSchematic'].handler({})).schematicUuid, 'sch-new', 'omitted board creates an unlinked schematic')
		assert.equal(state.calls.createSchematic, 1)
	}
	{
		const malformedTrees = [
			data => { data[0] = { ...data[0], pcb: undefined } },
			data => { data.push({ itemType: 'Schematic', uuid: 'sch-bad', name: 'bad', parentProjectUuid: 'project-1', page: {} }) },
			data => { data.push({ itemType: 'Schematic', uuid: 'sch-bad', name: 'bad', parentProjectUuid: 'project-1' }) },
			data => { data.push({ itemType: 'Container', children: [{ itemType: 'Schematic', uuid: 'nested', name: 'nested', parentProjectUuid: 'project-1', page: [] }] }) },
			data => { data[0].schematic.page[0] = { ...data[0].schematic.page[0], itemType: 'PCB' } },
			data => { data.push({ itemType: 'PCB', uuid: 'pcb-wrong-parent', name: 'pcb-wrong-parent', parentProjectUuid: 'project-1', parentBoardName: 'Board1' }) },
			data => { data.push({ itemType: 'Schematic', uuid: 'sch-wrong-parent', name: 'sch-wrong-parent', parentProjectUuid: 'project-1', parentBoardName: 'Board1', page: [] }) },
		]
		for (const corrupt of malformedTrees) {
			const state = makeState()
			corrupt(state.project.data)
			await assert.rejects(() => definitions['project.deleteSchematicPage'].handler({ pageUuid: 'page-1' }), /文档树|Board|原理图|PCB/)
			assert.equal(state.calls.pageDelete, 0, 'malformed or unbounded tree is rejected before a destructive SDK call')
		}
	}
	{
		const state = makeState()
		state.currentProjectReadDelayMs = 1100
		await assert.rejects(() => definitions['project.createPcb'].handler({ boardName: 'Board2', _timeoutMs: 1000 }), /超过 1000ms 操作期限/)
		assert.equal(state.calls.createPcb, 0, 'deadline on async preflight prevents the write from starting')
	}
	{
		const state = makeState()
		state.copyResult = undefined
		let followups = 0
		registerCommand({ name: 'test.projectFollowup', summary: 'test', params: [], handler: async () => { followups++; return true } })
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'project.copySchematicPage', params: { pageUuid: 'page-1' } },
			{ cmd: 'test.projectFollowup', params: {} },
		] } })
		assert.equal(result.ok, false)
		assert.equal(result.data?.stoppedReason, 'partial')
		assert.equal(result.data?.unexecutedSteps, 1)
		assert.equal(state.calls.copy, 1)
		assert.equal(followups, 0)
	}
	{
		const state = makeState()
		state.copyPcbThrows = true
		let followups = 0
		registerCommand({ name: 'test.copyPcbFollowup', summary: 'test', params: [], handler: async () => { followups++; return true } })
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'project.copyPcb', params: { pcbUuid: 'pcb-1', boardName: 'Board2' } },
			{ cmd: 'test.copyPcbFollowup', params: {} },
		] } })
		assert.equal(result.ok, false)
		assert.equal(result.data?.stoppedReason, 'partial')
		assert.equal(state.calls.copyPcb, 1)
		assert.equal(followups, 0)
	}
	{
		const state = makeState()
		state.deletePageResult = false
		state.deletePageRemoves = false
		let followups = 0
		registerCommand({ name: 'test.deletePageFollowup', summary: 'test', params: [], handler: async () => { followups++; return true } })
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: true, steps: [
			{ cmd: 'project.deleteSchematicPage', params: { pageUuid: 'page-1' } },
			{ cmd: 'test.deletePageFollowup', params: {} },
		] } })
		assert.equal(result.ok, false, 'SDK false is a command failure, not outer ok:true')
		assert.equal(followups, 0, 'macro does not run after confirmed delete failure')
	}
	{
		const state = makeState()
		state.focus = undefined
		await assert.rejects(() => definitions['project.getDocumentSource'].handler(), /没有可确认的激活文档 UUID/)
		assert.equal(state.calls.source, 0, 'missing focus is rejected before SDK source read')
		state.focus = { uuid: 'page-1' }
		assert.deepEqual(await definitions['project.getDocumentSource'].handler(), { source: '{"page":"page-1"}' }, 'valid UUID does not require a guessed type whitelist')
		state.focusAfterSource = { uuid: 'page-other' }
		await assert.rejects(() => definitions['project.getDocumentSource'].handler(), /焦点已从/)
		state.focus = { uuid: 'page-1', parentProjectUuid: 'project-1', tabId: 'page-1@project-1' }
		state.focusAfterSource = { uuid: 'page-1', parentProjectUuid: 'project-2', tabId: 'page-1@project-2' }
		await assert.rejects(() => definitions['project.getDocumentSource'].handler(), /焦点已从/)
		state.focusAfterSource = undefined
		state.sourceText = ''
		await assert.rejects(() => definitions['project.getDocumentSource'].handler(), /官方返回空或非字符串/)
		assert.equal(state.calls.source, 4)
	}
	console.log('project-mutation-outcome-regression: 16 groups passed')
}
finally {
	globalThis.setTimeout = timers.setTimeout
}
