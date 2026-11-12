/** Sequential PCB composition using a narrow, typed host adapter.
 *
 * This is the PCB write core only. Source extraction, schematic placement/net mapping,
 * transform preparation, save/reopen and end-user orchestration remain outside this module.
 */
export type JsonObject = Record<string, unknown>;
export type NetMap = Array<{ sourceNet: string; targetNet: string }>;
export type PadNet = { number: string; sourceNet: string; targetNet: string; padLength?: number | null };
export type PreparedPadPoseGeometry = {
	number: string; layer: string | number; x: number; y: number; rotation: number; shape: unknown; hole: unknown; specialPad: unknown;
	holeOffsetX: number | null; holeOffsetY: number | null; holeRotation: number | null;
};
export type PreparedComponent = {
	sourceUid: string;
	targetUid: string;
	designator: string;
	component: { libraryUuid: string; uuid: string };
	layer: number;
	x: number;
	y: number;
	rotation: number;
	primitiveLock: boolean;
	pads: PadNet[];
	expectedPosePadGeometry: PreparedPadPoseGeometry[];
	/** Explicit empty strings are meaningful and must survive the merge. */
	otherProperty: Record<string, unknown>;
};
export type PreparedLine = { sourceId: string; net: string; points: Array<[number, number]>; layer: 'top' | 'bottom'; width: number; sourceData: JsonObject };
export type PreparedVia = { sourceId: string; params: { net: string; x: number; y: number; holeDiameter: number; diameter: number; viaType?: number; blindRuleName?: string; solderMaskExpansion?: unknown; primitiveLock?: boolean }; sourceData: JsonObject };
export type PreparedArc = { sourceId: string; params: { net: string; layer: number; startX: number; startY: number; endX: number; endY: number; arcAngle: number; lineWidth: number; interactiveMode: number; primitiveLock: boolean }; sourceData: JsonObject };
export type PreparedStandalonePad = { sourceId: string; params: { layer: number; padNumber: string; x: number; y: number; rotation: number; pad: unknown; net: string; hole: unknown; holeOffsetX: number | null; holeOffsetY: number | null; holeRotation: number | null; metallization: unknown; padType: unknown; specialPad: unknown; maskExpansion: unknown; heatWelding: unknown; primitiveLock: boolean }; sourceData: JsonObject };
export type PreparedBlindRule = { name: string; startLayer: number; endLayer: number; viaSizeRule: string; sourceData: JsonObject; viaSizeData: JsonObject; typedViaSizeConfig: JsonObject };
export type PreparedString = { sourceId: string; params: { x: number; y: number; text: string; layer: 'top-silk' | 'bottom-silk'; fontSize: number; lineWidth: number; rotation: number; mirror: boolean; fontFamily?: string; alignMode?: string; reverse?: boolean; expansion?: number }; sourceData: JsonObject };
export type PreparedAttribute = { sourceId: string; parentUid: string; key: string; value: unknown; display: JsonObject };
export type PcbCompositionInput = {
	operationId: string;
	projectUuid: string;
	targetPcbUuid: string;
	components: PreparedComponent[];
	lines: PreparedLine[];
	vias: PreparedVia[];
	strings: PreparedString[];
	attributes: PreparedAttribute[];
	arcs?: PreparedArc[];
	standalonePads?: PreparedStandalonePad[];
	requiredBlindRules?: PreparedBlindRule[];
	sourceTypedRecords?: Array<{ type: 'ARC' | 'PAD'; id: string; state: JsonObject }>;
};
export type NativeRecord = { type: string; id: string; data: unknown; header?: JsonObject };
export type CompositionSnapshot = { projectUuid: string; pcbUuid: string; records: NativeRecord[] };
export type LineCoverage = { sourceId: string; targetIds: string[] };
export type CompositionOperation = {
	operationId: string;
	projectUuid: string;
	targetPcbUuid: string;
	status: 'running' | 'confirmed' | 'unknown' | 'not_started';
	phase: string;
	inputFingerprint: string;
	writeAttempted: boolean;
	createdComponents: Array<{ sourceUid: string; targetUid: string; componentId: string; padIds: Record<string, string>; attributeIds: string[]; transientGeneratedAttributeIds: string[]; transientGeneratedAttributeData: Array<{ id: string; data: JsonObject }> }>;
	transientAttributeIdsDisappeared?: string[];
	createdLines: Array<{ sourceId: string; returnedIds: string[] }>;
	lineCoverage: LineCoverage[];
	lineFieldDifferences?: Array<{ sourceId: string; targetId: string; fields: string[] }>;
	preservationTicketChanges?: Array<{ type: string; id: string; before: number | undefined; after: number | undefined }>;
	blindTypedConfigNormalizationDifferences?: TypedConfigNumericDifference[];
	createdVias: Array<{ sourceId: string; targetId: string }>;
	createdArcs?: Array<{ sourceId: string; targetId: string }>;
	createdStandalonePads?: Array<{ sourceId: string; targetId: string; typedMaskExpansion?: unknown }>;
	nativeNumericDifferences?: Array<{ type: 'VIA' | 'ARC' | 'PAD'; sourceId: string; targetId: string; field: string; expected: number; actual: number; delta: number; tolerance: number }>;
	typedArcEndpointQuantization?: Array<{ type: 'ARC'; sourceId: string; targetId: string; field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }>;
	typedPadGeometryQuantization?: Array<{ type: 'PAD'; sourceId: string; targetId: string; field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }>;
	typedViaSizeQuantization?: Array<{ type: 'VIA'; sourceId: string; targetId: string; field: 'holeDiameter' | 'diameter'; fullExpected: number; quantizedExpected: number; actual: number; formula: string }>;
	addedBlindRules?: string[];
	addedViaSizeRules?: string[];
	createdStrings: Array<{ sourceId: string; targetId: string }>;
	updatedAttributes: Array<{ sourceId: string; targetId: string; parentId: string; key: string }>;
	observedAddedRecords?: Array<{ type: string; id: string }>;
	error?: string;
};

/** Adapter boundary: methods are deliberately small so the caller can bind the known SDK calls
 * and read methods without passing executable code or relying on inferred SDK overloads here.
 */
export type PcbCompositionHost = {
	readSnapshot: (projectUuid: string, pcbUuid: string) => Promise<CompositionSnapshot>;
	createComponent: (input: PreparedComponent) => Promise<{ id: string }>;
	readComponent: (id: string) => Promise<{ id: string; uniqueId: string; designator: string; layer: number; x: number; y: number; rotation: number; primitiveLock: boolean; otherProperty: Record<string, unknown> }>;
	readPads: (componentId: string) => Promise<Array<{ id: string; number: string; net: string } & PreparedPadPoseGeometry>>;
	setPadNet: (padId: string, net: string) => Promise<void>;
	setPadLengths: (items: Array<{ componentId: string; padNumber: string; padLength: number | null }>) => Promise<void>;
	setComponentOtherProperty: (componentId: string, otherProperty: Record<string, unknown>) => Promise<void>;
	routeTrack: (input: Omit<PreparedLine, 'sourceId' | 'sourceData'>) => Promise<{ segmentIds: string[] }>;
	verifyLineCoverage: (lines: PreparedLine[], before: CompositionSnapshot, after: CompositionSnapshot) => Promise<LineCoverage[]>;
	restoreLineFields: (lines: PreparedLine[], coverage: LineCoverage[], before?: CompositionSnapshot) => Promise<void>;
	placeVia: (input: PreparedVia) => Promise<{ id: string; typedSizeQuantization?: Array<{ field: 'holeDiameter' | 'diameter'; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> }>;
	placeArc?: (input: PreparedArc) => Promise<{ id: string; typedEndpointQuantization?: Array<{ field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> }>;
	placeStandalonePad?: (input: PreparedStandalonePad) => Promise<{ id: string; typedMaskExpansion?: unknown; typedGeometryQuantization?: Array<{ field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> }>;
	preflightBlindRules?: (rules: PreparedBlindRule[], before: CompositionSnapshot) => Promise<string[]>;
	ensureBlindRules?: (rules: PreparedBlindRule[], before: CompositionSnapshot) => Promise<{ addedRules: string[]; addedViaSizeRules: string[]; typedConfigNormalizationDifferences: TypedConfigNumericDifference[] }>;
	placeString: (input: PreparedString) => Promise<{ id: string }>;
	modifyAttribute: (targetId: string, key: string, patch: { value: unknown; display: JsonObject }) => Promise<void>;
	readAttribute: (targetId: string, key: string) => Promise<{ id: string; parentId: string; key: string; value: unknown; display: JsonObject }>;
	getOperation: (operationId: string) => Promise<unknown> | unknown;
	setOperation: (operationId: string, value: CompositionOperation) => Promise<void>;
};

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): value is JsonObject { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
/** Exact generated ATTR shape observed to be discarded by the host during native PCB normalization. */
export function isTransientGenerated3DModelTitleAttribute(value: unknown): boolean {
	return object(value) && value.key === '3D Model Title' && value.x === null && value.y === null
		&& value.keyVisible === false && value.valueVisible === false;
}
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
type TypedConfigNumericDifference = { path: string; before: number; after: number; delta: number; tolerance: number; nativeRuleId?: string; nativeHoleClearance?: number; nativeExpectedMillimeters?: number };
type NativeDefaultHoleSpacing = { path: string; ruleId: string; holeClearance: number };
function compareOfficialTypedConfigReadback(before: unknown, after: unknown, path = '$', differences: TypedConfigNumericDifference[] = [], nativeSpacing?: NativeDefaultHoleSpacing): void {
	if (typeof before === 'number' || typeof after === 'number') {
		if (typeof before !== 'number' || typeof after !== 'number' || !Number.isFinite(before) || !Number.isFinite(after)) fail(`官方 DRC typed config 类型/数值变化：${path}`);
		if (before !== after) {
			const delta = Math.abs(before - after), tolerance = Number.EPSILON * Math.max(1, Math.abs(before), Math.abs(after));
			const expectedNativeMm = nativeSpacing ? nativeSpacing.holeClearance * 0.0254 : undefined;
			const nativeTolerance = expectedNativeMm === undefined ? undefined : Number.EPSILON * Math.max(1, Math.abs(after), Math.abs(expectedNativeMm));
			const isNativeHoleSpacingNormalization = Boolean(nativeSpacing && path === nativeSpacing.path && delta <= 1e-6
				&& expectedNativeMm !== undefined && nativeTolerance !== undefined && Math.abs(after - expectedNativeMm) <= nativeTolerance);
			if (delta > tolerance && !isNativeHoleSpacingNormalization) fail(`官方 DRC typed config 变化超出机器精度：${path}`);
			differences.push({ path, before, after, delta, tolerance: isNativeHoleSpacingNormalization ? 1e-6 : tolerance,
				...(isNativeHoleSpacingNormalization && nativeSpacing ? { nativeRuleId: nativeSpacing.ruleId, nativeHoleClearance: nativeSpacing.holeClearance, nativeExpectedMillimeters: expectedNativeMm } : {}) });
		}
		return;
	}
	if (Array.isArray(before) || Array.isArray(after)) {
		if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) fail(`官方 DRC typed config 数组结构变化：${path}`);
		for (let index = 0; index < before.length; index++) compareOfficialTypedConfigReadback(before[index], after[index], `${path}[${index}]`, differences, nativeSpacing);
		return;
	}
	if (object(before) || object(after)) {
		if (!object(before) || !object(after)) fail(`官方 DRC typed config 对象结构变化：${path}`);
		const beforeKeys = Object.keys(before).sort(), afterKeys = Object.keys(after).sort();
		if (stable(beforeKeys) !== stable(afterKeys)) fail(`官方 DRC typed config 字段变化：${path}`);
		for (const key of beforeKeys) compareOfficialTypedConfigReadback(before[key], after[key], `${path}.${key}`, differences, nativeSpacing);
		return;
	}
	if (typeof before !== typeof after || before !== after) fail(`官方 DRC typed config 非数值变化：${path}`);
}
const PAD_GEOMETRY_TOLERANCE = 1e-4;
function closeNumber(actual: unknown, expected: unknown, angle = false, tolerance = PAD_GEOMETRY_TOLERANCE): boolean {
	if (typeof actual !== 'number' || typeof expected !== 'number' || !Number.isFinite(actual) || !Number.isFinite(expected)) return actual === expected;
	if (!angle) return Math.abs(actual - expected) <= tolerance;
	const delta = ((actual - expected) % 360 + 540) % 360 - 180;
	return Math.abs(delta) <= tolerance;
}
function geometryValueMatches(actual: unknown, expected: unknown): boolean {
	if (typeof expected === 'number') return closeNumber(actual, expected);
	if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => geometryValueMatches(actual[index], value));
	if (object(expected)) return object(actual) && Object.keys(expected).length === Object.keys(actual).length
		&& Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && geometryValueMatches(actual[key], value));
	return actual === expected;
}
function padGeometryMatches(actual: PreparedPadPoseGeometry, expected: PreparedPadPoseGeometry): boolean {
	return actual.number === expected.number && actual.layer === expected.layer
		&& closeNumber(actual.x, expected.x) && closeNumber(actual.y, expected.y) && closeNumber(actual.rotation, expected.rotation, true)
		&& geometryValueMatches(actual.shape, expected.shape) && geometryValueMatches(actual.hole, expected.hole)
		&& geometryValueMatches(actual.specialPad, expected.specialPad)
		&& closeNumber(actual.holeOffsetX, expected.holeOffsetX) && closeNumber(actual.holeOffsetY, expected.holeOffsetY)
		&& closeNumber(actual.holeRotation, expected.holeRotation, true);
}
function headerWithoutTicket(header: JsonObject | undefined): string {
	if (!header) return '';
	const copy: JsonObject = {};
	for (const [key, value] of Object.entries(header)) if (key !== 'ticket') copy[key] = value;
	return stable(copy);
}
function recordMap(snapshot: CompositionSnapshot): Map<string, NativeRecord> {
	const map = new Map<string, NativeRecord>();
	for (const record of snapshot.records) {
		const key = `${record.type}\0${record.id}`;
		if (map.has(key)) fail(`PCB 快照记录重复：${record.type}/${record.id}`);
		map.set(key, record);
	}
	return map;
}
function requireText(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须是非空字符串`);
	return value;
}
export function validatePcbCompositionInput(raw: unknown): PcbCompositionInput {
	if (!object(raw)) fail('PCB 组合输入必须是对象');
	const input = raw as unknown as PcbCompositionInput;
	input.arcs ??= []; input.standalonePads ??= []; input.requiredBlindRules ??= [];
	requireText(input.operationId, 'operationId'); requireText(input.projectUuid, 'projectUuid'); requireText(input.targetPcbUuid, 'targetPcbUuid');
	for (const key of ['components', 'lines', 'vias', 'strings', 'attributes', 'arcs', 'standalonePads', 'requiredBlindRules'] as const) if (!Array.isArray(input[key])) fail(`${key} 必须是数组`);
	const unique = (values: string[], label: string) => {
		if (values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) fail(`${label} 缺失或重复`);
	};
	unique(input.components.map(item => item?.targetUid), 'targetUid');
	unique(input.lines.map(item => item?.sourceId), 'LINE sourceId'); unique(input.vias.map(item => item?.sourceId), 'VIA sourceId');
	unique(input.strings.map(item => item?.sourceId), 'STRING sourceId'); unique(input.attributes.map(item => item?.sourceId), 'ATTR sourceId');
	unique(input.arcs.map(item => item?.sourceId), 'ARC sourceId'); unique(input.standalonePads.map(item => item?.sourceId), '独立 PAD sourceId');
	unique(input.requiredBlindRules.map(item => item?.name), 'BLIND rule name');
	for (const component of input.components) {
		if (!object(component.component) || !component.component.libraryUuid || !component.component.uuid
			|| !Number.isFinite(component.x) || !Number.isFinite(component.y) || !Number.isFinite(component.rotation)
			|| !Array.isArray(component.pads) || !object(component.otherProperty)) fail(`组件准备数据无效：${component.targetUid}`);
		unique(component.pads.map(pad => pad.number), `PAD ${component.targetUid} number`);
		if (component.pads.some(pad => typeof pad.sourceNet !== 'string' || typeof pad.targetNet !== 'string')) fail(`PAD 网络数据无效：${component.targetUid}`);
		if (!Array.isArray(component.expectedPosePadGeometry)) fail(`PAD 几何读回基准缺失：${component.targetUid}`);
		unique(component.expectedPosePadGeometry.map(pad => pad?.number), `PAD ${component.targetUid} geometry number`);
		if (component.expectedPosePadGeometry.length !== component.pads.length || component.expectedPosePadGeometry.some(pad =>
			!component.pads.some(expected => expected.number === pad.number) || !Number.isFinite(pad.x) || !Number.isFinite(pad.y) || !Number.isFinite(pad.rotation)
			|| !['string', 'number'].includes(typeof pad.layer) || pad.shape === undefined || pad.hole === undefined || pad.specialPad === undefined
			|| ![pad.holeOffsetX, pad.holeOffsetY, pad.holeRotation].every(value => value === null || Number.isFinite(value))))
			fail(`PAD 几何读回基准不完整：${component.targetUid}`);
	}
	for (const line of input.lines) if (!Array.isArray(line.points) || line.points.length < 2 || !line.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
		|| !Number.isFinite(line.width) || typeof line.net !== 'string' || !object(line.sourceData)) fail(`LINE 几何无效：${line.sourceId}`);
	for (const via of input.vias) if (!object(via.params) || !object(via.sourceData)) fail(`VIA 数据无效：${via.sourceId}`);
	for (const item of input.strings) if (!object(item.params) || !object(item.sourceData)) fail(`STRING 数据无效：${item.sourceId}`);
	for (const item of input.arcs) if (!object(item.params) || !object(item.sourceData)) fail(`ARC 数据无效：${item.sourceId}`);
	for (const item of input.standalonePads) if (!object(item.params) || !object(item.sourceData)) fail(`独立 PAD 数据无效：${item.sourceId}`);
	for (const item of input.requiredBlindRules) if (!requireText(item.name, 'BLIND rule name') || !Number.isFinite(item.startLayer)
		|| !Number.isFinite(item.endLayer) || !requireText(item.viaSizeRule, 'viaSize rule name') || !object(item.sourceData) || !object(item.viaSizeData)
		|| !object(item.typedViaSizeConfig)) fail(`BLIND rule 数据无效：${item.name}`);
	for (const attr of input.attributes) if (!requireText(attr.parentUid, 'ATTR parentUid') || !requireText(attr.key, 'ATTR key') || !object(attr.display)) fail(`ATTR 显示数据无效：${attr.sourceId}`);
	return input;
}

export class PcbCompositionError extends Error {
	constructor(message: string, readonly operation: CompositionOperation) { super(message); this.name = 'PcbCompositionError'; }
}

export function createPcbCompositionService(host: PcbCompositionHost) {
	async function getCompositionOperation(operationId: string): Promise<CompositionOperation | undefined> {
		const value = await host.getOperation(requireText(operationId, 'operationId'));
		let parsed: unknown = value;
		if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { fail('PCB 组合阶段记录不是有效 JSON'); } }
		return object(parsed) ? parsed as unknown as CompositionOperation : undefined;
	}
	async function composePcbInstance(raw: unknown): Promise<CompositionOperation> {
		const input = validatePcbCompositionInput(raw);
		const existing = await getCompositionOperation(input.operationId);
		if (existing) {
			if (existing.projectUuid !== input.projectUuid || existing.targetPcbUuid !== input.targetPcbUuid
				|| existing.inputFingerprint !== stable(input)) fail('operationId 已用于不同参数或 PCB 目标');
			if (existing.status === 'confirmed') return existing;
			fail(`operationId 已处于 ${existing.status}/${existing.phase}；需先查明现场，不重放写入`);
		}
		let operation: CompositionOperation = { operationId: input.operationId, projectUuid: input.projectUuid, targetPcbUuid: input.targetPcbUuid,
			status: 'running', phase: 'preflight', inputFingerprint: stable(input), writeAttempted: false,
			createdComponents: [], transientAttributeIdsDisappeared: [], createdLines: [], lineCoverage: [], createdVias: [], createdArcs: [], createdStandalonePads: [], addedBlindRules: [], createdStrings: [], updatedAttributes: [] };
		const persist = async (patch: Partial<CompositionOperation>) => {
			operation = { ...operation, ...patch };
			await host.setOperation(input.operationId, operation);
			const readback = await getCompositionOperation(input.operationId);
			if (!readback || stable(readback) !== stable(operation)) throw new Error(`组合阶段记录写后读回不一致：${operation.phase}`);
		};
		const stop = async (status: 'unknown' | 'not_started', phase: string, error: string): Promise<never> => {
			operation = { ...operation, status, phase, error };
			try {
				await host.setOperation(input.operationId, operation);
				const readback = await getCompositionOperation(input.operationId);
				if (!readback || stable(readback) !== stable(operation)) throw new Error('状态记录写后读回不一致');
			} catch (persistError) {
				const detail = persistError instanceof Error ? persistError.message : String(persistError);
				operation = { ...operation, error: `${error}；状态记录未能持久化：${detail}` };
				throw new PcbCompositionError(`${operation.error}；停止本 operationId 的后续写入`, operation);
			}
			throw new PcbCompositionError(`${error}；停止本 operationId 的后续写入`, operation);
		};
		let beforeSnapshot: CompositionSnapshot | undefined;
		try {
			await host.setOperation(input.operationId, operation);
			const started = await getCompositionOperation(input.operationId);
			if (!started || stable(started) !== stable(operation)) return await stop('not_started', 'persist_started', '组合起始记录未通过读回');
			const before = beforeSnapshot = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
			if (before.projectUuid !== input.projectUuid || before.pcbUuid !== input.targetPcbUuid) return await stop('not_started', 'target_context', '当前工程或 PCB 身份不符');
			const beforeMap = recordMap(before);
			if (input.arcs?.length && !host.placeArc) return await stop('not_started', 'arc_preflight', 'ARC 适配器不可用');
			if (input.standalonePads?.length && !host.placeStandalonePad) return await stop('not_started', 'pad_preflight', '独立 PAD 适配器不可用');
			const preflightBlindRules = host.preflightBlindRules;
			const ensureBlindRules = host.ensureBlindRules;
			if (input.requiredBlindRules?.length && (!preflightBlindRules || !ensureBlindRules)) return await stop('not_started', 'blind_rule_preflight', 'BLIND 规则适配器不可用');
			if ((input.requiredBlindRules ?? []).length) {
				const missing = await preflightBlindRules!(input.requiredBlindRules!, before);
				let ensuredBlindRules = { addedRules: [] as string[], addedViaSizeRules: [] as string[], typedConfigNormalizationDifferences: [] as TypedConfigNumericDifference[] };
				if (missing.length) {
					await persist({ phase: 'blind_rule_write', writeAttempted: true });
					ensuredBlindRules = await ensureBlindRules!(input.requiredBlindRules!, before);
				}
				await persist({ addedBlindRules: ensuredBlindRules.addedRules, addedViaSizeRules: ensuredBlindRules.addedViaSizeRules,
					blindTypedConfigNormalizationDifferences: ensuredBlindRules.typedConfigNormalizationDifferences, phase: 'blind_rules_confirmed' });
			}
			const verifyLinesAt = async (snapshot: CompositionSnapshot, checkFields: boolean) => {
				if (snapshot.projectUuid !== input.projectUuid || snapshot.pcbUuid !== input.targetPcbUuid) return await stop('unknown', 'line_readback_context', 'LINE 读回上下文发生变化');
				const coverage = await host.verifyLineCoverage(input.lines, before, snapshot);
				const bySource = new Map(coverage.map(item => [item.sourceId, item]));
				if (bySource.size !== input.lines.length || input.lines.some(line => !bySource.get(line.sourceId))
					|| coverage.some(item => !Array.isArray(item.targetIds) || !item.targetIds.length)) return await stop('unknown', 'line_geometry_coverage', 'LINE 几何覆盖读回不完整；可能存在合并或未覆盖');
				const map = recordMap(snapshot);
				if (coverage.some(item => item.targetIds.some(id => !map.has(`LINE\0${id}`)))) return await stop('unknown', 'line_target_ids', 'LINE 覆盖映射指向不存在的目标 ID');
				const addedLineIds = new Set(snapshot.records.filter(record => record.type === 'LINE' && !beforeMap.has(`LINE\0${record.id}`)).map(record => record.id));
				const coveredIds = new Set(coverage.flatMap(item => item.targetIds));
				if ([...addedLineIds].some(id => !coveredIds.has(id))) return await stop('unknown', 'line_added_id_accounting', '新增 LINE 未被请求几何覆盖');
				const differences: NonNullable<CompositionOperation['lineFieldDifferences']> = [];
				if (checkFields) for (const item of coverage) {
					const sourceLine = input.lines.find(line => line.sourceId === item.sourceId)!;
					for (const targetId of item.targetIds) {
						const target = map.get(`LINE\0${targetId}`);
						if (!target || !object(target.data)) return await stop('unknown', 'line_field_readback', `LINE/${targetId} 未读回`);
						const targetData = target.data as JsonObject;
						const prior = beforeMap.get(`LINE\0${targetId}`);
						const preservedOldLines = before.records.filter(record => record.type === 'LINE' && object(record.data)
							&& lineOverlap(targetData, record.data as JsonObject));
						const owners = coverage.filter(owner => owner.targetIds.includes(targetId));
						const splitSource = owners.some(owner => owner.targetIds.length > 1);
						const endpointsMatch = lineEndpointsMatch(sourceLine.sourceData, targetData);
						const different = Object.entries(sourceLine.sourceData).filter(([key, value]) => {
							if (key === 'zIndex' || ((prior || owners.length > 1 || splitSource) && ['startX', 'startY', 'endX', 'endY'].includes(key))) return false;
							if (preservedOldLines.some(old => object(old.data) && stable(old.data[key]) !== stable(value) && stable(targetData[key]) === stable(old.data[key]))) return false;
							if (['startX', 'startY', 'endX', 'endY'].includes(key) && endpointsMatch) return false;
							return !lineFieldMatches(key, value, targetData[key]);
						}).map(([key]) => key);
						if (different.length) return await stop('unknown', 'line_field_readback', `LINE/${targetId} 属性未恢复：${different.join(', ')}`);
						const preservedFields = Object.entries(sourceLine.sourceData).filter(([key, value]) => preservedOldLines.some(old => object(old.data)
							&& stable(old.data[key]) !== stable(value) && stable(targetData[key]) === stable(old.data[key]))).map(([key]) => key);
						if (preservedFields.length) differences.push({ sourceId: item.sourceId, targetId, fields: preservedFields });
						if (Object.hasOwn(sourceLine.sourceData, 'zIndex') && stable(targetData.zIndex) !== stable(sourceLine.sourceData.zIndex)
							&& !preservedFields.includes('zIndex')) differences.push({ sourceId: item.sourceId, targetId, fields: ['zIndex'] });
					}
				}
				return { coverage, differences };
			};
			const desiredUids = new Set(input.components.map(item => item.targetUid));
			for (const record of before.records) {
				if (record.type === 'COMPONENT' && object(record.data) && object(record.data.attrs) && typeof record.data.attrs['Unique ID'] === 'string'
					&& desiredUids.has(record.data.attrs['Unique ID'])) return await stop('not_started', 'uid_collision', `目标 PCB 已存在组件 UID ${record.data.attrs['Unique ID']}`);
			}
			const createdComponentIds = new Set<string>();
		const pendingPadLengths: Array<{ componentId: string; padNumber: string; padLength: number | null; targetUid: string }> = [];
			for (const component of input.components) {
				await persist({ phase: `component:${component.targetUid}:create`, writeAttempted: true });
				const made = await host.createComponent(component);
				if (!made?.id) return await stop('unknown', `component:${component.targetUid}:create_readback`, '组件创建没有返回可读 ID');
				createdComponentIds.add(made.id);
				const pads = await host.readPads(made.id);
				if (pads.length !== component.pads.length || new Set(pads.map(pad => pad.number)).size !== pads.length) return await stop('unknown', `component:${component.targetUid}:pads`, '新器件 PAD 数量或编号不匹配');
				const padIds: Record<string, string> = {};
				for (const expected of component.pads) {
					const matches = pads.filter(pad => pad.number === expected.number);
					if (matches.length !== 1) return await stop('unknown', `component:${component.targetUid}:pad:${expected.number}`, 'PAD 编号读回不唯一');
					const pad = matches[0]; padIds[expected.number] = pad.id;
					const expectedGeometry = component.expectedPosePadGeometry.find(item => item.number === expected.number);
					if (!expectedGeometry || !padGeometryMatches(pad, expectedGeometry)) return await stop('unknown', `component:${component.targetUid}:pad:${expected.number}:geometry`, 'PAD 位置、层、旋转、形状或孔属性读回不匹配');
					if (pad.net !== expected.targetNet) {
						await persist({ phase: `component:${component.targetUid}:pad:${expected.number}:net`, writeAttempted: true });
						await host.setPadNet(pad.id, expected.targetNet);
					}
					const actual = (await host.readPads(made.id)).filter(item => item.number === expected.number);
					if (actual.length !== 1 || actual[0].net !== expected.targetNet) return await stop('unknown', `component:${component.targetUid}:pad:${expected.number}:verify`, 'PAD 网络读回不匹配');
					if (expected.padLength !== undefined) {
						await persist({ phase: `component:${component.targetUid}:pad:${expected.number}:length`, writeAttempted: true });
						pendingPadLengths.push({ componentId: made.id, padNumber: expected.number, padLength: expected.padLength, targetUid: component.targetUid });
					}
				}
				const prior = await host.readComponent(made.id);
				if (prior.uniqueId !== component.targetUid || prior.designator !== component.designator) return await stop('unknown', `component:${component.targetUid}:identity`, '新器件 UID 或位号读回不匹配');
				const merged = { ...prior.otherProperty, ...component.otherProperty };
				if (stable(merged) !== stable(prior.otherProperty)) {
					await persist({ phase: `component:${component.targetUid}:otherProperty`, writeAttempted: true });
					await host.setComponentOtherProperty(made.id, merged);
				}
				const finalComponent = await host.readComponent(made.id);
				if (finalComponent.uniqueId !== component.targetUid || finalComponent.designator !== component.designator
					|| finalComponent.layer !== component.layer || !closeNumber(finalComponent.x, component.x) || !closeNumber(finalComponent.y, component.y)
					|| !closeNumber(finalComponent.rotation, component.rotation, true) || finalComponent.primitiveLock !== component.primitiveLock
					|| Object.entries(component.otherProperty).some(([key, value]) => stable(finalComponent.otherProperty[key]) !== stable(value)))
					return await stop('unknown', `component:${component.targetUid}:verify`, '组件位姿、锁定或属性读回不符（包含显式空字符串）');
				const componentSnapshot = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
				const componentAttributes = componentSnapshot.records.filter(record => record.type === 'ATTR' && object(record.data) && record.data.parentId === made.id);
				const attributeIds = componentAttributes.map(record => record.id);
				const explicitlyRequestedAttributeKeys = new Set(input.attributes.filter(item => item.parentUid === component.targetUid).map(item => item.key));
				const transientGeneratedAttributeIds = componentAttributes
					.filter(record => isTransientGenerated3DModelTitleAttribute(record.data) && !explicitlyRequestedAttributeKeys.has(String((record.data as JsonObject).key)))
					.map(record => record.id);
				const transientGeneratedAttributeData = componentAttributes.filter(record => transientGeneratedAttributeIds.includes(record.id) && object(record.data))
					.map(record => ({ id: record.id, data: record.data as JsonObject }));
				await persist({ createdComponents: [...operation.createdComponents, { sourceUid: component.sourceUid, targetUid: component.targetUid, componentId: made.id, padIds, attributeIds, transientGeneratedAttributeIds, transientGeneratedAttributeData }], phase: `component:${component.targetUid}:confirmed` });
			}
			if (pendingPadLengths.length) {
				await persist({ phase: 'pad_length_restore', writeAttempted: true });
				await host.setPadLengths(pendingPadLengths.map(({ componentId, padNumber, padLength }) => ({ componentId, padNumber, padLength })));
				const snapshot = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
				for (const item of pendingPadLengths) {
					const record = snapshot.records.find(candidate => candidate.type === 'PAD_NET' && (() => {
						try { const id = JSON.parse(candidate.id); return Array.isArray(id) && id[1] === item.componentId && id[2] === item.padNumber; } catch { return false; }
					})());
					if (!record || !object(record.data) || record.data.padLen !== item.padLength) return await stop('unknown', `component:${item.targetUid}:pad:${item.padNumber}:length_verify`, 'PAD 长度读回不匹配');
				}
			}
			for (const line of input.lines) {
				await persist({ phase: `line:${line.sourceId}:route`, writeAttempted: true });
				const result = await host.routeTrack({ net: line.net, points: line.points, layer: line.layer, width: line.width });
				if (!result || !Array.isArray(result.segmentIds) || result.segmentIds.some(id => typeof id !== 'string' || !id)) return await stop('unknown', `line:${line.sourceId}:returned_ids`, '走线未返回有效 segmentIds');
				await persist({ createdLines: [...operation.createdLines, { sourceId: line.sourceId, returnedIds: [...result.segmentIds] }] });
			}
			const afterLines = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
			await verifyLinesAt(afterLines, false);
			const firstCoverage = (await host.verifyLineCoverage(input.lines, before, afterLines));
			await host.restoreLineFields(input.lines, firstCoverage, before);
			const afterLineFields = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
			if (afterLineFields.projectUuid !== input.projectUuid || afterLineFields.pcbUuid !== input.targetPcbUuid) return await stop('unknown', 'line_field_context', 'LINE 属性恢复后的上下文变化');
			const verifiedLineFields = await verifyLinesAt(afterLineFields, true);
			const lineCoverage = verifiedLineFields.coverage;
			const lineFieldDifferences = verifiedLineFields.differences;
			await persist({ lineCoverage, lineFieldDifferences, phase: 'lines_verified' });
			for (const via of input.vias) {
				await persist({ phase: `via:${via.sourceId}:place`, writeAttempted: true });
				const made = await host.placeVia(via); if (!made?.id) return await stop('unknown', `via:${via.sourceId}:readback`, 'VIA 未返回目标 ID');
				const snap = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
				if (snap.projectUuid !== input.projectUuid || snap.pcbUuid !== input.targetPcbUuid) return await stop('unknown', `via:${via.sourceId}:context`, 'VIA 读回上下文变化');
				const actual = recordMap(snap).get(`VIA\0${made.id}`);
				const compared = actual && object(actual.data) ? compareNewNativeGeometry('VIA', via.sourceId, made.id, via.sourceData, actual.data) : { ok: false, differences: [] as NativeNumericDifference[] };
				if (!compared.ok) return await stop('unknown', `via:${via.sourceId}:verify`, 'VIA 属性读回不匹配');
				const typedQuantization = (made.typedSizeQuantization ?? []).map(item => ({ type: 'VIA' as const, sourceId: via.sourceId, targetId: made.id, ...item }));
				await persist({ createdVias: [...operation.createdVias, { sourceId: via.sourceId, targetId: made.id }], nativeNumericDifferences: [...(operation.nativeNumericDifferences ?? []), ...compared.differences],
					...(typedQuantization.length ? { typedViaSizeQuantization: mergeTypedViaSizeQuantization(operation.typedViaSizeQuantization ?? [], typedQuantization) } : {}) });
			}
			for (const arc of input.arcs ?? []) {
				if (!host.placeArc) return await stop('not_started', `arc:${arc.sourceId}:unsupported`, 'ARC host adapter 不可用');
				await persist({ phase: `arc:${arc.sourceId}:place`, writeAttempted: true });
				const made = await host.placeArc(arc); if (!made?.id) return await stop('unknown', `arc:${arc.sourceId}:readback`, 'ARC 未返回目标 ID');
				const snap = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
				const actual = recordMap(snap).get(`ARC\0${made.id}`);
				const compared = actual && object(actual.data) ? compareNewNativeGeometry('ARC', arc.sourceId, made.id, arc.sourceData, actual.data) : { ok: false, differences: [] as NativeNumericDifference[] };
				if (snap.projectUuid !== input.projectUuid || snap.pcbUuid !== input.targetPcbUuid || !compared.ok) return await stop('unknown', `arc:${arc.sourceId}:verify`, 'ARC 属性读回不匹配');
				const typedQuantization = (made.typedEndpointQuantization ?? []).map(item => ({ type: 'ARC' as const, sourceId: arc.sourceId, targetId: made.id, ...item }));
				await persist({ createdArcs: [...(operation.createdArcs ?? []), { sourceId: arc.sourceId, targetId: made.id }], nativeNumericDifferences: [...(operation.nativeNumericDifferences ?? []), ...compared.differences],
					...(typedQuantization.length ? { typedArcEndpointQuantization: mergeTypedArcEndpointQuantization(operation.typedArcEndpointQuantization ?? [], typedQuantization) } : {}) });
			}
			for (const pad of input.standalonePads ?? []) {
				if (!host.placeStandalonePad) return await stop('not_started', `pad:${pad.sourceId}:unsupported`, '独立 PAD host adapter 不可用');
				await persist({ phase: `pad:${pad.sourceId}:place`, writeAttempted: true });
				const made = await host.placeStandalonePad(pad); if (!made?.id) return await stop('unknown', `pad:${pad.sourceId}:readback`, '独立 PAD 未返回目标 ID');
				const snap = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
				const actual = recordMap(snap).get(`PAD\0${made.id}`);
				const compared = actual && object(actual.data) ? compareNewNativeGeometry('PAD', pad.sourceId, made.id, pad.sourceData, actual.data) : { ok: false, differences: [] as NativeNumericDifference[] };
				if (snap.projectUuid !== input.projectUuid || snap.pcbUuid !== input.targetPcbUuid || !compared.ok) return await stop('unknown', `pad:${pad.sourceId}:verify`, '独立 PAD 属性读回不匹配');
				const typedQuantization = (made.typedGeometryQuantization ?? []).map(item => ({ type: 'PAD' as const, sourceId: pad.sourceId, targetId: made.id, ...item }));
				await persist({ createdStandalonePads: [...(operation.createdStandalonePads ?? []), { sourceId: pad.sourceId, targetId: made.id, typedMaskExpansion: made.typedMaskExpansion }], nativeNumericDifferences: [...(operation.nativeNumericDifferences ?? []), ...compared.differences],
					...(typedQuantization.length ? { typedPadGeometryQuantization: mergeTypedPadGeometryQuantization(operation.typedPadGeometryQuantization ?? [], typedQuantization) } : {}) });
			}
			for (const item of input.strings) {
				await persist({ phase: `string:${item.sourceId}:place`, writeAttempted: true });
				const made = await host.placeString(item); if (!made?.id) return await stop('unknown', `string:${item.sourceId}:readback`, 'STRING 未返回目标 ID');
				const snap = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
				if (snap.projectUuid !== input.projectUuid || snap.pcbUuid !== input.targetPcbUuid) return await stop('unknown', `string:${item.sourceId}:context`, 'STRING 读回上下文变化');
				const actual = recordMap(snap).get(`STRING\0${made.id}`);
				if (!actual || !object(actual.data) || !nativeExpectedFieldsMatch(item.sourceData, actual.data)) return await stop('unknown', `string:${item.sourceId}:verify`, 'STRING 属性读回不匹配');
				await persist({ createdStrings: [...operation.createdStrings, { sourceId: item.sourceId, targetId: made.id }] });
			}
			for (const attr of input.attributes) {
				const owner = operation.createdComponents.find(item => item.targetUid === attr.parentUid);
				if (!owner) return await stop('not_started', `attr:${attr.sourceId}:owner`, 'ATTR 父 UID 不属于本次新建组件');
				await persist({ phase: `attr:${attr.sourceId}:modify`, writeAttempted: true });
				await host.modifyAttribute(owner.componentId, attr.key, { value: attr.value, display: attr.display });
				const actual = await host.readAttribute(owner.componentId, attr.key);
				if (!actual.id || actual.parentId !== owner.componentId || actual.key !== attr.key || stable(actual.value) !== stable(attr.value)
					|| Object.entries(attr.display).some(([field, value]) => stable(actual.display[field]) !== stable(value)))
					return await stop('unknown', `attr:${attr.sourceId}:verify`, 'ATTR 关联或显示属性读回不匹配');
				await persist({ updatedAttributes: [...operation.updatedAttributes, { sourceId: attr.sourceId, targetId: actual.id, parentId: owner.componentId, key: attr.key }] });
			}
			const final = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
			if (final.projectUuid !== input.projectUuid || final.pcbUuid !== input.targetPcbUuid) return await stop('unknown', 'final_context', '最终 PCB 身份读回不符');
			const finalMap = recordMap(final);
			let finalLineEvidence: Awaited<ReturnType<typeof verifyLinesAt>>;
			try { finalLineEvidence = await verifyLinesAt(final, true); verifyLineBaselineCoverage(before, final); }
			catch (error) { return await stop('unknown', 'final_line_verification', error instanceof Error ? error.message : String(error)); }
			const disappearedTransientAttributeIds: string[] = [];
			for (const created of operation.createdComponents) {
				const expected = input.components.find(item => item.targetUid === created.targetUid);
				if (!expected) return await stop('unknown', 'final_component_identity', `找不到组件预期 ${created.targetUid}`);
				const actual = await host.readComponent(created.componentId);
				if (actual.uniqueId !== expected.targetUid || actual.designator !== expected.designator || actual.layer !== expected.layer
					|| !closeNumber(actual.x, expected.x) || !closeNumber(actual.y, expected.y) || !closeNumber(actual.rotation, expected.rotation, true)
					|| actual.primitiveLock !== expected.primitiveLock
					|| Object.entries(expected.otherProperty).some(([key, value]) => stable(actual.otherProperty[key]) !== stable(value)))
					return await stop('unknown', 'final_component_readback', `组件 ${expected.targetUid} 最终位姿或属性读回不符`);
				const pads = await host.readPads(created.componentId);
				if (pads.length !== expected.pads.length) return await stop('unknown', 'final_pad_set', `组件 ${expected.targetUid} 最终 PAD 数量变化`);
				for (const padPlan of expected.pads) {
					const matching = pads.filter(pad => pad.number === padPlan.number);
					const geometry = expected.expectedPosePadGeometry.find(pad => pad.number === padPlan.number);
					if (matching.length !== 1 || !geometry || !padGeometryMatches(matching[0], geometry) || matching[0].net !== padPlan.targetNet
						|| created.padIds[padPlan.number] !== matching[0].id) return await stop('unknown', 'final_pad_readback', `组件 ${expected.targetUid} PAD ${padPlan.number} 最终网络、归属或几何不符`);
					const padRecord = final.records.find(record => record.type === 'PAD_NET' && (() => { try { const row = JSON.parse(record.id); return Array.isArray(row) && row[1] === created.componentId && row[2] === padPlan.number && (row.length < 4 || `${created.componentId}${row[3]}` === matching[0].id); } catch { return false; } })());
					if (!padRecord || !object(padRecord.data) || padRecord.data.padNet !== padPlan.targetNet
						|| (padPlan.padLength !== undefined && padRecord.data.padLen !== padPlan.padLength)) return await stop('unknown', 'final_pad_net_record', `PAD_NET ${expected.targetUid}/${padPlan.number} 最终记录不符`);
				}
				for (const attrId of created.attributeIds) {
					const attr = finalMap.get(`ATTR\0${attrId}`);
					if (!attr) {
						if (created.transientGeneratedAttributeIds.includes(attrId)) { disappearedTransientAttributeIds.push(attrId); continue; }
						return await stop('unknown', 'final_component_attribute', `组件 ${expected.targetUid} 的原生 ATTR 归属或 ID 丢失`);
					}
					if (!object(attr.data) || attr.data.parentId !== created.componentId) return await stop('unknown', 'final_component_attribute', `组件 ${expected.targetUid} 的原生 ATTR 归属或 ID 丢失`);
					if (created.transientGeneratedAttributeIds.includes(attrId)) {
						const expectedGenerated = created.transientGeneratedAttributeData.find(item => item.id === attrId)?.data;
						if (!expectedGenerated || stable(attr.data) !== stable(expectedGenerated)) return await stop('unknown', 'final_component_attribute', `组件 ${expected.targetUid} 的瞬时 3D 标题 ATTR 数据变化`);
					}
				}
			}
			for (const via of input.vias) {
				const logged = operation.createdVias.find(item => item.sourceId === via.sourceId);
				const record = logged && finalMap.get(`VIA\0${logged.targetId}`);
				const compared = record && object(record.data) && logged ? compareNewNativeGeometry('VIA', via.sourceId, logged.targetId, via.sourceData, record.data) : { ok: false, differences: [] as NativeNumericDifference[] };
				if (!compared.ok) return await stop('unknown', 'final_via_readback', `VIA ${via.sourceId} 最终 ID 或数据不符`);
				operation.nativeNumericDifferences = mergeNativeNumericDifferences(operation.nativeNumericDifferences ?? [], compared.differences);
			}
			for (const arc of input.arcs ?? []) {
				const logged = operation.createdArcs?.find(item => item.sourceId === arc.sourceId);
				const record = logged && finalMap.get(`ARC\0${logged.targetId}`);
				const compared = record && object(record.data) && logged ? compareNewNativeGeometry('ARC', arc.sourceId, logged.targetId, arc.sourceData, record.data) : { ok: false, differences: [] as NativeNumericDifference[] };
				if (!compared.ok) return await stop('unknown', 'final_arc_readback', `ARC ${arc.sourceId} 最终 ID 或数据不符`);
				operation.nativeNumericDifferences = mergeNativeNumericDifferences(operation.nativeNumericDifferences ?? [], compared.differences);
			}
			for (const pad of input.standalonePads ?? []) {
				const logged = operation.createdStandalonePads?.find(item => item.sourceId === pad.sourceId);
				const record = logged && finalMap.get(`PAD\0${logged.targetId}`);
				const compared = record && object(record.data) && logged ? compareNewNativeGeometry('PAD', pad.sourceId, logged.targetId, pad.sourceData, record.data) : { ok: false, differences: [] as NativeNumericDifference[] };
				if (!compared.ok) return await stop('unknown', 'final_standalone_pad_readback', `独立 PAD ${pad.sourceId} 最终 ID 或数据不符`);
				operation.nativeNumericDifferences = mergeNativeNumericDifferences(operation.nativeNumericDifferences ?? [], compared.differences);
			}
			for (const item of input.strings) {
				const logged = operation.createdStrings.find(value => value.sourceId === item.sourceId);
				const record = logged && finalMap.get(`STRING\0${logged.targetId}`);
				if (!record || !object(record.data) || !nativeExpectedFieldsMatch(item.sourceData, record.data)) return await stop('unknown', 'final_string_readback', `STRING ${item.sourceId} 最终 ID 或数据不符`);
			}
			for (const attr of input.attributes) {
				const logged = operation.updatedAttributes.find(value => value.sourceId === attr.sourceId);
				const record = logged && finalMap.get(`ATTR\0${logged.targetId}`);
				if (!record || !object(record.data) || record.data.parentId !== logged.parentId || record.data.key !== logged.key
					|| logged.key !== attr.key || logged.parentId !== operation.createdComponents.find(item => item.targetUid === attr.parentUid)?.componentId
					|| stable(record.data.value) !== stable(attr.value) || Object.entries(attr.display).some(([key, value]) => stable(record.data && object(record.data) ? record.data[key] : undefined) !== stable(value)))
					return await stop('unknown', 'final_attribute_readback', `ATTR ${attr.sourceId} 最终 ID、父级或显示数据不符`);
			}
			const preservationTicketChanges: NonNullable<CompositionOperation['preservationTicketChanges']> = [];
			for (const record of before.records) if (record.type === 'LINE') {
				const current = finalMap.get(`LINE\0${record.id}`);
				if (current && record.header?.ticket !== current.header?.ticket) preservationTicketChanges.push({ type: 'LINE', id: record.id, before: record.header?.ticket as number | undefined, after: current.header?.ticket as number | undefined });
			}
			const permittedBlindRuleIds = new Set((input.requiredBlindRules ?? []).length
				? before.records.filter(record => record.type === 'RULE' && (() => { try { const parsed = JSON.parse(record.id); return Array.isArray(parsed) && parsed[1] === 'BLIND' && parsed[2] === 'blindVia'; } catch { return false; } })()).map(record => record.id)
				: []);
			const expectedBlindDataById = new Map<string, JsonObject>();
			for (const id of permittedBlindRuleIds) {
				const original = beforeMap.get(`RULE\0${id}`);
				if (!original || !object(original.data) || !object(original.data.ruleContext) || !object(original.data.ruleContext.blinds))
					return await stop('unknown', 'blind_rule_preservation', `BLIND 规则 ${id} 初始记录无效`);
				const originalContext = original.data.ruleContext as JsonObject;
				const originalBlinds = originalContext.blinds as JsonObject;
				if (!Array.isArray(originalBlinds.content)) return await stop('unknown', 'blind_rule_preservation', `BLIND 规则 ${id} 初始行表无效`);
				const expectedRows = [...originalBlinds.content];
				for (const rule of input.requiredBlindRules ?? []) {
					const sourceBlinds = (rule.sourceData.ruleContext as JsonObject).blinds as JsonObject;
					const sourceRows = (sourceBlinds.content as unknown[]).filter(row => object(row) && row.name === rule.name);
					if (sourceRows.length !== 1) return await stop('unknown', 'blind_rule_preservation', `BLIND 规则 ${rule.name} 来源行不唯一`);
					const matches = expectedRows.filter(row => object(row) && row.name === rule.name);
					if (matches.length > 1 || (matches.length === 1 && nativeBlindRuleSemantic(matches[0]) !== nativeBlindRuleSemantic(sourceRows[0])))
						return await stop('unknown', 'blind_rule_preservation', `BLIND 规则 ${rule.name} 与初始行冲突`);
					if (!matches.length) expectedRows.push(sourceRows[0]);
				}
				const expectedContext = { ...originalContext, blinds: { ...originalBlinds, content: expectedRows } };
				expectedBlindDataById.set(id, { ...original.data, ruleContext: expectedContext });
			}
			for (const [key, record] of beforeMap) if (record.type !== 'LINE' && !createdComponentIds.has(record.id)) {
				const current = finalMap.get(key);
				if (record.type === 'RULE' && permittedBlindRuleIds.has(record.id)) {
					const expectedData = expectedBlindDataById.get(record.id);
					if (!current || !expectedData || stable(current.data) !== stable(expectedData)
						|| headerWithoutTicket(current.header) !== headerWithoutTicket(record.header))
						return await stop('unknown', 'blind_rule_preservation', `BLIND 规则 ${record.id} 的完整规则状态、行表或 header 发生变化`);
					continue;
				}
				if (!current || stable(current.data) !== stable(record.data) || headerWithoutTicket(current.header) !== headerWithoutTicket(record.header))
					return await stop('unknown', 'existing_object_preservation', `既有对象被修改或删除：${record.type}/${record.id}`);
				if (record.header?.ticket !== current.header?.ticket)
					preservationTicketChanges.push({ type: record.type, id: record.id, before: record.header?.ticket as number | undefined, after: current.header?.ticket as number | undefined });
			}
			const createdComponentById = new Map(operation.createdComponents.map(item => [item.componentId, item]));
			const requiredNetNames = new Set([...input.components.flatMap(item => item.pads.map(pad => pad.targetNet)), ...input.lines.map(item => item.net), ...input.vias.map(item => item.params.net),
				...(input.arcs ?? []).map(item => item.params.net), ...(input.standalonePads ?? []).map(item => item.params.net)]);
			const coveredFinalLineIds = new Set(finalLineEvidence.coverage.flatMap(item => item.targetIds));
			for (const [key, record] of finalMap) if (!beforeMap.has(key)) {
				let accounted = false;
				if (record.type === 'COMPONENT') accounted = createdComponentById.has(record.id);
				else if (record.type === 'PAD_NET') {
					try { const row = JSON.parse(record.id); const owner = Array.isArray(row) ? createdComponentById.get(row[1]) : undefined; const padId = owner?.padIds[String(row[2])]; accounted = Boolean(owner && padId && (row.length < 4 || `${owner.componentId}${row[3]}` === padId)); } catch { accounted = false; }
				} else if (record.type === 'ATTR' && object(record.data)) {
					const attrData = record.data as JsonObject;
					const parentId = String(attrData.parentId); const owner = createdComponentById.get(parentId);
					const requestedId = operation.updatedAttributes.some(item => item.targetId === record.id && item.parentId === parentId && item.key === attrData.key);
					accounted = Boolean(owner && (owner.attributeIds.includes(record.id) || requestedId));
				} else if (record.type === 'LINE') accounted = coveredFinalLineIds.has(record.id);
				else if (record.type === 'VIA') accounted = operation.createdVias.some(item => item.targetId === record.id);
				else if (record.type === 'ARC') accounted = (operation.createdArcs ?? []).some(item => item.targetId === record.id);
				else if (record.type === 'PAD') accounted = (operation.createdStandalonePads ?? []).some(item => item.targetId === record.id);
				else if (record.type === 'STRING') accounted = operation.createdStrings.some(item => item.targetId === record.id);
				else if (record.type === 'NET' || record.type === 'RULE_SELECTOR') {
					try { const row = JSON.parse(record.id); const netName = record.type === 'NET' ? row[1] : row[1]?.[1]; accounted = Array.isArray(row) && requiredNetNames.has(netName); } catch { accounted = false; }
				} else if (record.type === 'RULE' && object(record.data)) {
					try {
						const row = JSON.parse(record.id);
						const ruleName = row[2];
						const sourceRule = input.requiredBlindRules?.find(rule => rule.viaSizeRule === ruleName);
						accounted = row.length === 3 && row[0] === 'RULE' && row[1] === 'RADIUS' && typeof ruleName === 'string'
							&& operation.addedViaSizeRules?.includes(ruleName) === true && sourceRule !== undefined
							&& stable(record.data) === stable(sourceRule.viaSizeData);
					} catch { accounted = false; }
				}
				if (!accounted) return await stop('unknown', 'unexpected_added_record', `新增原生对象没有本次操作对应的精确 ID/父级：${record.type}/${record.id}`);
			}
			const addedViaSizeNames = operation.addedViaSizeRules ?? [];
			if (new Set(addedViaSizeNames).size !== addedViaSizeNames.length)
				return await stop('unknown', 'via_size_accounting', 'addedViaSizeRules 台账包含重复名称');
			for (const name of addedViaSizeNames) {
				const expectedId = JSON.stringify(['RULE', 'RADIUS', name]);
				const record = finalMap.get(`RULE\0${expectedId}`);
				const prepared = input.requiredBlindRules?.find(rule => rule.viaSizeRule === name);
				if (!record || !prepared || stable(record.data) !== stable(prepared.viaSizeData))
					return await stop('unknown', 'via_size_accounting', `新增 viaSize 规则未按精确 ID 和 DATA 保留：${expectedId}`);
			}
			return await persist({ transientAttributeIdsDisappeared: disappearedTransientAttributeIds, preservationTicketChanges, lineCoverage: finalLineEvidence.coverage, lineFieldDifferences: finalLineEvidence.differences,
				...(operation.nativeNumericDifferences ? { nativeNumericDifferences: operation.nativeNumericDifferences } : {}),
				...(operation.typedArcEndpointQuantization ? { typedArcEndpointQuantization: operation.typedArcEndpointQuantization } : {}),
				...(operation.typedPadGeometryQuantization ? { typedPadGeometryQuantization: operation.typedPadGeometryQuantization } : {}),
				...(operation.typedViaSizeQuantization ? { typedViaSizeQuantization: operation.typedViaSizeQuantization } : {}), status: 'confirmed', phase: 'completed' }).then(() => operation);
		}
		catch (error) {
			if (error instanceof PcbCompositionError) throw error;
			if (operation.writeAttempted && beforeSnapshot) {
				try {
					const observed = await host.readSnapshot(input.projectUuid, input.targetPcbUuid);
					const baselineKeys = recordMap(beforeSnapshot);
					operation = { ...operation, observedAddedRecords: observed.records.filter(record => !baselineKeys.has(`${record.type}\0${record.id}`)).map(record => ({ type: record.type, id: record.id })) };
				} catch { /* preserve the original error and unknown state */ }
			}
			return await stop(operation.writeAttempted ? 'unknown' : 'not_started', operation.phase, error instanceof Error ? error.message : String(error));
		}
	}
	return { composePcbInstance, getCompositionOperation };
}

function nativeExpectedFieldsMatch(expected: JsonObject, target: JsonObject): boolean {
	return Object.entries(expected).every(([key, value]) => stable(target[key]) === stable(value));
}

type NativeGeometryType = 'VIA' | 'ARC' | 'PAD';
type NativeNumericDifference = NonNullable<CompositionOperation['nativeNumericDifferences']>[number];
const ARC_TYPED_ENDPOINT_QUANTIZATION = 'Math.round(value*10+1e-10)/10';
const PAD_TYPED_GEOMETRY_QUANTIZATION = 'Math.round(value*10+1e-10)/10';
const VIA_TYPED_SIZE_QUANTIZATION = '2*(Math.round((value/2)*10+1e-10)/10)';
function arcTypedEndpointValue(value: number): number { return Math.round(value * 10 + 1e-10) / 10; }
function padTypedGeometryValue(value: number): number { return Math.round(value * 10 + 1e-10) / 10; }
function viaTypedDiameterValue(value: number): number { return 2 * (Math.round((value / 2) * 10 + 1e-10) / 10); }
function angleDelta(actual: number, expected: number): number { return ((actual - expected) % 360 + 540) % 360 - 180; }
type TypedArcEndpointQuantization = NonNullable<CompositionOperation['typedArcEndpointQuantization']>[number];
function mergeTypedArcEndpointQuantization(existing: TypedArcEndpointQuantization[], incoming: TypedArcEndpointQuantization[]): TypedArcEndpointQuantization[] {
	const merged = new Map<string, TypedArcEndpointQuantization>();
	for (const evidence of [...existing, ...incoming]) merged.set(stable(evidence), evidence);
	return [...merged.values()];
}
type TypedPadGeometryQuantization = NonNullable<CompositionOperation['typedPadGeometryQuantization']>[number];
function mergeTypedPadGeometryQuantization(existing: TypedPadGeometryQuantization[], incoming: TypedPadGeometryQuantization[]): TypedPadGeometryQuantization[] {
	const merged = new Map<string, TypedPadGeometryQuantization>();
	for (const evidence of [...existing, ...incoming]) merged.set(stable(evidence), evidence);
	return [...merged.values()];
}
type TypedViaSizeQuantization = NonNullable<CompositionOperation['typedViaSizeQuantization']>[number];
function mergeTypedViaSizeQuantization(existing: TypedViaSizeQuantization[], incoming: TypedViaSizeQuantization[]): TypedViaSizeQuantization[] {
	const merged = new Map<string, TypedViaSizeQuantization>();
	for (const evidence of [...existing, ...incoming]) merged.set(stable(evidence), evidence);
	return [...merged.values()];
}
function compareNewNativeGeometry(type: NativeGeometryType, sourceId: string, targetId: string, expected: JsonObject, target: JsonObject): { ok: boolean; differences: NativeNumericDifference[] } {
	const tolerances: Record<string, number> = type === 'VIA' || type === 'PAD'
		? { centerX: 1e-4, centerY: 1e-4 }
		: { startX: 1e-3, startY: 1e-3, endX: 1e-3, endY: 1e-3 };
	const differences: NativeNumericDifference[] = [];
	for (const [key, value] of Object.entries(expected)) {
		const actual = target[key];
		const tolerance = tolerances[key];
		if (tolerance !== undefined && typeof value === 'number' && Number.isFinite(value)) {
			if (typeof actual !== 'number' || !Number.isFinite(actual)) return { ok: false, differences };
			const delta = Math.abs(actual - value);
			if (delta > tolerance) return { ok: false, differences };
			if (delta !== 0) differences.push({ type, sourceId, targetId, field: key, expected: value, actual, delta, tolerance });
		} else if (stable(actual) !== stable(value)) return { ok: false, differences };
	}
	return { ok: true, differences };
}
function mergeNativeNumericDifferences(existing: NativeNumericDifference[], incoming: NativeNumericDifference[]): NativeNumericDifference[] {
	const merged = new Map<string, NativeNumericDifference>();
	for (const difference of [...existing, ...incoming]) merged.set(stable(difference), difference);
	return [...merged.values()];
}

function lineFieldMatches(key: string, expected: unknown, actual: unknown): boolean {
	if (['startX', 'startY', 'endX', 'endY'].includes(key)) return closeNumber(actual, expected, false, 1e-3);
	return stable(actual) === stable(expected);
}

function lineEndpointsMatch(expected: JsonObject, actual: JsonObject): boolean {
	const direct = closeNumber(expected.startX, actual.startX, false, 1e-3) && closeNumber(expected.startY, actual.startY, false, 1e-3)
		&& closeNumber(expected.endX, actual.endX, false, 1e-3) && closeNumber(expected.endY, actual.endY, false, 1e-3);
	const reversed = closeNumber(expected.startX, actual.endX, false, 1e-3) && closeNumber(expected.startY, actual.endY, false, 1e-3)
		&& closeNumber(expected.endX, actual.startX, false, 1e-3) && closeNumber(expected.endY, actual.startY, false, 1e-3);
	return direct || reversed;
}

function segmentCoveredByLines(target: JsonObject, sources: JsonObject[]): boolean {
	const x1 = Number(target.startX), y1 = Number(target.startY), x2 = Number(target.endX), y2 = Number(target.endY);
	if (![x1, y1, x2, y2].every(Number.isFinite)) return false;
	const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
	if (length2 <= 1e-12) return false;
	const length = Math.sqrt(length2), distanceTolerance = 1e-3;
	const intervals: Array<{ lo: number; hi: number }> = [];
	for (const source of sources) {
		if (source.netName !== target.netName || source.layerId !== target.layerId || source.width !== target.width) continue;
		const ax = Number(source.startX), ay = Number(source.startY), bx = Number(source.endX), by = Number(source.endY);
		if (![ax, ay, bx, by].every(Number.isFinite)) continue;
		if (Math.abs((ax - x1) * dy - (ay - y1) * dx) / length > distanceTolerance
			|| Math.abs((bx - x1) * dy - (by - y1) * dx) / length > distanceTolerance) continue;
		const ta = ((ax - x1) * dx + (ay - y1) * dy) / length2, tb = ((bx - x1) * dx + (by - y1) * dy) / length2;
		const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(1, Math.max(ta, tb));
		if (hi - lo > 1e-10 || (Math.max(ta, tb) >= -distanceTolerance / length && Math.min(ta, tb) <= 1 + distanceTolerance / length)) intervals.push({ lo, hi });
	}
	intervals.sort((a, b) => a.lo - b.lo); let covered = 0;
	const projectionTolerance = distanceTolerance / length;
	for (const interval of intervals) { if (interval.lo > covered + projectionTolerance) break; covered = Math.max(covered, interval.hi); }
	return covered >= 1 - projectionTolerance;
}

function lineOverlap(a: JsonObject, b: JsonObject): boolean {
	if (a.netName !== b.netName || a.layerId !== b.layerId || a.width !== b.width) return false;
	const x1 = Number(a.startX), y1 = Number(a.startY), x2 = Number(a.endX), y2 = Number(a.endY);
	const ax = Number(b.startX), ay = Number(b.startY), bx = Number(b.endX), by = Number(b.endY);
	if (![x1, y1, x2, y2, ax, ay, bx, by].every(Number.isFinite)) return false;
	const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
	if (length2 <= 1e-12) return false;
	const length = Math.sqrt(length2), tolerance = 1e-3;
	if (Math.abs((ax - x1) * dy - (ay - y1) * dx) / length > tolerance || Math.abs((bx - x1) * dy - (by - y1) * dx) / length > tolerance) return false;
	const ta = ((ax - x1) * dx + (ay - y1) * dy) / length2, tb = ((bx - x1) * dx + (by - y1) * dy) / length2;
	return Math.min(1, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) > 1e-10;
}

export function verifyLineBaselineCoverage(before: CompositionSnapshot, after: CompositionSnapshot): void {
	const afterMap = recordMap(after);
	const beforeLines = before.records.filter(record => record.type === 'LINE' && object(record.data));
	const afterLines = after.records.filter(record => record.type === 'LINE' && object(record.data)).map(record => record.data as JsonObject);
	for (const record of beforeLines) {
		const oldLine = record.data as JsonObject;
		if (!segmentCoveredByLines(oldLine, afterLines)) fail(`既有 LINE 几何在组合后未保留：${record.id}`);
		const current = afterMap.get(`LINE\0${record.id}`);
		if (current && object(current.data)) {
			const currentData = current.data as JsonObject;
			const changed = Object.keys(oldLine).filter(key => !['startX', 'startY', 'endX', 'endY'].includes(key) && stable(oldLine[key]) !== stable(currentData[key]));
			if (changed.length || headerWithoutTicket(current.header) !== headerWithoutTicket(record.header)) fail(`既有 LINE/${record.id} 非几何属性变化：${changed.join(', ')}`);
		}
	}
}

type NativeParsedRecord = { header: JsonObject; data: unknown };
function parseNativeSnapshot(source: string, projectUuid: string, pcbUuid: string): CompositionSnapshot {
	const effective = new Map<string, NativeParsedRecord>();
	let foundPcbUuid = false;
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	for (const [index, raw] of lines.entries()) {
		const line = raw.replace(/[\r\n]+$/, ''); if (!line.trim()) continue;
		const split = line.indexOf('||'); if (split < 0) fail(`PCB 源码第 ${index + 1} 行缺少 ||`);
		let header: unknown, data: unknown;
		try {
			header = JSON.parse(line.slice(0, split)); let payload = line.slice(split + 2); if (payload.endsWith('|')) payload = payload.slice(0, -1);
			data = payload === '' ? '' : JSON.parse(payload);
		} catch { fail(`PCB 源码第 ${index + 1} 行 JSON 无效`); }
		if (!object(header) || typeof header.type !== 'string') fail(`PCB 源码第 ${index + 1} 行 header 无效`);
		if (header.type === 'DOCHEAD' && object(data) && data.docType === 'PCB' && data.uuid === pcbUuid) foundPcbUuid = true;
		if (header.type === 'DOCHEAD') continue;
		if (typeof header.id !== 'string') fail(`PCB 源码第 ${index + 1} 行缺少 id`);
		const key = `${header.type}\0${header.id}`; const previous = effective.get(key);
		if (!previous || Number(header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) effective.set(key, { header, data });
	}
	if (!foundPcbUuid) fail('当前文档源码不是指定 PCB');
	const records: NativeRecord[] = [];
		for (const { header, data } of effective.values()) if (data !== '') records.push({ type: String(header.type), id: String(header.id), data, header });
	return { projectUuid, pcbUuid, records };
}

function nativeLines(records: NativeRecord[]): string {
	return records.map(record => `${JSON.stringify({ type: record.type, id: record.id })}||${JSON.stringify(record.data)}|`).join('\n');
}

function stateOf<T>(value: unknown, getter: string): T {
	if (!value || typeof value !== 'object') fail(`SDK 读回对象缺少 ${getter}`);
	const method = (value as Record<string, unknown>)[getter];
	if (typeof method !== 'function') fail(`SDK 对象缺少 ${getter}`);
	return (method as () => T).call(value);
}

const BLIND_SEMANTIC_KEYS = ['name', 'startLayer', 'endLayer', 'viaSizeRule'] as const;
function blindRuleSemantic(value: unknown): string {
	if (!object(value)) return stable(value);
	const semantic: JsonObject = {}; for (const key of BLIND_SEMANTIC_KEYS) if (Object.hasOwn(value, key)) semantic[key] = value[key];
	return stable(semantic);
}
function nativeBlindRuleSemantic(value: unknown): string {
	if (!object(value) || !Number.isFinite(value.staLayerId) || !Number.isFinite(value.endLayerId)) fail('native BLIND 行缺少有效 staLayerId/endLayerId');
	return stable({ name: value.name, startLayer: value.staLayerId, endLayer: value.endLayerId, viaSizeRule: value.viaSizeRule });
}
function blindTypedTable(config: JsonObject): unknown[] {
	const physics = config.Physics;
	if (!object(physics)) fail('当前 DRC typed configuration 缺少 Physics');
	const group = physics['Blind/Buried Via'];
	if (!object(group) || !object(group.blindVia)) fail('当前 DRC typed configuration 缺少 Blind/Buried Via.blindVia');
	if (!Array.isArray(group.blindVia.table)) fail('当前 DRC typed blindVia.table 无效');
	return group.blindVia.table;
}
const VIA_SIZE_DIMENSIONS = ['viaOuterdiameterMin', 'viaOuterdiameterMax', 'viaOuterdiameterDefault', 'viaInnerdiameterMin', 'viaInnerdiameterMax', 'viaInnerdiameterDefault'] as const;
function viaSizeSemantic(value: unknown): string {
	if (!object(value) || !object(value.form)) return stable(value);
	const form = value.form as JsonObject;
	const dimensions: Record<string, number> = {};
	for (const key of VIA_SIZE_DIMENSIONS) {
		const current = form[key]; if (typeof current !== 'number' || !Number.isFinite(current)) fail(`typed viaSize 缺少尺寸 ${key}`);
		dimensions[key] = Math.round(current * 1e6) / 1e6;
	}
	const otherForm: JsonObject = {}; for (const [key, item] of Object.entries(form)) if (!VIA_SIZE_DIMENSIONS.includes(key as typeof VIA_SIZE_DIMENSIONS[number])) otherForm[key] = item;
	const other: JsonObject = {}; for (const [key, item] of Object.entries(value)) if (key !== 'form') other[key] = item;
	return stable({ ...other, form: { ...otherForm, ...dimensions } });
}
function nativeDefaultHoleSpacing(snapshot: CompositionSnapshot, config: JsonObject): NativeDefaultHoleSpacing | undefined {
	const spacing = config.Spacing;
	const otherGroup = object(spacing) ? spacing['Other Spacing'] : undefined;
	const clearance = object(otherGroup) ? otherGroup.otherClearance : undefined;
	if (!object(clearance) || clearance.unit !== 'mm' || clearance.isSetDefault !== true || !object(clearance.form) || !Number.isFinite(clearance.form.hole2Hole)) return undefined;
	const matches = snapshot.records.filter(record => {
		if (record.type !== 'RULE') return false;
		try { const id = JSON.parse(record.id); return Array.isArray(id) && id[1] === 'OTHER' && id[2] === 'otherClearance'; } catch { return false; }
	});
	if (matches.length !== 1 || !object(matches[0].data) || !object(matches[0].data.ruleContext)) return undefined;
	const data = matches[0].data;
	const context = data.ruleContext as JsonObject;
	if (data.ruleState !== 'DEFAULT' || context.unit !== 'mm' || !Number.isFinite(context.holeClearance)) return undefined;
	return { path: '$.Spacing.Other Spacing.otherClearance.form.hole2Hole', ruleId: matches[0].id, holeClearance: context.holeClearance as number };
}

/** Bind the verified composition contract to this extension's installed EDA SDK.
 * Uses native source snapshots for readback, ATTR style patches and stage storage.
 */
export function createPcbCompositionHost(api: EDA = eda): PcbCompositionHost {
	const operationKey = (id: string) => `module-reuse:pcb-composition:v1:${id}`;
	let boundTarget: { projectUuid: string; pcbUuid: string } | undefined;
	let pendingBlindRuleConfig: { projectUuid: string; pcbUuid: string; config: JsonObject; before: CompositionSnapshot } | undefined;
	async function context(projectUuid: string, pcbUuid: string): Promise<void> {
		const project = await api.dmt_Project.getCurrentProjectInfo();
		const document = await api.dmt_SelectControl.getCurrentDocumentInfo();
		if (project?.uuid !== projectUuid || document?.uuid !== pcbUuid || document?.parentProjectUuid !== projectUuid || document?.documentType !== 3)
			fail('当前工程或 PCB 与组合目标不一致');
	}
	async function readSnapshot(projectUuid: string, pcbUuid: string): Promise<CompositionSnapshot> {
		if (boundTarget && (boundTarget.projectUuid !== projectUuid || boundTarget.pcbUuid !== pcbUuid)) fail('本次 PCB 组合适配器已绑定其他目标，拒绝切换文档');
		await context(projectUuid, pcbUuid);
		boundTarget = { projectUuid, pcbUuid };
		const source = await api.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string' || !source.trim()) fail('当前 PCB 源码读取为空');
		return parseNativeSnapshot(source, projectUuid, pcbUuid);
	}
	async function assertBoundContext(): Promise<{ projectUuid: string; pcbUuid: string }> {
		if (!boundTarget) fail('尚无已核验的目标 PCB 上下文');
		await context(boundTarget.projectUuid, boundTarget.pcbUuid);
		return boundTarget;
	}
	async function patchNativeRecords(updates: Array<{ type: string; id: string; patch: JsonObject }>): Promise<void> {
		if (!updates.length) return;
		const target = await assertBoundContext();
		const source = await api.sys_FileManager.getDocumentSource(); if (typeof source !== 'string' || !source.trim()) fail('PCB 原生源码为空');
		const current = parseNativeSnapshot(source, target.projectUuid, target.pcbUuid);
		const uniqueUpdates = new Set(updates.map(item => `${item.type}\0${item.id}`));
		if (uniqueUpdates.size !== updates.length) fail('同一轮原生源补丁含重复对象');
		const records = updates.map(item => {
			const matches = current.records.filter(record => record.type === item.type && record.id === item.id);
			if (matches.length !== 1 || !object(matches[0].data)) fail(`${item.type}/${item.id} 原生记录不存在或不唯一`);
			const previous = matches[0].data as JsonObject;
			const changed = Object.fromEntries(Object.entries(item.patch).filter(([key, value]) => stable(previous[key]) !== stable(value)));
			return Object.keys(changed).length ? { type: item.type, id: item.id, data: { ...previous, ...changed } } : undefined;
		}).filter((record): record is { type: string; id: string; data: JsonObject } => Boolean(record));
		if (!records.length) return;
		const sourceLines: Array<{ text: string; eol: string }> = [];
		for (let offset = 0; offset < source.length;) {
			const newline = source.indexOf('\n', offset);
			const end = newline < 0 ? source.length : newline;
			const hasCr = end > offset && source[end - 1] === '\r';
			sourceLines.push({ text: source.slice(offset, hasCr ? end - 1 : end), eol: newline < 0 ? '' : hasCr ? '\r\n' : '\n' });
			offset = newline < 0 ? source.length : newline + 1;
		}
		const effectiveLine = new Map<string, { index: number; ticket: number }>();
		for (const [index, line] of sourceLines.entries()) {
			if (!line.text.trim()) continue;
			const split = line.text.indexOf('||');
			if (split < 0) fail(`PCB 原生源码第 ${index + 1} 行缺少 ||`);
			let header: unknown;
			try { header = JSON.parse(line.text.slice(0, split)); } catch { fail(`PCB 原生源码第 ${index + 1} 行 header JSON 无效`); }
			if (!object(header) || typeof header.type !== 'string' || typeof header.id !== 'string' || header.type === 'DOCHEAD') continue;
			const key = `${header.type}\0${header.id}`;
			const ticket = Number(header.ticket ?? 0);
			const previous = effectiveLine.get(key);
			if (!previous || ticket >= previous.ticket) effectiveLine.set(key, { index, ticket });
		}
		for (const record of records) {
			const targetLine = effectiveLine.get(`${record.type}\0${record.id}`);
			if (!targetLine) fail(`${record.type}/${record.id} 有效原生源码行不存在`);
			const line = sourceLines[targetLine.index];
			const split = line.text.indexOf('||');
			const payload = line.text.slice(split + 2);
			const hasTerminator = payload.endsWith('|');
			line.text = `${line.text.slice(0, split + 2)}${JSON.stringify(record.data)}${hasTerminator ? '|' : ''}`;
		}
		const rewritten = sourceLines.map(line => line.text + line.eol).join('');
		await context(target.projectUuid, target.pcbUuid);
		if (await api.sys_FileManager.setDocumentSource(rewritten) !== true) fail('原生源补丁 setDocumentSource 未返回 true');
	}
	const patchNativeRecord = (type: string, id: string, patch: JsonObject) => patchNativeRecords([{ type, id, patch }]);
	return {
		readSnapshot,
		createComponent: async input => {
			const target = await assertBoundContext();
			const result = await api.pcb_PrimitiveComponent.create(input.component, input.layer as any, input.x, input.y, input.rotation, input.primitiveLock);
			const id = result && stateOf<string | undefined>(result, 'getState_PrimitiveId'); if (!id) fail(`组件 ${input.targetUid} 创建无 ID`);
			await context(target.projectUuid, target.pcbUuid);
			const modified = await api.pcb_PrimitiveComponent.modify(id, { designator: input.designator, uniqueId: input.targetUid });
			if (!modified) fail(`组件 ${input.targetUid} 身份写入未返回对象`); return { id };
		},
		readComponent: async id => {
			const component = await api.pcb_PrimitiveComponent.get(id); if (!component) fail(`组件 ${id} 不存在`);
			return { id, uniqueId: String(stateOf(component, 'getState_UniqueId') ?? ''), designator: String(stateOf(component, 'getState_Designator') ?? ''),
				layer: stateOf<number>(component, 'getState_Layer'), x: stateOf<number>(component, 'getState_X'), y: stateOf<number>(component, 'getState_Y'),
				rotation: stateOf<number>(component, 'getState_Rotation'), primitiveLock: stateOf<boolean>(component, 'getState_PrimitiveLock'),
				otherProperty: (stateOf(component, 'getState_OtherProperty') ?? {}) as Record<string, unknown> };
		},
		readPads: async componentId => {
			const pads = await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(componentId); if (!pads) fail(`组件 ${componentId} 的 PAD 读取为空`);
			return pads.map(pad => {
				const parentId = String(stateOf(pad, 'getState_ParentComponentPrimitiveId') ?? '');
				if (parentId !== componentId) fail(`PAD ${String(stateOf(pad, 'getState_PadNumber'))} 归属器件读回不符`);
				return {
					id: String(stateOf(pad, 'getState_PrimitiveId') ?? ''), number: String(stateOf(pad, 'getState_PadNumber') ?? ''), net: String(stateOf(pad, 'getState_Net') ?? ''),
					layer: stateOf<string | number>(pad, 'getState_Layer'), x: stateOf<number>(pad, 'getState_X'), y: stateOf<number>(pad, 'getState_Y'),
					rotation: stateOf<number>(pad, 'getState_Rotation'), shape: stateOf(pad, 'getState_Pad'), hole: stateOf(pad, 'getState_Hole'),
					specialPad: stateOf(pad, 'getState_SpecialPad') ?? null, holeOffsetX: stateOf<number | null>(pad, 'getState_HoleOffsetX'),
					holeOffsetY: stateOf<number | null>(pad, 'getState_HoleOffsetY'), holeRotation: stateOf<number | null>(pad, 'getState_HoleRotation'),
				};
			});
		},
		setPadNet: async (padId, net) => { const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid); const result = await api.pcb_PrimitivePad.modify(padId, { net }); if (!result) fail(`PAD ${padId} 网络修改未返回对象`); },
		setPadLengths: async items => {
			if (!boundTarget) fail('尚无已核验的目标 PCB 上下文');
			const source = await api.sys_FileManager.getDocumentSource(); if (typeof source !== 'string') fail('PCB 源码读取为空');
			const snapshot = parseNativeSnapshot(source, boundTarget.projectUuid, boundTarget.pcbUuid);
			const updates = items.map(({ componentId, padNumber, padLength }) => {
				const matches = snapshot.records.filter(record => {
					if (record.type !== 'PAD_NET') return false;
					try { const parts = JSON.parse(record.id); return Array.isArray(parts) && parts[1] === componentId && parts[2] === padNumber; } catch { return false; }
				});
				if (matches.length !== 1) fail(`找不到唯一 PAD_NET ${componentId}/${padNumber}`);
				return { type: 'PAD_NET', id: matches[0].id, patch: { padLen: padLength } };
			});
			await patchNativeRecords(updates);
		},
		setComponentOtherProperty: async (componentId, otherProperty) => { const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid); const result = await api.pcb_PrimitiveComponent.modify(componentId, { otherProperty }); if (!result) fail(`组件 ${componentId} 属性修改未返回对象`); },
		routeTrack: async input => {
			const layer = input.layer === 'top' ? 1 : 2; const segmentIds: string[] = [];
			for (let index = 1; index < input.points.length; index++) {
				const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid);
				const [startX, startY] = input.points[index - 1], [endX, endY] = input.points[index];
				const line = await api.pcb_PrimitiveLine.create(input.net, layer as any, startX, startY, endX, endY, input.width, false);
				const id = line && stateOf<string | undefined>(line, 'getState_PrimitiveId'); if (!id) fail('LINE.create 未返回图元 ID'); segmentIds.push(id);
			}
			return { segmentIds };
		},
		verifyLineCoverage: async (lines, before, after) => verifyNativeLineCoverage(lines, before, after),
		restoreLineFields: async (lines, coverage, before) => {
			const ownersByTarget = new Map<string, PreparedLine[]>();
			for (const item of coverage) {
				const source = lines.find(line => line.sourceId === item.sourceId); if (!source) fail(`LINE coverage 来源不存在：${item.sourceId}`);
				for (const id of item.targetIds) ownersByTarget.set(id, [...(ownersByTarget.get(id) ?? []), source]);
			}
			const preservedByTarget = new Map<string, NativeRecord[]>();
			const current = boundTarget ? await readSnapshot(boundTarget.projectUuid, boundTarget.pcbUuid) : undefined;
			if (before && current) for (const id of ownersByTarget.keys()) {
				const target = current.records.find(record => record.type === 'LINE' && record.id === id);
				if (!target || !object(target.data)) fail(`LINE/${id} 在字段恢复前不存在`);
				const oldOwners = before.records.filter(record => record.type === 'LINE' && object(record.data)
					&& lineOverlap(target.data as JsonObject, record.data as JsonObject));
				if (oldOwners.length) preservedByTarget.set(id, oldOwners);
			}
			const targets = new Map<string, JsonObject>();
			for (const [id, owners] of ownersByTarget) {
				const patch: JsonObject = {}; const oldOwners = preservedByTarget.get(id) ?? [];
				const keys = new Set([...owners.flatMap(item => Object.keys(item.sourceData)), ...oldOwners.flatMap(item => object(item.data) ? Object.keys(item.data) : [])]);
				const prior = before?.records.find(record => record.type === 'LINE' && record.id === id);
				const splitSource = coverage.some(item => item.targetIds.length > 1 && owners.some(owner => owner.sourceId === item.sourceId));
				for (const key of keys) {
					if ((prior || oldOwners.length || owners.length > 1 || splitSource) && ['startX', 'startY', 'endX', 'endY'].includes(key)) continue;
					const values = owners.filter(item => Object.hasOwn(item.sourceData, key)).map(item => item.sourceData[key]);
					const oldValues = oldOwners.filter(item => object(item.data) && Object.hasOwn(item.data, key)).map(item => (item.data as JsonObject)[key]);
					if (key === 'zIndex') {
						if (oldValues.some(value => stable(value) !== stable(oldValues[0]))) fail(`合并 LINE/${id} 的既有属性 ${key} 冲突`);
						// A newly created merged LINE has no SDK zIndex setter. Preserve source zIndex
						// as evidence, but leave the host's effective order untouched. Existing LINE
						// ownership remains authoritative and is restored from its baseline.
						if (oldValues.length) patch[key] = oldValues[0];
						continue;
					}
					if (values.some(value => stable(value) !== stable(values[0]))) fail(`合并 LINE/${id} 的来源属性 ${key} 冲突`);
					if (oldValues.some(value => stable(value) !== stable(oldValues[0]))) fail(`合并 LINE/${id} 的既有属性 ${key} 冲突`);
					if (oldValues.length && (!values.length || stable(oldValues[0]) !== stable(values[0]))) { patch[key] = oldValues[0]; continue; }
					if (values.length) patch[key] = values[0];
				}
				targets.set(id, patch);
			}
			await patchNativeRecords([...targets].map(([id, patch]) => ({ type: 'LINE', id, patch })));
		},
		placeVia: async input => {
			const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid);
			const via = await api.pcb_PrimitiveVia.create(input.params.net, input.params.x, input.params.y, input.params.holeDiameter, input.params.diameter,
				(input.params.viaType ?? 0) as any, input.params.blindRuleName ?? '', input.params.solderMaskExpansion as any, input.params.primitiveLock ?? false);
			const id = via && stateOf<string | undefined>(via, 'getState_PrimitiveId'); if (!id) fail('VIA.create 未返回图元 ID');
			let verifiedSizeQuantization: Array<{ field: 'holeDiameter' | 'diameter'; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> = [];
			const verify = async () => {
				const all = await api.pcb_PrimitiveVia.getAll();
				const matches = (all ?? []).filter(item => stateOf<string>(item, 'getState_PrimitiveId') === id);
				const actual = matches.length === 1 ? matches[0] : undefined;
				if (!actual || stateOf<string>(actual, 'getState_PrimitiveId') !== id || stateOf<string>(actual, 'getState_Net') !== input.params.net
					|| !closeNumber(stateOf<number>(actual, 'getState_X'), input.params.x) || !closeNumber(stateOf<number>(actual, 'getState_Y'), input.params.y)
					|| stateOf<number>(actual, 'getState_ViaType') !== (input.params.viaType ?? 0)
					|| (stateOf<string | null>(actual, 'getState_DesignRuleBlindViaName') ?? '') !== (input.params.blindRuleName ?? '')
					|| stable(stateOf(actual, 'getState_SolderMaskExpansion') ?? null) !== stable(input.params.solderMaskExpansion ?? null)
					|| stateOf<boolean>(actual, 'getState_PrimitiveLock') !== (input.params.primitiveLock ?? false)) fail(`VIA/${id} typed getter几何、类型、规则、阻焊或锁定读回不符`);
				const quantization: Array<{ field: 'holeDiameter' | 'diameter'; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> = [];
				for (const [field, getter, fullExpected] of [
					['holeDiameter', 'getState_HoleDiameter', input.params.holeDiameter], ['diameter', 'getState_Diameter', input.params.diameter],
				] as const) {
					const size = stateOf<number>(actual, getter);
					const quantizedExpected = viaTypedDiameterValue(fullExpected);
					const epsilon = Number.EPSILON * Math.max(1, Math.abs(size), Math.abs(quantizedExpected));
					if (!Number.isFinite(size) || Math.abs(size - quantizedExpected) > epsilon) fail(`VIA/${id} ${field} typed getter量化值读回不符`);
					if (fullExpected !== quantizedExpected) quantization.push({ field, fullExpected, quantizedExpected, actual: size, formula: VIA_TYPED_SIZE_QUANTIZATION });
				}
				verifiedSizeQuantization = quantization;
				return quantization;
			};
			const createdTypedSizeQuantization = await verify();
			await patchNativeRecord('VIA', id, input.sourceData);
			const patchedTypedSizeQuantization = await verify();
			if (stable(createdTypedSizeQuantization) !== stable(patchedTypedSizeQuantization)) fail(`VIA/${id} native patch前后typed尺寸量化证据变化`);
			return { id, ...(createdTypedSizeQuantization.length ? { typedSizeQuantization: createdTypedSizeQuantization } : {}) };
		},
		preflightBlindRules: async (rules, before) => {
			const target = await assertBoundContext();
			const layerIds = new Set(before.records.filter(record => record.type === 'LAYER' && object(record.data) && record.data.use === true).map(record => object(record.data) ? record.data.layerId : undefined));
			for (const rule of rules) if (!layerIds.has(rule.startLayer) || !layerIds.has(rule.endLayer)) fail(`BLIND 规则 ${rule.name} 所需铜层在目标板不可用`);
			const identity = (record: NativeRecord): unknown[] | undefined => { try { const parsed = JSON.parse(record.id); return Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; } };
			const findRule = (kind: string, name: string) => before.records.find(record => record.type === 'RULE' && identity(record)?.[1] === kind && identity(record)?.[2] === name);
			const blind = findRule('BLIND', 'blindVia');
			if (!blind || !object(blind.data) || !object(blind.data.ruleContext) || !object(blind.data.ruleContext.blinds) || !Array.isArray(blind.data.ruleContext.blinds.content)) fail('目标板缺少 BLIND 规则记录');
			const current = await (api as any).pcb_Drc?.getCurrentRuleConfiguration?.();
			if (!object(current) || !object(current.config)) fail('无法读取当前 DRC typed configuration');
			const typedRows = blindTypedTable(current.config);
			if (!object(current.config.Physics)) fail('当前 DRC typed configuration 缺少 Physics');
			const typedPhysics = current.config.Physics as JsonObject;
			const viaGroup = typedPhysics['Via Size'];
			const missing: string[] = [];
			const sourceViaSizes = new Map<string, { native: JsonObject; typed: JsonObject }>();
			for (const rule of rules) {
				const sharedSize = sourceViaSizes.get(rule.viaSizeRule);
				if (sharedSize && (stable(sharedSize.native) !== stable(rule.viaSizeData)
					|| viaSizeSemantic(sharedSize.typed) !== viaSizeSemantic(rule.typedViaSizeConfig)))
					fail(`多个 BLIND 规则对共享 viaSize ${rule.viaSizeRule} 的来源配置不一致`);
				sourceViaSizes.set(rule.viaSizeRule, { native: rule.viaSizeData, typed: rule.typedViaSizeConfig });
				const nativeRows = (blind.data.ruleContext as JsonObject).blinds as JsonObject;
				const sourceBlindRows = ((rule.sourceData.ruleContext as JsonObject).blinds as JsonObject).content as unknown[];
				const sourceRows = sourceBlindRows.filter(item => object(item) && item.name === rule.name);
				if (sourceRows.length !== 1) fail(`来源 BLIND 规则 ${rule.name} 不唯一`);
				const nativeExisting = (nativeRows.content as unknown[]).filter(item => object(item) && item.name === rule.name);
				if (nativeExisting.length > 1 || (nativeExisting.length === 1 && nativeBlindRuleSemantic(nativeExisting[0]) !== nativeBlindRuleSemantic(sourceRows[0]))) fail(`同名原生 BLIND 规则 ${rule.name} 内容冲突`);
				const typedExisting = typedRows.filter(item => object(item) && item.name === rule.name);
				const expectedTyped = { name: rule.name, startLayer: rule.startLayer, endLayer: rule.endLayer, viaSizeRule: rule.viaSizeRule };
				if (typedExisting.length > 1 || (typedExisting.length === 1 && blindRuleSemantic(typedExisting[0]) !== blindRuleSemantic(expectedTyped))) fail(`同名 typed BLIND 规则 ${rule.name} 内容冲突`);
				const sizeRecord = findRule('RADIUS', rule.viaSizeRule);
				if (sizeRecord && stable(sizeRecord.data) !== stable(rule.viaSizeData)) fail(`原生 viaSize 规则 ${rule.viaSizeRule} 冲突`);
				const typedSize = object(viaGroup) ? viaGroup[rule.viaSizeRule] : undefined;
				if (typedSize !== undefined && viaSizeSemantic(typedSize) !== viaSizeSemantic(rule.typedViaSizeConfig)) fail(`typed viaSize 规则 ${rule.viaSizeRule} 尺寸/单位/状态冲突`);
				if (!typedExisting.length || typedSize === undefined || !nativeExisting.length || !sizeRecord) missing.push(rule.name);
			}
			pendingBlindRuleConfig = { projectUuid: target.projectUuid, pcbUuid: target.pcbUuid, config: current.config, before };
			return [...new Set(missing)];
		},
		ensureBlindRules: async (rules, before) => {
			const target = await assertBoundContext();
			const pending = pendingBlindRuleConfig;
			if (!pending || pending.projectUuid !== target.projectUuid || pending.pcbUuid !== target.pcbUuid || stable(pending.before) !== stable(before)) fail('BLIND 规则 preflight 已失效');
			const current = await (api as any).pcb_Drc?.getCurrentRuleConfiguration?.();
			if (!object(current) || !object(current.config) || stable(current.config) !== stable(pending.config)) fail('目标 DRC typed configuration 在 preflight 后发生变化');
			const identity = (record: NativeRecord): unknown[] | undefined => { try { const parsed = JSON.parse(record.id); return Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; } };
			const ruleRecord = (kind: string, name: string) => before.records.find(record => record.type === 'RULE' && identity(record)?.[1] === kind && identity(record)?.[2] === name);
			const blindRecord = ruleRecord('BLIND', 'blindVia');
			if (!blindRecord || !object(blindRecord.data) || !object(blindRecord.data.ruleContext) || !object(blindRecord.data.ruleContext.blinds)
				|| !Array.isArray(blindRecord.data.ruleContext.blinds.content)) fail('目标板缺少可追加的 BLIND 规则记录；停止写入');
			const originalBlind = blindRecord.data as JsonObject;
			const originalRows = (originalBlind.ruleContext as JsonObject).blinds as JsonObject;
			const rows = originalRows.content as unknown[];
			const currentSnapshot = await readSnapshot(target.projectUuid, target.pcbUuid);
			const currentBlind = currentSnapshot.records.find(record => record.type === 'RULE' && record.id === blindRecord.id);
			if (!currentBlind || stable(currentBlind.data) !== stable(blindRecord.data)) fail('目标 BLIND 原生记录在 preflight 后发生变化');
			for (const oldRule of before.records.filter(record => record.type === 'RULE')) {
				const currentRule = currentSnapshot.records.find(record => record.type === 'RULE' && record.id === oldRule.id);
				if (!currentRule || stable(currentRule.data) !== stable(oldRule.data) || headerWithoutTicket(currentRule.header) !== headerWithoutTicket(oldRule.header))
					fail(`官方 DRC overwrite 前既有 RULE 已变化：${oldRule.id}`);
			}
			const additions: unknown[] = [];
			const viaSizeAdditions = new Map<string, JsonObject>();
			const typedRows = blindTypedTable(current.config);
			const physics = current.config.Physics as JsonObject;
			const viaSizeGroup = physics['Via Size'];
			let nextConfig = JSON.parse(stable(current.config)) as JsonObject;
			const nextPhysics = nextConfig.Physics as JsonObject;
			const nextBlindGroup = nextPhysics['Blind/Buried Via'] as JsonObject;
			const nextBlindConfig = nextBlindGroup.blindVia as JsonObject;
			const nextTypedRows = [...typedRows];
			let configChanged = false;
			const typedConfigNormalizationDifferences: TypedConfigNumericDifference[] = [];
			const nativeSpacing = nativeDefaultHoleSpacing(before, current.config);
			for (const rule of rules) {
				const sourceRows = (rule.sourceData.ruleContext as JsonObject).blinds as JsonObject;
				const sourceRow = (sourceRows.content as unknown[]).filter(item => object(item) && item.name === rule.name);
				if (sourceRow.length !== 1) fail(`来源 BLIND 规则 ${rule.name} 不唯一`);
				const nativeExisting = rows.filter(item => object(item) && item.name === rule.name);
				if (nativeExisting.length > 1 || (nativeExisting.length === 1 && nativeBlindRuleSemantic(nativeExisting[0]) !== nativeBlindRuleSemantic(sourceRow[0]))) fail(`同名原生 BLIND 规则 ${rule.name} 冲突`);
				if (!nativeExisting.length) additions.push(sourceRow[0]);
				const expectedTypedRow = { name: rule.name, startLayer: rule.startLayer, endLayer: rule.endLayer, viaSizeRule: rule.viaSizeRule };
				const typedExisting = nextTypedRows.filter(item => object(item) && item.name === rule.name);
				if (typedExisting.length > 1 || (typedExisting.length === 1 && blindRuleSemantic(typedExisting[0]) !== blindRuleSemantic(expectedTypedRow))) fail(`同名 typed BLIND 规则 ${rule.name} 冲突`);
				if (!typedExisting.length) { nextTypedRows.push(expectedTypedRow); configChanged = true; }
				const size = ruleRecord('RADIUS', rule.viaSizeRule);
				if (size && stable(size.data) !== stable(rule.viaSizeData)) fail(`viaSize 规则 ${rule.viaSizeRule} 内容冲突`);
				if (!size) {
					const previous = viaSizeAdditions.get(rule.viaSizeRule);
					if (previous && stable(previous) !== stable(rule.viaSizeData)) fail(`多个 BLIND 规则要求的 viaSize ${rule.viaSizeRule} 来源内容冲突`);
					viaSizeAdditions.set(rule.viaSizeRule, rule.viaSizeData);
				}
				const targetSize = object(viaSizeGroup) ? viaSizeGroup[rule.viaSizeRule] : undefined;
				if (targetSize !== undefined && viaSizeSemantic(targetSize) !== viaSizeSemantic(rule.typedViaSizeConfig)) fail(`typed viaSize 规则 ${rule.viaSizeRule} 与来源冲突`);
				if (targetSize === undefined) {
					const nextSizeGroup = nextPhysics['Via Size'];
					if (!object(nextSizeGroup)) fail(`typed Via Size group 缺失：${rule.viaSizeRule}`);
					(nextSizeGroup as JsonObject)[rule.viaSizeRule] = JSON.parse(stable(rule.typedViaSizeConfig));
					configChanged = true;
				}
			}
			if (nextTypedRows.length !== typedRows.length) { nextBlindConfig.table = nextTypedRows; configChanged = true; }
			if (configChanged || additions.length || viaSizeAdditions.size) {
				await context(target.projectUuid, target.pcbUuid);
				if (await (api as any).pcb_Drc.overwriteCurrentRuleConfiguration(nextConfig) !== true) fail('overwriteCurrentRuleConfiguration 未返回 true');
				const readback = await (api as any).pcb_Drc.getCurrentRuleConfiguration();
				if (!object(readback) || !object(readback.config)) fail('DRC typed config overwrite 后无法读回');
				const actualTypedRows = blindTypedTable(readback.config);
				if (actualTypedRows.length !== nextTypedRows.length || typedRows.some((row, index) => stable(row) !== stable(actualTypedRows[index]))) fail('DRC typed config overwrite 改动了旧 blind row 或其顺序');
				for (const rule of rules) {
					const matches = actualTypedRows.filter(row => object(row) && row.name === rule.name);
					if (matches.length !== 1 || blindRuleSemantic(matches[0]) !== stable({ name: rule.name, startLayer: rule.startLayer, endLayer: rule.endLayer, viaSizeRule: rule.viaSizeRule })) fail(`DRC typed blind row 写后读回不符：${rule.name}`);
					const actualPhysics = readback.config.Physics as JsonObject;
					const actualGroup = actualPhysics['Via Size'];
					const sizeConfig = object(actualGroup) ? actualGroup[rule.viaSizeRule] : undefined;
					if (viaSizeSemantic(sizeConfig) !== viaSizeSemantic(rule.typedViaSizeConfig)) fail(`DRC typed viaSize 写后读回不符：${rule.viaSizeRule}`);
				}
				const actualConfigWithoutRuleRows = JSON.parse(stable(readback.config)) as JsonObject;
				const actualPhysics = actualConfigWithoutRuleRows.Physics as JsonObject;
				const actualBlindGroup = actualPhysics['Blind/Buried Via'] as JsonObject;
				(actualBlindGroup.blindVia as JsonObject).table = [...typedRows];
				const actualViaSizeGroup = actualPhysics['Via Size'];
				const originalViaSizeGroup = (current.config.Physics as JsonObject)['Via Size'];
				if (object(actualViaSizeGroup)) for (const rule of rules) {
					if (object(originalViaSizeGroup) && Object.hasOwn(originalViaSizeGroup, rule.viaSizeRule)) continue;
					delete actualViaSizeGroup[rule.viaSizeRule];
				}
				compareOfficialTypedConfigReadback(current.config, actualConfigWithoutRuleRows, '$', typedConfigNormalizationDifferences, nativeSpacing);
			}
			const expectedRows = [...rows, ...additions];
			const expectedContext = { ...(originalBlind.ruleContext as JsonObject), blinds: { ...originalRows, content: expectedRows } };
			const expectedNativeData = { ...originalBlind, ruleContext: expectedContext };
			const after = await readSnapshot(target.projectUuid, target.pcbUuid);
			const actual = after.records.find(record => record.type === 'RULE' && record.id === blindRecord.id);
			if (!actual || stable(actual.data) !== stable(expectedNativeData) || headerWithoutTicket(actual.header) !== headerWithoutTicket(blindRecord.header))
				fail('DRC typed configuration 写后 native BLIND 规则表、ruleState、其它字段或 header 不符');
			for (const oldRule of before.records.filter(record => record.type === 'RULE' && record.id !== blindRecord.id)) {
				const currentRule = after.records.find(record => record.type === 'RULE' && record.id === oldRule.id);
				if (!currentRule || stable(currentRule.data) !== stable(oldRule.data) || headerWithoutTicket(currentRule.header) !== headerWithoutTicket(oldRule.header))
					fail(`官方 DRC overwrite 改动了既有 native RULE：${oldRule.id}`);
			}
			const expectedViaSizeIds = new Set([...viaSizeAdditions.keys()].map(name => JSON.stringify(['RULE', 'RADIUS', name])));
			for (const record of after.records.filter(record => record.type === 'RULE' && !before.records.some(old => old.type === 'RULE' && old.id === record.id))) {
				if (!expectedViaSizeIds.has(record.id)) fail(`DRC overwrite 新增了未请求的 native RULE：${record.id}`);
				const name = identity(record)?.[2];
				if (typeof name !== 'string' || stable(record.data) !== stable(viaSizeAdditions.get(name))) fail(`DRC overwrite 新增 native viaSize ${String(name)} 内容不符`);
			}
			for (const [name, data] of viaSizeAdditions) {
				const id = JSON.stringify(['RULE', 'RADIUS', name]);
				const matches = after.records.filter(record => record.type === 'RULE' && record.id === id);
				if (matches.length !== 1 || stable(matches[0].data) !== stable(data)) fail(`native viaSize ${name} 写后读回缺失或不符`);
			}
			return { addedRules: additions.map(item => String(object(item) ? item.name : '')), addedViaSizeRules: [...viaSizeAdditions.keys()], typedConfigNormalizationDifferences };
		},
		placeArc: async input => {
			const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid);
			const raw = input.params;
			const arc = await api.pcb_PrimitiveArc.create(raw.net, raw.layer as any, raw.startX, raw.startY, raw.endX, raw.endY,
				raw.arcAngle, raw.lineWidth, raw.interactiveMode as any, raw.primitiveLock);
			const id = arc && stateOf<string | undefined>(arc, 'getState_PrimitiveId'); if (!id) fail('ARC.create 未返回图元 ID');
			const verify = async () => {
				const exact = await api.pcb_PrimitiveArc.get(id);
				if (!exact || stateOf<string>(exact, 'getState_PrimitiveId') !== id || stateOf<string>(exact, 'getState_Net') !== raw.net
					|| stateOf<number>(exact, 'getState_Layer') !== raw.layer || !closeNumber(stateOf<number>(exact, 'getState_ArcAngle'), raw.arcAngle, true)
					|| !closeNumber(stateOf<number>(exact, 'getState_LineWidth'), raw.lineWidth) || stateOf<number>(exact, 'getState_InteractiveMode') !== raw.interactiveMode
					|| stateOf<boolean>(exact, 'getState_PrimitiveLock') !== raw.primitiveLock) fail(`ARC/${id} typed getter状态读回不符`);
				const endpoints: Array<{ field: string; getter: string; expected: number }> = [
					{ field: 'startX', getter: 'getState_StartX', expected: raw.startX }, { field: 'startY', getter: 'getState_StartY', expected: raw.startY },
					{ field: 'endX', getter: 'getState_EndX', expected: raw.endX }, { field: 'endY', getter: 'getState_EndY', expected: raw.endY },
				];
				const quantization: Array<{ field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> = [];
				for (const endpoint of endpoints) {
					const actual = stateOf<number>(exact, endpoint.getter);
					const quantizedExpected = arcTypedEndpointValue(endpoint.expected);
					const epsilon = Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(quantizedExpected));
					if (!Number.isFinite(actual) || Math.abs(actual - quantizedExpected) > epsilon) fail(`ARC/${id} ${endpoint.field} typed getter量化值读回不符`);
					if (endpoint.expected !== quantizedExpected) quantization.push({ field: endpoint.field, fullExpected: endpoint.expected, quantizedExpected, actual, formula: ARC_TYPED_ENDPOINT_QUANTIZATION });
				}
				return quantization;
			};
			const createdTypedEvidence = await verify();
			await patchNativeRecord('ARC', id, input.sourceData);
			const patchedTypedEvidence = await verify();
			if (stable(createdTypedEvidence) !== stable(patchedTypedEvidence)) fail(`ARC/${id} native patch前后 typed端点量化证据变化`);
			return { id, ...(createdTypedEvidence.length ? { typedEndpointQuantization: createdTypedEvidence } : {}) };
		},
		placeStandalonePad: async input => {
			const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid);
			const raw = input.params;
			const pad = await api.pcb_PrimitivePad.create(raw.layer as any, raw.padNumber, raw.x, raw.y, raw.rotation, raw.pad as any,
				raw.net, raw.hole as any, raw.holeOffsetX ?? 0, raw.holeOffsetY ?? 0, raw.holeRotation ?? 0, raw.metallization as any,
				raw.padType as any, raw.specialPad as any, raw.maskExpansion as any, raw.heatWelding as any, raw.primitiveLock);
			const id = pad && stateOf<string | undefined>(pad, 'getState_PrimitiveId'); if (!id) fail('独立 PAD.create 未返回图元 ID');
			const followsNativeMaskRule = raw.maskExpansion === null || raw.maskExpansion === undefined;
			const nativeMaskFields = ['topSolderExpansion', 'bottomSolderExpansion', 'topPasteExpansion', 'bottomPasteExpansion'];
			if (followsNativeMaskRule && !nativeMaskFields.every(key => input.sourceData[key] === null)) fail(`PAD/${id} native 阻焊/锡膏字段不是跟随规则模式`);
			let verifiedMaskExpansion: unknown;
			let verifiedGeometryQuantization: Array<{ field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> = [];
			const verify = async () => {
				const exact = await api.pcb_PrimitivePad.get(id);
				if (!exact || stateOf<string>(exact, 'getState_PrimitiveId') !== id || stateOf<number>(exact, 'getState_Layer') !== raw.layer
					|| stateOf<string>(exact, 'getState_PadNumber') !== raw.padNumber
					|| stable(stateOf(exact, 'getState_Pad')) !== stable(raw.pad) || stateOf<string | undefined>(exact, 'getState_Net') !== raw.net
					|| stable(stateOf(exact, 'getState_Hole')) !== stable(raw.hole) || !closeNumber(stateOf<number>(exact, 'getState_HoleOffsetX'), raw.holeOffsetX ?? 0)
					|| !closeNumber(stateOf<number>(exact, 'getState_HoleOffsetY'), raw.holeOffsetY ?? 0) || !closeNumber(stateOf<number>(exact, 'getState_HoleRotation'), raw.holeRotation ?? 0, true)
					|| stateOf<boolean>(exact, 'getState_Metallization') !== raw.metallization || stateOf<number>(exact, 'getState_PadType') !== raw.padType
					|| stable(stateOf(exact, 'getState_SpecialPad') ?? null) !== stable(raw.specialPad ?? null)
					|| stable(stateOf(exact, 'getState_HeatWelding') ?? null) !== stable(raw.heatWelding ?? null)
					|| stateOf<boolean>(exact, 'getState_PrimitiveLock') !== raw.primitiveLock) fail(`PAD/${id} typed getter完整状态读回不符`);
				const endpoints: Array<{ field: string; getter: string; expected: number; rotation?: boolean }> = [
					{ field: 'x', getter: 'getState_X', expected: raw.x }, { field: 'y', getter: 'getState_Y', expected: raw.y },
					{ field: 'rotation', getter: 'getState_Rotation', expected: raw.rotation, rotation: true },
				];
				const quantization: Array<{ field: string; fullExpected: number; quantizedExpected: number; actual: number; formula: string }> = [];
				for (const endpoint of endpoints) {
					const actual = stateOf<number>(exact, endpoint.getter);
					const quantizedExpected = padTypedGeometryValue(endpoint.expected);
					const error = endpoint.rotation ? angleDelta(actual, quantizedExpected) : actual - quantizedExpected;
					const epsilon = Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(quantizedExpected));
					if (!Number.isFinite(actual) || Math.abs(error) > epsilon) fail(`PAD/${id} ${endpoint.field} typed getter量化值读回不符`);
					if (endpoint.expected !== quantizedExpected) quantization.push({ field: endpoint.field, fullExpected: endpoint.expected, quantizedExpected, actual, formula: PAD_TYPED_GEOMETRY_QUANTIZATION });
				}
				verifiedGeometryQuantization = quantization;
				const typedMaskExpansion = stateOf(exact, 'getState_SolderMaskAndPasteMaskExpansion') ?? null;
				if (followsNativeMaskRule) {
					const maskKeys = ['topSolderMask', 'bottomSolderMask', 'topPasteMask', 'bottomPasteMask'];
					if (!object(typedMaskExpansion) || !maskKeys.every(key => typeof typedMaskExpansion[key] === 'number' && Number.isFinite(typedMaskExpansion[key])))
						fail(`PAD/${id} 跟随规则的 typed 阻焊/锡膏有效值未读回`);
				} else if (stable(typedMaskExpansion) !== stable(raw.maskExpansion)) fail(`PAD/${id} 显式阻焊/锡膏扩展 typed getter 读回不符`);
				if (verifiedMaskExpansion !== undefined && stable(typedMaskExpansion) !== stable(verifiedMaskExpansion)) fail(`PAD/${id} typed 阻焊/锡膏有效值前后读回变化`);
				verifiedMaskExpansion = typedMaskExpansion;
			};
			await verify(); const createdTypedGeometryQuantization = verifiedGeometryQuantization;
			await patchNativeRecord('PAD', id, input.sourceData); await verify();
			if (stable(createdTypedGeometryQuantization) !== stable(verifiedGeometryQuantization)) fail(`PAD/${id} native patch前后typed坐标量化证据变化`);
			return { id, typedMaskExpansion: verifiedMaskExpansion, ...(createdTypedGeometryQuantization.length ? { typedGeometryQuantization: createdTypedGeometryQuantization } : {}) };
		},
		placeString: async input => {
			const raw = input.params;
			const layer = raw.layer === 'top-silk' ? 3 : 4;
			const alignModeByName: Record<string, number> = { LEFT_TOP: 1, LEFT_MIDDLE: 2, LEFT_BOTTOM: 3, CENTER_TOP: 4, CENTER: 5, CENTER_BOTTOM: 6, RIGHT_TOP: 7, RIGHT_MIDDLE: 8, RIGHT_BOTTOM: 9 };
			const alignMode = typeof raw.alignMode === 'number' ? raw.alignMode : raw.alignMode ? alignModeByName[raw.alignMode] : 5;
			if (!Number.isInteger(alignMode) || alignMode < 1 || alignMode > 9) fail(`STRING alignMode 无效：${String(raw.alignMode)}`);
			const target = await assertBoundContext(); await context(target.projectUuid, target.pcbUuid);
			const value = await api.pcb_PrimitiveString.create(layer as any, raw.x, raw.y, raw.text, raw.fontFamily ?? 'Arial', raw.fontSize, raw.lineWidth,
				alignMode as any, raw.rotation, raw.reverse ?? false, raw.expansion ?? 0, raw.mirror, false);
			const id = value && stateOf<string | undefined>(value, 'getState_PrimitiveId'); if (!id) fail('STRING.create 未返回图元 ID');
			await patchNativeRecord('STRING', id, input.sourceData); return { id };
		},
		modifyAttribute: async (targetId, key, patch) => {
			if (!boundTarget) fail('尚无已核验的目标 PCB 上下文');
			const snap = await readSnapshot(boundTarget.projectUuid, boundTarget.pcbUuid);
			const matches = snap.records.filter(record => record.type === 'ATTR' && object(record.data) && record.data.parentId === targetId && record.data.key === key);
			if (matches.length !== 1) fail(`ATTR ${String(patch.display.key)} 在组件 ${targetId} 下不唯一`);
			const attr = matches[0]; await patchNativeRecord('ATTR', attr.id, { value: patch.value, ...patch.display });
		},
		readAttribute: async (targetId, key) => {
			const target = await assertBoundContext(); const snap = await readSnapshot(target.projectUuid, target.pcbUuid);
			const record = snap.records.find(item => item.type === 'ATTR' && object(item.data) && item.data.parentId === targetId && item.data.key === key);
			if (!record || !object(record.data)) fail(`组件 ${targetId} ATTR 未读回`);
			const data = record.data;
			const display: JsonObject = {};
			for (const field of ['x', 'y', 'angle', 'keyVisible', 'valueVisible', 'specialColor', 'fontFamily', 'fontSize', 'strokeWidth', 'bold', 'italic', 'origin', 'reverse', 'expansion', 'mirror', 'locked'])
				if (Object.prototype.hasOwnProperty.call(data, field)) display[field] = data[field];
			return { id: record.id, parentId: String(data.parentId), key: String(data.key), value: data.value, display };
		},
		getOperation: id => api.sys_Storage.getExtensionUserConfig(operationKey(id)),
		setOperation: async (id, value) => {
			if (await api.sys_Storage.setExtensionUserConfig(operationKey(id), JSON.stringify(value)) !== true) fail('PCB 组合阶段记录写入未确认');
		},
	};
}

export function verifyNativeLineCoverage(lines: PreparedLine[], before: CompositionSnapshot, after: CompositionSnapshot): LineCoverage[] {
	const beforeLines = new Map(before.records.filter(item => item.type === 'LINE').map(item => [item.id, item]));
	const candidates = after.records.filter(item => item.type === 'LINE' && object(item.data)
		&& (!beforeLines.has(item.id) || stable(beforeLines.get(item.id)?.data) !== stable(item.data)));
	const result: LineCoverage[] = [];
	for (const line of lines) {
		if (line.points.length !== 2) fail(`当前已验证覆盖器只接受单段LINE：${line.sourceId}`);
		const [[x1, y1], [x2, y2]] = line.points; const dx = x2 - x1, dy = y2 - y1; const length2 = dx * dx + dy * dy;
		if (length2 <= 1e-12) fail(`LINE ${line.sourceId} 长度为零`);
		const intervals: Array<{ id: string; lo: number; hi: number }> = [];
		const distanceTolerance = 1e-3, projectionTolerance = distanceTolerance / Math.sqrt(length2);
		for (const record of candidates) {
			const d = record.data as JsonObject;
			if (d.netName !== line.net || d.layerId !== (line.layer === 'top' ? 1 : 2) || d.width !== line.width) continue;
			const ax = Number(d.startX), ay = Number(d.startY), bx = Number(d.endX), by = Number(d.endY);
			if (![ax, ay, bx, by].every(Number.isFinite)) continue;
			const crossA = Math.abs((ax - x1) * dy - (ay - y1) * dx) / Math.sqrt(length2), crossB = Math.abs((bx - x1) * dy - (by - y1) * dx) / Math.sqrt(length2);
			if (crossA > distanceTolerance || crossB > distanceTolerance) continue;
			const ta = ((ax - x1) * dx + (ay - y1) * dy) / length2, tb = ((bx - x1) * dx + (by - y1) * dy) / length2;
			const lo = Math.max(0, Math.min(ta, tb)), hi = Math.min(1, Math.max(ta, tb));
			if (hi - lo > 1e-10 || (Math.max(ta, tb) >= -projectionTolerance && Math.min(ta, tb) <= 1 + projectionTolerance)) intervals.push({ id: record.id, lo, hi });
		}
		intervals.sort((a, b) => a.lo - b.lo); let covered = 0;
		for (const item of intervals) { if (item.lo > covered + projectionTolerance) break; covered = Math.max(covered, item.hi); }
		if (covered < 1 - projectionTolerance) fail(`LINE ${line.sourceId} 实际几何未完整覆盖`);
		result.push({ sourceId: line.sourceId, targetIds: [...new Set(intervals.filter(item => item.hi > 0 && item.lo < 1).map(item => item.id))] });
	}
	for (const target of candidates) {
		const data = target.data as JsonObject;
		const baseline = before.records.filter(record => record.type === 'LINE' && object(record.data) && lineOverlap(data, record.data as JsonObject)).map(record => record.data as JsonObject);
		const requested = lines.map(line => line.sourceData);
		if (!segmentCoveredByLines(data, [...baseline, ...requested])) fail(`新建/变更 LINE/${target.id} 超出旧线路与请求线路的联合几何`);
	}
	return result;
}
