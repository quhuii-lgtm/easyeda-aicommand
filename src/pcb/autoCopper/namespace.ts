/** Local namespace for statically extracted upstream geometry code. */
const autoCopperNamespace: Record<string, any> = { diagnostics: [], sdk: undefined, host: undefined };
autoCopperNamespace.AutoCopperPour = autoCopperNamespace;
autoCopperNamespace.logger = {
	warn: (...args: unknown[]) => autoCopperNamespace.diagnostics.push({ level: 'warning', args }),
	error: (...args: unknown[]) => autoCopperNamespace.diagnostics.push({ level: 'error', args }),
	reportDiagnostic: (...args: unknown[]) => autoCopperNamespace.diagnostics.push({ level: 'diagnostic', args }),
};
autoCopperNamespace.i18n = {
	text: (message: string, ...values: unknown[]) => values.reduce(
		(text: string, value, index) => text.replace(`$` + `{${index + 1}}`, String(value)),
		message,
	),
};
autoCopperNamespace.sdkProxy = new Proxy({}, {
	get: (_target, serviceName: string) => {
		const service = autoCopperNamespace.sdk?.[serviceName];
		if (!service || typeof service !== 'object')
			return service;
		return new Proxy(service, {
			get: (target, memberName: string) => {
				const member = target[memberName];
				if (typeof member !== 'function')
					return member;
				return (...args: unknown[]) => autoCopperNamespace.host.read(
					`upstream ${String(serviceName)}.${String(memberName)}`,
					async () => {
						const result = await member.apply(target, args);
						if (String(memberName).startsWith('getAll') && !Array.isArray(result))
							throw new Error(`${String(serviceName)}.${String(memberName)} 未返回完整数组`);
						return result;
					},
				);
			},
		});
	},
});

export default autoCopperNamespace;
