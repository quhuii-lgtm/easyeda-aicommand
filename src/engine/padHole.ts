export type PadLayer = 'top' | 'bottom';
export type PadShape =
	| { shape: 'circle'; diameter: number }
	| { shape: 'rectangle'; width: number; height: number; cornerRadius: number };

export interface PadMaskExpansion {
	topSolderMask?: number;
	bottomSolderMask?: number;
	topPasteMask?: number;
	bottomPasteMask?: number;
}

export interface PlaceHoleInput {
	x: number;
	y: number;
	holeDiameter: number;
	plated: boolean;
	padDiameter?: number;
	net?: string;
	solderMaskAndPasteMaskExpansion?: PadMaskExpansion;
}

export interface PlacePadInput {
	x: number;
	y: number;
	layer: PadLayer;
	shape: PadShape['shape'];
	diameter?: number;
	width?: number;
	height?: number;
	cornerRadius?: number;
	net?: string;
	solderMaskAndPasteMaskExpansion?: PadMaskExpansion;
}

const commonKeys = new Set(['__docUuid', '_timeoutMs']);
const holeKeys = new Set(['x', 'y', 'holeDiameter', 'plated', 'padDiameter', 'net', 'solderMaskAndPasteMaskExpansion']);
const padKeys = new Set(['x', 'y', 'layer', 'shape', 'diameter', 'width', 'height', 'cornerRadius', 'net', 'solderMaskAndPasteMaskExpansion']);
const maskKeys = new Set(['topSolderMask', 'bottomSolderMask', 'topPasteMask', 'bottomPasteMask']);

function ensureOnlyKeys(params: Record<string, unknown>, allowed: Set<string>, command: string): void {
	for (const key of Object.keys(params)) {
		if (key === 'solderMaskOpen')
			throw new Error('solderMaskOpen 暂不支持：它不是 SDK 明确的扩展数值，未执行写入');
		if (!allowed.has(key) && !commonKeys.has(key))
			throw new Error(`${command} 不支持参数 ${key}`);
	}
}

function finiteNumber(value: unknown, key: string, positive = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0))
		throw new Error(`${key} 必须是${positive ? '大于 0 的' : ''}有限数值（PCB 单位 mil）`);
	return value;
}

function validateMaskExpansion(value: unknown): PadMaskExpansion | undefined {
	if (value === undefined)
		return undefined;
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('solderMaskAndPasteMaskExpansion 必须是 SDK 扩展数值对象');
	const input = value as Record<string, unknown>;
	for (const key of Object.keys(input)) {
		if (!maskKeys.has(key))
			throw new Error(`solderMaskAndPasteMaskExpansion 不支持字段 ${key}`);
		finiteNumber(input[key], `solderMaskAndPasteMaskExpansion.${key}`);
	}
	return { ...input } as PadMaskExpansion;
}

export function validatePlaceHole(params: Record<string, any>): PlaceHoleInput {
	ensureOnlyKeys(params, holeKeys, 'pcb.placeHole');
	const x = finiteNumber(params.x, 'x');
	const y = finiteNumber(params.y, 'y');
	const holeDiameter = finiteNumber(params.holeDiameter, 'holeDiameter', true);
	if (typeof params.plated !== 'boolean')
		throw new Error('plated 必须明确为 boolean；不会推断是否电镀');
	if (Object.hasOwn(params, 'net') && typeof params.net !== 'string')
		throw new Error('net 必须是字符串');
	const net = params.net as string | undefined;
	const hasPadDiameter = Object.hasOwn(params, 'padDiameter');
	const padDiameter = hasPadDiameter ? finiteNumber(params.padDiameter, 'padDiameter', true) : undefined;
	if (params.plated && padDiameter === undefined)
		throw new Error('plated=true 时必须明确提供 padDiameter；拒绝推断铜环尺寸');
	if (padDiameter !== undefined && padDiameter <= holeDiameter)
		throw new Error('padDiameter 必须大于 holeDiameter，才能形成正宽度焊盘');
	if (padDiameter === undefined && net !== undefined && net.length > 0)
		throw new Error('无铜机械孔不能绑定网络；请删除 net 或显式提供 padDiameter 创建带盘孔');
	const mask = validateMaskExpansion(params.solderMaskAndPasteMaskExpansion);
	if (padDiameter === undefined && mask !== undefined)
		throw new Error('纯机械孔没有焊盘阻焊扩展；请在 padDiameter 模式下使用该参数');
	return { x, y, holeDiameter, plated: params.plated, ...(padDiameter === undefined ? {} : { padDiameter }), ...(net === undefined ? {} : { net }), ...(mask === undefined ? {} : { solderMaskAndPasteMaskExpansion: mask }) };
}

export function validatePlacePad(params: Record<string, any>): PlacePadInput {
	ensureOnlyKeys(params, padKeys, 'pcb.placePad');
	const x = finiteNumber(params.x, 'x');
	const y = finiteNumber(params.y, 'y');
	if (params.layer !== 'top' && params.layer !== 'bottom')
		throw new Error('layer 必须明确为 top 或 bottom；多层焊盘不属于 pcb.placePad');
	if (params.shape !== 'circle' && params.shape !== 'rectangle')
		throw new Error('shape 必须是 circle 或 rectangle');
	if (Object.hasOwn(params, 'net') && typeof params.net !== 'string')
		throw new Error('net 必须是字符串');
	let shape: PadShape;
	if (params.shape === 'circle') {
		if (Object.hasOwn(params, 'width') || Object.hasOwn(params, 'height') || Object.hasOwn(params, 'cornerRadius'))
			throw new Error('圆形焊盘只接受 diameter，不接受 width/height/cornerRadius');
		shape = { shape: 'circle', diameter: finiteNumber(params.diameter, 'diameter', true) };
	}
	else {
		if (Object.hasOwn(params, 'diameter'))
			throw new Error('矩形焊盘使用 width 和 height，不接受 diameter');
		const width = finiteNumber(params.width, 'width', true);
		const height = finiteNumber(params.height, 'height', true);
		const cornerRadius = params.cornerRadius === undefined ? 0 : finiteNumber(params.cornerRadius, 'cornerRadius');
		if (cornerRadius < 0 || cornerRadius > Math.min(width, height) / 2)
			throw new Error('cornerRadius 必须在 0 到 min(width,height)/2 之间');
		shape = { shape: 'rectangle', width, height, cornerRadius };
	}
	const mask = validateMaskExpansion(params.solderMaskAndPasteMaskExpansion);
	return {
		x,
		y,
		layer: params.layer,
		...shape,
		...(params.net === undefined ? {} : { net: params.net }),
		...(mask === undefined ? {} : { solderMaskAndPasteMaskExpansion: mask }),
	};
}

export function padShapeForSdk(input: PadShape): [string, number, number] | [string, number, number, number] {
	return input.shape === 'circle'
		? ['ELLIPSE', input.diameter, input.diameter]
		: ['RECT', input.width, input.height, 200 * input.cornerRadius / Math.min(input.width, input.height)];
}

export function circlePolygonSource(x: number, y: number, diameter: number): ['CIRCLE', number, number, number] {
	return ['CIRCLE', x, y, diameter / 2];
}

export function stableJson(value: unknown): string {
	const stable = (item: any): any => Array.isArray(item)
		? item.map(stable)
		: item && typeof item === 'object'
			? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]))
			: item;
	return JSON.stringify(stable(value));
}

export function numbersEqual(actual: unknown, expected: number, tolerance = 1e-9): boolean {
	return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}
