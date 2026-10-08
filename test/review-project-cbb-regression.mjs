import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
async function loadCommands(relativePath, exportName) {
	const result = await build({
		entryPoints: [resolve(root, relativePath)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
	})
	const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
	return (await import(url))[exportName]
}

const projectCommands = await loadCommands('src/commands/project.ts', 'projectCommands')
const cbbCommands = await loadCommands('src/commands/cbb.ts', 'cbbCommands')
const schematicCommands = await loadCommands('src/commands/schematic.ts', 'schematicCommands')
const projectHandler = name => projectCommands.find(command => command.name === name).handler
const cbbHandler = name => cbbCommands.find(command => command.name === name).handler
const schematicHandler = name => schematicCommands.find(command => command.name === name).handler
let failed = 0
function check(condition, label) {
	if (condition)
		console.log(`PASS  ${label}`)
	else {
		console.error(`FAIL  ${label}`)
		failed++
	}
}

async function withImmediateTimers(fn) {
	const original = globalThis.setTimeout
	globalThis.setTimeout = callback => { queueMicrotask(callback); return 0 }
	try { await fn() }
	finally { globalThis.setTimeout = original }
}

await withImmediateTimers(async () => {
	// R4: tabId is present, but a failed activation leaves another page focused.
	{
		let saves = 0
		let focusReads = 0
		globalThis.eda = {
			dmt_EditorControl: {
				openDocument: async () => 'target-tab',
				activateDocument: async () => false,
			},
			dmt_SelectControl: { getCurrentDocumentInfo: async () => { focusReads++; return { uuid: 'other-page' } } },
			sch_Document: { save: async () => { saves++ } },
			dmt_Schematic: {
				modifySchematicPageName: async () => true,
				getSchematicPageInfo: async () => ({ name: 'renamed' }),
			},
		}
		await projectHandler('project.renameSchematicPage')({ pageUuid: 'target-page', name: 'renamed' })
		check(focusReads > 0 && saves === 0, 'R4：activateDocument=false 且焦点仍是其他页时跳过 save')
	}
	// R4 successful control: saving is allowed once actual focus matches the target UUID.
	{
		let saves = 0
		globalThis.eda = {
			dmt_EditorControl: { openDocument: async () => 'target-tab', activateDocument: async () => true },
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'target-page' }) },
			sch_Document: { save: async () => { saves++ } },
			dmt_Schematic: {
				modifySchematicPageName: async () => true,
				getSchematicPageInfo: async () => ({ name: 'renamed' }),
			},
		}
		await projectHandler('project.renameSchematicPage')({ pageUuid: 'target-page', name: 'renamed' })
		check(saves === 1, 'R4：焦点 UUID 等于目标图页时保存一次')
	}

	// R6: page A and B expose different fields; validation and write must target current page B.
	{
		const pageReads = []
		const pageB = { uuid: 'page-B', showTitleBlock: true, titleBlockData: { Revision: { showTitle: false, showValue: true, value: 'A0' }, Title: { showTitle: true, showValue: true, value: 'Original title' } } }
		let written
		let shown
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => {
					pageReads.push(uuid)
					return uuid === 'page-A'
						? { uuid, titleBlockData: { Title: { showTitle: true, showValue: true, value: 'A title' } } }
						: pageB
				},
				modifySchematicPageTitleBlock: async (show, data) => {
					shown = show
					written = data
					if (show !== undefined) pageB.showTitleBlock = show
					Object.assign(pageB.titleBlockData, data)
					return true
				},
			},
		}
		const result = await projectHandler('project.modifyTitleBlock')({ showTitleBlock: false, data: { Revision: { showValue: false, value: 'B1' } } })
		check(result.modified && result.submitted && result.readback?.uuid === 'page-B' && result.readback?.verified === false && pageReads.length === 1 && pageReads[0] === 'page-B', 'R6：多页字段不同，按当前页 B 校验并提交，返回待独立读回状态')
		check(shown === false && written.Revision.showTitle === false && written.Revision.showValue === false && written.Revision.value === 'B1', 'R6：只补同字段当前状态，省略属性保留且请求属性覆盖')
		check(pageB.titleBlockData.Title.value === 'Original title' && pageB.showTitleBlock === false, 'R6：只提交请求字段，未请求字段与显示状态未被接口参数改变')
	}
	{
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => ({ uuid, titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'A0' } } }),
				modifySchematicPageTitleBlock: async () => { writes++; return true },
			},
		}
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: { Title: { value: 'wrong-page-field' } } }), /标题栏不存在字段/)
		check(writes === 0, 'R6：当前页无目标字段时在写入前拒绝')
	}
	{
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => ({ uuid, titleBlockData: { Revision: { value: 'A0' } } }),
				modifySchematicPageTitleBlock: async () => { writes++; return true },
			},
		}
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'B1' } } }), /缺少 showTitle\/showValue\/value 状态/)
		check(writes === 0, 'R6：当前字段状态不完整时明确报错，不虚构默认值或写入')
	}
	{
		const page = { uuid: 'page-B', showTitleBlock: true, titleBlockData: { Revision: { showTitle: true, showValue: false, value: 'A0' } } }
		let shown
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async () => page,
				modifySchematicPageTitleBlock: async (show, data) => { shown = show; Object.assign(page.titleBlockData, data); return true },
			},
		}
		const result = await projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'B1' } } })
		check(result.submitted && result.readback?.verified === false && shown === undefined && page.showTitleBlock === true && page.titleBlockData.Revision.showValue === false, 'R6：未传 showTitleBlock 时沿用当前状态与省略字段，并标记待确认')
	}
	{
		let writes = 0
		let focusReads = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => { focusReads++; return { documentType: 1, uuid: 'page-B' } } },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => ({ uuid, titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'A0' } } }),
				modifySchematicPageTitleBlock: async () => { writes++; return true },
			},
		}
		await assert.rejects(projectHandler('project.modifyTitleBlock')([]), /参数必须是对象/)
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: { Revision: ['bad'] } }), /字段 Revision 的值必须是对象/)
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: [] }), /data 必须是/)
		check(focusReads === 1 && writes === 0, 'R6：非对象请求、数组 data 和非法字段对象均在写入前拒绝')
	}
	{
		let focusReads = 0
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: ++focusReads === 1 ? 'page-B' : 'page-A' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => ({ uuid, titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'A0' } } }),
				modifySchematicPageTitleBlock: async () => { writes++; return true },
			},
		}
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'B1' } } }), /焦点已从图页/)
		check(focusReads === 2 && writes === 0, 'R6：读字段期间焦点切页时写入前再次核对并拒绝')
	}
	{
		const reads = []
		const focusReads = []
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => { focusReads.push(true); return { documentType: 1, uuid: 'page-B' } } },
			dmt_Schematic: { getSchematicPageInfo: async uuid => { reads.push(uuid); return { uuid, name: uuid, showTitleBlock: true, titleBlockData: { Title: { value: uuid } } } } },
			dmt_Project: { getCurrentProjectInfo: async () => { throw new Error('should not inspect project tree') } },
		}
		const focused = await schematicHandler('schematic.getPageInfo')({})
		check(focused.uuid === 'page-B' && focused.showTitleBlock === true && focused.titleBlockData.Title.value === 'page-B' && reads.join(',') === 'page-B' && focusReads.length === 1, 'R3：无 UUID 时读取二页工程的实际焦点页并返回标题栏状态')
		reads.length = 0
		focusReads.length = 0
		const explicitPage = await schematicHandler('schematic.getPageInfo')({ pageUuid: 'page-A' })
		const explicitAlias = await schematicHandler('schematic.getPageInfo')({ uuid: 'page-C' })
		check(explicitPage.uuid === 'page-A' && explicitAlias.uuid === 'page-C' && reads.join(',') === 'page-A,page-C' && focusReads.length === 0, 'R3：显式 pageUuid 与 uuid 别名保留原行为')
	}
	{
		let pageReads = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 2, uuid: 'pcb-uuid' }) },
			dmt_Schematic: { getSchematicPageInfo: async () => { pageReads++; return undefined } },
		}
		await assert.rejects(schematicHandler('schematic.getPageInfo')({}), /无法确认当前焦点是有效原理图图页/)
		check(pageReads === 0, 'R3：无效/非原理图焦点明确报错且不请求错误图页')
	}
	{
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async () => ({ uuid: 'page-A', titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'A0' } } }),
				modifySchematicPageTitleBlock: async () => { writes++; return true },
			},
		}
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'B1' } } }), /无法读取当前焦点图页 page-B/)
		await assert.rejects(schematicHandler('schematic.getPageInfo')({ pageUuid: 'page-B' }), /图页读取结果 UUID 与目标不一致/)
		check(writes === 0, 'R3/R6：读到错 UUID 图页时拒绝使用数据或写入')
	}
	{
		let reads = 0
		let writes = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => { reads++; return { uuid, showTitleBlock: true, titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'old' } } } },
				modifySchematicPageTitleBlock: async () => { writes++; return true },
			},
		}
		const result = await projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'new' } } })
		check(result.modified && result.submitted && result.readback?.verified === false && result.note.includes('尚待独立读回确认') && reads === 1 && writes === 1, 'R6：异步旧值不被冒称读回成功，也不误报 partial')
	}
	{
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => ({ uuid, titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'old' } } }),
				modifySchematicPageTitleBlock: async () => { throw new Error('sdk write error') },
			},
		}
		await assert.rejects(projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'new' } } }), error => {
			check(error.cause?.partial === true && error.cause?.retryable === false, 'R6：写入异常保留 partial 且不可重试原因')
			return /标题栏修改失败/.test(error.message)
		})
	}
	{
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-B' }) },
			dmt_Schematic: {
				getSchematicPageInfo: async uuid => ({ uuid, titleBlockData: { Revision: { showTitle: true, showValue: true, value: 'old' } } }),
				modifySchematicPageTitleBlock: async () => false,
			},
		}
		const result = await projectHandler('project.modifyTitleBlock')({ data: { Revision: { value: 'new' } } })
		check(result.modified === false && result.submitted === false && !result.readback, 'R6：SDK 返回 false 时不标记已提交或读回')
	}

	async function runCbbScenario(kind, returnUuid, availableObjects, expected) {
		let calls = 0
		let searches = 0
		const name = 'duplicate-name'
		globalThis.eda = {
			lib_Cbb: {
				search: async () => { searches++; return availableObjects },
				create: async () => { calls++; return returnUuid },
				copy: async () => { calls++; return returnUuid },
			},
		}
		const params = kind === 'create'
			? { libraryUuid: 'personal', name }
			: { cbbUuid: 'source', libraryUuid: 'system', targetLibraryUuid: 'personal', newName: name }
		if (expected === 'unconfirmed') {
			await assert.rejects(cbbHandler(`cbb.${kind}`)(params), error => {
				check(error.cause?.partial === true && error.cause?.retryable === false, `R5：${kind} 未确认错误标记 partial 且不可重试`)
				return /结果未确认/.test(error.message)
			})
			check(calls === 1 && searches === 0, `R5：${kind} 空返回时不搜索旧对象或他窗口新增对象，也不重试`)
		}
		else {
			const result = await cbbHandler(`cbb.${kind}`)(params)
			check(result.cbbUuid === expected && result.verify === 'official', `R5：${kind} 仅接受官方直接返回 UUID ${expected}`)
			check(calls === 1 && searches === 0, `R5：${kind} 官方 UUID 成功路径只调用一次且不搜索`)
		}
	}

	const oldObject = { name: 'duplicate-name', uuid: 'old-module' }
	const otherWindowObject = { name: 'duplicate-name', uuid: 'other-window-module' }
	for (const kind of ['create', 'copy']) {
		await runCbbScenario(kind, undefined, [oldObject], 'unconfirmed')
		await runCbbScenario(kind, undefined, [oldObject, otherWindowObject], 'unconfirmed')
		await runCbbScenario(kind, `${kind}-official-uuid`, [oldObject, otherWindowObject], `${kind}-official-uuid`)
	}
})

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
