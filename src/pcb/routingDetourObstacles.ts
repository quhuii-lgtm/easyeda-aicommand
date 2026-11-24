/**
 * Read-only geometric review of shorter alternatives for a traced PCB route.
 * Candidates are suggestions only: this module neither changes copper nor
 * proves host connectivity, manufacturing-rule coverage, or electrical safety.
 */

export interface DetourPoint { x: number; y: number }
export type DetourEndpoint = 'start' | 'end';

export interface DetourPathSource {
	id: string;
	objectIds?: string[];
	net: string;
	layer: number;
	widthMil: number;
	points: DetourPoint[];
	locked?: boolean;
	/** True if replacing this source is known to affect existing copper contact. */
	protected?: boolean;
}

export type DetourObstacleGeometry
	= | { kind: 'segment'; a: DetourPoint; b: DetourPoint; widthMil: number }
		| { kind: 'circle'; center: DetourPoint; radiusMil: number }
		| { kind: 'polyline'; paths: DetourPoint[][]; strokeMil: number }
		| { kind: 'polygon'; rings: DetourPoint[][]; strokeMil?: number };

export interface DetourObstacle {
	id: string;
	kind: 'track' | 'arc-approximation' | 'via' | 'pad' | 'copper' | 'keepout' | 'slot' | 'other';
	net?: string;
	/** null means layer coverage is unknown and the obstacle is treated as relevant. */
	layers: number[] | null;
	geometry: DetourObstacleGeometry;
	locked?: boolean;
	protected?: boolean;
	approximate?: boolean;
}

export interface DetourTerminalContact {
	obstacleId: string;
	endpoint: DetourEndpoint;
	/** Maximum path distance from that endpoint where contact is intentional. */
	windowMil: number;
}

export interface DetourAssessmentInput {
	source: DetourPathSource;
	/** First ring is the board exterior; further rings are holes/slots (even-odd fill). */
	boardRings?: DetourPoint[][];
	obstacles: DetourObstacle[];
	/** Explicitly identified terminal contacts; same-net contact is not inferred. */
	terminalContacts?: DetourTerminalContact[];
	/** Existing non-terminal contacts which the replacement must retain. */
	protectedContactObjectIds?: string[];
	/** `verified-active-rule` must only be used after the caller read the active rule. */
	clearanceRule?: { valueMil: number; evidence: 'verified-active-rule'; ruleId?: string };
	edgeClearanceRule?: { valueMil: number; evidence: 'verified-active-rule'; ruleId?: string };
	/** False when any relevant track, pad, via, copper, or keepout could not be read. */
	obstacleCoverageComplete: boolean;
	coverageNotes?: string[];
	minimumSavingsMil?: number;
	/** Caller-read local restrictions; they downgrade results to human review. */
	usageLimitations?: string[];
}

export interface RoutingDetourBoardInput {
	source: DetourPathSource;
	outline?: DetourPoint[][];
	tracks: Array<{ id: string; net: string; layer: number; width: number; a: DetourPoint; b: DetourPoint; locked?: boolean; arc?: number }>;
	vias: Array<{ id: string; net: string; x: number; y: number; diameter: number; hole: number; layers: number[] | null; locked?: boolean }>;
	pads: Array<{ id: string; net: string; x: number; y: number; layers: number[]; radius: number; approximate?: boolean }>;
	copper: Array<{ id: string; net: string; layer: number; rings: DetourPoint[][]; stroke?: number }>;
	keepouts?: Array<{ id: string; layer?: number; rings: DetourPoint[][]; source?: string }>;
	issues: Array<{ id?: string; objectId?: string; net?: string; layer?: number; reason?: string; message?: string }>;
	rules: { clearanceMil?: number; edgeClearanceMil?: number };
	terminalContacts?: { start: Array<{ id: string; windowMil: number }>; end: Array<{ id: string; windowMil: number }> };
	protectedContactObjectIds?: string[];
	obstacleCoverageComplete: boolean;
	coverageNotes?: string[];
	usageLimitations?: string[];
	minimumSavingsMil?: number;
}

export interface DetourBlocker {
	code: 'outside-board' | 'board-boundary' | 'board-hole' | 'obstacle-overlap' | 'clearance' | 'unintended-same-net-contact' | 'protected-contact-lost' | 'locked-source' | 'protected-source' | 'invalid-geometry';
	message: string;
	objectId?: string;
	segmentIndex?: number;
}

export interface DetourPathCandidate {
	style: 'direct' | 'orthogonal-L' | '45-degree-combination';
	points: DetourPoint[];
	lengthMil: number;
	savingsMil: number;
	turnCount: number;
	geometry: 'clear' | 'blocked' | 'unknown';
	decision: 'manual-review-candidate' | 'blocked' | 'geometry-preview-only';
	blockers: DetourBlocker[];
	flags: string[];
}

export interface DetourAssessment {
	sourceId: string;
	net: string;
	layer: number;
	currentLengthMil: number;
	currentTurnCount: number;
	candidates: DetourPathCandidate[];
	coverage: { boardOutline: boolean; obstaclesComplete: boolean; spacingRule: 'verified' | 'unknown'; notes: string[] };
	limitations: string[];
	readOnly: true;
	noViaReductionClaim: true;
}

const EPS = 1e-7;
const TOUCH_TOLERANCE = 0.02;
const distance = (a: DetourPoint, b: DetourPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePoint = (p: DetourPoint) => Number.isFinite(p.x) && Number.isFinite(p.y);

function pathLength(points: DetourPoint[]): number {
	return points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);
}

function simplify(points: DetourPoint[]): DetourPoint[] {
	const result: DetourPoint[] = [];
	for (const point of points) {
		if (result.length && distance(result.at(-1)!, point) <= EPS)
			continue;
		result.push(point);
		while (result.length >= 3) {
			const a = result[result.length - 3];
			const b = result[result.length - 2];
			const c = result[result.length - 1];
			const ab = { x: b.x - a.x, y: b.y - a.y };
			const bc = { x: c.x - b.x, y: c.y - b.y };
			const cross = ab.x * bc.y - ab.y * bc.x;
			const dot = ab.x * bc.x + ab.y * bc.y;
			if (Math.abs(cross) <= EPS * Math.max(1, Math.hypot(ab.x, ab.y) * Math.hypot(bc.x, bc.y)) && dot >= 0)
				result.splice(result.length - 2, 1);
			else
				break;
		}
	}
	return result;
}

function turnCount(points: DetourPoint[]): number {
	let count = 0;
	for (let i = 1; i + 1 < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		const c = points[i + 1];
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		if (Math.abs(cross) > EPS)
			count++;
	}
	return count;
}

function directionsSupported(points: DetourPoint[]): boolean {
	for (let i = 1; i < points.length; i++) {
		const dx = Math.abs(points[i].x - points[i - 1].x);
		const dy = Math.abs(points[i].y - points[i - 1].y);
		const tolerance = EPS * Math.max(1, dx, dy);
		if (dx <= tolerance || dy <= tolerance || Math.abs(dx - dy) <= tolerance)
			continue;
		return false;
	}
	return true;
}

function pointSequenceKey(points: DetourPoint[]): string {
	return points.map(point => `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`).join(';');
}

function pointSegmentDistance(p: DetourPoint, a: DetourPoint, b: DetourPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const denominator = dx * dx + dy * dy;
	if (denominator <= EPS * EPS)
		return distance(p, a);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denominator));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function orientation(a: DetourPoint, b: DetourPoint, c: DetourPoint): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(p: DetourPoint, a: DetourPoint, b: DetourPoint): boolean {
	return Math.abs(orientation(a, b, p)) <= EPS * Math.max(1, distance(a, b))
		&& p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
		&& p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}

function segmentsIntersect(a: DetourPoint, b: DetourPoint, c: DetourPoint, d: DetourPoint): boolean {
	const o1 = orientation(a, b, c);
	const o2 = orientation(a, b, d);
	const o3 = orientation(c, d, a);
	const o4 = orientation(c, d, b);
	if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
		&& ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) {
		return true;
	}
	return (Math.abs(o1) <= EPS && onSegment(c, a, b)) || (Math.abs(o2) <= EPS && onSegment(d, a, b))
		|| (Math.abs(o3) <= EPS && onSegment(a, c, d)) || (Math.abs(o4) <= EPS && onSegment(b, c, d));
}

function segmentDistance(a: DetourPoint, b: DetourPoint, c: DetourPoint, d: DetourPoint): number {
	if (segmentsIntersect(a, b, c, d))
		return 0;
	return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function ringEdges(ring: DetourPoint[]): Array<[DetourPoint, DetourPoint]> {
	return ring.map((point, index) => [point, ring[(index + 1) % ring.length]] as [DetourPoint, DetourPoint]);
}

function pointInRings(point: DetourPoint, rings: DetourPoint[][]): boolean {
	let inside = false;
	for (const ring of rings) {
		for (const [a, b] of ringEdges(ring)) {
			if (onSegment(point, a, b))
				return true;
			if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)
				inside = !inside;
		}
	}
	return inside;
}

function segmentPolygonDistance(a: DetourPoint, b: DetourPoint, rings: DetourPoint[][]): number {
	if (pointInRings(a, rings) || pointInRings(b, rings))
		return 0;
	let result = Infinity;
	for (const ring of rings) {
		for (const [c, d] of ringEdges(ring)) {
			result = Math.min(result, segmentDistance(a, b, c, d));
			if (result <= EPS)
				return 0;
		}
	}
	return result;
}

function distanceToRingEdges(a: DetourPoint, b: DetourPoint, rings: DetourPoint[][]): number {
	let result = Infinity;
	for (const ring of rings) {
		for (const [c, d] of ringEdges(ring))
			result = Math.min(result, segmentDistance(a, b, c, d));
	}
	return result;
}

function geometryDistance(a: DetourPoint, b: DetourPoint, geometry: DetourObstacleGeometry): number {
	if (geometry.kind === 'segment')
		return segmentDistance(a, b, geometry.a, geometry.b) - geometry.widthMil / 2;
	if (geometry.kind === 'circle')
		return pointSegmentDistance(geometry.center, a, b) - geometry.radiusMil;
	if (geometry.kind === 'polyline') {
		let result = Infinity;
		for (const path of geometry.paths) {
			for (let i = 1; i < path.length; i++)
				result = Math.min(result, segmentDistance(a, b, path[i - 1], path[i]));
		}
		return result - geometry.strokeMil / 2;
	}
	return segmentPolygonDistance(a, b, geometry.rings) - (geometry.strokeMil ?? 0) / 2;
}

function validRings(rings: DetourPoint[][] | undefined): rings is DetourPoint[][] {
	return Boolean(rings?.length && rings.every(ring => ring.length >= 3 && ring.every(finitePoint)));
}

function candidatePaths(a: DetourPoint, b: DetourPoint): Array<{ style: DetourPathCandidate['style']; points: DetourPoint[] }> {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const sx = Math.sign(dx);
	const sy = Math.sign(dy);
	const ax = Math.abs(dx);
	const ay = Math.abs(dy);
	const paths: Array<{ style: DetourPathCandidate['style']; points: DetourPoint[] }> = [
		{ style: 'direct', points: [a, b] },
		{ style: 'orthogonal-L', points: [a, { x: b.x, y: a.y }, b] },
		{ style: 'orthogonal-L', points: [a, { x: a.x, y: b.y }, b] },
	];
	if (ax >= ay) {
		paths.push(
			{ style: '45-degree-combination', points: [a, { x: a.x + sx * ay, y: b.y }, b] },
			{ style: '45-degree-combination', points: [a, { x: a.x + sx * (ax - ay), y: a.y }, b] },
		);
	}
	else {
		paths.push(
			{ style: '45-degree-combination', points: [a, { x: b.x, y: a.y + sy * ax }, b] },
			{ style: '45-degree-combination', points: [a, { x: a.x, y: a.y + sy * (ay - ax) }, b] },
		);
	}
	const seen = new Set<string>();
	return paths.map(item => ({ ...item, points: simplify(item.points) }))
		.filter(item => item.points.length >= 2)
		.filter((item) => {
			const key = pointSequenceKey(item.points);
			if (seen.has(key))
				return false;
			seen.add(key);
			return true;
		});
}

function trimPathAtEndpoint(points: DetourPoint[], endpoint: DetourEndpoint, windowMil: number): DetourPoint[] {
	const ordered = endpoint === 'start' ? points : [...points].reverse();
	let remaining = windowMil;
	const kept = [ordered[0]];
	for (let i = 1; i < ordered.length; i++) {
		const start = ordered[i - 1];
		const end = ordered[i];
		const segmentLength = distance(start, end);
		if (remaining >= segmentLength) {
			remaining -= segmentLength;
			continue;
		}
		const ratio = segmentLength ? remaining / segmentLength : 0;
		kept.push({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio });
		kept.push(...ordered.slice(i + 1));
		break;
	}
	if (kept.length === 1)
		return [];
	return endpoint === 'start' ? kept : kept.reverse();
}

function contactDistance(points: DetourPoint[], geometry: DetourObstacleGeometry): number {
	let best = Infinity;
	for (let i = 1; i < points.length; i++)
		best = Math.min(best, geometryDistance(points[i - 1], points[i], geometry));
	return best;
}

function pointOutsideBoard(point: DetourPoint, rings: DetourPoint[][]): boolean {
	return !pointInRings(point, rings);
}

function candidateBlockers(
	points: DetourPoint[],
	input: DetourAssessmentInput,
	spacingMil: number | undefined,
	edgeSpacingMil: number | undefined,
): DetourBlocker[] {
	const blockers: DetourBlocker[] = [];
	const { source } = input;
	const board = input.boardRings;
	if (board) {
		for (const point of points) {
			if (pointOutsideBoard(point, board)) {
				blockers.push({ code: 'outside-board', message: '候选路径中心线有顶点位于板框之外或落在开槽内' });
				break;
			}
		}
		for (let i = 1; i < points.length; i++) {
			const a = points[i - 1];
			const b = points[i];
			const boundaryDistance = distanceToRingEdges(a, b, board);
			const edgeMargin = edgeSpacingMil ?? 0;
			if (boundaryDistance <= source.widthMil / 2 + edgeMargin + TOUCH_TOLERANCE) {
				const hole = pointInRings({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, board) === false;
				blockers.push({ code: hole ? 'board-hole' : 'board-boundary', message: `线宽半径 ${source.widthMil / 2} mil 加已知边距 ${edgeMargin} mil 未与板边/开槽保持距离`, segmentIndex: i - 1 });
			}
			const length = distance(a, b);
			const steps = Math.max(1, Math.ceil(length / 10));
			for (let step = 1; step < steps; step++) {
				const ratio = step / steps;
				const sample = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
				if (!pointInRings(sample, board)) {
					blockers.push({ code: 'outside-board', message: '线段中途穿过凹边外侧或开槽', segmentIndex: i - 1 });
					break;
				}
			}
		}
	}

	const sourceIds = new Set([source.id, ...(source.objectIds ?? [])]);
	const protectedContacts = new Set(input.protectedContactObjectIds ?? []);
	const allowed = new Map((input.terminalContacts ?? []).map(contact => [contact.obstacleId, contact]));
	for (const obstacle of input.obstacles) {
		if (sourceIds.has(obstacle.id))
			continue;
		if (obstacle.layers && !obstacle.layers.includes(source.layer))
			continue;
		const contact = allowed.get(obstacle.id);
		let nearest = contactDistance(points, obstacle.geometry);
		if (contact && contact.windowMil >= 0) {
			const afterWindow = trimPathAtEndpoint(points, contact.endpoint, contact.windowMil);
			nearest = afterWindow.length >= 2 ? contactDistance(afterWindow, obstacle.geometry) : Infinity;
		}
		const physicalRadius = source.widthMil / 2;
		const sameNet = obstacle.net === source.net;
		const requiredGap = sameNet ? 0 : spacingMil;
		const threshold = physicalRadius + (requiredGap ?? 0);
		const nearObstacle = nearest <= threshold + TOUCH_TOLERANCE;
		if (nearest <= physicalRadius + TOUCH_TOLERANCE) {
			if (sameNet && !contact && !protectedContacts.has(obstacle.id)) {
				blockers.push({ code: 'unintended-same-net-contact', message: '候选会接触未指定的同网络对象；可能新增支路或改变原连通关系', objectId: obstacle.id });
			}
			else {
				if (!protectedContacts.has(obstacle.id))
					blockers.push({ code: sameNet ? 'unintended-same-net-contact' : 'obstacle-overlap', message: `${obstacle.kind} 与候选路径物理重叠`, objectId: obstacle.id });
			}
		}
		else if (!sameNet && spacingMil !== undefined && nearObstacle) {
			blockers.push({ code: 'clearance', message: `与 ${obstacle.kind} 未达到已确认净距 ${spacingMil} mil`, objectId: obstacle.id });
		}
		else if (!sameNet && !obstacle.net && nearObstacle) {
			blockers.push({ code: 'clearance', message: '附近对象没有可靠网络标签，无法确认其净距关系', objectId: obstacle.id });
		}
		if (obstacle.approximate && nearObstacle)
			blockers.push({ code: 'invalid-geometry', message: '障碍几何为近似表示，需人工核对', objectId: obstacle.id });
		if ((obstacle.locked || obstacle.protected) && nearObstacle)
			blockers.push({ code: 'invalid-geometry', message: '附近对象已锁定或标记保护，需人工检查其潜在铜接触', objectId: obstacle.id });
	}
	if (source.locked)
		blockers.push({ code: 'locked-source', message: '源线路已锁定，不建议替换' });
	if (source.protected)
		blockers.push({ code: 'protected-source', message: '源线路标记为受保护内容，需人工确认后才可考虑修改' });
	return dedupeBlockers(blockers);
}

function dedupeBlockers(blockers: DetourBlocker[]): DetourBlocker[] {
	const seen = new Set<string>();
	return blockers.filter((blocker) => {
		const key = `${blocker.code}:${blocker.objectId ?? ''}:${blocker.segmentIndex ?? ''}`;
		if (seen.has(key))
			return false;
		seen.add(key);
		return true;
	});
}

/** Evaluate shorter direct and same-layer orthogonal/45-degree alternatives. */
export function evaluateRoutingDetour(input: DetourAssessmentInput): DetourAssessment {
	const { source } = input;
	const notes = [...(input.coverageNotes ?? [])];
	const limitations: string[] = [
		'只评估同层几何候选；不提出减少过孔方案。',
		'候选只供人工复核，不写入、不自动改线，也不替代 EDA 连通检查或完整 DRC。',
		'原路径与实填铜、同网分支、热焊及对象拆并关系需调用端提供证据；未确认的接触不得视为安全。',
	];
	for (const limitation of input.usageLimitations ?? [])
		limitations.push(`调用端用途限制：${limitation}`);
	const validSource = typeof source.id === 'string' && source.id.length > 0
		&& typeof source.net === 'string' && source.net.length > 0
		&& Number.isInteger(source.layer) && Number.isFinite(source.widthMil) && source.widthMil > 0
		&& Array.isArray(source.points) && source.points.length >= 2 && source.points.every(finitePoint);
	const boardOk = validRings(input.boardRings);
	if (!boardOk)
		notes.push('未提供可解析的板框外轮廓及开槽；候选不能判为通过。');
	const spacing = input.clearanceRule?.evidence === 'verified-active-rule'
		&& Number.isFinite(input.clearanceRule.valueMil) && input.clearanceRule.valueMil >= 0
		? input.clearanceRule.valueMil
		: undefined;
	const edgeSpacing = input.edgeClearanceRule?.evidence === 'verified-active-rule'
		&& Number.isFinite(input.edgeClearanceRule.valueMil) && input.edgeClearanceRule.valueMil >= 0
		? input.edgeClearanceRule.valueMil
		: undefined;
	if (spacing === undefined)
		notes.push('没有调用端确认的当前网络/区域净距；只提供几何预览，不判断规则合格。');
	if (edgeSpacing === undefined)
		notes.push('没有调用端确认的当前板边净距；只检查不越界和线宽物理包络。');
	if (!input.obstacleCoverageComplete)
		notes.push('障碍读取不完整；未知走线、孔、焊盘、铜区或禁布区可能改变结论。');
	if (!validSource) {
		return {
			sourceId: source?.id ?? '',
			net: source?.net ?? '',
			layer: source?.layer ?? -1,
			currentLengthMil: 0,
			currentTurnCount: 0,
			candidates: [],
			coverage: { boardOutline: boardOk, obstaclesComplete: false, spacingRule: spacing === undefined || edgeSpacing === undefined ? 'unknown' : 'verified', notes },
			limitations: [...limitations, '源路径缺少有效 ID、网络、层、线宽或路径点，无法计算。'],
			readOnly: true,
			noViaReductionClaim: true,
		};
	}
	const currentPath = simplify(source.points);
	const currentLength = pathLength(currentPath);
	const start = currentPath[0];
	const end = currentPath.at(-1)!;
	const minimumSavings = Number.isFinite(input.minimumSavingsMil) && input.minimumSavingsMil! >= 0 ? input.minimumSavingsMil! : 1;
	const sourceIds = new Set([source.id, ...(source.objectIds ?? [])]);
	const currentContacts = new Set<string>();
	for (const obstacle of input.obstacles) {
		if (sourceIds.has(obstacle.id))
			continue;
		if (obstacle.layers && !obstacle.layers.includes(source.layer))
			continue;
		if (contactDistance(currentPath, obstacle.geometry) <= source.widthMil / 2 + TOUCH_TOLERANCE)
			currentContacts.add(obstacle.id);
	}
	const requiredContacts = new Set([...(input.protectedContactObjectIds ?? []), ...[...currentContacts].filter((id) => {
		const found = input.obstacles.find(obstacle => obstacle.id === id);
		return found?.kind === 'copper' || found?.kind === 'via' || found?.protected === true;
	})]);
	const seenCandidatePaths = new Set<string>();
	const candidates = candidatePaths(start, end)
		.map(({ style, points }) => {
			const lengthMil = pathLength(points);
			const savingsMil = currentLength - lengthMil;
			const blockers = candidateBlockers(points, input, spacing, edgeSpacing);
			for (const objectId of requiredContacts) {
				const obstacle = input.obstacles.find(item => item.id === objectId);
				if (!obstacle)
					blockers.push({ code: 'protected-contact-lost', message: '原路径保护接触的对象未在障碍数据中，无法比较是否保留', objectId });
				else if (contactDistance(points, obstacle.geometry) > source.widthMil / 2 + TOUCH_TOLERANCE)
					blockers.push({ code: 'protected-contact-lost', message: '候选路径未保留原路径与此对象的潜在接触', objectId });
			}
			const relevant = savingsMil > minimumSavings;
			const actualBlockers = relevant ? dedupeBlockers(blockers) : [];
			const supportedAngles = directionsSupported(points);
			const complete = boardOk && input.obstacleCoverageComplete && spacing !== undefined && edgeSpacing !== undefined
				&& !points.some(point => !finitePoint(point)) && (input.usageLimitations?.length ?? 0) === 0;
			const geometry: DetourPathCandidate['geometry'] = actualBlockers.length ? 'blocked' : complete && supportedAngles ? 'clear' : 'unknown';
			const decision: DetourPathCandidate['decision'] = actualBlockers.length ? 'blocked' : complete && supportedAngles ? 'manual-review-candidate' : 'geometry-preview-only';
			const flags: string[] = [];
			if (!supportedAngles)
				flags.push('含非水平、垂直或 45 度线段；仅作长度下界，不能作为建议路径');
			if (!relevant)
				flags.push(`缩短量不超过 ${minimumSavings} mil，未列为缩短候选`);
			if (!boardOk)
				flags.push('板框边界/开槽未验证');
			if (spacing === undefined || edgeSpacing === undefined)
				flags.push('板内或板边净距规则未知');
			if (!input.obstacleCoverageComplete)
				flags.push('障碍覆盖不完整');
			if (input.obstacles.some(obstacle => obstacle.approximate && obstacle.layers?.includes(source.layer)))
				flags.push('存在近似障碍几何');
			if (currentPath.length > 2 && turnCount(points) >= turnCount(currentPath))
				flags.push('候选没有减少转弯数');
			if (requiredContacts.size)
				flags.push('原路径有需要保持的铜接触；候选仅作人工核对');
			for (const limitation of input.usageLimitations ?? [])
				flags.push(`用途需人工确认：${limitation}`);
			return { style, points, lengthMil, savingsMil, turnCount: turnCount(points), geometry, decision, blockers: actualBlockers, flags };
		})
		.filter(candidate => candidate.savingsMil > minimumSavings)
		.filter((candidate) => {
			const key = pointSequenceKey(candidate.points);
			if (seenCandidatePaths.has(key))
				return false;
			seenCandidatePaths.add(key);
			return true;
		})
		.sort((a, b) => a.lengthMil - b.lengthMil || a.turnCount - b.turnCount);
	if (!candidates.length)
		notes.push(`没有找到比当前路径至少短 ${minimumSavings} mil 的直线或 45 度组合候选。`);
	return {
		sourceId: source.id,
		net: source.net,
		layer: source.layer,
		currentLengthMil: currentLength,
		currentTurnCount: turnCount(currentPath),
		candidates,
		coverage: { boardOutline: boardOk, obstaclesComplete: input.obstacleCoverageComplete, spacingRule: spacing === undefined || edgeSpacing === undefined ? 'unknown' : 'verified', notes },
		limitations,
		readOnly: true,
		noViaReductionClaim: true,
	};
}

/**
 * Adapter for the board snapshot used by routing-remnant analysis. Geometry is
 * intentionally conservative: pads use their supplied containing radius, vias
 * use copper diameter, and arcs use a containing circle instead of a chord.
 */
export function assessRoutingDetour(input: RoutingDetourBoardInput): DetourAssessment {
	const sourceIds = new Set([input.source.id, ...(input.source.objectIds ?? [])]);
	const obstacles: DetourObstacle[] = [];
	for (const track of input.tracks) {
		if (sourceIds.has(track.id) || track.layer !== input.source.layer)
			continue;
		if (Number.isFinite(track.arc) && track.arc !== 0) {
			// A circle containing the entire arc is a safe broad-phase obstacle.
			// It may reject a usable candidate near the arc, hence the approximation flag.
			try {
				const dx = track.b.x - track.a.x;
				const dy = track.b.y - track.a.y;
				const chord = Math.hypot(dx, dy);
				const sweep = track.arc! * Math.PI / 180;
				const radius = chord / (2 * Math.sin(Math.abs(sweep) / 2));
				const offset = chord / (2 * Math.tan(sweep / 2));
				const middle = { x: (track.a.x + track.b.x) / 2, y: (track.a.y + track.b.y) / 2 };
				const left = { x: -dy / chord, y: dx / chord };
				const center = { x: middle.x + left.x * offset, y: middle.y + left.y * offset };
				if (![radius, center.x, center.y].every(Number.isFinite) || radius <= 0)
					throw new Error('invalid arc');
				obstacles.push({ id: track.id, kind: 'arc-approximation', net: track.net || undefined, layers: [track.layer], geometry: { kind: 'circle', center, radiusMil: radius + track.width / 2 }, locked: track.locked, approximate: true });
			}
			catch {
				obstacles.push({ id: track.id, kind: 'arc-approximation', net: track.net || undefined, layers: [track.layer], geometry: { kind: 'segment', a: track.a, b: track.b, widthMil: track.width }, locked: track.locked, approximate: true });
			}
		}
		else {
			obstacles.push({ id: track.id, kind: 'track', net: track.net || undefined, layers: [track.layer], geometry: { kind: 'segment', a: track.a, b: track.b, widthMil: track.width }, locked: track.locked });
		}
	}
	for (const via of input.vias) {
		if (sourceIds.has(via.id))
			continue;
		obstacles.push({ id: via.id, kind: 'via', net: via.net || undefined, layers: via.layers, geometry: { kind: 'circle', center: { x: via.x, y: via.y }, radiusMil: via.diameter / 2 }, locked: via.locked });
	}
	for (const pad of input.pads) {
		if (sourceIds.has(pad.id))
			continue;
		obstacles.push({ id: pad.id, kind: 'pad', net: pad.net || undefined, layers: pad.layers, geometry: { kind: 'circle', center: { x: pad.x, y: pad.y }, radiusMil: pad.radius }, approximate: pad.approximate });
	}
	for (const copper of input.copper) {
		if (sourceIds.has(copper.id) || copper.layer !== input.source.layer)
			continue;
		obstacles.push({ id: copper.id, kind: 'copper', net: copper.net || undefined, layers: [copper.layer], geometry: copper.stroke !== undefined
			? { kind: 'polyline', paths: copper.rings, strokeMil: copper.stroke }
			: { kind: 'polygon', rings: copper.rings } });
	}
	for (const keepout of input.keepouts ?? []) {
		if (keepout.layer !== undefined && keepout.layer !== input.source.layer)
			continue;
		obstacles.push({ id: keepout.id, kind: 'keepout', layers: keepout.layer === undefined ? null : [keepout.layer], geometry: { kind: 'polygon', rings: keepout.rings } });
	}
	const relevantIssues = input.issues.filter(issue =>
		(issue.net === undefined || issue.net === '' || issue.net === input.source.net)
		&& (issue.layer === undefined || issue.layer === input.source.layer));
	const knownContacts = new Set<string>(input.protectedContactObjectIds ?? []);
	for (const obstacle of obstacles) {
		if (obstacle.layers && !obstacle.layers.includes(input.source.layer))
			continue;
		if (obstacle.net === input.source.net
			&& contactDistance(input.source.points, obstacle.geometry) <= input.source.widthMil / 2 + TOUCH_TOLERANCE) {
			knownContacts.add(obstacle.id);
		}
	}
	const terminalContacts: DetourTerminalContact[] = [];
	for (const contact of input.terminalContacts?.start ?? [])
		terminalContacts.push({ obstacleId: contact.id, endpoint: 'start', windowMil: contact.windowMil });
	for (const contact of input.terminalContacts?.end ?? [])
		terminalContacts.push({ obstacleId: contact.id, endpoint: 'end', windowMil: contact.windowMil });
	const coverageNotes = [...(input.coverageNotes ?? [])];
	if (relevantIssues.length) {
		coverageNotes.push(...relevantIssues.map(issue => `障碍/路径覆盖问题 ${issue.id ?? issue.objectId ?? '(无 ID)'}：${issue.reason ?? issue.message ?? '未提供原因'}`));
	}
	const clearance = Number.isFinite(input.rules.clearanceMil) && input.rules.clearanceMil! >= 0
		? { valueMil: input.rules.clearanceMil!, evidence: 'verified-active-rule' as const }
		: undefined;
	const edgeClearance = Number.isFinite(input.rules.edgeClearanceMil) && input.rules.edgeClearanceMil! >= 0
		? { valueMil: input.rules.edgeClearanceMil!, evidence: 'verified-active-rule' as const }
		: undefined;
	return evaluateRoutingDetour({
		source: input.source,
		boardRings: input.outline,
		obstacles,
		terminalContacts,
		protectedContactObjectIds: [...knownContacts],
		clearanceRule: clearance,
		edgeClearanceRule: edgeClearance,
		obstacleCoverageComplete: input.obstacleCoverageComplete && relevantIssues.length === 0,
		coverageNotes,
		minimumSavingsMil: input.minimumSavingsMil,
		usageLimitations: input.usageLimitations,
	});
}
