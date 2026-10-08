/**
 * 编辑器视图类指令：截图、缩放、文档激活
 */
import type { ICommandDef } from '../engine/types'
import { fileToResult } from './util'

export const editorCommands: Array<ICommandDef> = [
	{
		name: 'editor.openDocument',
		summary: '激活打开指定文档（原理图图页/PCB 的 uuid，可从 project.getInfo 获取）；原理图/PCB 类指令执行前需确保对应文档已激活',
		params: [
			{ name: 'uuid', type: 'string', required: true, description: '文档 UUID（图页或 PCB）' },
		],
		returns: '{ tabId, activated }',
		example: { cmd: 'editor.openDocument', params: { uuid: '5c96eb02cb6183a2' } },
		handler: async (params) => {
			if (!params.uuid)
				throw new Error('缺少参数 uuid')
			const tabId = await eda.dmt_EditorControl.openDocument(String(params.uuid))
			if (!tabId)
				throw new Error('文档打开失败，请检查 uuid 是否正确')
			// 打开后显式激活一次，规避新文档未渲染导致后续 API 拒写的问题
			let activated = false
			try {
				activated = Boolean(await eda.dmt_EditorControl.activateDocument(tabId))
			}
			catch {
				// 激活失败不阻断，openDocument 本身通常已激活
			}
			return { tabId, activated }
		},
	},
	{
		name: 'editor.closeDocument',
		summary: '关闭指定文档页签（官方 dmt_EditorControl.closeDocument）。用途：删除持久化对照测试（删→存→关→开→读回）、释放卡死的文档会话。**关闭前必须先 save**：脏文档可能弹「是否保存」对话框；关闭及页签树读回未确认时返回失败，读回未知会标记 partial 并阻止宏继续',
		params: [
			{ name: 'uuid', type: 'string', description: '文档 UUID（与 tabId 二选一）' },
			{ name: 'tabId', type: 'string', description: '页签 ID（editor.listTabs / openDocument 返回；优先于 uuid）' },
		],
		returns: '{ tabId, closed, note? }（closed=false 为命令失败；页签树必须是有效结构且明确不含目标才能报告 closed=true）',
		example: { cmd: 'editor.closeDocument', params: { uuid: '5c96eb02cb6183a2' } },
		handler: async (params) => {
			let tabId = params.tabId ? String(params.tabId) : undefined
			const inspectTree = (tree: any, matches: (tabId: string) => boolean): { valid: boolean, found: boolean } => {
				let found = false
				const walk = (node: any): boolean => {
					if (!node || typeof node !== 'object' || Array.isArray(node))
						return false
					let recognized = false
					for (const key of ['tabs', 'children', 'splitScreens', 'leaves']) {
						if (!Object.prototype.hasOwnProperty.call(node, key))
							continue
						recognized = true
						if (!Array.isArray(node[key]))
							return false
						if (key === 'tabs') {
							for (const tab of node.tabs) {
								if (!tab || typeof tab !== 'object' || typeof tab.tabId !== 'string')
									return false
								if (matches(tab.tabId))
									found = true
							}
						}
						else {
							for (const child of node[key]) {
								if (!walk(child))
									return false
							}
						}
					}
					return recognized
				}
				const valid = Boolean(tree && typeof tree === 'object' && !Array.isArray(tree) && walk(tree))
				return { valid, found }
			}
			const readTree = async (stage: string): Promise<any> => {
				const tree = await (eda.dmt_EditorControl as any).getSplitScreenTree()
				if (!tree || typeof tree !== 'object' || Array.isArray(tree))
					throw new Error(`${stage}读取页签树失败：返回值不是有效对象`)
				return tree
			}
			if (!tabId && params.uuid) {
				// 从页签树按文档 uuid 反查 tabId（页签 ID 形如 "<docUuid>@<projectUuid>"）
				const tree = await readTree('关闭前')
				const inspected = inspectTree(tree, candidate => candidate.startsWith(String(params.uuid)))
				if (!inspected.valid)
					throw new Error('关闭前读取到非法页签树结构，已拒绝关闭')
				tabId = undefined
				const find = (node: any): string | undefined => {
					if (Array.isArray(node?.tabs)) {
						const hit = node.tabs.find((tab: any) => tab.tabId.startsWith(String(params.uuid)))
						if (hit)
							return hit.tabId
					}
					for (const key of ['children', 'splitScreens', 'leaves']) {
						for (const child of node?.[key] ?? []) {
							const found = find(child)
							if (found)
								return found
						}
					}
					return undefined
				}
				tabId = find(tree)
				tabId = tabId ?? String(params.uuid)
			}
			if (!tabId)
				throw new Error('缺少参数 uuid / tabId')
			let closed: boolean
			try {
				closed = Boolean(await eda.dmt_EditorControl.closeDocument(tabId))
			}
			catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(`官方 closeDocument 结果未知：${message}`, {
					cause: { partial: true, retryable: false, phase: 'closeDocument', operationError: message, result: { tabId, closed: 'unknown' } },
				})
			}
			// 读回页签列表验证确实关了——官方关闭是异步的，0.10.53 实测刚关完页签还在树里（1ms 后验证必误判），轮询最长 8s
			let stillThere = true
			for (let attempt = 0; attempt < 8; attempt++) {
				let tree: any
				let inspected: { valid: boolean, found: boolean }
				try {
					tree = await readTree('关闭后')
					inspected = inspectTree(tree, candidate => candidate === tabId || (!params.tabId && candidate.startsWith(String(params.uuid ?? ''))))
				}
				catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					throw new Error(`关闭后无法确认页签状态：${message}`, {
						cause: { partial: true, retryable: false, phase: 'closeDocument.readback', operationError: message, result: { tabId, closed: 'unknown' } },
					})
				}
				if (!inspected.valid) {
					const message = '关闭后读取到非法页签树结构'
					throw new Error(`${message}，无法确认页签是否关闭`, {
						cause: { partial: true, retryable: false, phase: 'closeDocument.readback', operationError: message, result: { tabId, closed: 'unknown' } },
					})
				}
				stillThere = inspected.found
				if (!stillThere)
					break
				await new Promise(resolve => setTimeout(resolve, 1000))
			}
			if (!closed && !stillThere)
				throw new Error(`官方 closeDocument 返回 false，但有效页签树已不含 ${tabId}；本次关闭结果矛盾且无法确认`, {
					cause: { partial: true, retryable: false, phase: 'closeDocument.readback', result: { tabId, closed: false, treeContainsTab: false } },
				})
			if (!closed)
				throw new Error(`官方未确认关闭页签 ${tabId}`, {
					cause: { result: { tabId, closed: false, note: stillThere ? '页签仍在树中' : '树中已不存在，但官方调用返回 false，不能确认本次关闭' } },
				})
			if (!stillThere)
				return { tabId, closed: true }
			throw new Error(`官方返回已关闭但页签 ${tabId} 仍在树中——可能有未保存修改确认框，请在 EDA 里核对并手动关闭`, {
				cause: { partial: true, retryable: false, phase: 'closeDocument.readback', result: { tabId, closed: false, note: '页签仍在有效页签树中' } },
			})
		},
	},
	{
		name: 'editor.screenshot',
		summary: '截取画布当前渲染区域图像（返回 base64 PNG；建议先 editor.zoomToAll 缩放到全部图元再截图）',
		params: [
			{ name: 'tabId', type: 'string', description: '标签页 ID（editor.openDocument 返回值），留空取最近焦点画布' },
			{ name: 'zoomToAll', type: 'boolean', description: '截图前先缩放到全部图元，默认 false' },
		],
		returns: '{ fileName, size, mimeType, base64 }（base64 为 PNG 图像数据）',
		example: { cmd: 'editor.screenshot', params: { zoomToAll: true } },
		handler: async (params) => {
			const tabId = params.tabId ? String(params.tabId) : undefined
			if (params.zoomToAll) {
				try {
					await eda.dmt_EditorControl.zoomToAllPrimitives(tabId)
				}
				catch {
					// 缩放失败不阻断截图
				}
			}
			const image = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(tabId)
			const result = await fileToResult(image ?? undefined, 'screenshot.png')
			if (!result)
				throw new Error('截图失败：官方返回空（请确认对应画布已在界面中打开并渲染）')
			return result
		},
	},
	{
		name: 'editor.zoomToAll',
		summary: '缩放画布到全部图元（fit all）',
		params: [
			{ name: 'tabId', type: 'string', description: '标签页 ID，留空取最近焦点画布' },
		],
		returns: '可视区域 { left, right, top, bottom } 或 false',
		example: { cmd: 'editor.zoomToAll' },
		handler: async (params) => {
			const result = await eda.dmt_EditorControl.zoomToAllPrimitives(
				params.tabId ? String(params.tabId) : undefined,
			)
			if (result === false)
				throw new Error('缩放失败（画布可能未打开）')
			return result
		},
	},
	{
		name: 'editor.listTabs',
		summary: '列出编辑器当前打开的所有标签页（跨工程；返回 tabId/标题/文档类型），用于确认 AI 操作的目标画布',
		params: [],
		returns: '[{ tabId, title, documentType, splitId }]',
		example: { cmd: 'editor.listTabs' },
		handler: async () => {
			const tree = await (eda.dmt_EditorControl as any).getSplitScreenTree()
			const tabs: Array<Record<string, unknown>> = []
			const walk = (node: any): void => {
				if (!node)
					return
				if (Array.isArray(node.tabs)) {
					for (const t of node.tabs)
						tabs.push({ tabId: t.tabId, title: t.title, documentType: t.documentType, splitId: node.id })
				}
				if (Array.isArray(node.children))
					node.children.forEach(walk)
			}
			walk(tree)
			return tabs
		},
	},
	{
		name: 'editor.zoomToRegion',
		summary: '缩放画布到指定区域（坐标单位跟随文档：原理图 10mil，PCB mil）',
		params: [
			{ name: 'left', type: 'number', required: true, description: '区域左边界' },
			{ name: 'right', type: 'number', required: true, description: '区域右边界' },
			{ name: 'top', type: 'number', required: true, description: '区域上边界' },
			{ name: 'bottom', type: 'number', required: true, description: '区域下边界' },
			{ name: 'tabId', type: 'string', description: '标签页 ID，留空取最近焦点画布' },
		],
		returns: '是否成功',
		example: { cmd: 'editor.zoomToRegion', params: { left: 100, right: 600, top: 500, bottom: 100 } },
		handler: async (params) => {
			for (const key of ['left', 'right', 'top', 'bottom']) {
				if (params[key] == null)
					throw new Error(`缺少参数 ${key}`)
			}
			const result = await (eda.dmt_EditorControl as any).zoomToRegion(
				Number(params.left), Number(params.right), Number(params.top), Number(params.bottom),
				params.tabId ? String(params.tabId) : undefined,
			)
			return { zoomed: result !== false, result }
		},
	},
]
