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
		summary: '关闭指定文档页签（官方 dmt_EditorControl.closeDocument）。用途：删除持久化对照测试（删→存→关→开→读回）、释放卡死的文档会话。**关闭前必须先 save**：脏文档官方可能弹「是否保存」对话框，AI 点不了，命令会返回 closed:false 并提示手动处理',
		params: [
			{ name: 'uuid', type: 'string', description: '文档 UUID（与 tabId 二选一）' },
			{ name: 'tabId', type: 'string', description: '页签 ID（editor.listTabs / openDocument 返回；优先于 uuid）' },
		],
		returns: '{ tabId, closed, note? }',
		example: { cmd: 'editor.closeDocument', params: { uuid: '5c96eb02cb6183a2' } },
		handler: async (params) => {
			let tabId = params.tabId ? String(params.tabId) : undefined
			if (!tabId && params.uuid) {
				// 从页签树按文档 uuid 反查 tabId（页签 ID 形如 "<docUuid>@<projectUuid>"）
				try {
					const tree = await (eda.dmt_EditorControl as any).getSplitScreenTree()
					const walk = (node: any): string | undefined => {
						if (!node)
							return undefined
						if (Array.isArray(node.tabs)) {
							const hit = node.tabs.find((t: any) => typeof t.tabId === 'string' && t.tabId.startsWith(String(params.uuid)))
							if (hit)
								return hit.tabId
						}
						for (const key of ['children', 'splitScreens', 'leaves']) {
							if (Array.isArray(node[key])) {
								for (const child of node[key]) {
									const found = walk(child)
									if (found)
										return found
								}
							}
						}
						return undefined
					}
					tabId = walk(tree)
				}
				catch {
					// 页签树查询失败则直接尝试用 uuid 关
				}
				tabId = tabId ?? String(params.uuid)
			}
			if (!tabId)
				throw new Error('缺少参数 uuid / tabId')
			const closed = Boolean(await eda.dmt_EditorControl.closeDocument(tabId))
			// 读回页签列表验证确实关了——官方关闭是异步的，0.10.53 实测刚关完页签还在树里（1ms 后验证必误判），轮询最长 8s
			let stillThere = false
			for (let attempt = 0; attempt < 8; attempt++) {
				try {
					const tree = await (eda.dmt_EditorControl as any).getSplitScreenTree()
					stillThere = JSON.stringify(tree).includes(tabId)
				}
				catch {
					// 验证失败不阻断，以 closed 返回值为准
				}
				if (!stillThere)
					break
				await new Promise(resolve => setTimeout(resolve, 1000))
			}
			if (closed && !stillThere)
				return { tabId, closed: true }
			return {
				tabId,
				closed: false,
				note: stillThere
					? '官方返回已关闭但页签仍在——可能文档有未保存修改弹了确认框（AI 点不了），请在 EDA 里手动关闭该页签（不保存/保存均可，视你是否要刚才的修改）'
					: '官方未确认关闭——请用 editor.listTabs 核对页签状态；若页签仍在且文档已脏，请手动关闭',
			}
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
