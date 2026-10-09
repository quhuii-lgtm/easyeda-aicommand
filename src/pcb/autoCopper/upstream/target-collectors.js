import namespace from '../namespace.js'
(function (global) {
	'use strict';
	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};
	const eda = namespace.sdkProxy;
	const {
		SAFE_COPPER_WIDTH,
		MULTI_LAYER_ID,
		OBSTACLE_SEARCH_MARGIN,
	} = namespace.constants;
	const {
		toNumber,
		roundCoordinate,
	} = namespace.geometryUtils;
	const {
		getPrimitiveType,
		getPrimitiveId,
		makeViaTarget,
		makePadTarget,
		makeLineObstacleTarget,
		getPrimitiveLayer,
		makePourObstacleTarget,
		makeFillObstacleTarget,
		makeArcObstacleTarget,
		makeRegionObstacleTarget,
		makePouredFillObstacleTargets,
		getComponentPads,
	} = namespace.primitiveTargets;

	function normalizeNetName(net) {
		return String(net || '').trim();
	}

	function isPadLikeTarget(target) {
		return target.type === 'Pad' || target.type === 'ComponentPad';
	}

	function getLayerQueriesWithMulti(layer) {
		const layers = [layer];
		if (layer !== MULTI_LAYER_ID) {
			layers.push(MULTI_LAYER_ID);
		}

		return [...new Set(layers)];
	}

	function getTargetKey(target) {
		const primitiveId = normalizeNetName(target.primitiveId);
		const dimensionKey = [
			roundCoordinate(target.x),
			roundCoordinate(target.y),
			roundCoordinate(target.width),
			roundCoordinate(target.height),
			roundCoordinate(toNumber(target.shapeWidth, target.width)),
			roundCoordinate(toNumber(target.shapeHeight, target.height)),
			roundCoordinate(toNumber(target.rotation, 0)),
			normalizeNetName(target.net),
		].join(':');
		const geometryKey = `${target.type}:${dimensionKey}`;

		if (primitiveId) {
			if (isPadLikeTarget(target)) {
				// Primitive IDs identify physical pads across Pad and ComponentPad API views.
				// Geometry can differ slightly between those views, so it must not split one pad into duplicates.
				return `id:${primitiveId}:pad`;
			}

			return `id:${primitiveId}`;
		}

		return geometryKey;
	}

	function dedupeTargets(targets) {
		const seen = new Set();
		const unique = [];

		for (const target of targets) {
			const key = getTargetKey(target);
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			unique.push(target);
		}

		return unique;
	}

	async function collectTargets(selectedPrimitives) {
		const targets = [];

		for (const primitive of selectedPrimitives) {
			const primitiveType = getPrimitiveType(primitive);
			if (primitiveType === 'Via') {
				targets.push(makeViaTarget(primitive));
			}
			else if (primitiveType === 'Pad') {
				targets.push(makePadTarget(primitive));
			}
			else if (primitiveType === 'ComponentPad') {
				targets.push(makePadTarget(primitive));
			}
			else if (primitiveType === 'Component') {
				const pads = await getComponentPads(primitive);
				for (const pad of pads) {
					targets.push(makePadTarget(pad));
				}
			}
		}

		return dedupeTargets(targets);
	}

	function getTargetHalfSize(target, shouldUseDynamicShape) {
		return {
			halfWidth: shouldUseDynamicShape ? Math.max(target.width / 2, SAFE_COPPER_WIDTH / 2) : 0,
			halfHeight: shouldUseDynamicShape ? Math.max(target.height / 2, SAFE_COPPER_WIDTH / 2) : 0,
		};
	}

	function calculateTargetBounds(targets, shouldUseDynamicShape) {
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		let maxItemSize = 0;

		for (const target of targets) {
			const { halfWidth, halfHeight } = getTargetHalfSize(target, shouldUseDynamicShape);
			minX = Math.min(minX, target.x - halfWidth);
			minY = Math.min(minY, target.y - halfHeight);
			maxX = Math.max(maxX, target.x + halfWidth);
			maxY = Math.max(maxY, target.y + halfHeight);
			maxItemSize = Math.max(maxItemSize, target.width, target.height);
		}

		const span = Math.max(maxX - minX, maxY - minY, 1);

		return { minX, minY, maxX, maxY, maxItemSize, span };
	}

	function isTargetNearBounds(target, bounds) {
		const halfWidth = toNumber(target.width, SAFE_COPPER_WIDTH) / 2;
		const halfHeight = toNumber(target.height, SAFE_COPPER_WIDTH) / 2;
		const minX = target.x - halfWidth;
		const minY = target.y - halfHeight;
		const maxX = target.x + halfWidth;
		const maxY = target.y + halfHeight;
		const gapX = Math.max(bounds.minX - maxX, minX - bounds.maxX, 0);
		const gapY = Math.max(bounds.minY - maxY, minY - bounds.maxY, 0);

		return Math.hypot(gapX, gapY) <= OBSTACLE_SEARCH_MARGIN;
	}

	function isCopperNodePrimitive(target) {
		return target.type === 'Pad'
			|| target.type === 'ComponentPad'
			|| target.type === 'Via';
	}

	function isTraceClipObstacle(target) {
		return Boolean(target
			&& !isCopperNodePrimitive(target)
			&& Number.isFinite(toNumber(target.startX, Number.NaN))
			&& Number.isFinite(toNumber(target.startY, Number.NaN))
			&& Number.isFinite(toNumber(target.endX, Number.NaN))
			&& Number.isFinite(toNumber(target.endY, Number.NaN)));
	}

	function isCopperAreaClipObstacle(target) {
		return Boolean(target
			&& !isCopperNodePrimitive(target)
			&& normalizeNetName(target.net)
			&& target.sourceKind === 'polygon'
			&& Array.isArray(target.polygonSource));
	}

	function isConfirmedDifferentNetObstacle(target, normalizedNet) {
		const obstacleNet = normalizeNetName(target && target.net);
		return Boolean(obstacleNet && obstacleNet !== normalizedNet);
	}

	function isSameNetObstacle(target, normalizedNet) {
		const obstacleNet = normalizeNetName(target && target.net);
		return Boolean(normalizedNet && obstacleNet && obstacleNet === normalizedNet);
	}

	async function collectCopperObstacles(targets, targetNet, layer, options = {}) {
		const normalizedNet = normalizeNetName(targetNet);
		const targetKeys = new Set(targets.map(getTargetKey));
		const obstacleKeys = new Set();
		const obstacles = [];
		const bounds = calculateTargetBounds(targets, true);
		const padLayers = options.includeMultiPads ? getLayerQueriesWithMulti(layer) : [layer];

		const addObstacle = (target) => {
			if (!target || targetKeys.has(getTargetKey(target))) {
				return;
			}

			if (isSameNetObstacle(target, normalizedNet)) {
				return;
			}

			if (!isTargetNearBounds(target, bounds)) {
				return;
			}

			const key = getTargetKey(target);
			if (obstacleKeys.has(key)) {
				return;
			}

			obstacleKeys.add(key);
			obstacles.push(target);
		};

		for (const padLayer of padLayers) {
			const pads = await eda.pcb_PrimitivePad.getAll(padLayer);
			if (Array.isArray(pads)) {
				for (const pad of pads) {
					addObstacle(makePadTarget(pad));
				}
			}
		}

		const components = await eda.pcb_PrimitiveComponent.getAll(layer);
		if (Array.isArray(components)) {
			for (const component of components) {
				const padsInComponent = await getComponentPads(component);
				for (const pad of padsInComponent) {
					addObstacle(makePadTarget(pad));
				}
			}
		}

		const vias = await eda.pcb_PrimitiveVia.getAll();
		if (Array.isArray(vias)) {
			for (const via of vias) {
				addObstacle(makeViaTarget(via));
			}
		}

		if (options.includeLines) {
			const lines = await eda.pcb_PrimitiveLine.getAll(undefined, layer);
			if (Array.isArray(lines)) {
				for (const line of lines) {
					addObstacle(makeLineObstacleTarget(line));
				}
			}
		}

		if (options.includeArcs) {
			const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, layer);
			if (Array.isArray(arcs)) {
				for (const arc of arcs) {
					addObstacle(makeArcObstacleTarget(arc));
				}
			}
		}

		if (options.includeRegions) {
			for (const regionLayer of getLayerQueriesWithMulti(layer)) {
				const regions = await eda.pcb_PrimitiveRegion.getAll(regionLayer);
				if (Array.isArray(regions)) {
					for (const region of regions) {
						addObstacle(makeRegionObstacleTarget(region));
					}
				}
			}
		}

		return obstacles;
	}

	async function collectPadEdgeShieldObstacles(targets, layer, options = {}) {
		const targetKeys = new Set(targets.map(getTargetKey));
		const shieldKeys = new Set();
		const shieldTargets = [];
		const bounds = calculateTargetBounds(targets, true);
		const addShieldTarget = (target) => {
			if (!target || targetKeys.has(getTargetKey(target)) || !isPadLikeTarget(target)) {
				return;
			}

			if (!isTargetNearBounds(target, bounds)) {
				return;
			}

			const key = getTargetKey(target);
			if (shieldKeys.has(key)) {
				return;
			}

			shieldKeys.add(key);
			shieldTargets.push(target);
		};

		for (const padLayer of getLayerQueriesWithMulti(layer)) {
			const pads = await eda.pcb_PrimitivePad.getAll(padLayer);
			if (Array.isArray(pads)) {
				for (const pad of pads) {
					addShieldTarget(makePadTarget(pad));
				}
			}
		}

		const components = await eda.pcb_PrimitiveComponent.getAll(layer);
		if (Array.isArray(components)) {
			for (const component of components) {
				const padsInComponent = await getComponentPads(component);
				for (const pad of padsInComponent) {
					addShieldTarget(makePadTarget(pad));
				}
			}
		}

		if (typeof options.reportPadEdgeDiagnostic === 'function') {
			options.reportPadEdgeDiagnostic('Pad edge shield obstacles collected', {
				targetCount: targets.length,
				shieldTargetCount: shieldTargets.length,
				shieldTargets: typeof options.summarizePadEdgeCollection === 'function'
					? options.summarizePadEdgeCollection(shieldTargets)
					: undefined,
			});
		}

		return shieldTargets;
	}

	async function collectTraceClipObstacles(targets, targetNet, layer) {
		const normalizedNet = normalizeNetName(targetNet);
		const traceKeys = new Set();
		const traces = [];
		const bounds = calculateTargetBounds(targets, true);
		const lines = await eda.pcb_PrimitiveLine.getAll(undefined, layer);

		if (!Array.isArray(lines)) {
			return traces;
		}

		for (const line of lines) {
			const trace = makeLineObstacleTarget(line);
			const traceNet = normalizeNetName(trace.net);
			if (!traceNet || traceNet === normalizedNet) {
				continue;
			}

			if (!isTargetNearBounds(trace, bounds)) {
				continue;
			}

			const key = getTargetKey(trace);
			if (traceKeys.has(key)) {
				continue;
			}

			traceKeys.add(key);
			traces.push(trace);
		}

		return traces;
	}

	async function collectCopperAreaClipObstacles(targets, targetNet, layer) {
		const normalizedNet = normalizeNetName(targetNet);
		const targetKeys = new Set(targets.map(getTargetKey));
		const obstacleKeys = new Set();
		const obstacles = [];
		const bounds = calculateTargetBounds(targets, true);
		const pourById = new Map();
		const pouredPourIds = new Set();
		const addObstacle = (target) => {
			if (!target || targetKeys.has(getTargetKey(target))) {
				return;
			}

			if (isCopperNodePrimitive(target)) {
				return;
			}

			if (!isConfirmedDifferentNetObstacle(target, normalizedNet)) {
				return;
			}

			if (!isTargetNearBounds(target, bounds)) {
				return;
			}

			const key = getTargetKey(target);
			if (obstacleKeys.has(key)) {
				return;
			}

			obstacleKeys.add(key);
			obstacles.push(target);
		};

		const pours = await eda.pcb_PrimitivePour.getAll(undefined, layer);
		if (Array.isArray(pours)) {
			for (const pour of pours) {
				const primitiveId = getPrimitiveId(pour);
				if (primitiveId) {
					pourById.set(primitiveId, pour);
				}
			}
		}

		const pouredPrimitives = await eda.pcb_PrimitivePoured.getAll();
		if (Array.isArray(pouredPrimitives)) {
			for (const poured of pouredPrimitives) {
				const pourPrimitiveId = typeof poured.getState_PourPrimitiveId === 'function'
					? poured.getState_PourPrimitiveId()
					: '';
				const sourcePour = pourPrimitiveId ? pourById.get(pourPrimitiveId) : undefined;
				if (!sourcePour || String(getPrimitiveLayer(sourcePour)) !== String(layer)) {
					continue;
				}

				pouredPourIds.add(pourPrimitiveId);
				for (const target of makePouredFillObstacleTargets(poured, pourById)) {
					addObstacle(target);
				}
			}
		}

		if (Array.isArray(pours)) {
			for (const pour of pours) {
				const primitiveId = getPrimitiveId(pour);
				if (primitiveId && pouredPourIds.has(primitiveId)) {
					continue;
				}

				addObstacle(makePourObstacleTarget(pour));
			}
		}

		const fills = await eda.pcb_PrimitiveFill.getAll(layer);
		if (Array.isArray(fills)) {
			for (const fill of fills) {
				addObstacle(makeFillObstacleTarget(fill));
			}
		}

		for (const regionLayer of getLayerQueriesWithMulti(layer)) {
			const regions = await eda.pcb_PrimitiveRegion.getAll(regionLayer);
			if (Array.isArray(regions)) {
				for (const region of regions) {
					addObstacle(makeRegionObstacleTarget(region));
				}
			}
		}

		return obstacles;
	}

	namespace.targetCollectors = {
		normalizeNetName,
		isPadLikeTarget,
		getLayerQueriesWithMulti,
		getTargetKey,
		dedupeTargets,
		collectTargets,
		getTargetHalfSize,
		calculateTargetBounds,
		isTargetNearBounds,
		isCopperNodePrimitive,
		isTraceClipObstacle,
		isCopperAreaClipObstacle,
		isConfirmedDifferentNetObstacle,
		isSameNetObstacle,
		collectCopperObstacles,
		collectPadEdgeShieldObstacles,
		collectTraceClipObstacles,
		collectCopperAreaClipObstacles,
	};
})(namespace);
