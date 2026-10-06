import { readFileSync } from 'node:fs'
import { runStructuralAudit } from '../src/commands/schematicAuditEngine'

function unwrap(o: any): any {
	return o && typeof o === 'object' && 'data' in o ? o.data : o
}

function load(path: string) {
	const b = JSON.parse(readFileSync(path, 'utf-8'))
	const wires = (unwrap(b.wires) ?? []).map((w: any) => ({
		primitiveId: String(w.primitiveId ?? '?'),
		net: String(w.net ?? ''),
		line: (w.line ?? []).map(Number),
	}))
	const labels = (unwrap(b.labels) ?? []).map((l: any) => ({
		primitiveId: String(l.primitiveId ?? '?'),
		net: String(l.net ?? ''),
		x: l.x != null ? Number(l.x) : undefined,
		y: l.y != null ? Number(l.y) : undefined,
		attached: l.attached !== false,
		wireId: l.wireId != null ? String(l.wireId) : undefined,
	}))
	const comps = (unwrap(b.comps) ?? []).map((c: any) => ({
		primitiveId: String(c.primitiveId ?? '?'),
		designator: c.designator != null ? String(c.designator) : undefined,
		x: c.x != null ? Number(c.x) : undefined,
		y: c.y != null ? Number(c.y) : undefined,
	}))
	const compPins: Array<{ primitiveId: string, designator?: string, pins: Array<any> }> = []
	const compIdByDev = new Map<string, string>()
	for (const c of comps)
		if (c.designator && !compIdByDev.has(c.designator))
			compIdByDev.set(c.designator, c.primitiveId)
	for (const [dev, pins] of Object.entries<any[]>(b.pins ?? {})) {
		compPins.push({
			primitiveId: compIdByDev.get(dev) ?? dev,
			designator: dev,
			pins: pins.map(p => ({
				pinNumber: p.pinNumber != null ? String(p.pinNumber) : undefined,
				pinName: p.pinName != null ? String(p.pinName) : undefined,
				x: Number(p.x), y: Number(p.y),
			})),
		})
	}
	const rects = (unwrap(b.rects) ?? []).map((r: any) => {
		const sp = r.span ?? { x1: Number(r.x), y1: Number(r.y) - Number(r.height), x2: Number(r.x) + Number(r.width), y2: Number(r.y) }
		return { id: String(r.primitiveId ?? r.id ?? '?'), span: { x1: Number(sp.x1), y1: Number(sp.y1), x2: Number(sp.x2), y2: Number(sp.y2) } }
	})
	return { wires, labels, comps, compPins, rects, ncExempt: new Set<string>(), deviceMargin: 10 }
}

for (const path of process.argv.slice(2)) {
	const input = load(path)
	const { issues, stats } = runStructuralAudit(input)
	const summary: Record<string, number> = {}
	for (const it of issues) {
		const key = `${it.rule}[${it.type}]`
		summary[key] = (summary[key] ?? 0) + 1
	}
	const blocking = issues.filter(i => i.type === 'blocking').length
	console.log(JSON.stringify({ file: path, blockingCount: blocking, summary, stats }, null, 1))
}
