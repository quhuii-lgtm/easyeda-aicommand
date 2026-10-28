import type { CurvePrimitive } from './arcTuneGeometry';

interface SourceRecord { header: { type: string; id?: string }; data: unknown }
const sourceCollinearToleranceMil = 0.0001;

function canonical(value: unknown): string {
	return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
		: item);
}

function samePoint(a: [number, number], b: [number, number], tolerance = 0.001): boolean {
	return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
}

function dataPoint(data: Record<string, unknown>, start: boolean): [number, number] {
	const x = data[start ? 'startX' : 'endX'];
	const y = data[start ? 'startY' : 'endY'];
	if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y))
		throw new Error('原target/分片LINE端点无效');
	return [x, y];
}

function projectPoint(point: [number, number], a: [number, number], b: [number, number]): { t: number; distance: number } | undefined {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0)
		return undefined;
	const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
	const projection: [number, number] = [a[0] + t * dx, a[1] + t * dy];
	return { t, distance: Math.hypot(point[0] - projection[0], point[1] - projection[1]) };
}

function expectedCuts(targetData: Record<string, unknown>, planned: CurvePrimitive[]): [number, number][] {
	const a = dataPoint(targetData, true);
	const b = dataPoint(targetData, false);
	const candidates: Array<{ t: number; point: [number, number] }> = [];
	for (const primitive of planned) {
		for (const point of [primitive.a, primitive.b]) {
			const projection = projectPoint(point, a, b);
			const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
			if (projection && projection.distance <= 0.001 && projection.t * length > 0.001 && (1 - projection.t) * length > 0.001 && !candidates.some(item => samePoint(item.point, point)))
				candidates.push({ t: projection.t, point });
		}
	}
	return candidates.sort((left, right) => left.t - right.t).map(item => item.point);
}

function sameAttributesExceptEndpoints(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	const strip = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data)
		.filter(([key]) => !['startX', 'startY', 'endX', 'endY'].includes(key)));
	return canonical(strip(left)) === canonical(strip(right));
}

export function identifyOldBypassFragments(input: {
	targetId: string;
	target: SourceRecord;
	beforeRecords: Map<string, SourceRecord>;
	afterRecords: Map<string, SourceRecord>;
	writerKeys: Set<string>;
	planned: CurvePrimitive[];
}): { split: boolean; fragmentIds: string[]; expectedEndpoints: Array<[[number, number], [number, number]]> } {
	const targetKey = `LINE\0${input.targetId}`;
	const targetAfter = input.afterRecords.get(targetKey);
	const added = [...input.afterRecords.entries()].filter(([key]) => !input.beforeRecords.has(key));
	for (const [key, record] of added) {
		const expectedKey = typeof record.header.id === 'string' && record.header.id ? `${record.header.type}\0${record.header.id}` : '';
		if (!expectedKey || key !== expectedKey)
			throw new Error(`新增源码记录key与header身份不符：${key}`);
	}
	const extra = added.filter(([key]) => !input.writerKeys.has(key) && key !== targetKey);
	if (targetAfter) {
		if (canonical(input.target.data) !== canonical(targetAfter.data))
			throw new Error(`创建后原target ${input.targetId} 变化但未消失；不允许推断旁路分片`);
		if (extra.length)
			throw new Error(`创建后存在不能解释的额外记录 ${extra.map(([key]) => key.replace('\0', ' ')).join(', ')}`);
		return { split: false, fragmentIds: [], expectedEndpoints: [] };
	}
	const targetData = input.target.data as Record<string, unknown>;
	const start = dataPoint(targetData, true);
	const end = dataPoint(targetData, false);
	const cuts = expectedCuts(targetData, input.planned);
	if (!cuts.length)
		throw new Error(`原target ${input.targetId} 消失，但计划路径没有可证明的内部切点`);
	const points = [start, ...cuts, end];
	const expectedEndpoints = points.slice(1).map((point, index) => [points[index], point] as [[number, number], [number, number]]);
	const candidates = extra.filter(([, record]) => record.header.type === 'LINE');
	if (candidates.length !== expectedEndpoints.length || extra.length !== candidates.length)
		throw new Error(`原target分片数量不符或有额外记录：期望${expectedEndpoints.length}段，实际${candidates.length}段`);
	const a = dataPoint(targetData, true);
	const b = dataPoint(targetData, false);
	const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const oriented = candidates.map(([key, record]) => {
		const data = record.data as Record<string, unknown>;
		if (!sameAttributesExceptEndpoints(targetData, data))
			throw new Error(`原target分片 ${record.header.id} 的非端点属性与原target不一致`);
		const pointA = dataPoint(data, true);
		const pointB = dataPoint(data, false);
		const projectionA = projectPoint(pointA, a, b);
		const projectionB = projectPoint(pointB, a, b);
		if (!projectionA || !projectionB || projectionA.distance > sourceCollinearToleranceMil || projectionB.distance > sourceCollinearToleranceMil
			|| Math.min(projectionA.t, projectionB.t) < -1e-12 || Math.max(projectionA.t, projectionB.t) > 1 + 1e-12
			|| Math.abs(projectionA.t - projectionB.t) * length <= 1e-9) {
			throw new Error(`原target分片 ${record.header.id} 不共线、外伸或长度无效`);
		}
		const forward = projectionA.t < projectionB.t;
		return { key, id: String(record.header.id), start: forward ? pointA : pointB, end: forward ? pointB : pointA, lo: Math.min(projectionA.t, projectionB.t), hi: Math.max(projectionA.t, projectionB.t) };
	}).sort((left, right) => left.lo - right.lo);
	if (oriented.length !== expectedEndpoints.length || Math.abs(oriented[0].lo) * length > 1e-9 || Math.abs(oriented.at(-1)!.hi - 1) * length > 1e-9
		|| !samePoint(oriented[0].start, a, 1e-9) || !samePoint(oriented.at(-1)!.end, b, 1e-9)) {
		throw new Error('原target分片未精确覆盖原线段首尾');
	}
	for (let i = 0; i < oriented.length; i++) {
		if (i > 0 && Math.hypot(oriented[i - 1].end[0] - oriented[i].start[0], oriented[i - 1].end[1] - oriented[i].start[1]) > 1e-9)
			throw new Error('原target分片之间存在源码端点缺口或重叠');
		if (i > 0) {
			const join = oriented[i].start;
			const plannedCut = cuts[i - 1];
			if (!samePoint(join, plannedCut, 0.001))
				throw new Error('原target分片切点不匹配计划中的已知接点');
		}
	}
	const fragmentIds = oriented.map(item => item.id);
	return { split: true, fragmentIds, expectedEndpoints };
}

export function oldBypassFragmentSdkMatches(source: { id: string; net: unknown; layer: unknown; width: unknown; start: [number, number]; end: [number, number] }, sdk: { id: unknown; type: unknown; net: unknown; layer: unknown; width: unknown; start: [number, number]; end: [number, number] }): boolean {
	const endpointsMatch = (samePoint(sdk.start, source.start) && samePoint(sdk.end, source.end))
		|| (samePoint(sdk.start, source.end) && samePoint(sdk.end, source.start));
	return sdk.id === source.id && sdk.type === 'Line' && sdk.net === source.net && sdk.layer === source.layer && sdk.width === source.width && endpointsMatch;
}
