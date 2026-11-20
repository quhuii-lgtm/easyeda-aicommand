export interface RoutingRuleSourceRecord {
	type: string;
	id: string;
	data: unknown;
}

export type EquivalentPourSafeProof
	= | { verified: true; pourId: string; safeName: string; defaultSafeName: string; comparedCells: number }
		| { verified: false; reason: string; pourId?: string; safeName?: string };

type PlainObject = Record<string, unknown>;

function object(value: unknown): PlainObject | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as PlainObject : undefined;
}

function tuple(value: unknown): unknown[] {
	if (typeof value !== 'string')
		return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	}
	catch {
		return [];
	}
}

function safeNameFromId(record: RoutingRuleSourceRecord): string | undefined {
	const id = tuple(record.id);
	return record.type === 'RULE' && id.length === 3 && id[0] === 'RULE' && id[1] === 'SAFE' && typeof id[2] === 'string' && id[2].trim() ? id[2] : undefined;
}

function isEmptyObject(value: unknown): boolean {
	const item = object(value);
	return Boolean(item && Object.keys(item).length === 0);
}

function getSafeGetterProfiles(configuration: unknown): { profiles: Record<string, PlainObject>; defaultName: string } | undefined {
	const config = object(object(configuration)?.config);
	const spacing = object(config?.Spacing);
	const safeProfiles = object(spacing?.['Safe Spacing']);
	if (!safeProfiles)
		return undefined;
	const profiles = Object.fromEntries(Object.entries(safeProfiles).flatMap(([name, value]) => {
		const profile = object(value);
		return profile ? [[name, profile]] : [];
	}));
	const defaults = Object.entries(profiles).filter(([, profile]) => profile.isSetDefault === true && profile.unit === 'mm');
	if (defaults.length !== 1)
		return undefined;
	const [defaultName, defaultProfile] = defaults[0];
	if (defaultProfile.editName !== defaultName)
		return undefined;
	return { profiles, defaultName };
}

function safeSourceRule(records: RoutingRuleSourceRecord[], name: string, isDefault: boolean): PlainObject | undefined {
	const matches = records.filter(record => safeNameFromId(record) === name);
	if (matches.length !== 1)
		return undefined;
	const data = object(matches[0].data);
	const context = object(data?.ruleContext);
	if (!data || !context || data.ruleState !== (isDefault ? 'DEFAULT' : 'NORMAL')
		|| Object.keys(data).sort().join(',') !== 'ruleContext,ruleState'
		|| Object.keys(context).sort().join(',') !== 'isForAll,safeSpacing,unit'
		|| context.unit !== 'mm' || context.isForAll !== 'ALL' || !Array.isArray(context.safeSpacing)) {
		return undefined;
	}
	return data;
}

interface SafeLayerMatrix {
	getterCells: number[][];
	sourceCells: number[][];
	getterStatus: unknown;
	sourceIsOpen: true;
	sourceColumnNames: unknown[];
}

function sourceGetterEquivalent(getterMm: number, sourceMil: number): boolean {
	const sourceMm = sourceMil * 0.0254;
	const tolerance = Number.EPSILON * Math.max(1, Math.abs(getterMm), Math.abs(sourceMm)) * 2;
	return Math.abs(getterMm - sourceMm) <= tolerance;
}

function profileLayerCells(profile: PlainObject, sourceRule: PlainObject): Map<string, SafeLayerMatrix> | undefined {
	if (profile.unit !== 'mm' || profile.editName === undefined || typeof profile.editName !== 'string')
		return undefined;
	const tables = object(profile.tables);
	const context = object(sourceRule.ruleContext);
	const sourceLayers = context?.safeSpacing;
	if (!tables || !Array.isArray(sourceLayers) || !Object.keys(tables).length)
		return undefined;
	const tableIds = Object.keys(tables).sort();
	const layersById = new Map<string, PlainObject[]>();
	for (const layerValue of sourceLayers) {
		const layer = object(layerValue);
		if (!layer || !Number.isFinite(Number(layer.layerId)))
			return undefined;
		const id = String(layer.layerId);
		const list = layersById.get(id) ?? [];
		list.push(layer);
		layersById.set(id, list);
	}
	if (layersById.size !== tableIds.length || tableIds.some(id => layersById.get(id)?.length !== 1))
		return undefined;
	const output = new Map<string, SafeLayerMatrix>();
	for (const id of tableIds) {
		const table = object(tables[id]);
		const sourceLayer = layersById.get(id)![0];
		const getterCells = table?.content;
		const sourceCells = sourceLayer.content;
		if (table?.status !== 1 || sourceLayer.isOpen !== true || !Array.isArray(sourceLayer.columnNames)
			|| Object.keys(table).sort().join(',') !== 'content,status'
			|| Object.keys(sourceLayer).sort().join(',') !== 'columnNames,content,isOpen,layerId'
			|| !Array.isArray(getterCells) || !Array.isArray(sourceCells)
			|| getterCells.length !== sourceCells.length) {
			return undefined;
		}
		let cellCount = 0;
		const convertedGetter: number[][] = [];
		const convertedSource: number[][] = [];
		for (let row = 0; row < getterCells.length; row++) {
			const getterRow = getterCells[row];
			const sourceRow = sourceCells[row];
			if (!Array.isArray(getterRow) || !Array.isArray(sourceRow) || getterRow.length !== sourceRow.length)
				return undefined;
			const getterRowValues: number[] = [];
			const sourceRowValues: number[] = [];
			for (let column = 0; column < getterRow.length; column++) {
				const getterValue = getterRow[column];
				const sourceValue = sourceRow[column];
				if (typeof getterValue !== 'number' || !Number.isFinite(getterValue)
					|| typeof sourceValue !== 'number' || !Number.isFinite(sourceValue)
					|| !sourceGetterEquivalent(getterValue, sourceValue)) {
					return undefined;
				}
				getterRowValues.push(getterValue);
				sourceRowValues.push(sourceValue);
				cellCount++;
			}
			convertedGetter.push(getterRowValues);
			convertedSource.push(sourceRowValues);
		}
		if (cellCount !== 89)
			return undefined;
		output.set(id, {
			getterCells: convertedGetter,
			sourceCells: convertedSource,
			getterStatus: table.status,
			sourceIsOpen: true,
			sourceColumnNames: sourceLayer.columnNames,
		});
	}
	return output;
}

function sameRows(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Prove one POUR SAFE binding is semantically identical to the active default SAFE matrix. */
export function proveEquivalentPourSafeSelector(
	selector: RoutingRuleSourceRecord,
	records: RoutingRuleSourceRecord[],
	configuration: unknown,
): EquivalentPourSafeProof {
	if (selector.type !== 'RULE_SELECTOR')
		return { verified: false, reason: '对象不是 RULE_SELECTOR' };
	const id = tuple(selector.id);
	const scope = id[1];
	if (id.length !== 2 || id[0] !== 'RULE_SELECTOR' || !Array.isArray(scope) || scope.length !== 2
		|| scope[0] !== 'POUR' || typeof scope[1] !== 'string' || !scope[1].trim()) {
		return { verified: false, reason: 'selector 不是有效的 POUR 规则范围' };
	}
	const pourId = scope[1];
	const sameSelector = records.filter((record) => {
		if (record.type !== 'RULE_SELECTOR')
			return false;
		const parts = tuple(record.id);
		return parts.length === 2 && parts[0] === 'RULE_SELECTOR' && Array.isArray(parts[1])
			&& parts[1].length === 2 && parts[1][0] === 'POUR' && parts[1][1] === pourId;
	});
	if (sameSelector.length !== 1 || sameSelector[0] !== selector)
		return { verified: false, reason: 'POUR selector 不唯一', pourId };
	const parentPours = records.filter(record => record.type === 'POUR' && record.id === pourId);
	if (parentPours.length !== 1 || !object(parentPours[0].data) || !Object.keys(object(parentPours[0].data)!).length)
		return { verified: false, reason: 'POUR 父对象不存在、无效或不唯一', pourId };
	const data = object(selector.data);
	if (!data || Object.keys(data).sort().join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder'
		|| data.ruleOrder !== 2 || data.parent !== null || !isEmptyObject(data.copperValue) || !isEmptyObject(data.innerPlaneValue)) {
		return { verified: false, reason: 'POUR selector 字段不是已验证的独立 SAFE 结构', pourId };
	}
	const ruleKeyValue = object(data.ruleKeyValue);
	const safeName = ruleKeyValue && Object.keys(ruleKeyValue).length === 1 && typeof ruleKeyValue.SAFE === 'string' && ruleKeyValue.SAFE.trim()
		? ruleKeyValue.SAFE
		: undefined;
	if (!safeName)
		return { verified: false, reason: 'POUR selector 没有唯一有效 SAFE 引用', pourId };
	const getter = getSafeGetterProfiles(configuration);
	if (!getter)
		return { verified: false, reason: 'getter 中 active SAFE 配置缺失或不唯一', pourId, safeName };
	const selectedProfile = getter.profiles[safeName];
	const defaultProfile = getter.profiles[getter.defaultName];
	if (!selectedProfile || !defaultProfile || selectedProfile.editName !== safeName)
		return { verified: false, reason: 'getter 中选中 SAFE 配置不存在或身份不匹配', pourId, safeName };
	if (!Object.prototype.hasOwnProperty.call(selectedProfile, 'status')
		|| !Object.prototype.hasOwnProperty.call(defaultProfile, 'status')
		|| !sameRows(selectedProfile.status, defaultProfile.status)) {
		return { verified: false, reason: '选中 SAFE 配置状态缺失或与 active SAFE 不一致', pourId, safeName };
	}
	const selectedSource = safeSourceRule(records, safeName, safeName === getter.defaultName);
	const defaultSource = safeSourceRule(records, getter.defaultName, true);
	if (!selectedSource || !defaultSource)
		return { verified: false, reason: 'SAFE 原始规则记录缺失、重复或字段来源未确认', pourId, safeName };
	if (!sameRows(selectedProfile.row, defaultProfile.row) || !sameRows(selectedProfile.column, defaultProfile.column))
		return { verified: false, reason: '选中 SAFE 与 active SAFE 的矩阵标签不一致', pourId, safeName };
	const selectedCells = profileLayerCells(selectedProfile, selectedSource);
	const defaultCells = profileLayerCells(defaultProfile, defaultSource);
	if (!selectedCells || !defaultCells || !sameRows([...selectedCells.keys()], [...defaultCells.keys()]))
		return { verified: false, reason: 'SAFE 原始源码、getter 或 active SAFE 的 89 格矩阵无法逐格等价', pourId, safeName };
	for (const [layerId, selectedMatrix] of selectedCells) {
		const defaultMatrix = defaultCells.get(layerId)!;
		if (selectedMatrix.getterStatus !== defaultMatrix.getterStatus
			|| selectedMatrix.sourceIsOpen !== defaultMatrix.sourceIsOpen
			|| !sameRows(selectedMatrix.sourceColumnNames, defaultMatrix.sourceColumnNames)
			|| !sameRows(selectedMatrix.getterCells, defaultMatrix.getterCells)
			|| !sameRows(selectedMatrix.sourceCells, defaultMatrix.sourceCells)) {
			return { verified: false, reason: 'SAFE 原始源码、getter、列名或状态与 active SAFE 逐格不等价', pourId, safeName };
		}
	}
	return { verified: true, pourId, safeName, defaultSafeName: getter.defaultName, comparedCells: [...selectedCells.values()].reduce((sum, matrix) => sum + matrix.getterCells.flat().length, 0) };
}
