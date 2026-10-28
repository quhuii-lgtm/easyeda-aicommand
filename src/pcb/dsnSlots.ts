import type { DsnRepairResult, DsnSlotClearanceInput } from '../engine/dsnExport';
import type { ISourceRecord } from './sourcelog';
import { augmentDsnSlotClearances } from '../engine/dsnExport';
import { comparePcbSourceSnapshots } from './dsnSourceSnapshot';
import { createGeometryHost } from './geometryHost';
import { parseSourceLog, resolveRecords } from './sourcelog';

function normalizeLabel(value: unknown): string {
	return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
}

function isRecord(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type DsnNode = { kind: 'atom'; value: string } | { kind: 'list'; items: DsnNode[] };

function parseDsnRoots(source: string): DsnNode[] | undefined {
	let index = 0;
	const skip = () => {
		while (index < source.length) {
			if (/\s/u.test(source[index])) {
				index++;
				continue;
			}
			if (source[index] === ';' || (source[index] === '#' && (index === 0 || /\s/u.test(source[index - 1])))) {
				while (index < source.length && source[index] !== '\n' && source[index] !== '\r')
					index++;
				continue;
			}
			break;
		}
	};
	const parse = (): DsnNode | undefined => {
		skip();
		if (index >= source.length || source[index] === ')')
			return undefined;
		if (source[index] === '(') {
			index++;
			const items: DsnNode[] = [];
			while (true) {
				skip();
				if (index >= source.length)
					return undefined;
				if (source[index] === ')') {
					index++;
					return { kind: 'list', items };
				}
				const child = parse();
				if (!child)
					return undefined;
				items.push(child);
			}
		}
		const quoteDeclaration = source[index] === '"' && /\(\s*string_quote\s*$/u.test(source.slice(Math.max(0, index - 32), index));
		if (quoteDeclaration) {
			index++;
			return { kind: 'atom', value: '"' };
		}
		if (source[index] === '"') {
			index++;
			let value = '';
			while (index < source.length) {
				const char = source[index++];
				if (char === '"')
					return { kind: 'atom', value };
				if (char === '\\') {
					if (index >= source.length)
						return undefined;
					value += source[index++];
				}
				else {
					value += char;
				}
			}
			return undefined;
		}
		const start = index;
		while (index < source.length && !/[\s();]/u.test(source[index])) index++;
		return index > start ? { kind: 'atom', value: source.slice(start, index) } : undefined;
	};
	const roots: DsnNode[] = [];
	while (true) {
		skip();
		if (index >= source.length)
			return roots;
		if (source[index] === ')')
			return undefined;
		const root = parse();
		if (!root)
			return undefined;
		roots.push(root);
	}
}

function dsnNetworkNames(source: string): string[] | undefined {
	const roots = parseDsnRoots(source);
	if (!roots)
		return undefined;
	const pcbRoots = roots.filter((node): node is Extract<DsnNode, { kind: 'list' }> => node.kind === 'list' && node.items[0]?.kind === 'atom' && node.items[0].value.toLowerCase() === 'pcb');
	if (pcbRoots.length !== 1)
		return undefined;
	const networks = pcbRoots[0].items.filter((node): node is Extract<DsnNode, { kind: 'list' }> => node.kind === 'list' && node.items[0]?.kind === 'atom' && node.items[0].value.toLowerCase() === 'network');
	if (networks.length !== 1)
		return undefined;
	const names: string[] = [];
	for (const entry of networks[0].items.slice(1)) {
		if (entry.kind !== 'list' || entry.items[0]?.kind !== 'atom' || entry.items[0].value.toLowerCase() !== 'net')
			continue;
		const name = entry.items[1];
		if (name?.kind !== 'atom' || !name.value.trim() || names.includes(name.value))
			return undefined;
		names.push(name.value);
	}
	return names.length ? names : undefined;
}

function hasVerifiedDefaultNetSpacing(netRules: unknown, targetNames: string[]): boolean {
	if (!Array.isArray(netRules) || !targetNames.length)
		return false;
	const allowedKeys = new Set(['type', 'name', 'Safe Spacing', 'Copper Safe Spacing', 'Plane Safe Spacing', 'Track', 'Net Length Range', 'Net Length Tolerance', 'Blind/Buried Via', 'Via Size', 'Plane Zone', 'Copper Zone', 'Solder Mask Expansion', 'Paste Mask Expansion', 'Creepage Distance', 'targetNet']);
	const classRows = netRules.filter((entry): entry is Record<string, any> => isRecord(entry) && entry.type === 'netClass');
	if (!classRows.length) {
		for (const entry of netRules) {
			if (!isRecord(entry) || entry.type !== 'net' || typeof entry.name !== 'string' || !entry.name.trim()
				|| !Object.hasOwn(entry, 'Safe Spacing') || !Object.hasOwn(entry, 'targetNet') || entry.targetNet !== null
				|| Object.keys(entry).some(key => !allowedKeys.has(key))) return false;
		}
		return targetNames.every(name => {
			const entries = netRules.filter(entry => isRecord(entry) && entry.name === name);
			return entries.length === 1 && entries[0]['Safe Spacing'] === 'default';
		});
	}
	const seen = new Set<string>();
	const flattened: Array<{ entry: Record<string, any>; owner?: string }> = [];
	for (const entry of netRules) {
		if (!isRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim()
			|| !Object.hasOwn(entry, 'Safe Spacing') || entry['Safe Spacing'] !== 'default'
			|| !Object.hasOwn(entry, 'targetNet') || entry.targetNet !== null) {
			return false;
		}
		if (entry.type === 'net') {
			if (Object.keys(entry).some(key => key !== 'sub' && !allowedKeys.has(key)) || Object.hasOwn(entry, 'sub'))
				return false;
			flattened.push({ entry });
		}
		else if (entry.type === 'netClass') {
			if (Object.keys(entry).some(key => key !== 'sub' && !allowedKeys.has(key)) || !Array.isArray(entry.sub))
				return false;
			for (const child of entry.sub) {
				if (!isRecord(child) || child.type !== 'net' || Object.hasOwn(child, 'sub')
					|| Object.keys(child).some(key => !allowedKeys.has(key)) || !Object.hasOwn(child, 'Safe Spacing')
					|| child['Safe Spacing'] !== 'default' || !Object.hasOwn(child, 'targetNet') || child.targetNet !== null
					|| typeof child.name !== 'string' || !child.name.trim())
					return false;
				flattened.push({ entry: child, owner: entry.name });
			}
		}
		else return false;
	}
	for (const { entry } of flattened) {
		if (seen.has(entry.name)) return false;
		seen.add(entry.name);
	}
	for (const name of targetNames) {
		if (flattened.filter(item => item.entry.name === name).length !== 1)
			return false;
	}
	return seen.size === targetNames.length && targetNames.every(name => seen.has(name));
}

function hasVerifiedDefaultNetSelectors(records: ISourceRecord[], targetNames: string[], netRules: unknown, sourceRecords: ISourceRecord[]): boolean {
	if (!targetNames.length)
		return false;
	const selectors = records.filter(record => record.header.type === 'RULE_SELECTOR');
	if (!selectors.length)
		return false;
	const sdkClassNames = Array.isArray(netRules) ? netRules.filter(isRecord).filter(row => row.type === 'netClass').map(row => row.name) : [];
	const strictClassPath = sdkClassNames.length > 0 || selectors.some(record => {
		try { const key = JSON.parse(String(record.header.id)); return Array.isArray(key?.[1]) && key[1][0] === 'NET_CLASS'; }
		catch { return false; }
	});
	const selectedNames: string[] = [];
	let hasClassSelector = false;
	let hasSafeKey = false;
	const selectorTrack = new Map<string, string | undefined>();
	for (const record of selectors) {
		if (typeof record.header.id !== 'string' || !isRecord(record.data))
			return false;
		let key: unknown;
		try {
			key = JSON.parse(record.header.id);
		}
		catch { return false; }
		if (!Array.isArray(key) || key.length !== 2 || key[0] !== 'RULE_SELECTOR' || !Array.isArray(key[1]) || key[1].length !== 2
			|| !['NET', 'NET_CLASS'].includes(key[1][0]) || typeof key[1][1] !== 'string' || !key[1][1].trim()) {
			return false;
		}
		const name = key[1][1];
		const data = record.data;
		if (data.ruleOrder !== 4 || data.parent !== null || !isRecord(data.ruleKeyValue)
			|| !isRecord(data.copperValue) || Object.keys(data.copperValue).length !== 0
			|| !isRecord(data.innerPlaneValue) || Object.keys(data.innerPlaneValue).length !== 0) {
			return false;
		}
		const selectorType = key[1][0];
		hasClassSelector ||= selectorType === 'NET_CLASS';
		const tracks = Object.entries(data.ruleKeyValue);
		if (!strictClassPath) {
			if (selectorType !== 'NET' || (Object.hasOwn(data.ruleKeyValue, 'SAFE') && data.ruleKeyValue.SAFE !== 'default')) return false;
		}
		else if (tracks.some(([field, track]) => {
			if (field === 'SAFE') { hasSafeKey = true; return true; }
			return field !== 'TRACK' || typeof track !== 'string' || !track.trim();
		}) || (selectorType === 'NET_CLASS' && (tracks.length !== 1 || tracks[0][0] !== 'TRACK')) || tracks.length > 1) return false;
		selectorTrack.set(`${selectorType}:${name}`, typeof data.ruleKeyValue.TRACK === 'string' ? data.ruleKeyValue.TRACK : undefined);
		if (Object.keys(data).some(field => !['ruleOrder', 'ruleKeyValue', 'copperValue', 'innerPlaneValue', 'parent'].includes(field)))
			return false;
		selectedNames.push(`${selectorType}:${name}`);
	}
	const classNames = sdkClassNames;
	if (!classNames.length && !hasClassSelector)
		return selectedNames.length === targetNames.length
			&& targetNames.every(name => selectedNames.filter(selected => selected === `NET:${name}`).length === 1);
	if (!strictClassPath || hasSafeKey || !classNames.length
		|| !hasClassSelector
		|| selectedNames.length !== targetNames.length + classNames.length
		|| !targetNames.every(name => selectedNames.filter(selected => selected === `NET:${name}`).length === 1)
		|| !classNames.every(name => selectedNames.filter(selected => selected === `NET_CLASS:${name}`).length === 1)
		|| selectedNames.filter(selected => selected.startsWith('NET_CLASS:')).length !== classNames.length)
		return false;
	const sourceNetRows = sourceRecords.flatMap(record => {
		if (record.header.type !== 'NET' || !isRecord(record.data)) return [];
		try {
			const key = JSON.parse(String(record.header.id));
			return Array.isArray(key) && key[0] === 'NET' && typeof key[1] === 'string' ? [[key[1], record.data.netType ?? null] as const] : [];
		}
		catch { return []; }
	});
	const sourceNets = new Map(sourceNetRows);
	if (sourceNets.size !== sourceNetRows.length) return false;
	const sdkNet = new Map<string, { owner: string | null; track: unknown }>();
	for (const row of Array.isArray(netRules) ? netRules.filter(isRecord) : []) {
		if (row.type === 'net') sdkNet.set(row.name, { owner: null, track: row.Track });
		if (row.type === 'netClass' && Array.isArray(row.sub))
			for (const child of row.sub.filter(isRecord)) sdkNet.set(child.name, { owner: row.name, track: child.Track });
	}
	for (const name of targetNames) {
		const sourceOwner = sourceNets.get(name);
		const sdk = sdkNet.get(name);
		if (!sourceNets.has(name) || !sdk || sourceOwner !== sdk.owner)
			return false;
		const sourceTrack = selectorTrack.get(`NET:${name}`);
		if (typeof sdk.track !== 'string' || !sdk.track.trim()) return false;
		const sdkTrack = sdk.track === 'default' ? undefined : sdk.track;
		if (sourceTrack !== sdkTrack)
			return false;
	}
	const targetClasses = new Set(classNames);
	for (const row of Array.isArray(netRules) ? netRules.filter(isRecord).filter(row => row.type === 'netClass') : []) {
		const sourceTrack = selectorTrack.get(`NET_CLASS:${row.name}`);
		if (typeof row.Track !== 'string' || !row.Track.trim()) return false;
		const sdkTrack = row.Track === 'default' ? undefined : row.Track;
		if (sourceTrack !== sdkTrack) return false;
	}
	if ([...sourceNets.values()].some(owner => owner !== null && (!targetClasses.has(owner) || !classNames.includes(owner))))
		return false;
	return true;
}

function hasVerifiedNetEndpoints(records: ISourceRecord[], targetNames: string[]): boolean {
	const copperLayers = new Set(records.flatMap(record => {
		if (record.header.type !== 'LAYER' || !isRecord(record.data) || record.data.use !== true
			|| !['TOP', 'BOTTOM', 'INNER', 'INNER1', 'INNER2', 'INNER3', 'INNER4', 'INNER5', 'INNER6'].includes(String(record.data.layerType).toUpperCase()))
			return [];
		return Number.isInteger(record.data.layerId) ? [record.data.layerId as number] : [];
	}));
	const coverage = new Set<string>();
	for (const record of records) {
		if (record.header.type === 'PAD_NET' && isRecord(record.data)) {
			if (typeof record.data.padNet === 'string' && record.data.padNet.trim()) coverage.add(record.data.padNet);
			continue;
		}
		if (record.header.type !== 'PAD' || !isRecord(record.data)
			|| typeof record.header.id !== 'string' || !record.header.id.trim()
			|| typeof record.data.netName !== 'string' || !record.data.netName.trim()
			|| record.data.padType !== 'NORMAL' || !copperLayers.has(record.data.layerId)
			|| !isRecord(record.data.defaultPad) || !['OVAL', 'RECT'].includes(String(record.data.defaultPad.padType).toUpperCase())
			|| typeof record.data.defaultPad.width !== 'number' || !Number.isFinite(record.data.defaultPad.width) || record.data.defaultPad.width <= 0
			|| typeof record.data.defaultPad.height !== 'number' || !Number.isFinite(record.data.defaultPad.height) || record.data.defaultPad.height <= 0
			|| ['parent', 'parentId', 'component', 'componentId', 'componentID'].some(field => Object.hasOwn(record.data as object, field)))
			continue;
		coverage.add(record.data.netName);
	}
	return targetNames.every(name => coverage.has(name));
}

export function slotClearanceFromRuleConfiguration(value: unknown, source: string, dsnText: string, netRules: unknown): { clearanceMil: number; provenance: string } | undefined {
	if (!isRecord(value))
		return undefined;
	const config = isRecord(value.config) ? value.config : value;
	const spacing = Object.entries(config).find(([key]) => normalizeLabel(key) === 'spacing')?.[1];
	if (!isRecord(spacing))
		return undefined;
	const safeSpacing = Object.entries(spacing).find(([key]) => normalizeLabel(key) === 'safespacing')?.[1];
	if (!isRecord(safeSpacing))
		return undefined;
	const defaults = Object.entries(safeSpacing).filter(([, candidate]) => isRecord(candidate) && candidate.isSetDefault === true);
	if (defaults.length !== 1 || normalizeLabel(defaults[0][0]) !== 'copperthickness1oz')
		return undefined;
	const [ruleName, ruleValue] = defaults[0];
	const rule = ruleValue;
	if (!isRecord(rule) || rule.isSetDefault !== true || rule.status !== 0)
		return undefined;
	const rows = Array.isArray(rule.row) ? rule.row : [];
	const columns = Array.isArray(rule.column) ? rule.column : [];
	const rowMatches = rows.flatMap((label: unknown, index: number) => normalizeLabel(label) === 'slotregion' ? [index] : []);
	const columnMatches = columns.flatMap((label: unknown, index: number) => normalizeLabel(label) === 'track' ? [index] : []);
	if (rowMatches.length !== 1 || columnMatches.length !== 1)
		return undefined;
	const rowIndex = rowMatches[0];
	const columnIndex = columnMatches[0];
	const unit = normalizeLabel(rule.unit);
	const tables = isRecord(rule.tables) ? Object.entries(rule.tables) : [];
	if (tables.length !== 1 || tables[0][0] !== '1' || !isRecord(tables[0][1]) || tables[0][1].status !== 1 || !Array.isArray(tables[0][1].content))
		return undefined;
	const table = tables[0][1] as Record<string, any>;
	const row = table.content[rowIndex];
	const raw = Array.isArray(row) ? row[columnIndex] : undefined;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0)
		return undefined;
	let clearanceMil: number;
	if (unit === 'mm')
		clearanceMil = raw / 0.0254;
	else if (unit === 'mil')
		clearanceMil = raw;
	else return undefined;
	let sourceDocument: ReturnType<typeof parseSourceLog>;
	try {
		sourceDocument = parseSourceLog(source);
	}
	catch { return undefined; }
	const sourceRecordTickets = new Set<string>();
	for (const record of sourceDocument.records.filter(item => ['RULE', 'RULE_SELECTOR', 'NET', 'PAD', 'PAD_NET', 'LAYER', 'FILL'].includes(item.header.type))) {
		const identity = `${record.header.type}\u0000${String(record.header.id)}\u0000${String(record.header.ticket)}`;
		if (sourceRecordTickets.has(identity)) return undefined;
		sourceRecordTickets.add(identity);
	}
	const effectiveRecords = [...resolveRecords(sourceDocument).values()];
	const sourceSafeRules = effectiveRecords.filter((record) => {
		if (record.header.type !== 'RULE' || !isRecord(record.data))
			return false;
		try {
			const key = JSON.parse(String(record.header.id));
			return Array.isArray(key) && key[0] === 'RULE' && key[1] === 'SAFE';
		}
		catch { return false; }
	});
	const defaultRule = sourceSafeRules.filter((record) => {
		const key = JSON.parse(String(record.header.id));
		return key[2] === ruleName;
	});
	if (defaultRule.length !== 1 || !isRecord(defaultRule[0].data) || defaultRule[0].data.ruleState !== 'DEFAULT'
		|| !isRecord(defaultRule[0].data.ruleContext) || normalizeLabel(defaultRule[0].data.ruleContext.isForAll) !== 'all') {
		return undefined;
	}
	if (sourceSafeRules.filter(record => isRecord(record.data) && record.data.ruleState === 'DEFAULT').length !== 1)
		return undefined;
	const sourceUnit = normalizeLabel(defaultRule[0].data.ruleContext.unit);
	if (sourceUnit !== 'mm' && sourceUnit !== 'mil')
		return undefined;
	if (sourceSafeRules.some((record) => {
		if (record === defaultRule[0])
			return false;
		const context = isRecord(record.data) && isRecord(record.data.ruleContext) ? record.data.ruleContext : undefined;
		return !context || normalizeLabel(context.isForAll) !== 'all';
	})) {
		return undefined;
	}
	if (!Array.isArray(netRules))
		return undefined;
	const dsnNets = dsnNetworkNames(dsnText);
	if (!dsnNets)
		return undefined;
	if (!hasVerifiedNetEndpoints(effectiveRecords, dsnNets) || !hasVerifiedDefaultNetSpacing(netRules, dsnNets)
		|| !hasVerifiedDefaultNetSelectors(effectiveRecords, dsnNets, netRules, effectiveRecords)) {
		return undefined;
	}
	return { clearanceMil, provenance: `getCurrentRuleConfiguration.config.Spacing.Safe Spacing.${ruleName}.tables.1.content[${rowIndex}][${columnIndex}] (${rows[rowIndex]}→${columns[columnIndex]}, ${unit}); effective source RULE is DEFAULT/isForAll=ALL; DSN network names match effective PAD_NET or verified independent NORMAL PAD associations, and each exact getNetRules entry selects Safe Spacing=default` };
}

function slotRectangle(record: any): DsnSlotClearanceInput | undefined {
	const data = record?.data;
	if (!isRecord(data) || data.layerId !== 12 || data.netName !== '')
		return undefined;
	const paths = data.path;
	if (!Array.isArray(paths) || paths.length !== 1 || !Array.isArray(paths[0]))
		return undefined;
	const path = paths[0];
	if (path.length !== 7 || path[0] !== 'R' || path.slice(1).some((item: unknown) => typeof item !== 'number' || !Number.isFinite(item)))
		return undefined;
	const [x, y, width, height, rotation, cornerRadius] = path.slice(1) as number[];
	if (width <= 0 || height <= 0 || rotation !== 0 || cornerRadius !== 0)
		return undefined;
	const id = record.header?.id;
	if (typeof id !== 'string' || !id)
		return undefined;
	return { id, x, y, width, height };
}

function noChange(source: DsnRepairResult, warning: string, limitation: string): DsnRepairResult {
	return { ...source, warnings: [...source.warnings, warning], limitations: [...source.limitations, limitation] };
}

/** Add conservative slot clearances only when live DRC labels, rule scope and source rectangles are all verified. */
export async function prepareDsnWithSlotClearances(sdk: any, input: DsnRepairResult, expectedUuid: string, expectedDocumentSource: string): Promise<DsnRepairResult> {
	try {
		const host = await createGeometryHost(sdk, {}, expectedUuid);
		const before = await host.read('核对槽孔补偿前 PCB 源码', () => sdk.sys_FileManager.getDocumentSource());
		if (!comparePcbSourceSnapshots(expectedDocumentSource, before).matches)
			throw new Error('槽孔读回开始前 PCB 源码已变化');
		const currentRules = await host.read('读取 SAFE 间距规则', () => sdk.pcb_Drc.getCurrentRuleConfiguration());
		const netRules = await host.read('读取网络专属规则', () => sdk.pcb_Drc.getNetRules());
		const spacing = slotClearanceFromRuleConfiguration(currentRules, before, input.text, netRules);
		if (!spacing) {
			return noChange(input, 'SAFE 规则、source DEFAULT/isForAll=ALL 或目标网络覆盖未能按已验证 profile 确认，槽孔补偿未应用', '规则单位、默认类或标签无法确认时保留原 DSN');
		}
		const document = parseSourceLog(before);
		if (document.uuid !== expectedUuid || document.docType.toUpperCase() !== 'PCB')
			throw new Error('PCB 源码身份与导出文档不符');
		const canvas = resolveRecords(document, 'CANVAS').values().next().value?.data;
		if (!isRecord(canvas) || normalizeLabel(canvas.unit) !== 'mil')
			return noChange(input, 'PCB 源码单位未验证为 mil，槽孔补偿未应用', '槽孔矩形需要明确的 mil 坐标才能写入 DSN');
		const fillRecords = [...resolveRecords(document, 'FILL').values()];
		const slots: DsnSlotClearanceInput[] = [];
		const unsupported: string[] = [];
		for (const record of fillRecords) {
			const data = record.data as any;
			if (data?.layerId !== 12 || data?.netName !== '')
				continue;
			const slot = slotRectangle(record);
			if (slot)
				slots.push(slot);
			else unsupported.push(String(record.header.id ?? '无ID'));
		}
		const after = await host.read('核对槽孔与规则读回后的 PCB 源码', () => sdk.sys_FileManager.getDocumentSource());
		if (!comparePcbSourceSnapshots(expectedDocumentSource, after).matches)
			throw new Error('槽孔规则读回期间 PCB 源码已变化');
		await host.finish();
		if (unsupported.length)
			input = { ...input, warnings: [...input.warnings, `发现 ${unsupported.length} 个形状或旋转未支持的无网络 FILL 槽孔，未补偿：${unsupported.join(', ')}`] };
		if (!slots.length)
			return { ...input, warnings: [...input.warnings, '未发现符合条件的无网络多层矩形槽孔，未添加槽孔补偿'] };
		const augmented = augmentDsnSlotClearances(input.text, slots, spacing.clearanceMil, spacing.provenance);
		return {
			...augmented,
			originalText: input.originalText,
			changed: input.changed || augmented.changed,
			changes: [...input.changes, ...augmented.changes],
			warnings: [...input.warnings, ...augmented.warnings],
			limitations: [...input.limitations, ...augmented.limitations],
			slotClearance: augmented.slotClearance,
		};
	}
	catch (error) {
		return noChange(input, `槽孔读回或规则确认失败，保留既有 DSN：${error instanceof Error ? error.message : String(error)}`, '槽孔补偿只在稳定同板快照和明确的默认 SAFE 规则下写入');
	}
}
