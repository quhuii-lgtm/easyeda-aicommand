/** Read-only comparison of EasyEDA track width rules with DSN and SES widths. */

export type WidthStatus = 'known' | 'unknown';
export interface WidthBounds { minMil: number; preferredMil: number; maxMil: number }
export interface RoutingLayerWidth extends WidthBounds { layerId: number; name?: string; status: WidthStatus }
export interface RoutingNetWidth { net: string; ruleKey?: string; status: WidthStatus; layers: RoutingLayerWidth[] }
export interface RoutingWidthSnapshot {
	schemaVersion: 1;
	editorVersion: string;
	sourceUnit?: string;
	unitAssumption: string;
	globalStatus: WidthStatus;
	defaultRule: RoutingLayerWidth & { ruleKey?: string; layers: RoutingLayerWidth[] };
	nets: RoutingNetWidth[];
	unknowns: string[];
	routingConstraintsComplete: false;
}
export interface BuildRoutingWidthSnapshotInput { source: string; editorVersion: string; layers?: unknown[]; netRules?: unknown }
export interface WidthComparisonLayerEntry { layerId: number; name?: string; status: WidthStatus | 'matched' | 'mismatch'; eda?: WidthBounds; dsnWidthMil?: number; deviationFromPreferredMil?: number; withinEdaBounds?: boolean }
export interface WidthComparisonEntry { net?: string; status: WidthStatus | 'matched' | 'mismatch' | 'incomplete'; eda?: WidthBounds; dsnWidthMil?: number; deviationFromPreferredMil?: number; withinEdaBounds?: boolean; ruleKey?: string; layers?: WidthComparisonLayerEntry[] }
export interface DsnWidthComparison { status: 'matched' | 'mismatch' | 'incomplete'; defaultRule: WidthComparisonEntry; nets: WidthComparisonEntry[]; unknowns: string[] }
export interface SesWidthCheck { status: 'compliant' | 'violation' | 'unknown'; violations: Array<{ lineIndex: number; net: string; widthMil: number; minMil: number; maxMil: number }>; unknowns: string[] }

interface Rec { type: string; id?: string; idIsString?: boolean; ticket?: number; data: any }
interface ParsedSource { records: Rec[]; unknowns: string[] }
interface LayerInfo { id: number; name?: string }

export function resolveDsnLayerId(name: string): number | undefined {
	if (name === 'TopLayer') return 1
	if (name === 'BottomLayer') return 2
	const inner = /^Inner([1-9]\d*)$/.exec(name)
	if (inner) return 14 + Number(inner[1])
	return undefined
}

export function dsnLayerNameMatchesSdk(name: string | undefined, dsnName: string, id: number): boolean {
	if (!name) return false
	if (id === 1) return name === 'TopLayer' || name === 'Top Layer'
	if (id === 2) return name === 'BottomLayer' || name === 'Bottom Layer'
	const n = id - 14
	return n > 0 && (name === `Inner${n}` || name === `Inner ${n}` || name === `Inner Layer ${n}`) && dsnName === `Inner${n}`
}
const asNum = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function parseSource(source: string): ParsedSource {
	const records: Rec[] = [];
	const unknowns: string[] = [];
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		if (!line.trim())
			continue;
		const split = line.indexOf('||');
		if (split < 0) {
			unknowns.push(`源码第 ${index + 1} 行格式无法解析`);
			continue;
		}
		try {
			const header = JSON.parse(line.slice(0, split));
			const dataText = line.slice(split + 2).replace(/\|$/, '');
			const data = dataText ? JSON.parse(dataText) : '';
			if (typeof header.type !== 'string' || (header.id == null && header.type !== 'DOCHEAD')) {
				unknowns.push(`源码第 ${index + 1} 行缺少类型或ID`);
				continue;
			}
			records.push({ type: header.type, id: header.id == null ? undefined : String(header.id), idIsString: typeof header.id === 'string', ticket: asNum(header.ticket), data });
		}
		catch {
			unknowns.push(`源码第 ${index + 1} 行JSON无效`);
		}
	}
	return { records, unknowns };
}

function keyParts(id?: string): any[] {
	try {
		const value = JSON.parse(id ?? '');
		return Array.isArray(value) ? value : [];
	}
	catch {
		return [];
	}
}

function effectiveRecords(records: Rec[], type: string): { records: Rec[]; unknowns: string[] } {
	const byId = new Map<string, Rec[]>();
	for (const record of records.filter(item => item.type === type)) {
		const group = byId.get(record.id!) ?? [];
		group.push(record);
		byId.set(record.id!, group);
	}
	const result: Rec[] = [];
	const unknowns: string[] = [];
	for (const [id, group] of byId) {
		const maxTicket = Math.max(...group.map(record => record.ticket ?? 0));
		const latest = group.filter(record => (record.ticket ?? 0) === maxTicket);
		if (latest.length !== 1) {
			unknowns.push(`${type} ${id} 存在相同最新ticket的冲突记录`);
			continue;
		}
		if (latest[0].data === '')
			continue;
		result.push(latest[0]);
	}
	return { records: result, unknowns };
}

function getEnabledLayers(input: unknown): { layers: LayerInfo[]; unknowns: string[]; idsValid: boolean } {
	if (!Array.isArray(input))
		return { layers: [], unknowns: ['缺少SDK图层列表'], idsValid: false };
	const layers: LayerInfo[] = [];
	const unknowns: string[] = [];
	let idsValid = true;
	const seenIds = new Set<number>();
	for (const [index, layer] of input.entries()) {
		const item = layer as any;
		if (String(item?.type ?? '').toUpperCase() !== 'SIGNAL')
			continue;
		const status = item?.status ?? item?.layerStatus;
		if (status === 0)
			continue;
		if (item?.layerId !== undefined && item?.id !== undefined && item.layerId !== item.id) {
			idsValid = false;
			unknowns.push(`SDK图层第${index + 1}项id/layerId身份冲突`);
			continue;
		}
		const rawId = item?.layerId ?? item?.id;
		const id = asNum(rawId);
		if (id === undefined || !Number.isInteger(id) || (status !== 1 && status !== 2)) {
			idsValid = false;
			unknowns.push(`SDK图层第${index + 1}项不是可确认的启用SIGNAL图层`);
			continue;
		}
		if (seenIds.has(id)) {
			idsValid = false;
			unknowns.push(`SDK启用SIGNAL图层ID ${id} 重复`);
			continue;
		}
		seenIds.add(id);
		layers.push({ id, name: typeof item.layerName === 'string' ? item.layerName : typeof item.name === 'string' ? item.name : undefined });
	}
	if (!layers.length)
		unknowns.push('没有可确认的启用SIGNAL图层');
	return { layers, unknowns, idsValid };
}

function boundsFor(rule: Rec | undefined, layerId: number): RoutingLayerWidth | undefined {
	const track = rule?.data?.ruleContext?.track;
	if (!track || track.isOpen !== true || !Array.isArray(track.content))
		return undefined;
	const matching = track.content.filter((row: any) => row && row.layerId === layerId);
	if (matching.length !== 1)
		return undefined;
	const row = matching[0];
	const minMil = asNum(row.stroMin);
	const preferredMil = asNum(row.stroDef);
	const maxMil = asNum(row.stroMax);
	if (minMil === undefined || preferredMil === undefined || maxMil === undefined || minMil < 0 || minMil > preferredMil || preferredMil > maxMil)
		return undefined;
	return { layerId, minMil, preferredMil, maxMil, status: 'known' };
}

function netRuleMap(value: unknown): Map<string, string> {
	const result = new Map<string, string>();
	const wrapperData = value && typeof value === 'object' ? (value as any).data ?? (value as any).result?.data : undefined;
	const rows = Array.isArray(value) ? value : Array.isArray(wrapperData) ? wrapperData : [];
	const visit = (items: any[]): void => {
		for (const row of items) {
			if (typeof row?.name === 'string' && typeof row?.Track === 'string' && row.type === 'net')
				result.set(row.name, row.Track);
			if (Array.isArray(row?.sub))
				visit(row.sub);
		}
	};
	visit(rows);
	return result;
}

interface SdkNetRowEvidence { track: unknown; safeSpacing: unknown; className?: unknown; classTrack?: unknown }
interface SdkNetRuleEvidence { nets: Map<string, SdkNetRowEvidence[]>; classes: Map<string, Array<{ track: unknown; safeSpacing: unknown }>> }

function sdkNetRuleEvidence(value: unknown): SdkNetRuleEvidence {
	const nets = new Map<string, SdkNetRowEvidence[]>();
	const classes = new Map<string, Array<{ track: unknown; safeSpacing: unknown }>>();
	const wrapperData = value && typeof value === 'object' ? (value as any).data ?? (value as any).result?.data : undefined;
	const rows = Array.isArray(value) ? value : Array.isArray(wrapperData) ? wrapperData : [];
	const visit = (items: any[], owner?: any): void => {
		for (const row of items) {
			let nestedOwner = owner;
			if (row?.type === 'netClass') {
				if (typeof row.name === 'string')
					classes.set(row.name, [...(classes.get(row.name) ?? []), { track: row.Track, safeSpacing: row['Safe Spacing'] }]);
				nestedOwner = row;
			}
			if (row?.type === 'net' && typeof row.name === 'string')
				nets.set(row.name, [...(nets.get(row.name) ?? []), { track: row.Track, safeSpacing: row['Safe Spacing'], className: nestedOwner?.name, classTrack: nestedOwner?.Track }]);
			if (Array.isArray(row?.sub))
				visit(row.sub, nestedOwner);
		}
	};
	visit(rows);
	return { nets, classes };
}

function simpleTrackSelector(selector: Rec | undefined, scope: 'NET' | 'NET_CLASS', name: string): string | undefined {
	if (!selector || selector.idIsString !== true || !name)
		return undefined;
	const id = keyParts(selector.id);
	const target = id[1];
	if (id.length !== 2 || id[0] !== 'RULE_SELECTOR' || !Array.isArray(target) || target.length !== 2 || target[0] !== scope || target[1] !== name)
		return undefined;
	const data = selector.data;
	if (!data || typeof data !== 'object' || Array.isArray(data))
		return undefined;
	const keys = Object.keys(data).sort();
	if (keys.length !== 5 || keys.join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder' || data.parent !== null || data.ruleOrder !== 4)
		return undefined;
	const ruleKeyValue = data.ruleKeyValue;
	if (!ruleKeyValue || typeof ruleKeyValue !== 'object' || Array.isArray(ruleKeyValue) || Object.keys(ruleKeyValue).length !== 1 || typeof ruleKeyValue.TRACK !== 'string' || !ruleKeyValue.TRACK)
		return undefined;
	const isEmptyObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	return isEmptyObject(data.copperValue) && isEmptyObject(data.innerPlaneValue) ? ruleKeyValue.TRACK : undefined;
}

function isConfirmedEmptyTrackNetSelector(selector: Rec | undefined, net: string): boolean {
	if (!selector || selector.idIsString !== true || !net)
		return false;
	const id = keyParts(selector.id);
	if (id.length !== 2 || id[0] !== 'RULE_SELECTOR' || !Array.isArray(id[1]) || id[1].length !== 2 || id[1][0] !== 'NET' || id[1][1] !== net)
		return false;
	const data = selector.data;
	if (!data || typeof data !== 'object' || Array.isArray(data))
		return false;
	const keys = Object.keys(data).sort();
	if (keys.length !== 5 || keys.join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder' || data.ruleOrder !== 4 || data.parent !== null)
		return false;
	const isEmptyObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	return isEmptyObject(data.ruleKeyValue) && isEmptyObject(data.copperValue) && isEmptyObject(data.innerPlaneValue);
}

function safeSpacingRuleMatches(rule: Rec | undefined, ruleName: string): boolean {
	if (!rule || rule.idIsString !== true || rule.data?.ruleState !== 'NORMAL')
		return false;
	const id = keyParts(rule.id);
	if (id.length !== 3 || id[0] !== 'RULE' || id[1] !== 'SAFE' || id[2] !== ruleName)
		return false;
	const data = rule.data;
	if (Object.keys(data).sort().join(',') !== 'ruleContext,ruleState')
		return false;
	const context = data.ruleContext;
	if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).sort().join(',') !== 'isForAll,safeSpacing,unit'
		|| context.unit !== 'mil' || context.isForAll !== 'ALL' || !Array.isArray(context.safeSpacing) || context.safeSpacing.length !== 1)
		return false;
	const spacing = context.safeSpacing[0];
	if (!spacing || typeof spacing !== 'object' || Array.isArray(spacing) || Object.keys(spacing).sort().join(',') !== 'columnNames,content,isOpen,layerId'
		|| spacing.layerId !== 1 || spacing.isOpen !== true || !Array.isArray(spacing.columnNames) || spacing.columnNames.length !== 0
		|| !Array.isArray(spacing.content) || spacing.content.length !== 13)
		return false;
	const rowLengths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12];
	return spacing.content.every((row: unknown, index: number) => Array.isArray(row) && row.length === rowLengths[index]
		&& row.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0));
}

interface SafeTrackSelection { safeName: string; trackName: string; resolvedHistoricalTombstones: Set<Rec> }

function resolveSafeRuleHistory(records: Rec[], safeName: string): { rule?: Rec; resolvedHistoricalTombstones: Set<Rec> } {
	const matching = records.filter(record => record.type === 'RULE' && record.idIsString === true
		&& (() => { const id = keyParts(record.id); return id.length === 3 && id[0] === 'RULE' && id[1] === 'SAFE' && id[2] === safeName; })());
	const byRawId = new Map<string, Rec[]>();
	for (const record of matching)
		byRawId.set(record.id!, [...(byRawId.get(record.id!) ?? []), record]);
	if (byRawId.size !== 1)
		return { resolvedHistoricalTombstones: new Set() };
	const history = [...byRawId.values()][0];
	if (history.some(record => !Number.isSafeInteger(record.ticket) || (record.ticket ?? 0) <= 0))
		return { resolvedHistoricalTombstones: new Set() };
	const seenTickets = new Set<number>();
	for (const record of history) {
		if (seenTickets.has(record.ticket!))
			return { resolvedHistoricalTombstones: new Set() };
		seenTickets.add(record.ticket!);
	}
	const latestTicket = Math.max(...history.map(record => record.ticket!));
	const latest = history.find(record => record.ticket === latestTicket)!;
	if (latest.data === '' || !safeSpacingRuleMatches(latest, safeName))
		return { resolvedHistoricalTombstones: new Set() };
	return { rule: latest, resolvedHistoricalTombstones: new Set(history.filter(record => record.data === '' && record.ticket! < latestTicket)) };
}

function isConfirmedSafeTrackNetSelector(selector: Rec | undefined, net: string, safeRules: Rec[]): SafeTrackSelection | undefined {
	if (!selector || selector.idIsString !== true || !net)
		return undefined;
	const id = keyParts(selector.id);
	if (id.length !== 2 || id[0] !== 'RULE_SELECTOR' || !Array.isArray(id[1]) || id[1].length !== 2 || id[1][0] !== 'NET' || id[1][1] !== net)
		return undefined;
	const data = selector.data;
	if (!data || typeof data !== 'object' || Array.isArray(data)
		|| Object.keys(data).sort().join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder'
		|| data.parent !== null || data.ruleOrder !== 4)
		return undefined;
	const isEmptyObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	if (!isEmptyObject(data.copperValue) || !isEmptyObject(data.innerPlaneValue))
		return undefined;
	const keys = data.ruleKeyValue && typeof data.ruleKeyValue === 'object' && !Array.isArray(data.ruleKeyValue) ? Object.keys(data.ruleKeyValue).sort() : [];
	if (keys.join(',') !== 'SAFE,TRACK')
		return undefined;
	const safeName = data.ruleKeyValue.SAFE;
	const trackName = data.ruleKeyValue.TRACK;
	if (typeof safeName !== 'string' || !safeName || typeof trackName !== 'string' || !trackName)
		return undefined;
	const safeHistory = resolveSafeRuleHistory(safeRules, safeName);
	if (!safeHistory.rule)
		return undefined;
	return { safeName, trackName, resolvedHistoricalTombstones: safeHistory.resolvedHistoricalTombstones };
}

function isConfirmedSafeTrackClassSelector(selector: Rec | undefined, className: string, safeRules: Rec[]): SafeTrackSelection | undefined {
	if (!selector || selector.idIsString !== true || !className)
		return undefined;
	const id = keyParts(selector.id);
	if (id.length !== 2 || id[0] !== 'RULE_SELECTOR' || !Array.isArray(id[1]) || id[1].length !== 2 || id[1][0] !== 'NET_CLASS' || id[1][1] !== className)
		return undefined;
	const data = selector.data;
	if (!data || typeof data !== 'object' || Array.isArray(data)
		|| Object.keys(data).sort().join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder'
		|| data.parent !== null || data.ruleOrder !== 4)
		return undefined;
	const isEmptyObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	if (!isEmptyObject(data.copperValue) || !isEmptyObject(data.innerPlaneValue))
		return undefined;
	const ruleKeys = data.ruleKeyValue && typeof data.ruleKeyValue === 'object' && !Array.isArray(data.ruleKeyValue) ? Object.keys(data.ruleKeyValue).sort() : [];
	if (ruleKeys.join(',') !== 'SAFE,TRACK')
		return undefined;
	const safeName = data.ruleKeyValue.SAFE;
	const trackName = data.ruleKeyValue.TRACK;
	if (typeof safeName !== 'string' || !safeName || typeof trackName !== 'string' || !trackName)
		return undefined;
	const safeHistory = resolveSafeRuleHistory(safeRules, safeName);
	if (!safeHistory.rule)
		return undefined;
	return { safeName, trackName, resolvedHistoricalTombstones: safeHistory.resolvedHistoricalTombstones };
}

function isNormalSingleRowTrackRule(rule: Rec | undefined, enabledLayerIds: ReadonlySet<number>): boolean {
	if (!rule || rule.data?.ruleState !== 'NORMAL')
		return false;
	const unit = rule.data?.ruleContext?.unit;
	const content = rule.data?.ruleContext?.track?.content;
	const layerId = Array.isArray(content) && content.length === 1 ? asNum(content[0]?.layerId) : undefined;
	return (unit === 'mil' || unit === 'mm') && layerId !== undefined && Number.isInteger(layerId) && enabledLayerIds.has(layerId) && boundsFor(rule, layerId) !== undefined;
}

function normalMultiLayerTrack(rule: Rec | undefined, enabled: ReturnType<typeof getEnabledLayers>, state: 'NORMAL' | 'DEFAULT' = 'NORMAL'): RoutingLayerWidth[] | undefined {
	if (!rule || rule.data?.ruleState !== state || rule.data?.ruleContext?.unit !== 'mil')
		return undefined;
	const track = rule.data?.ruleContext?.track;
	const content = track?.content;
	if (track?.isOpen !== true || !Array.isArray(content) || content.length < 2 || !enabled.idsValid || !enabled.layers.length)
		return undefined;
	const enabledById = new Map(enabled.layers.map(layer => [layer.id, layer]));
	const rows = new Map<number, RoutingLayerWidth>();
	for (const row of content) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
		const keys = Object.keys(row).sort();
		if (keys.length !== 4 || keys.join(',') !== 'layerId,stroDef,stroMax,stroMin' || typeof row.layerId !== 'number' || !Number.isInteger(row.layerId) || rows.has(row.layerId))
			return undefined;
		const layer = enabledById.get(row.layerId);
		const minMil = asNum(row.stroMin);
		const preferredMil = asNum(row.stroDef);
		const maxMil = asNum(row.stroMax);
		if (!layer || minMil === undefined || preferredMil === undefined || maxMil === undefined || minMil < 0 || minMil > preferredMil || preferredMil > maxMil)
			return undefined;
		rows.set(row.layerId, { layerId: layer.id, name: layer.name, minMil, preferredMil, maxMil, status: 'known' });
	}
	if (rows.size !== enabled.layers.length || enabled.layers.some(layer => !rows.has(layer.id)))
		return undefined;
	return enabled.layers.map(layer => rows.get(layer.id)!);
}

function isConfirmedLengthOnlyNetSelector(selector: Rec): boolean {
	if (selector.idIsString !== true)
		return false;
	const id = keyParts(selector.id);
	const scope = id[1];
	if (id.length !== 2 || id[0] !== 'RULE_SELECTOR' || !Array.isArray(scope) || scope.length !== 2 || scope[0] !== 'NET' || typeof scope[1] !== 'string')
		return false;
	const data = selector.data;
	if (!data || typeof data !== 'object' || Array.isArray(data))
		return false;
	const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(data, key);
	if (!hasOwn('ruleOrder') || data.ruleOrder !== 4 || !hasOwn('parent') || data.parent !== null || !hasOwn('ruleKeyValue') || !hasOwn('copperValue') || !hasOwn('innerPlaneValue'))
		return false;
	const ruleKeyValue = data.ruleKeyValue;
	if (!ruleKeyValue || typeof ruleKeyValue !== 'object' || Array.isArray(ruleKeyValue))
		return false;
	const ruleKeys = Object.keys(ruleKeyValue);
	if (ruleKeys.length !== 1 || ruleKeys[0] !== 'NET_LENGTH_TOLERANCE')
		return false;
	const lengthRule = ruleKeyValue.NET_LENGTH_TOLERANCE;
	if (!Array.isArray(lengthRule) || lengthRule.length !== 2 || typeof lengthRule[0] !== 'string' || lengthRule[0].length === 0 || (lengthRule[1] !== null && typeof lengthRule[1] !== 'string'))
		return false;
	const isEmptyObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
	return isEmptyObject(data.copperValue) && isEmptyObject(data.innerPlaneValue);
}

export function buildRoutingWidthSnapshot(input: BuildRoutingWidthSnapshotInput): RoutingWidthSnapshot {
	const parsed = parseSource(input.source);
	const unknowns = [...parsed.unknowns];
	const enabled = getEnabledLayers(input.layers);
	unknowns.push(...enabled.unknowns);
	const ruleRecords = effectiveRecords(parsed.records, 'RULE');
	const selectorRecords = effectiveRecords(parsed.records, 'RULE_SELECTOR');
	const netRecords = effectiveRecords(parsed.records, 'NET');
	unknowns.push(...ruleRecords.unknowns, ...selectorRecords.unknowns, ...netRecords.unknowns);
	const allRules = ruleRecords.records;
	const trackRules = allRules.filter(record => keyParts(record.id)[1] === 'TRACK');
	const safeRules = parsed.records.filter(record => record.type === 'RULE' && keyParts(record.id)[1] === 'SAFE');
	const defaults = trackRules.filter(record => record.data?.ruleState === 'DEFAULT');
	let defaultRec: Rec | undefined;
	if (defaults.length === 1)
		defaultRec = defaults[0];
	else
		unknowns.push(defaults.length ? '存在多个DEFAULT TRACK规则' : '缺少DEFAULT TRACK规则');
	const sourceUnit = defaultRec?.data?.ruleContext?.unit;
	const supportedSourceUnit = sourceUnit === 'mil' || sourceUnit === 'mm';
	if (!supportedSourceUnit)
		unknowns.push(`未验证ruleContext.unit: ${String(sourceUnit)}`);
	const content = defaultRec?.data?.ruleContext?.track?.content;
	if (!Array.isArray(content) || content.length === 0)
		unknowns.push('TRACK规则缺少有效图层表单');
	const defaultKey = String(keyParts(defaultRec?.id)[2] ?? '') || undefined;
	const baseByLayer: RoutingLayerWidth[] = [];
	if (supportedSourceUnit && Array.isArray(content) && content.length === 1) {
		const evidenceRow = content[0];
		const evidenceBounds = boundsFor(defaultRec, evidenceRow?.layerId);
		if (!evidenceBounds)
			unknowns.push('DEFAULT TRACK规则字段无法确认');
		else {
			for (const layer of enabled.layers)
				baseByLayer.push({ ...evidenceBounds, layerId: layer.id, name: layer.name });
		}
	}
	else if (defaultRec && content && content.length > 1) {
		const layers = normalMultiLayerTrack(defaultRec, enabled, 'DEFAULT');
		if (layers) baseByLayer.push(...layers);
		else unknowns.push('DEFAULT TRACK多行表格与启用SIGNAL层集合不一致或字段无效');
	}
	const defaultStatus: WidthStatus = baseByLayer.length === enabled.layers.length && baseByLayer.length > 0 ? 'known' : 'unknown';
	const base = baseByLayer[0];
	const defaultRule: RoutingWidthSnapshot['defaultRule'] = {
		layerId: base?.layerId ?? 0,
		name: base?.name,
		minMil: base?.minMil ?? Number.NaN,
		preferredMil: base?.preferredMil ?? Number.NaN,
		maxMil: base?.maxMil ?? Number.NaN,
		status: defaultStatus,
		ruleKey: defaultKey,
		layers: baseByLayer,
	};
	const selectors = selectorRecords.records;
	const netMap = new Map(netRecords.records.map(record => [String(keyParts(record.id)[1] ?? ''), record]));
	const netRecordCounts = new Map<string, number>();
	for (const record of netRecords.records) {
		const name = String(keyParts(record.id)[1] ?? '');
		netRecordCounts.set(name, (netRecordCounts.get(name) ?? 0) + 1);
	}
	const netApiRules = netRuleMap(input.netRules);
	const sdkRuleEvidence = sdkNetRuleEvidence(input.netRules);
	const selectorByNet = new Map<string, Rec>();
	const selectorByClass = new Map<string, Rec>();
	const duplicateNetSelectors = new Set<string>();
	const duplicateClassSelectors = new Set<string>();
	let globalSelectorUnknown = false;
	const unknownNetReasons = new Map<string, string[]>();
	const hasTombstones = parsed.records.some(record => record.data === '');
	for (const tombstone of parsed.records.filter(record => record.data === '')) {
		if (tombstone.type === 'RULE' && keyParts(tombstone.id)[1] === 'TRACK') {
			globalSelectorUnknown = true;
			unknowns.push(`TRACK规则${String(keyParts(tombstone.id)[2] ?? '')}存在删除记录，范围未确认`);
		}
		if (tombstone.type === 'RULE_SELECTOR') {
			const parts = keyParts(tombstone.id)[1];
			if (Array.isArray(parts) && parts[0] === 'NET' && typeof parts[1] === 'string')
				unknownNetReasons.set(parts[1], [...(unknownNetReasons.get(parts[1]) ?? []), 'NET TRACK selector存在删除记录']);
			else {
				globalSelectorUnknown = true;
				unknowns.push('非NET规则selector存在删除记录，影响范围未确认');
			}
		}
		if (tombstone.type === 'NET') {
			globalSelectorUnknown = true;
			unknowns.push(`NET ${String(keyParts(tombstone.id)[1] ?? '')}存在删除记录`);
		}
	}
	const sourceEvidenceAmbiguousWithoutTombstones = parsed.unknowns.length > 0 || ruleRecords.unknowns.length > 0 || selectorRecords.unknowns.length > 0 || netRecords.unknowns.length > 0;
	const sourceEvidenceAmbiguous = sourceEvidenceAmbiguousWithoutTombstones || hasTombstones;
	for (const selector of selectors) {
		if (isConfirmedLengthOnlyNetSelector(selector))
			continue;
		const parts = keyParts(selector.id)[1];
		const scope = Array.isArray(parts) ? parts[0] : undefined;
		const name = Array.isArray(parts) ? String(parts[1] ?? '') : '';
		if (scope !== 'NET') {
			if (scope === 'NET_CLASS') {
				let matchedClassMember = false;
				for (const [net, record] of netMap) {
					if (record.data?.netType === name)
						matchedClassMember = true;
				}
				if (!matchedClassMember) {
					globalSelectorUnknown = true;
					unknowns.push(`NET_CLASS ${name} selector无法关联网络成员`);
				}
				if (selectorByClass.has(name))
					duplicateClassSelectors.add(name);
				else
					selectorByClass.set(name, selector);
			}
			else {
				globalSelectorUnknown = true;
				unknowns.push(`存在${String(scope ?? '未知')}范围TRACK选择器，其影响范围未确认`);
			}
			continue;
		}
		if (!name) {
			globalSelectorUnknown = true;
			unknowns.push('存在网络名为空的TRACK选择器');
			continue;
		}
		if (selectorByNet.has(name)) {
			duplicateNetSelectors.add(name);
			unknownNetReasons.set(name, [...(unknownNetReasons.get(name) ?? []), '存在重复NET TRACK选择器']);
			continue;
		}
		selectorByNet.set(name, selector);
		if (selector.data?.parent !== null || selector.data?.ruleOrder !== 4)
			unknownNetReasons.set(name, [...(unknownNetReasons.get(name) ?? []), 'NET selector的parent/ruleOrder不是已验证的null/4']);
	}
	if (globalSelectorUnknown)
		unknowns.push('复杂selector可能改变任意网络的有效TRACK规则');
	const netNames = new Set([...netMap.keys(), ...netApiRules.keys()]);
	const enabledLayerIds = new Set(enabled.layers.map(layer => layer.id));
	const nets: RoutingNetWidth[] = [];
	for (const net of netNames) {
		const netRec = netMap.get(net);
		const selector = selectorByNet.get(net);
		const selectorKey = selector?.data?.ruleKeyValue?.TRACK;
		const emptyTrackNetSelector = isConfirmedEmptyTrackNetSelector(selector, net);
		const safeTrackSelection = isConfirmedSafeTrackNetSelector(selector, net, safeRules);
		const unresolvedTombstone = parsed.records.some(record => record.data === '' && !safeTrackSelection?.resolvedHistoricalTombstones.has(record));
		const mixedSafeSourceEvidenceAmbiguous = sourceEvidenceAmbiguousWithoutTombstones || unresolvedTombstone;
		const apiKey = netApiRules.get(net);
		const issues = [...(unknownNetReasons.get(net) ?? [])];
		const safeSdkRows = sdkRuleEvidence.nets.get(net) ?? [];
		const safeSdkBindingConfirmed = safeTrackSelection !== undefined && safeSdkRows.length === 1
			&& safeSdkRows[0].track === safeTrackSelection.trackName && safeSdkRows[0].safeSpacing === safeTrackSelection.safeName;
		if (safeTrackSelection && !safeSdkBindingConfirmed)
			issues.push('NET SAFE+TRACK selector与SDK的唯一NET行不一致');
		if (safeTrackSelection && mixedSafeSourceEvidenceAmbiguous)
			issues.push('NET SAFE+TRACK 的来源仍有未消解歧义或删除记录');
		if (!netRec)
			issues.push('源码中缺少NET记录');
		if (selector && selector.data?.ruleKeyValue && Object.prototype.hasOwnProperty.call(selector.data.ruleKeyValue, 'SAFE') && !safeTrackSelection)
			issues.push('NET SAFE+TRACK selector与已验证profile不符');
		if (selector && selectorKey !== undefined && typeof selectorKey !== 'string')
			issues.push('NET selector的TRACK值不是简单规则名');
		if (selector && selectorKey !== undefined && apiKey !== undefined && selectorKey !== apiKey)
			issues.push(`NET selector与SDK规则读回冲突(${String(selectorKey)}/${apiKey})`);
		if (!selector && apiKey && apiKey !== 'default')
			issues.push(`SDK显示TRACK=${apiKey}但源码无对应NET selector`);
		const selectedKey = emptyTrackNetSelector && apiKey === 'default' ? defaultKey : typeof selectorKey === 'string' ? selectorKey : apiKey && apiKey !== 'default' ? apiKey : defaultKey;
		const chosen = selectedKey ? trackRules.filter(record => keyParts(record.id)[2] === selectedKey) : [];
		if (selectedKey && chosen.length !== 1)
			issues.push(`TRACK规则${selectedKey}缺失或重复`);
		const ruleRec = chosen.length === 1 ? chosen[0] : selectedKey === defaultKey ? defaultRec : undefined;
		const netMultiLayers = normalMultiLayerTrack(ruleRec, enabled);
		if (ruleRec && !['DEFAULT', 'NORMAL'].includes(String(ruleRec.data?.ruleState)))
			issues.push(`TRACK规则状态${String(ruleRec.data?.ruleState)}不受支持`);
		const netClassName = netRec?.data?.netType;
		let classInheritanceConfirmed = false;
		if (typeof netClassName === 'string' && netClassName) {
			const netSelectorTrack = simpleTrackSelector(selector, 'NET', net);
			const selectedNetTrack = netSelectorTrack ?? safeTrackSelection?.trackName;
			const classSelector = selectorByClass.get(netClassName);
			const classSelectorTrack = simpleTrackSelector(classSelector, 'NET_CLASS', netClassName);
			const mixedClassSelection = isConfirmedSafeTrackClassSelector(classSelector, netClassName, safeRules);
			const explicitClassTrack = classSelectorTrack ?? mixedClassSelection?.trackName;
			const sdkNets = sdkRuleEvidence.nets.get(net) ?? [];
			const sdkClasses = sdkRuleEvidence.classes.get(netClassName) ?? [];
			const classRules = explicitClassTrack ? trackRules.filter(record => keyParts(record.id)[2] === explicitClassTrack) : [];
			const defaultLayerId = asNum(defaultRec?.data?.ruleContext?.track?.content?.[0]?.layerId);
			const classRuleConfirmed = classRules.length === 1 && (isNormalSingleRowTrackRule(classRules[0], enabledLayerIds) || normalMultiLayerTrack(classRules[0], enabled, 'NORMAL') !== undefined);
			const mixedClassSdkBindingConfirmed = mixedClassSelection !== undefined && sdkClasses.length === 1
				&& sdkClasses[0].track === mixedClassSelection.trackName && sdkClasses[0].safeSpacing === mixedClassSelection.safeName;
			const defaultSingleRowConfirmed = sourceUnit === 'mil' && defaultStatus === 'known' && defaults.length === 1
				&& ruleRec === defaultRec && defaultRec?.data?.ruleState === 'DEFAULT'
				&& defaultRec?.data?.ruleContext?.unit === 'mil'
				&& defaultRec?.data?.ruleContext?.track?.isOpen === true
				&& Array.isArray(defaultRec?.data?.ruleContext?.track?.content) && defaultRec.data.ruleContext.track.content.length === 1
				&& defaultLayerId !== undefined && Number.isInteger(defaultLayerId) && enabledLayerIds.has(defaultLayerId)
				&& boundsFor(defaultRec, defaultLayerId) !== undefined;
			const defaultRuleConfirmed = defaultSingleRowConfirmed || normalMultiLayerTrack(defaultRec, enabled, 'DEFAULT') !== undefined;
			const defaultRuleSelectedForNet = emptyTrackNetSelector && selectedKey === defaultKey && apiKey === 'default'
				&& sdkNets.length === 1 && sdkClasses.length === 1
				&& sdkNets[0].track === 'default' && sdkNets[0].className === netClassName
				&& typeof sdkNets[0].classTrack === 'string' && sdkNets[0].classTrack === sdkClasses[0].track
				&& classSelectorTrack !== undefined && classRuleConfirmed
				&& sdkClasses[0].track === classSelectorTrack
				&& defaultRuleConfirmed;
			const explicitClassSourceConfirmed = mixedClassSelection ? !sourceEvidenceAmbiguous : safeTrackSelection ? !mixedSafeSourceEvidenceAmbiguous : !sourceEvidenceAmbiguous;
			const mixedNetTrackBindingConfirmed = safeTrackSelection !== undefined && safeSdkBindingConfirmed;
			const explicitClassBindingConfirmed = supportedSourceUnit && defaultStatus === 'known' && explicitClassSourceConfirmed && netRecordCounts.get(net) === 1 && !duplicateNetSelectors.has(net) && !duplicateClassSelectors.has(netClassName)
				&& selectedNetTrack !== undefined && selectedNetTrack !== defaultKey && explicitClassTrack !== undefined
				&& (!mixedClassSelection || netSelectorTrack !== undefined || mixedNetTrackBindingConfirmed)
				&& sdkNets.length === 1 && sdkClasses.length === 1
				&& sdkNets[0].className === netClassName && typeof sdkNets[0].classTrack === 'string' && sdkNets[0].classTrack === sdkClasses[0].track
				&& sdkNets[0].track === selectedNetTrack && sdkClasses[0].track === explicitClassTrack
				&& (!mixedClassSelection || mixedClassSdkBindingConfirmed)
				&& (!safeTrackSelection || safeSdkBindingConfirmed)
				&& (isNormalSingleRowTrackRule(ruleRec, enabledLayerIds) || (netMultiLayers !== undefined && selectedNetTrack !== undefined && selectedNetTrack !== defaultKey))
				&& classRuleConfirmed;
			const defaultClassBindingConfirmed = defaultRuleSelectedForNet && !sourceEvidenceAmbiguous && netRecordCounts.get(net) === 1 && !duplicateNetSelectors.has(net) && !duplicateClassSelectors.has(netClassName);
			classInheritanceConfirmed = explicitClassBindingConfirmed || defaultClassBindingConfirmed;
		}
		if (netClassName && !classInheritanceConfirmed)
			issues.push(`网络类${String(netClassName)}的TRACK继承关系未确认`);
		const selectedUnit = ruleRec?.data?.ruleContext?.unit;
		if (ruleRec && !(selectedUnit === 'mil' || selectedUnit === 'mm'))
			issues.push(`所选TRACK规则单位未验证: ${String(selectedUnit)}`);
		const selectedContent = ruleRec?.data?.ruleContext?.track?.content;
		let netLayers: RoutingLayerWidth[] = [];
		if (ruleRec === defaultRec && selectedKey === defaultKey && defaultStatus === 'known')
			netLayers = defaultRule.layers.map(layer => ({ ...layer }));
		else if (ruleRec && Array.isArray(selectedContent) && selectedContent.length === 1 && supportedSourceUnit) {
			const selectedBounds = boundsFor(ruleRec, selectedContent[0]?.layerId);
			if (selectedBounds)
				netLayers = enabled.layers.map(layer => ({ ...selectedBounds, layerId: layer.id, name: layer.name }));
		}
		if (netMultiLayers) {
			const netSelectorTrack = simpleTrackSelector(selector, 'NET', net);
			const selectedNetTrack = netSelectorTrack ?? safeTrackSelection?.trackName;
			const sdkNets = sdkRuleEvidence.nets.get(net) ?? [];
			const explicitSdkBinding = selectedNetTrack !== undefined && selectedNetTrack === selectedKey && selectedNetTrack !== defaultKey
				&& !duplicateNetSelectors.has(net) && netRecordCounts.get(net) === 1 && (safeTrackSelection ? !mixedSafeSourceEvidenceAmbiguous : !sourceEvidenceAmbiguous)
				&& sdkNets.length === 1 && sdkNets[0].track === selectedNetTrack
				&& (!safeTrackSelection || sdkNets[0].safeSpacing === safeTrackSelection.safeName)
				&& (netClassName
					? sdkNets[0].className === netClassName && typeof sdkNets[0].classTrack === 'string'
					: sdkNets[0].className === undefined && sdkNets[0].classTrack === undefined);
			if (explicitSdkBinding && (!netClassName || classInheritanceConfirmed))
				netLayers = netMultiLayers;
			else
				issues.push('多行NET TRACK规则的SDK绑定或来源唯一性无法确认');
		}
		if (!netLayers.length)
			issues.push('NET的TRACK范围字段或层配置无法确认');
		const status: WidthStatus = issues.length || globalSelectorUnknown || !netLayers.length ? 'unknown' : 'known';
		if (issues.length)
			unknowns.push(`网络 ${net}：${issues.join('；')}`);
		nets.push({ net, ruleKey: selectedKey, status, layers: netLayers.length ? netLayers : enabled.layers.map(layer => ({ layerId: layer.id, name: layer.name, minMil: Number.NaN, preferredMil: Number.NaN, maxMil: Number.NaN, status: 'unknown' })) });
	}
	const globalStatus: WidthStatus = defaultStatus === 'known' && !globalSelectorUnknown && parsed.unknowns.length === 0 && ruleRecords.unknowns.length === 0 && selectorRecords.unknowns.length === 0 ? 'known' : 'unknown';
	return {
		schemaVersion: 1,
		editorVersion: input.editorVersion,
		sourceUnit: typeof sourceUnit === 'string' ? sourceUnit : undefined,
		unitAssumption: 'TRACK stro* values are interpreted as mil with no conversion; ruleContext.unit is retained as source evidence.',
		globalStatus,
		defaultRule,
		nets,
		unknowns: [...new Set(unknowns)],
		routingConstraintsComplete: false,
	};
}

type SNode = string | SNode[];
function parseSExpr(text: string): SNode[] {
	const root: SNode[] = [];
	const stack: SNode[][] = [root];
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (/\s/.test(char)) { i++; continue; }
		if (char === ';' || (char === '#' && (i === 0 || /\s/.test(text[i - 1])))) { while (i < text.length && text[i] !== '\n') i++; continue; }
		if (char === '(') { const list: SNode[] = []; stack.at(-1)!.push(list); stack.push(list); i++; continue; }
		if (char === ')') { if (stack.length === 1) throw new Error('unmatched close'); stack.pop(); i++; continue; }
		const current = stack.at(-1)!;
		if ((char === '"' || char === '\'') && current[0] === 'string_quote' && current.length === 1) { current.push(char); i++; continue; }
		if (char === '"' || char === '\'') {
			const quote = char;
			let value = '';
			i++;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === '\\' && i + 1 < text.length) i++;
				value += text[i++];
			}
			if (text[i] !== quote) throw new Error('unclosed quote');
			i++;
			current.push(value);
			continue;
		}
		let value = '';
		while (i < text.length && !/[\s()]/.test(text[i])) value += text[i++];
		current.push(value);
	}
	if (stack.length !== 1) throw new Error('unmatched open');
	return root;
}

const children = (node: SNode, name: string): SNode[][] => Array.isArray(node) ? node.filter((item): item is SNode[] => Array.isArray(item) && item[0] === name) : [];
const scalar = (node: SNode | undefined): string | undefined => typeof node === 'string' ? node : undefined;
interface ParsedDsn { defaultWidth?: number; defaultWidthInvalid?: boolean; defaultLayerWidths: Map<number, number>; classes: Map<string, { width?: number; members: string[]; layerWidths: Map<number, number> }>; nets: Set<string>; layerNames: Map<number, string>; structureLayerMappingInvalid?: boolean; problem?: string }
function dsnMil(text: string): ParsedDsn {
	const roots = parseSExpr(text);
	const pcb = roots.find(node => Array.isArray(node) && node[0] === 'PCB') as SNode[] | undefined;
	if (!pcb || roots.filter(node => Array.isArray(node) && node[0] === 'PCB').length !== 1) return { defaultLayerWidths: new Map(), classes: new Map(), nets: new Set(), layerNames: new Map(), problem: '缺少或存在多个PCB根节点' };
	const resolutions = children(pcb, 'resolution');
	const networks = children(pcb, 'network');
	const structures = children(pcb, 'structure');
	if (resolutions.length !== 1 || networks.length !== 1 || structures.length > 1) return { defaultLayerWidths: new Map(), classes: new Map(), nets: new Set(), layerNames: new Map(), problem: 'resolution/network节点缺失或重复' };
	const unit = scalar(resolutions[0][1])?.toLowerCase();
	const factor = unit === 'mil' ? 1 : unit === 'mm' ? 1000 / 25.4 : unit === 'inch' ? 1000 : undefined;
	if (!factor) return { defaultLayerWidths: new Map(), classes: new Map(), nets: new Set(), layerNames: new Map(), problem: `不支持DSN resolution unit ${unit ?? '(missing)'}` };
	const structure = structures[0];
	const structureRules = structure ? children(structure, 'rule') : [];
	const defaultWidths = structureRules.flatMap(rule => children(rule, 'width')).map(width => Number(scalar(width[1])));
	const baseWidthRules = structureRules.filter(rule => children(rule, 'width').length > 0);
	const defaultWidthValid = baseWidthRules.length === 1 && defaultWidths.length === 1 && Number.isFinite(defaultWidths[0]) && defaultWidths[0] > 0
		&& children(baseWidthRules[0], 'width')[0]?.length === 2
		&& baseWidthRules[0].slice(1).every(field => Array.isArray(field) && ['width', 'clearance'].includes(String(field[0])))
	const defaultWidth = defaultWidthValid ? defaultWidths[0] * factor : undefined;
	const defaultWidthInvalid = baseWidthRules.length > 0 && !defaultWidthValid;
	const netNodes = children(networks[0], 'net');
	const nets = new Set(netNodes.map(net => scalar(net[1])).filter((name): name is string => Boolean(name)));
	const structureLayerRules = structure ? children(structure, 'layer_rule').length > 0 || children(structure, 'layer').some(layer => children(layer, 'layer_rule').length > 0) : false;
	if (netNodes.some(net => children(net, 'rule').length || children(net, 'layer_rule').length) || structureLayerRules)
		return { defaultWidth, defaultLayerWidths: new Map(), classes: new Map(), nets, layerNames: new Map(), problem: 'DSN存在net rule/layer_rule或structure layer_rule覆盖，其优先级未确认' };
	const classes = new Map<string, { width?: number; members: string[]; layerWidths: Map<number, number> }>();
	const defaultLayerWidths = new Map<number, number>();
	let duplicateClass = false;
	const memberOwners = new Map<string, string[]>();
	const structureLayers = structure ? children(structure, 'layer').filter(layer => children(layer, 'type').some(type => scalar(type[1])?.toLowerCase() === 'signal')) : [];
	const structureLayerIds = new Map<number, string>();
	const structureLayerNames = new Set<string>();
	let structureLayerMappingInvalid = false;
	for (const layer of structureLayers) {
		const name = scalar(layer[1]);
		const id = name ? resolveDsnLayerId(name) : undefined;
		if (!name || id === undefined || structureLayerIds.has(id) || structureLayerNames.has(name)) {
			structureLayerMappingInvalid = true;
			continue;
		}
		structureLayerIds.set(id, name);
		structureLayerNames.add(name);
	}
	for (const layer of structure ? children(structure, 'layer') : []) {
		const layerRules = children(layer, 'rule');
		if (!layerRules.length) continue;
		const layerName = scalar(layer[1]);
		const layerId = layerName ? resolveDsnLayerId(layerName) : undefined;
		const isSignal = children(layer, 'type').some(type => scalar(type[1])?.toLowerCase() === 'signal');
		const widths = layerRules.flatMap(rule => children(rule, 'width')).map(width => Number(scalar(width[1])));
		if (!isSignal || layerRules.length !== 1 || layerId === undefined || !structureLayerIds.has(layerId)
			|| widths.length !== 1 || !Number.isFinite(widths[0]) || widths[0] <= 0
			|| layerRules[0].length !== 2 || children(layerRules[0], 'width')[0]?.length !== 2
			|| layerRules[0].slice(1).some(field => !Array.isArray(field) || String(field[0]) !== 'width'))
			return { defaultWidth, defaultLayerWidths: new Map(), classes: new Map(), nets, layerNames: structureLayerIds, problem: `DSN layer ${layerName ?? '(unknown)'} default width覆盖重复、无效或含不支持字段` };
		defaultLayerWidths.set(layerId, widths[0] * factor);
	}
	for (const classNode of children(networks[0], 'class')) {
		const className = scalar(classNode[1]);
		if (!className) continue;
		const widthValues = children(classNode, 'rule').flatMap(rule => children(rule, 'width')).map(width => Number(scalar(width[1])));
		if (widthValues.length !== 1 || !Number.isFinite(widthValues[0]) || widthValues[0] <= 0)
			return { defaultWidth, defaultLayerWidths, classes: new Map(), nets, layerNames: new Map(), problem: `DSN class ${className} 的base width缺失、重复或无效` };
		const baseRules = children(classNode, 'rule');
		if (baseRules.length !== 1 || children(baseRules[0], 'width')[0]?.length !== 2
			|| baseRules[0].slice(1).some(field => !Array.isArray(field) || !['width', 'clearance'].includes(String(field[0]))))
			return { defaultWidth, defaultLayerWidths, classes: new Map(), nets, layerNames: new Map(), problem: `DSN class ${className} base rule含额外或不支持字段` };
		const members = classNode.slice(2).filter((item): item is string => typeof item === 'string');
		if (!members.length || members.some(member => !nets.has(member)))
			return { defaultWidth, defaultLayerWidths, classes: new Map(), nets, layerNames: new Map(), problem: `DSN class ${className} 引用了未声明网络` };
		const layerWidths = new Map<number, number>();
		for (const layerRule of children(classNode, 'layer_rule')) {
			const layerName = scalar(layerRule[1]);
			const layerId = layerName ? resolveDsnLayerId(layerName) : undefined;
			const ruleNodes = children(layerRule, 'rule');
			const ruleWidths = ruleNodes.flatMap(rule => children(rule, 'width')).map(width => Number(scalar(width[1])));
			if (layerRule.length !== 3 || layerId === undefined || !structureLayerIds.has(layerId) || layerWidths.has(layerId)
				|| ruleNodes.length !== 1 || ruleWidths.length !== 1 || !Number.isFinite(ruleWidths[0]) || ruleWidths[0] <= 0
				|| children(ruleNodes[0], 'width')[0]?.length !== 2
				|| ruleNodes[0].slice(1).some(field => !Array.isArray(field) || !['width', 'clearance'].includes(String(field[0]))))
				return { defaultWidth, defaultLayerWidths, classes: new Map(), nets, layerNames: new Map(), problem: `DSN class ${className} layer_rule重复、冲突或含不支持字段` };
			layerWidths.set(layerId, ruleWidths[0] * factor);
		}
		if (layerWidths.size && !structureLayerIds.size)
			return { defaultWidth, defaultLayerWidths, classes: new Map(), nets, layerNames: new Map(), problem: `DSN class ${className} layer_rule缺少可映射structure layer` };
		const entry = { width: widthValues[0] * factor, members, layerWidths };
		if (classes.has(className)) duplicateClass = true;
		classes.set(className, entry);
		for (const member of members) {
			if (!nets.has(member)) continue;
			memberOwners.set(member, [...(memberOwners.get(member) ?? []), className]);
		}
	}
	if (duplicateClass) return { defaultWidth, defaultLayerWidths, classes, nets, layerNames: structureLayerIds, problem: 'DSN class名称重复' };
	for (const [net, owners] of memberOwners) if (owners.length !== 1) return { defaultWidth, defaultLayerWidths, classes, nets, layerNames: structureLayerIds, problem: `DSN网络${net}重复归属class` };
	return { defaultWidth, defaultWidthInvalid, defaultLayerWidths, classes, nets, layerNames: structureLayerIds, structureLayerMappingInvalid };
}

function compareEntry(rule: RoutingLayerWidth, width: number | undefined, net?: string, ruleKey?: string): WidthComparisonEntry {
	if (rule.status !== 'known' || width === undefined) return { net, status: 'unknown', ruleKey };
	const within = width >= rule.minMil && width <= rule.maxMil;
	return { net, status: Math.abs(width - rule.preferredMil) < 1e-6 ? 'matched' : 'mismatch', ruleKey, eda: { minMil: rule.minMil, preferredMil: rule.preferredMil, maxMil: rule.maxMil }, dsnWidthMil: width, deviationFromPreferredMil: width - rule.preferredMil, withinEdaBounds: within };
}

function compareLayerEntry(rule: RoutingLayerWidth, width: number | undefined, net?: string, ruleKey?: string): WidthComparisonLayerEntry {
	const comparison = compareEntry(rule, width, net, ruleKey);
	return {
		layerId: rule.layerId,
		...(rule.name ? { name: rule.name } : {}),
		status: comparison.status === 'matched' || comparison.status === 'mismatch' ? comparison.status : 'unknown',
		...(comparison.eda ? { eda: comparison.eda } : {}),
		...(comparison.dsnWidthMil !== undefined ? { dsnWidthMil: comparison.dsnWidthMil } : {}),
		...(comparison.deviationFromPreferredMil !== undefined ? { deviationFromPreferredMil: comparison.deviationFromPreferredMil } : {}),
		...(comparison.withinEdaBounds !== undefined ? { withinEdaBounds: comparison.withinEdaBounds } : {}),
	};
}

function combinedLayerStatus(layers: WidthComparisonLayerEntry[]): WidthComparisonEntry['status'] {
	return layers.some(layer => layer.status === 'mismatch') ? 'mismatch' : layers.some(layer => layer.status === 'unknown') ? 'unknown' : 'matched';
}

function sameBounds(layers: RoutingLayerWidth[]): boolean {
	return new Set(layers.map(layer => `${layer.minMil}/${layer.preferredMil}/${layer.maxMil}/${layer.status}`)).size <= 1;
}

export function compareDsnWidthRules(snapshot: RoutingWidthSnapshot, dsnText: string): DsnWidthComparison {
	const unknowns = [...snapshot.unknowns];
	let parsed: ParsedDsn;
	try { parsed = dsnMil(dsnText); }
	catch (error) { parsed = { defaultLayerWidths: new Map(), classes: new Map(), nets: new Set(), layerNames: new Map(), problem: `DSN解析失败: ${String(error)}` }; }
	if (parsed.problem) unknowns.push(parsed.problem);
	const defaultLayers = snapshot.defaultRule.layers;
	const hasDefaultLayerOverrides = parsed.defaultLayerWidths.size > 0;
	const defaultMappingValid = !hasDefaultLayerOverrides || (!parsed.structureLayerMappingInvalid
		&& parsed.layerNames.size === defaultLayers.length
		&& defaultLayers.every(layer => {
			const name = parsed.layerNames.get(layer.layerId);
			return name !== undefined && dsnLayerNameMatchesSdk(layer.name, name, layer.layerId);
		}));
	const completeDefaultLayerOverrides = !parsed.defaultWidthInvalid && parsed.defaultWidth === undefined && hasDefaultLayerOverrides && defaultMappingValid
		&& defaultLayers.every(layer => parsed.defaultLayerWidths.has(layer.layerId));
	const defaultWidthEvidenceComplete = parsed.defaultWidth !== undefined || completeDefaultLayerOverrides;
	if (parsed.defaultWidthInvalid) unknowns.push('DSN structure base width存在但格式、数值或字段无效，不能由layer覆盖替代');
	const defaultResolvedWidths = defaultLayers.map(layer => parsed.defaultLayerWidths.get(layer.layerId) ?? parsed.defaultWidth);
	const defaultRule: WidthComparisonEntry = parsed.problem || snapshot.globalStatus !== 'known' || !defaultLayers.length || !defaultWidthEvidenceComplete || !defaultMappingValid
		? { status: 'unknown', ruleKey: snapshot.defaultRule.ruleKey }
		: hasDefaultLayerOverrides
			? (() => {
				if (defaultResolvedWidths.some(width => width === undefined))
					return { status: 'unknown' as const, ruleKey: snapshot.defaultRule.ruleKey };
				const layers = defaultLayers.map((layer, index) => compareLayerEntry(layer, defaultResolvedWidths[index], undefined, snapshot.defaultRule.ruleKey));
				if (sameBounds(defaultLayers) && new Set(defaultResolvedWidths).size === 1)
					return compareEntry(defaultLayers[0], defaultResolvedWidths[0], undefined, snapshot.defaultRule.ruleKey);
				return { status: combinedLayerStatus(layers), ruleKey: snapshot.defaultRule.ruleKey, layers };
			})()
			: sameBounds(defaultLayers)
				? compareEntry(defaultLayers[0], parsed.defaultWidth, undefined, snapshot.defaultRule.ruleKey)
				: (() => {
					const layers = defaultLayers.map(layer => compareLayerEntry(layer, parsed.defaultWidth, undefined, snapshot.defaultRule.ruleKey));
					return { status: combinedLayerStatus(layers), ruleKey: snapshot.defaultRule.ruleKey, layers };
				})();
	const nets = snapshot.nets.map((netRule): WidthComparisonEntry => {
		if (parsed.problem || netRule.status !== 'known' || snapshot.globalStatus !== 'known' || !netRule.layers.length)
			return { net: netRule.net, status: 'unknown' as const, ruleKey: netRule.ruleKey };
		const classOwners = [...parsed.classes.entries()].filter(([, entry]) => entry.members.includes(netRule.net));
		if (!parsed.nets.has(netRule.net) || classOwners.length !== 1) {
			unknowns.push(`DSN网络${netRule.net}不存在或class归属不唯一`);
			return { net: netRule.net, status: 'unknown' as const, ruleKey: netRule.ruleKey };
		}
		const classRule = classOwners[0][1];
		const width = classRule.width;
		if (width === undefined) {
			unknowns.push(`DSN class ${classOwners[0][0]} 的宽度字段无法确认`);
			return { net: netRule.net, status: 'unknown' as const, ruleKey: netRule.ruleKey };
		}
		let resolvedWidths = netRule.layers.map(() => width);
		if (classRule.layerWidths.size) {
			const expectedLayerIds = new Set(netRule.layers.map(layer => layer.layerId));
			if (parsed.structureLayerMappingInvalid || parsed.layerNames.size !== expectedLayerIds.size || [...parsed.layerNames.keys()].some(id => !expectedLayerIds.has(id))) {
				unknowns.push(`DSN class ${classOwners[0][0]} 的signal层集合与network ${netRule.net} 的SDK启用层集合不一致或含重复`);
				return { net: netRule.net, status: 'unknown' as const, ruleKey: netRule.ruleKey };
			}
			const mappedLayers = netRule.layers.map(layer => {
				const dsnName = parsed.layerNames.get(layer.layerId);
				return dsnName !== undefined && dsnLayerNameMatchesSdk(layer.name, dsnName, layer.layerId);
			});
			if (mappedLayers.some(valid => !valid)) {
				unknowns.push(`DSN class ${classOwners[0][0]} 的network ${netRule.net} layer_rule无法按精确layerId/name映射`);
				return { net: netRule.net, status: 'unknown' as const, ruleKey: netRule.ruleKey };
			}
			resolvedWidths = netRule.layers.map(layer => classRule.layerWidths.get(layer.layerId) ?? width);
		}
		const layerComparisons = netRule.layers.map((layer, index) => compareLayerEntry(layer, resolvedWidths[index], netRule.net, netRule.ruleKey));
		const resolvedWidth = resolvedWidths[0];
		const layerWidthsDiffer = new Set(resolvedWidths).size > 1;
		if (sameBounds(netRule.layers) && !layerWidthsDiffer)
			return compareEntry(netRule.layers[0], resolvedWidth, netRule.net, netRule.ruleKey);
		return { net: netRule.net, status: combinedLayerStatus(layerComparisons), ruleKey: netRule.ruleKey, layers: layerComparisons };
	});
	const status = nets.some(entry => entry.status === 'mismatch') || defaultRule.status === 'mismatch' ? 'mismatch' : nets.some(entry => entry.status === 'unknown') || defaultRule.status === 'unknown' || unknowns.length ? 'incomplete' : 'matched';
	return { status, defaultRule, nets, unknowns: [...new Set(unknowns)] };
}

export function checkSesWidthRules(snapshot: RoutingWidthSnapshot, lines: Array<{ net: string; layer: number | string; widthMil: number }>): SesWidthCheck {
	const violations: SesWidthCheck['violations'] = [];
	const unknowns: string[] = [];
	for (const [index, line] of lines.entries()) {
		const netRule = snapshot.nets.find(rule => rule.net === line.net);
		const layerRule = netRule?.layers.find(layer => String(layer.layerId) === String(line.layer) || layer.name === String(line.layer));
		if (snapshot.globalStatus !== 'known' || !netRule || netRule.status !== 'known' || !layerRule || layerRule.status !== 'known' || !Number.isFinite(line.widthMil)) {
			const reasons: string[] = [];
			if (snapshot.globalStatus !== 'known') {
				const globalReasons = snapshot.unknowns.filter(reason => !reason.startsWith('网络 ') && !(reason.startsWith('NET ') && reason.endsWith('存在删除记录')));
				reasons.push(...(globalReasons.length ? globalReasons : ['全局TRACK规则状态未知']));
			}
			if (!netRule)
				reasons.push(`快照中缺少网络 ${line.net}`);
			else if (netRule.status !== 'known') {
				const prefix = `网络 ${line.net}：`;
				const netReasons = snapshot.unknowns.filter(reason => reason.startsWith(prefix)).map(reason => reason.slice(prefix.length));
				reasons.push(...(netReasons.length ? netReasons : [`网络状态为 ${netRule.status}`]));
			}
			if (!layerRule) {
				const enabledLayerRule = snapshot.defaultRule.layers.find(layer => String(layer.layerId) === String(line.layer) || layer.name === String(line.layer));
				reasons.push(enabledLayerRule
					? `网络 ${line.net} 未提供图层 ${String(line.layer)} 的有效宽度规则`
					: `SDK已确认的启用SIGNAL图层中不存在图层 ${String(line.layer)}；启用状态或图层映射未知`);
			}
			else if (layerRule.status !== 'known')
				reasons.push(`图层 ${String(line.layer)} 的有效宽度规则状态为 ${layerRule.status}`);
			if (!Number.isFinite(line.widthMil))
				reasons.push(`SES线宽 ${String(line.widthMil)} 不是有限数值`);
			unknowns.push(`SES第${index + 1}条线（网络 ${line.net}，图层 ${String(line.layer)}）：${[...new Set(reasons)].join('；')}`);
			continue;
		}
		if (line.widthMil < layerRule.minMil || line.widthMil > layerRule.maxMil)
			violations.push({ lineIndex: index, net: line.net, widthMil: line.widthMil, minMil: layerRule.minMil, maxMil: layerRule.maxMil });
	}
	return { status: violations.length ? 'violation' : unknowns.length ? 'unknown' : 'compliant', violations, unknowns };
}
