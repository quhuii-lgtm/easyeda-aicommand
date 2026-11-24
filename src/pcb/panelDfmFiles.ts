import type { CopperGerberLayerName, GerberInterestBox, GerberLayerGeometry } from './silkscreenGerber';
import { layerKind, parseDrill, readArchive } from './manufacturingPreflight';
import { isSimpleClosedRing, parseGerberLayerGeometry } from './silkscreenGerber';

export async function readPanelFiles(base64: string, check: () => void) {
	const archive = await readArchive(base64);
	check();
	const files = Object.values(archive.files).filter(file => !file.dir).map(file => ({ file, ...layerKind(file.name) }));
	const issues: Array<{ layer: string; reason: string }> = [];
	const read = async <Layer extends Parameters<typeof parseGerberLayerGeometry>[0]>(layer: Layer, interest?: readonly GerberInterestBox[]) => {
		const matching = files.filter(file => file.layer === layer);
		if (matching.length !== 1) {
			issues.push({ layer, reason: matching.length ? '同一层有多个文件，无法确认实际版本' : '未提供此层文件' });
			return undefined;
		}
		check();
		const file = matching[0].file;
		const parsed = parseGerberLayerGeometry(layer, file.name, await file.async('string'), check, interest);
		check();
		return parsed;
	};
	const drillHits = new Map<string, { id: string; xMm: number; yMm: number; diameterMm: number; plating: 'PLATED' | 'NON_PLATED' }>();
	const drillFiles = files.filter(file => file.role === 'drill');
	let drillComplete = drillFiles.length > 0;
	if (!drillComplete)
		issues.push({ layer: 'DRL', reason: '未提供带镀层声明的圆孔钻孔文件' });
	for (const entry of drillFiles) {
		check();
		try {
			const hits = parseDrill(await entry.file.async('string'));
			for (const hit of hits) {
				const key = JSON.stringify([hit.x, hit.y, hit.diameter, hit.plating]);
				if (!drillHits.has(key))
					drillHits.set(key, { id: `${entry.file.name}:${drillHits.size + 1}`, xMm: hit.x, yMm: hit.y, diameterMm: hit.diameter, plating: hit.plating });
			}
		}
		catch (error) {
			drillComplete = false;
			issues.push({ layer: 'DRL', reason: `${entry.file.name}: ${String(error)}` });
		}
	}
	const copperLayers: GerberLayerGeometry<CopperGerberLayerName>[] = [];
	const copperNames = new Set(files.flatMap(file => /^G(?:TL|BL|\d+)$/.test(file.layer) ? [file.layer as CopperGerberLayerName] : []));
	const holeBounds = [...drillHits.values()].filter(hit => hit.plating === 'NON_PLATED').map((hit) => {
		const radius = hit.diameterMm / 2 + 0.001;
		return { minX: (hit.xMm - radius) / 0.0254, minY: (hit.yMm - radius) / 0.0254, maxX: (hit.xMm + radius) / 0.0254, maxY: (hit.yMm + radius) / 0.0254 };
	});
	for (const layer of copperNames) {
		const parsed = await read(layer, holeBounds);
		if (parsed)
			copperLayers.push(parsed);
	}
	const gko = await read('GKO');
	const outline = readPanelOutline(gko);
	if (outline.issue)
		issues.push({ layer: 'GKO', reason: outline.issue });
	return { read, issues, outline, copperLayers, drillComplete, drillHits: [...drillHits.values()] };
}

type Point = [number, number];

function readPanelOutline(layer?: GerberLayerGeometry<'GKO'>) {
	const failed = (issue: string) => ({ rings: [] as Array<{ id: string; pointsMm: { x: number; y: number }[] }>, issue });
	if (!layer || layer.unknowns.length || layer.unsupported.some(issue => issue !== 'GKO不是唯一简单闭合线框'))
		return failed('板框文件缺失或含无法读取的几何');
	const nodes = new Map<string, { point: Point; next: string[] }>();
	const key = ([x, y]: Point) => `${x},${y}`;
	for (const shape of layer.shapes) {
		if (shape.kind !== 'stroke' || shape.polarity !== 'dark' || shape.centerline?.length !== 2)
			return failed('板框含非直线轮廓');
		const [a, b] = shape.centerline;
		for (const [from, to] of [[a, b], [b, a]]) {
			const id = key(from);
			const target = key(to);
			const node = nodes.get(id) ?? { point: from, next: [] };
			if (id === target || node.next.includes(target))
				return failed('板框存在重复或零长度轮廓边');
			node.next.push(target);
			nodes.set(id, node);
		}
	}
	if (!nodes.size || [...nodes.values()].some(node => node.next.length !== 2))
		return failed('板框或锣槽含开口、相接或分支');
	const pending = new Set(nodes.keys());
	const contours: Point[][] = [];
	while (pending.size) {
		const start = pending.values().next().value!;
		const contour: Point[] = [];
		let current = start;
		let previous = '';
		do {
			const node = nodes.get(current)!;
			if (!pending.delete(current))
				return failed('板框闭环连接冲突');
			contour.push(node.point);
			const next = node.next.find(id => id !== previous)!;
			previous = current;
			current = next;
		} while (current !== start);
		contour.push(contour[0]);
		if (!isSimpleClosedRing(contour))
			return failed('板框或锣槽闭环自交');
		contours.push(contour);
	}
	return {
		rings: contours.map((points, index) => ({
			id: `${layer.fileName}:${index + 1}`,
			pointsMm: points.map(([x, y]) => ({ x: x * 0.0254, y: y * 0.0254 })),
		})),
		issue: null,
	};
}
