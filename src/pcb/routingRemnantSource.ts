import type { LocalPad } from './localRoutingReview';
import type { ScanCopper, ScanPad, ScanTrack, ScanVia } from './routingRemnantAnalysis';
import { normalizePouredFillPathToMil, normalizePouredStrokePathToMil } from './kiroutingInput';
import { parseSourceLog, resolveRecords } from './sourcelog';

const copperTypes = new Set(['TOP', 'BOTTOM', 'SIGNAL', 'PLANE']);

function idTuple(id: unknown, type: string): unknown[] {
	if (typeof id !== 'string' || !id.startsWith('['))
		return [];
	try {
		const tuple: unknown = JSON.parse(id);
		return Array.isArray(tuple) && tuple[0] === type ? tuple : [];
	}
	catch {
		return [];
	}
}

function netName(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

type CopperRing = ScanCopper['rings'][number];

function containsPoint(ring: CopperRing, point: CopperRing[number]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[j];
		const b = ring[i];
		if ((a.y > point.y) !== (b.y > point.y)
			&& point.x < a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y))
			inside = !inside;
	}
	return inside;
}

/** A filled child may contain holes or detached outer rings. Keep each outer island separate. */
function copperIslands(rings: CopperRing[]): CopperRing[][] {
	const containers = rings.map((ring, index) => rings.flatMap((other, otherIndex) =>
		otherIndex !== index && containsPoint(other, ring[0]) ? [otherIndex] : []));
	return rings.flatMap((ring, index) => containers[index].length % 2 === 0
		? [[ring, ...rings.filter((_, child) => containers[child].length === containers[index].length + 1 && containers[child].includes(index))]]
		: []);
}

export function routingRemnantSource(source: string, readPads?: LocalPad[]) {
	const document = parseSourceLog(source);
	if (document.docType.toUpperCase() !== 'PCB' || !document.uuid)
		throw new Error('整板余线检查需要有效的 PCB 编辑器源码');

	const records = [...resolveRecords(document).values()];
	const layerRecords = records.filter(record => record.header.type === 'LAYER');
	const layers = layerRecords
		.filter(({ data }) => data.use === true && copperTypes.has(data.layerType))
		.map(({ data }) => ({ id: data.layerId as number, name: String(data.layerName ?? '') }));
	const layerIds = new Set(layers.map(layer => layer.id));
	if (!layerIds.has(1) || !layerIds.has(2) || layers.some(layer => !Number.isInteger(layer.id)) || layerIds.size !== layers.length)
		throw new Error('PCB 源码缺少可核对的有效铜层');

	const issues: Array<{ id: string, net: string, reason: string }> = [];
	const issue = (id: string, net: string, reason: string) => { issues.push({ id, net, reason }); };
	const tracks: ScanTrack[] = [];
	const vias: ScanVia[] = [];
	const pads: ScanPad[] = [];
	const copper: ScanCopper[] = [];
	const pours = new Map(records.filter(record => record.header.type === 'POUR').map(record => [record.header.id, record.data]));
	const filledPours = new Set<string>();
	const expectedPads = new Map<string, { id: string; net: string; standalone: boolean }>();

	for (const { header, data } of records) {
		const { type, id = '' } = header;
		const net = netName(data.netName);
		const isCopper = layerIds.has(data.layerId);
		if ((type === 'LINE' || type === 'ARC') && isCopper) {
			const coordinates = [data.startX, data.startY, data.endX, data.endY];
			const arc = type === 'ARC' ? data.angle ?? data.arcAngle : undefined;
			if (!net || !coordinates.every(Number.isFinite) || !(Number.isFinite(data.width) && data.width > 0)
				|| (type === 'ARC' && (!Number.isFinite(arc) || arc === 0 || Math.abs(arc) >= 360))) {
				issue(id, net, '走线网络或几何无法核对');
				continue;
			}
			tracks.push({ id, net, layer: data.layerId, width: data.width,
				a: { x: data.startX, y: data.startY }, b: { x: data.endX, y: data.endY }, locked: data.locked === true, arc });
		}
		else if (type === 'VIA') {
			if (!net || ![data.centerX, data.centerY, data.holeDiameter, data.viaDiameter].every(Number.isFinite)
				|| data.holeDiameter <= 0 || data.viaDiameter <= data.holeDiameter) {
				issue(id, net, '过孔网络、孔径或孔环无法核对');
				continue;
			}
			const unused = data.unusedInnerLayers;
			const spanKnown = data.viaType === 'NORMAL' && (unused === undefined
				|| Array.isArray(unused) && unused.every(layer => Number.isInteger(layer) && layer > 2 && layerIds.has(layer)));
			const span = spanKnown ? [...layerIds].filter(layer => !unused?.includes(layer)) : null;
			if (!span)
				issue(id, net, '过孔有效铜层缺少验证，需人工核对跨度');
			vias.push({ id, net, x: data.centerX, y: data.centerY, diameter: data.viaDiameter,
				hole: data.holeDiameter, layers: span, locked: data.locked === true });
		}
		else if (type === 'PAD_NET' && data.padNet) {
			const [, component, , pin] = idTuple(id, type);
			const padId = typeof component === 'string' && typeof pin === 'string' ? component + pin : '';
			if (padId)
				expectedPads.set(padId, { id, net: netName(data.padNet), standalone: false });
			else
				issue(id, netName(data.padNet), '器件焊盘的源码身份无法读取');
		}
		else if (type === 'PAD' && net)
			expectedPads.set(id, { id, net, standalone: true });
		else if (type === 'POURED') {
			const [, parentId] = idTuple(id, type);
			const parent = typeof parentId === 'string' ? pours.get(parentId) : undefined;
			const parentNet = netName(parent?.netName);
			if (!parent || !layerIds.has(parent.layerId) || !parentNet || !Array.isArray(data.pourFill) || !data.pourFill.length) {
				issue(id, parentNet, '实填铜缺少可核对的所属铜区、图层或路径');
				continue;
			}
			filledPours.add(String(parentId));
			for (const [index, fill] of data.pourFill.entries()) {
				const fillId = typeof fill.id === 'string' ? fill.id : `${parentId}:fill:${index}`;
				try {
					if (fill.fill === true && fill.strokeWidth === 0) {
						const islands = copperIslands(normalizePouredFillPathToMil(fill.path));
						for (const [island, rings] of islands.entries())
							copper.push({ id: island === 0 ? fillId : `${fillId}:island:${island}`, net: parentNet, layer: parent.layerId, rings });
					}
					else if (fill.fill === false && Number.isFinite(fill.strokeWidth) && fill.strokeWidth > 0) {
						for (const [path, points] of normalizePouredStrokePathToMil(fill.path).entries())
							copper.push({ id: path === 0 ? fillId : `${fillId}:stroke:${path}`, net: parentNet,
								layer: parent.layerId, rings: [points], stroke: fill.strokeWidth * 10 });
					}
					else {
						issue(fillId, parentNet, '实填铜线宽或填充方式未覆盖');
					}
				}
				catch (error) {
					issue(fillId, parentNet, `实填铜路径无法分析：${(error as Error).message}`);
				}
			}
		}
		else if (type === 'FILL' && isCopper) {
			try {
				if (!net || data.fillStyle !== 'SOLID' || data.isBridgingCopper)
					throw new Error('网络、实心状态或跨网桥接未核实');
				// Standalone FILL coordinates are already in mil, unlike POURED.
				const rings = normalizePouredFillPathToMil(data.path).map(ring => ring.map(point => ({ x: point.x / 10, y: point.y / 10 })));
				for (const [island, paths] of copperIslands(rings).entries())
					copper.push({ id: island === 0 ? id : `${id}:island:${island}`, net, layer: data.layerId, rings: paths });
				if (data.width > 0)
					for (const [index, ring] of rings.entries())
						copper.push({ id: `${id}:boundary:${index}`, net, layer: data.layerId, rings: [[...ring, ring[0]]], stroke: data.width });
			}
			catch (error) {
				issue(id, net, `独立铜填充无法分析：${(error as Error).message}`);
			}
		}
		else if (isCopper && ['POLY', 'REGION', 'STRING', 'TEXT', 'COMPONENT_PRIMITIVE', 'PRIMITIVE', 'SOLIDREGION'].includes(type)) {
			issue(id, net, `铜层上的 ${type} 几何未覆盖`);
		}
	}

	for (const [id, data] of pours) {
		if (typeof id === 'string' && layerIds.has(data.layerId) && !filledPours.has(id))
			issue(id, netName(data.netName), '只有覆铜边框，缺少实际填充');
	}
	for (const pad of readPads ?? []) {
		const shape = pad.shape;
		const shapeType = Array.isArray(shape) ? shape[0] : '';
		const padLayers = pad.layer === 12 ? [...layerIds] : layerIds.has(pad.layer) ? [pad.layer] : [];
		if (!pad.net || !padLayers.length)
			continue;
		const dimensions = Array.isArray(shape) ? shape.slice(1, 3) : [];
		if (!['RECT', 'ELLIPSE', 'OVAL'].includes(shapeType) || dimensions.length !== 2
			|| !dimensions.every(value => Number.isFinite(value) && value > 0)
			|| ![pad.x, pad.y].every(Number.isFinite)
			|| (pad.special != null && (!Array.isArray(pad.special) || pad.special.length > 0))) {
			issue(pad.id, pad.net, '焊盘轮廓或特殊层几何未覆盖');
			continue;
		}
		const [width, height] = dimensions;
		// A containing disk protects rectangular corners and rotated pads and is not proof of electrical contact.
		const radius = shapeType === 'RECT' ? Math.hypot(width, height) / 2 : Math.max(width, height) / 2;
		const exactDisk = shapeType === 'ELLIPSE' && width === height && pad.hole == null && padLayers.length === 1;
		pads.push({ id: pad.id, net: pad.net, x: pad.x, y: pad.y, radius, layers: padLayers, approximate: !exactDisk });
	}

	const adoptedPads = new Map(pads.map(pad => [pad.id, pad.net]));
	let matchedComponentPads = 0;
	let matchedIndependentPads = 0;
	for (const [padId, entry] of expectedPads) {
		if (adoptedPads.get(padId) !== entry.net)
			issue(entry.id, entry.net, `缺少匹配的${entry.standalone ? '独立' : '器件'}焊盘有效几何`);
		else if (entry.standalone)
			matchedIndependentPads++;
		else
			matchedComponentPads++;
	}

	const nets = new Set(records.filter(record => record.header.type === 'NET')
		.map(record => netName(idTuple(record.header.id, 'NET')[1])).filter(Boolean));
	for (const item of [...tracks, ...vias, ...pads, ...copper, ...issues]) {
		if (item.net)
			nets.add(item.net);
	}
	return { uuid: document.uuid, layers, tracks, vias, pads, copper, issues, nets,
		padReadback: { sdkRead: readPads !== undefined, matchedComponentPads, matchedIndependentPads,
			approximateProtectedPads: pads.filter(pad => pad.approximate).length } };
}
