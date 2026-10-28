import { augmentDsnPlanes, type DsnPlaneRegion, type DsnRepairResult } from '../engine/dsnExport'
import { createGeometryHost } from './geometryHost'
import { parseSourceLog } from './sourcelog'
import { normalizePouredPathSource, readEditorVersion } from './pouredUnits'
import { comparePcbSourceSnapshots } from './dsnSourceSnapshot'

function state<T = any>(object: any, name: string): T | undefined {
	const getter = object?.[`getState_${name}`]
	return typeof getter === 'function' ? getter.call(object) as T : undefined
}

function polygonPoints(path: unknown): { x: number, y: number }[] | undefined {
	if (!Array.isArray(path) || path.length < 7 || path.some(Array.isArray))
		return undefined
	const values = path.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
	if (values.length < 6 || values.length % 2 !== 0)
		return undefined
	const points = Array.from({ length: values.length / 2 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }))
	if (points[0].x !== points.at(-1)!.x || points[0].y !== points.at(-1)!.y)
		points.push({ ...points[0] })
	return points
}

function unchanged(source: string, warnings: string[], limitations: string[] = []): DsnRepairResult {
	return { originalText: source, text: source, changed: false, changes: [], warnings, limitations }
}

/** Add only read-back, normalized, filled inner-layer polygons to an exported DSN. */
export async function prepareDsnWithPouredPlanes(sdk: any, source: string, expectedUuid: string, expectedDocumentSource: string): Promise<DsnRepairResult> {
	let host
	try {
		host = await createGeometryHost(sdk, {}, expectedUuid)
		const sourceLog = await host.read('核对当前 PCB 文档身份', () => sdk.sys_FileManager.getDocumentSource())
		const startComparison = comparePcbSourceSnapshots(expectedDocumentSource, sourceLog)
		if (!startComparison.matches)
			throw new Error(`导出 DSN 后 PCB 源码快照已变化：${startComparison.reason}`)
		const parsed = parseSourceLog(sourceLog)
		if (parsed.uuid !== expectedUuid || parsed.docType.toUpperCase() !== 'PCB')
			throw new Error(`当前源码 DOCHEAD ${parsed.uuid}/${parsed.docType} 与导出的 PCB ${expectedUuid} 不符`)
		const [layers, pours, poured] = await Promise.all([
			host.read('读取 PCB 层映射', () => sdk.pcb_Layer.getAllLayers()),
			host.read('读取覆铜边框列表', () => sdk.pcb_PrimitivePour.getAll()),
			host.read('读取实际覆铜填充列表', () => sdk.pcb_PrimitivePoured.getAll()),
		])
		if (!Array.isArray(layers) || !Array.isArray(pours) || !Array.isArray(poured))
			throw new Error('PCB 层、覆铜边框或实际填充列表未返回数组')
		const layerNames = new Map<number, string>()
		for (const layer of layers) {
			const id = Number(layer?.id)
			if (Number.isInteger(id) && id >= 15 && id <= 46 && typeof layer?.name === 'string' && layer.name.trim())
				layerNames.set(id, layer.name)
		}
		const candidates: DsnPlaneRegion[] = []
		const warnings: string[] = []
		for (const pour of pours) {
			const values = await host.read('读取覆铜边框网络与层', () => ({
				id: state<string>(pour, 'PrimitiveId'),
				net: state<string>(pour, 'Net'),
				layerId: Number(state(pour, 'Layer')),
			}))
			if (!values.id || !values.net || !Number.isInteger(values.layerId) || !layerNames.has(values.layerId))
				continue
			const matches = await host.read(`按 PourPrimitiveId 关联 ${values.id} 的实填充`, () => poured
				.filter((item: any) => state<string>(item, 'PourPrimitiveId') === values.id))
			if (matches.length === 0) {
				warnings.push(`覆铜 ${values.id} 没有实际填充对象，未从边框生成平面`)
				continue
			}
			for (const item of matches) {
				const pouredId = await host.read('读取实填充对象 ID', () => state<string>(item, 'PrimitiveId'))
				if (!pouredId) {
					warnings.push(`覆铜 ${values.id} 的实际填充缺少对象 ID，已跳过`)
					continue
				}
				const fills = await host.read(`读取实填充 ${pouredId} 的填充区域`, () => {
					const result = state<any[]>(item, 'PourFills')
					if (!Array.isArray(result))
						throw new Error(`实际填充 ${pouredId} 的 PourFills 未返回数组`)
					return result.map((region: any) => {
						const path = region?.path
						return {
							id: typeof region?.id === 'string' ? region.id : pouredId,
							fill: region?.fill,
							lineWidth: region?.lineWidth,
							declaredCoordinateUnit: region?.coordinateUnit,
							pathSource: typeof path?.getSource === 'function' ? path.getSource() : undefined,
						}
					})
				})
				for (const region of fills) {
					if (region.fill !== true)
						continue
					if (typeof region.lineWidth !== 'number' || !Number.isFinite(region.lineWidth) || region.lineWidth !== 0) {
						warnings.push(`实填充 ${region.id} 的 lineWidth 未验证为 0，未写入平面`)
						continue
					}
					const flatPath = Array.isArray(region.pathSource) && region.pathSource.length === 1 && Array.isArray(region.pathSource[0])
						? region.pathSource[0]
						: region.pathSource
					const normalized = normalizePouredPathSource(flatPath, {
						fill: region.fill,
						lineWidth: region.lineWidth,
						editorVersion: readEditorVersion(sdk),
						declaredCoordinateUnit: region.declaredCoordinateUnit,
					})
					if (normalized.status !== 'normalized' || !Array.isArray(normalized.normalizedPathMil)) {
						warnings.push(`实填充 ${region.id} 的路径/单位未验证，未写入平面`)
						continue
					}
					const pointsMil = polygonPoints(normalized.normalizedPathMil)
					if (!pointsMil) {
						warnings.push(`实填充 ${region.id} 不是支持的直线多边形，未写入平面`)
						continue
					}
					candidates.push({ id: region.id, net: values.net, layerName: layerNames.get(values.layerId)!, pointsMil })
				}
			}
		}
		const sourceAfterReadback = await host.read('核对实填充读回后的 PCB 源码快照', () => sdk.sys_FileManager.getDocumentSource())
		const endComparison = comparePcbSourceSnapshots(expectedDocumentSource, sourceAfterReadback)
		if (!endComparison.matches)
			throw new Error(`读取实填充期间 PCB 源码快照已变化：${endComparison.reason}`)
		await host.finish()
		const augmented = augmentDsnPlanes(source, candidates)
		return { ...augmented, warnings: [...warnings, ...augmented.warnings] }
	}
	catch (error) {
		return unchanged(source, [`读取实填充或核对 PCB 焦点失败，保留原 DSN：${error instanceof Error ? error.message : String(error)}`], [
			'内层平面仅依据可关联且已归一化的实填充多边形生成；未验证数据未用于修改 DSN。',
	])
	}
}
