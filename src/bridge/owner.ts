export const BRIDGE_OWNER_QUERY_TOPIC = 'ai-command-engine:owner:query:v1';

type OwnerPhase = 'initializing' | 'ready';
type BridgeOwner = { id: string; rpcTopic: string; phase: OwnerPhase; version: string };
type OwnerRole = 'owner' | 'existing' | 'initializing';

const MODULE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;

function nextId(): string {
	return `${MODULE_ID}-${++sequence}`;
}

export function createBridgeOwnerCoordinator(version: string) {
	let role: OwnerRole | 'inactive' = 'inactive';
	let owner: BridgeOwner | null = null;
	let querySubscription: { cancel: () => void } | null = null;

	function discoverOwners(): BridgeOwner[] {
		const replyTopic = `ai-command-engine:owner:reply:${nextId()}`;
		const found = new Map<string, BridgeOwner>();
		let incompatibleVersion: string | null = null;
		let invalidReply = false;
		const replySubscription = eda.sys_MessageBus.subscribe(replyTopic, (message: any) => {
			if (typeof message?.id !== 'string' || !message.id.trim()
				|| typeof message?.rpcTopic !== 'string' || !message.rpcTopic.trim()) {
				invalidReply = true;
				return;
			}
			if (typeof message.version !== 'string' || message.version !== version) {
				incompatibleVersion = typeof message.version === 'string' && message.version ? message.version : 'unknown';
				return;
			}
			if (message.phase !== 'initializing' && message.phase !== 'ready') {
				invalidReply = true;
				return;
			}
			found.set(message.id, { id: message.id, rpcTopic: message.rpcTopic, phase: message.phase, version: message.version });
		});
		try {
			eda.sys_MessageBus.publish(BRIDGE_OWNER_QUERY_TOPIC, { replyTopic });
		}
		finally {
				replySubscription.cancel();
		}
		if (invalidReply)
			throw new Error('收到无效的 AI Command Engine 所有者回复');
		if (incompatibleVersion)
			throw new Error(`发现不兼容的 AI Command Engine 所有者版本：${incompatibleVersion}`);
		return [...found.values()];
	}

	function activate(handler: (request: any) => any): OwnerRole {
		if (role !== 'inactive')
			return role;
		role = 'initializing';
		try {
			const owners = discoverOwners();
			if (owners.length > 1)
				throw new Error(`发现 ${owners.length} 个 AI Command Engine 所有者，拒绝重复启动`);
			if (owners.length === 1) {
				owner = owners[0];
				role = owner.phase === 'ready' ? 'existing' : 'initializing';
				return role;
			}

			const ownRecord: BridgeOwner = {
				id: nextId(),
				rpcTopic: `ai-command-engine:owner:rpc:${nextId()}`,
				phase: 'initializing',
				version,
			};
			owner = ownRecord;
			querySubscription = eda.sys_MessageBus.subscribe(BRIDGE_OWNER_QUERY_TOPIC, (message: any) => {
				if (typeof message?.replyTopic === 'string') {
					eda.sys_MessageBus.publish(message.replyTopic, {
						id: ownRecord.id,
						rpcTopic: ownRecord.rpcTopic,
						phase: ownRecord.phase,
						version: ownRecord.version,
					});
				}
			});
			try {
				eda.sys_MessageBus.rpcService(ownRecord.rpcTopic, (request: any) => {
					if (ownRecord.phase !== 'ready')
						return { ok: false, error: 'owner-initializing' };
					return handler(request);
				});
			}
			catch (err) {
				querySubscription.cancel();
				querySubscription = null;
				owner = null;
				role = 'inactive';
				throw err;
			}
			role = 'owner';
			return 'owner';
		}
		catch (err) {
			if (role === 'initializing' && !querySubscription) {
				owner = null;
				role = 'inactive';
			}
			throw err;
		}
	}

	function markReady(): void {
		if (role !== 'owner' || !owner)
			throw new Error('当前模块没有桥接所有者登记权');
		owner.phase = 'ready';
	}

	function release(): void {
		querySubscription?.cancel();
		querySubscription = null;
		owner = null;
		role = 'inactive';
	}

	function request(method: string): Promise<any> {
		const owners = discoverOwners();
		if (owners.length === 0)
			throw new Error('未发现已激活的 AI Command Engine 所有者，请先激活扩展');
		if (owners.length > 1)
			throw new Error(`发现 ${owners.length} 个 AI Command Engine 所有者，拒绝执行菜单操作`);
		if (owners[0].phase !== 'ready')
			throw new Error('AI Command Engine 所有者正在初始化，请稍后重试');
		return eda.sys_MessageBus.rpcCall(owners[0].rpcTopic, { method });
	}

	return { activate, markReady, release, request };
}
