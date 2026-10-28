// Keep production deadlines unchanged while exercising readback convergence and late SDK results.
export function installVirtualClock() {
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
	const immediate = globalThis.setImmediate
	let now = 0, nextId = 0, steps = 0, scheduled = false, active = true
	const timers = new Map()
	const pump = () => {
		if (scheduled || !active) return
		scheduled = true
		immediate(() => {
			scheduled = false
			if (!active || !timers.size) return
			if (++steps > 1_000_000) throw new Error('Virtual clock driver did not settle')
			const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]
			timers.delete(id)
			now = timer.due
			timer.callback(...timer.args)
			pump()
		})
	}
	globalThis.setTimeout = (callback, delay = 0, ...args) => {
		const id = ++nextId
		timers.set(id, { due: now + Math.max(0, Number(delay)), callback, args })
		pump()
		return id
	}
	globalThis.clearTimeout = id => timers.delete(id)
	Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
	return {
		get now() { return now },
		restore() {
			active = false
			timers.clear()
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
			if (originalNow) Object.defineProperty(performance, 'now', originalNow)
			else delete performance.now
		},
	}
}
