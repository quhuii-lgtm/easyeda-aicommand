/**
 * 指令公共工具
 */

/** 防御性读取图元状态方法（不同图元类型支持的方法不同） */
export function safeState<T>(obj: any, method: string): T | undefined {
	try {
		const fn = obj?.[method]
		if (typeof fn === 'function')
			return fn.call(obj) as T
	}
	catch {
		// 忽略不支持的状态读取
	}
	return undefined
}

/** Blob → base64（分块避免栈溢出） */
export async function blobToBase64(blob: Blob): Promise<string> {
	const buf = new Uint8Array(await blob.arrayBuffer())
	let binary = ''
	const CHUNK = 0x8000
	for (let i = 0; i < buf.length; i += CHUNK)
		binary += String.fromCharCode(...buf.subarray(i, i + CHUNK))
	return btoa(binary)
}

export interface IFileResult {
	fileName: string
	size: number
	mimeType: string
	base64: string
}

/**
 * 把官方导出接口返回的 File/Blob 转成可经 HTTP 传输的结构。
 * data 为 undefined 时返回 null（由调用方报错）。
 */
export async function fileToResult(data: File | Blob | undefined, fallbackName: string): Promise<IFileResult | null> {
	if (!data)
		return null
	const fileName = (data as File).name || fallbackName
	return {
		fileName,
		size: data.size,
		mimeType: data.type || 'application/octet-stream',
		base64: await blobToBase64(data),
	}
}
