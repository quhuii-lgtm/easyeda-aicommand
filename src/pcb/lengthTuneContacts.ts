import type { GeometryHost } from './geometryHost';
import type { TuneContact, TuneRegion } from './lengthTuneTargets';
import { normalizePouredPathSource, readEditorVersion } from './pouredUnits';

function state(object: any, name: string): any {
	const getter = object?.[`getState_${name}`];
	if (typeof getter !== 'function')
		throw new Error(`补长连接检查缺少 ${name} 读取接口`);
	return getter.call(object);
}
function number(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`补长连接检查 ${label} 不是有限数值`);
	return value;
}
function circleBounds(x: number, y: number, radius: number): TuneRegion {
	return { xMin: x - radius, xMax: x + radius, yMin: y - radius, yMax: y + radius };
}

// Recognize straight polygon syntax only. Unknown curves retain no bounds, so they
// cannot be silently excluded from the local contact check.
function polygonBounds(value: any, margin: number): TuneRegion | undefined {
	const source = typeof value?.getSource === 'function' ? value.getSource() : value;
	const sets = Array.isArray(source?.[0]) ? source : [source];
	const points: number[][] = [];
	for (const raw of sets) {
		if (!Array.isArray(raw) || !raw.length)
			return undefined;
		if (raw[0] === 'R') {
			const [, x, y, w, h, rotation = 0, radius = 0] = raw;
			if (![x, y, w, h, rotation, radius].every(n => typeof n === 'number' && Number.isFinite(n)) || w <= 0 || h <= 0 || rotation !== 0 || radius !== 0)
				return undefined;
			points.push([x, y], [x + w, y - h]);
			continue;
		}
		for (let i = 0; i < raw.length;) {
			if (raw[i] === 'L') {
				i++;
				continue;
			}
			if (typeof raw[i] !== 'number' || !Number.isFinite(raw[i]) || typeof raw[i + 1] !== 'number' || !Number.isFinite(raw[i + 1]))
				return undefined;
			points.push([raw[i], raw[i + 1]]);
			i += 2;
		}
	}
	if (!points.length)
		return undefined;
	return { xMin: Math.min(...points.map(p => p[0])) - margin, xMax: Math.max(...points.map(p => p[0])) + margin, yMin: Math.min(...points.map(p => p[1])) - margin, yMax: Math.max(...points.map(p => p[1])) + margin };
}

export function tunePadContact(pad: any, targetLayer: number): TuneContact {
	const id = String(state(pad, 'PrimitiveId'));
	const net = String(state(pad, 'Net') ?? '');
	const x = number(state(pad, 'X'), `${id}.X`);
	const y = number(state(pad, 'Y'), `${id}.Y`);
	const layer = number(state(pad, 'Layer'), `${id}.Layer`);
	const hole = state(pad, 'Hole');
	const metallization = state(pad, 'Metallization');
	const layers = layer === 12 ? (metallization === true ? [targetLayer] : null) : [layer];
	let shape = state(pad, 'Pad');
	const special = state(pad, 'SpecialPad');
	if (special !== undefined && special !== null) {
		if (!Array.isArray(special))
			throw new Error(`焊盘 ${id} 特殊层外形读取无效`);
		if (special.some(entry => !Array.isArray(entry) || entry.length !== 3
			|| !Number.isInteger(entry[0]) || !Number.isInteger(entry[1]) || entry[0] < 1 || entry[1] > 44 || entry[0] > entry[1]
			|| !Array.isArray(entry[2]) || typeof entry[2][0] !== 'string')) {
			return { id, net, layers, kind: 'unknown', reason: '特殊层外形条目无法可靠解释，未回退到默认外形' };
		}
		// Layer IDs are not physical stack indices (bottom=2, inner=15+).
		// The public SDK contract does not define expansion of ranged entries.
		if (special.some(entry => entry[0] !== entry[1]))
			return { id, net, layers, kind: 'unknown', reason: '特殊焊盘跨层范围缺少可确认的层序语义' };
		const matches = special.filter(entry => entry[0] === targetLayer);
		if (matches.length > 1)
			return { id, net, layers, kind: 'unknown', reason: '特殊层外形重复，无法确认目标层铜形状' };
		if (matches.length === 1)
			shape = matches[0][2];
	}
	const rotation = number(state(pad, 'Rotation'), `${id}.Rotation`);
	const w = shape?.[1];
	const h = shape?.[2];
	const hasDimensions = typeof w === 'number' && Number.isFinite(w) && w > 0 && typeof h === 'number' && Number.isFinite(h) && h > 0;
	const bounds = hasDimensions ? circleBounds(x, y, Math.hypot(w, h) / 2) : undefined;
	const plainCircle = Array.isArray(shape) && shape[0] === 'ELLIPSE' && hasDimensions && w === h;
	let holeRadius: number | undefined;
	if (hole !== null && hole !== undefined) {
		const offsetX = number(state(pad, 'HoleOffsetX'), `${id}.HoleOffsetX`);
		const offsetY = number(state(pad, 'HoleOffsetY'), `${id}.HoleOffsetY`);
		if (!plainCircle || !Array.isArray(hole) || hole[0] !== 'ROUND' || typeof hole[1] !== 'number' || !(hole[1] > 0) || !Number.isFinite(hole[1]) || offsetX !== 0 || offsetY !== 0 || hole[1] >= w)
			return { id, net, layers, kind: 'unknown', bounds, reason: '带孔或偏心焊盘形状尚不能精确确认接触' };
		holeRadius = hole[1] / 2;
	}
	if (plainCircle)
		return { id, net, layers, kind: 'circle', center: [x, y], radius: w / 2, ...(holeRadius === undefined ? {} : { holeRadius }) };
	if (Array.isArray(shape) && ['RECT', 'RECTANGLE'].includes(shape[0]) && hasDimensions && (shape[3] ?? 0) === 0)
		return { id, net, layers, kind: 'rect', center: [x, y], width: w, height: h, rotation };
	return { id, net, layers, kind: 'unknown', bounds, reason: '该焊盘外形尚不能精确确认局部接触' };
}

/** Read conductors through the same document/budget guard as the tuning command. */
export async function readTuneContacts(host: GeometryHost, targetLayer: number, padObjects?: any[]): Promise<TuneContact[]> {
	const sdk = host.sdk;
	const contacts: TuneContact[] = [];
	const pourParents = new Map<string, { net: string; layer: number }>();
	const pads = padObjects ?? await host.read('读取补长周围独立焊盘', () => sdk.pcb_PrimitivePad.getAll()) as any[];
	const components = padObjects === undefined ? await host.read('读取补长周围器件', () => sdk.pcb_PrimitiveComponent.getAll()) as any[] : [];
	if (!Array.isArray(pads) || !Array.isArray(components))
		throw new Error('补长焊盘/器件枚举无效');
	const byId = new Map<string, any>();
	for (const pad of pads) byId.set(String(state(pad, 'PrimitiveId')), pad);
	for (const component of components) {
		const id = String(state(component, 'PrimitiveId'));
		const pins = await host.read(`读取器件 ${id} 焊盘`, () => component.getAllPins()) as any[];
		if (!Array.isArray(pins))
			throw new Error(`器件 ${id} 焊盘枚举无效`);
		for (const pad of pins) byId.set(String(state(pad, 'PrimitiveId')), pad);
	}
	for (const pad of byId.values()) {
		host.checkBudget();
		contacts.push(tunePadContact(pad, targetLayer));
	}
	const vias = await host.read('读取补长周围过孔', () => sdk.pcb_PrimitiveVia.getAll()) as any[];
	if (!Array.isArray(vias))
		throw new Error('补长过孔枚举无效');
	for (const via of vias) {
		host.checkBudget();
		const id = String(state(via, 'PrimitiveId'));
		const net = String(state(via, 'Net') ?? '');
		const x = number(state(via, 'X'), `${id}.X`);
		const y = number(state(via, 'Y'), `${id}.Y`);
		const radius = number(state(via, 'Diameter'), `${id}.Diameter`) / 2;
		const holeRadius = number(state(via, 'HoleDiameter'), `${id}.HoleDiameter`) / 2;
		if (!(radius > holeRadius && holeRadius > 0))
			throw new Error(`过孔 ${id} 铜环尺寸无效`);
		const type = state(via, 'ViaType');
		contacts.push(type === 0
			? { id, net, layers: [targetLayer], kind: 'circle', center: [x, y], radius, holeRadius }
			: { id, net, layers: null, kind: 'unknown', bounds: circleBounds(x, y, radius), reason: '非通孔的导电层跨度尚不能可靠确认' });
	}
	for (const kind of ['Arc', 'Fill', 'Pour', 'Polyline'] as const) {
		const objects = await host.read(`读取补长周围 ${kind}`, () => sdk[`pcb_Primitive${kind}`].getAll()) as any[];
		if (!Array.isArray(objects))
			throw new Error(`${kind} 枚举无效`);
		for (const object of objects) {
			host.checkBudget();
			const id = String(state(object, 'PrimitiveId'));
			const net = String(state(object, 'Net') ?? '');
			const layer = number(state(object, 'Layer'), `${kind} ${id}.Layer`);
			if (kind === 'Pour')
				pourParents.set(id, { net, layer });
			if (layer !== targetLayer)
				continue;
			let bounds: TuneRegion | undefined;
			if (kind === 'Arc') {
				const ax = number(state(object, 'StartX'), `${id}.StartX`);
				const ay = number(state(object, 'StartY'), `${id}.StartY`);
				const bx = number(state(object, 'EndX'), `${id}.EndX`);
				const by = number(state(object, 'EndY'), `${id}.EndY`);
				const sweep = number(state(object, 'ArcAngle'), `${id}.ArcAngle`) * Math.PI / 180;
				const width = number(state(object, 'LineWidth'), `${id}.LineWidth`);
				const chord = Math.hypot(bx - ax, by - ay);
				if (chord > 0 && Math.abs(sweep) > 0 && Math.abs(sweep) < 2 * Math.PI) {
					const offset = chord / (2 * Math.tan(sweep / 2));
					const cx = (ax + bx) / 2 - (by - ay) / chord * offset;
					const cy = (ay + by) / 2 + (bx - ax) / chord * offset;
					bounds = circleBounds(cx, cy, Math.hypot(cx - ax, cy - ay) + width / 2);
				}
			}
			else {
				const width = typeof object.getState_LineWidth === 'function' ? number(state(object, 'LineWidth'), `${id}.LineWidth`) : 0;
				bounds = polygonBounds(state(object, kind === 'Polyline' ? 'Polygon' : 'ComplexPolygon'), width / 2);
			}
			contacts.push({ id, net, layers: [layer], kind: 'unknown', bounds, reason: `${kind} 的局部实际导电接触尚不能确认` });
		}
	}
	const poured = await host.read('读取补长周围实际覆铜填充', () => sdk.pcb_PrimitivePoured.getAll()) as any[];
	if (!Array.isArray(poured))
		throw new Error('实际覆铜填充枚举无效');
	const editorVersion = readEditorVersion(sdk);
	for (const item of poured) {
		host.checkBudget();
		const id = String(state(item, 'PrimitiveId'));
		const parentId = String(state(item, 'PourPrimitiveId'));
		const parent = pourParents.get(parentId);
		if (!parent)
			throw new Error(`实际覆铜填充 ${id} 缺少父覆铜 ${parentId}，无法确认网络和图层`);
		if (parent.layer !== targetLayer)
			continue;
		const fills = state(item, 'PourFills');
		if (!Array.isArray(fills))
			throw new Error(`实际覆铜填充 ${id} 子区域读取无效`);
		for (let i = 0; i < fills.length; i++) {
			host.checkBudget();
			const fill = fills[i];
			if (fill?.fill === false)
				continue;
			const path = typeof fill?.path?.getSource === 'function' ? fill.path.getSource() : fill?.path;
			const normalized = normalizePouredPathSource(path, { fill: fill?.fill, lineWidth: fill?.lineWidth, editorVersion, declaredCoordinateUnit: fill?.coordinateUnit });
			contacts.push({ id: `${id}:${i}`, net: parent.net, layers: [parent.layer], kind: 'unknown', bounds: normalized.status === 'normalized' ? polygonBounds(normalized.normalizedPathMil, 0) : undefined, reason: `实际覆铜填充接触未精确解析（${normalized.normalization}）` });
		}
	}
	return contacts;
}
