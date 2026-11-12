function childPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function invalid(path: string, reason: string): never {
	throw new TypeError(`无法克隆纯 JSON 数据 ${path}：${reason}`);
}

function arrayIndex(key: string): number | undefined {
	if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < 0xffff_ffff ? index : undefined;
}

/** Clone JSON-shaped values without relying on the host's structuredClone implementation. */
export function cloneJsonData<T>(input: T): T {
	const ancestors = new WeakSet<object>();

	const clone = (value: unknown, path: string): unknown => {
		if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) invalid(path, 'number 必须有限');
			return value; // Returning the primitive directly preserves -0.
		}
		if (typeof value !== 'object') invalid(path, `不支持 ${typeof value}`);
		if (ancestors.has(value)) invalid(path, '检测到循环引用');

		const prototype = Object.getPrototypeOf(value);
		const isArray = Array.isArray(value);
		if (isArray) {
			if (prototype !== Array.prototype) invalid(path, '不支持 Array 子类或特殊数组对象');
		} else if (prototype !== Object.prototype && prototype !== null) {
			invalid(path, '只接受普通对象');
		}

		for (const symbol of Object.getOwnPropertySymbols(value)) {
			if (Object.prototype.propertyIsEnumerable.call(value, symbol))
				invalid(`${path}[${String(symbol)}]`, '不支持 symbol 属性');
		}

		ancestors.add(value);
		try {
			if (isArray) {
				const source = value as unknown[];
				const result: unknown[] = new Array(source.length);
				const keys = Object.keys(source);
				for (const key of keys) {
					const index = arrayIndex(key);
					if (index === undefined || index >= source.length)
						invalid(childPath(path, key), '数组不能包含额外的可枚举属性');
				}
				for (let index = 0; index < source.length; index++) {
					if (!Object.prototype.hasOwnProperty.call(source, index)) invalid(`${path}[${index}]`, '不支持稀疏数组');
					const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
					if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid(`${path}[${index}]`, '不支持 accessor 属性');
					result[index] = clone(descriptor.value, `${path}[${index}]`);
				}
				return result;
			}

			const result: Record<string, unknown> = Object.create(prototype) as Record<string, unknown>;
			for (const key of Object.keys(value)) {
				const propertyPath = childPath(path, key);
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid(propertyPath, '不支持 accessor 属性');
				Object.defineProperty(result, key, {
					value: clone(descriptor.value, propertyPath),
					writable: true,
					enumerable: true,
					configurable: true,
				});
			}
			return result;
		} finally {
			ancestors.delete(value);
		}
	};

	return clone(input, '$') as T;
}
