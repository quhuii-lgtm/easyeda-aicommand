import { parseSourceLog, resolveRecords } from './sourcelog';
import { isTransientGenerated3DModelTitleAttribute, type PcbCompositionInput, type PreparedAttribute, type PreparedStandalonePad, type JsonObject } from './pcbComposition';
import type { PadCopperState } from './pcbTemplatePhysical';

type ComponentNetlist = { props: Record<string, unknown>; pinInfoMap: Record<string, { number: string; net: string }> };
export type PcbCompositionPlanParams = {
	operationId: string;
	projectUuid: string;
	targetPcbUuid: string;
	sourcePcbUuid: string;
	source: string;
	sourcePads: Array<{ sourceUid: string; pads: PadCopperState[] }>;
	/** Actual library references returned by the source component getter after resource restoration. */
	deviceBindings: Array<{ sourceUid: string; component: { libraryUuid: string; uuid: string } }>;
	uidMappings: Array<{ sourceUid: string; targetUid: string }>;
	netMappings: Array<{ sourceNet: string; targetNet: string }>;
	targetComponents: Record<string, ComponentNetlist>;
	transform: { dx: number; dy: number; rotationDegrees: number };
	standalonePads?: Array<{ sourceId: string; data: JsonObject; typed: JsonObject }>;
	sourceArcCaptures?: Array<{ sourceId: string; typed: JsonObject }>;
	sourceViaCaptures?: Array<{ sourceId: string; typed: JsonObject }>;
	sourceRuleConfiguration?: JsonObject;
};

function object(value: unknown): value is JsonObject { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function finite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} 缺少有效坐标/尺寸`);
	return value;
}
function sdkTenth(value: unknown, name: string): number {
	return Math.round(finite(value, name) * 10 + 1e-10) / 10;
}
function sdkViaDiameter(value: unknown, name: string): number {
	return 2 * sdkTenth(finite(value, name) / 2, name);
}
function sameMachineNumber(value: number, expected: number): boolean {
	return Math.abs(value - expected) <= Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(expected));
}
function text(value: unknown, name: string): string {
	if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
	return value;
}

/** Pure preparation. It never opens documents, writes a design, or marks host acceptance complete. */
export function preparePcbComposition(params: PcbCompositionPlanParams): {
	input: PcbCompositionInput;
	unsupported: Array<{ type: string; id: string; reason: string }>;
	deferred: Array<{ type: string; id: string }>;
	retainedTargetSettings: Array<{ type: string; id: string }>;
} {
	const parsed = parseSourceLog(params.source);
	if (parsed.uuid !== params.sourcePcbUuid || parsed.docType.toUpperCase() !== 'PCB') throw new Error('来源 PCB 文档身份不符');
	const records = [...resolveRecords<JsonObject>(parsed).values()];
	const uidMap = new Map(params.uidMappings.map(item => [item.sourceUid, item.targetUid]));
	const bindings = new Map(params.deviceBindings.map(item => [item.sourceUid, item.component]));
	const nets = new Map(params.netMappings.map(item => [item.sourceNet, item.targetNet]));
	if (uidMap.size !== params.uidMappings.length || new Set(uidMap.values()).size !== uidMap.size) throw new Error('器件 UID 映射不唯一');
	if (bindings.size !== params.deviceBindings.length || nets.size !== params.netMappings.length) throw new Error('器件引用或网络映射重复');
	const { dx, dy, rotationDegrees } = params.transform;
	[dx, dy, rotationDegrees].forEach(value => finite(value, 'transform'));
	const radians = rotationDegrees * Math.PI / 180;
	const cos = Math.cos(radians), sin = Math.sin(radians);
	const point = (x: unknown, y: unknown): [number, number] => {
		const px = finite(x, 'x'), py = finite(y, 'y');
		return [px * cos - py * sin + dx, px * sin + py * cos + dy];
	};
	const net = (value: unknown): string => {
		const sourceNet = text(value, '网络');
		return nets.get(sourceNet) ?? sourceNet;
	};
	const input: PcbCompositionInput = { operationId: params.operationId, projectUuid: params.projectUuid, targetPcbUuid: params.targetPcbUuid,
		components: [], lines: [], vias: [], strings: [], attributes: [], arcs: [], standalonePads: [], requiredBlindRules: [] };
	input.sourceTypedRecords = [
		...(params.sourceArcCaptures ?? []).map(item => ({ type: 'ARC' as const, id: item.sourceId, state: item.typed })),
		...(params.standalonePads ?? []).map(item => ({ type: 'PAD' as const, id: item.sourceId, state: item.typed })),
	];
	const unsupported: Array<{ type: string; id: string; reason: string }> = [];
	const deferred: Array<{ type: string; id: string }> = [];
	const retainedTargetSettings: Array<{ type: string; id: string }> = [];
	const byRuleIdentity = new Map<string, (typeof records)[number]>();
	for (const record of records.filter(item => item.header.type === 'RULE')) {
		try { const key = JSON.parse(String(record.header.id)); if (Array.isArray(key) && key.length === 3) {
			const identity = `${key[1]}\0${key[2]}`;
			if (byRuleIdentity.has(identity)) throw new Error(`来源规则身份重复：${identity.replace('\0', '/')}`);
			byRuleIdentity.set(identity, record);
		} } catch (error) { if (error instanceof Error && error.message.startsWith('来源规则身份重复')) throw error; /* malformed unrelated rule is preserved and ignored */ }
	}
	const sourceRuleConfig = params.sourceRuleConfiguration;
	const sourcePhysics = sourceRuleConfig && object(sourceRuleConfig.Physics) ? sourceRuleConfig.Physics : undefined;
	const typedBlindTable = sourcePhysics && object(sourcePhysics['Blind/Buried Via']) && object(sourcePhysics['Blind/Buried Via'].blindVia)
		&& Array.isArray(sourcePhysics['Blind/Buried Via'].blindVia.table) ? sourcePhysics['Blind/Buried Via'].blindVia.table : undefined;
	const requiredByName = new Map<string, NonNullable<PcbCompositionInput['requiredBlindRules']>[number]>();
	const readBlindDependency = (name: string): NonNullable<PcbCompositionInput['requiredBlindRules']>[number] => {
		const blindRecord = byRuleIdentity.get('BLIND\0blindVia'); const sourceData = blindRecord?.data;
		if (!blindRecord || !object(sourceData) || !object(sourceData.ruleContext) || !object(sourceData.ruleContext.blinds) || !Array.isArray(sourceData.ruleContext.blinds.content)) throw new Error(`BLIND 规则 ${name} 缺少原生规则记录`);
		const rows = sourceData.ruleContext.blinds.content.filter((item: unknown) => object(item) && item.name === name);
		if (rows.length !== 1 || !object(rows[0])) throw new Error(`BLIND 规则 ${name} 原生行不唯一`);
		const row = rows[0]; const sizeName = text(row.viaSizeRule, `BLIND ${name} viaSizeRule`);
		const typedRows = typedBlindTable?.filter((item: unknown) => object(item) && item.name === name) ?? [];
		if (typedRows.length !== 1 || !object(typedRows[0])) throw new Error(`BLIND 规则 ${name} typed 配置行不唯一`);
		const typedRow = typedRows[0];
		if (finite(row.staLayerId, `BLIND ${name} staLayerId`) !== finite(typedRow.startLayer, `BLIND ${name} startLayer`)
			|| finite(row.endLayerId, `BLIND ${name} endLayerId`) !== finite(typedRow.endLayer, `BLIND ${name} endLayer`)
			|| sizeName !== text(typedRow.viaSizeRule, `BLIND ${name} typed viaSizeRule`)) throw new Error(`BLIND 规则 ${name} 原生行与 typed 配置不一致`);
		const sizeRecord = byRuleIdentity.get(`RADIUS\0${sizeName}`);
		if (!sizeRecord || !object(sizeRecord.data)) throw new Error(`BLIND ${name} 缺少 viaSize 规则 ${sizeName}`);
		const typedSize = sourcePhysics && object(sourcePhysics['Via Size']) ? sourcePhysics['Via Size'][sizeName] : undefined;
		if (!object(typedSize)) throw new Error(`BLIND ${name} 缺少 typed viaSize 配置 ${sizeName}`);
		return { name, startLayer: typedRow.startLayer as number, endLayer: typedRow.endLayer as number, viaSizeRule: sizeName,
			sourceData, viaSizeData: sizeRecord.data, typedViaSizeConfig: typedSize };
	};
	const owners = new Map<string, { sourceUid: string; targetUid: string; designator: string }>();
	for (const record of records.filter(item => item.header.type === 'COMPONENT')) {
		const data = record.data;
		if (!object(data) || !object(data.attrs)) throw new Error(`来源器件属性无效：${record.header.id}`);
		const sourceUid = text(data.attrs['Unique ID'], 'Unique ID');
		const targetUid = uidMap.get(sourceUid);
		const binding = bindings.get(sourceUid);
		const actual = targetUid && params.targetComponents[targetUid];
		if (!targetUid || !binding || !actual) throw new Error(`器件 ${sourceUid} 缺少实际目标网表或资源引用`);
		if (!binding.libraryUuid || !binding.uuid) throw new Error(`器件 ${sourceUid} 资源引用为空`);
		if (actual.props['Unique ID'] !== targetUid) throw new Error(`目标网表 UID 不符：${targetUid}`);
		const footprintAttrs = records.filter(item => item.header.type === 'ATTR' && object(item.data)
			&& item.data.parentId === record.header.id && item.data.key === 'Footprint');
		if (actual.props.Device !== binding.uuid || footprintAttrs.length !== 1 || !object(footprintAttrs[0].data)
			|| actual.props.Footprint !== footprintAttrs[0].data.value) throw new Error(`目标器件/封装与本次来源不符：${targetUid}；需要单独准备替换映射`);
		const designator = text(actual.props.Designator, 'Designator');
		const padRows = records.filter(item => item.header.type === 'PAD_NET').flatMap(item => {
			let identity: unknown;
			try { identity = JSON.parse(String(item.header.id)); } catch { throw new Error(`PAD_NET 标识无效：${item.header.id}`); }
			if (!Array.isArray(identity) || identity[0] !== 'PAD_NET') throw new Error('PAD_NET 标识结构无效');
			if (identity[1] !== record.header.id) return [];
			if (!object(item.data)) throw new Error('PAD_NET 数据无效');
			const number = String(identity[2]);
			const pin = actual.pinInfoMap[number];
			const sourceNet = text(item.data.padNet, 'PAD_NET.padNet');
			if (!pin || pin.number !== number || pin.net !== net(sourceNet)) throw new Error(`目标网表引脚网络与来源映射不一致：${targetUid}/${number}`);
			if (item.data.padLen !== null && typeof item.data.padLen !== 'number') throw new Error(`来源焊盘长度无效：${sourceUid}/${number}`);
			return [{ number, sourceNet, targetNet: pin.net, padLength: item.data.padLen }];
		});
		if (padRows.length !== Object.keys(actual.pinInfoMap).length) throw new Error(`目标网表引脚数量不同：${targetUid}`);
		const otherProperty: Record<string, unknown> = Object.create(null);
		const associationKeys = ['Reuse Block', 'Group ID', 'Channel ID', 'Relevance', 'Multi-Part Group'];
		for (const [key, value] of Object.entries(data.attrs)) if (!['DeviceName', 'Unique ID', ...associationKeys].includes(key)) otherProperty[key] = value;
		for (const key of associationKeys) {
			if (!Object.hasOwn(actual.props, key)) {
				if (['Reuse Block', 'Group ID', 'Channel ID'].includes(key)) throw new Error(`目标网表缺少关联属性：${targetUid}/${key}`);
				continue;
			}
			otherProperty[key] = actual.props[key];
		}
		const [x, y] = point(data.x, data.y);
		const sourcePadMatches = params.sourcePads.filter(item => item.sourceUid === sourceUid);
		if (sourcePadMatches.length !== 1 || sourcePadMatches[0].pads.length !== padRows.length) throw new Error(`来源焊盘几何缺失或数量不符：${sourceUid}`);
		const expectedPosePadGeometry = sourcePadMatches[0].pads.map(pad => {
			if (pad.geometryComplete !== true || !padRows.some(item => item.number === pad.padNumber && item.sourceNet === pad.net)
				|| typeof pad.layer !== 'number' || pad.shape === undefined || pad.hole === undefined || pad.specialPad === undefined
				|| typeof pad.holeOffsetX !== 'number' || typeof pad.holeOffsetY !== 'number' || typeof pad.holeRotation !== 'number')
				throw new Error(`来源焊盘几何不能完整读取：${sourceUid}/${pad.padNumber}`);
			const [px, py] = point(pad.x, pad.y);
			return { number: pad.padNumber, x: px, y: py, rotation: finite(pad.rotation, 'PAD rotation') + rotationDegrees,
				layer: pad.layer, shape: pad.shape, hole: pad.hole, specialPad: pad.specialPad,
				holeOffsetX: pad.holeOffsetX, holeOffsetY: pad.holeOffsetY, holeRotation: pad.holeRotation };
		});
		input.components.push({ sourceUid, targetUid, designator, component: { ...binding }, layer: finite(data.layerId, 'layerId'), x, y,
			rotation: finite(data.angle, 'angle') + rotationDegrees, primitiveLock: data.locked === true, pads: padRows, otherProperty, expectedPosePadGeometry });
		owners.set(String(record.header.id), { sourceUid, targetUid, designator });
	}
	if (owners.size !== uidMap.size) throw new Error('UID 映射包含来源之外的器件');
	const infrastructure = new Set(['META', 'LAYER', 'LAYER_PHYS', 'RULE', 'RULE_SELECTOR', 'NET', 'NET_CLASS', 'DIFFERENTIAL_PAIR', 'PRIMITIVE', 'GROUP', 'PAD_NET', 'COMPONENT', 'CANVAS', 'ACTIVE_LAYER', 'RULE_TEMPLATE', 'SILK_OPTS', 'D3_ATTRIBUTE', 'PREFERENCE', 'PANELIZE']);
	const excluded = new Set(['POUR', 'POURED']);
	for (const record of records) {
		const type = record.header.type, id = String(record.header.id), data = record.data;
		if (!object(data)) continue;
		if (infrastructure.has(type)) {
			if (!['PAD_NET', 'COMPONENT'].includes(type)) retainedTargetSettings.push({ type, id });
			continue;
		}
		if (excluded.has(type)) { deferred.push({ type, id }); continue; }
		if (type === 'LINE') {
			if (data.layerId !== 1 && data.layerId !== 2) { unsupported.push({ type, id, reason: '当前组合器尚未接通该线层' }); continue; }
			const start = point(data.startX, data.startY), end = point(data.endX, data.endY);
			input.lines.push({ sourceId: id, net: net(data.netName), points: [start, end], layer: data.layerId === 1 ? 'top' : 'bottom', width: finite(data.width, 'LINE width'),
				sourceData: { ...data, groupId: 0, netName: net(data.netName), startX: start[0], startY: start[1], endX: end[0], endY: end[1] } });
		} else if (type === 'VIA') {
			if (data.viaType !== 'NORMAL' && data.viaType !== 'BLIND') { unsupported.push({ type, id, reason: '当前组合器尚未接通该过孔类型；历史单项结果保留' }); continue; }
			const captured = params.sourceViaCaptures?.find(item => item.sourceId === id)?.typed;
			if (data.viaType === 'BLIND' && (!captured || captured.primitiveId !== id)) throw new Error(`来源 VIA typed getter 未按原生 ID 捕获：${id}`);
			const viaState = captured ?? (data.viaType === 'NORMAL' ? { primitiveId: id, net: data.netName, x: data.centerX, y: data.centerY,
				holeDiameter: sdkViaDiameter(data.holeDiameter, 'VIA native holeDiameter'), diameter: sdkViaDiameter(data.viaDiameter, 'VIA native viaDiameter'), viaType: 0, blindRuleName: null,
				solderMaskExpansion: data.topSolderExpansion === null && data.bottomSolderExpansion === null ? null : undefined, primitiveLock: data.locked === true } : undefined);
			if (!viaState || viaState.primitiveId !== id) throw new Error(`来源 VIA typed getter 未按原生 ID 捕获：${id}`);
			const viaType = finite(viaState.viaType, 'VIA viaType');
			if ((data.viaType === 'BLIND' && viaType !== 1) || (data.viaType === 'NORMAL' && viaType !== 0)) throw new Error(`来源 VIA ${id} 的 native/typed 类型不一致`);
			const [x, y] = point(data.centerX, data.centerY);
			const capturedNet = text(viaState.net, 'VIA net');
			if (capturedNet !== data.netName || Math.hypot(finite(viaState.x, 'VIA x') - finite(data.centerX, 'VIA centerX'),
				finite(viaState.y, 'VIA y') - finite(data.centerY, 'VIA centerY')) > 0.0001
				|| !sameMachineNumber(finite(viaState.holeDiameter, 'VIA holeDiameter'), sdkViaDiameter(data.holeDiameter, 'VIA native holeDiameter'))
				|| !sameMachineNumber(finite(viaState.diameter, 'VIA diameter'), sdkViaDiameter(data.viaDiameter, 'VIA native viaDiameter'))
				|| (viaState.primitiveLock === true) !== (data.locked === true)
				|| (data.topSolderExpansion === null && data.bottomSolderExpansion === null && viaState.solderMaskExpansion !== null)) throw new Error(`来源 VIA ${id} 的 native/typed 几何或网络不一致`);
			const ruleName = viaState.blindRuleName == null ? undefined : text(viaState.blindRuleName, 'VIA blindRuleName');
			if (data.viaType === 'BLIND') {
				if (!ruleName || ruleName !== data.ruleName) throw new Error(`来源盲埋 VIA ${id} 的 native/typed 规则不一致`);
				if (!requiredByName.has(ruleName)) requiredByName.set(ruleName, readBlindDependency(ruleName));
			} else if (ruleName) throw new Error(`普通 VIA ${id} 出现盲埋孔规则名`);
			input.vias.push({ sourceId: id, params: { net: net(capturedNet), x, y, holeDiameter: finite(data.holeDiameter, 'VIA native holeDiameter'), diameter: finite(data.viaDiameter, 'VIA native viaDiameter'),
				viaType, blindRuleName: ruleName, solderMaskExpansion: viaState.solderMaskExpansion, primitiveLock: viaState.primitiveLock === true },
				sourceData: { ...data, groupId: 0, netName: net(data.netName), centerX: x, centerY: y } });
		} else if (type === 'ARC') {
			const capture = params.sourceArcCaptures?.find(item => item.sourceId === id)?.typed;
			if (!capture || capture.primitiveId !== id) { unsupported.push({ type, id, reason: 'ARC 缺少按原生 ID 捕获的 typed 状态' }); continue; }
			const arcFields = [capture.layer, capture.startX, capture.startY, capture.endX, capture.endY, capture.arcAngle, capture.lineWidth];
			if (typeof capture.net !== 'string' || arcFields.some(value => typeof value !== 'number' || !Number.isFinite(value))
				|| capture.net !== data.netName || capture.layer !== data.layerId
				|| capture.startX !== sdkTenth(data.startX, 'ARC native startX') || capture.startY !== sdkTenth(data.startY, 'ARC native startY')
				|| capture.endX !== sdkTenth(data.endX, 'ARC native endX') || capture.endY !== sdkTenth(data.endY, 'ARC native endY') || capture.arcAngle !== data.angle || capture.lineWidth !== data.width
				|| (capture.primitiveLock === true) !== (data.locked === true)) {
				unsupported.push({ type, id, reason: 'ARC 原生状态与独立 typed 读回不完整或不一致' }); continue;
			}
			const start = point(data.startX, data.startY), end = point(data.endX, data.endY);
			const sourceData = { ...data, groupId: 0, netName: net(data.netName), startX: start[0], startY: start[1], endX: end[0], endY: end[1] };
			input.arcs!.push({ sourceId: id, params: { net: net(capture.net), layer: finite(capture.layer, 'ARC layer'), startX: start[0], startY: start[1], endX: end[0], endY: end[1],
				arcAngle: finite(capture.arcAngle, 'ARC arcAngle'), lineWidth: finite(capture.lineWidth, 'ARC lineWidth'), interactiveMode: finite(capture.interactiveMode, 'ARC interactiveMode'), primitiveLock: capture.primitiveLock === true }, sourceData });
		} else if (type === 'PAD' && data.num !== undefined && data.layerId === 12) {
			const captured = params.standalonePads?.find(item => item.sourceId === id);
			if (!captured) { unsupported.push({ type, id, reason: '独立 PAD 缺少按原生 ID 捕获的 typed 状态' }); continue; }
			const typed = captured.typed;
			const typedHole = typed.hole;
			const nativeHole = object(data.hole) ? data.hole : {};
			const holeMatches = Array.isArray(typedHole) && ((nativeHole.holeType === 'ROUND' && typedHole[0] === 'ROUND'
				&& typedHole[1] === nativeHole.width && nativeHole.width === nativeHole.height)
				|| (nativeHole.holeType === 'SLOT' && typedHole[0] === 'SLOT' && typedHole[1] === nativeHole.height && typedHole[2] === nativeHole.width));
			const nativePad = object(data.defaultPad) ? data.defaultPad : {};
			if (typed.primitiveId !== id || text(typed.padNumber, 'PAD number') !== data.num || text(typed.net, 'PAD net') !== (data.netName ?? '')
				|| finite(typed.layer, 'PAD layer') !== finite(data.layerId, 'PAD layerId') || finite(typed.x, 'PAD x') !== sdkTenth(data.centerX, 'PAD native centerX')
				|| finite(typed.y, 'PAD y') !== sdkTenth(data.centerY, 'PAD native centerY') || finite(typed.rotation, 'PAD rotation') !== sdkTenth(data.padAngle, 'PAD native rotation')
				|| !Array.isArray(typed.pad) || typed.pad[0] !== nativePad.padType || typed.pad[1] !== nativePad.width || typed.pad[2] !== nativePad.height
				|| !holeMatches || typeof typed.metallization !== 'boolean' || typed.metallization !== data.plated
				|| typed.holeOffsetX !== data.padOffsetX || typed.holeOffsetY !== data.padOffsetY
				|| typeof typed.holeRotation !== 'number' || Math.abs(typed.holeRotation - finite(data.relativeAngle, 'PAD relativeAngle')) > 1e-8
				|| (typed.primitiveLock === true) !== (data.locked === true)) throw new Error(`来源 PAD ${id} 的 native/typed 状态不一致`);
			const [x, y] = point(data.centerX, data.centerY);
			const padAngle = finite(data.padAngle, 'PAD native padAngle') + rotationDegrees;
			const sourceData = { ...data, groupId: 0, netName: net(data.netName ?? ''), centerX: x, centerY: y, padAngle };
			const nativeMaskIsDefault = ['topSolderExpansion', 'bottomSolderExpansion', 'topPasteExpansion', 'bottomPasteExpansion'].every(key => data[key] === null);
			const prepared: PreparedStandalonePad['params'] = { layer: finite(typed.layer, 'PAD layer'), padNumber: text(typed.padNumber, 'PAD number'), x, y,
				rotation: padAngle, pad: typed.pad, net: net(typed.net), hole: typed.hole,
				holeOffsetX: typeof typed.holeOffsetX === 'number' ? typed.holeOffsetX : null, holeOffsetY: typeof typed.holeOffsetY === 'number' ? typed.holeOffsetY : null,
				holeRotation: typeof typed.holeRotation === 'number' ? typed.holeRotation : null, metallization: typed.metallization, padType: typed.padType,
				specialPad: typed.specialPad ?? null, maskExpansion: nativeMaskIsDefault ? null : typed.maskExpansion ?? null, heatWelding: typed.heatWelding ?? null, primitiveLock: typed.primitiveLock === true };
			input.standalonePads!.push({ sourceId: id, params: prepared, sourceData });
		} else if (type === 'STRING') {
			if (data.layerId !== 3 && data.layerId !== 4) { unsupported.push({ type, id, reason: '当前组合器尚未接通该文字层' }); continue; }
			const [x, y] = point(data.x, data.y), angle = finite(data.angle, 'STRING angle') + rotationDegrees;
			input.strings.push({ sourceId: id, params: { x, y, text: text(data.text, 'STRING text'), layer: data.layerId === 3 ? 'top-silk' : 'bottom-silk',
				fontSize: finite(data.fontSize, 'fontSize'), lineWidth: finite(data.strokeWidth, 'strokeWidth'), rotation: angle, mirror: data.mirror === true },
				sourceData: { ...data, groupId: 0, x, y, angle, zIndex: -1 } });
		} else if (type === 'ATTR') {
			const owner = owners.get(String(data.parentId));
			if (!owner) { unsupported.push({ type, id, reason: '属性没有来源器件归属' }); continue; }
			// The initial host save removes these hidden, unpositioned generated 3D-title labels (A75-065).
			if (isTransientGenerated3DModelTitleAttribute(data)) continue;
			const display: PreparedAttribute['display'] = {};
			if (data.x !== null && data.y !== null) { const [x, y] = point(data.x, data.y); display.x = x; display.y = y; }
			else { display.x = data.x; display.y = data.y; }
			for (const key of ['keyVisible', 'valueVisible', 'specialColor', 'fontFamily', 'fontSize', 'strokeWidth', 'bold', 'italic', 'origin', 'reverse', 'expansion', 'mirror', 'locked']) if (Object.hasOwn(data, key)) display[key] = data[key];
			if (typeof data.angle === 'number') display.angle = ((finite(data.angle, 'ATTR angle') + rotationDegrees) % 360 + 360) % 360;
			input.attributes.push({ sourceId: id, parentUid: owner.targetUid, key: text(data.key, 'ATTR key'),
				value: data.key === 'Designator' ? owner.designator : data.value, display });
		} else unsupported.push({ type, id, reason: '该原生对象尚未接入本次组合器，不能静默丢弃' });
	}
	input.requiredBlindRules = [...requiredByName.values()];
	return { input, unsupported, deferred, retainedTargetSettings };
}
