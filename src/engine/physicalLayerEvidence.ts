import type { ISourceDocument, ISourceRecord } from '../pcb/sourcelog'

export interface PhysicalLayerEvidenceInput {
	document: Pick<ISourceDocument, 'records'>
	layers: unknown[]
	editorVersion: string
}

export interface PhysicalLayerEvidenceRecord {
	layerId: number
	ticket: number
	data: Record<string, unknown>
	thicknessRaw: unknown
	thicknessUnitStatus: 'observed-mil-eda-4.1.78' | 'unknown'
	thicknessValueStatus: 'valid-nonnegative' | 'invalid'
	thicknessMm?: number
	zIndex: number | null
	material: unknown
	permittivity: unknown
	lossTangent: unknown
	sourceLayer?: { layerId: number; layerType: unknown; layerName: unknown; use: unknown }
	sdkLayer?: { layerId: number; type: unknown; name: unknown; status: unknown }
	identityStatus: 'matched' | 'source-missing' | 'sdk-missing' | 'source-sdk-mismatch' | 'ambiguous'
	rawSourceIdentities: Array<{ id: unknown; ticket: unknown; line: number }>
}

export interface PhysicalLayerEvidence {
	schemaVersion: 1
	editorVersion: string
	thicknessUnitStatus: 'observed-mil-eda-4.1.78' | 'unknown'
	unitEvidence: string
	effectiveRecords: PhysicalLayerEvidenceRecord[]
	rawSourceIdentities: Array<{ id: unknown; ticket: unknown; line: number }>
	tombstonedIdentities: number[]
	conflicts: string[]
	unknowns: string[]
	zIndexGroups: Array<{ zIndex: number; layerIds: number[]; conflict: boolean }>
	orderingStatus: 'known-from-unique-source-zIndex' | 'unknown'
	orderedLayers?: PhysicalLayerEvidenceRecord[]
}

interface Resolved<T> {
	records: Array<{ id: number; ticket: number; data: Record<string, unknown>; sources: ISourceRecord[] }>
	tombstones: number[]
	conflicts: number[]
	unknowns: string[]
	rawIdentities: Array<{ id: unknown; ticket: unknown; line: number }>
}

function parseStrictId(record: ISourceRecord, type: 'LAYER_PHYS' | 'LAYER'): number | undefined {
	if (record.header.type !== type || typeof record.header.id !== 'string') return undefined
	try {
		const parsed: unknown = JSON.parse(record.header.id)
		if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== type || !Number.isSafeInteger(parsed[1]) || parsed[1] <= 0) return undefined
		if (JSON.stringify(parsed) !== record.header.id) return undefined
		return parsed[1] as number
	}
	catch { return undefined }
}

function stableValue(value: unknown): string {
	return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}

function resolveType(document: Pick<ISourceDocument, 'records'>, type: 'LAYER_PHYS' | 'LAYER'): Resolved<Record<string, unknown>> {
	const groups = new Map<number, ISourceRecord[]>()
	const unknowns: string[] = []
	const rawIdentities: Resolved<Record<string, unknown>>['rawIdentities'] = []
	for (const record of document.records) {
		if (record.header.type !== type) continue
		rawIdentities.push({ id: record.header.id, ticket: record.header.ticket, line: record.line })
		const id = parseStrictId(record, type)
		if (id === undefined) {
			unknowns.push(`${type}记录身份无效：${String(record.header.id ?? '<missing>')}`)
			continue
		}
		const group = groups.get(id) ?? []
		group.push(record)
		groups.set(id, group)
	}
	const records: Resolved<Record<string, unknown>>['records'] = []
	const tombstones: number[] = []
	const conflicts: number[] = []
	for (const [id, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
		if (group.some(record => !Number.isSafeInteger(record.header.ticket) || (record.header.ticket as number) < 0)) {
			unknowns.push(`${type} ${id} 缺少合法ticket，无法确定生效记录`)
			continue
		}
		const maxTicket = Math.max(...group.map(record => record.header.ticket as number))
		const latest = group.filter(record => record.header.ticket === maxTicket)
		const distinct = new Set(latest.map(record => stableValue(record.data)))
		if (distinct.size !== 1) {
			conflicts.push(id)
			unknowns.push(`${type} ${id} 的最高ticket ${maxTicket} 存在不同内容冲突`)
			continue
		}
		const data = latest[0].data
		if (data === '') {
			tombstones.push(id)
			continue
		}
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			unknowns.push(`${type} ${id} 的生效记录结构无效`)
			continue
		}
		records.push({ id, ticket: maxTicket, data: data as Record<string, unknown>, sources: latest })
	}
	return { records, tombstones, conflicts, unknowns, rawIdentities }
}

interface SdkLayerEvidence { layerId: number; type: unknown; name: unknown; status: unknown; identityConflict?: boolean }

function sdkLayerIndex(layers: unknown[], unknowns: string[]): Map<number, SdkLayerEvidence[]> {
	const result = new Map<number, SdkLayerEvidence[]>()
	for (const [index, value] of layers.entries()) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			unknowns.push(`SDK图层第${index + 1}项结构无效`)
			continue
		}
		const row = value as Record<string, unknown>
		if (row.id !== undefined && row.layerId !== undefined && row.id !== row.layerId) {
			unknowns.push(`SDK图层第${index + 1}项id/layerId身份冲突`)
			for (const alias of [row.id, row.layerId]) if (Number.isSafeInteger(alias) && (alias as number) > 0) {
				const item: SdkLayerEvidence = { layerId: alias as number, type: row.type ?? row.layerType, name: row.layerName ?? row.name, status: row.status ?? row.layerStatus, identityConflict: true }
				result.set(item.layerId, [...(result.get(item.layerId) ?? []), item])
			}
			continue
		}
		const id = row.layerId ?? row.id
		if (!Number.isSafeInteger(id) || (id as number) <= 0) {
			unknowns.push(`SDK图层第${index + 1}项身份无效`)
			continue
		}
		const item = { layerId: id as number, type: row.type ?? row.layerType, name: row.layerName ?? row.name, status: row.status ?? row.layerStatus }
		result.set(item.layerId, [...(result.get(item.layerId) ?? []), item])
	}
	for (const [id, matches] of result) if (matches.length !== 1) unknowns.push(`SDK图层 ${id} 身份重复`)
	return result
}

export function buildPhysicalLayerEvidence(input: PhysicalLayerEvidenceInput): PhysicalLayerEvidence {
	const thicknessUnitStatus = input.editorVersion === '4.1.78' ? 'observed-mil-eda-4.1.78' : 'unknown'
	const physical = resolveType(input.document, 'LAYER_PHYS')
	const sourceLayers = resolveType(input.document, 'LAYER')
	const unknowns = [...physical.unknowns, ...sourceLayers.unknowns]
	const conflicts = [
		...physical.conflicts.map(id => `LAYER_PHYS:${id}`),
		...sourceLayers.conflicts.map(id => `LAYER:${id}`),
	]
	const sourceById = new Map(sourceLayers.records.map(record => [record.id, record]))
	const sdkById = sdkLayerIndex(input.layers, unknowns)
	const effectiveRecords: PhysicalLayerEvidenceRecord[] = physical.records.map(record => {
		const source = sourceById.get(record.id)
		const sourceData = source?.data
		let identityStatus: PhysicalLayerEvidenceRecord['identityStatus'] = 'matched'
		if (source && sourceData?.layerId !== record.id) {
			identityStatus = 'source-sdk-mismatch'
			unknowns.push(`LAYER_PHYS ${record.id} 与生效LAYER数据身份不一致`)
		}
		else if (!source) identityStatus = 'source-missing'
		const sdkMatches = sdkById.get(record.id) ?? []
		if (sdkMatches.length > 1) identityStatus = 'ambiguous'
		else if (sdkMatches.length === 0 && identityStatus === 'matched') identityStatus = 'sdk-missing'
		else if (sdkMatches.length === 1 && (sdkMatches[0].identityConflict || sdkMatches[0].layerId !== record.id)) identityStatus = 'source-sdk-mismatch'
		if (identityStatus !== 'matched') unknowns.push(`LAYER_PHYS ${record.id} 的source/SDK身份关联状态为 ${identityStatus}`)
		const rawZ = record.data.zIndex
		const zIndex = typeof rawZ === 'number' && Number.isFinite(rawZ) ? rawZ : null
		if (zIndex === null) unknowns.push(`LAYER_PHYS ${record.id} 的zIndex不是有限数值`)
		return {
			layerId: record.id,
			ticket: record.ticket,
			data: record.data,
			thicknessRaw: record.data.thickness,
			thicknessUnitStatus,
			thicknessValueStatus: typeof record.data.thickness === 'number' && Number.isFinite(record.data.thickness) && record.data.thickness >= 0 ? 'valid-nonnegative' : 'invalid',
			...(thicknessUnitStatus === 'observed-mil-eda-4.1.78' && typeof record.data.thickness === 'number' && Number.isFinite(record.data.thickness) && record.data.thickness >= 0 && Number.isFinite(record.data.thickness * 0.0254)
				? { thicknessMm: record.data.thickness * 0.0254 } : {}),
			zIndex,
			material: record.data.material,
			permittivity: record.data.permittivity,
			lossTangent: record.data.lossTangent,
			...(sourceData ? { sourceLayer: { layerId: source!.id, layerType: sourceData.layerType, layerName: sourceData.layerName, use: sourceData.use } } : {}),
			...(sdkMatches.length === 1 ? { sdkLayer: sdkMatches[0] } : {}),
			identityStatus,
			rawSourceIdentities: record.sources.map(item => ({ id: item.header.id, ticket: item.header.ticket, line: item.line })),
		}
	})
	const groups = new Map<number, number[]>()
	for (const record of effectiveRecords) if (record.zIndex !== null) groups.set(record.zIndex, [...(groups.get(record.zIndex) ?? []), record.layerId])
	const zIndexGroups = [...groups.entries()].sort(([a], [b]) => a - b).map(([zIndex, layerIds]) => ({ zIndex, layerIds: [...layerIds].sort((a, b) => a - b), conflict: layerIds.length > 1 }))
	for (const group of zIndexGroups) if (group.conflict) unknowns.push(`LAYER_PHYS zIndex ${group.zIndex} 冲突：${group.layerIds.join(', ')}`)
	const hasUnknownPhysical = physical.unknowns.length > 0 || physical.conflicts.length > 0
	const orderingKnown = !hasUnknownPhysical && effectiveRecords.length > 0 && effectiveRecords.every(record => record.zIndex !== null) && zIndexGroups.every(group => !group.conflict)
	const orderedLayers = orderingKnown ? [...effectiveRecords].sort((a, b) => a.zIndex! - b.zIndex!) : undefined
	return {
		schemaVersion: 1,
		editorVersion: input.editorVersion,
		thicknessUnitStatus,
		unitEvidence: '原生 UI、源码及保存重开观察支持 EDA 4.1.78 的 LAYER_PHYS thickness 按 mil 解释；这是观察到的单位证据，不代表固定量化算法或误差界限。换算仅用于报告，不写回 UI。',
		effectiveRecords,
		rawSourceIdentities: physical.rawIdentities,
		tombstonedIdentities: physical.tombstones,
		conflicts,
		unknowns: [...new Set(unknowns)],
		zIndexGroups,
		orderingStatus: orderingKnown ? 'known-from-unique-source-zIndex' : 'unknown',
		...(orderedLayers ? { orderedLayers } : {}),
	}
}
