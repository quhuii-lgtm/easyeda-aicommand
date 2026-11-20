import { effectiveRecordsByType, parseSourceLog } from '../pcb/sourcelog'

const COORDINATE_TOLERANCE_MIL = 0.001

export interface FootprintRouteViaProof {
	id: string
	componentId: string
	footprintUuid: string
	localViaId: string
	net: string
	x: number
	y: number
	diameterMil: number
	holeDiameterMil: number
	viaType: 0
	locked: boolean
}

export interface FootprintRouteComponent {
	id: string
	footprintUuid: string
	x: number
	y: number
	angle: number
	layerId: number
	footprintPrimitives: boolean
	data: Record<string, unknown>
}

export interface FootprintRouteSdkVia {
	id: string
	net: string
	x: number
	y: number
	diameterMil: number
	holeDiameterMil?: number
	viaType: 0 | 1 | 2
	locked: boolean
}

function finite(value: unknown, field: string, context: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`${context} 的 ${field} 不是有限数`)
	return value
}

function positive(value: unknown, field: string, context: string): number {
	const result = finite(value, field, context)
	if (!(result > 0))
		throw new Error(`${context} 的 ${field} 必须大于 0`)
	return result
}

/** Resolve only explicit, effective COMPONENT/Footprint attributes for instances that may own an SDK-only via. */
export function findFootprintViaComponents(pcbSource: string, unmappedSdkVias: FootprintRouteSdkVia[]): FootprintRouteComponent[] {
	const document = parseSourceLog(pcbSource)
	if (document.docType !== 'PCB')
		throw new Error('读取封装内过孔时，文档源码不是 PCB')
	const components = effectiveRecordsByType(document, 'COMPONENT')
	const attrs = effectiveRecordsByType(document, 'ATTR')
	const unresolved = unmappedSdkVias
	const unresolvedIds = new Set(unresolved.map(via => via.id))
	const candidateComponentIds = new Set<string>()
	for (const record of effectiveRecordsByType(document, 'PAD_NET')) {
		let tuple: unknown
		try { tuple = JSON.parse(String(record.header.id ?? '')) } catch { continue }
		if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== 'PAD_NET'
			|| typeof tuple[1] !== 'string' || typeof tuple[2] !== 'string' || tuple[2] !== tuple[3])
			continue
		const componentId = tuple[1] as string
		const localViaId = tuple[2] as string
		if (unresolvedIds.has(`${componentId}${localViaId}`))
			candidateComponentIds.add(componentId)
	}
	const result: FootprintRouteComponent[] = []
	for (const record of components) {
		const id = String(record.header.id ?? '')
		if (!id || !candidateComponentIds.has(id))
			continue
		const data = record.data as Record<string, unknown> | ''
		if (!data || typeof data !== 'object')
			throw new Error(`组件 ${id} 的源数据无法读取`)
		const footprintAttrs = attrs.filter(attr => {
			const attrData = attr.data as Record<string, unknown> | ''
			return attrData && typeof attrData === 'object'
				&& attrData.parentId === id
				&& typeof attrData.key === 'string'
				&& attrData.key.toLowerCase() === 'footprint'
		})
		if (footprintAttrs.length !== 1)
			throw new Error(`组件 ${id} 的 Footprint ATTR 不是唯一记录`)
		const footprintAttrData = footprintAttrs[0].data as Record<string, unknown>
		if (typeof footprintAttrData.value !== 'string' || !footprintAttrData.value.trim())
			throw new Error(`组件 ${id} 的 Footprint ATTR 缺少封装 UUID`)
		const layerId = finite(data.layerId, 'layerId', `组件 ${id}`)
		result.push({
			id,
			footprintUuid: footprintAttrData.value,
			x: finite(data.x, 'x', `组件 ${id}`),
			y: finite(data.y, 'y', `组件 ${id}`),
			angle: finite(data.angle, 'angle', `组件 ${id}`),
			layerId,
			footprintPrimitives: data.footprintPrimitives === true,
			data,
		})
	}
	return result
}

function transformedTopPoint(component: FootprintRouteComponent, localX: number, localY: number): { x: number, y: number } {
	const radians = component.angle * Math.PI / 180
	return {
		x: component.x + localX * Math.cos(radians) - localY * Math.sin(radians),
		y: component.y + localX * Math.sin(radians) + localY * Math.cos(radians),
	}
}

function sizeReadbackMatches(sourceMil: number, sdkMil: number): boolean {
	if (sourceMil === sdkMil)
		return true
	const projected = Math.round(sourceMil * 10) / 10
	return Math.abs(sdkMil - projected) <= Number.EPSILON * Math.max(1, Math.abs(projected)) * 2
}

function componentPadNet(pcbDocument: ReturnType<typeof parseSourceLog>, componentId: string, localViaId: string): string {
	const expectedId = JSON.stringify(['PAD_NET', componentId, localViaId, localViaId])
	const records = effectiveRecordsByType(pcbDocument, 'PAD_NET').filter(record => record.header.id === expectedId)
	if (records.length !== 1)
		throw new Error(`组件 ${componentId} 封装过孔 ${localViaId} 的 PAD_NET 源记录不唯一`)
	const data = records[0].data as Record<string, unknown> | ''
	if (!data || typeof data !== 'object' || typeof data.padNet !== 'string' || !data.padNet.trim())
		throw new Error(`组件 ${componentId} 封装过孔 ${localViaId} 的 PAD_NET 网络为空或不可判定`)
	return data.padNet
}

/** Prove top-side footprint NORMAL vias from the actual footprint source and board SDK/source net binding. */
export function matchTopFootprintVias(
	pcbSource: string,
	components: FootprintRouteComponent[],
	footprintSources: Array<{ footprintUuid: string, documentSource: string }>,
	sdkVias: FootprintRouteSdkVia[],
): FootprintRouteViaProof[] {
	const pcbDocument = parseSourceLog(pcbSource)
	const sourcesByUuid = new Map<string, string>()
	for (const source of footprintSources) {
		if (!source?.footprintUuid || typeof source.documentSource !== 'string' || sourcesByUuid.has(source.footprintUuid))
			throw new Error('封装来源存在无效项或重复 UUID')
		sourcesByUuid.set(source.footprintUuid, source.documentSource)
	}
	const sdkById = new Map<string, FootprintRouteSdkVia>()
	for (const via of sdkVias) {
		if (!via.id || sdkById.has(via.id))
			throw new Error(`SDK 过孔 ID ${via.id || '(empty)'} 重复或无效`)
		sdkById.set(via.id, via)
	}
	const proofs: FootprintRouteViaProof[] = []
	const proofIds = new Set<string>()
	for (const component of components) {
		const source = sourcesByUuid.get(component.footprintUuid)
		if (!source)
			throw new Error(`组件 ${component.id} 的封装 ${component.footprintUuid} 来源不可用`)
		const footprint = parseSourceLog(source)
		if (footprint.docType !== 'FOOTPRINT' || footprint.uuid !== component.footprintUuid)
			throw new Error(`封装 ${component.footprintUuid} 的来源文档类型或 UUID 不匹配`)
		const vias = effectiveRecordsByType(footprint, 'VIA')
		for (const record of vias) {
			const data = record.data as Record<string, unknown> | ''
			if (!data || typeof data !== 'object')
				throw new Error(`封装 ${component.footprintUuid} 的 VIA ${record.header.id} 数据不可读`)
			if (data.viaType !== 'NORMAL')
				continue
			const localViaId = String(record.header.id ?? '')
			if (!localViaId)
				throw new Error(`封装 ${component.footprintUuid} 存在无有效 ID 的 NORMAL VIA`)
			const id = `${component.id}${localViaId}`
			if (proofIds.has(id))
				throw new Error(`封装内过孔实例 ID ${id} 重复`)
			const sdk = sdkById.get(id)
			if (!sdk)
				continue
			proofIds.add(id)
			if (!component.footprintPrimitives)
				throw new Error(`组件 ${component.id} 未声明封装图元已实例化，不能关联封装内过孔`)
			if (component.layerId !== 1)
				throw new Error(`组件 ${component.id} 位于非顶层，封装内过孔变换尚未验证`)
			if (component.data.mirror === true || component.data.reverse === true || component.data.flipped === true)
				throw new Error(`组件 ${component.id} 存在镜像状态，封装内过孔变换尚未验证`)
			if (sdk.viaType !== 0)
				throw new Error(`封装内过孔 ${id} SDK viaType 与 NORMAL 源记录不一致`)
			// Footprint source geometry values are already in mil; CANVAS.unit is display state and is not a conversion factor.
			const localX = finite(data.centerX, 'centerX', `封装 VIA ${localViaId}`)
			const localY = finite(data.centerY, 'centerY', `封装 VIA ${localViaId}`)
			const point = transformedTopPoint(component, localX, localY)
			if (Math.abs(sdk.x - point.x) > COORDINATE_TOLERANCE_MIL || Math.abs(sdk.y - point.y) > COORDINATE_TOLERANCE_MIL)
				throw new Error(`封装内过孔 ${id} 坐标与组件顶面变换不一致`)
			const diameterMil = positive(data.viaDiameter, 'viaDiameter', `封装 VIA ${localViaId}`)
			const holeDiameterMil = positive(data.holeDiameter, 'holeDiameter', `封装 VIA ${localViaId}`)
			if (!(diameterMil > holeDiameterMil) || sdk.holeDiameterMil == null || !(sdk.holeDiameterMil > 0)
				|| !sizeReadbackMatches(diameterMil, sdk.diameterMil) || !sizeReadbackMatches(holeDiameterMil, sdk.holeDiameterMil))
				throw new Error(`封装内过孔 ${id} 孔径与SDK读回不一致`)
			if (typeof data.locked !== 'boolean' || sdk.locked !== data.locked)
				throw new Error(`封装内过孔 ${id} 自身锁定状态与SDK读回不一致`)
			const net = componentPadNet(pcbDocument, component.id, localViaId)
			if (typeof sdk.net !== 'string' || !sdk.net || sdk.net !== net)
				throw new Error(`封装内过孔 ${id} 的PAD_NET与SDK实际网络不一致`)
			if (typeof data.netName === 'string' && data.netName.trim() && data.netName !== net)
				throw new Error(`封装内过孔 ${id} 封装网络名与板级PAD_NET不一致`)
			proofs.push({ id, componentId: component.id, footprintUuid: component.footprintUuid, localViaId, net, x: point.x, y: point.y, diameterMil, holeDiameterMil, viaType: 0, locked: data.locked })
		}
	}
	return proofs
}
