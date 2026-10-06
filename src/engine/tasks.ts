/**
 * 任务登记处（0.10.42，GPT KIMI-EDA-20261002-03）：
 * 长指令（批量删除等）客户端超时后，扩展侧仍在执行——调用方此前只能盲等或盲重发。
 * 这里给每个长任务建档案：进行中可查实时进度，完成后结果保留 15 分钟可供补取；
 * 相同参数的任务仍在跑时，重复调用直接返回现有任务进度，不重复执行（防盲重发）。
 */

export interface ITaskRec {
	id: string
	cmd: string
	fingerprint: string
	state: 'running' | 'done' | 'error'
	startedAt: number
	updatedAt: number
	/** 实时进度（deleted/failed/batches/stage 等，由各指令自行维护） */
	progress: Record<string, any>
	/** 完成后的最终结果（done 时才有） */
	result?: any
	error?: string
	/**
	 * 0.10.49（KIMI-EDA-20261002-07 R2）：进度心跳回调。
	 * taskProgress/finishTask/failTask 每次更新后调用——桥层把它转成
	 * { type:'progress', id } 消息发给代理，代理据此重置该指令的 30s 超时计时器，
	 * 批量指令不会因总时长超时被误杀（超时速率语义变为「30s 无心跳」）。
	 */
	onUpdate?: (task: ITaskRec) => void
}

const tasks = new Map<string, ITaskRec>()
let seq = 0
const TTL_MS = 15 * 60 * 1000 // 完成/失败结果保留 15 分钟供补取

function cleanup(): void {
	const now = Date.now()
	for (const [id, t] of tasks) {
		if (t.state !== 'running' && now - t.updatedAt > TTL_MS)
			tasks.delete(id)
	}
}

function fingerprintOf(params: any): string {
	const norm = (v: any): any => {
		if (Array.isArray(v))
			return v.map(norm).sort()
		if (v && typeof v === 'object') {
			const o: Record<string, any> = {}
			for (const k of Object.keys(v).sort())
				o[k] = norm(v[k])
			return o
		}
		return v
	}
	try {
		return JSON.stringify(norm(params))
	}
	catch {
		return String(params)
	}
}

/** 开始（或发现已在跑的）任务。existing=true 时调用方应直接返回现有任务进度，不要重复执行 */
export function beginTask(cmd: string, params: any, onUpdate?: (task: ITaskRec) => void): { task: ITaskRec, existing: boolean } {
	cleanup()
	const fp = `${cmd}|${fingerprintOf(params)}`
	for (const t of tasks.values()) {
		if (t.fingerprint === fp && t.state === 'running')
			return { task: t, existing: true }
	}
	const task: ITaskRec = {
		id: `task-${Date.now().toString(36)}-${++seq}`,
		cmd,
		fingerprint: fp,
		state: 'running',
		startedAt: Date.now(),
		updatedAt: Date.now(),
		progress: {},
		onUpdate,
	}
	tasks.set(task.id, task)
	return { task, existing: false }
}

/** 通知心跳回调（0.10.49）：回调异常不得影响任务本身 */
function notify(task: ITaskRec): void {
	try {
		task.onUpdate?.(task)
	}
	catch {
		// 心跳发送失败静默忽略——进度通道是尽力而为的辅助设施
	}
}

export function taskProgress(task: ITaskRec, patch: Record<string, any>): void {
	Object.assign(task.progress, patch)
	task.updatedAt = Date.now()
	notify(task)
}

export function finishTask(task: ITaskRec, result: any): void {
	task.state = 'done'
	task.result = result
	task.updatedAt = Date.now()
	notify(task)
}

export function failTask(task: ITaskRec, err: any): void {
	task.state = 'error'
	task.error = err instanceof Error ? err.message : String(err)
	task.updatedAt = Date.now()
	notify(task)
}

export function getTask(id: string): ITaskRec | undefined {
	cleanup()
	return tasks.get(id)
}

export function listTasks(): Array<Omit<ITaskRec, 'result' | 'progress'>> {
	cleanup()
	return [...tasks.values()]
		.sort((a, b) => b.startedAt - a.startedAt)
		.map(({ result: _r, progress: _p, ...rest }) => rest)
}
