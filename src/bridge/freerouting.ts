const FR_API_BASE = 'http://127.0.0.1:37864/v1'

/** FreeRouting REST 请求（走 eda.sys_ClientUrl 绕开扩展网络限制，与官方集成扩展同款） */
export async function frRequest<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {
		'Freerouting-Environment-Host': 'EasyEDA/3.2',
		'Freerouting-Profile-ID': '4c11cc11-75b4-4eaa-96b8-95a71d3611ef',
	}
	if (body)
		headers['Content-Type'] = 'application/json'
	const res = await eda.sys_ClientUrl.request(
		`${FR_API_BASE}${path}`, method, body ? JSON.stringify(body) : undefined, { headers },
	)
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`FreeRouting API ${method} ${path} 失败（${res.status}）：${text}`)
	}
	if (res.status === 204)
		return undefined as T
	return res.json() as Promise<T>
}
