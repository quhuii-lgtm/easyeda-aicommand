import JSZip from 'jszip'
import { parseGerberLayerGeometry } from './silkscreenGerber'

export function readTable(base64: string) {
	const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
	const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
	const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
	const header = text.split(/\r?\n/, 1)[0].replace(/"(?:[^"]|"")*"/g, '')
	const delimiter = header.includes('\t') ? '\t' : ','
	const rows: string[][] = []
	let row: string[] = [], field = '', quoted = false, closedQuote = false
	for (let i = 0; i <= text.length; i++) {
		const char = text[i]
		if (quoted) {
			if (char === undefined) throw new Error('表格引号未闭合')
			if (char !== '"') field += char
			else if (text[i + 1] === '"') { field += '"'; i++ }
			else { quoted = false; closedQuote = true }
		}
		else if (char === '"' && !field && !closedQuote) quoted = true
		else if (char === delimiter) { row.push(field); field = ''; closedQuote = false }
		else if (char === undefined || char === '\n' || char === '\r') {
			if (char === '\r' && text[i + 1] === '\n') i++
			if (row.length || field) rows.push([...row, field])
			row = []; field = ''; closedQuote = false
		}
		else if (char === '"' || closedQuote) throw new Error('表格字段格式无效')
		else field += char
	}
	if (!rows.length || rows[0].length < 2 || rows.some(row => row.length !== rows[0].length)) throw new Error('无法确认表格列结构')
	return { rows, encoding, delimiter, format: delimiter === '\t' ? 'tsv' : 'csv' }
}

export async function describePlacementFile(file: { fileName: string; base64: string }) {
	try {
		if (atob(file.base64.slice(0, 8)).startsWith('PK\x03\x04')) {
			const zip = await JSZip.loadAsync(file.base64, { base64: true })
			if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) return { format: 'unknown', note: 'ZIP 缺少 XLSX 工作簿条目' }
			return { format: 'xlsx', nativeFileName: file.fileName, fileName: file.fileName.replace(/\.(csv|tsv|xlsx)$/i, '') + '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
		}
		const { encoding, delimiter, format } = readTable(file.base64)
		return { format, encoding, delimiter, nativeFileName: file.fileName, fileName: file.fileName.replace(/\.(csv|tsv|xlsx)$/i, '') + '.' + format, mimeType: (format === 'tsv' ? 'text/tab-separated-values' : 'text/csv') + '; charset=' + encoding }
	}
	catch { return { format: 'unknown', note: '无法确认文件编码和分隔符' } }
}

type Mode = 'manual' | 'smt' | 'omit'
type PasteRegion = { designator: string; side: 'top' | 'bottom'; minX: number; maxX: number; minY: number; maxY: number }
const encodeTable = (rows: string[][]) => {
	const text = '\uFEFF' + rows.map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join('\t')).join('\r\n') + '\r\n'
	return text
}

export async function preflightAssembly(input: { bomBase64: string; placementBase64: string; assignments: Record<string, Mode>; gerberBase64?: string; pasteRegions?: PasteRegion[] }) {
	const [bomHeader, ...bomRows] = readTable(input.bomBase64).rows
	const [placementHeader, ...placementRows] = readTable(input.placementBase64).rows
	const column = (header: string[], name: string) => {
		const i = header.indexOf(name)
		if (i < 0 || i !== header.lastIndexOf(name)) throw new Error('缺少唯一列 ' + name)
		return i
	}
	const bRef = column(bomHeader, 'Designator'), quantity = column(bomHeader, 'Quantity')
	const pRef = column(placementHeader, 'Designator'), smd = column(placementHeader, 'SMD')
	const bFoot = column(bomHeader, 'Footprint'), pFoot = column(placementHeader, 'Footprint')
	const bom = new Map<string, string[]>(), placements = new Map<string, string[]>()
	for (const row of bomRows) {
		const refs = row[bRef].split(',').map(ref => ref.trim())
		if (refs.length !== Number(row[quantity])) throw new Error('BOM 数量与位号数不符')
		for (const ref of refs) {
			if (!ref || bom.has(ref)) throw new Error('BOM 位号为空或重复 ' + ref)
			bom.set(ref, row)
		}
	}
	for (const row of placementRows) {
		const ref = row[pRef].trim()
		if (!ref || placements.has(ref)) throw new Error('坐标表位号为空或重复 ' + ref)
		placements.set(ref, row)
	}
	if (!input.assignments || typeof input.assignments !== 'object' || Array.isArray(input.assignments)) throw new Error('需要按位号提供装配方式')
	const refs = new Set([...bom.keys(), ...placements.keys()])
	const assignments = new Map(Object.entries(input.assignments))
	for (const [ref, mode] of assignments) {
		if (!refs.has(ref) || !['manual', 'smt', 'omit'].includes(mode)) throw new Error('未知位号或装配方式 ' + ref)
	}
	const unassigned = [...refs].filter(ref => !assignments.has(ref)).sort()
	const eligible = new Set<string>()
	const issues: Array<{ designator: string; reason: string }> = []
	for (const [designator, mode] of assignments) {
		if (mode !== 'smt') continue
		const b = bom.get(designator), p = placements.get(designator)
		if (!b || !p || p[smd].trim().toLowerCase() !== 'yes' || !b[bFoot] || b[bFoot] !== p[pFoot]) {
			issues.push({ designator, reason: '缺少 BOM 或贴片坐标、SMD 标识不符，或封装不一致' })
		}
		else eligible.add(designator)
	}
	const complete = !unassigned.length && !issues.length
	const filteredBom = bomRows.flatMap(row => {
		const selected = row[bRef].split(',').map(ref => ref.trim()).filter(ref => eligible.has(ref))
		if (!selected.length) return []
		const next = [...row]
		next[bRef] = selected.join(',')
		next[quantity] = String(selected.length)
		return [next]
	})
	const paste = input.gerberBase64 ? await inspectPaste(input.gerberBase64, input.pasteRegions ?? [], assignments) : { status: 'not-checked', regions: [] }
	return {
		complete, unassigned, issues, assignments: Object.fromEntries(assignments), smtDesignators: [...eligible].sort(),
		bom: complete ? { designatorCount: eligible.size, tsv: encodeTable([bomHeader, ...filteredBom]) } : null,
		placement: complete ? { designatorCount: eligible.size, tsv: encodeTable([placementHeader, ...placementRows.filter(row => eligible.has(row[pRef].trim()))]) } : null,
		paste,
	}
}

function layerKind(name: string) {
	const ext = name.split('.').at(-1)?.toUpperCase() ?? ''
	if (/^(GTL|GBL|G\d+|GTO|GBO|GTS|GBS|GTP|GBP|GKO)$/.test(ext)) return { role: 'production', layer: ext }
	if (ext === 'DRL') return { role: 'drill', layer: ext }
	if (['GDL', 'GDD', 'GML', 'TXT', 'JSON'].includes(ext)) return { role: 'reference', layer: ext }
	return { role: 'unknown', layer: ext }
}

async function readArchive(base64: string) {
	return JSZip.loadAsync(base64, { base64: true, checkCRC32: true })
}

export async function listManufacturingFiles(base64: string) {
	const zip = await JSZip.loadAsync(base64, { base64: true })
	return Object.values(zip.files).filter(file => !file.dir).map(file => ({ name: file.name, ...layerKind(file.name) }))
}

async function inspectPaste(base64: string, regions: PasteRegion[], assignments: Map<string, Mode>) {
	const zip = await readArchive(base64)
	const names = Object.keys(zip.files).filter(name => !zip.files[name].dir)
	const results = []
	for (const side of ['top', 'bottom'] as const) {
		const selected = regions.filter(region => region.side === side)
		if (!selected.length) continue
		const layer = side === 'top' ? 'GTP' : 'GBP'
		const matches = names.filter(name => layerKind(name).layer === layer)
		const parsed = matches.length === 1 ? parseGerberLayerGeometry(layer, matches[0], await zip.files[matches[0]].async('string')) : null
		for (const region of selected) {
			if (!['manual', 'omit'].includes(assignments.get(region.designator) ?? '') ||
				![region.minX, region.maxX, region.minY, region.maxY].every(Number.isFinite) ||
				region.minX >= region.maxX || region.minY >= region.maxY) throw new Error('无效的手装或不装器件锡膏核对范围')
			const nearby = parsed?.shapes.flatMap(shape => {
				const points = shape.geometryUpper.flat(2)
				if (!points.length) return []
				const x = points.map(point => point[0] * .0254), y = points.map(point => point[1] * .0254)
				const minX = Math.min(...x), maxX = Math.max(...x), minY = Math.min(...y), maxY = Math.max(...y)
				if (maxX < region.minX || minX > region.maxX || maxY < region.minY || minY > region.maxY) return []
				return [{ shape, minX, maxX, minY, maxY, contained: minX >= region.minX && maxX <= region.maxX && minY >= region.minY && maxY <= region.maxY }]
			}) ?? []
			const flashes = nearby.filter(({ shape, contained }) => contained && shape.kind === 'flash' && shape.polarity === 'dark' && shape.flashCenterMil)
			const overlappingFlashBounds = flashes.some((a, i) => flashes.slice(i + 1).some(b =>
				a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY))
			const verified = parsed?.complete === true && nearby.length === flashes.length && !overlappingFlashBounds
			results.push({ designator: region.designator, side, file: matches[0], flashCentersMm: flashes.map(({ shape }) => shape.flashCenterMil!.map(mil => mil * .0254)), openingCount: verified ? flashes.length : null, overlappingFlashBounds, unresolvedObjects: nearby.length - flashes.length, status: verified ? 'checked-region' : 'incomplete' })
		}
	}
	if (results.length !== regions.length) throw new Error('锡膏核对面必须是 top 或 bottom')
	return { status: results.length && results.every(result => result.status === 'checked-region') ? 'checked-regions' : 'incomplete', evidence: '按传入的 Gerber 坐标范围核对完整闪光图形，范围和位号的对应由调用方提供', regions: results }
}

function parseDrill(text: string) {
	const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
	const plating = lines.find(line => /^;TYPE=(PLATED|NON_PLATED)$/.test(line))?.split('=')[1]
	if (!plating || !lines.some(line => /^METRIC,LZ,0+\.0+$/.test(line)) || !lines.includes('G90') || lines.at(-1) !== 'M30')
		throw new Error('需要带镀层声明、绝对坐标及结束标记的公制钻孔程序')
	let tool = ''
	const tools = new Map<string, number>()
	const hits = []
	for (const line of lines) {
		const definition = /^(T\d+)C(\d+(?:\.\d+)?)$/.exec(line)
		const hit = /^X(-?\d+\.\d+)Y(-?\d+\.\d+)$/.exec(line)
		if (definition) {
			const diameter = Number(definition[2])
			if (tools.has(definition[1]) || !Number.isFinite(diameter) || diameter <= 0) throw new Error('钻头定义重复或无效')
			tools.set(definition[1], diameter)
		}
		else if (/^T\d+$/.test(line)) tool = line
		else if (hit && tools.has(tool)) hits.push({ plating, x: Number(hit[1]), y: Number(hit[2]), diameter: tools.get(tool)! })
		else if (!/^(?:;.*|M48|METRIC,LZ,0+\.0+|%|G05|G90|M30)$/.test(line)) throw new Error('未支持的钻孔指令 ' + line)
	}
	return hits
}

export async function inspectManufacturingPackage(base64: string, selectedFiles?: string[], includeSelectedArchive = false) {
	const zip = await readArchive(base64)
	const names = Object.keys(zip.files).filter(name => !zip.files[name].dir)
	if (selectedFiles !== undefined && (!Array.isArray(selectedFiles) || !selectedFiles.length || new Set(selectedFiles).size !== selectedFiles.length || selectedFiles.some(name => !names.includes(name)))) throw new Error('选中文件必须精确匹配 ZIP 内的唯一条目')
	const files = names.map(name => ({ name, ...layerKind(name), selected: selectedFiles === undefined || selectedFiles.includes(name) }))
	const selected = files.filter(file => file.selected)
	const outlines = selected.filter(file => file.layer === 'GKO')
	const parsed = outlines.length === 1 ? parseGerberLayerGeometry('GKO', outlines[0].name, await zip.files[outlines[0].name].async('string')) : null
	const ring = parsed?.complete ? parsed.boardOutline[0] : undefined
	const outline = ring ? {
		status: 'closed', unit: 'mm', basis: 'centerline',
		width: (Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0]))) * .0254,
		height: (Math.max(...ring.map(p => p[1])) - Math.min(...ring.map(p => p[1]))) * .0254,
	} : { status: 'incomplete', reasons: [...(parsed?.unknowns ?? []), ...(parsed?.unsupported ?? []), ...(!parsed ? ['需要唯一 GKO'] : [])] }
	const holes = new Map<string, Set<string>>(), positions = new Set<string>()
	const drillFiles: Array<{ name: string; hits: number | null; error?: string }> = []
	for (const file of selected.filter(file => file.role === 'drill')) {
		try {
			const hits = parseDrill(await zip.files[file.name].async('string'))
			drillFiles.push({ name: file.name, hits: hits.length })
			for (const hit of hits) {
				const key = JSON.stringify([hit.x, hit.y, hit.diameter, hit.plating])
				positions.add(JSON.stringify([hit.x, hit.y]))
				if (!holes.has(key)) holes.set(key, new Set())
				holes.get(key)!.add(file.name)
			}
		}
		catch (error) { drillFiles.push({ name: file.name, hits: null, error: String(error) }) }
	}
	const overlaps = new Map<string, { files: string[]; count: number }>()
	for (const entries of holes.values()) {
		const pair = [...entries].sort()
		for (let i = 0; i < pair.length; i++) for (let j = i + 1; j < pair.length; j++) {
			const files = [pair[i], pair[j]], key = JSON.stringify(files)
			if (!overlaps.has(key)) overlaps.set(key, { files, count: 0 })
			overlaps.get(key)!.count++
		}
	}
	const drillComplete = drillFiles.length > 0 && drillFiles.every(file => file.hits !== null)
	let selectedArchiveBase64: string | undefined
	if (includeSelectedArchive) {
		if (!selectedFiles) throw new Error('生成选中文件 ZIP 时必须显式提供 selectedFiles')
		const selectedZip = new JSZip()
		for (const file of selected) selectedZip.file(file.name, await zip.files[file.name].async('uint8array'))
		selectedArchiveBase64 = await selectedZip.generateAsync({ type: 'base64', compression: 'DEFLATE' })
	}
	return { files, zipCrcChecked: true, outline, drill: {
		status: drillComplete ? 'checked' : 'incomplete', files: drillFiles,
		uniquePositions: drillComplete ? positions.size : null, uniqueHits: drillComplete ? holes.size : null,
		overlaps: [...overlaps.values()], matchBasis: '绝对毫米坐标、孔径及镀层精确一致',
	}, selectedArchiveBase64, scope: '文件清单、板框中心线与圆孔钻孔程序' }
}
