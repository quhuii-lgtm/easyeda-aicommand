import type { ICommandDef } from '../../engine/types';
import type { GeometryHost } from '../geometryHost';
import type { CopperObstacle, Point } from './fanout-routing';
import { createGeometryHost } from '../geometryHost';
import { planRouteDetailed } from './fanout-routing';

type Direction = 'auto' | '8directions' | 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
type LayerName = 'top' | 'bottom';
interface FanoutInput {
	padIds?: string[];
	componentIds?: string[];
	net?: string;
	direction: Direction;
	layer?: LayerName;
	lineLength?: number;
	lineWidth?: number;
	viaDiameter?: number;
	holeDiameter?: number;
	clearance?: number;
	staggerLength: number;
}

interface PrimitivePlan {
	type: 'line' | 'via';
	start?: Point;
	end?: Point;
	center?: Point;
	net: string;
	layer?: number | 'all-copper';
	lineWidth?: number;
	diameter?: number;
	holeDiameter?: number;
	targetId: string;
}

interface PadInfo {
	id: string;
	componentId: string | null;
	number: string;
	net: string;
	layer: number;
	position: Point;
	rotation: number;
	shape: unknown;
	special: unknown;
	hole: unknown;
}

type LayerObstacle = CopperObstacle & { copperLayers?: number[]; ownerPadId?: string };
interface Collected { pads: PadInfo[]; obstacles: LayerObstacle[]; board: Point[][]; keepouts: Point[][]; copperLayers: number[]; warnings: string[]; complete: boolean }

const DIRS: Record<Exclude<Direction, 'auto' | '8directions'>, Point> = {
	N: { x: 0, y: 1 },
	NE: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
	E: { x: 1, y: 0 },
	SE: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
	S: { x: 0, y: -1 },
	SW: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
	W: { x: -1, y: 0 },
	NW: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
};
const ALL_DIRS = Object.values(DIRS);
const ANGLE_STEP_DEG = 10;

function stable(value: any): any {
	if (Array.isArray(value))
		return value.map(stable);
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) result[key] = stable(value[key]);
		return result;
	}
	return value;
}
function stableJson(value: unknown): string {
	return JSON.stringify(stable(value));
}
function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}
function positive(value: unknown): value is number {
	return finite(value) && value > 0;
}
function requiredState<T>(obj: any, getter: string, label: string): T {
	if (!obj || typeof obj[getter] !== 'function')
		throw new Error(`${label} 缺少 SDK getter ${getter}`);
	const result = obj[getter]() as T;
	if (result == null)
		throw new Error(`${label} 的 ${getter} 为空`);
	return result;
}
function state<T>(obj: any, getter: string): T | undefined {
	if (!obj || typeof obj[getter] !== 'function')
		return undefined;
	return obj[getter]() as T;
}

function normalizeInput(params: Record<string, any>): FanoutInput {
	const selectors = ['padIds', 'componentIds', 'net'].filter(key => params[key] != null);
	if (selectors.length !== 1)
		throw new Error('padIds、componentIds、net 必须且只能提供一项');
	const input: FanoutInput = {
		direction: params.direction == null ? 'auto' : String(params.direction) as Direction,
		staggerLength: params.staggerLength == null ? 0 : Number(params.staggerLength),
	};
	if (!['auto', '8directions', ...Object.keys(DIRS)].includes(input.direction))
		throw new Error('direction 仅支持 auto、8directions 或 N/NE/E/SE/S/SW/W/NW');
	if (!finite(input.staggerLength) || input.staggerLength < 0)
		throw new Error('staggerLength 必须是有限非负 mil 数值');
	if (params.padIds != null) {
		input.padIds = Array.isArray(params.padIds) ? params.padIds.map(String) : [String(params.padIds)];
		if (!input.padIds.length || input.padIds.some(id => !id))
			throw new Error('padIds 必须包含至少一个非空图元 ID');
	}
	if (params.componentIds != null) {
		input.componentIds = Array.isArray(params.componentIds) ? params.componentIds.map(String) : [String(params.componentIds)];
		if (!input.componentIds.length || input.componentIds.some(id => !id))
			throw new Error('componentIds 必须包含至少一个非空图元 ID');
	}
	if (params.net != null) {
		input.net = String(params.net);
		if (!input.net)
			throw new Error('net 不能为空');
	}
	if (params.layer != null) {
		input.layer = String(params.layer).toLowerCase() as LayerName;
		if (input.layer !== 'top' && input.layer !== 'bottom')
			throw new Error('layer 仅支持 top 或 bottom');
	}
	for (const key of ['lineLength', 'lineWidth', 'viaDiameter', 'holeDiameter', 'clearance'] as const) {
		if (params[key] != null) {
			const value = Number(params[key]);
			if (!positive(value))
				throw new Error(`${key} 必须是有限正数 mil`);
			input[key] = value;
		}
	}
	return input;
}

function dimensions(input: FanoutInput): { lineLength?: number; lineWidth?: number; viaDiameter?: number; holeDiameter?: number; clearance?: number; missing: string[] } {
	const values = {
		lineLength: input.lineLength,
		lineWidth: input.lineWidth,
		viaDiameter: input.viaDiameter,
		holeDiameter: input.holeDiameter,
		clearance: input.clearance,
	};
	const missing = Object.entries(values).filter(([, value]) => !positive(value)).map(([key]) => key);
	if (positive(values.viaDiameter) && positive(values.holeDiameter) && values.holeDiameter >= values.viaDiameter)
		missing.push('holeDiameter (< viaDiameter)');
	return { ...values, missing };
}

function rotate(p: Point, degrees: number, center: Point): Point {
	const a = degrees * Math.PI / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	const x = p.x - center.x;
	const y = p.y - center.y;
	return { x: center.x + x * c - y * s, y: center.y + x * s + y * c };
}
function polygonSource(source: unknown): Point[][] | undefined {
	const sets = Array.isArray(source) && Array.isArray(source[0]) ? source as unknown[][] : [source as unknown[]];
	const output: Point[][] = [];
	for (const raw of sets) {
		if (!Array.isArray(raw) || raw.length === 0)
			return undefined;
		if (raw[0] === 'R' && raw.length >= 5) {
			const [, x, y, w, h, rotation = 0] = raw as [string, number, number, number, number, number];
			if (![x, y, w, h, rotation].every(finite) || w <= 0 || h <= 0)
				return undefined;
			const center = { x: x + w / 2, y: y + h / 2 };
			output.push([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(point => rotate(point, rotation, center)));
			continue;
		}
		const points: Point[] = [];
		for (let index = 0; index < raw.length;) {
			if (finite(raw[index]) && finite(raw[index + 1])) {
				points.push({ x: raw[index] as number, y: raw[index + 1] as number });
				index += 2;
				continue;
			}
			if (raw[index] === 'L') {
				index++;
				continue;
			}
			if (raw[index] === 'ARC' || raw[index] === 'CARC' || raw[index] === 'C')
				return undefined;
			return undefined;
		}
		if (points.length < 3)
			return undefined;
		output.push(points);
	}
	return output.length ? output : undefined;
}

function padPolygon(pad: PadInfo, layer?: number): Point[][] | undefined {
	let shape = pad.shape;
	if (Array.isArray(pad.special)) {
		const matches = (pad.special as any[]).filter(entry => Array.isArray(entry) && entry.length === 3 && layer != null && Number(entry[0]) <= layer && Number(entry[1]) >= layer);
		if (matches.length > 1)
			return undefined;
		if (matches.length === 1)
			shape = matches[0][2];
	}
	if (!Array.isArray(shape) || typeof shape[0] !== 'string')
		return undefined;
	const type = shape[0].toUpperCase();
	const w = Number(shape[1]);
	const h = Number(shape[2]);
	if (type === 'POLYLINE_COMPLEX_POLYGON') {
		const polys = polygonSource(shape[1]);
		return polys?.map(poly => poly.map(point => rotate({ x: pad.position.x + point.x, y: pad.position.y + point.y }, pad.rotation, pad.position)));
	}
	if (!positive(w) || !positive(h))
		return undefined;
	let local: Point[];
	if (type === 'RECTANGLE') {
		const round = Number(shape[3] ?? 0);
		if (!finite(round) || round < 0 || round > Math.min(w, h) / 2)
			return undefined;
		if (round > 0) {
			local = [];
			for (const [cx, cy, start] of [[w / 2 - round, h / 2 - round, 0], [-w / 2 + round, h / 2 - round, 90], [-w / 2 + round, -h / 2 + round, 180], [w / 2 - round, -h / 2 + round, 270]] as number[][]) {
				for (let i = 0; i <= 9; i++) {
					const a = (start + i * 90 / 9) * Math.PI / 180;
					local.push({ x: cx + round * Math.cos(a), y: cy + round * Math.sin(a) });
				}
			}
		}
		else {
			local = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
		}
	}
	else if (type === 'ELLIPSE') {
		local = Array.from({ length: 36 }, (_, i) => ({ x: w / 2 * Math.cos(i * 2 * Math.PI / 36), y: h / 2 * Math.sin(i * 2 * Math.PI / 36) }));
	}
	else if (type === 'OBLONG') {
		local = [];
		const r = Math.min(w, h) / 2;
		const half = Math.abs(w - h) / 2;
		const horizontal = w >= h;
		for (let i = 0; i <= 18; i++) {
			const a = (horizontal ? -90 : 0) + i * 180 / 18;
			const center = horizontal ? { x: half, y: 0 } : { x: 0, y: half };
			local.push({ x: center.x + r * Math.cos(a * Math.PI / 180), y: center.y + r * Math.sin(a * Math.PI / 180) });
		}
		for (let i = 0; i <= 18; i++) {
			const a = (horizontal ? 90 : 180) + i * 180 / 18;
			const center = horizontal ? { x: -half, y: 0 } : { x: 0, y: -half };
			local.push({ x: center.x + r * Math.cos(a * Math.PI / 180), y: center.y + r * Math.sin(a * Math.PI / 180) });
		}
	}
	else if (type === 'REGULAR_POLYGON') {
		const sides = Math.round(h);
		if (sides < 3 || sides !== h)
			return undefined;
		local = Array.from({ length: sides }, (_, i) => ({ x: w / 2 * Math.cos(2 * Math.PI * i / sides), y: w / 2 * Math.sin(2 * Math.PI * i / sides) }));
	}
	else {
		return undefined;
	}
	return [local.map(point => rotate({ x: point.x + pad.position.x, y: point.y + pad.position.y }, pad.rotation, pad.position))];
}

function padApproximationMargin(pad: PadInfo): number {
	const shape = Array.isArray(pad.shape) ? pad.shape : [];
	if (typeof shape[0] !== 'string')
		return 0;
	const type = shape[0].toUpperCase();
	const width = Number(shape[1]);
	const height = Number(shape[2]);
	if (!positive(width) || !positive(height))
		return 0;
	const sagittaFactor = 1 - Math.cos(ANGLE_STEP_DEG * Math.PI / 360);
	if (type === 'ELLIPSE')
		return Math.max(width, height) / 2 * sagittaFactor;
	if (type === 'OBLONG')
		return Math.min(width, height) / 2 * sagittaFactor;
	if (type === 'RECTANGLE' && Number(shape[3]) > 0)
		return Number(shape[3]) * sagittaFactor;
	return 0;
}

function padToInfo(obj: any): PadInfo {
	const id = requiredState<string>(obj, 'getState_PrimitiveId', '焊盘');
	const x = requiredState<number>(obj, 'getState_X', `焊盘 ${id}`);
	const y = requiredState<number>(obj, 'getState_Y', `焊盘 ${id}`);
	const layer = requiredState<number>(obj, 'getState_Layer', `焊盘 ${id}`);
	const shape = state<unknown>(obj, 'getState_Pad');
	const special = state<unknown>(obj, 'getState_SpecialPad');
	const hole = state<unknown>(obj, 'getState_Hole');
	return {
		id,
		componentId: state<string>(obj, 'getState_ParentComponentPrimitiveId') ?? null,
		number: String(state<string>(obj, 'getState_PadNumber') ?? ''),
		net: String(state<string>(obj, 'getState_Net') ?? ''),
		layer,
		position: { x, y },
		rotation: Number(state<number>(obj, 'getState_Rotation') ?? 0),
		shape,
		special,
		hole,
	};
}

function polygonBounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
	return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
}
function arcPoints(start: Point, end: Point, angle: number): { points: Point[]; error: number } {
	if (!finite(angle) || Math.abs(angle) < 1e-8)
		return { points: [start, end], error: 0 };
	const chord = Math.hypot(end.x - start.x, end.y - start.y);
	const sweep = angle * Math.PI / 180;
	if (chord <= 0 || Math.abs(sweep) >= 2 * Math.PI)
		return { points: [], error: Infinity };
	const offset = chord / (2 * Math.tan(sweep / 2));
	const center = { x: (start.x + end.x) / 2 - (end.y - start.y) / chord * offset, y: (start.y + end.y) / 2 + (end.x - start.x) / chord * offset };
	const radius = Math.hypot(start.x - center.x, start.y - center.y);
	const a0 = Math.atan2(start.y - center.y, start.x - center.x);
	const steps = Math.max(1, Math.ceil(Math.abs(angle) / ANGLE_STEP_DEG));
	const points = Array.from({ length: steps + 1 }, (_, i) => {
		const a = a0 + sweep * i / steps;
		return { x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) };
	});
	return { points, error: radius * (1 - Math.cos(Math.abs(sweep) / steps / 2)) };
}
function outlinePaths(lines: any[]): { polygons: Point[][]; open: boolean } {
	const paths = lines.map((line) => {
		const angle = state<number>(line, 'getState_ArcAngle');
		if (!finite(angle))
			return { points: [], error: Number.POSITIVE_INFINITY };
		return arcPoints(
			{ x: requiredState(line, 'getState_StartX', '板框线'), y: requiredState(line, 'getState_StartY', '板框线') },
			{ x: requiredState(line, 'getState_EndX', '板框线'), y: requiredState(line, 'getState_EndY', '板框线') },
			angle,
		);
	});
	if (paths.some(path => path.points.length < 2 || path.error > 0))
		return { polygons: [], open: true };
	const remaining = paths.map(path => path.points);
	const polygons: Point[][] = [];
	const key = (p: Point) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
	while (remaining.length) {
		const path = remaining.shift()!;
		let changed = true;
		while (changed && key(path[0]) !== key(path.at(-1)!)) {
			changed = false;
			for (let i = 0; i < remaining.length; i++) {
				const candidate = remaining[i];
				if (key(path.at(-1)!) === key(candidate[0]))
					path.push(...candidate.slice(1));
				else if (key(path.at(-1)!) === key(candidate.at(-1)!))
					path.push(...candidate.slice(0, -1).reverse());
				else continue;
				remaining.splice(i, 1);
				changed = true;
				break;
			}
		}
		if (path.length >= 4 && key(path[0]) === key(path.at(-1)!))
			polygons.push(path.slice(0, -1));
		else return { polygons: [], open: true };
	}
	return { polygons, open: polygons.length === 0 };
}

function getPolygonState(obj: any): unknown {
	const polygon = requiredState<any>(obj, 'getState_ComplexPolygon', '铜图元');
	return typeof polygon?.getSource === 'function' ? polygon.getSource() : polygon;
}
function layerOf(obj: any, label: string): number {
	return requiredState<number>(obj, 'getState_Layer', label);
}

async function collect(host: GeometryHost): Promise<Collected> {
	const sdk = host.sdk;
	const [regularPads, components, lines, arcs, vias, fills, pours, poured, regions, layers, holeLines, polylines] = await Promise.all([
		host.read('读取全部独立焊盘', () => sdk.pcb_PrimitivePad.getAll()),
		host.read('读取全部器件', () => sdk.pcb_PrimitiveComponent.getAll()),
		host.read('读取全部走线', () => sdk.pcb_PrimitiveLine.getAll()),
		host.read('读取全部圆弧', () => sdk.pcb_PrimitiveArc.getAll()),
		host.read('读取全部过孔', () => sdk.pcb_PrimitiveVia.getAll()),
		host.read('读取全部填充', () => sdk.pcb_PrimitiveFill.getAll()),
		host.read('读取全部覆铜', () => sdk.pcb_PrimitivePour.getAll()),
		host.read('读取全部覆铜实填充', () => sdk.pcb_PrimitivePoured.getAll()),
		host.read('读取全部禁止/约束区', () => sdk.pcb_PrimitiveRegion.getAll()),
		host.read('读取铜层栈', () => sdk.pcb_Layer.getAllLayers()),
		host.read('读取板内孔边界', () => sdk.pcb_PrimitiveLine.getAll(undefined, 47 as any)),
		host.read('读取折线图元', () => sdk.pcb_PrimitivePolyline.getAll()),
	]);
	const collections = [regularPads, components, lines, arcs, vias, fills, pours, poured, regions, layers, holeLines, polylines];
	if (collections.some(items => !Array.isArray(items)))
		throw new Error('必需 PCB 图元或铜层查询未返回数组，障碍采集不完整');
	const copperLayers = (layers as any[]).filter(layer => layer?.type === 'SIGNAL' || layer?.type === 'PLANE').map(layer => layer.id);
	if (copperLayers.length < 2 || copperLayers.some(id => !Number.isInteger(id)))
		throw new Error('SDK 铜层栈缺失或层身份无效');
	const pads = new Map<string, PadInfo>();
	for (const pad of regularPads ?? []) {
		const info = padToInfo(pad);
		pads.set(info.id, info);
	}
	for (const component of components ?? []) {
		const componentId = requiredState<string>(component, 'getState_PrimitiveId', '器件');
		const pins = await host.read(`读取器件 ${componentId} 所有焊盘`, () => component.getAllPins());
		if (!Array.isArray(pins))
			throw new Error(`器件 ${componentId} 的 getAllPins 未返回数组`);
		for (const pin of pins) {
			const info = padToInfo(pin);
			pads.set(info.id, { ...info, componentId });
		}
	}
	const warnings: string[] = ['椭圆、圆角矩形和长圆焊盘按弦高余量向外膨胀；独立圆弧走线按弦高余量膨胀。曲线铜面/区域及弧形板框/孔边界不支持，发现时计划不可执行。'];
	let complete = true;
	const obstacles: LayerObstacle[] = [];
	const keepouts: Point[][] = [];
	const allPads = [...pads.values()];
	for (const pad of allPads) {
		const polygons = padPolygon(pad);
		if (pad.special != null && (!Array.isArray(pad.special) || pad.special.some(entry => !Array.isArray(entry) || entry.length !== 3))) {
			complete = false;
			warnings.push(`焊盘 ${pad.id} 特殊层外形无法解析`);
		}
		if (!pad.net)
			warnings.push(`焊盘 ${pad.id} 网络为空；规划将其作为所有网络均需避让的障碍`);
		if (!polygons) {
			complete = false;
			warnings.push(`焊盘 ${pad.id} 的外形无法解析`);
			continue;
		}
		for (const points of polygons) obstacles.push({ type: 'polygon', points, margin: padApproximationMargin(pad), net: '', bounds: polygonBounds(points), copperLayers: pad.layer === 12 || pad.hole != null ? copperLayers : [pad.layer], ownerPadId: pad.id });
		if (Array.isArray(pad.special)) {
			for (const entry of pad.special as any[]) {
				if (!Array.isArray(entry) || entry.length !== 3 || !Number.isInteger(entry[0]) || !Number.isInteger(entry[1])) {
					complete = false;
					warnings.push(`焊盘 ${pad.id} 特殊层外形无法解析`);
					continue;
				}
				const specialPolygons = padPolygon({ ...pad, shape: entry[2], special: undefined });
				if (!specialPolygons) {
					complete = false;
					warnings.push(`焊盘 ${pad.id} 特殊层外形无法采样`);
					continue;
				}
				const specialLayers = copperLayers.filter(id => Number(entry[0]) <= id && Number(entry[1]) >= id);
				for (const points of specialPolygons) obstacles.push({ type: 'polygon', points, margin: padApproximationMargin({ ...pad, shape: entry[2] }), net: '', bounds: polygonBounds(points), copperLayers: specialLayers, ownerPadId: pad.id });
			}
		}
		if (pad.hole != null) {
			const hole = pad.hole as any;
			if (!Array.isArray(hole) || !positive(hole[1])) {
				complete = false;
				warnings.push(`焊盘 ${pad.id} 的孔形状未知`);
			}
		}
	}
	for (const line of lines ?? []) {
		const layer = layerOf(line, '走线');
		const start = { x: requiredState<number>(line, 'getState_StartX', '走线'), y: requiredState<number>(line, 'getState_StartY', '走线') };
		const end = { x: requiredState<number>(line, 'getState_EndX', '走线'), y: requiredState<number>(line, 'getState_EndY', '走线') };
		const width = requiredState<number>(line, 'getState_LineWidth', '走线');
		if (!positive(width)) {
			complete = false;
			warnings.push('走线宽度无效');
			continue;
		}
		if (layer === 11)
			continue;
		if (copperLayers.includes(layer))
			obstacles.push({ type: 'segment', start, end, radius: width / 2, net: '', copperLayers: [layer] });
	}
	for (const arc of arcs ?? []) {
		const layer = layerOf(arc, '圆弧');
		if (layer === 11 || layer === 47) {
			complete = false;
			warnings.push(`发现独立圆弧图元位于板框/板内孔层 ${layer}，当前无法合并到闭合边界`);
			continue;
		}
		const { points, error } = arcPoints(
			{ x: requiredState<number>(arc, 'getState_StartX', '圆弧'), y: requiredState<number>(arc, 'getState_StartY', '圆弧') },
			{ x: requiredState<number>(arc, 'getState_EndX', '圆弧'), y: requiredState<number>(arc, 'getState_EndY', '圆弧') },
			Number(requiredState<number>(arc, 'getState_ArcAngle', '圆弧')),
		);
		const width = requiredState<number>(arc, 'getState_LineWidth', '圆弧');
		if (points.length < 2 || !positive(width)) {
			complete = false;
			warnings.push('圆弧几何/线宽无法解析');
			continue;
		}
		if (copperLayers.includes(layer)) {
			for (let i = 1; i < points.length; i++) obstacles.push({ type: 'segment', start: points[i - 1], end: points[i], radius: width / 2 + error, net: '', copperLayers: [layer] });
		}
	}
	for (const via of vias ?? []) {
		const id = requiredState<string>(via, 'getState_PrimitiveId', '过孔');
		const type = requiredState<number>(via, 'getState_ViaType', `过孔 ${id}`);
		if (type !== 0) {
			complete = false;
			warnings.push(`现有过孔 ${id} 不是通孔；其跨层范围无法由本版本安全确认`);
		}
		const x = requiredState<number>(via, 'getState_X', `过孔 ${id}`);
		const y = requiredState<number>(via, 'getState_Y', `过孔 ${id}`);
		const diameter = requiredState<number>(via, 'getState_Diameter', `过孔 ${id}`);
		if (!positive(diameter)) {
			complete = false;
			warnings.push(`过孔 ${id} 外径无效`);
			continue;
		}
		obstacles.push({ type: 'circle', center: { x, y }, radius: diameter / 2, net: '', copperLayers });
	}
	for (const item of [...(fills ?? []), ...(pours ?? [])]) {
		const layer = layerOf(item, '铜填充');
		const src = getPolygonState(item);
		const polygons = polygonSource(src);
		if (!polygons) {
			complete = false;
			warnings.push('填充/覆铜复杂多边形无法完整读取');
			continue;
		}
		const marginRaw = state<number>(item, 'getState_LineWidth') ?? 0;
		if (!finite(marginRaw) || marginRaw < 0) {
			complete = false;
			warnings.push('填充/覆铜线宽无效');
			continue;
		}
		if (!copperLayers.includes(layer)) {
			complete = false;
			warnings.push(`填充/覆铜出现非铜层 ID ${layer}`);
			continue;
		}
		for (const points of polygons) obstacles.push({ type: 'polygon', points, margin: marginRaw / 2, bounds: polygonBounds(points), net: '', copperLayers: [layer] });
	}
	const pourById = new Map((pours as any[]).map(pour => [requiredState<string>(pour, 'getState_PrimitiveId', '覆铜边框'), pour]));
	for (const item of poured as any[]) {
		const pourId = requiredState<string>(item, 'getState_PourPrimitiveId', '覆铜实填充');
		const sourcePour = pourById.get(pourId);
		if (!sourcePour) {
			complete = false;
			warnings.push(`覆铜实填充 ${requiredState<string>(item, 'getState_PrimitiveId', '覆铜实填充')} 找不到边框 ${pourId}`);
			continue;
		}
		const layer = layerOf(sourcePour, `覆铜 ${pourId}`);
		if (!copperLayers.includes(layer)) {
			complete = false;
			warnings.push(`覆铜实填充 ${pourId} 的铜层 ID 无效`);
			continue;
		}
		const regions = requiredState<any[]>(item, 'getState_PourFills', `覆铜实填充 ${pourId}`);
		if (!Array.isArray(regions)) {
			complete = false;
			warnings.push(`覆铜实填充 ${pourId} 子区域列表无效`);
			continue;
		}
		for (const fill of regions) {
			if (fill?.fill !== true)
				continue;
			const polygons = polygonSource(getPolygonState({ getState_ComplexPolygon: () => fill.path }));
			if (!polygons || !positive(fill.lineWidth)) {
				complete = false;
				warnings.push(`覆铜实填充 ${pourId} 中有无法读取的填充区域`);
				continue;
			}
			for (const points of polygons) obstacles.push({ type: 'polygon', points, margin: fill.lineWidth / 2, bounds: polygonBounds(points), net: '', copperLayers: [layer] });
		}
	}
	for (const polyline of polylines as any[]) {
		const layer = layerOf(polyline, '折线图元');
		if (copperLayers.includes(layer)) {
			complete = false;
			warnings.push('发现铜层折线图元，当前安全障碍转换未覆盖');
		}
	}
	const boardLines = (lines as any[]).filter((line: any) => layerOf(line, '板框线') === 11);
	const boardGeometry = outlinePaths(boardLines);
	if (boardLines.length === 0 || boardGeometry.open) {
		complete = false;
		warnings.push('板框线未形成完整闭合直线边界，弧形板框当前不支持安全规划');
	}
	const holes = outlinePaths(holeLines as any[]);
	if ((holeLines as any[]).length && holes.open) {
		complete = false;
		warnings.push('板内孔边界未形成完整闭合直线边界，弧形孔边界当前不支持安全规划');
	}
	keepouts.push(...holes.polygons);
	for (const region of regions ?? []) {
		const types = requiredState<number[]>(region, 'getState_RuleType', '区域');
		const layer = layerOf(region, '区域');
		if (!Array.isArray(types)) {
			complete = false;
			warnings.push('区域规则类型无法识别');
			continue;
		}
		if (types.includes(5)) {
			const polygons = polygonSource(getPolygonState(region));
			if (!polygons) {
				complete = false;
				warnings.push('布线禁止区域几何无法解析');
				continue;
			}
			keepouts.push(...polygons);
		}
		else if (types.some(type => type !== 6 && type !== 7 && type !== 8)) {
			complete = false;
			warnings.push(`发现层 ${layer} 的未识别约束区域，无法确认是否禁止布线`);
		}
	}
	return { pads: allPads, obstacles, board: boardGeometry.polygons, keepouts, copperLayers, warnings: [...new Set(warnings)], complete };
}

function selectedPads(input: FanoutInput, pads: PadInfo[]): PadInfo[] {
	let result: PadInfo[];
	if (input.padIds) {
		const byId = new Map(pads.map(pad => [pad.id, pad]));
		result = input.padIds.map((id) => {
			const pad = byId.get(id);
			if (!pad)
				throw new Error(`找不到焊盘 ${id}`);
			return pad;
		});
	}
	else if (input.componentIds) {
		const ids = new Set(input.componentIds);
		const found = new Set<string>();
		result = pads.filter((pad) => {
			if (pad.componentId && ids.has(pad.componentId)) {
				found.add(pad.componentId);
				return true;
			}
			return false;
		});
		for (const id of ids) {
			if (!found.has(id))
				throw new Error(`器件 ${id} 没有可扇出焊盘`);
		}
	}
	else {
		result = pads.filter(pad => pad.net === input.net);
	}
	if (!result.length)
		throw new Error('选择目标没有焊盘');
	return result;
}
function targetLayer(pad: PadInfo, input: FanoutInput): number | undefined {
	if (pad.layer === 1 || pad.layer === 2) {
		if (input.layer && (input.layer === 'top' ? 1 : 2) !== pad.layer)
			return undefined;
		return pad.layer;
	}
	if (pad.layer === 12 || pad.hole != null)
		return input.layer === 'top' ? 1 : input.layer === 'bottom' ? 2 : undefined;
	return undefined;
}
function chosenDirections(direction: Direction): Point[] {
	if (direction === 'auto' || direction === '8directions')
		return ALL_DIRS;
	return [DIRS[direction]];
}
function makePlan(input: FanoutInput, dims: ReturnType<typeof dimensions>, collected: Collected, baseline: Awaited<ReturnType<GeometryHost['getBaseline']>>, documentUuid: string, checkBudget: () => void) {
	const warnings = [...collected.warnings];
	if (dims.missing.length)
		warnings.push(`缺少明确 mil 尺寸：${dims.missing.join(', ')}；当前未核实 DRC 规则默认字段，不能从规则猜值`);
	let targets: PadInfo[] = [];
	try {
		targets = selectedPads(input, collected.pads);
	}
	catch (error) { warnings.push((error as Error).message); }
	if (input.net && targets.some(pad => pad.net !== input.net))
		warnings.push('选择中存在不同网络的焊盘，拒绝混网扇出');
	const groups: Array<Record<string, unknown>> = [];
	const plannedPrimitives: PrimitivePlan[] = [];
	const routingObstacles: LayerObstacle[] = [...collected.obstacles];
	let searchLimited = false;
	let checkedCandidates = 0;
	if (!dims.missing.length && collected.complete && targets.length && !warnings.some(w => /不同网络|拒绝混网/.test(w))) {
		for (let index = 0; index < targets.length; index++) {
			checkBudget();
			const target = targets[index];
			const layer = targetLayer(target, input);
			if (layer == null) {
				warnings.push(`焊盘 ${target.id} 为多层/通孔焊盘，必须显式选择 top 或 bottom`);
				continue;
			}
			if (!target.net) {
				warnings.push(`焊盘 ${target.id} 没有网络，不能扇出`);
				continue;
			}
			const shape = padPolygon(target, layer);
			if (!shape) {
				warnings.push(`焊盘 ${target.id} 外形无法采样`);
				continue;
			}
			const targetObstacles = routingObstacles.map(obstacle => ({
				...obstacle,
				trackCollision: obstacle.ownerPadId === target.id ? false : !obstacle.copperLayers || obstacle.copperLayers.includes(layer),
			}));
			const stagger = (index % 2 === 0 ? 1 : -1) * input.staggerLength / 2;
			const directionSet = chosenDirections(input.direction);
			const targetShapeName = Array.isArray(target.shape) ? String(target.shape[0]).toUpperCase() : '';
			const candidates = directionSet.map(dir => targetShapeName !== 'ELLIPSE' && target.rotation !== 0
				? rotate(dir, target.rotation, { x: 0, y: 0 })
				: { x: dir.x, y: dir.y });
			const expandedDirections = candidates.map(dir => ({ dir, start: target.position, desired: { x: target.position.x + dir.x * (dims.lineLength as number) - dir.y * stagger, y: target.position.y + dir.y * (dims.lineLength as number) + dir.x * stagger } }));
			let best: { route: Point[]; endOffset: number; length: number; checked: number; limited: boolean; reason: string } | undefined;
			let targetChecked = 0;
			let targetLimited = false;
			for (const option of expandedDirections) {
				checkBudget();
				const planned = planRouteDetailed({ start: option.start, desiredEnd: option.desired, net: '__fanout__', lineWidth: dims.lineWidth!, viaDiameter: dims.viaDiameter!, clearance: dims.clearance!, maxEndOffset: dims.lineLength!, obstacles: targetObstacles, boardPolygons: collected.board, keepoutPolygons: collected.keepouts, maxCandidates: 20000, timeLimitMs: Number.POSITIVE_INFINITY, checkBudget });
				checkedCandidates += planned.checkedCandidates;
				searchLimited ||= planned.searchLimited;
				targetChecked += planned.checkedCandidates;
				targetLimited ||= planned.searchLimited;
				if (planned.route && (!best || planned.route.length < best.length))
					best = { route: planned.route.points, endOffset: planned.route.endOffset, length: planned.route.length, checked: planned.checkedCandidates, limited: planned.searchLimited, reason: planned.terminationReason };
			}
			if (!best) {
				groups.push({ targetId: target.id, net: target.net, layer, planned: false, checkedCandidates: targetChecked, searchLimited: targetLimited, terminationReason: targetLimited ? 'candidate-limit' : 'candidate-search-exhausted' });
				continue;
			}
			groups.push({ targetId: target.id, net: target.net, layer, planned: true, via: best.route.at(-1), length: best.length, endOffset: best.endOffset, checkedCandidates: targetChecked, searchLimited: targetLimited, terminationReason: targetLimited ? 'route-found-after-candidate-limit' : best.reason });
			for (let i = 1; i < best.route.length; i++) {
				const primitive: PrimitivePlan = { type: 'line', start: best.route[i - 1], end: best.route[i], net: target.net, layer, lineWidth: dims.lineWidth!, targetId: target.id };
				plannedPrimitives.push(primitive);
				routingObstacles.push({ type: 'segment', start: primitive.start!, end: primitive.end!, radius: dims.lineWidth! / 2, net: '', copperLayers: [layer] });
			}
			const via: PrimitivePlan = { type: 'via', center: best.route.at(-1), net: target.net, layer: 'all-copper', diameter: dims.viaDiameter!, holeDiameter: dims.holeDiameter!, targetId: target.id };
			plannedPrimitives.push(via);
			routingObstacles.push({ type: 'circle', center: via.center!, radius: dims.viaDiameter! / 2, net: '', copperLayers: collected.copperLayers });
		}
	}
	const failedTarget = targets.length === 0 || groups.length !== targets.length || groups.some(group => group.planned !== true);
	const executable = collected.complete && dims.missing.length === 0 && targets.length > 0 && !failedTarget && !warnings.some(w => /混网|没有网络|必须显式|未形成完整|无法/.test(w));
	return {
		documentUuid,
		operation: 'fanout',
		units: 'mil' as const,
		inputs: input,
		baseline,
		targets: targets.map(target => ({ ...target, polygon: padPolygon(target) })),
		groups,
		plannedPrimitives,
		executable,
		coverage: { complete: collected.complete, pads: collected.pads.length, obstacles: collected.obstacles.length, boardPolygons: collected.board.length, keepoutPolygons: collected.keepouts.length, copperLayers: collected.copperLayers, searchLimited, checkedCandidates, sampling: 'ellipses, rounded rectangles and oblong pads use at most 10 degree steps with conservative outward chord-sagitta padding; unsupported curve polygons block execution' },
		warnings: [...new Set(warnings)],
		provenance: { algorithm: 'eext-pad-fanout/src/fanout-routing.ts', upstreamCommit: '7c88e571457e6d63463b7cb391e1e62bdbdd02d7', sdk: '@jlceda/pro-api-types 0.4.26', viaType: 'through-hole' },
	};
}

async function buildPlan(host: GeometryHost, rawInput: FanoutInput, baseline?: Awaited<ReturnType<GeometryHost['getBaseline']>>) {
	const snapshot = baseline ?? await host.getBaseline();
	const collected = await collect(host);
	const dims = dimensions(rawInput);
	const plan = makePlan(rawInput, dims, collected, snapshot, host.documentUuid, () => host.checkBudget());
	await host.assertBaseline(snapshot);
	return plan;
}

function assertPlanShape(plan: any): asserts plan is ReturnType<typeof makePlan> {
	if (!plan || plan.operation !== 'fanout' || plan.units !== 'mil' || typeof plan.documentUuid !== 'string' || !plan.inputs || !plan.baseline || !Array.isArray(plan.targets) || !Array.isArray(plan.groups) || !Array.isArray(plan.plannedPrimitives) || typeof plan.executable !== 'boolean')
		throw new Error('plan 结构不完整或 operation/units 不匹配');
}

async function getPlan(params: Record<string, any>) {
	let host: GeometryHost | undefined;
	try {
		host = await createGeometryHost(eda, params);
		const input = normalizeInput(params);
		const plan = await buildPlan(host, input);
		await host.finish();
		return plan;
	}
	catch (error) {
		if (host)
			host.fail(error);
		throw error;
	}
}

async function executePlan(params: Record<string, any>) {
	let host: GeometryHost | undefined;
	const attemptedIndexes = new Set<number>();
	try {
		const plan = params.plan;
		assertPlanShape(plan);
		host = await createGeometryHost(eda, params, plan.documentUuid);
		if (!plan.executable)
			throw new Error('计划标记为不可执行');
		await host.assertBaseline(plan.baseline);
		const current = await buildPlan(host, normalizeInput(plan.inputs), plan.baseline);
		if (stableJson(current.targets) !== stableJson(plan.targets) || stableJson(current.groups) !== stableJson(plan.groups) || stableJson(current.plannedPrimitives) !== stableJson(plan.plannedPrimitives) || current.executable !== plan.executable)
			throw new Error('plan 目标、障碍或几何与当前 PCB 不一致，拒绝执行');
		if (!current.executable)
			throw new Error('重新核对后的计划不可执行');
		await host.assertBaseline(plan.baseline);
		const createdIds: string[] = [];
		const verifiedIds: string[] = [];
		const readback: Array<Record<string, unknown>> = [];
		for (let index = 0; index < plan.plannedPrimitives.length; index++) {
			const primitive = plan.plannedPrimitives[index];
			let created: any;
			if (primitive.type === 'line') {
				if (!primitive.start || !primitive.end || !primitive.layer || !positive(primitive.lineWidth) || !primitive.net || !primitive.targetId)
					throw new Error(`第 ${index + 1} 条线几何不完整`);
				created = await host.write(`创建扇出线 ${index + 1}`, () => {
					attemptedIndexes.add(index);
					return host!.sdk.pcb_PrimitiveLine.create(primitive.net, primitive.layer, primitive.start!.x, primitive.start!.y, primitive.end!.x, primitive.end!.y, primitive.lineWidth, false);
				});
			}
			else if (primitive.type === 'via') {
				if (!primitive.center || !positive(primitive.diameter) || !positive(primitive.holeDiameter) || !primitive.net || !primitive.targetId)
					throw new Error(`第 ${index + 1} 个过孔几何不完整`);
				created = await host.write(`创建扇出通孔 ${index + 1}`, () => {
					attemptedIndexes.add(index);
					return host!.sdk.pcb_PrimitiveVia.create(primitive.net, primitive.center!.x, primitive.center!.y, primitive.holeDiameter, primitive.diameter, 0, undefined, undefined, false);
				});
			}
			else {
				throw new Error(`第 ${index + 1} 个计划图元类型未知`);
			}
			if (!created)
				throw new Error(`第 ${index + 1} 个图元创建返回空值`);
			const id = requiredState<string>(created, 'getState_PrimitiveId', `第 ${index + 1} 个新图元`);
			host.recordCreated(id);
			createdIds.push(id);
			const refetched = await host.read(`按 ID 读回图元 ${id}`, () => primitive.type === 'line' ? host!.sdk.pcb_PrimitiveLine.get(id) : host!.sdk.pcb_PrimitiveVia.get(id));
			if (!refetched)
				throw new Error(`图元 ${id} 按 ID 读回为空`);
			const values = primitive.type === 'line'
				? { id: state(refetched, 'getState_PrimitiveId'), net: state(refetched, 'getState_Net'), layer: state(refetched, 'getState_Layer'), startX: state(refetched, 'getState_StartX'), startY: state(refetched, 'getState_StartY'), endX: state(refetched, 'getState_EndX'), endY: state(refetched, 'getState_EndY'), lineWidth: state(refetched, 'getState_LineWidth') }
				: { id: state(refetched, 'getState_PrimitiveId'), net: state(refetched, 'getState_Net'), x: state(refetched, 'getState_X'), y: state(refetched, 'getState_Y'), diameter: state(refetched, 'getState_Diameter'), holeDiameter: state(refetched, 'getState_HoleDiameter'), viaType: state(refetched, 'getState_ViaType') };
			const expected = primitive.type === 'line'
				? { id, net: primitive.net, layer: primitive.layer, startX: primitive.start!.x, startY: primitive.start!.y, endX: primitive.end!.x, endY: primitive.end!.y, lineWidth: primitive.lineWidth }
				: { id, net: primitive.net, x: primitive.center!.x, y: primitive.center!.y, diameter: primitive.diameter, holeDiameter: primitive.holeDiameter, viaType: 0 };
			const ok = Object.keys(expected).every((key) => {
				const a = (values as any)[key];
				const e = (expected as any)[key];
				return typeof e === 'number' ? finite(a) && Math.abs(a - e) <= 0.001 : a === e;
			});
			readback.push({ id, type: primitive.type, expected, actual: values, verified: ok });
			if (!ok)
				throw new Error(`图元 ${id} 读回值与计划不符`);
			host.recordVerified(id);
			verifiedIds.push(id);
		}
		await host.finish();
		return { documentUuid: host.documentUuid, operation: 'fanout', createdIds, verifiedIds, readback, saved: false, completed: createdIds.length, planned: plan.plannedPrimitives.length };
	}
	catch (error) {
		if (host) {
			const planned = params.plan?.plannedPrimitives;
			const notAttemptedIndices = Array.isArray(planned) ? planned.map((_: unknown, index: number) => index).filter((index: number) => !attemptedIndexes.has(index)) : [];
			host.fail(error, { notAttemptedSteps: notAttemptedIndices.length, notAttemptedIndices });
		}
		throw error;
	}
}

export const fanoutCommands: Array<ICommandDef> = [
	{
		name: 'pcb.getFanoutPlan',
		summary: '只读规划指定焊盘的短线与通孔扇出',
		params: [
			{ name: 'padIds', type: 'string[]', description: '目标焊盘图元 ID，可选；与 componentIds/net 三选一' },
			{ name: 'componentIds', type: 'string[]', description: '目标器件图元 ID，可选；与 padIds/net 三选一' },
			{ name: 'net', type: 'string', description: '目标网络，可选；与 padIds/componentIds 三选一' },
			{ name: 'direction', type: 'string', description: 'auto/8directions 或 N/NE/E/SE/S/SW/W/NW；默认 auto' },
			{ name: 'layer', type: 'string', description: 'top/bottom；多层或通孔焊盘必填，SMT 焊盘沿用自身层' },
			{ name: 'lineLength', type: 'number', description: '扇出长度（mil）；当前未核实 DRC 规则字段，需要明确提供' },
			{ name: 'lineWidth', type: 'number', description: '走线宽度（mil）；当前未核实 DRC 规则字段，需要明确提供' },
			{ name: 'viaDiameter', type: 'number', description: '过孔外径（mil）；当前未核实 DRC 规则字段，需要明确提供' },
			{ name: 'holeDiameter', type: 'number', description: '过孔孔径（mil）；当前未核实 DRC 规则字段，需要明确提供' },
			{ name: 'clearance', type: 'number', description: '安全间距（mil）；当前未核实 DRC 规则字段，需要明确提供' },
			{ name: 'staggerLength', type: 'number', description: '相邻目标线长参差值（mil），默认 0' },
		],
		returns: '扇出计划，含真实目标坐标、网络、层、线宽、过孔尺寸、搜索覆盖与 executable；不写入 PCB。',
		example: { cmd: 'pcb.getFanoutPlan', params: { padIds: ['pad-id'], lineLength: 120, lineWidth: 8, viaDiameter: 24, holeDiameter: 12, clearance: 8 } },
		handler: getPlan,
	},
	{
		name: 'pcb.fanout',
		summary: '执行并逐项读回 pcb.getFanoutPlan 返回的扇出计划',
		params: [{ name: 'plan', type: 'object', required: true, description: 'pcb.getFanoutPlan 的完整 plan 返回值' }],
		returns: 'createdIds、verifiedIds、逐项 readback、saved:false；失败会停止后续图元，并在 cause.partial 中报告部分结果。',
		example: { cmd: 'pcb.fanout', params: { plan: { operation: 'fanout' } } },
		handler: executePlan,
	},
];
