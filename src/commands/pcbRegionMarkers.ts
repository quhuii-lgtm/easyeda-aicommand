import type { ICommandDef } from '../engine/types'
import { appendRecords, effectiveRecordsByType, extractPcbDocument, extractSchematicRects, findOwningRect, getMaxTicket, parseSourceLog, resolveRecords, type IBBox, type ISourcePcbComponent, type IPendingRecord } from '../pcb/sourcelog'

const PREFIX = 'aicr_region_'
const DOC_LAYER = 13
const MARKER_FONT = '黑体'
type Region = { regionId: string, pageUuid: string, pageName: string, rectId: string, name: string, bbox: IBBox | null, members: Array<{ componentId: string, designator: string, locked: boolean, matchedBy: 'uniqueId' | 'designator' }>, unmatched: string[], ambiguous: string[], identityConflicts: string[], warnings: string[] }
type Target = { uuid: string, tabId: string, board: any, initialTabs: Set<string> }

function active(): Promise<any> { return eda.dmt_SelectControl.getCurrentDocumentInfo() }
async function target(params: any): Promise<Target> {
	const doc = await active()
	if (doc?.documentType !== 3 || typeof doc.uuid !== 'string' || !doc.uuid.trim() || typeof doc.tabId !== 'string' || !doc.tabId.trim()) throw new Error('需要当前有效 PCB 文档和标签页')
	if ((params.__docUuid && params.__docUuid !== doc.uuid) || (params.__tabId && params.__tabId !== doc.tabId)) throw new Error('PCB 文档或标签页与请求目标不符')
	const project: any = await eda.dmt_Project.getCurrentProjectInfo()
	const board = (project?.data ?? []).find((item: any) => item?.pcb?.uuid === doc.uuid)
	if (!board) throw new Error(`当前 PCB ${doc.uuid} 未关联到工程中的 Board；拒绝回退到其他板`)
	const tree: any = await eda.dmt_EditorControl.getSplitScreenTree()
	if (!tree) throw new Error('无法读取已打开标签页清单；拒绝为读取原理图而误关用户已有页面')
	const initialTabs = new Set<string>()
	const walk = (node: any) => { for (const tab of node?.tabs ?? []) if (tab?.tabId) initialTabs.add(String(tab.tabId)); for (const child of node?.children ?? []) walk(child) }
	walk(tree)
	return { uuid: doc.uuid, tabId: doc.tabId, board, initialTabs }
}
async function assertTarget(target: Target): Promise<void> {
	const doc = await active()
	if (doc?.documentType !== 3 || doc.uuid !== target.uuid || doc.tabId !== target.tabId) throw new Error('操作期间 PCB 文档或标签页已变化')
}
async function readPcb(target: Target): Promise<{ source: string, doc: ReturnType<typeof parseSourceLog>, parsed: ReturnType<typeof extractPcbDocument> }> {
	await assertTarget(target)
	const source = await eda.sys_FileManager.getDocumentSource()
	if (typeof source !== 'string' || !source) throw new Error('无法读取当前 PCB 源码')
	const doc = parseSourceLog(source), parsed = extractPcbDocument(source)
	if (doc.uuid !== target.uuid || parsed.uuid !== target.uuid) throw new Error(`PCB 源码 UUID 不符：目标 ${target.uuid}，读到 ${doc.uuid}`)
	if (!/pcb/i.test(doc.docType)) throw new Error(`当前文档源码类型不是 PCB：${doc.docType}`)
	await assertTarget(target)
	return { source, doc, parsed }
}
function norm(value: string): string { return value.trim().toUpperCase().replace(/([A-Z]+\d+)[A-Z]+$/, '$1') }
function union(boxes: IBBox[]): IBBox | null {
	if (!boxes.length) return null
	return { minX: Math.min(...boxes.map(b => b.minX)), minY: Math.min(...boxes.map(b => b.minY)), maxX: Math.max(...boxes.map(b => b.maxX)), maxY: Math.max(...boxes.map(b => b.maxY)) }
}
function sourceNumber(value: number): number {
	if (!Number.isFinite(value)) throw new Error(`PCB 标记坐标/尺寸不是有限数值：${String(value)}`)
	return Number(value.toFixed(4))
}
function stableId(pcbUuid: string, regionId: string, kind: string): string { return `${PREFIX}${[...`${pcbUuid}/${regionId}/v1`].map(c => c.codePointAt(0)!.toString(16)).join('_')}_${kind}` }
function ownedMarkerId(pcbUuid: string, id: string): boolean {
	const namespace = [...`${pcbUuid}/`].map(c => c.codePointAt(0)!.toString(16)).join('_')
	return id.startsWith(`${PREFIX}${namespace}`) && /^(?:[0-9a-f]+_)*[0-9a-f]+_(?:border|label)$/.test(id.slice(PREFIX.length))
}
function markerShape(type: string, data: any): boolean {
	if (type === 'POLY') return Number(data?.layerId) === DOC_LAYER && Array.isArray(data?.path) && data.path[0] === 'R' && Number.isFinite(Number(data.path[1])) && Number.isFinite(Number(data.path[2])) && Number.isFinite(Number(data.path[3])) && Number.isFinite(Number(data.path[4]))
	if (type === 'STRING') return Number(data?.layerId) === DOC_LAYER && typeof data?.text === 'string' && Number.isFinite(Number(data?.x)) && Number.isFinite(Number(data?.y))
	return false
}
function markerRecords(regions: Region[], doc: ReturnType<typeof parseSourceLog>, fontFamily = MARKER_FONT): IPendingRecord[] {
	const ticket = getMaxTicket(doc)
	let next = ticket
	const pending: IPendingRecord[] = []
	for (const region of regions) {
		if (!region.bbox || !region.members.length) continue
		const b = region.bbox, w = b.maxX - b.minX, h = b.maxY - b.minY
		pending.push({ header: { type: 'POLY', id: stableId(doc.uuid, region.regionId, 'border'), ticket: ++next }, data: { partitionId: '', groupId: 0, netName: '', layerId: DOC_LAYER, width: sourceNumber(10), path: ['R', sourceNumber(b.minX - 40), sourceNumber(b.maxY + 40), sourceNumber(w + 80), sourceNumber(h + 80), 0, 0], locked: false, zIndex: -1, polyType: 'NORMAL' } })
		pending.push({ header: { type: 'STRING', id: stableId(doc.uuid, region.regionId, 'label'), ticket: ++next }, data: { partitionId: '', groupId: 0, layerId: DOC_LAYER, x: sourceNumber(b.minX), y: sourceNumber(b.maxY + 55), text: region.name, fontFamily, fontSize: 30, strokeWidth: 3, bold: 0, italic: 0, origin: 'LEFT_BOTTOM', angle: 0, reverse: false, expansion: 0, mirror: false, locked: false, zIndex: -1, specialColor: null } })
	}
	const desired = new Set(pending.map(item => `${item.header.type}\0${item.header.id}`))
	const live = resolveRecords(doc)
	for (const record of live.values()) {
		if (!record.header.id || !ownedMarkerId(doc.uuid, record.header.id) || !markerShape(record.header.type, record.data)) continue
		if (desired.has(`${record.header.type}\0${record.header.id}`)) continue
		pending.push({ header: { type: record.header.type, id: record.header.id, ticket: ++next }, data: '' })
	}
	for (const item of pending.filter(record => record.data !== '')) {
		const current = live.get(`${item.header.type}\0${item.header.id}`)
		if (current && (!ownedMarkerId(doc.uuid, String(current.header.id)) || !markerShape(current.header.type, current.data))) throw new Error(`标记 ID 与非本功能记录冲突：${current.header.id}`)
	}
	return pending
}
function meaningful(snapshot: { parsed: ReturnType<typeof extractPcbDocument>, doc: ReturnType<typeof parseSourceLog> }): { uuid: string, docType: string, components: unknown, records: Array<[string, unknown]> } {
	const components = snapshot.parsed.components.map(c => [c.id, c.x, c.y, c.angle, c.layerId, c.locked]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
	const records = [...resolveRecords(snapshot.doc)].filter(([key, value]) => key.slice(0, key.indexOf('\0')) !== 'DOCHEAD' && !(ownedMarkerId(snapshot.doc.uuid, key.slice(key.indexOf('\0') + 1)) && markerShape(value.header.type, value.data))).map(([key, value]) => [key, value.data] as [string, unknown]).sort((a, b) => a[0].localeCompare(b[0]))
	return { uuid: snapshot.doc.uuid, docType: snapshot.doc.docType, components, records }
}
async function readRegions(target: Target, ctx?: any): Promise<{ regions: Region[], signature: string, pcb: Awaited<ReturnType<typeof readPcb>> }> {
	const pcb = await readPcb(target)
	const pages = (target.board?.schematic?.page ?? []) as Array<any>
	if (!pages.length) throw new Error('当前关联 Board 没有原理图页；未尝试其他 Board')
	const schMembers: Array<{ pageUuid: string, pageName: string, rectId: string, rectLabel: string, designator: string, uniqueId: string }> = []
	const regions: Region[] = []
	const addedTabs: string[] = []
	try {
		for (const page of pages) {
			ctx?.stopSignal?.assertActive()
			const tabId = await eda.dmt_EditorControl.openDocument(String(page.uuid))
			if (!tabId) throw new Error(`无法打开原理图页 ${page.name ?? page.uuid}`)
			if (!target.initialTabs.has(String(tabId))) addedTabs.push(String(tabId))
			if (!await eda.dmt_EditorControl.activateDocument(tabId)) throw new Error(`无法激活原理图页 ${page.uuid}`)
			const source = await eda.sys_FileManager.getDocumentSource()
			if (!source) throw new Error(`无法读取原理图页 ${page.uuid}`)
			const focused = await active()
			if (focused?.documentType === 3 || focused?.uuid !== String(page.uuid)) throw new Error(`原理图读取焦点与目标页不符：期望 ${page.uuid}，当前 ${focused?.uuid ?? '未知'}`)
			const sch = extractSchematicRects(source)
			if (sch.uuid !== String(page.uuid)) throw new Error(`原理图页身份不符：期望 ${page.uuid}，读到 ${sch.uuid}`)
			const schDoc = parseSourceLog(source)
			const attrData = effectiveRecordsByType(schDoc, 'ATTR').map(record => record.data as any)
			const uniqueByParent = new Map(attrData.filter(data => String(data?.key).toLowerCase() === 'unique id').map(data => [String(data.parentId), String(data.value)]))
			const namedRects = new Map(attrData.filter(data => String(data?.key).toLowerCase() === 'name').map(data => [String(data.parentId), String(data.value)]))
			const texts = effectiveRecordsByType(schDoc, 'TEXT').map(record => record.data as any)
			for (const rect of sch.rects) {
				const owners = sch.components.filter(c => c.designator && findOwningRect(sch.rects, c)?.id === rect.id)
				const titleCandidates = texts.filter(text => {
					const x = Number(text?.x), y = Number(text?.y)
					return Number.isFinite(x) && Number.isFinite(y) && x >= rect.bbox.minX && x - rect.bbox.minX <= 80 && y >= rect.bbox.minY && y - rect.bbox.minY <= 80 && typeof (text.value ?? text.text) === 'string' && String(text.value ?? text.text).trim()
				})
				const explicitName = namedRects.get(rect.id)
				const title = explicitName || (titleCandidates.length === 1 ? String(titleCandidates[0].value ?? titleCandidates[0].text).trim() : '')
				const warning = explicitName ? [] : title ? [] : [`未找到唯一的近框标题 TEXT，使用 ${rect.label}`]
				regions.push({ regionId: `${page.uuid}/${rect.id}`, pageUuid: String(page.uuid), pageName: String(page.name ?? page.uuid), rectId: rect.id, name: `${page.name ?? page.uuid}/${title || rect.label}`, bbox: null, members: [], unmatched: [], ambiguous: [], identityConflicts: [], warnings: warning })
				for (const c of owners) schMembers.push({ pageUuid: String(page.uuid), pageName: String(page.name ?? page.uuid), rectId: rect.id, rectLabel: rect.label, designator: c.designator, uniqueId: uniqueByParent.get(c.id) ?? '' })
			}
		}
	}
		finally {
			const restored = await eda.dmt_EditorControl.activateDocument(target.tabId).catch(() => false)
			if (!restored) throw new Error('未能恢复原 PCB 标签；为保护用户页面，未关闭新打开的原理图标签')
			for (const tabId of addedTabs) await eda.dmt_EditorControl.closeDocument(tabId).catch(() => false)
	}
	await assertTarget(target)
	const pcbByNorm = new Map<string, ISourcePcbComponent[]>()
	for (const c of pcb.parsed.components) { const k = norm(c.designator); if (!k) continue; pcbByNorm.set(k, [...(pcbByNorm.get(k) ?? []), c]) }
	const pcbAttrs = new Map<string, string>()
	for (const record of effectiveRecordsByType(pcb.doc, 'ATTR')) { const data = record.data as any; if (String(data?.key).toLowerCase() === 'unique id') pcbAttrs.set(String(data.parentId), String(data.value)) }
	const uniqueOf = (component: ISourcePcbComponent): string => {
		const attrs: any = component.data?.attrs
		const embedded = attrs && typeof attrs === 'object' ? Object.entries(attrs).find(([key]) => key.toLowerCase() === 'unique id')?.[1] : undefined
		return String(embedded ?? pcbAttrs.get(component.id) ?? '')
	}
	const pcbByUnique = new Map<string, ISourcePcbComponent[]>()
	for (const component of pcb.parsed.components) { const uid = uniqueOf(component); if (uid) pcbByUnique.set(uid, [...(pcbByUnique.get(uid) ?? []), component]) }
	const candidate = (sch: { uniqueId: string, designator: string }): { component?: ISourcePcbComponent, by?: 'uniqueId' | 'designator', ambiguous?: boolean, identityConflict?: boolean } => {
		const byUid = sch.uniqueId ? pcbByUnique.get(sch.uniqueId) ?? [] : []
		if (byUid.length === 1) return { component: byUid[0], by: 'uniqueId' }
		if (byUid.length > 1) return { ambiguous: true }
		const byRef = pcbByNorm.get(norm(sch.designator)) ?? []
		if (byRef.length > 1) return { ambiguous: true }
		if (byRef.length === 1) {
			const pcbUid = uniqueOf(byRef[0])
			if (sch.uniqueId && pcbUid && pcbUid !== sch.uniqueId) return { identityConflict: true }
			return { component: byRef[0], by: 'designator' }
		}
		return {}
	}
	const claims = new Map<string, Set<string>>()
	for (const sch of schMembers) {
		const result = candidate(sch)
		if (!result.component) continue
		const claimSet = claims.get(result.component.id) ?? new Set<string>()
		claimSet.add(result.by === 'uniqueId' ? `${sch.pageUuid}/${sch.rectId}/uid/${sch.uniqueId}` : `${sch.pageUuid}/${sch.rectId}/sch/${sch.designator}`)
		claims.set(result.component.id, claimSet)
	}
	const boxes = new Map<string, IBBox>()
	for (const c of pcb.parsed.components) {
		if (!claims.has(c.id)) continue
		try { const bb = await eda.pcb_Primitive.getPrimitivesBBox([c.id]); await assertTarget(target); if (bb) boxes.set(c.id, bb) } catch { /* Missing geometry remains visible as a blocker in results. */ }
	}
	const emitted = new Map<string, { uniqueId: string, usedUniqueId: boolean }>()
	for (const sch of schMembers) {
		const region = regions.find(r => r.pageUuid === sch.pageUuid && r.rectId === sch.rectId)!
		const result = candidate(sch)
		if (!result.component) {
			if (result.ambiguous) region.ambiguous.push(sch.designator)
			else {
				region.unmatched.push(sch.designator)
				if (result.identityConflict) region.identityConflicts.push(sch.designator)
			}
			continue
		}
		const component = result.component
		if ((claims.get(component.id)?.size ?? 0) !== 1) { region.ambiguous.push(sch.designator); continue }
		const withinRegion = `${region.regionId}/${component.id}`
		const previous = emitted.get(withinRegion)
		if (previous) {
			if (result.by === 'uniqueId' && previous.usedUniqueId && sch.uniqueId && previous.uniqueId === sch.uniqueId) continue
			region.ambiguous.push(sch.designator)
			continue
		}
		emitted.set(withinRegion, { uniqueId: sch.uniqueId, usedUniqueId: result.by === 'uniqueId' })
		region.members.push({ componentId: component.id, designator: component.designator, locked: component.locked, matchedBy: result.by! })
	}
	for (const region of regions) {
		region.unmatched = [...new Set(region.unmatched)]
		region.ambiguous = [...new Set(region.ambiguous)]
		region.identityConflicts = [...new Set(region.identityConflicts)]
		const members = region.members.map(m => m.componentId)
		region.bbox = members.length && members.every(id => boxes.has(id)) ? union(members.map(id => boxes.get(id)!)) : null
	}
	const signature = JSON.stringify({ pcb: target.uuid, regions: regions.map(r => ({ regionId: r.regionId, name: r.name, members: r.members.map(m => m.componentId).sort(), bbox: r.bbox, unmatched: [...r.unmatched].sort(), ambiguous: [...r.ambiguous].sort(), identityConflicts: [...r.identityConflicts].sort() })) })
	return { regions, signature, pcb }
}

function failPartial(error: unknown, docUuid: string, writtenIds: string[], detail: unknown): never {
	throw Object.assign(new Error(`PCB 功能区标记写入未完成：${String((error as any)?.message ?? error)}`), { cause: { partial: writtenIds.length > 0, docUUID: docUuid, writtenIds, detail } })
}

export const pcbRegionMarkerCommands: ICommandDef[] = [
	{
		name: 'pcb.getSchematicRegions', summary: '读取当前关联原理图功能区、唯一匹配成员及其当前几何包围盒', params: [], returns: '{ docUUID, regions, signature }', example: { cmd: 'pcb.getSchematicRegions' },
		handler: async (params, ctx) => { const t = await target(params); const result = await readRegions(t, ctx); return { docUUID: t.uuid, regions: result.regions, signature: result.signature } },
	},
	{
		name: 'pcb.markSchematicRegions', summary: '在 PCB 文档层为原理图功能区添加或更新边框和名称；不移动任何器件',
		params: [{ name: 'dryRun', type: 'boolean', description: '默认 true，只预览；必须传 false 才写入' }, { name: 'expectedSignature', type: 'string', description: '可选：从 pcb.getSchematicRegions 返回的 signature，防止预览后成员/几何变化' }],
		returns: '{ dryRun, docUUID, regions, written, verified, saved, signature }', example: { cmd: 'pcb.markSchematicRegions', params: { dryRun: true } },
		handler: async (params, ctx) => {
			const t = await target(params), result = await readRegions(t, ctx)
			if (params.expectedSignature !== undefined && params.expectedSignature !== result.signature) throw new Error('功能区成员或当前几何已变化；预览签名不匹配，未写入')
			const missingGeometry = result.regions.filter(region => region.members.length && !region.bbox)
			if (params.dryRun === false && missingGeometry.length) throw new Error(`以下功能区成员几何包围盒读取不完整，拒绝标记：${missingGeometry.map(region => region.regionId).join(', ')}`)
			if (params.dryRun !== false) return { dryRun: true, docUUID: t.uuid, regions: result.regions, written: 0, signature: result.signature }
			if (typeof eda.sys_FontManager?.getFontsList !== 'function') throw new Error('当前 SDK 不支持读取已配置字体；未写入 PCB')
			const fonts = await eda.sys_FontManager.getFontsList()
			const markerFont = Array.isArray(fonts)
				? ([MARKER_FONT, 'Arial', 'Verdana', 'Times New Roman'].find(font => fonts.includes(font)) ?? fonts.find(font => typeof font === 'string' && font.trim() && font !== 'default' && font !== 'default2'))
				: undefined
			if (!markerFont) throw new Error('没有可用于 PCB 区域名称的已配置明确字体；未写入 PCB')
			let pending = markerRecords(result.regions, result.pcb.doc, markerFont)
			if (!pending.length) return { dryRun: false, docUUID: t.uuid, regions: result.regions, written: 0, verified: true, saved: false, signature: result.signature }
			ctx?.stopSignal?.assertActive()
			await assertTarget(t)
			const before = meaningful(result.pcb)
			let touched = pending.map(r => `${r.header.type}:${r.header.id}`)
			let started = false
			try {
				const freshSource = await eda.sys_FileManager.getDocumentSource()
				await assertTarget(t)
				if (typeof freshSource !== 'string' || !freshSource) throw new Error('写入前 PCB 源码为空')
				const freshDoc = parseSourceLog(freshSource), freshPcb = extractPcbDocument(freshSource)
				if (freshDoc.uuid !== t.uuid || freshDoc.docType !== result.pcb.doc.docType || freshPcb.uuid !== t.uuid) throw new Error('写入前 PCB 文档身份或类型已变化')
				if (JSON.stringify(before) !== JSON.stringify(meaningful({ doc: freshDoc, parsed: freshPcb }))) throw new Error('PCB 有效记录在预览后发生变化；拒绝覆盖新内容')
				pending = markerRecords(result.regions, freshDoc, markerFont)
				touched = pending.map(r => `${r.header.type}:${r.header.id}`)
				ctx?.stopSignal?.assertActive()
				await assertTarget(t)
				started = true
				const ack = await eda.sys_FileManager.setDocumentSource(appendRecords(freshSource, pending))
				await assertTarget(t)
				const afterSource = await eda.sys_FileManager.getDocumentSource()
				await assertTarget(t)
				if (!afterSource) throw new Error('写入后 PCB 源码为空')
				const afterDoc = parseSourceLog(afterSource), afterPcb = extractPcbDocument(afterSource)
				if (afterDoc.uuid !== t.uuid) throw new Error(`写后 PCB 身份不符：${afterDoc.uuid}`)
				const nonMarkerAfter = meaningful({ doc: afterDoc, parsed: afterPcb })
				if (JSON.stringify(before) !== JSON.stringify(nonMarkerAfter)) throw new Error('写后发现功能区标记之外的有效记录或器件当前坐标发生变化；不保存')
				const live = resolveRecords(afterDoc)
				for (const expected of pending.filter(r => r.data !== '')) {
					const actual = live.get(`${expected.header.type}\0${expected.header.id}`)
					if (!actual || JSON.stringify(actual.data) !== JSON.stringify(expected.data)) throw new Error(`标记读回不符：${expected.header.id}`)
				}
				for (const removed of pending.filter(r => r.data === '')) {
					if (live.has(`${removed.header.type}\0${removed.header.id}`)) throw new Error(`旧功能区标记墓碑未生效：${removed.header.id}`)
				}
				if (ack === false) { /* readback remains authoritative */ }
				ctx?.stopSignal?.assertActive()
				await assertTarget(t)
				const saved = await eda.pcb_Document.save()
				if (saved !== true) throw new Error(`PCB 保存未确认：${String(saved)}`)
				return { dryRun: false, docUUID: t.uuid, regions: result.regions, written: pending.filter(r => r.data !== '').length, fontFamily: markerFont, verified: true, saved: true, signature: result.signature }
			}
			catch (error) { if (started) failPartial(error, t.uuid, touched, { regions: result.regions, signature: result.signature }); throw error }
		},
	},
	{
		name: 'pcb.locateSchematicRegion', summary: '按当前成员位号在 PCB 高亮选中并缩放到指定功能区',
		params: [{ name: 'regionId', type: 'string', required: true, description: 'pcb.getSchematicRegions 返回的 regionId' }], returns: '{ regionId, designators, selectedIds, zoomed }', example: { cmd: 'pcb.locateSchematicRegion', params: { regionId: 'pageUuid/rectId' } },
		handler: async (params, ctx) => {
			if (typeof params.regionId !== 'string' || !params.regionId) throw new Error('缺少 regionId')
			const t = await target(params), result = await readRegions(t, ctx), region = result.regions.find(r => r.regionId === params.regionId)
			if (!region) throw new Error(`当前关联原理图中没有功能区 ${params.regionId}`)
			if (region.unmatched.length || region.ambiguous.length || !region.members.length) throw new Error(`功能区成员无法唯一匹配：未匹配 ${region.unmatched.join(',') || '无'}；歧义 ${region.ambiguous.join(',') || '无'}`)
			await assertTarget(t)
			const designators = region.members.map(m => m.designator)
			const done = await eda.pcb_SelectControl.doCrossProbeSelect(designators, undefined, undefined, true, true)
			await assertTarget(t)
			if (done !== true) throw new Error('PCB 交叉探针未确认成功')
			const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId()
			await assertTarget(t)
			const memberIds = new Set(region.members.map(m => m.componentId))
			const selectedMembers = (selectedIds ?? []).filter((id: string) => memberIds.has(id))
			if (selectedMembers.length !== memberIds.size || (selectedIds ?? []).length !== memberIds.size) throw new Error(`交叉探针选择回读不精确：期望 ${memberIds.size} 个成员，实际选中 ${(selectedIds ?? []).length} 个，成员匹配 ${selectedMembers.length}`)
			await assertTarget(t)
			const zoom = await eda.dmt_EditorControl.zoomToSelectedPrimitives(t.tabId)
			await assertTarget(t)
			return { regionId: region.regionId, designators, selectedIds, zoomed: Boolean(zoom), zoom }
		},
	},
]
