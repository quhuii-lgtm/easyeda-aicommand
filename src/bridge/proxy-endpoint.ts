/** The port is published only after a compatible local proxy health response. */
let proxyPort: number | null = null

export function setProxyPort(port: number | null): void {
	proxyPort = port
}

export function getProxyPort(): number | null {
	return proxyPort
}

export function getProxyUrl(path: string): string | null {
	return proxyPort === null ? null : `http://127.0.0.1:${proxyPort}${path}`
}
