import { tokenizeDsn, type DsnAtom, type DsnList, type DsnNode, type DsnRepairChange, type DsnRepairResult } from './dsnExport'
import { dsnLayerNameMatchesSdk, resolveDsnLayerId, type RoutingWidthSnapshot } from './routingWidthRules'

interface DsnLayer { name: string; id: number }
interface PlannedChange { offset: number; text: string; change: DsnRepairChange }

function head(node: DsnNode | undefined): string | undefined {
	return node?.type === 'list' && node.items[0]?.type === 'atom' ? node.items[0].value.toLowerCase() : undefined
}

function atom(node: DsnNode | undefined, label: string): DsnAtom {
	if (!node || node.type !== 'atom' || !node.value)
		throw new Error(`DSN ${label} 缺失或格式不受支持`)
	return node
}

function directLists(node: DsnList, name: string): DsnList[] {
	return node.items.filter((item): item is DsnList => item.type === 'list' && head(item) === name)
}

function oneDirect(parent: DsnList, name: string, label: string): DsnList {
	const matches = directLists(parent, name)
	if (matches.length !== 1)
		throw new Error(`DSN ${label} 必须有且仅有一个 ${name} 节点（实际 ${matches.length} 个）`)
	return matches[0]
}

function isNumeric(node: DsnNode | undefined): node is DsnAtom {
	return node?.type === 'atom' && Number.isFinite(Number(node.value))
}

function parseSingleWidth(rule: DsnList, label: string): number {
	if (rule.items.length < 2)
		throw new Error(`${label} 缺少规则内容`)
	const widths = directLists(rule, 'width')
	if (widths.length !== 1 || widths[0].items.length !== 2 || !isNumeric(widths[0].items[1]))
		throw new Error(`${label} 必须且只能有一个简单width规则`)
	const value = Number(widths[0].items[1].value)
	if (!Number.isFinite(value) || value <= 0)
		throw new Error(`${label} width必须是正数`)
	for (const field of rule.items.slice(1)) {
		if (field.type !== 'list' || !['width', 'clearance'].includes(head(field) ?? ''))
			throw new Error(`${label} 含影响不明或不支持的规则字段`)
		if (head(field) === 'clearance' && (field.items.length !== 2 || !isNumeric(field.items[1]) || Number(field.items[1].value) < 0))
			throw new Error(`${label} clearance格式不受支持`)
	}
	return value
}

function parseSimpleWidthRule(rule: DsnList, label: string): number {
	const widths = directLists(rule, 'width')
	if (rule.items.length !== 2 || widths.length !== 1 || widths[0].items.length !== 2 || !isNumeric(widths[0].items[1]))
		throw new Error(`${label}必须且只能是无额外字段的简单(rule (width N))`)
	const value = Number(widths[0].items[1].value)
	if (!Number.isFinite(value) || value <= 0)
		throw new Error(`${label} width必须是正有限数值`)
	return value
}

function lineAt(source: string, offset: number): number {
	let line = 1
	for (let index = 0; index < offset; index++) if (source[index] === '\n') line++
	return line
}

function snapshotLayerMap(snapshot: RoutingWidthSnapshot): Map<number, { name?: string }> {
	const layers = snapshot.defaultRule?.layers
	if (!Array.isArray(layers) || !layers.length)
		throw new Error('线宽快照缺少可核验的SDK铜层集合')
	const result = new Map<number, { name?: string }>()
	for (const layer of layers) {
		if (layer.status !== 'known' || !Number.isInteger(layer.layerId) || layer.layerId <= 0 || !Number.isFinite(layer.preferredMil) || layer.preferredMil <= 0 || result.has(layer.layerId))
			throw new Error('线宽快照SDK铜层preferred未知、ID无效或重复')
		result.set(layer.layerId, { name: layer.name })
	}
	return result
}

/** Applies only fully evidenced class-scoped width overrides to an unchanged DSN string. */
export function applyDsnLayerWidthRules(snapshot: RoutingWidthSnapshot, source: string): DsnRepairResult {
	const unchanged = (messages: string[] = []): DsnRepairResult => ({ originalText: source, text: source, changed: false, changes: [], warnings: messages, limitations: [] })
	if (snapshot.schemaVersion !== 1 || snapshot.sourceUnit !== 'mil' || snapshot.globalStatus !== 'known')
		throw new Error('只支持schemaVersion为1、源码单位mil且globalStatus已知的线宽快照')
	const roots = tokenizeDsn(source).filter((node): node is DsnList => node.type === 'list')
	if (roots.length !== 1 || head(roots[0]) !== 'pcb')
		throw new Error('DSN必须只有一个PCB根节点')
	const pcb = roots[0]
	const structure = oneDirect(pcb, 'structure', '根节点')
	const network = oneDirect(pcb, 'network', '根节点')
	const resolutions = directLists(pcb, 'resolution')
	if (resolutions.length !== 1 || resolutions[0].items.length !== 3 || atom(resolutions[0].items[1], 'resolution unit').value.toLowerCase() !== 'mil'
		|| !isNumeric(resolutions[0].items[2]) || Number(resolutions[0].items[2].value) !== 1000)
		throw new Error('只支持唯一DSN resolution mil 1000')
	const units = directLists(pcb, 'unit')
	if (units.length > 1 || (units.length === 1 && (units[0].items.length !== 2 || atom(units[0].items[1], 'unit').value.toLowerCase() !== 'mil')))
		throw new Error('DSN unit 必须缺省或为唯一mil')
	if (directLists(structure, 'layer_rule').length || directLists(structure, 'layer').some(layer => directLists(layer, 'layer_rule').length))
		throw new Error('DSN structure或layer存在不支持的layer_rule覆盖')
	const structureRules = directLists(structure, 'rule')
	const structureWidthRules = structureRules.filter(rule => directLists(rule, 'width').length > 0)
	if (structureWidthRules.length > 1)
		throw new Error('DSN structure存在多个base width rule')
	const structureBaseWidth = structureWidthRules.length === 1 ? parseSimpleWidthRule(structureWidthRules[0], 'DSN structure base rule') : undefined
	const structureLayerNodes = directLists(structure, 'layer')
	const layerNodes = structureLayerNodes.filter(layer => directLists(layer, 'type').some(type => atom(type.items[1], 'layer type').value.toLowerCase() === 'signal'))
	if (structureLayerNodes.some(layer => directLists(layer, 'rule').length > 0 && !layerNodes.includes(layer)))
		throw new Error('非signal structure layer存在默认宽度覆盖，无法确认目标层集合')
	if (!layerNodes.length)
		throw new Error('DSN structure没有signal铜层')
	const sdkLayers = snapshotLayerMap(snapshot)
	const dsnLayers: DsnLayer[] = []
	const dsnIds = new Set<number>()
	for (const layer of layerNodes) {
		const name = atom(layer.items[1], 'signal layer name').value
		const id = resolveDsnLayerId(name)
		const sdk = id === undefined ? undefined : sdkLayers.get(id)
		if (id === undefined || !sdk || !dsnLayerNameMatchesSdk(sdk.name, name, id) || dsnIds.has(id))
			throw new Error(`DSN铜层${name}与SDK layerId=${id}的精确映射缺失、歧义或不一致`)
		dsnIds.add(id)
		dsnLayers.push({ name, id })
	}
	if (dsnIds.size !== sdkLayers.size || [...sdkLayers.keys()].some(id => !dsnIds.has(id)))
		throw new Error('DSN signal铜层集合与SDK启用铜层映射不一致')
	const defaultLayerOverrides = new Map<number, number>()
	for (const layer of layerNodes) {
		const rules = directLists(layer, 'rule')
		if (rules.length > 1)
			throw new Error(`DSN layer ${layer.items[1]?.type === 'atom' ? layer.items[1].value : '(unknown)'} 有重复rule`)
		if (rules.length === 1)
			defaultLayerOverrides.set(resolveDsnLayerId(atom(layer.items[1], 'signal layer name').value)!, parseSimpleWidthRule(rules[0], 'DSN default layer rule'))
	}
	const nets = directLists(network, 'net')
	const classes = directLists(network, 'class')
	if (!nets.length || !classes.length)
		throw new Error('DSN network必须包含已声明net和class')
	if (network.items.slice(1).some(item => item.type !== 'list' || !['net', 'class'].includes(head(item) ?? '')))
		throw new Error('DSN network含不支持的直接字段')
	const netNames = nets.map((net, index) => atom(net.items[1], `net[${index}] name`).value)
	if (new Set(netNames).size !== netNames.length)
		throw new Error('DSN存在重复net声明')
	const widthByNet = new Map(snapshot.nets.map(net => [net.net, net]))
	const classNames = new Set<string>()
	const memberOwners = new Map<string, string[]>()
	const plans: PlannedChange[] = []
	for (const layer of dsnLayers) {
		const defaultPreferred = snapshot.defaultRule.layers.find(item => item.layerId === layer.id)!.preferredMil
		const oldDefault = defaultLayerOverrides.get(layer.id)
		if (oldDefault !== undefined && oldDefault !== defaultPreferred)
			throw new Error(`DSN default ${layer.name} layer rule与已知preferred冲突`)
		if (oldDefault === undefined && (structureBaseWidth === undefined || defaultPreferred !== structureBaseWidth)) {
			const layerNode = layerNodes.find(item => atom(item.items[1], 'signal layer name').value === layer.name)!
			const offset = layerNode.end - 1
			plans.push({ offset, text: ` (rule (width ${defaultPreferred}))`, change: {
				kind: 'default-layer-width', from: structureBaseWidth === undefined ? '未提供structure base width' : `${structureBaseWidth} mil`, to: `${defaultPreferred} mil`, line: lineAt(source, offset),
				layer: layer.name,
			} })
		}
	}
	for (const classNode of classes) {
		const className = atom(classNode.items[1], 'class name').value
		if (classNames.has(className)) throw new Error(`DSN class ${className} 重复`)
		classNames.add(className)
		const fields = classNode.items.slice(2)
		const memberAtoms = fields.filter((field): field is DsnAtom => field.type === 'atom')
		if (memberAtoms.length === 0) throw new Error(`DSN class ${className} 必须包含至少一个已声明net`)
		for (const member of memberAtoms) {
			if (!netNames.includes(member.value)) throw new Error(`DSN class ${className} 引用了未声明net ${member.value}`)
		}
		if (memberAtoms.length !== 1) throw new Error(`DSN class ${className} 必须且只能包含一个已声明net`)
		const net = memberAtoms[0].value
		memberOwners.set(net, [...(memberOwners.get(net) ?? []), className])
		const fieldLists = fields.filter((field): field is DsnList => field.type === 'list')
		for (const field of fieldLists) {
			if (!['circuit', 'rule', 'layer_rule', 'clearance'].includes(head(field) ?? ''))
				throw new Error(`DSN class ${className} 有不支持字段 ${head(field) ?? '(unknown)'}`)
		}
		const baseRules = fieldLists.filter(field => head(field) === 'rule')
		if (baseRules.length !== 1) throw new Error(`DSN class ${className} 必须有且仅有一个base rule`)
		const baseWidth = parseSingleWidth(baseRules[0], `DSN class ${className} base rule`)
		const circuitFields = fieldLists.filter(field => head(field) === 'circuit')
		if (circuitFields.length > 1) throw new Error(`DSN class ${className} circuit重复`)
		if (circuitFields.some(circuit => circuit.items.slice(1).some(field => field.type !== 'list' || !['use_via', 'use_layer'].includes(head(field) ?? ''))))
			throw new Error(`DSN class ${className} circuit含不支持字段`)
		const clearanceFields = fieldLists.filter(field => head(field) === 'clearance')
		if (clearanceFields.some(clearance => clearance.items.length !== 2 || !isNumeric(clearance.items[1]) || Number(clearance.items[1].value) < 0))
			throw new Error(`DSN class ${className} clearance格式不受支持`)
		const netNodes = nets.filter(candidate => atom(candidate.items[1], 'net name').value === net)
		if (netNodes.length !== 1 || directLists(netNodes[0], 'rule').length || directLists(netNodes[0], 'layer_rule').length)
			throw new Error(`DSN net ${net} 有重复声明或宽度覆盖，无法安全添加class layer_rule`)
		const widthEntry = widthByNet.get(net)
		if (!widthEntry || widthEntry.status !== 'known') throw new Error(`网络 ${net} 的线宽快照未知`)
		const byLayer = new Map(widthEntry.layers.map(layer => [layer.layerId, layer]))
		if (byLayer.size !== dsnLayers.length || dsnLayers.some(layer => {
			const rule = byLayer.get(layer.id)
			return !rule || rule.status !== 'known' || !Number.isFinite(rule.preferredMil) || rule.preferredMil <= 0
		})) throw new Error(`网络 ${net} 存在未知或缺失的启用层preferred宽度`)
		const existingRules = fieldLists.filter(field => head(field) === 'layer_rule')
		const existingByLayer = new Map<string, DsnList[]>()
		for (const rule of existingRules) {
			if (rule.items.length !== 3) throw new Error(`DSN class ${className} layer_rule结构不受支持`)
			const layerName = atom(rule.items[1], `class ${className} layer_rule layer`).value
			existingByLayer.set(layerName, [...(existingByLayer.get(layerName) ?? []), rule])
		}
		for (const layerName of existingByLayer.keys()) {
			if (!dsnLayers.some(layer => layer.name === layerName) || existingByLayer.get(layerName)!.length !== 1)
				throw new Error(`DSN class ${className} layer_rule存在未知层或重复层 ${layerName}`)
		}
		for (const layer of dsnLayers) {
			const preferred = byLayer.get(layer.id)!.preferredMil
			const oldRules = existingByLayer.get(layer.name) ?? []
			if (preferred === baseWidth) {
				if (oldRules.length) {
					const childRules = directLists(oldRules[0], 'rule')
					if (childRules.length !== 1 || parseSingleWidth(childRules[0], `DSN class ${className}/${layer.name} layer_rule`) !== preferred)
						throw new Error(`DSN class ${className}/${layer.name} layer_rule与base width冲突或结构不受支持`)
				}
				continue
			}
			if (oldRules.length) {
				const childRules = directLists(oldRules[0], 'rule')
				if (childRules.length !== 1 || parseSingleWidth(childRules[0], `DSN class ${className}/${layer.name} layer_rule`) !== preferred)
					throw new Error(`DSN class ${className}/${layer.name} layer_rule与已知preferred冲突或含额外字段`)
				continue
			}
			const text = ` (layer_rule ${layer.name} (rule (width ${preferred})))`
			plans.push({ offset: classNode.end - 1, text, change: {
				kind: 'layer-width', from: `${baseWidth} mil`, to: `${preferred} mil`, line: lineAt(source, classNode.end - 1),
				net, className, layerId: layer.id, layerName: layer.name, fromWidthMil: baseWidth, toWidthMil: preferred,
			} })
		}
	}
	for (const net of netNames) {
		if (memberOwners.get(net)?.length !== 1)
			throw new Error(`DSN net ${net} 必须且只能属于一个简单class`)
	}
	const snapshotNetNames = snapshot.nets.map(net => net.net)
	if (new Set(snapshotNetNames).size !== snapshotNetNames.length || netNames.length !== snapshotNetNames.length || netNames.some(net => !widthByNet.has(net)))
		throw new Error('线宽快照与DSN network的net集合存在缺失或重复')
	const edits = [...plans].sort((a, b) => b.offset - a.offset)
	let text = source
	for (const edit of edits) text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset)
	return { originalText: source, text, changed: edits.length > 0, changes: plans.map(plan => plan.change), warnings: [], limitations: [] }
}
