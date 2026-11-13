import type { ICommandDef } from '../engine/types'

type Side = 'top' | 'bottom'
const layerId: Record<Side, number> = { top: 3, bottom: 4 }

function normalizeColor(value: unknown): string {
	if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
		throw new Error('color 必须是 #RRGGBB 格式')
	return value.toUpperCase()
}

async function activePcb(params: Record<string, any>, ctx?: { stopSignal?: { assertActive(): void } }): Promise<{ uuid: string, tabId?: string }> {
	ctx?.stopSignal?.assertActive()
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (doc?.documentType !== 3 || typeof doc.uuid !== 'string' || !doc.uuid.trim())
		throw new Error('需要当前激活有效 PCB 文档')
	if ((params.__docUuid !== undefined && params.__docUuid !== doc.uuid)
		|| (params.__tabId !== undefined && params.__tabId !== doc.tabId))
		throw new Error('当前 PCB 文档或标签页已变化；拒绝操作')
	return { uuid: doc.uuid, tabId: doc.tabId }
}

async function readLayers(): Promise<any[]> {
	if (typeof eda.pcb_Layer?.getAllLayers !== 'function') throw new Error('当前 SDK 不支持读取 PCB 图层')
	const layers = await eda.pcb_Layer.getAllLayers()
	if (!Array.isArray(layers)) throw new Error('PCB 图层读取未返回数组')
	return layers
}

function colorOf(layers: any[], id: number): string | undefined {
	const layer = layers.find(item => Number(item?.id ?? item?.layer) === id)
	return typeof layer?.color === 'string' ? layer.color : undefined
}

async function checkTarget(params: Record<string, any>, ctx: any, uuid: string): Promise<void> {
	const fresh = await activePcb(params, ctx)
	if (fresh.uuid !== uuid) throw new Error('PCB 文档已变化；拒绝继续操作')
}

export const pcbLayerColorCommands: ICommandDef[] = [
	{
		name: 'pcb.getSilkscreenColors', summary: '读取当前 PCB 顶/底丝印显示颜色', params: [],
		returns: '{ docUUID, top, bottom }', example: { cmd: 'pcb.getSilkscreenColors' },
		handler: async (params, ctx) => {
			const doc = await activePcb(params, ctx)
			const layers = await readLayers()
			await checkTarget(params, ctx, doc.uuid)
			return { docUUID: doc.uuid, top: colorOf(layers, 3) ?? null, bottom: colorOf(layers, 4) ?? null }
		},
	},
	{
		name: 'pcb.setSilkscreenColor', summary: '设置当前 PCB 顶/底丝印显示颜色并读回校验',
		params: [
			{ name: 'side', type: 'string', description: 'top | bottom | both（默认 top）' },
			{ name: 'color', type: 'string', required: true, description: '图层激活显示颜色，#RRGGBB；非激活暗色保持 EDA 设置' },
		], returns: '{ docUUID, target, verified, layers }',
		example: { cmd: 'pcb.setSilkscreenColor', params: { side: 'top', color: '#FF0000' } },
		handler: async (params, ctx) => {
			const color = normalizeColor(params.color)
			const side = params.side == null ? 'top' : String(params.side).toLowerCase()
			if (!['top', 'bottom', 'both'].includes(side)) throw new Error('side 仅支持 top | bottom | both')
			const doc = await activePcb(params, ctx)
			const targets: Side[] = side === 'both' ? ['top', 'bottom'] : [side as Side]
			const beforeLayers = await readLayers()
			await checkTarget(params, ctx, doc.uuid)
			const before = Object.fromEntries(targets.map(target => [target, colorOf(beforeLayers, layerId[target]) ?? null]))
			const results: Record<string, any> = {}
			for (const target of targets) {
				try { await checkTarget(params, ctx, doc.uuid) }
				catch (error) {
					if (Object.values(results).some((item: any) => !item.skipped))
						throw Object.assign(new Error(`丝印颜色操作中断，未处理 ${target} 层：${String((error as any)?.message ?? error)}`), { cause: { partial: true, docUUID: doc.uuid, before, target: color, layers: results } })
					throw error
				}
				if (String(before[target] ?? '').toUpperCase() === color) {
					results[target] = { before: before[target], target: color, observed: before[target], skipped: true, verified: true }
					continue
				}
				if (typeof eda.pcb_Layer?.modifyLayer !== 'function') throw new Error('当前 SDK 不支持修改 PCB 图层颜色')
				let ack: unknown
				let writeError: unknown
				try { ack = await eda.pcb_Layer.modifyLayer(layerId[target] as any, { color }) }
				catch (error) { writeError = error }
				let observed: string | undefined
				let readError: unknown
				try {
					const readback = await readLayers()
					await checkTarget(params, ctx, doc.uuid)
					observed = colorOf(readback, layerId[target])
				}
				catch (error) { readError = error }
				const verified = observed?.toUpperCase() === color
				results[target] = { before: before[target], target: color, observed: observed ?? null, ack: ack ?? null, verified }
				if (!verified) {
					throw Object.assign(new Error(`丝印颜色未能确认：${target} 层目标 ${color}，读回 ${observed ?? '未知'}${writeError ? `；写入异常 ${String((writeError as any)?.message ?? writeError)}` : ''}${readError ? `；读回异常 ${String((readError as any)?.message ?? readError)}` : ''}`), { cause: { partial: true, docUUID: doc.uuid, before, target: color, layers: results } })
				}
			}
			try { await checkTarget(params, ctx, doc.uuid) }
			catch (error) {
				if (Object.values(results).some((item: any) => !item.skipped))
					throw Object.assign(new Error(`丝印颜色已处理，但最终复核失败：${String((error as any)?.message ?? error)}`), { cause: { partial: true, docUUID: doc.uuid, before, target: color, layers: results } })
				throw error
			}
			return { docUUID: doc.uuid, target: color, verified: true, layers: results }
		},
	},
]
