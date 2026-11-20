import type { ICommandContext, ICommandDef } from '../engine/types';
import type { NetRuleChange, RulePathChange } from '../pcb/ruleEditing';
import { applyConfigurationChanges, applyNetRuleChanges, assertJsonValue, cloneRuleValue, stableRuleJson } from '../pcb/ruleEditing';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';

export interface PcbDesignRuleSnapshot {
	document: { documentType: number; uuid: string; tabId?: string; parentProjectUuid?: string };
	configuration: unknown;
	configurationName?: string;
	netRules: unknown[];
}

export interface PcbRuleUpdateParams {
	changes?: RulePathChange[];
	netRuleChanges?: NetRuleChange[];
	dryRun?: boolean;
	__docUuid?: string;
	__projectUuid?: string;
}

export interface PcbTrackRuleDeleteParams {
	name?: string;
	dryRun?: boolean;
	__docUuid?: string;
	__projectUuid?: string;
}

export interface PcbRuleUpdateResult {
	dryRun: boolean;
	document: PcbDesignRuleSnapshot['document'];
	configuration: { status: string; diff: unknown[]; sdkResult?: unknown; sdkError?: string; sdkWarning?: string; metadata?: Record<string, unknown>; normalizations?: unknown[]; sourceRuleChanges?: unknown[] };
	netRules: { status: string; diff: unknown[]; sdkResult?: unknown; sdkError?: string; sdkWarning?: string };
	verified: boolean;
}

interface RuleSnapshot { document: PcbDesignRuleSnapshot['document']; configuration: any; configurationName?: string; netRules: unknown[]; source: string }

const EXPANSION_SOURCE_FIELDS: Record<string, Record<string, Record<string, string>>> = {
	'Solder Mask Expansion': {
		solderMaskExpansion: {
			padToplayerExpansion: 'padTopExpan',
			padBottomlayerExpansion: 'padBotExpan',
			viaToplayerExpansion: 'viaTopExpan',
			viaBottomlayerExpansion: 'viaBotExpan',
			testPointToplayerExpansion: 'testPointTopExpan',
			testPointBottomlayerExpansion: 'testPointBotExpan',
		},
	},
	'Paste Mask Expansion': {
		pasteMaskExpansion: {
			padToplayerExpansion: 'padTopExpan',
			padBottomlayerExpansion: 'padBotExpan',
			testPointToplayerExpansion: 'testPointTopExpan',
			testPointBottomlayerExpansion: 'testPointBotExpan',
		},
	},
};

function fail(message: string, details: Record<string, unknown>): Error {
	return new Error(message, { cause: { ...details, partial: Boolean(details.partial), retryable: false } });
}

async function assertTarget(ctx: ICommandContext | undefined, target: RuleSnapshot['document']): Promise<void> {
	ctx?.stopSignal?.assertActive();
	if (ctx?.assertDocumentTarget) {
		await ctx.assertDocumentTarget();
	}
	else {
		const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (focus?.documentType !== 3 || focus.uuid !== target.uuid)
			throw new Error(`PCB 目标已变化：期望 ${target.uuid}，当前 ${focus?.uuid ?? '未知'}`);
		if (typeof focus.tabId !== 'string' || !focus.tabId.trim() || typeof focus.parentProjectUuid !== 'string' || !focus.parentProjectUuid.trim())
			throw new Error('独立执行缺少有效 PCB 标签页或所属工程身份');
		if ((target.tabId && focus.tabId !== target.tabId) || (target.parentProjectUuid && focus.parentProjectUuid !== target.parentProjectUuid))
			throw new Error(`PCB 标签页或所属工程已变化：目标 ${target.parentProjectUuid ?? '未知'}/${target.tabId ?? '未知'}，当前 ${focus.parentProjectUuid}/${focus.tabId}`);
	}
	ctx?.stopSignal?.assertActive();
}

async function readSnapshot(ctx?: ICommandContext): Promise<RuleSnapshot> {
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (document?.documentType !== 3 || typeof document.uuid !== 'string' || !document.uuid.trim())
		throw new Error('当前文档不是有效 PCB');
	const target = cloneRuleValue(document);
	await assertTarget(ctx, target);
	const configuration = await eda.pcb_Drc.getCurrentRuleConfiguration();
	await assertTarget(ctx, target);
	const netRules = await eda.pcb_Drc.getNetRules();
	await assertTarget(ctx, target);
	const configurationName = await eda.pcb_Drc.getCurrentRuleConfigurationName();
	await assertTarget(ctx, target);
	const source = await eda.sys_FileManager.getDocumentSource();
	await assertTarget(ctx, target);
	if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
		throw new Error('当前设计规则配置未返回有效对象');
	if (!Object.prototype.hasOwnProperty.call(configuration, 'config') || !configuration.config || typeof configuration.config !== 'object' || Array.isArray(configuration.config))
		throw new Error('当前设计规则 getter 未返回有效 configuration.config；拒绝执行规则覆盖写入');
	if (!Array.isArray(netRules))
		throw new Error('当前网络规则未返回数组');
	// Validate before JSON cloning: stringify would otherwise silently drop undefined fields or turn NaN into null.
	// This check has no mutation side effects and keeps unknown getter fields intact rather than normalizing them.
	assertJsonValue(configuration, '当前规则配置');
	assertJsonValue(netRules, '当前网络规则');
	if (typeof source !== 'string' || !source)
		throw new Error('无法读取当前 PCB 源码，规则写入结果不得判通过');
	const parsedSource = parseSourceLog(source);
	if (parsedSource.docType !== 'PCB' || parsedSource.uuid !== target.uuid)
		throw new Error('规则快照的 PCB 源码身份与焦点不符');
	if (configurationName !== undefined && typeof configurationName !== 'string')
		throw new Error('规则配置名称 getter 返回了非字符串值');
	if (configurationName !== undefined && (configuration as Record<string, any>).name !== configurationName)
		throw new Error('规则配置名称 getter 与配置对象名称不一致');
	return { document: target, configuration: cloneRuleValue(configuration), configurationName, netRules: cloneRuleValue(netRules), source };
}

function resolvedSource(source: string) {
	return resolveRecords(parseSourceLog(source));
}

function sourceRecordMapKey(type: string, id: unknown): string {
	return `${type}\0${String(id)}`;
}

function flattenLeaves(value: unknown, path: string[] = [], output = new Map<string, unknown>()): Map<string, unknown> {
	if (value && typeof value === 'object') {
		const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
		if (!entries.length) {
			output.set(stableRuleJson(path), value);
		}
		else {
			for (const [key, item] of entries)
				flattenLeaves(item, [...path, key], output);
		}
	}
	else {
		output.set(stableRuleJson(path), value);
	}
	return output;
}

function rawRuleDiff(before: RuleSnapshot, after: RuleSnapshot, changes: RulePathChange[], netChanges: NetRuleChange[], phase: string, sourceRuleChanges: unknown[]): string[] {
	const left = resolvedSource(before.source);
	const right = resolvedSource(after.source);
	const newTracks = phase === 'configuration' ? newTrackRowChanges(changes, before) : new Map<string, RulePathChange>();
	const requestedRuleKeys = phase === 'configuration' ? requestedRuleSourceKeys(changes) : new Set<string>();
	const newTrackGuardedFamilies = new Set(['TRACK', 'SAFE', 'OTHER', 'SOLDER', 'PASTE']);
	const allowedTrackFields = new Map<string, Map<string, { fields: Map<string, RulePathChange>; row?: RulePathChange }>>();
	for (const change of changes) {
		const leafMatch = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(change.path.join('.'));
		const rowMatch = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)$/.exec(change.path.join('.'));
		if (!leafMatch && !rowMatch)
			continue;
		const rule = (leafMatch ?? rowMatch)![1];
		const layer = (leafMatch ?? rowMatch)![2];
		const key = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule]));
		const byLayer = allowedTrackFields.get(key) ?? new Map<string, { fields: Map<string, RulePathChange>; row?: RulePathChange }>();
		const selected = byLayer.get(layer) ?? { fields: new Map<string, RulePathChange>() };
		if (leafMatch)
			selected.fields.set(leafMatch[3], change);
		else selected.row = change;
		byLayer.set(layer, selected);
		allowedTrackFields.set(key, byLayer);
	}
	const allowedKeys = new Set([...left.keys(), ...right.keys()]);
	const differences: string[] = [];
	const stripTicket = (record: any) => {
		const header = { ...record.header };
		delete header.ticket;
		return { header, data: record.data };
	};
	const deepDiff = (a: any, b: any, path: string, result: string[]) => {
		if (stableRuleJson(a) === stableRuleJson(b))
			return;
		if (a === undefined && b && typeof b === 'object') {
			for (const [key, value] of Object.entries(b))
				deepDiff(undefined, value, `${path}.${key}`, result);
			return;
		}
		if (b === undefined && a && typeof a === 'object') {
			for (const [key, value] of Object.entries(a))
				deepDiff(value, undefined, `${path}.${key}`, result);
			return;
		}
		if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
			const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
			for (const key of keys)
				deepDiff(a[key], b[key], `${path}.${key}`, result);
			return;
		}
		result.push(path);
	};
	for (const key of allowedKeys) {
		const a = left.get(key);
		const b = right.get(key);
		if (!a || !b) {
			if (phase === 'configuration' && key.startsWith('RULE\0')) {
				const newTrack = newTracks.get(key);
				if (newTrack) {
					const rule = key.startsWith('RULE\0') ? String(newTrack.path[3]) : '';
					const expectedRule = newTrack.value;
					if (a || !b || !newTrackSourceRow(b, expectedRule).valid)
						differences.push(`new TRACK record ${rule} is missing or does not match the requested full rule`);
					else sourceRuleChanges.push({ record: key, before: null, after: b.data, rawSourceFullyMapped: false, reason: '新TRACK的全部层与min/default/max源码值均已核对；目标记录其余内部字段不作映射' });
				}
				else if (newTracks.size && requestedRuleKeys.has(key)) {
					sourceRuleChanges.push({ record: key, before: a?.data ?? null, after: b?.data ?? null, rawSourceFullyMapped: false, reason: '该源码规则由本次显式配置路径选中；完整配置 getter 已核对，RULE 内部字段映射未展开' });
				}
				else if (newTracks.size && newTrackGuardedFamilies.has(ruleFamilyFromSourceKey(key) ?? '')) {
					differences.push(`non-target rule source record ${key} added or removed during new TRACK creation`);
				}
				else {
					sourceRuleChanges.push({ record: key, before: a?.data ?? null, after: b?.data ?? null, rawSourceFullyMapped: false, reason: '完整配置 getter 已核对；SDK 序列化的原始规则结构未作全字段映射' });
				}
			}
			else {
				differences.push(`record ${key} added or removed`);
			}
			continue;
		}
		if (stableRuleJson(stripTicket(a)) === stableRuleJson(stripTicket(b)))
			continue;
		if (key === 'RULE_TEMPLATE\0RULE_TEMPLATE') {
			const strippedA = stripTicket(a);
			const strippedB = stripTicket(b);
			const da = { ...strippedA.data };
			const db = { ...strippedB.data };
			delete da.name;
			delete db.name;
			if (stableRuleJson({ header: strippedA.header, data: da }) !== stableRuleJson({ header: strippedB.header, data: db }))
				differences.push(`record ${key} changed outside generated name`);
			continue;
		}
		if (phase === 'netRules' && key.startsWith('RULE_SELECTOR\0')) {
			let selector: unknown;
			try {
				selector = JSON.parse(key.slice(key.indexOf('\0') + 1));
			}
			catch {}
			const tuple = Array.isArray(selector) && selector.length === 2 && selector[0] === 'RULE_SELECTOR' && Array.isArray(selector[1]) ? selector[1] : undefined;
			const scope = tuple?.[0] === 'NET' ? 'net' : tuple?.[0] === 'NET_CLASS' ? 'netclass' : tuple?.[0] === 'EQ_LEN_GRP' ? 'equallengthgroup' : undefined;
			// The full typed getter comparison above validates selected binding fields and every other
			// row. Keep source checking scoped to the exact selected selector identity; the SDK's
			// selector serialization has several field families, so do not guess mappings here.
			if (netChanges.some(change => change.type.replace(/_/g, '').toLowerCase() === scope && change.name === tuple?.[1])) {
				const leftRecord = stripTicket(a);
				const rightRecord = stripTicket(b);
				if (stableRuleJson(leftRecord.header) !== stableRuleJson(rightRecord.header))
					differences.push(`record ${key} header changed outside ticket`);
				sourceRuleChanges.push({ record: key, before: a.data, after: b.data, rawSourceFullyMapped: false, reason: '所选网络绑定由完整 netRules getter 读回确认；RULE_SELECTOR 内部字段映射未展开' });
				continue;
			}
		}
		const perRule = allowedTrackFields.get(key);
		if (!perRule && phase === 'configuration' && key.startsWith('RULE\0')) {
			if (newTracks.size) {
				const leftRecord = stripTicket(a);
				const rightRecord = stripTicket(b);
				if (stableRuleJson(leftRecord.header) !== stableRuleJson(rightRecord.header))
					differences.push(`record ${key} header changed outside ticket`);
				if (requestedRuleKeys.has(key)) {
					sourceRuleChanges.push({ record: key, before: a.data, after: b.data, rawSourceFullyMapped: false, reason: '该源码规则由本次显式配置路径选中；完整配置 getter 已核对，RULE 内部字段映射未展开' });
					continue;
				}
				if (newTrackGuardedFamilies.has(ruleFamilyFromSourceKey(key) ?? '')) {
					differences.push(`non-target rule source record ${key} changed during new TRACK creation`);
					continue;
				}
			}
			const leftRecord = stripTicket(a);
			const rightRecord = stripTicket(b);
			if (stableRuleJson(leftRecord.header) !== stableRuleJson(rightRecord.header))
				differences.push(`record ${key} header changed outside ticket`);
			// The getter covers the complete writable configuration, but its group names do not map
			// mechanically to source-log rule families. Report SDK rule serialization without inventing
			// that mapping; every non-rule record and every getter field remains checked independently.
			sourceRuleChanges.push({ record: key, before: a.data, after: b.data, rawSourceFullyMapped: false, reason: '完整配置 getter 已核对；SDK 序列化的原始规则结构未作全字段映射' });
			continue;
		}
		if (!perRule) {
			const leftRecord = stripTicket(a);
			const rightRecord = stripTicket(b);
			if (stableRuleJson({ header: leftRecord.header, data: leftRecord.data }) !== stableRuleJson({ header: rightRecord.header, data: rightRecord.data }))
				differences.push(`record ${key} changed`);
			continue;
		}
		const aCopy = stripTicket(a);
		const bCopy = stripTicket(b);
		const rawDiffs: string[] = [];
		deepDiff(aCopy.data, bCopy.data, 'data', rawDiffs);
		for (const path of rawDiffs) {
			const match = /^data\.ruleContext\.track\.content\.(\d+)\.(layerId|stroMin|stroDef|stroMax)$/.exec(path);
			if (!match) {
				differences.push(`record ${key} changed at ${path}`);
				continue;
			}
			const [, row, field] = match;
			const rowBefore = aCopy.data?.ruleContext?.track?.content?.[Number(row)];
			const rowAfter = bCopy.data?.ruleContext?.track?.content?.[Number(row)];
			const layerId = rowAfter?.layerId ?? rowBefore?.layerId;
			const configField = ({ stroMin: 'minValue', stroDef: 'defaultValue', stroMax: 'maxValue' } as Record<string, string>)[field];
			const request = perRule.get(String(layerId));
			const leafRequest = configField ? request?.fields.get(configField) : undefined;
			const rowRequest = request?.row;
			if (field === 'layerId') {
				if (!rowRequest || rowBefore || String(rowAfter?.layerId) !== String(rowRequest.path[6]))
					differences.push(`record ${key} changed layer selector at ${path}`);
			}
			else {
				const selectedChange = leafRequest ?? (rowRequest && rowRequest.value && typeof rowRequest.value === 'object' ? { value: (rowRequest.value as Record<string, unknown>)[configField] } : undefined);
				let ruleName: string | undefined;
				try {
					const sourceId = JSON.parse(key.slice(key.indexOf('\0') + 1));
					if (Array.isArray(sourceId) && sourceId[0] === 'RULE' && sourceId[1] === 'TRACK')
						ruleName = sourceId[2];
				}
				catch {}
				const unit = ruleName ? before.configuration.config?.Physics?.Track?.[ruleName]?.unit : undefined;
				const expectedMil = selectedChange && typeof selectedChange.value === 'number' && (unit === 'mm' || unit === 'mil')
					? Math.round(selectedChange.value * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4
					: undefined;
				if (expectedMil === undefined || rowAfter?.[field] !== expectedMil || (rowRequest && rowBefore))
					differences.push(`record ${key} changed target field to an unrequested value at ${path}`);
			}
		}
	}
	return differences;
}

function milEquivalent(a: unknown, b: unknown, unit: unknown): boolean {
	if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b))
		return false;
	if (unit !== 'mm' && unit !== 'mil')
		return false;
	const scale = unit === 'mm' ? 1 / 0.0254 : 1;
	return Math.round(a * scale * 1e4) === Math.round(b * scale * 1e4);
}

function existingTrackQuantization(change: RulePathChange, snapshot: RuleSnapshot): Record<string, unknown> | undefined {
	const match = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(change.path.join('.'));
	if (!match || typeof change.value !== 'number')
		return undefined;
	const [, rule, layer, field] = match;
	const configRule = snapshot.configuration.config?.Physics?.Track?.[rule];
	const actual = configRule?.form?.data?.[layer]?.[field];
	if (Object.is(change.value, actual) || !milEquivalent(change.value, actual, configRule?.unit))
		return undefined;
	const raw = resolvedSource(snapshot.source).get(sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule])));
	const rawField = ({ minValue: 'stroMin', defaultValue: 'stroDef', maxValue: 'stroMax' } as Record<string, string>)[field];
	const rows = raw?.data?.ruleContext?.track?.content;
	if (!Array.isArray(rows))
		return undefined;
	const matched = rows.filter((row: any) => String(row.layerId) === layer);
	if (matched.length !== 1)
		return undefined;
	const normalizedMil = Math.round(change.value * (configRule.unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4;
	if (matched[0][rawField] !== normalizedMil || matched[0][rawField] !== Math.round((actual as number) * (configRule.unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4)
		return undefined;
	return { path: change.path, requested: change.value, actual, normalizedMil, sourceVerified: true };
}

function expansionSourcePath(path: string[]): { group: string; rule: string; field: string; family: 'SOLDER' | 'PASTE'; sourceField: string } | undefined {
	const match = /^config\.Expansion\.([^.]+)\.([^.]+)\.form\.([^.]+)$/.exec(path.join('.'));
	if (!match)
		return undefined;
	const [, group, rule, field] = match;
	const sourceField = EXPANSION_SOURCE_FIELDS[group]?.[rule]?.[field];
	if (!sourceField)
		return undefined;
	return { group, rule, field, family: group === 'Solder Mask Expansion' ? 'SOLDER' : 'PASTE', sourceField };
}

function expansionSourceRecord(snapshot: RuleSnapshot, mapping: ReturnType<typeof expansionSourcePath>): any {
	if (!mapping)
		return undefined;
	const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', mapping.family, mapping.rule]));
	return resolvedSource(snapshot.source).get(recordKeyValue);
}

function expansionMmMatchesRawMil(value: unknown, rawMil: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value) && typeof rawMil === 'number' && Number.isFinite(rawMil)
		&& value === rawMil * 254 / 10000;
}

function existingExpansionQuantization(change: RulePathChange, snapshot: RuleSnapshot): Record<string, unknown> | undefined {
	const mapping = expansionSourcePath(change.path);
	if (!mapping || typeof change.value !== 'number')
		return undefined;
	const rule = snapshot.configuration.config?.Expansion?.[mapping.group]?.[mapping.rule];
	const actual = rule?.form?.[mapping.field];
	const rawRecord = expansionSourceRecord(snapshot, mapping);
	const rawMil = rawRecord?.data?.ruleContext?.[mapping.sourceField];
	if (rule?.unit !== 'mm' || rawRecord?.data?.ruleContext?.unit !== 'mm' || Object.is(change.value, actual))
		return undefined;
	if (typeof rawMil !== 'number' || !Number.isFinite(rawMil) || !expansionMmMatchesRawMil(change.value, rawMil) || actual !== rawMil * 0.0254)
		return undefined;
	return { path: change.path, requested: change.value, actual, normalizedMil: rawMil, sourceVerified: true, sourcePath: `RULE ${mapping.family} ${mapping.rule}.ruleContext.${mapping.sourceField}`, sourceEvidence: '同名扩展规则字段的原始mil值与请求换算一致，且getter严格等于rawMil × 0.0254' };
}

function newTrackRowChange(changes: RulePathChange[], rule: string): RulePathChange | undefined {
	return changes.find(change => change.path.length === 4 && change.path[0] === 'config' && change.path[1] === 'Physics' && change.path[2] === 'Track' && change.path[3] === rule
		&& change.value && typeof change.value === 'object' && !Array.isArray(change.value));
}

function newTrackRowChanges(changes: RulePathChange[], before: RuleSnapshot): Map<string, RulePathChange> {
	const result = new Map<string, RulePathChange>();
	const beforeRules = before.configuration.config?.Physics?.Track ?? {};
	const beforeSource = resolvedSource(before.source);
	for (const change of changes) {
		if (change.path.length !== 4 || change.path[0] !== 'config' || change.path[1] !== 'Physics' || change.path[2] !== 'Track'
			|| typeof change.path[3] !== 'string' || !change.value || typeof change.value !== 'object' || Array.isArray(change.value)) {
			continue;
		}
		const rule = change.path[3];
		const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule]));
		if (Object.hasOwn(beforeRules, rule) || beforeSource.has(recordKeyValue))
			continue;
		result.set(recordKeyValue, change);
	}
	return result;
}

function requestedRuleSourceKeys(changes: RulePathChange[]): Set<string> {
	const output = new Set<string>();
	for (const change of changes) {
		const path = change.path;
		let family: string | undefined;
		let rule: string | undefined;
		if (path[0] === 'config' && path[1] === 'Physics' && path[2] === 'Track' && path.length >= 4) {
			family = 'TRACK';
			rule = path[3];
		}
		else if (path[0] === 'config' && path[1] === 'Spacing' && path[2] === 'Safe Spacing' && path.length >= 4) {
			family = 'SAFE';
			rule = path[3];
		}
		else if (path[0] === 'config' && path[1] === 'Spacing' && path[2] === 'Other Spacing' && path.length >= 4) {
			family = 'OTHER';
			rule = path[3];
		}
		else if (path[0] === 'config' && path[1] === 'Expansion' && path.length >= 4) {
			if (path[2] === 'Solder Mask Expansion') {
				family = 'SOLDER';
				rule = path[3];
			}
			else if (path[2] === 'Paste Mask Expansion') {
				family = 'PASTE';
				rule = path[3];
			}
		}
		if (family && rule)
			output.add(sourceRecordMapKey('RULE', JSON.stringify(['RULE', family, rule])));
	}
	return output;
}

function ruleFamilyFromSourceKey(key: string): string | undefined {
	if (!key.startsWith('RULE\0'))
		return undefined;
	try {
		const tuple = JSON.parse(key.slice(key.indexOf('\0') + 1));
		return Array.isArray(tuple) && tuple[0] === 'RULE' && typeof tuple[1] === 'string' ? tuple[1] : undefined;
	}
	catch { return undefined; }
}

function newTrackSourceRow(record: any, expectedRule: any): { valid: boolean; rows: Array<{ layerId: string; values: Record<string, number> }> } {
	const unit = expectedRule?.unit;
	const content = record?.data?.ruleContext?.track?.content;
	if ((unit !== 'mm' && unit !== 'mil') || record?.data?.ruleContext?.unit !== unit || !Array.isArray(content))
		return { valid: false, rows: [] };
	const expectedData = expectedRule?.form?.data;
	if (!expectedData || typeof expectedData !== 'object' || Array.isArray(expectedData))
		return { valid: false, rows: [] };
	const fields = { minValue: 'stroMin', defaultValue: 'stroDef', maxValue: 'stroMax' } as const;
	const expectedLayers = Object.keys(expectedData);
	if (content.length !== expectedLayers.length)
		return { valid: false, rows: [] };
	const rows: Array<{ layerId: string; values: Record<string, number> }> = [];
	for (const layerId of expectedLayers) {
		const matches = content.filter((item: any) => String(item?.layerId) === layerId);
		if (matches.length !== 1)
			return { valid: false, rows: [] };
		const sourceRow = matches[0];
		const values: Record<string, number> = {};
		for (const [field, sourceField] of Object.entries(fields)) {
			const expected = expectedData[layerId]?.[field];
			const raw = sourceRow[sourceField];
			if (typeof expected !== 'number' || !Number.isFinite(expected) || typeof raw !== 'number' || !Number.isFinite(raw))
				return { valid: false, rows: [] };
			const expectedMil = Math.round(expected * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4;
			if (raw !== expectedMil)
				return { valid: false, rows: [] };
			values[field] = raw;
		}
		rows.push({ layerId, values });
	}
	return { valid: true, rows };
}

function trackRuleReferences(snapshot: RuleSnapshot, ruleName: string): string[] {
	const references: string[] = [];
	const visitNetRules = (rows: unknown[], prefix: string): void => {
		for (const [index, item] of rows.entries()) {
			if (!item || typeof item !== 'object' || Array.isArray(item))
				continue;
			const row = item as Record<string, any>;
			const label = `${prefix}[${index}](${String(row.name ?? '?')})`;
			if (row.Track === ruleName)
				references.push(`${label}.Track`);
			if (Array.isArray(row.sub))
				visitNetRules(row.sub, `${label}.sub`);
		}
	};
	visitNetRules(snapshot.netRules, 'netRules');
	const targetKey = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', ruleName]));
	for (const [key, record] of resolvedSource(snapshot.source)) {
		if (key === targetKey || !record.data || typeof record.data !== 'object')
			continue;
		const visit = (value: unknown, path: string): void => {
			if (!value || typeof value !== 'object')
				return;
			if (Array.isArray(value)) {
				value.forEach((item, index) => visit(item, `${path}[${index}]`));
				return;
			}
			for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
				const childPath = `${path}.${field}`;
				if (field.toLowerCase() === 'track') {
					const findExact = (candidate: unknown, at: string): void => {
						if (candidate === ruleName) {
							references.push(`${key}${at}`);
						}
						else if (Array.isArray(candidate)) {
							candidate.forEach((item, index) => findExact(item, `${at}[${index}]`));
						}
						else if (candidate && typeof candidate === 'object') {
							for (const [nested, item] of Object.entries(candidate as Record<string, unknown>))
								findExact(item, `${at}.${nested}`);
						}
					};
					findExact(child, childPath);
				}
				else {
					visit(child, childPath);
				}
			}
		};
		visit(record.data, `source:${key}`);
	}
	return references;
}

function requireTrackRuleDeleteExpected(before: RuleSnapshot, after: RuleSnapshot, ruleName: string): unknown[] {
	if (after.document.uuid !== before.document.uuid || stableRuleJson(after.document) !== stableRuleJson(before.document))
		throw new Error('PCB 文档身份在规则删除后发生变化');
	const actual = cloneRuleValue(after.configuration);
	const wanted = cloneRuleValue(before.configuration);
	if (after.configurationName !== undefined && actual.name !== after.configurationName)
		throw new Error('删除后配置名称 getter 与配置对象名称不一致');
	if (actual.name !== wanted.name && (typeof after.configurationName !== 'string' || actual.name !== after.configurationName || typeof before.configurationName !== 'string' || before.configuration.name !== before.configurationName))
		throw new Error('删除后配置名称变化未由官方配置名称 getter 确认');
	delete actual.name;
	delete wanted.name;
	if (Object.hasOwn(actual.config.Physics.Track, ruleName))
		throw new Error('删除后设计规则 getter 仍包含目标 TRACK 定义');
	delete wanted.config.Physics.Track[ruleName];
	const normalizations: unknown[] = [];
	const expectedLeaves = flattenLeaves(wanted);
	const actualLeaves = flattenLeaves(actual);
	const getterPaths = new Set([...expectedLeaves.keys(), ...actualLeaves.keys()]);
	for (const pathKey of getterPaths) {
		if (expectedLeaves.has(pathKey) && actualLeaves.has(pathKey) && stableRuleJson(expectedLeaves.get(pathKey)) === stableRuleJson(actualLeaves.get(pathKey)))
			continue;
		const path = JSON.parse(pathKey) as string[];
		const accepted = allowedGetterDifference(path, expectedLeaves.get(pathKey), actualLeaves.get(pathKey), [], wanted, before, after);
		if (!accepted)
			throw new Error(`删除后设计规则 getter 与仅移除目标 TRACK 定义的预期不符：${path.join('.')}`);
		normalizations.push(accepted);
	}
	if (stableRuleJson(after.netRules) !== stableRuleJson(before.netRules))
		throw new Error('删除后网络绑定发生变化');
	const beforeRecords = resolvedSource(before.source);
	const afterRecords = resolvedSource(after.source);
	const targetKey = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', ruleName]));
	if (afterRecords.has(targetKey))
		throw new Error('删除后目标 TRACK 源码记录仍存在');
	for (const [key, record] of beforeRecords) {
		if (key === targetKey)
			continue;
		const readback = afterRecords.get(key);
		if (!readback || stableRuleJson({ header: stripSourceTicket(record.header), data: record.data }) !== stableRuleJson({ header: stripSourceTicket(readback.header), data: readback.data }))
			throw new Error(`删除后非目标源码记录变化或缺失：${key}`);
	}
	for (const key of afterRecords.keys()) {
		if (!beforeRecords.has(key) && key !== targetKey)
			throw new Error(`删除后新增非目标源码记录：${key}`);
	}
	return normalizations;
}

function stripSourceTicket(header: Record<string, unknown>): Record<string, unknown> {
	const copy = { ...header };
	delete copy.ticket;
	return copy;
}

async function deleteTrackRule(params: PcbTrackRuleDeleteParams, ctx?: ICommandContext): Promise<Record<string, unknown>> {
	if (typeof params.name !== 'string' || !params.name.trim())
		throw new Error('name 必须是非空 TRACK 规则名');
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
		throw new Error('dryRun 必须是 boolean');
	if (params.__docUuid !== undefined && (typeof params.__docUuid !== 'string' || !params.__docUuid.trim()))
		throw new Error('__docUuid 必须是非空字符串');
	if (params.__projectUuid !== undefined && (typeof params.__projectUuid !== 'string' || !params.__projectUuid.trim()))
		throw new Error('__projectUuid 必须是非空字符串');
	const name = params.name.trim();
	const dryRun = params.dryRun !== false;
	const snapshot = await readSnapshot(ctx);
	if (params.__docUuid && params.__docUuid !== snapshot.document.uuid)
		throw new Error(`请求目标 PCB UUID 不符：${params.__docUuid}`);
	if (params.__projectUuid && params.__projectUuid !== snapshot.document.parentProjectUuid)
		throw new Error(`请求目标工程 UUID 不符：${params.__projectUuid}`);
	const rules = snapshot.configuration.config?.Physics?.Track;
	if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !Object.hasOwn(rules, name))
		throw new Error(`当前 PCB 不存在 TRACK 规则：${name}`);
	const rule = rules[name];
	if (!rule || typeof rule !== 'object' || rule.isSetDefault !== false)
		throw new Error(`只允许删除明确标记为非默认的 TRACK 规则：${name}`);
	const targetKey = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', name]));
	const sourceRecord = resolvedSource(snapshot.source).get(targetKey);
	if (!sourceRecord || !newTrackSourceRow(sourceRecord, rule).valid)
		throw new Error(`TRACK 规则 ${name} 缺少唯一且与 getter 完整匹配的源码记录；拒绝删除`);
	const references = trackRuleReferences(snapshot, name);
	if (references.length)
		throw new Error(`TRACK 规则 ${name} 仍被引用，拒绝删除：${references.slice(0, 12).join('; ')}`);
	const expectedConfiguration = cloneRuleValue(snapshot.configuration);
	delete expectedConfiguration.config.Physics.Track[name];
	if (dryRun) {
		return {
			dryRun: true,
			status: 'planned',
			document: snapshot.document,
			name,
			deletedDefinition: { path: ['config', 'Physics', 'Track', name], isSetDefault: false },
			references: [],
			verified: false,
		};
	}

	try {
		const latest = await readSnapshot(ctx);
		requirePreWriteSnapshot(latest, snapshot.configuration, snapshot.configurationName, snapshot.netRules, snapshot);
		await assertTarget(ctx, snapshot.document);
	}
	catch (error) {
		throw fail(`写入前快照未通过；未删除TRACK规则：${String((error as any)?.message ?? error)}`, { partial: false, outcome: 'not_started', phase: 'configuration', writeAttempted: false });
	}
	let sdkResult: unknown;
	let sdkError: string | undefined;
	try {
		sdkResult = await eda.pcb_Drc.overwriteCurrentRuleConfiguration(expectedConfiguration.config);
	}
	catch (error) { sdkError = String((error as any)?.message ?? error); }
	let normalizations: unknown[] = [];
	try {
		const after = await readSnapshot(ctx);
		normalizations = requireTrackRuleDeleteExpected(snapshot, after, name);
	}
	catch (error) {
		throw fail(`TRACK规则删除写入已发出，但无法确认删除结果：${String((error as any)?.message ?? error)}`, {
			partial: true,
			outcome: 'unknown',
			phase: 'configuration',
			writeAttempted: true,
			sdkResult,
			sdkError,
		});
	}
	return { dryRun: false, status: 'deleted', document: snapshot.document, name, references: [], normalizations, sdkResult, sdkWarning: sdkError ?? (sdkResult === false ? 'SDK 返回 false，但完整 getter、绑定和非目标源码读回均确认删除' : undefined), verified: true, saved: false };
}

function newTrackLeafNormalization(path: string[], expectedValue: unknown, actual: unknown, changes: RulePathChange[], expectedConfiguration: any, before: RuleSnapshot, after: RuleSnapshot): Record<string, unknown> | undefined {
	const match = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(path.join('.'));
	if (!match)
		return undefined;
	const [, rule, layer, field] = match;
	const change = newTrackRowChange(changes, rule);
	if (!change || !Object.hasOwn(change.value as object, 'form'))
		return undefined;
	const expectedRule = expectedConfiguration.config?.Physics?.Track?.[rule];
	if (!expectedRule || stableRuleJson(change.value) !== stableRuleJson(expectedRule)
		|| Object.hasOwn(before.configuration.config?.Physics?.Track ?? {}, rule)) {
		return undefined;
	}
	const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule]));
	const beforeRecords = resolvedSource(before.source);
	const afterRecords = resolvedSource(after.source);
	if (beforeRecords.has(recordKeyValue))
		return undefined;
	const afterRecord = afterRecords.get(recordKeyValue);
	if (!afterRecord)
		return undefined;
	const mapped = newTrackSourceRow(afterRecord, expectedRule);
	if (!mapped.valid || !milEquivalent(expectedValue, actual, expectedRule.unit))
		return undefined;
	const row = mapped.rows.find(item => item.layerId === layer);
	const rawField = ({ minValue: 'stroMin', defaultValue: 'stroDef', maxValue: 'stroMax' } as Record<string, string>)[field];
	const rawValue = (afterRecord.data as any)?.ruleContext?.track?.content?.find((item: any) => String(item?.layerId) === layer)?.[rawField];
	if (!row || typeof rawValue !== 'number' || row.values[field] !== rawValue)
		return undefined;
	return { path, requested: expectedValue, actual, normalizedMil: rawValue, sourceVerified: true, sourcePath: `RULE TRACK ${rule}.track.content[layerId=${layer}].${rawField}`, sourceEvidence: '仅限写前getter和有效TRACK源码均不存在的新规则；新记录所有层与三项数值字段均已匹配' };
}

function expandExistingTrackRows(changes: RulePathChange[], configuration: unknown): RulePathChange[] {
	const output: RulePathChange[] = [];
	for (const change of changes) {
		const match = /^config\.Physics\.Track\.[^.]+\.form\.data\.[^.]+$/.exec(change.path.join('.'));
		if (!match || !change.value || typeof change.value !== 'object' || Array.isArray(change.value)) {
			output.push(change);
			continue;
		}
		let current: any = configuration;
		for (const key of change.path) {
			if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) {
				current = undefined;
				break;
			}
			current = current[key];
		}
		if (!current || typeof current !== 'object' || Array.isArray(current)) {
			output.push(change);
			continue;
		}
		for (const [field, value] of Object.entries(change.value))
			output.push({ path: [...change.path, field], value: value as RulePathChange['value'] });
	}
	return output;
}

function allowedGetterDifference(path: string[], expectedValue: unknown, actual: unknown, changes: RulePathChange[], expectedConfiguration: any, before: RuleSnapshot, after: RuleSnapshot): Record<string, unknown> | undefined {
	const key = stableRuleJson(path);
	let requested = changes.find(change => stableRuleJson(change.path) === key);
	if (!requested) {
		const row = changes.find(change => change.path.length + 1 === path.length && change.path.every((part, index) => part === path[index])
			&& change.value && typeof change.value === 'object' && !Array.isArray(change.value)
			&& Object.prototype.hasOwnProperty.call(change.value, path[path.length - 1]));
		if (row)
			requested = { path, value: (row.value as Record<string, RulePathChange['value']>)[path[path.length - 1]] };
	}
	const track = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(path.join('.'));
	if (track && !requested) {
		const addedRule = newTrackLeafNormalization(path, expectedValue, actual, changes, expectedConfiguration, before, after);
		if (addedRule)
			return addedRule;
	}
	if (track && requested) {
		const [, rule, layer, field] = track;
		const unit = expectedConfiguration.config?.Physics?.Track?.[rule]?.unit;
		const beforeRows = resolvedSource(before.source);
		const afterRows = resolvedSource(after.source);
		const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule]));
		const beforeRecord = beforeRows.get(recordKeyValue);
		const afterRecord = afterRows.get(recordKeyValue);
		if (!beforeRecord || !afterRecord || !milEquivalent(requested.value, actual, unit))
			return undefined;
		const rawField = ({ minValue: 'stroMin', defaultValue: 'stroDef', maxValue: 'stroMax' } as Record<string, string>)[field];
		const rows = afterRecord.data?.ruleContext?.track?.content;
		if (!Array.isArray(rows))
			return undefined;
		const matches = rows.filter((row: any) => String(row.layerId) === layer);
		if (matches.length !== 1 || matches[0][rawField] !== Math.round((requested.value as number) * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4)
			return undefined;
		const beforeRow = beforeRecord.data?.ruleContext?.track?.content?.find((row: any) => String(row.layerId) === layer);
		const originalValue = beforeRow?.[rawField];
		if (originalValue === matches[0][rawField])
			return undefined;
		return { path, requested: requested.value, actual, normalizedMil: matches[0][rawField], sourceVerified: true };
	}
	const expansion = expansionSourcePath(path);
	if (expansion && requested) {
		const unit = expectedConfiguration.config?.Expansion?.[expansion.group]?.[expansion.rule]?.unit;
		const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', expansion.family, expansion.rule]));
		const beforeRecord = resolvedSource(before.source).get(recordKeyValue);
		const afterRecord = resolvedSource(after.source).get(recordKeyValue);
		const beforeUnit = beforeRecord?.data?.ruleContext?.unit;
		const afterUnit = afterRecord?.data?.ruleContext?.unit;
		const beforeMil = beforeRecord?.data?.ruleContext?.[expansion.sourceField];
		const afterMil = afterRecord?.data?.ruleContext?.[expansion.sourceField];
		if (unit !== 'mm' || beforeUnit !== unit || afterUnit !== unit
			|| typeof beforeMil !== 'number' || !Number.isFinite(beforeMil) || typeof afterMil !== 'number' || !Number.isFinite(afterMil)
			|| beforeMil === afterMil || !expansionMmMatchesRawMil(requested.value, afterMil) || actual !== afterMil * 0.0254) {
			return undefined;
		}
		return {
			path,
			requested: requested.value,
			actual,
			normalizedMil: afterMil,
			sourceVerified: true,
			sourcePath: `RULE ${expansion.family} ${expansion.rule}.ruleContext.${expansion.sourceField}`,
			sourceBeforeMil: beforeMil,
			sourceAfterMil: afterMil,
			sourceEvidence: '实测同名扩展规则字段的raw mil已变化到请求换算值，getter严格等于rawMil × 0.0254',
		};
	}
	const safe = /^config\.Spacing\.Safe Spacing\.([^.]+)\.tables\.([^.]*)\.content\.(\d+)\.(\d+)$/.exec(path.join('.'));
	if (!safe || requested)
		return undefined;
	const [, rule, table, row, column] = safe;
	const unit = expectedConfiguration.config?.Spacing?.['Safe Spacing']?.[rule]?.unit;
	const beforeRows = resolvedSource(before.source);
	const afterRows = resolvedSource(after.source);
	const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'SAFE', rule]));
	const beforeRecord = beforeRows.get(recordKeyValue);
	const afterRecord = afterRows.get(recordKeyValue);
	if (unit !== 'mm' || !beforeRecord || !afterRecord || beforeRecord.data?.ruleContext?.unit !== unit || afterRecord.data?.ruleContext?.unit !== unit)
		return undefined;
	const beforeLayers = beforeRecord.data?.ruleContext?.safeSpacing;
	const afterLayers = afterRecord.data?.ruleContext?.safeSpacing;
	if (!Array.isArray(beforeLayers) || !Array.isArray(afterLayers))
		return undefined;
	const beforeMatches = beforeLayers.filter((item: any) => String(item.layerId) === table);
	const afterMatches = afterLayers.filter((item: any) => String(item.layerId) === table);
	if (beforeMatches.length !== 1 || afterMatches.length !== 1)
		return undefined;
	const beforeRow = beforeMatches[0].content?.[Number(row)];
	const afterRow = afterMatches[0].content?.[Number(row)];
	const beforeRaw = beforeRow?.[Number(column)];
	const afterRaw = afterRow?.[Number(column)];
	const expectedMil = typeof expectedValue === 'number' && Number.isFinite(expectedValue) ? Math.round(expectedValue / 0.0254 * 1e4) / 1e4 : undefined;
	const actualMil = typeof actual === 'number' && Number.isFinite(actual) ? Math.round(actual / 0.0254 * 1e4) / 1e4 : undefined;
	if (typeof beforeRaw !== 'number' || !Number.isFinite(beforeRaw) || beforeRaw !== afterRaw
		|| beforeRaw !== expectedMil || beforeRaw !== actualMil) {
		return undefined;
	}
	return {
		path,
		requested: expectedValue,
		actual,
		normalizedMil: afterRaw,
		sourceVerified: true,
		sourcePath: `RULE SAFE ${rule}.safeSpacing[layerId=${table}].content[${row}][${column}]`,
		sourceBeforeMil: beforeRaw,
		sourceAfterMil: afterRaw,
		sourceEvidence: '同名SAFE规则中唯一layerId的同一单元格在写入前后保持有限且严格相等，并与getter的expected/actual毫米值换算一致',
	};
}

function requireExpected(current: RuleSnapshot, expected: Pick<RuleSnapshot, 'configuration' | 'netRules'>, phase: string, changes: RulePathChange[], netChanges: NetRuleChange[], before: RuleSnapshot): { normalizations: unknown[]; sourceRuleChanges: unknown[] } {
	const normalizations: unknown[] = [];
	const sourceRuleChanges: unknown[] = [];
	const actual = cloneRuleValue(current.configuration);
	const wanted = cloneRuleValue(expected.configuration);
	if (current.configurationName !== undefined && actual.name !== current.configurationName)
		throw new Error(`${phase}配置名称 getter 与配置对象名称不一致`);
	// The SDK promotes a selected built-in template to a generated custom configuration name.
	// Name is reported as SDK metadata and is never treated as a writeable design-rule field.
	if (actual.name !== wanted.name && (typeof current.configurationName !== 'string' || actual.name !== current.configurationName || typeof before.configurationName !== 'string' || before.configuration.name !== before.configurationName))
		throw new Error(`${phase}配置名称变化未由官方配置名称 getter 确认`);
	delete actual.name;
	delete wanted.name;
	const expectedLeaves = flattenLeaves(wanted);
	const actualLeaves = flattenLeaves(actual);
	const keys = new Set([...expectedLeaves.keys(), ...actualLeaves.keys()]);
	for (const pathKey of keys) {
		if (expectedLeaves.has(pathKey) && actualLeaves.has(pathKey) && stableRuleJson(expectedLeaves.get(pathKey)) === stableRuleJson(actualLeaves.get(pathKey)))
			continue;
		const path = JSON.parse(pathKey) as string[];
		const accepted = allowedGetterDifference(path, expectedLeaves.get(pathKey), actualLeaves.get(pathKey), changes, wanted, before, current);
		if (!accepted)
			throw new Error(`${phase}读回与预期不符：${path.join('.')}`);
		normalizations.push(accepted);
	}
	if (stableRuleJson(current.netRules) !== stableRuleJson(expected.netRules))
		throw new Error(`${phase}网络规则读回与预期不符`);
	const sourceDifferences = rawRuleDiff(before, current, changes, netChanges, phase, sourceRuleChanges);
	if (sourceDifferences.length)
		throw new Error(`${phase}源码存在未授权变化：${sourceDifferences.slice(0, 8).join('; ')}`);
	return { normalizations, sourceRuleChanges };
}

function requirePreWriteSnapshot(current: RuleSnapshot, expectedConfiguration: any, expectedConfigurationName: string | undefined, expectedNetRules: unknown[], before: RuleSnapshot): void {
	if (current.configurationName !== expectedConfigurationName || stableRuleJson(current.netRules) !== stableRuleJson(expectedNetRules))
		throw new Error('规则快照已变化；拒绝覆盖用户新修改');
	const actual = cloneRuleValue(current.configuration);
	const wanted = cloneRuleValue(expectedConfiguration);
	if (actual.name !== wanted.name || (current.configurationName !== undefined && actual.name !== current.configurationName))
		throw new Error('规则配置名称已变化；拒绝覆盖用户新修改');
	delete actual.name;
	delete wanted.name;
	const expectedLeaves = flattenLeaves(wanted);
	const actualLeaves = flattenLeaves(actual);
	const keys = new Set([...expectedLeaves.keys(), ...actualLeaves.keys()]);
	for (const pathKey of keys) {
		if (expectedLeaves.has(pathKey) && actualLeaves.has(pathKey) && stableRuleJson(expectedLeaves.get(pathKey)) === stableRuleJson(actualLeaves.get(pathKey)))
			continue;
		const path = JSON.parse(pathKey) as string[];
		if (!allowedGetterDifference(path, expectedLeaves.get(pathKey), actualLeaves.get(pathKey), [], wanted, before, current))
			throw new Error(`规则快照已变化；拒绝覆盖用户新修改：${path.join('.')}`);
	}
	const differences = rawRuleDiff(before, current, [], [], 'prewrite', []);
	if (differences.length)
		throw new Error(`规则原始快照已变化；拒绝覆盖用户新修改：${differences.slice(0, 8).join('; ')}`);
}

function phaseFailure(phase: string, state: PcbRuleUpdateResult, error: unknown, outcome: 'unknown' | 'mismatch'): Error {
	const message = String((error as any)?.message ?? error);
	return fail(`${phase}写入已发出，但无法确认设计规则结果：${message}`, {
		// A dispatched write with failed/incomplete readback is itself partial, even if this was stage one.
		partial: true,
		outcome,
		phase,
		writeAttempted: true,
		stages: { configuration: state.configuration, netRules: state.netRules },
	});
}

function rejectUnpersistedDifferentialSpacingMax(changes: RulePathChange[]): void {
	const visit = (value: unknown, path: string[], explicit: boolean): void => {
		if (path.includes('diffPairSpacingTables') && explicit && path[path.length - 1] === 'maxValue' && value !== null && value !== undefined)
			throw new Error(`差分间距 maxValue 当前没有对应的源码字段，拒绝将未持久化值视为成功：${path.join('.')}`);
		if (!value || typeof value !== 'object')
			return;
		const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
		for (const [key, child] of entries)
			visit(child, [...path, key], true);
	};
	for (const change of changes)
		visit(change.value, change.path, true);
}

async function updateDesignRules(params: PcbRuleUpdateParams, ctx?: ICommandContext): Promise<PcbRuleUpdateResult> {
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
		throw new Error('dryRun 必须是 boolean');
	if (params.__docUuid !== undefined && (typeof params.__docUuid !== 'string' || !params.__docUuid.trim()))
		throw new Error('__docUuid 必须是非空字符串');
	if (params.__projectUuid !== undefined && (typeof params.__projectUuid !== 'string' || !params.__projectUuid.trim()))
		throw new Error('__projectUuid 必须是非空字符串');
	const dryRun = params.dryRun !== false;
	rejectUnpersistedDifferentialSpacingMax(params.changes ?? []);
	const snapshot = await readSnapshot(ctx);
	if (params.__docUuid && params.__docUuid !== snapshot.document.uuid)
		throw new Error(`请求目标 PCB UUID 不符：${params.__docUuid}`);
	if (params.__projectUuid && params.__projectUuid !== snapshot.document.parentProjectUuid)
		throw new Error(`请求目标工程 UUID 不符：${params.__projectUuid}`);
	const candidateConfigChanges = expandExistingTrackRows(params.changes ?? [], snapshot.configuration);
	const initialNormalizations = candidateConfigChanges.flatMap(change => [existingTrackQuantization(change, snapshot), existingExpansionQuantization(change, snapshot)]).filter((item): item is Record<string, unknown> => Boolean(item));
	const normalizedPaths = new Set(initialNormalizations.map(item => stableRuleJson(item.path)));
	const effectiveConfigChanges = candidateConfigChanges.filter(change => !normalizedPaths.has(stableRuleJson(change.path)));
	const configPlan = applyConfigurationChanges(snapshot.configuration, effectiveConfigChanges);
	const netPlan = applyNetRuleChanges(snapshot.netRules, params.netRuleChanges ?? []);
	const resolvedNetChanges: NetRuleChange[] = netPlan.diff.map(change => ({
		type: change.type,
		name: change.name,
		values: Object.fromEntries(Object.entries(change.values).map(([field, value]) => [field, value.after])),
	}));
	const state: PcbRuleUpdateResult = {
		dryRun,
		document: snapshot.document,
		configuration: { status: configPlan.diff.length ? (dryRun ? 'planned' : 'pending') : 'skipped', diff: configPlan.diff },
		netRules: { status: netPlan.diff.length ? (dryRun ? 'planned' : 'pending') : 'skipped', diff: netPlan.diff },
		verified: dryRun || (!configPlan.diff.length && !netPlan.diff.length),
	};
	if (initialNormalizations.length)
		state.configuration.normalizations = initialNormalizations;
	if (dryRun || (!configPlan.diff.length && !netPlan.diff.length))
		return state;

	const phases: Array<'configuration' | 'netRules'> = ['configuration', 'netRules'];
	let sourceBaseline = snapshot;
	for (const phase of phases) {
		const diff = phase === 'configuration' ? configPlan.diff : netPlan.diff;
		if (!diff.length)
			continue;
		const expectedBefore = phase === 'configuration'
			? { configuration: snapshot.configuration, netRules: snapshot.netRules }
			: { configuration: sourceBaseline.configuration, netRules: snapshot.netRules };
		const expectedBeforeName = phase === 'configuration' ? snapshot.configurationName : sourceBaseline.configurationName;
		const expectedAfter = phase === 'configuration'
			? { configuration: configPlan.expected, netRules: snapshot.netRules }
			: { configuration: sourceBaseline.configuration, netRules: netPlan.expected };
		try {
			const latest = await readSnapshot(ctx);
			if (latest.document.uuid !== snapshot.document.uuid || stableRuleJson(latest.document) !== stableRuleJson(snapshot.document))
				throw new Error('PCB 工程或文档身份发生变化');
			requirePreWriteSnapshot(latest, expectedBefore.configuration, expectedBeforeName, expectedBefore.netRules, sourceBaseline);
			await assertTarget(ctx, snapshot.document);
		}
		catch (error) {
			const priorApplied = state.configuration.status === 'applied' || state.netRules.status === 'applied';
			if (priorApplied) {
				throw fail(`${phase}阶段未写入；前一阶段已应用，后续阶段停止：${String((error as any)?.message ?? error)}`, {
					partial: true,
					outcome: 'not_started',
					phase,
					writeAttempted: false,
					stages: { configuration: state.configuration, netRules: state.netRules },
				});
			}
			throw error;
		}
		state[phase].status = 'writing';
		let sdkResult: unknown;
		let sdkError: string | undefined;
		try {
			if (phase === 'configuration')
				sdkResult = await eda.pcb_Drc.overwriteCurrentRuleConfiguration((configPlan.expected as Record<string, any>).config);
			else sdkResult = await eda.pcb_Drc.overwriteNetRules(netPlan.expected as Record<string, any>[]);
		}
		catch (error) { sdkError = String((error as any)?.message ?? error); }
		let after: RuleSnapshot;
		try {
			after = await readSnapshot(ctx);
			const verification = requireExpected(after, expectedAfter, phase, phase === 'configuration' ? effectiveConfigChanges : [], phase === 'netRules' ? resolvedNetChanges : [], sourceBaseline);
			state.configuration.normalizations = [...(state.configuration.normalizations ?? []), ...verification.normalizations];
			state.configuration.sourceRuleChanges = [...(state.configuration.sourceRuleChanges ?? []), ...verification.sourceRuleChanges];
			if (phase === 'configuration') {
				state.configuration.metadata = {
					configurationNameBefore: snapshot.configurationName,
					getterNameBefore: snapshot.configurationName,
					configurationNameAfter: after.configurationName,
					getterNameAfter: after.configurationName,
					nameIsSdkGeneratedMetadata: snapshot.configurationName !== after.configurationName,
				};
			}
		}
		catch (error) {
			state[phase].sdkResult = sdkResult;
			if (sdkError)
				state[phase].sdkError = sdkError;
			state[phase].status = 'outcomeunknown';
			throw phaseFailure(phase, state, error, 'unknown');
		}
		state[phase].status = 'applied';
		state[phase].sdkResult = sdkResult;
		if (sdkError)
			state[phase].sdkError = sdkError;
		if (sdkResult === false || sdkError)
			state[phase].sdkWarning = sdkError ?? 'SDK 返回 false，但完整读回与预期相符';
		sourceBaseline = after;
		try {
			ctx?.stopSignal?.assertActive();
			await assertTarget(ctx, snapshot.document);
		}
		catch (error) {
			const nextPhase = phase === 'configuration' && netPlan.diff.length ? 'netRules' : undefined;
			throw fail(`${phase}阶段读回已确认，但停止信号或目标复核阻止后续写入`, {
				partial: Boolean(nextPhase),
				outcome: nextPhase ? 'not_started' : 'verified',
				phase: nextPhase ?? phase,
				writeAttempted: false,
				blocker: String((error as any)?.message ?? error),
				stages: { configuration: state.configuration, netRules: state.netRules },
			});
		}
	}
	state.verified = true;
	return state;
}

export const pcbRuleCommands: ICommandDef[] = [
	{
		name: 'pcb.getDesignRules',
		summary: '读取当前 PCB 的完整设计规则配置和网络规则绑定',
		params: [],
		returns: '{ document, configuration, configurationName, netRules }',
		example: { cmd: 'pcb.getDesignRules' },
		handler: async (_params, ctx) => {
			const snapshot = await readSnapshot(ctx);
			return { document: snapshot.document, configuration: snapshot.configuration, configurationName: snapshot.configurationName, netRules: snapshot.netRules };
		},
	},
	{
		name: 'pcb.updateDesignRules',
		summary: '按明确字段修改当前 PCB 设计规则；默认仅预览差异',
		params: [
			{ name: 'changes', type: 'array', required: false, description: '配置字段补丁 [{path: string[], value: JSON}]；path 必须以 config 开头并指向 getter 的 configuration.config 内字段；外层 name 等元数据不可写。只改一个叶字段，可新增末级叶，父路径必须已存在。数值按该规则当前 unit 提供，不自动换算。' },
			{ name: 'netRuleChanges', type: 'array', required: false, description: '网络绑定补丁 [{type, name, values}]；从 getter 原样选取 type/name，精确且唯一匹配现有行（包括 sub 中的网络）。网络类赋值按界面语义同时分配到其成员；同批显式网络值优先，与输入顺序无关。预览列出全部实际变化，成员项标明 fromClass。values 仅更新已有绑定字段，值须为规则名字符串或 null；保留行身份及分组结构。' },
			{ name: 'dryRun', type: 'boolean', required: false, description: '严格 boolean；省略时默认 true，只返回差异，不写入。明确传 false 才执行。' },
		],
		returns: '{ dryRun, document, configuration, netRules, verified }；configuration.sourceRuleChanges 单列已变更的原始规则记录；normalizations 只列有逐字段源码数值依据的表示差异（如 SAFE 未选格与已映射的阻焊/锡膏扩展字段），不放宽其他字段，也不表示所有规则都可归一。差分间距 diffPairSpacingTables 的 maxValue 当前没有对应的原始源码字段，明确请求非空值会在写前拒绝；不能据即时 getter 缓存判断已持久化。未完整映射的原始字段会标明，完整 getter 读回不代表隐藏源字段均已映射。每个写入阶段都复核写前快照；未知结果停止后续阶段，不自动回滚或重试。Track:"default" 表示跟随默认规则；宿主保存时可能把 Track／等长容差指向当前默认规则名称的绑定转成 default，不能据此保证以后仍固定绑定该名称。verified 为即时读回，持久性须保存重开核对',
		example: { cmd: 'pcb.updateDesignRules', params: { changes: [{ path: ['config', 'Physics', 'Track', 'copperThickness1oz', 'form', 'data', '1', 'defaultValue'], value: 0.2 }] } },
		handler: async (params, ctx) => updateDesignRules(params as PcbRuleUpdateParams, ctx),
	},
	{
		name: 'pcb.deleteTrackRule',
		summary: '删除当前 PCB 中未引用的非默认 TRACK 规则定义；默认仅预览，不删除应用级规则方案模板',
		params: [
			{ name: 'name', type: 'string', required: true, description: '当前 PCB 的 TRACK 规则名；必须存在、明确为非默认，且无网络或源码引用。' },
			{ name: 'dryRun', type: 'boolean', required: false, description: '严格 boolean；省略时默认 true，只检查引用并返回计划；明确传 false 才执行。' },
		],
		returns: '{ dryRun, status, document, name, deletedDefinition, references, sdkResult, sdkWarning, verified, saved }；只删除当前 PCB 的一条无引用非默认 TRACK 规则定义，不删除应用级规则方案模板。写前复核完整 getter、源码及绑定；写后核对目标记录消失且非目标 getter、绑定和源码未变化。verified 表示即时读回，不表示已保存；未知结果停止，不重试或回滚。',
		example: { cmd: 'pcb.deleteTrackRule', params: { name: 'CFG_TRACK_ALT', dryRun: true } },
		handler: async (params, ctx) => deleteTrackRule(params as PcbTrackRuleDeleteParams, ctx),
	},
];

export const pcbRuleUpdateHandler = updateDesignRules;
