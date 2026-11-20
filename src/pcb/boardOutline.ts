export interface BoardOutlinePolylineResult {
	lines: any[];
	summaries: Array<{ id: string | null; source: unknown; lineCount: number }>;
	issues: string[];
}

function state<T = any>(object: any, name: string): T | undefined {
	const getter = object?.[`getState_${name}`];
	if (typeof getter !== 'function')
		return undefined;
	return getter.call(object) as T;
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

interface Point {
	x: number;
	y: number;
}

function cross(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(point: Point, start: Point, end: Point): boolean {
	return point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x)
		&& point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean | null {
	const abC = cross(a, b, c);
	const abD = cross(a, b, d);
	const cdA = cross(c, d, a);
	const cdB = cross(c, d, b);
	if (![abC, abD, cdA, cdB].every(Number.isFinite))
		return null;
	if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0))
		&& ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0)))
		return true;
	return (abC === 0 && onSegment(c, a, b))
		|| (abD === 0 && onSegment(d, a, b))
		|| (cdA === 0 && onSegment(a, c, d))
		|| (cdB === 0 && onSegment(b, c, d));
}

function parseClosedStraightPolygon(source: unknown): { points?: Point[]; issue?: string } {
	if (!Array.isArray(source) || source.length < 9 || source[2] !== 'L' || (source.length - 3) % 2 !== 0)
		return { issue: '格式不是受支持的显式闭合直线 POLY' };
	const coordinates = [source[0], source[1], ...source.slice(3)];
	if (!coordinates.every(finite))
		return { issue: '含非有限坐标或未知线段标记' };
	const points: Point[] = [];
	for (let index = 0; index < coordinates.length; index += 2)
		points.push({ x: coordinates[index], y: coordinates[index + 1] });
	const first = points[0];
	const last = points.at(-1)!;
	if (first.x !== last.x || first.y !== last.y)
		return { issue: '未显式闭合' };
	const vertices = points.slice(0, -1);
	if (vertices.length < 3 || vertices.some((point, index) => point.x === vertices[(index + 1) % vertices.length].x && point.y === vertices[(index + 1) % vertices.length].y))
		return { issue: '顶点不足或存在零长度边' };
	const unique = new Set(vertices.map(point => `${point.x},${point.y}`));
	if (unique.size !== vertices.length)
		return { issue: '存在重复顶点' };
	let twiceArea = 0;
	const origin = vertices[0];
	for (let index = 0; index < vertices.length; index++) {
		const current = vertices[index];
		const next = vertices[(index + 1) % vertices.length];
		twiceArea += (current.x - origin.x) * (next.y - origin.y) - (current.y - origin.y) * (next.x - origin.x);
	}
	if (!Number.isFinite(twiceArea) || twiceArea === 0)
		return { issue: '面积为零或坐标运算溢出' };
	for (let index = 0; index < vertices.length; index++) {
		const previous = vertices[(index + vertices.length - 1) % vertices.length];
		const current = vertices[index];
		const next = vertices[(index + 1) % vertices.length];
		const turn = cross(previous, current, next);
		const overlap = (previous.x - current.x) * (next.x - current.x) + (previous.y - current.y) * (next.y - current.y);
		if (!Number.isFinite(turn) || !Number.isFinite(overlap))
			return { issue: '坐标运算溢出，无法确认边界' };
		if (turn === 0 && overlap > 0)
			return { issue: '相邻边发生重叠' };
	}
	for (let firstEdge = 0; firstEdge < vertices.length; firstEdge++) {
		const a = vertices[firstEdge];
		const b = vertices[(firstEdge + 1) % vertices.length];
		for (let secondEdge = firstEdge + 1; secondEdge < vertices.length; secondEdge++) {
			if (secondEdge === firstEdge + 1 || (firstEdge === 0 && secondEdge === vertices.length - 1))
				continue;
			const c = vertices[secondEdge];
			const d = vertices[(secondEdge + 1) % vertices.length];
			const intersects = segmentsIntersect(a, b, c, d);
			if (intersects !== false)
				return { issue: intersects === null ? '坐标运算溢出，无法确认边界' : '存在自交、非相邻接触或重叠边' };
		}
	}
	return { points: vertices };
}

export function normalizeBoardOutlinePolylines(polylines: any[], boardLayer = 11): BoardOutlinePolylineResult {
	const lines: any[] = [];
	const summaries: BoardOutlinePolylineResult['summaries'] = [];
	const issues: string[] = [];
	const boardPolylines: any[] = [];
	for (const polyline of polylines) {
		const id = state<string>(polyline, 'PrimitiveId');
		const layer = state<number>(polyline, 'Layer');
		if (!finite(layer)) {
			issues.push(`折线图元 ${id ?? '(无 ID)'} 缺少有效图层`);
			continue;
		}
		if (layer === boardLayer)
			boardPolylines.push(polyline);
	}
	for (const polyline of boardPolylines) {
		const idValue = state<any>(polyline, 'PrimitiveId');
		const id = typeof idValue === 'string' ? idValue : null;
		const polygon = state<any>(polyline, 'Polygon');
		const source = typeof polygon?.getSource === 'function' ? polygon.getSource() : undefined;
		const summary = { id, source: source ?? null, lineCount: 0 };
		summaries.push(summary);
		const width = state<number>(polyline, 'LineWidth');
		if (!id?.trim() || !finite(width) || width <= 0) {
			issues.push(`板框折线 ${id ?? '(无 ID)'} 缺少有效 ID 或线宽`);
			continue;
		}
		let points: Point[];
		if (Array.isArray(source) && source[0] === 'R') {
			if (source.length !== 7) {
				issues.push(`板框折线 ${id} 不是受支持的零旋转直角矩形`);
				continue;
			}
			const [, x, y, widthMil, heightMil, rotation, radius] = source;
			if (![x, y, widthMil, heightMil, rotation, radius].every(finite) || widthMil <= 0 || heightMil <= 0 || rotation !== 0 || radius !== 0) {
				issues.push(`板框折线 ${id} 的矩形坐标、尺寸、旋转或圆角无效`);
				continue;
			}
			points = [
				{ x, y },
				{ x: x + widthMil, y },
				{ x: x + widthMil, y: y - heightMil },
				{ x, y: y - heightMil },
			];
			if (points.some(point => !finite(point.x) || !finite(point.y))
				|| points[1].x <= points[0].x || points[3].y >= points[0].y) {
				issues.push(`板框折线 ${id} 的矩形角点溢出或尺寸退化`);
				continue;
			}
		}
		else {
			const parsed = parseClosedStraightPolygon(source);
			if (!parsed.points) {
				issues.push(`板框折线 ${id} 的 POLY 无效：${parsed.issue}`);
				continue;
			}
			points = parsed.points;
		}
		for (let index = 0; index < points.length; index++) {
			const start = points[index];
			const end = points[(index + 1) % points.length];
			lines.push({
				getState_PrimitiveId: () => id,
				getState_Layer: () => boardLayer,
				getState_StartX: () => start.x,
				getState_StartY: () => start.y,
				getState_EndX: () => end.x,
				getState_EndY: () => end.y,
				getState_LineWidth: () => width,
				getState_ArcAngle: () => 0,
			});
		}
		summary.lineCount = points.length;
	}
	return { lines: issues.length ? [] : lines, summaries, issues };
}
