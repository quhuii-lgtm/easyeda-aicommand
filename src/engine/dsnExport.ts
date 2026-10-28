export interface DsnRepairChange {
	kind: 'class-net-reference' | 'parser-quote-settings' | 'plane' | 'slot-clearance' | 'layer-width' | 'default-layer-width';
	from: string;
	to: string;
	line: number;
	net?: string;
	className?: string;
	layerId?: number;
	layerName?: string;
	layer?: string;
	fromWidthMil?: number;
	toWidthMil?: number;
}

export interface DsnRepairResult {
	originalText: string;
	text: string;
	changed: boolean;
	changes: DsnRepairChange[];
	warnings: string[];
	limitations: string[];
	slotClearance?: DsnSlotClearanceDiagnostics;
}

export interface DsnSlotClearanceInput {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DsnSlotClearanceDiagnostics {
	appliedSlotIds: string[];
	skippedSlots: Array<{ id: string; reason: string }>;
	clearanceMil: number;
	conservativeDefaultClass: true;
	planeSlotEquivalent: false;
	provenance?: string;
}

export interface DsnPlaneRegion {
	id: string;
	net: string;
	layerName: string;
	pointsMil: { x: number; y: number }[];
}

export interface DsnAtom {
	type: 'atom';
	value: string;
	raw: string;
	quote: 'none' | 'double' | 'single';
	start: number;
	end: number;
}

export interface DsnList {
	type: 'list';
	items: DsnNode[];
	start: number;
	end: number;
}

export type DsnNode = DsnAtom | DsnList;
type Atom = DsnAtom;
type List = DsnList;
type Node = DsnNode;

function isAtom(node: Node | undefined, value?: string): node is Atom {
	return Boolean(node && node.type === 'atom' && (value === undefined || node.value === value));
}

function tokenize(source: string): Node[] {
	const roots: Node[] = [];
	const stack: List[] = [];
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (char === ';' || (char === '#' && (i === 0 || /\s/.test(source[i - 1])))) {
			while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
			continue;
		}
		if (char === '(') {
			const list: List = { type: 'list', items: [], start: i, end: -1 };
			if (stack.length)
				stack.at(-1)!.items.push(list);
			else roots.push(list);
			stack.push(list);
			i++;
			continue;
		}
		if (char === ')') {
			const list = stack.pop();
			if (!list)
				throw new Error(`DSN 中存在未配对的右括号，位置 ${i}`);
			list.end = i + 1;
			i++;
			continue;
		}
		// The DSN declaration is conventionally written `(string_quote ")`.
		// Its quote character is a bare one-character value, not an open string.
		const isQuoteDeclaration = char === '"' && /\(\s*string_quote\s*$/.test(source.slice(Math.max(0, i - 32), i));
		if ((char === '"' || char === '\'') && !isQuoteDeclaration) {
			const quote = char;
			const start = i++;
			let value = '';
			let closed = false;
			while (i < source.length) {
				const next = source[i++];
				if (next === quote) {
					const followsTokenBoundary = i >= source.length || /[\s)]/.test(source[i]);
					if (quote === '"' || followsTokenBoundary) {
						closed = true;
						break;
					}
					value += next;
					continue;
				}
				if (next === '\\') {
					if (i >= source.length)
						break;
					const escaped = source[i++];
					value += escaped;
				}
				else {
					value += next;
				}
			}
			if (!closed)
				throw new Error(`DSN 中存在未闭合字符串，位置 ${start}：${JSON.stringify(source.slice(start, start + 64))}`);
			const atom: Atom = { type: 'atom', value, raw: source.slice(start, i), quote: quote === '"' ? 'double' : 'single', start, end: i };
			if (stack.length)
				stack.at(-1)!.items.push(atom);
			else roots.push(atom);
			continue;
		}
		const start = i;
		while (i < source.length && !/[\s()]/.test(source[i])) i++;
		if (i === start) {
			i++;
			const atom: Atom = { type: 'atom', value: char, raw: char, quote: 'none', start, end: i };
			if (stack.length)
				stack.at(-1)!.items.push(atom);
			else roots.push(atom);
			continue;
		}
		const raw = source.slice(start, i);
		const atom: Atom = { type: 'atom', value: raw, raw, quote: 'none', start, end: i };
		if (stack.length)
			stack.at(-1)!.items.push(atom);
		else roots.push(atom);
	}
	if (stack.length)
		throw new Error('DSN 中存在未闭合的括号');
	return roots;
}

export function tokenizeDsn(source: string): DsnNode[] {
	return tokenize(source);
}

function head(list: List): string | undefined {
	return isAtom(list.items[0]) ? list.items[0].value.toLowerCase() : undefined;
}

function walkLists(nodes: Node[], expected: string): List[] {
	const result: List[] = [];
	for (const node of nodes) {
		if (node.type !== 'list')
			continue;
		if (head(node) === expected)
			result.push(node);
		result.push(...walkLists(node.items, expected));
	}
	return result;
}

function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (source[i] === '\n')
			line++;
	}
	return line;
}

function encodeDsnString(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function getDsnName(atom: Atom, quoteStyle: string): string {
	return quoteStyle === '"' && atom.quote === 'single' ? atom.raw : atom.value;
}

function numberKey(value: number): string {
	return Object.is(value, -0) ? '0' : String(value);
}

function canonicalPolygonKey(points: { x: number; y: number }[]): string {
	const open = points.slice(0, -1).map(point => `${numberKey(point.x)},${numberKey(point.y)}`);
	const candidates: string[] = [];
	for (const sequence of [open, [...open].reverse()]) {
		for (let start = 0; start < sequence.length; start++)
			candidates.push([...sequence.slice(start), ...sequence.slice(0, start)].join(';'));
	}
	return candidates.sort()[0] ?? '';
}

function orientation(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, epsilon: number): boolean {
	return Math.abs(orientation(a, b, point)) <= epsilon
		&& point.x >= Math.min(a.x, b.x) - epsilon && point.x <= Math.max(a.x, b.x) + epsilon
		&& point.y >= Math.min(a.y, b.y) - epsilon && point.y <= Math.max(a.y, b.y) + epsilon;
}

function segmentsIntersect(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }, epsilon: number): boolean {
	const abc = orientation(a, b, c);
	const abd = orientation(a, b, d);
	const cda = orientation(c, d, a);
	const cdb = orientation(c, d, b);
	if (((abc > epsilon && abd < -epsilon) || (abc < -epsilon && abd > epsilon))
		&& ((cda > epsilon && cdb < -epsilon) || (cda < -epsilon && cdb > epsilon))) {
		return true;
	}
	return (Math.abs(abc) <= epsilon && pointOnSegment(c, a, b, epsilon))
		|| (Math.abs(abd) <= epsilon && pointOnSegment(d, a, b, epsilon))
		|| (Math.abs(cda) <= epsilon && pointOnSegment(a, c, d, epsilon))
		|| (Math.abs(cdb) <= epsilon && pointOnSegment(b, c, d, epsilon));
}

function validateClosedSimplePolygon(points: { x: number; y: number }[]): string | undefined {
	if (!Array.isArray(points) || points.length < 4)
		return '多边形至少需要 3 个不同顶点并显式闭合';
	if (!points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y)))
		return '坐标必须是有限数值';
	const first = points[0];
	const last = points.at(-1)!;
	if (first.x !== last.x || first.y !== last.y)
		return '多边形必须以首点重复闭合';
	const vertices = points.slice(0, -1);
	if (vertices.some((point, index) => point.x === vertices[(index + 1) % vertices.length].x && point.y === vertices[(index + 1) % vertices.length].y))
		return '多边形不得包含重复的相邻顶点';
	const span = Math.max(1, ...vertices.map(point => Math.abs(point.x)), ...vertices.map(point => Math.abs(point.y)));
	const epsilon = Number.EPSILON * span * span * 64;
	let twiceArea = 0;
	for (let index = 0; index < vertices.length; index++) {
		const current = vertices[index];
		const next = vertices[(index + 1) % vertices.length];
		twiceArea += current.x * next.y - next.x * current.y;
	}
	if (Math.abs(twiceArea) <= epsilon)
		return '多边形面积为零或过小';
	for (let firstIndex = 0; firstIndex < vertices.length; firstIndex++) {
		const firstEnd = (firstIndex + 1) % vertices.length;
		for (let secondIndex = firstIndex + 1; secondIndex < vertices.length; secondIndex++) {
			const secondEnd = (secondIndex + 1) % vertices.length;
			if (firstIndex === secondIndex || firstEnd === secondIndex || secondEnd === firstIndex)
				continue;
			if (segmentsIntersect(vertices[firstIndex], vertices[firstEnd], vertices[secondIndex], vertices[secondEnd], epsilon))
				return '多边形存在自交或非相邻边接触';
		}
	}
	return undefined;
}

/**
 * Repairs only single-quoted class members that exactly match a net declared
 * in the same DSN network scope. Unknown or ambiguous syntax is left intact
 * and reported; this does not synthesize routing rules, planes, or keepouts.
 */
export function repairDsnClassNetReferences(source: string): DsnRepairResult {
	const changes: DsnRepairChange[] = [];
	const warnings: string[] = [];
	const limitations = [
		'仅修复与 network 中实际 net 名精确匹配的单引号 class 成员；不推断未知名字。',
		'本引号修补阶段不添加或修复电源平面、槽孔/keepout 区域、网络类线宽、间距或其他布线规则。',
		'此文本处理未证明 FreeRouting 实机导入、自动布线或 SES 回灌成功。',
	];
	const unchanged = (messages: string[]): DsnRepairResult => ({ originalText: source, text: source, changed: false, changes: [], warnings: messages, limitations });
	let roots: Node[];
	try {
		roots = tokenize(source);
	}
	catch (error) {
		return unchanged([`DSN 解析失败，未修改文件：${error instanceof Error ? error.message : String(error)}`]);
	}
	const pcbLists = roots.filter((node): node is List => node.type === 'list' && head(node) === 'pcb');
	if (pcbLists.length !== 1)
		return unchanged([`预期一个顶层 PCB 节点，实际 ${pcbLists.length} 个；未修改 DSN`]);
	const parserLists = walkLists(pcbLists[0].items, 'parser');
	if (parserLists.length !== 1)
		return unchanged([`预期一个 parser 节点，实际 ${parserLists.length} 个；未修改 DSN`]);
	const parser = parserLists[0];
	const quoteSettings = parser.items.slice(1).filter((item): item is List => item.type === 'list' && head(item) === 'string_quote');
	const spaceSettings = parser.items.slice(1).filter((item): item is List => item.type === 'list' && head(item) === 'space_in_quoted_tokens');
	if (quoteSettings.length > 1)
		return unchanged(['parser 中存在多个 string_quote 声明，未修改 DSN']);
	if (spaceSettings.length > 1)
		return unchanged(['parser 中存在多个 space_in_quoted_tokens 声明，未修改 DSN']);
	if (quoteSettings.length === 1) {
		const quoteValue = quoteSettings[0].items[1];
		if (!isAtom(quoteValue) || quoteValue.value !== '"')
			return unchanged(['parser 已指定非双引号 string_quote，未修改 DSN']);
	}
	if (spaceSettings.length === 1) {
		const value = spaceSettings[0].items[1];
		if (!isAtom(value) || value.value.toLowerCase() !== 'on')
			return unchanged(['parser 已关闭或无法识别 space_in_quoted_tokens，未修改 DSN']);
	}
	const networkLists = walkLists(pcbLists[0].items, 'network');
	if (networkLists.length !== 1)
		return unchanged([`预期一个 network 节点，实际 ${networkLists.length} 个；未修改 DSN`]);
	const network = networkLists[0];
	const nets = network.items.filter((item): item is List => item.type === 'list' && head(item) === 'net');
	const netNames: { identity: string; tokenValue: string }[] = [];
	for (const net of nets) {
		const name = net.items[1];
		if (isAtom(name)) {
			// With string_quote set to double quote, apostrophes inside a token
			// are literal identifier characters. Keep that identity separate from
			// the pseudo-quoted value used to recognize the host's malformed refs.
			const identity = name.quote === 'single' ? name.raw : name.value;
			netNames.push({ identity, tokenValue: name.value });
		}
	}
	const edits: { start: number; end: number; text: string }[] = [];
	for (const classList of network.items.filter((item): item is List => item.type === 'list' && head(item) === 'class')) {
		const className = classList.items[1];
		if (isAtom(className) && className.quote === 'single' && className.value === '') {
			warnings.push(`第 ${lineAt(source, className.start)} 行存在空名 class；保持为空，不生成网络名`);
			continue;
		}
		for (const member of classList.items.slice(2)) {
			if (!isAtom(member) || member.quote !== 'single')
				continue;
			if (member.value === '') {
				warnings.push(`第 ${lineAt(source, member.start)} 行存在空网络引用；保持为空`);
				continue;
			}
			const exactMatches = netNames.filter(net => net.identity === member.raw);
			const normalizedMatches = netNames.filter(net => net.tokenValue === member.value);
			const normalizedIdentities = new Set(normalizedMatches.map(net => net.identity));
			const exactIdentities = new Set(exactMatches.map(net => net.identity));
			const hasDifferentNormalizedTarget = [...normalizedIdentities].some(identity => !exactIdentities.has(identity));
			if (exactMatches.length > 0 && hasDifferentNormalizedTarget) {
				warnings.push(`第 ${lineAt(source, member.start)} 行的 class token 同时匹配原始网络名和去引号网络名，存在网络身份歧义；保持原样`);
				continue;
			}
			if (exactMatches.length > 0)
				continue;
			if (normalizedIdentities.size > 1) {
				warnings.push(`第 ${lineAt(source, member.start)} 行的 class token 去引号后匹配多个网络名，存在网络身份歧义；保持原样`);
				continue;
			}
			if (normalizedIdentities.size !== 1) {
				warnings.push(`第 ${lineAt(source, member.start)} 行的单引号 class token 未匹配 network 中的实际 net，保持原样`);
				continue;
			}
			const replacement = encodeDsnString(member.value);
			edits.push({ start: member.start, end: member.end, text: replacement });
			changes.push({ kind: 'class-net-reference', from: member.raw, to: replacement, line: lineAt(source, member.start) });
		}
	}
	if (quoteSettings.length === 0 || spaceSettings.length === 0) {
		const parserHead = parser.items[0];
		if (!isAtom(parserHead))
			return unchanged([...warnings, 'parser 节点结构无法识别，未写入 string_quote']);
		const insertion = parserHead.end;
		const settings = [
			...(quoteSettings.length === 0 ? ['(string_quote ")'] : []),
			...(spaceSettings.length === 0 ? ['(space_in_quoted_tokens on)'] : []),
		];
		const prefix = `\n    ${settings.join('\n    ')}`;
		edits.push({ start: insertion, end: insertion, text: prefix });
		changes.push({ kind: 'parser-quote-settings', from: [quoteSettings.length === 0 ? '(string_quote missing)' : '', spaceSettings.length === 0 ? '(space_in_quoted_tokens missing)' : ''].filter(Boolean).join(', '), to: settings.join(' + '), line: lineAt(source, insertion) });
	}
	edits.sort((a, b) => b.start - a.start || b.end - a.end);
	let text = source;
	for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
	return { originalText: source, text, changed: edits.length > 0, changes, warnings, limitations };
}

/** Adds only caller-supplied, closed simple inner-layer copper polygons. */
export function augmentDsnPlanes(source: string, regions: DsnPlaneRegion[]): DsnRepairResult {
	const changes: DsnRepairChange[] = [];
	const warnings: string[] = [];
	const limitations = [
		'仅写入调用方提供的已归一化实心填充边界；调用方不得传覆铜边框代替填充区域。',
		'仅支持无洞、无弧、非外层、非机械槽孔的简单闭合直线多边形。',
		'不改变已有 layer signal/power 声明，不生成整层网络或网络类规则。',
		'文本生成不证明 FreeRouting 导入/布线成功，也不证明回灌兼容。',
	];
	const unchanged = (messages: string[]): DsnRepairResult => ({ originalText: source, text: source, changed: false, changes: [], warnings: messages, limitations });
	if (!Array.isArray(regions) || regions.length === 0)
		return unchanged(['没有提供 plane 多边形；未修改 DSN']);
	let roots: Node[];
	try {
		roots = tokenize(source);
	}
	catch (error) {
		return unchanged([`DSN 解析失败，未修改文件：${error instanceof Error ? error.message : String(error)}`]);
	}
	const pcbLists = roots.filter((node): node is List => node.type === 'list' && head(node) === 'pcb');
	if (pcbLists.length !== 1)
		return unchanged([`预期一个顶层 PCB 节点，实际 ${pcbLists.length} 个；未修改 DSN`]);
	const pcb = pcbLists[0];
	const childScopes = (scope: List, name: string) => scope.items.slice(1).filter((item): item is List => item.type === 'list' && head(item) === name);
	const parserLists = walkLists(pcb.items, 'parser');
	const structureLists = walkLists(pcb.items, 'structure');
	const networkLists = walkLists(pcb.items, 'network');
	const unitLists = childScopes(pcb, 'unit');
	const resolutionLists = childScopes(pcb, 'resolution');
	if (parserLists.length !== 1 || structureLists.length !== 1 || networkLists.length !== 1 || unitLists.length > 1 || resolutionLists.length !== 1)
		return unchanged(['parser/structure/network/resolution 节点缺失或重复，或 unit 节点重复；未修改 DSN']);
	if ((unitLists.length === 1 && (!isAtom(unitLists[0].items[1]) || unitLists[0].items[1].value.toLowerCase() !== 'mil'))
		|| !isAtom(resolutionLists[0].items[1]) || resolutionLists[0].items[1].value.toLowerCase() !== 'mil'
		|| !isAtom(resolutionLists[0].items[2]) || !Number.isFinite(Number(resolutionLists[0].items[2].value)) || Number(resolutionLists[0].items[2].value) <= 0) {
		return unchanged(['仅支持 resolution mil 为正数且 unit（若提供）为 mil 的 DSN；未修改文件']);
	}
	const parser = parserLists[0];
	const quotes = childScopes(parser, 'string_quote');
	const spaces = childScopes(parser, 'space_in_quoted_tokens');
	if (quotes.length > 1 || spaces.length > 1)
		return unchanged(['parser 的字符串设置重复，未修改 DSN']);
	if (quotes.length === 1 && (!isAtom(quotes[0].items[1]) || quotes[0].items[1].value !== '"'))
		return unchanged(['仅支持双引号 string_quote，未修改 DSN']);
	if (spaces.length === 1 && (!isAtom(spaces[0].items[1]) || spaces[0].items[1].value.toLowerCase() !== 'on'))
		return unchanged(['space_in_quoted_tokens 未开启，未修改 DSN']);
	const quoteStyle = quotes.length === 1 ? quotes[0].items[1] as Atom : '"';
	const netNames = new Set(childScopes(networkLists[0], 'net').flatMap(net => isAtom(net.items[1]) ? [getDsnName(net.items[1], typeof quoteStyle === 'string' ? quoteStyle : quoteStyle.value)] : []));
	const layerLists = childScopes(structureLists[0], 'layer');
	const layerNames = layerLists.flatMap(layer => isAtom(layer.items[1]) ? [getDsnName(layer.items[1], typeof quoteStyle === 'string' ? quoteStyle : quoteStyle.value)] : []);
	if (layerNames.length < 3)
		return unchanged(['未识别到至少三层的叠层，无法确认内层；未修改 DSN']);
	const innerLayers = new Set(layerNames.slice(1, -1));
	const planes = childScopes(structureLists[0], 'plane');
	const existingKeys = new Set<string>();
	for (const plane of planes) {
		const net = plane.items[1];
		const shape = plane.items.find(item => item.type === 'list' && head(item) === 'polygon') as List | undefined;
		if (!isAtom(net) || !shape || !isAtom(shape.items[1]))
			continue;
		const layer = getDsnName(shape.items[1], typeof quoteStyle === 'string' ? quoteStyle : quoteStyle.value);
		const numbers = shape.items.slice(3).flatMap(item => isAtom(item) && Number.isFinite(Number(item.value)) ? [Number(item.value)] : []);
		if (numbers.length < 8 || numbers.length % 2)
			continue;
		const points = Array.from({ length: numbers.length / 2 }, (_, index) => ({ x: numbers[index * 2], y: numbers[index * 2 + 1] }));
		existingKeys.add(`${getDsnName(net, typeof quoteStyle === 'string' ? quoteStyle : quoteStyle.value)}|${layer}|${canonicalPolygonKey(points)}`);
	}
	const newScopes: string[] = [];
	const localKeys = new Set<string>();
	for (const region of regions) {
		if (!region || !region.id || !region.net || !region.layerName)
			return unchanged([`plane 区域缺少 id/net/layerName，未修改 DSN`]);
		if (!netNames.has(region.net))
			return unchanged([`区域 ${region.id} 的网络 ${region.net} 未在 DSN network 定义，未修改 DSN`]);
		if (!innerLayers.has(region.layerName))
			return unchanged([`区域 ${region.id} 的图层 ${region.layerName} 不是已定义的确切内层，未修改 DSN`]);
		const invalidPolygon = validateClosedSimplePolygon(region.pointsMil);
		if (invalidPolygon)
			return unchanged([`区域 ${region.id} 多边形无效：${invalidPolygon}；未修改 DSN`]);
		const polygonKey = `${region.net}|${region.layerName}|${canonicalPolygonKey(region.pointsMil)}`;
		if (existingKeys.has(polygonKey) || localKeys.has(polygonKey)) {
			warnings.push(`区域 ${region.id} 已有相同 net/layer/多边形，跳过重复写入`);
			continue;
		}
		localKeys.add(polygonKey);
		const coords = region.pointsMil.map(point => `${numberKey(point.x)} ${numberKey(point.y)}`).join(' ');
		newScopes.push(`(plane ${encodeDsnString(region.net)} (polygon ${encodeDsnString(region.layerName)} 0 ${coords}))`);
		changes.push({ kind: 'plane', from: '', to: `plane ${region.id}: ${region.net}@${region.layerName}`, line: lineAt(source, structureLists[0].end - 1) });
	}
	const edits: { start: number; end: number; text: string }[] = [];
	if (newScopes.length > 0)
		edits.push({ start: structureLists[0].end - 1, end: structureLists[0].end - 1, text: `\n    ${newScopes.join('\n    ')}\n  ` });
	if (quotes.length === 0 || spaces.length === 0) {
		const parserHead = parser.items[0];
		if (!isAtom(parserHead))
			return unchanged(['parser 结构无法识别，未修改 DSN']);
		const settings = [...(quotes.length === 0 ? ['(string_quote ")'] : []), ...(spaces.length === 0 ? ['(space_in_quoted_tokens on)'] : [])];
		edits.push({ start: parserHead.end, end: parserHead.end, text: `\n    ${settings.join('\n    ')}` });
		changes.push({ kind: 'parser-quote-settings', from: '缺少字符串设置', to: settings.join(' + '), line: lineAt(source, parserHead.end) });
	}
	edits.sort((a, b) => b.start - a.start || b.end - a.end);
	let text = source;
	for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
	return { originalText: source, text, changed: edits.length > 0, changes, warnings, limitations };
}

/** Adds a conservative, per-slot clearance class for verified rectangular DSN slots. */
export function augmentDsnSlotClearances(
	source: string,
	slots: DsnSlotClearanceInput[],
	clearanceMil: number,
	provenance?: string,
): DsnRepairResult {
	const changes: DsnRepairChange[] = [];
	const warnings: string[] = [];
	const diagnostics: DsnSlotClearanceDiagnostics = {
		appliedSlotIds: [],
		skippedSlots: [],
		clearanceMil,
		conservativeDefaultClass: true,
		planeSlotEquivalent: false,
		...(provenance ? { provenance } : {}),
	};
	const limitations = [
		'仅为通过几何/身份核验的简单矩形槽孔 pin 添加专属 clearance class，不是完整槽孔 DSN 语义。',
		'DSN default class 可能同时影响 via/pad 等对象；这是保守收紧，调用方须评估其作用范围。',
		'此 clearance class 不等价于 plane slot、负片槽孔或实际覆铜避让验证。',
		'仅支持 DSN resolution mil、front 面、0 度、无额外变换的扁平 placement 与四铜层矩形 padstack。',
	];
	const unchanged = (reason: string): DsnRepairResult => {
		for (const slot of Array.isArray(slots) ? slots : []) {
			diagnostics.skippedSlots.push({ id: typeof slot?.id === 'string' ? slot.id : '', reason });
		}
		warnings.push(reason);
		return { originalText: source, text: source, changed: false, changes: [], warnings, limitations, slotClearance: diagnostics };
	};
	if (!Array.isArray(slots))
		return unchanged('slots 必须是数组；未修改 DSN');
	if (slots.length === 0) {
		warnings.push('没有提供槽孔；未修改 DSN');
		return { originalText: source, text: source, changed: false, changes, warnings, limitations, slotClearance: diagnostics };
	}
	if (!Number.isFinite(clearanceMil) || clearanceMil <= 0)
		return unchanged('clearanceMil 必须是有限正数；未修改 DSN');
	let roots: Node[];
	try {
		roots = tokenize(source);
	}
	catch (error) {
		return unchanged(`DSN 解析失败，未修改文件：${error instanceof Error ? error.message : String(error)}`);
	}
	const pcbLists = roots.filter((node): node is List => node.type === 'list' && head(node) === 'pcb');
	if (pcbLists.length !== 1)
		return unchanged(`预期一个顶层 PCB 节点，实际 ${pcbLists.length} 个；未修改 DSN`);
	const pcb = pcbLists[0];
	const childScopes = (scope: List, name: string) => scope.items.slice(1).filter((item): item is List => item.type === 'list' && head(item) === name);
	const structures = childScopes(pcb, 'structure');
	const placements = childScopes(pcb, 'placement');
	const libraries = childScopes(pcb, 'library');
	const networks = childScopes(pcb, 'network');
	const resolutions = childScopes(pcb, 'resolution');
	const units = childScopes(pcb, 'unit');
	if (structures.length !== 1 || placements.length !== 1 || libraries.length !== 1 || networks.length !== 1 || resolutions.length !== 1 || units.length > 1)
		return unchanged('structure/placement/library/network/resolution 节点缺失或重复，或 unit 节点重复；未修改 DSN');
	if (!isAtom(resolutions[0].items[1]) || resolutions[0].items[1].value.toLowerCase() !== 'mil'
		|| !isAtom(resolutions[0].items[2]) || !Number.isFinite(Number(resolutions[0].items[2].value)) || Number(resolutions[0].items[2].value) <= 0
		|| (units.length === 1 && (!isAtom(units[0].items[1]) || units[0].items[1].value.toLowerCase() !== 'mil'))) {
		return unchanged('仅支持 resolution mil 为正数且 unit（若提供）为 mil 的 DSN；未修改 DSN');
	}
	const structure = structures[0];
	const placement = placements[0];
	const library = libraries[0];
	const network = networks[0];
	const layers = childScopes(structure, 'layer');
	const copperLayers = layers.flatMap((layer) => {
		const layerName = layer.items[1];
		const types = childScopes(layer, 'type');
		if (!isAtom(layerName) || types.length !== 1 || !isAtom(types[0].items[1]))
			return [];
		return ['signal', 'power'].includes(types[0].items[1].value.toLowerCase()) ? [layerName.value] : [];
	});
	if (copperLayers.length !== 4 || new Set(copperLayers).size !== 4)
		return unchanged(`DSN 必须明确且唯一声明四个铜层，当前识别 ${copperLayers.length} 个；未修改 DSN`);
	const images = childScopes(library, 'image');
	const components = childScopes(placement, 'component');
	const networkPins = childScopes(network, 'net').flatMap(net => childScopes(net, 'pins').flatMap(pins => pins.items.slice(1).filter(item => isAtom(item)).map(pin => pin.value)));
	const classNames = new Set(childScopes(network, 'class').flatMap(entry => isAtom(entry.items[1]) ? [entry.items[1].value.toLowerCase()] : []));
	const globalRuleTypes = new Set(childScopes(structure, 'rule').flatMap(rule => walkLists(rule.items, 'type').flatMap(type => isAtom(type.items[1]) ? [type.items[1].value.toLowerCase()] : [])));
	const existingBindings = new Set<string>();
	for (const component of components) {
		for (const place of childScopes(component, 'place')) {
			for (const pin of childScopes(place, 'pin')) {
				const pinId = pin.items[1];
				for (const binding of childScopes(pin, 'clearance_class')) {
					const value = binding.items[1];
					if (isAtom(value))
						existingBindings.add(value.value.toLowerCase());
				}
				if (isAtom(pinId))
					existingBindings.add(pinId.value.toLowerCase());
			}
		}
	}
	const tolerance = 0.001;
	const approx = (a: number, b: number) => Math.abs(a - b) <= tolerance;
	const isRectangle = (polygon: List, width: number, height: number): boolean => {
		const aperture = polygon.items[2];
		const rawCoordinates = polygon.items.slice(3);
		if (!isAtom(aperture) || !Number.isFinite(Number(aperture.value)) || rawCoordinates.length < 8 || rawCoordinates.length % 2 !== 0
			|| !rawCoordinates.every(item => isAtom(item))) {
			return false;
		}
		const numbers = rawCoordinates.map(value => Number((value as Atom).value));
		if (!numbers.every(Number.isFinite))
			return false;
		const points = Array.from({ length: numbers.length / 2 }, (_, index) => ({ x: numbers[index * 2], y: numbers[index * 2 + 1] }));
		const minX = Math.min(...points.map(point => point.x));
		const maxX = Math.max(...points.map(point => point.x));
		const minY = Math.min(...points.map(point => point.y));
		const maxY = Math.max(...points.map(point => point.y));
		if (!approx(maxX - minX, width) || !approx(maxY - minY, height) || !approx(minX + maxX, 0) || !approx(minY + maxY, 0))
			return false;
		const corners = [{ x: minX, y: minY }, { x: minX, y: maxY }, { x: maxX, y: minY }, { x: maxX, y: maxY }];
		const onCorner = (point: { x: number; y: number }) => corners.some(corner => approx(point.x, corner.x) && approx(point.y, corner.y));
		if (!points.every(onCorner))
			return false;
		const compact: { x: number; y: number }[] = [];
		for (const point of points) {
			if (!compact.length || !approx(compact.at(-1)!.x, point.x) || !approx(compact.at(-1)!.y, point.y))
				compact.push(point);
		}
		if (compact.length > 1 && approx(compact[0].x, compact.at(-1)!.x) && approx(compact[0].y, compact.at(-1)!.y))
			compact.pop();
		if (compact.length !== 4 || new Set(compact.map(point => corners.findIndex(corner => approx(corner.x, point.x) && approx(corner.y, point.y)))).size !== 4)
			return false;
		return compact.every((point, index) => {
			const next = compact[(index + 1) % compact.length];
			return (approx(point.x, next.x) !== approx(point.y, next.y));
		});
	};
	const edits = new Map<number, string[]>();
	const addEdit = (offset: number, text: string) => edits.set(offset, [...(edits.get(offset) ?? []), text]);
	const usedIds = new Set<string>();
	for (const slot of slots) {
		const id = typeof slot?.id === 'string' ? slot.id : '';
		const reject = (reason: string) => {
			diagnostics.skippedSlots.push({ id, reason });
			warnings.push(`槽孔 ${id || '(无 id)'}：${reason}；保持该项 DSN 原样`);
		};
		if (!slot || !id || !/^[a-z0-9]+$/i.test(id)) {
			reject('id 必须是非空字母数字串，避免生成带下划线或不安全的 class 名');
			continue;
		}
		if (usedIds.has(id)) {
			reject('输入中存在重复 id');
			continue;
		}
		usedIds.add(id);
		if (![slot.x, slot.y, slot.width, slot.height].every(Number.isFinite) || slot.width <= 0 || slot.height <= 0) {
			reject('x/y/width/height 必须有限且宽高为正数');
			continue;
		}
		const className = `aceslot${id}`;
		const defaultType = `default_${className}`;
		const matchingPins = images.flatMap((image) => {
			const imageName = image.items[1];
			if (!isAtom(imageName))
				return [];
			return childScopes(image, 'pin').flatMap(pin => isAtom(pin.items[2]) && pin.items[2].value === id ? [{ image, imageName: imageName.value, pin }] : []);
		});
		if (matchingPins.length !== 1) {
			reject(`DSN image 中必须有且仅有一个同名 pin，实际 ${matchingPins.length} 个`);
			continue;
		}
		const { imageName, pin } = matchingPins[0];
		if (pin.items.length !== 5) {
			reject('DSN image pin 只支持 padstack、id、x、y 五项；额外变换或未知字段保持原样');
			continue;
		}
		const padstackToken = pin.items[1];
		const pinNameToken = pin.items[2];
		const pinX = pin.items[3];
		const pinY = pin.items[4];
		if (!isAtom(padstackToken) || !isAtom(pinNameToken) || !isAtom(pinX) || !isAtom(pinY)
			|| !Number.isFinite(Number(pinX.value)) || !Number.isFinite(Number(pinY.value))) {
			reject('DSN image pin 缺少可读的独立 padstack 或坐标');
			continue;
		}
		const instancePlacements = components.flatMap((component) => {
			const componentName = component.items[1];
			if (!isAtom(componentName) || componentName.value !== imageName)
				return [];
			return childScopes(component, 'place').filter(place => isAtom(place.items[1]) && place.items[1].value === imageName).map(place => ({ component, place }));
		});
		if (instancePlacements.length !== 1) {
			reject(`DSN placement 中必须有且仅有一个 ${imageName} 实例`);
			continue;
		}
		const { place } = instancePlacements[0];
		const placeX = place.items[2];
		const placeY = place.items[3];
		const side = place.items[4];
		const rotation = place.items[5];
		if (!isAtom(placeX) || !isAtom(placeY) || !Number.isFinite(Number(placeX.value)) || !Number.isFinite(Number(placeY.value))
			|| !isAtom(side) || side.value.toLowerCase() !== 'front' || !isAtom(rotation) || !approx(Number(rotation.value), 0)
			|| place.items.slice(6).some(item => item.type !== 'list' || head(item) !== 'pin')) {
			reject('只支持无额外变换的扁平 front/0° placement');
			continue;
		}
		const expectedX = slot.x + slot.width / 2;
		const expectedY = slot.y - slot.height / 2;
		if (!approx(Number(pinX.value) + Number(placeX.value), expectedX) || !approx(Number(pinY.value) + Number(placeY.value), expectedY)) {
			reject('DSN image pin 中心与 native R 左上角及宽高换算结果不符');
			continue;
		}
		const existingSlotPin = childScopes(place, 'pin').filter(pinEntry => isAtom(pinEntry.items[1]) && pinEntry.items[1].value === id);
		if (existingSlotPin.length > 0) {
			reject('该 placement pin 已有绑定，保持既有绑定');
			continue;
		}
		if (classNames.has(className.toLowerCase()) || globalRuleTypes.has(defaultType.toLowerCase())) {
			reject('生成的 clearance class 与已有 class 或全局规则冲突');
			continue;
		}
		if (existingBindings.has(className.toLowerCase())) {
			reject('生成的 clearance class 已由其他 placement pin 绑定');
			continue;
		}
		const netPinName = `${imageName}-${pinNameToken.value}`;
		if (networkPins.includes(netPinName)) {
			reject('该 pin 已列入 DSN network，不能按无网络槽孔处理');
			continue;
		}
		const sharedPadstackPins = images.flatMap(image => childScopes(image, 'pin').filter(candidate => isAtom(candidate.items[1]) && candidate.items[1].value === padstackToken.value));
		if (sharedPadstackPins.length !== 1 || sharedPadstackPins[0] !== pin) {
			reject('槽孔 padstack 被其他 DSN image pin 共享');
			continue;
		}
		const padstacks = childScopes(library, 'padstack').filter(padstack => isAtom(padstack.items[1]) && padstack.items[1].value === padstackToken.value);
		if (padstacks.length !== 1) {
			reject(`独立 padstack ${padstackToken.value} 缺失或重复`);
			continue;
		}
		const shapes = childScopes(padstacks[0], 'shape');
		const shapeLayers: string[] = [];
		let unsupportedShape = false;
		for (const shape of shapes) {
			const polygon = childScopes(shape, 'polygon');
			const layer = polygon[0]?.items[1];
			if (polygon.length !== 1 || shape.items.length !== 2 || !isAtom(layer) || !isRectangle(polygon[0], slot.width, slot.height)) {
				unsupportedShape = true;
				break;
			}
			shapeLayers.push(layer.value);
		}
		if (unsupportedShape || shapes.length !== 4 || new Set(shapeLayers).size !== 4 || copperLayers.some(layerName => !shapeLayers.includes(layerName)) || shapeLayers.some(layerName => !copperLayers.includes(layerName))) {
			reject('padstack 必须只在四个实际铜层定义尺寸/中心吻合的简单矩形 polygon');
			continue;
		}
		const bindingOffset = place.end - 1;
		const bindingPrefix = /\s$/.test(source.slice(0, bindingOffset)) ? '' : ' ';
		addEdit(bindingOffset, `${bindingPrefix}(pin ${id} (clearance_class ${className}))`);
		const ruleScopes = childScopes(structure, 'rule');
		const layerScope = layers[0];
		const ruleOffset = ruleScopes.length > 0 ? ruleScopes.at(-1)!.end : layerScope?.start ?? structure.end - 1;
		addEdit(ruleOffset, `\n    (rule (clearance ${numberKey(clearanceMil)} (type ${defaultType})))`);
		diagnostics.appliedSlotIds.push(id);
		changes.push({ kind: 'slot-clearance', from: '', to: `${id}: ${className}, clearance=${numberKey(clearanceMil)}mil`, line: lineAt(source, bindingOffset) });
	}
	const descendingEdits = [...edits.entries()].sort((a, b) => b[0] - a[0]);
	let text = source;
	for (const [offset, insertions] of descendingEdits) {
		const insertion = insertions.join('');
		text = text.slice(0, offset) + insertion + text.slice(offset);
	}
	const changed = diagnostics.appliedSlotIds.length > 0;
	return { originalText: source, text, changed, changes, warnings, limitations, slotClearance: diagnostics };
}
