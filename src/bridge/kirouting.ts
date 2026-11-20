import { getProxyUrl } from './client'

export type KiRoutingAction = 'info' | 'install' | 'start' | 'status' | 'stop' | 'result' | 'list'

export interface KiRoutingResponse<T = any> {
	ok: boolean
	data?: T
	error?: { code?: string, message: string, details?: unknown, partial?: boolean, outcome?: 'unknown' | 'rejected' }
}

const mayCreateJob = (action: KiRoutingAction): boolean => action === 'start' || action === 'install'

/** KiRouting reuses the running command proxy; it does not open a second local port. */
export async function kiRoutingRequest<T = any>(action: KiRoutingAction, params: Record<string, unknown> = {}): Promise<KiRoutingResponse<T>> {
	const url = getProxyUrl('/kirouting')
	if (!url) return { ok: false, error: { code: 'proxy-unavailable', message: '本地命令代理尚未连接；请先启动配套代理' } }
	let response: any
	try {
		response = await eda.sys_ClientUrl.request(url, 'POST', JSON.stringify({ action, params }), { headers: { 'Content-Type': 'application/json' } })
	}
	catch (error) {
		const uncertain = mayCreateJob(action)
		return { ok: false, error: { code: 'transport-error', partial: uncertain, outcome: uncertain ? 'unknown' : 'rejected', details: uncertain ? { operationId: params.operationId } : undefined, message: `KiRouting 本地代理请求发生传输错误；${uncertain ? '服务端是否已接收或创建任务未知，请用原 operationId 查询状态' : '请求未取得有效响应'}：${String((error as any)?.message ?? error)}` } }
	}
	if (!response || typeof response.json !== 'function') {
		const uncertain = mayCreateJob(action)
		return { ok: false, error: { code: 'invalid-response', partial: uncertain, outcome: uncertain ? 'unknown' : 'rejected', details: uncertain ? { operationId: params.operationId } : undefined, message: `KiRouting 代理没有返回可解析的 HTTP 响应${uncertain ? '；任务是否已创建未知，请用原 operationId 查询状态' : ''}` } }
	}
	let body: any
	try { body = await response.json() }
	catch (error) {
		const uncertain = mayCreateJob(action)
		return { ok: false, error: { code: 'invalid-json', partial: uncertain, outcome: uncertain ? 'unknown' : 'rejected', details: uncertain ? { operationId: params.operationId } : undefined, message: `KiRouting 代理响应不是有效 JSON${uncertain ? '；任务是否已创建未知，请用原 operationId 查询状态' : ''}：${String((error as any)?.message ?? error)}` } }
	}
	if (!response.ok) return { ok: false, error: body?.error ?? { code: `http-${response.status}`, partial: mayCreateJob(action), outcome: mayCreateJob(action) ? 'unknown' : 'rejected', details: body, message: `KiRouting 代理请求失败（HTTP ${response.status}）${mayCreateJob(action) ? '；任务是否已创建未知' : ''}` } }
	if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
		const uncertain = mayCreateJob(action)
		return { ok: false, error: { code: 'invalid-envelope', partial: uncertain, outcome: uncertain ? 'unknown' : 'rejected', details: uncertain ? { operationId: params.operationId } : undefined, message: `KiRouting 代理响应缺少 ok 字段${uncertain ? '；任务是否已创建未知，请用原 operationId 查询状态' : ''}` } }
	}
	return body as KiRoutingResponse<T>
}
