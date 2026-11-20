const FR_API_BASE = 'http://127.0.0.1:37864/v1';

/** FreeRouting REST 请求（走 eda.sys_ClientUrl 绕开扩展网络限制，与官方集成扩展同款） */
export async function frRequest<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {
		'Freerouting-Environment-Host': 'EasyEDA/3.2',
		'Freerouting-Profile-ID': '4c11cc11-75b4-4eaa-96b8-95a71d3611ef',
	};
	if (body)
		headers['Content-Type'] = 'application/json';
	const res = await eda.sys_ClientUrl.request(
		`${FR_API_BASE}${path}`,
		method,
		body ? JSON.stringify(body) : undefined,
		{ headers },
	);
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`FreeRouting API ${method} ${path} 失败（${res.status}）：${text}`);
	}
	if (res.status === 204)
		return undefined as T;
	return res.json() as Promise<T>;
}

const FREEROUTING_SETTING_PATHS = [
	'autorouter.max_passes',
	'scoring.via_costs',
	'optimizer.max_threads',
	'optimizer.improvement_threshold',
	'trace_pull_tight_accuracy',
	'scoring.start_ripup_costs',
	'automatic_neckdown',
	'allowed_via_types',
] as const;

function readSettingPath(settings: Record<string, unknown>, path: string): unknown {
	let value: unknown = settings;
	for (const part of path.split('.')) {
		if (!value || typeof value !== 'object')
			return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

/** Apply RouterSettings in the v2.5.0 DTO shape and verify every submitted field against effective settings. */
export async function frSetAndVerifyJobSettings(jobId: string, settings?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
	if (!settings)
		return undefined;
	const jobPath = `/jobs/${encodeURIComponent(jobId)}`;
	try {
		await frRequest('POST', `${jobPath}/settings`, settings);
	}
	catch (error) {
		throw new Error(`FreeRouting settings POST 失败：${String((error as any)?.message ?? error)}`);
	}
	let effective: Record<string, unknown>;
	try {
		effective = await frRequest<Record<string, unknown>>('GET', `${jobPath}/settings`);
	}
	catch (error) {
		throw new Error(`FreeRouting effective settings 读回失败：${String((error as any)?.message ?? error)}`);
	}
	const mismatches = FREEROUTING_SETTING_PATHS.flatMap((path) => {
		const requested = readSettingPath(settings, path);
		if (requested === undefined)
			return [];
		const actual = readSettingPath(effective, path);
		return Object.is(actual, requested) ? [] : [`${path}: requested=${String(requested)}, effective=${String(actual)}`];
	});
	if (mismatches.length)
		throw new Error(`FreeRouting effective settings 与请求不一致：${mismatches.join('; ')}`);
	return effective;
}
