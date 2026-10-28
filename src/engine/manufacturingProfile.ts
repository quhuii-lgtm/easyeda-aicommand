import type { RoutingWidthSnapshot } from './routingWidthRules';
import type { PhysicalLayerEvidence } from './physicalLayerEvidence';

export type ProfileComparisonStatus = 'matched' | 'mismatch' | 'unknown' | 'not-applicable';
export type ManufacturingSource = { url: string; observedAt: string };
export type ManufacturingSelection = {
	copperLayers: number;
	nominalThicknessMm: number;
	outerCopperOz: number;
	innerCopperOz?: number;
};
export type ManufacturingProfileLayer = {
	name: string;
	kind: 'copper' | 'prepreg' | 'core';
	thicknessMm: number | 'unknown';
	material?: string;
	dk?: number | 'unknown';
};
export type ManufacturingCalculationModel = 'single-ended-non-coplanar' | 'single-ended-coplanar' | 'differential-non-coplanar' | 'differential-coplanar';
export type ManufacturingCalculation = {
	id: string;
	stackupId: string;
	source: ManufacturingSource;
	evidenceStatus: 'verified' | 'unverified';
	model: ManufacturingCalculationModel;
	targetOhm: number;
	signalLayer: string;
	topReference?: string | null;
	bottomReference?: string | null;
	widthMil?: number | 'unknown';
	spacingMil?: number | 'unknown';
	copperGapMil?: number | 'unknown';
	widthSpacingComplement?: boolean;
	bindings?: Array<{ net: string; edaLayerId: number; layerMappingSource: string }>;
};
export type ManufacturingProfile = {
	schemaVersion: 1;
	profileId: string;
	revision: string | number;
	manufacturer: string;
	productType: string;
	stackupId: string;
	source: ManufacturingSource;
	selection: ManufacturingSelection;
	officialStackup: {
		stackupId: string;
		orderedLayers: ManufacturingProfileLayer[];
		finishedThicknessMm?: number | 'unknown';
		finishedTolerancePercent?: number | 'unknown';
	};
	calculations?: ManufacturingCalculation[];
};
export type OrderImpedanceCalculation = {
	id: string;
	targetOhm: number;
	model: ManufacturingCalculationModel;
	signalLayer: string;
	topReference?: string | null;
	bottomReference?: string | null;
	widthMil?: number | 'unknown';
	spacingMil?: number | 'unknown';
	copperGapMil?: number | 'unknown';
	widthSpacingComplement?: boolean;
};
export type OrderConfirmation = {
	schemaVersion: 1;
	confirmed: true;
	source: ManufacturingSource;
	manufacturer: string;
	productType: string;
	stackupId: string;
	selection: ManufacturingSelection;
	impedanceService?: null | { source: ManufacturingSource; calculations: OrderImpedanceCalculation[] };
};
export interface ManufacturingComparisonItem {
	id: string;
	status: ProfileComparisonStatus;
	profileValue?: unknown;
	currentValue?: unknown;
	unit?: 'mm' | 'mil' | 'oz' | 'layer' | 'ohm' | 'boolean' | 'text';
	reason: string;
	sources: string[];
}
export interface ManufacturingProfileReport {
	overall: 'mismatch' | 'incomplete' | 'matched-within-scope';
	items: ManufacturingComparisonItem[];
	message: string;
}
export interface CompareManufacturingProfileInput {
	profile: unknown;
	routing: RoutingWidthSnapshot;
	enabledCopperLayers: Array<{ layerId: number; name?: string }>;
	rawPhysicalLayerRecords?: Array<{ header: { type: string; id?: string; ticket?: number }; data: unknown }>;
	physicalLayerEvidence?: PhysicalLayerEvidence;
	orderConfirmation?: unknown;
}

const profileKeys = ['schemaVersion', 'profileId', 'revision', 'manufacturer', 'productType', 'stackupId', 'source', 'selection', 'officialStackup', 'calculations'];
const selectionKeys = ['copperLayers', 'nominalThicknessMm', 'outerCopperOz', 'innerCopperOz'];
const sourceKeys = ['url', 'observedAt'];
const layerKeys = ['name', 'kind', 'thicknessMm', 'material', 'dk'];
const calculationKeys = ['id', 'stackupId', 'source', 'evidenceStatus', 'model', 'targetOhm', 'signalLayer', 'topReference', 'bottomReference', 'widthMil', 'spacingMil', 'copperGapMil', 'widthSpacingComplement', 'bindings'];
const bindingFieldKeys = ['net', 'edaLayerId', 'layerMappingSource'];
const orderKeys = ['schemaVersion', 'confirmed', 'source', 'manufacturer', 'productType', 'stackupId', 'selection', 'impedanceService'];
const orderServiceKeys = ['source', 'calculations'];
const orderCalculationKeys = ['id', 'targetOhm', 'model', 'signalLayer', 'topReference', 'bottomReference', 'widthMil', 'spacingMil', 'copperGapMil', 'widthSpacingComplement'];
const calculationModels = new Set<ManufacturingCalculationModel>([
	'single-ended-non-coplanar', 'single-ended-coplanar', 'differential-non-coplanar', 'differential-coplanar',
]);

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
	return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const extra = Object.keys(value).find(key => !allowed.includes(key));
	if (extra) throw new Error(`${label} 不支持字段 ${extra}`);
}
function requiredString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必须是非空字符串`);
	return value;
}
function finitePositive(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须是有限正数`);
	return value;
}
function validPercentEscapes(value: string): boolean { return !/%(?![0-9A-Fa-f]{2})/.test(value); }
function validIpv4(value: string): boolean {
	const parts = value.split('.');
	return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}
function validIpv6(value: string): boolean {
	if (!value || value.includes('%') || value.includes(':::')) return false;
	const doubleColon = value.indexOf('::');
	if (doubleColon !== -1 && value.indexOf('::', doubleColon + 2) !== -1) return false;
	const compressed = doubleColon !== -1;
	if (!compressed && (value.startsWith(':') || value.endsWith(':'))) return false;
	const halves = compressed ? value.split('::') : [value];
	if (halves.length !== (compressed ? 2 : 1)) return false;
	const left = halves[0];
	const right = compressed ? halves[1] : '';
	if ((left && (left.startsWith(':') || left.endsWith(':'))) || (right && (right.startsWith(':') || right.endsWith(':')))) return false;
	const leftParts = left ? left.split(':') : [];
	const rightParts = right ? right.split(':') : [];
	const parts = [...leftParts, ...rightParts];
	if (parts.length === 0 && !compressed) return false;
	let groups = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part.includes('.')) {
			if (index !== parts.length - 1 || (compressed && rightParts.length === 0) || !validIpv4(part)) return false;
			groups += 2;
		} else {
			if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return false;
			groups++;
		}
	}
	return compressed ? groups < 8 : groups === 8;
}
function validHost(value: string): boolean {
	if (!value || value.length > 253) return false;
	if (value.startsWith('[') || value.endsWith(']')) return false;
	if (/^[\d.]+$/.test(value)) return validIpv4(value);
	const domain = value.endsWith('.') ? value.slice(0, -1) : value;
	if (!domain) return false;
	return domain.split('.').every(label => label.length >= 1 && [...label].length <= 63 && /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u.test(label));
}
function validHttpAuthority(authority: string): boolean {
	if (!authority) return false;
	const at = authority.lastIndexOf('@');
	if (at !== -1) {
		if (authority.indexOf('@') !== at || at === 0) return false;
		const userinfo = authority.slice(0, at);
		if (!/^[A-Za-z0-9._~!$&'()*+,;=:%-]+$/.test(userinfo)) return false;
	}
	const hostPort = authority.slice(at + 1);
	let host: string;
	let port: string | undefined;
	if (hostPort.startsWith('[')) {
		const close = hostPort.indexOf(']');
		if (close < 0 || !validIpv6(hostPort.slice(1, close))) return false;
		host = hostPort.slice(0, close + 1);
		const remainder = hostPort.slice(close + 1);
		if (remainder) {
			if (!remainder.startsWith(':')) return false;
			port = remainder.slice(1);
		}
	} else {
		const colon = hostPort.lastIndexOf(':');
		if (colon !== -1) {
			if (hostPort.indexOf(':') !== colon) return false;
			host = hostPort.slice(0, colon);
			port = hostPort.slice(colon + 1);
		} else host = hostPort;
		if (!validHost(host)) return false;
	}
	if (port !== undefined && (!/^\d+$/.test(port) || Number(port) > 65535)) return false;
	return true;
}
function validAbsoluteSourceUri(value: string): boolean {
	if (/[\u0000-\u0020\u007f<>"{}|\\^`]/.test(value) || !validPercentEscapes(value)) return false;
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(value);
	if (!match) return false;
	const scheme = match[1].toLowerCase();
	const rest = match[2];
	if (scheme === 'http' || scheme === 'https') {
		if (!rest.startsWith('//')) return false;
		const authorityAndPath = rest.slice(2);
		const delimiter = authorityAndPath.search(/[/?#]/);
		const authority = delimiter < 0 ? authorityAndPath : authorityAndPath.slice(0, delimiter);
		return validHttpAuthority(authority);
	}
	return true;
}
function validSource(value: unknown, label: string): ManufacturingSource {
	const source = object(value, label);
	exactKeys(source, sourceKeys, label);
	const url = requiredString(source.url, `${label}.url`);
	if (!validAbsoluteSourceUri(url)) throw new Error(`${label}.url 必须是语法有效的绝对 URI`);
	const observedAt = requiredString(source.observedAt, `${label}.observedAt`);
	if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`${label}.observedAt 必须是有效日期时间`);
	return value as ManufacturingSource;
}
function validateSelection(value: unknown, label: string): ManufacturingSelection {
	const selection = object(value, label);
	exactKeys(selection, selectionKeys, label);
	if (typeof selection.copperLayers !== 'number' || !Number.isInteger(selection.copperLayers) || selection.copperLayers < 1)
		throw new Error(`${label}.copperLayers 必须是正整数`);
	finitePositive(selection.nominalThicknessMm, `${label}.nominalThicknessMm`);
	finitePositive(selection.outerCopperOz, `${label}.outerCopperOz`);
	if (selection.copperLayers > 2) finitePositive(selection.innerCopperOz, `${label}.innerCopperOz`);
	else if (selection.innerCopperOz !== undefined) throw new Error(`${label}.innerCopperOz 仅适用于多于2层的板，不超过2层时必须省略`);
	return value as ManufacturingSelection;
}
function optionalMeasurement(value: unknown, label: string, unit: string): void {
	if (value === undefined || value === 'unknown') return;
	finitePositive(value, `${label} (${unit})`);
}
function optionalNonnegative(value: unknown, label: string, unit: string): void {
	if (value === undefined || value === 'unknown') return;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} (${unit}) 必须是有限非负数`);
}
function validateModelDimensions(calculation: Record<string, unknown>, label: string): void {
	const model = calculation.model as ManufacturingCalculationModel;
	const differential = model.startsWith('differential-');
	const coplanar = model.endsWith('-coplanar') && !model.endsWith('-non-coplanar');
	if (!differential && calculation.spacingMil !== undefined && calculation.spacingMil !== 'unknown')
		throw new Error(`${label}.spacingMil 仅适用于差分模型`);
	if (!coplanar && calculation.copperGapMil !== undefined && calculation.copperGapMil !== 'unknown')
		throw new Error(`${label}.copperGapMil 仅适用于共面模型`);
}
function validateCalculation(value: unknown, label: string, stackupId: string, copperLayerNames: Set<string>): ManufacturingCalculation {
	const calculation = object(value, label);
	exactKeys(calculation, calculationKeys, label);
	requiredString(calculation.id, `${label}.id`);
	if (calculation.stackupId !== stackupId) throw new Error(`${label}.stackupId 与 profile.stackupId 冲突`);
	validSource(calculation.source, `${label}.source`);
	if (calculation.evidenceStatus !== 'verified' && calculation.evidenceStatus !== 'unverified')
		throw new Error(`${label}.evidenceStatus 必须是 verified 或 unverified`);
	if (typeof calculation.model !== 'string' || !calculationModels.has(calculation.model as ManufacturingCalculationModel))
		throw new Error(`${label}.model 不受支持`);
	finitePositive(calculation.targetOhm, `${label}.targetOhm`);
	const signalLayer = requiredString(calculation.signalLayer, `${label}.signalLayer`);
	if (!copperLayerNames.has(signalLayer)) throw new Error(`${label}.signalLayer 不在 profile 已声明铜层中`);
	const orderedCopperNames = [...copperLayerNames];
	const signalPosition = orderedCopperNames.indexOf(signalLayer);
	for (const field of ['topReference', 'bottomReference'] as const) {
		if (calculation[field] !== undefined && calculation[field] !== null) {
			const reference = requiredString(calculation[field], `${label}.${field}`);
			if (!copperLayerNames.has(reference)) throw new Error(`${label}.${field} 不在 profile 已声明铜层中`);
			if (reference === signalLayer) throw new Error(`${label}.${field} 不能与 signalLayer 相同`);
			const referencePosition = orderedCopperNames.indexOf(reference);
			if (field === 'topReference' && referencePosition > signalPosition) throw new Error(`${label}.topReference 必须位于 signalLayer 顶侧`);
			if (field === 'bottomReference' && referencePosition < signalPosition) throw new Error(`${label}.bottomReference 必须位于 signalLayer 底侧`);
		}
	}
	if (calculation.topReference !== undefined && calculation.bottomReference !== undefined && calculation.topReference !== null && calculation.bottomReference !== null && calculation.topReference === calculation.bottomReference)
		throw new Error(`${label}.topReference 和 bottomReference 不能指向同一层`);
	if (calculation.topReference === null && calculation.bottomReference === null)
		throw new Error(`${label} 的阻抗模型不能同时声明无上下参考层`);
	optionalMeasurement(calculation.widthMil, `${label}.widthMil`, 'mil');
	optionalMeasurement(calculation.spacingMil, `${label}.spacingMil`, 'mil');
	optionalMeasurement(calculation.copperGapMil, `${label}.copperGapMil`, 'mil');
	validateModelDimensions(calculation, label);
	if (calculation.widthSpacingComplement !== undefined && typeof calculation.widthSpacingComplement !== 'boolean')
		throw new Error(`${label}.widthSpacingComplement 必须是 boolean`);
	if (calculation.bindings !== undefined && !Array.isArray(calculation.bindings)) throw new Error(`${label}.bindings 必须是数组`);
	return value as ManufacturingCalculation;
}
function validateProfile(value: unknown): ManufacturingProfile {
	const profile = object(value, 'profile');
	exactKeys(profile, profileKeys, 'profile');
	if (profile.schemaVersion !== 1) throw new Error('profile.schemaVersion 必须为 1');
	requiredString(profile.profileId, 'profile.profileId');
	if (!(typeof profile.revision === 'string' && profile.revision.trim()) && !(typeof profile.revision === 'number' && Number.isFinite(profile.revision)))
		throw new Error('profile.revision 必须是字符串或有限数值');
	requiredString(profile.manufacturer, 'profile.manufacturer');
	requiredString(profile.productType, 'profile.productType');
	const stackupId = requiredString(profile.stackupId, 'profile.stackupId');
	validSource(profile.source, 'profile.source');
	const selection = validateSelection(profile.selection, 'profile.selection');
	const stackup = object(profile.officialStackup, 'profile.officialStackup');
	exactKeys(stackup, ['stackupId', 'orderedLayers', 'finishedThicknessMm', 'finishedTolerancePercent'], 'profile.officialStackup');
	if (requiredString(stackup.stackupId, 'profile.officialStackup.stackupId') !== stackupId)
		throw new Error('profile.officialStackup.stackupId 与 profile.stackupId 冲突');
	if (!Array.isArray(stackup.orderedLayers) || stackup.orderedLayers.length === 0) throw new Error('profile.officialStackup.orderedLayers 必须是非空数组');
	for (const [index, rawLayer] of stackup.orderedLayers.entries()) {
		const label = `profile.officialStackup.orderedLayers[${index}]`;
		const layer = object(rawLayer, label);
		exactKeys(layer, layerKeys, label);
		requiredString(layer.name, `${label}.name`);
		if (layer.kind !== 'copper' && layer.kind !== 'prepreg' && layer.kind !== 'core') throw new Error(`${label}.kind 无效`);
		if (layer.thicknessMm !== 'unknown') finitePositive(layer.thicknessMm, `${label}.thicknessMm`);
		if (layer.material !== undefined) requiredString(layer.material, `${label}.material`);
		if (layer.dk !== undefined && layer.dk !== 'unknown') finitePositive(layer.dk, `${label}.dk`);
	}
	const allLayerNames = new Set<string>();
	const copperLayerNames = new Set<string>();
	for (const layer of stackup.orderedLayers as ManufacturingProfileLayer[]) {
		if (allLayerNames.has(layer.name)) throw new Error(`profile.officialStackup.orderedLayers 包含重复层名 ${layer.name}`);
		allLayerNames.add(layer.name);
		if (layer.kind === 'copper') copperLayerNames.add(layer.name);
	}
	optionalMeasurement(stackup.finishedThicknessMm, 'profile.officialStackup.finishedThicknessMm', 'mm');
	optionalNonnegative(stackup.finishedTolerancePercent, 'profile.officialStackup.finishedTolerancePercent', '%');
	if (stackup.orderedLayers.filter((layer: ManufacturingProfileLayer) => layer.kind === 'copper').length !== selection.copperLayers)
		throw new Error('profile.selection.copperLayers 必须与 officialStackup 中显式铜层数量一致');
	if (profile.calculations !== undefined && !Array.isArray(profile.calculations)) throw new Error('profile.calculations 必须是数组');
	const calculationIds = new Set<string>();
	const seenBindingKeys = new Set<string>();
	const signalToEdaLayer = new Map<string, number>();
	const edaLayerToSignal = new Map<number, string>();
	const rawCalculations = profile.calculations === undefined ? [] : profile.calculations as unknown[];
	for (const [index, rawCalculation] of rawCalculations.entries()) {
		const calculation = validateCalculation(rawCalculation, `profile.calculations[${index}]`, stackupId, copperLayerNames);
		if (calculationIds.has(calculation.id)) throw new Error(`重复计算 id ${calculation.id}`);
		calculationIds.add(calculation.id);
		for (const [bindingIndex, rawBinding] of (calculation.bindings ?? []).entries()) {
			const label = `profile.calculations[${index}].bindings[${bindingIndex}]`;
			const binding = object(rawBinding, label);
			exactKeys(binding, bindingFieldKeys, label);
			requiredString(binding.net, `${label}.net`);
			if (typeof binding.edaLayerId !== 'number' || !Number.isFinite(binding.edaLayerId) || !Number.isInteger(binding.edaLayerId) || binding.edaLayerId <= 0)
				throw new Error(`${label}.edaLayerId 必须是有限正整数`);
			requiredString(binding.layerMappingSource, `${label}.layerMappingSource`);
			const key = `${binding.net}\u0000${binding.edaLayerId}`;
			if (seenBindingKeys.has(key)) throw new Error(`重复 net/layer binding ${String(binding.net)} / ${String(binding.edaLayerId)}`);
			seenBindingKeys.add(key);
			const mappedEdaLayer = signalToEdaLayer.get(calculation.signalLayer);
			if (mappedEdaLayer !== undefined && mappedEdaLayer !== binding.edaLayerId) throw new Error(`制造层 ${calculation.signalLayer} 映射到多个 EDA 层`);
			const mappedSignalLayer = edaLayerToSignal.get(binding.edaLayerId);
			if (mappedSignalLayer !== undefined && mappedSignalLayer !== calculation.signalLayer) throw new Error(`EDA 层 ${binding.edaLayerId} 映射到多个制造层`);
			signalToEdaLayer.set(calculation.signalLayer, binding.edaLayerId);
			edaLayerToSignal.set(binding.edaLayerId, calculation.signalLayer);
		}
	}
	return value as ManufacturingProfile;
}
export function validateManufacturingProfile(value: unknown): ManufacturingProfile { return validateProfile(value); }

export function validateOrderConfirmation(value: unknown): OrderConfirmation {
	const order = object(value, 'orderConfirmation');
	exactKeys(order, orderKeys, 'orderConfirmation');
	if (order.schemaVersion !== 1) throw new Error('orderConfirmation.schemaVersion 必须为 1');
	if (order.confirmed !== true) throw new Error('orderConfirmation.confirmed 必须明确为 true');
	validSource(order.source, 'orderConfirmation.source');
	requiredString(order.manufacturer, 'orderConfirmation.manufacturer');
	requiredString(order.productType, 'orderConfirmation.productType');
	requiredString(order.stackupId, 'orderConfirmation.stackupId');
	validateSelection(order.selection, 'orderConfirmation.selection');
	if (order.impedanceService !== undefined && order.impedanceService !== null) {
		const service = object(order.impedanceService, 'orderConfirmation.impedanceService');
		exactKeys(service, orderServiceKeys, 'orderConfirmation.impedanceService');
		validSource(service.source, 'orderConfirmation.impedanceService.source');
		if (!Array.isArray(service.calculations)) throw new Error('orderConfirmation.impedanceService.calculations 必须是数组');
		const ids = new Set<string>();
		for (const [index, rawCalculation] of service.calculations.entries()) {
			const label = `orderConfirmation.impedanceService.calculations[${index}]`;
			const calculation = object(rawCalculation, label);
			exactKeys(calculation, orderCalculationKeys, label);
			requiredString(calculation.id, `${label}.id`);
			if (ids.has(calculation.id as string)) throw new Error(`订单阻抗服务包含重复计算 id ${calculation.id}`);
			ids.add(calculation.id as string);
			finitePositive(calculation.targetOhm, `${label}.targetOhm`);
			if (typeof calculation.model !== 'string' || !calculationModels.has(calculation.model as ManufacturingCalculationModel)) throw new Error(`${label}.model 不受支持`);
			requiredString(calculation.signalLayer, `${label}.signalLayer`);
			for (const field of ['topReference', 'bottomReference'] as const)
				if (calculation[field] !== undefined && calculation[field] !== null) requiredString(calculation[field], `${label}.${field}`);
			if (calculation.topReference !== undefined && calculation.bottomReference !== undefined && calculation.topReference !== null && calculation.bottomReference !== null && calculation.topReference === calculation.bottomReference)
				throw new Error(`${label}.topReference 和 bottomReference 不能指向同一层`);
			if (calculation.topReference === calculation.signalLayer || calculation.bottomReference === calculation.signalLayer)
				throw new Error(`${label} 参考层不能与 signalLayer 相同`);
			if (calculation.topReference === null && calculation.bottomReference === null)
				throw new Error(`${label} 不能同时声明无上下参考层`);
			for (const field of ['widthMil', 'spacingMil', 'copperGapMil'] as const) optionalMeasurement(calculation[field], `${label}.${field}`, 'mil');
			validateModelDimensions(calculation, label);
			if (calculation.widthSpacingComplement !== undefined && typeof calculation.widthSpacingComplement !== 'boolean') throw new Error(`${label}.widthSpacingComplement 必须是 boolean`);
		}
	}
	return value as OrderConfirmation;
}

function sameNumber(a: number, b: number): boolean {
	return Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8;
}
function statusForEqual(a: unknown, b: unknown): ProfileComparisonStatus {
	if (a === undefined || b === undefined || a === 'unknown' || b === 'unknown') return 'unknown';
	return Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && sameNumber(a, b)) ? 'matched' : 'mismatch';
}
function addItem(items: ManufacturingComparisonItem[], item: ManufacturingComparisonItem): void { items.push(item); }
function profileItem(id: string, status: ProfileComparisonStatus, profileValue: unknown, currentValue: unknown, unit: ManufacturingComparisonItem['unit'], reason: string, sources: string[]): ManufacturingComparisonItem {
	return { id, status, profileValue, currentValue, unit, reason, sources };
}

export function compareManufacturingProfile(input: CompareManufacturingProfileInput): ManufacturingProfileReport {
	if (!input || typeof input !== 'object') throw new Error('compareManufacturingProfile 输入必须是对象');
	const profile = validateProfile(input.profile);
	if (!input.routing || typeof input.routing !== 'object' || !Array.isArray(input.routing.nets) || !input.routing.defaultRule || (input.routing.globalStatus !== 'known' && input.routing.globalStatus !== 'unknown'))
		throw new Error('routing 必须是 RoutingWidthSnapshot');
	if (!Array.isArray(input.enabledCopperLayers)) throw new Error('enabledCopperLayers 必须是数组');
	const enabledLayerIds = new Set<number>();
	for (const [index, layer] of input.enabledCopperLayers.entries()) {
		if (!layer || typeof layer.layerId !== 'number' || !Number.isFinite(layer.layerId) || !Number.isInteger(layer.layerId) || layer.layerId <= 0)
			throw new Error(`enabledCopperLayers[${index}].layerId 必须是有限正整数`);
		if (enabledLayerIds.has(layer.layerId)) throw new Error(`重复启用铜层 ID ${layer.layerId}`);
		enabledLayerIds.add(layer.layerId);
		if (layer.name !== undefined) requiredString(layer.name, `enabledCopperLayers[${index}].name`);
	}
	const order = input.orderConfirmation === undefined ? undefined : validateOrderConfirmation(input.orderConfirmation);
	const items: ManufacturingComparisonItem[] = [];
	const profileSource = `${profile.source.url} @ ${profile.source.observedAt} (调用方提供)`;
	const orderSource = order ? `${order.source.url} @ ${order.source.observedAt} (调用方提供的确认记录)` : undefined;
	const copperLayerCount = profile.officialStackup.orderedLayers.filter(layer => layer.kind === 'copper').length;
	addItem(items, profileItem('profile.selection.copperLayers-vs-stackup', statusForEqual(profile.selection.copperLayers, copperLayerCount), profile.selection.copperLayers, copperLayerCount, 'layer', '选择铜层数与逐层结构中的铜层数量比较；芯板和铜箔组说明不作为额外物理层。', [profileSource]));
	addItem(items, profileItem('profile.selection.copperLayers-vs-eda', statusForEqual(profile.selection.copperLayers, input.enabledCopperLayers.length), profile.selection.copperLayers, input.enabledCopperLayers.length, 'layer', '只与命令提供的明确启用 SIGNAL/PLANE 铜层计数比较，不从默认规则推导。', [profileSource, '当前 EDA getAllLayers 明确启用列表']));
	addItem(items, profileItem('profile.selection.nominalThicknessMm', 'unknown', profile.selection.nominalThicknessMm, undefined, 'mm', '名义板厚与成品板厚分开记录；不与 EDA 逐层原始厚度换算值直接比较。', [profileSource, '当前 EDA 物理层缺少逐层板厂映射']));
	addItem(items, profileItem('order.selection.copperLayers', order ? statusForEqual(profile.selection.copperLayers, order.selection.copperLayers) : 'unknown', profile.selection.copperLayers, order?.selection.copperLayers, 'layer', order ? '与调用方提供的订单确认记录比较。' : '缺少订单确认记录。', [profileSource, ...(orderSource ? [orderSource] : [])]));
	addItem(items, profileItem('order.selection.nominalThicknessMm', order ? statusForEqual(profile.selection.nominalThicknessMm, order.selection.nominalThicknessMm) : 'unknown', profile.selection.nominalThicknessMm, order?.selection.nominalThicknessMm, 'mm', order ? '仅与订单名义厚度比较，不与叠层页的成品厚度混用。' : '缺少订单确认记录。', [profileSource, ...(orderSource ? [orderSource] : [])]));
	addItem(items, profileItem('profile.selection.outerCopperOz', order ? statusForEqual(profile.selection.outerCopperOz, order.selection.outerCopperOz) : 'unknown', profile.selection.outerCopperOz, order?.selection.outerCopperOz, 'oz', order ? '与调用方提供的订单确认记录比较；不是插件在线订单读回。' : '缺少独立订单确认记录。', [profileSource, ...(orderSource ? [orderSource] : [])]));
	const innerCopperStatus: ProfileComparisonStatus = !order ? 'unknown' : profile.selection.copperLayers <= 2 && order.selection.copperLayers <= 2 ? 'not-applicable' : profile.selection.copperLayers <= 2 || order.selection.copperLayers <= 2 ? 'unknown' : statusForEqual(profile.selection.innerCopperOz, order.selection.innerCopperOz);
	addItem(items, profileItem('profile.selection.innerCopperOz', innerCopperStatus, profile.selection.innerCopperOz, order?.selection.innerCopperOz, 'oz', innerCopperStatus === 'not-applicable' ? '两侧订单/设计均不超过2层，不适用内层铜厚。' : innerCopperStatus === 'unknown' && order && (profile.selection.copperLayers <= 2 || order.selection.copperLayers <= 2) ? '两侧铜层数不一致；内层铜厚不作对照。' : !order ? '缺少独立订单确认记录。' : '与调用方提供的订单确认记录比较；不是插件在线订单读回。', [profileSource, ...(orderSource ? [orderSource] : [])]));
	for (const [id, profileValue, orderValue, unit] of [
		['manufacturer', profile.manufacturer, order?.manufacturer, 'text'],
		['productType', profile.productType, order?.productType, 'text'],
		['stackupId', profile.stackupId, order?.stackupId, 'text'],
	] as Array<[string, string, string | undefined, ManufacturingComparisonItem['unit']]>) {
		addItem(items, profileItem(`order.${id}`, order ? statusForEqual(profileValue, orderValue) : 'unknown', profileValue, orderValue, unit, order ? '与调用方提供的订单确认记录比较，不代表插件从订单网站独立读取。' : '缺少订单确认记录。', [profileSource, ...(orderSource ? [orderSource] : [])]));
	}
	const finished = profile.officialStackup.finishedThicknessMm;
	addItem(items, profileItem('profile.officialStackup.finishedThicknessMm', 'unknown', finished ?? 'unknown', undefined, 'mm', '成品厚度按板厂叠层来源单独记录，不与名义厚度或 EDA 逐层换算值互相替代。', [profileSource, '当前 EDA 物理层缺少逐层板厂映射']));
	if (profile.officialStackup.finishedTolerancePercent === undefined || profile.officialStackup.finishedTolerancePercent === 'unknown')
		addItem(items, profileItem('profile.officialStackup.finishedTolerancePercent', 'unknown', profile.officialStackup.finishedTolerancePercent ?? 'unknown', undefined, 'text', '成品厚度容差未提供。', [profileSource]));
	else addItem(items, profileItem('profile.officialStackup.finishedTolerancePercent', 'unknown', profile.officialStackup.finishedTolerancePercent, undefined, 'text', '记录板厂明示容差，不把它解释为阻抗保证；没有独立订单目标可比较。', [profileSource]));
	for (const [index, layer] of profile.officialStackup.orderedLayers.entries()) {
		addItem(items, profileItem(`profile.officialStackup.orderedLayers[${index}].thicknessMm`, 'unknown', layer.thicknessMm, undefined, 'mm', layer.thicknessMm === 'unknown' ? '该层厚度未知；不进行补值或Dk推算。' : '仅记录来源叠层中的该层厚度，未从当前 EDA 推断对应物理层。', [profileSource]));
		if (layer.dk === undefined || layer.dk === 'unknown') addItem(items, profileItem(`profile.officialStackup.orderedLayers[${index}].dk`, 'unknown', layer.dk ?? 'unknown', undefined, undefined, '材料 Dk 未提供，不据此推算；这不阻止其他已知参数的比较。', [profileSource]));
		else addItem(items, profileItem(`profile.officialStackup.orderedLayers[${index}].dk`, 'unknown', layer.dk, undefined, undefined, '仅记录板厂来源 Dk；没有独立参数可比较。', [profileSource]));
	}
	const rawPhysicalLayerRecords = input.rawPhysicalLayerRecords ?? [];
	addItem(items, profileItem('eda.physicalLayerOrderAndUnits', 'unknown', undefined, input.physicalLayerEvidence ?? rawPhysicalLayerRecords, undefined, '保留原始源码；厚度单位证据仅适用于已观察的 EDA 4.1.78，且缺少逐层板厂映射，不能确认实际对应关系或完成叠层比较。', ['当前 EDA 原始源码', ...(input.physicalLayerEvidence ? [input.physicalLayerEvidence.unitEvidence] : [])]));
	for (const record of rawPhysicalLayerRecords) {
		addItem(items, profileItem(`eda.rawPhysicalLayerRecords.${String(record.header?.id ?? 'unknown')}`, 'unknown', undefined, { header: record.header, data: record.data }, undefined, '保留原始 LAYER_PHYS 记录；原始记录可能包含历史或墓碑，逐层板厂映射和实际叠层对应关系仍未确认。', ['当前 EDA 原始源码']));
	}
	if (!order) addItem(items, profileItem('order.impedanceService', 'unknown', undefined, undefined, undefined, '缺少独立订单确认记录。', []));
	else if (order.impedanceService === null) addItem(items, profileItem('order.impedanceService', (profile.calculations?.length ?? 0) > 0 ? 'mismatch' : 'not-applicable', null, null, undefined, (profile.calculations?.length ?? 0) > 0 ? 'profile 含阻抗计算，但订单确认记录明确表示未开通阻抗服务。' : '订单确认记录明确表示未开通阻抗服务，且 profile 没有阻抗计算。', [orderSource!]));
	else if (order.impedanceService === undefined) addItem(items, profileItem('order.impedanceService', 'unknown', undefined, undefined, undefined, '订单确认记录未提供阻抗服务字段；明确 null 才表示未开通。', [orderSource!]));
	const calculations = profile.calculations ?? [];
	if (calculations.length === 0) addItem(items, profileItem('profile.calculations', 'unknown', [], undefined, undefined, '没有计算记录；不生成默认阻抗模型或线宽。', [profileSource]));
	for (const calculation of calculations) {
		const base = `calculation.${calculation.id}`;
		const calculationSource = `${calculation.source.url} @ ${calculation.source.observedAt} (调用方提供的计算证据)`;
		const verifiedStatus: ProfileComparisonStatus = calculation.evidenceStatus === 'verified' ? 'matched' : 'unknown';
		addItem(items, profileItem(`${base}.evidenceStatus`, verifiedStatus, calculation.evidenceStatus, calculation.evidenceStatus === 'verified' ? '调用方标记为已验证' : '调用方标记为未验证', undefined, calculation.evidenceStatus === 'verified' ? 'verified 仅表示调用方提供了可见计算证据，插件未独立认证。' : '计算证据未验证，数值不能提升为已确认结果。', [calculationSource]));
		addItem(items, profileItem(`${base}.widthSpacingComplement`, 'unknown', calculation.widthSpacingComplement ?? 'unknown', undefined, 'boolean', calculation.widthSpacingComplement === undefined ? '补偿选项未提供，状态未知。' : '仅记录调用方提供的计算器补偿选项，未与独立读回值比较。', [calculationSource]));
		const isDifferential = calculation.model.startsWith('differential-');
		const isCoplanar = calculation.model.endsWith('-coplanar') && !calculation.model.endsWith('-non-coplanar');
		for (const field of ['spacingMil', 'copperGapMil'] as const) {
			const value = calculation[field];
			const applicable = field === 'spacingMil' ? isDifferential : isCoplanar;
			const status: ProfileComparisonStatus = !applicable ? 'not-applicable' : value === undefined || value === 'unknown' ? 'unknown' : 'unknown';
			addItem(items, profileItem(`${base}.${field}`, status, value ?? 'unknown', undefined, 'mil', !applicable ? field === 'spacingMil' ? '单端模型不使用差分线间距。' : '非共面模型不使用共面铜间距。' : value === undefined || value === 'unknown' ? '该模型适用此参数，但来源记录缺值。' : '仅记录来源计算值；当前 EDA 没有该字段读回。', [calculationSource]));
		}
		for (const field of ['topReference', 'bottomReference'] as const) {
			const value = calculation[field];
			addItem(items, profileItem(`${base}.${field}`, value === undefined ? 'unknown' : value === null ? 'not-applicable' : 'unknown', value === undefined ? 'unknown' : value, undefined, 'text', value === undefined ? '参考层未提供。' : value === null ? '计算证据明确无该侧参考层。' : '计算参考层已记录，但尚无已确认的 PCB 物理层映射。', [calculationSource]));
		}
		const width = calculation.widthMil;
		const bindings = calculation.bindings ?? [];
		if (bindings.length === 0) addItem(items, profileItem(`${base}.bindings`, 'unknown', [], undefined, undefined, '没有明确网络/EDA层映射，不猜测网络归属。', [calculationSource]));
		for (const binding of bindings) {
			const bindingLabel = `${base}.binding.${binding.net}.layer${binding.edaLayerId}`;
			const rule = input.routing.nets.find(netRule => netRule.net === binding.net);
			const layerRule = rule?.layers.find(item => item.layerId === binding.edaLayerId);
			const layerEnabled = enabledLayerIds.has(binding.edaLayerId);
			const ruleKnown = input.routing.globalStatus === 'known' && rule?.status === 'known' && layerRule?.status === 'known' && layerEnabled;
			const orderCalc = order?.impedanceService && order.impedanceService.calculations.find(item => item.id === calculation.id);
			const widthStatus: ProfileComparisonStatus = calculation.evidenceStatus !== 'verified' || width === undefined || width === 'unknown' || !ruleKnown ? 'unknown' : statusForEqual(width, layerRule!.preferredMil);
			addItem(items, profileItem(`${bindingLabel}.preferredWidth`, widthStatus, width ?? 'unknown', ruleKnown ? layerRule!.preferredMil : undefined, 'mil', !layerEnabled ? '映射层不在当前明确启用铜层列表中。' : !ruleKnown ? '该网络/层规则未知；不回退到默认规则。' : calculation.evidenceStatus !== 'verified' ? '计算记录未验证，不能形成已确认首选线宽结论。' : widthStatus === 'matched' ? '计算线宽与当前网络/层首选线宽一致。' : '计算线宽与当前网络/层首选线宽不同。', [calculationSource, binding.layerMappingSource, '当前 EDA 规则']));
			const boundsStatus: ProfileComparisonStatus = calculation.evidenceStatus !== 'verified' || width === undefined || width === 'unknown' || !ruleKnown ? 'unknown' : (width >= layerRule!.minMil || sameNumber(width, layerRule!.minMil)) && (width <= layerRule!.maxMil || sameNumber(width, layerRule!.maxMil)) ? 'matched' : 'mismatch';
			addItem(items, profileItem(`${bindingLabel}.withinMinMax`, boundsStatus, width ?? 'unknown', ruleKnown ? { minMil: layerRule!.minMil, maxMil: layerRule!.maxMil } : undefined, 'mil', !ruleKnown ? '该网络/层 min/max 规则未知；不回退到默认规则。' : calculation.evidenceStatus !== 'verified' ? '计算记录未验证，min/max合规性仍未知。' : boundsStatus === 'matched' ? '计算线宽位于当前规则 min/max 范围内；这不代表与 preferred 相同。' : '计算线宽超出当前规则 min/max 范围。', [calculationSource, binding.layerMappingSource, '当前 EDA 规则']));
			if (order) {
				const orderStatus: ProfileComparisonStatus = order.impedanceService === undefined ? 'unknown' : order.impedanceService === null ? 'mismatch' : orderCalc ? 'matched' : 'mismatch';
				addItem(items, profileItem(`${bindingLabel}.orderImpedanceService`, orderStatus, calculation.id, orderCalc?.id ?? (order.impedanceService === null ? null : undefined), undefined, order.impedanceService === undefined ? '订单确认记录未提供阻抗服务字段。' : order.impedanceService === null ? 'profile 含阻抗计算，但订单确认记录明确未包含阻抗服务。' : orderCalc ? '订单确认记录含同ID阻抗计算；逐字段值另行比较。' : '订单阻抗服务未包含该计算ID。', [calculationSource, ...(orderSource ? [orderSource] : [])]));
			}
		}
		if (order?.impedanceService) {
			const orderCalc = order.impedanceService.calculations.find(item => item.id === calculation.id);
			if (!orderCalc) addItem(items, profileItem(`${base}.orderCalculation`, 'mismatch', calculation.id, undefined, undefined, '订单阻抗服务缺少对应计算记录。', [calculationSource, `${order.impedanceService.source.url} @ ${order.impedanceService.source.observedAt} (调用方提供)`]));
			else {
				for (const field of ['targetOhm', 'model', 'signalLayer', 'topReference', 'bottomReference', 'widthMil', 'spacingMil', 'copperGapMil', 'widthSpacingComplement'] as const) {
					const profileValue = calculation[field];
					const orderValue = orderCalc[field];
					const dimensionNotApplicable = (field === 'spacingMil' && !calculation.model.startsWith('differential-')) || (field === 'copperGapMil' && !(calculation.model.endsWith('-coplanar') && !calculation.model.endsWith('-non-coplanar')));
					const status: ProfileComparisonStatus = dimensionNotApplicable ? 'not-applicable' : profileValue === undefined || profileValue === 'unknown' || orderValue === undefined || orderValue === 'unknown'
						? 'unknown'
						: field.endsWith('Mil') || field === 'targetOhm'
							? statusForEqual(profileValue, orderValue)
							: profileValue === orderValue ? 'matched' : 'mismatch';
					const unit = field === 'targetOhm' ? 'ohm' : field.endsWith('Mil') ? 'mil' : field === 'widthSpacingComplement' ? 'boolean' : 'text';
					const reportValue = (value: unknown) => value === undefined ? 'unknown' : value;
					const reason = status === 'unknown' ? 'profile或订单记录缺少该字段。' : status === 'not-applicable' ? '该阻抗模型不适用此字段。' : status === 'matched' ? '与调用方提供的订单阻抗服务记录一致。' : '与调用方提供的订单阻抗服务记录不同。';
					addItem(items, profileItem(`${base}.order.${field}`, status, reportValue(profileValue), reportValue(orderValue), unit, reason, [calculationSource, `${order.impedanceService.source.url} @ ${order.impedanceService.source.observedAt} (调用方提供)`]));
				}
			}
		}
	}
	if (order?.impedanceService) {
		const profileCalculationIds = new Set(calculations.map(calculation => calculation.id));
		const impedanceSource = `${order.impedanceService.source.url} @ ${order.impedanceService.source.observedAt} (调用方提供)`;
		for (const orderCalculation of order.impedanceService.calculations) {
			if (profileCalculationIds.has(orderCalculation.id)) continue;
			addItem(items, profileItem(`order.calculation.${orderCalculation.id}`, 'mismatch', undefined, orderCalculation.id, undefined, '订单阻抗服务包含 profile 未声明的计算ID。', [profileSource, impedanceSource]));
		}
	}
	const mismatch = items.some(item => item.status === 'mismatch');
	const incomplete = items.some(item => item.status === 'unknown') || !order || calculations.some(calculation => calculation.evidenceStatus !== 'verified' || !calculation.bindings?.length);
	return {
		overall: mismatch ? 'mismatch' : incomplete ? 'incomplete' : 'matched-within-scope',
		items,
		message: `仅比较了带来源的声明、明确网络/层映射及调用方提供的规则/订单记录；这不是插件独立认证或在线订单读回。${incomplete ? '仍有未知项。' : mismatch ? '发现不一致项。' : '本范围内各项一致。'}`,
	};
}
