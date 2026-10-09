import namespace from '../namespace.js'
(function (global) {
	'use strict';

	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};
	const {
		SAFE_COPPER_WIDTH,
		REGION_RULE_NO_FILLS,
		REGION_RULE_NO_POURS,
		REGION_RULE_FOLLOW_REGION_RULE,
	} = namespace.constants;
	const {
		toNumber,
		rotateBox,
		normalizePadRotationDegrees,
	} = namespace.geometryUtils;
	const {
		getPolygonBounds,
		getPolygonSize,
		makePointsFromPolygonSource,
		cleanBoundaryPoints,
	} = namespace.polygonUtils;

	function getPrimitiveType(primitive) {
		if (!primitive || typeof primitive.getState_PrimitiveType !== 'function') {
			return '';
		}

		return primitive.getState_PrimitiveType();
	}

	function getPrimitiveId(primitive) {
		if (!primitive || typeof primitive.getState_PrimitiveId !== 'function') {
			return '';
		}

		return primitive.getState_PrimitiveId();
	}

	function makeCenteredLocalPolygonPoints(source) {
		const points = makePointsFromPolygonSource(source);
		const bounds = getPolygonBounds(source);
		if (!bounds || points.length < 3) {
			return [];
		}

		const centerX = (bounds.minX + bounds.maxX) / 2;
		const centerY = (bounds.minY + bounds.maxY) / 2;
		return cleanBoundaryPoints(points.map(point => ({
			x: point.x - centerX,
			y: point.y - centerY,
		})));
	}

	function getPadGeometry(pad) {
		const shape = typeof pad.getState_Pad === 'function' ? pad.getState_Pad() : undefined;
		if (!Array.isArray(shape)) {
			const hole = typeof pad.getState_Hole === 'function' ? pad.getState_Hole() : undefined;
			const holeDiameter = Array.isArray(hole) ? toNumber(hole[1], 60) : 60;
			const diameter = holeDiameter * 1.8;
			return { shapeKind: 'circle', width: diameter, height: diameter };
		}

		if (shape[0] === 'RECT') {
			return {
				shapeKind: 'rect',
				width: toNumber(shape[1], 60),
				height: toNumber(shape[2], 60),
				roundRadius: Math.max(0, toNumber(shape[3], 0)),
			};
		}

		if (shape[0] === 'ELLIPSE') {
			return { shapeKind: 'ellipse', width: toNumber(shape[1], 60), height: toNumber(shape[2], 60) };
		}

		if (shape[0] === 'OVAL') {
			return { shapeKind: 'oval', width: toNumber(shape[1], 60), height: toNumber(shape[2], 60) };
		}

		if (shape[0] === 'NGON') {
			const diameter = toNumber(shape[1], 60);
			const sideCount = Math.max(3, Math.round(toNumber(shape[2], 32)));
			return { shapeKind: 'regular-polygon', width: diameter, height: diameter, sideCount };
		}

		if (shape[0] === 'POLYGON') {
			const size = getPolygonSize(shape[1]);
			if (size) {
				return {
					shapeKind: 'polygon',
					width: size.width,
					height: size.height,
					localPolygonPoints: makeCenteredLocalPolygonPoints(shape[1]),
				};
			}
		}

		return { shapeKind: 'ellipse', width: 80, height: 80 };
	}

	function makeViaTarget(via) {
		const diameter = toNumber(via.getState_Diameter(), 60);
		return {
			primitiveId: getPrimitiveId(via),
			type: 'Via',
			x: toNumber(via.getState_X(), 0),
			y: toNumber(via.getState_Y(), 0),
			width: diameter,
			height: diameter,
			shapeKind: 'circle',
			shapeWidth: diameter,
			shapeHeight: diameter,
			rotation: 0,
			net: typeof via.getState_Net === 'function' ? via.getState_Net() : '',
		};
	}

	function makePadTarget(pad) {
		const geometry = getPadGeometry(pad);
		const rotation = normalizePadRotationDegrees(
			typeof pad.getState_Rotation === 'function' ? pad.getState_Rotation() : 0,
		);
		const rotated = rotateBox(geometry.width, geometry.height, rotation);
		return {
			primitiveId: getPrimitiveId(pad),
			type: getPrimitiveType(pad),
			x: toNumber(pad.getState_X(), 0),
			y: toNumber(pad.getState_Y(), 0),
			width: rotated.width,
			height: rotated.height,
			shapeKind: geometry.shapeKind,
			boundaryShapeKind: 'rect',
			shapeWidth: geometry.width,
			shapeHeight: geometry.height,
			roundRadius: geometry.roundRadius || 0,
			sideCount: geometry.sideCount || 0,
			localPolygonPoints: geometry.localPolygonPoints || [],
			rotation,
			net: typeof pad.getState_Net === 'function' ? pad.getState_Net() : '',
		};
	}

	function makeLineObstacleTarget(line) {
		const startX = toNumber(line.getState_StartX(), 0);
		const startY = toNumber(line.getState_StartY(), 0);
		const endX = toNumber(line.getState_EndX(), startX);
		const endY = toNumber(line.getState_EndY(), startY);
		const dx = endX - startX;
		const dy = endY - startY;
		const lineWidth = Math.max(toNumber(line.getState_LineWidth(), SAFE_COPPER_WIDTH), SAFE_COPPER_WIDTH);
		const length = Math.hypot(dx, dy);
		const rotation = length > 0 ? Math.atan2(dy, dx) * 180 / Math.PI : 0;
		const shapeWidth = length + lineWidth;
		const shapeHeight = lineWidth;
		const rotated = rotateBox(shapeWidth, shapeHeight, rotation);

		return {
			primitiveId: getPrimitiveId(line),
			type: getPrimitiveType(line) || 'Line',
			x: (startX + endX) / 2,
			y: (startY + endY) / 2,
			width: rotated.width,
			height: rotated.height,
			shapeKind: 'rect',
			shapeWidth,
			shapeHeight,
			rotation,
			startX,
			startY,
			endX,
			endY,
			lineWidth,
			net: typeof line.getState_Net === 'function' ? line.getState_Net() : '',
		};
	}

	function makeBoundsObstacleTarget(bounds, primitive, type, net) {
		const width = Math.max(bounds.maxX - bounds.minX, SAFE_COPPER_WIDTH);
		const height = Math.max(bounds.maxY - bounds.minY, SAFE_COPPER_WIDTH);

		return {
			primitiveId: getPrimitiveId(primitive),
			type,
			x: (bounds.minX + bounds.maxX) / 2,
			y: (bounds.minY + bounds.maxY) / 2,
			width,
			height,
			shapeKind: 'rect',
			shapeWidth: width,
			shapeHeight: height,
			rotation: 0,
			net,
		};
	}

	function getPrimitiveNet(primitive) {
		return primitive && typeof primitive.getState_Net === 'function'
			? primitive.getState_Net()
			: '';
	}

	function getPrimitiveLayer(primitive) {
		return primitive && typeof primitive.getState_Layer === 'function'
			? primitive.getState_Layer()
			: undefined;
	}

	function getPrimitiveLineWidth(primitive) {
		return primitive && typeof primitive.getState_LineWidth === 'function'
			? Math.max(toNumber(primitive.getState_LineWidth(), 0), 0)
			: 0;
	}

	function getComplexPolygonSource(complexPolygon) {
		if (!complexPolygon) {
			return undefined;
		}

		return typeof complexPolygon.getSource === 'function'
			? complexPolygon.getSource()
			: complexPolygon;
	}

	function getPrimitiveComplexPolygonSource(primitive) {
		const complexPolygon = primitive && typeof primitive.getState_ComplexPolygon === 'function'
			? primitive.getState_ComplexPolygon()
			: undefined;
		return getComplexPolygonSource(complexPolygon);
	}

	function makePolygonObstacleTarget(source, primitive, type, net, options = {}) {
		const lineWidth = Math.max(toNumber(options.lineWidth, 0), 0);
		const bounds = getPolygonBounds(source, lineWidth / 2);
		if (!bounds) {
			const primitiveId = options.primitiveId || getPrimitiveId(primitive) || '(无 ID)';
			throw new Error(`铜对象 ${type} ${primitiveId} 的多边形几何缺失或无法解析`);
		}

		const target = makeBoundsObstacleTarget(bounds, primitive, type, net);
		return {
			...target,
			primitiveId: options.primitiveId || target.primitiveId,
			polygonSource: source,
			lineWidth,
			sourceKind: 'polygon',
		};
	}

	function makePourObstacleTarget(pour) {
		return makePolygonObstacleTarget(
			getPrimitiveComplexPolygonSource(pour),
			pour,
			getPrimitiveType(pour) || 'Pour',
			getPrimitiveNet(pour),
			{ lineWidth: getPrimitiveLineWidth(pour) },
		);
	}

	function makeFillObstacleTarget(fill) {
		return makePolygonObstacleTarget(
			getPrimitiveComplexPolygonSource(fill),
			fill,
			getPrimitiveType(fill) || 'Fill',
			getPrimitiveNet(fill),
			{ lineWidth: getPrimitiveLineWidth(fill) },
		);
	}

	function makeArcObstacleTarget(arc) {
		const startX = toNumber(arc.getState_StartX(), 0);
		const startY = toNumber(arc.getState_StartY(), 0);
		const endX = toNumber(arc.getState_EndX(), startX);
		const endY = toNumber(arc.getState_EndY(), startY);
		const lineWidth = Math.max(toNumber(arc.getState_LineWidth(), SAFE_COPPER_WIDTH), SAFE_COPPER_WIDTH);
		const chord = Math.hypot(endX - startX, endY - startY);
		const arcAngle = Math.abs(toNumber(
			typeof arc.getState_ArcAngle === 'function' ? arc.getState_ArcAngle() : 0,
			0,
		));
		const angleRadians = Math.min(arcAngle * Math.PI / 180, Math.PI * 1.95);
		const rawBulge = chord > 0 && angleRadians > 0
			? (chord / 2) * Math.abs(Math.tan(angleRadians / 4))
			: 0;
		const arcBulge = Number.isFinite(rawBulge)
			? Math.min(rawBulge, Math.max(chord * 2, lineWidth * 2))
			: Math.max(chord, lineWidth);
		const padding = lineWidth / 2 + arcBulge;

		return makeBoundsObstacleTarget({
			minX: Math.min(startX, endX) - padding,
			minY: Math.min(startY, endY) - padding,
			maxX: Math.max(startX, endX) + padding,
			maxY: Math.max(startY, endY) + padding,
		}, arc, getPrimitiveType(arc) || 'Arc', typeof arc.getState_Net === 'function' ? arc.getState_Net() : '');
	}

	function getRegionRuleTypes(region) {
		if (!region || typeof region.getState_RuleType !== 'function') {
			return [];
		}

		const ruleTypes = region.getState_RuleType();
		return Array.isArray(ruleTypes) ? ruleTypes.map(ruleType => toNumber(ruleType, -1)) : [];
	}

	function shouldUseRegionAsObstacle(region) {
		const ruleTypes = getRegionRuleTypes(region);
		return ruleTypes.length === 0
			|| ruleTypes.includes(REGION_RULE_NO_FILLS)
			|| ruleTypes.includes(REGION_RULE_NO_POURS)
			|| ruleTypes.includes(REGION_RULE_FOLLOW_REGION_RULE);
	}

	function makeRegionObstacleTarget(region) {
		if (!shouldUseRegionAsObstacle(region)) {
			return undefined;
		}

		return makePolygonObstacleTarget(
			getPrimitiveComplexPolygonSource(region),
			region,
			getPrimitiveType(region) || 'Region',
			getPrimitiveNet(region),
			{ lineWidth: getPrimitiveLineWidth(region) },
		);
	}

	function makePouredFillObstacleTargets(poured, pourById) {
		const pourPrimitiveId = poured && typeof poured.getState_PourPrimitiveId === 'function'
			? poured.getState_PourPrimitiveId()
			: '';
		const sourcePour = pourPrimitiveId ? pourById.get(pourPrimitiveId) : undefined;
		const sourceNet = sourcePour ? getPrimitiveNet(sourcePour) : '';
		const sourceLayer = sourcePour ? getPrimitiveLayer(sourcePour) : undefined;
		const pourFills = poured && typeof poured.getState_PourFills === 'function'
			? poured.getState_PourFills()
			: [];
		const targets = [];

		if (!Array.isArray(pourFills))
			throw new Error(`覆铜填充 ${getPrimitiveId(poured) || '(无 ID)'} 缺少 PourFills 数组`);

		for (const fill of pourFills) {
			if (!fill || fill.fill === false) {
				continue;
			}

			const source = getComplexPolygonSource(fill.path);
			const target = makePolygonObstacleTarget(
				source,
				poured,
				getPrimitiveType(poured) || 'Poured',
				sourceNet,
				{
					lineWidth: Math.max(toNumber(fill.lineWidth, 0), 0),
					primitiveId: `${getPrimitiveId(poured)}:${fill.id || targets.length}`,
				},
			);

			if (target) {
				target.layer = sourceLayer;
				target.pourPrimitiveId = pourPrimitiveId;
				target.pouredFillId = fill.id || '';
				targets.push(target);
			}
		}

		return targets;
	}

	async function getComponentPads(component) {
		if (typeof component.getAllPins === 'function') {
			const primitiveId = getPrimitiveId(component) || '(无 ID)';
			return await namespace.host.read(`upstream 读取器件 ${primitiveId} 焊盘`, async () => {
				const pins = await component.getAllPins();
				if (!Array.isArray(pins))
					throw new Error(`器件 ${primitiveId} 的 getAllPins 未返回完整数组`);
				return pins;
			});
		}

		const primitiveId = getPrimitiveId(component);
		if (!primitiveId) {
			throw new Error('器件缺少 PrimitiveId，无法完整读取焊盘');
		}

		const pads = await namespace.sdkProxy.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
		if (!Array.isArray(pads))
			throw new Error(`器件 ${primitiveId} 的 getAllPinsByPrimitiveId 未返回完整数组`);
		return pads;
	}

	namespace.primitiveTargets = {
		getPrimitiveType,
		getPrimitiveId,
		makeCenteredLocalPolygonPoints,
		getPadGeometry,
		makeViaTarget,
		makePadTarget,
		makeLineObstacleTarget,
		makeBoundsObstacleTarget,
		getPrimitiveNet,
		getPrimitiveLayer,
		getPrimitiveLineWidth,
		getComplexPolygonSource,
		getPrimitiveComplexPolygonSource,
		makePolygonObstacleTarget,
		makePourObstacleTarget,
		makeFillObstacleTarget,
		makeArcObstacleTarget,
		getRegionRuleTypes,
		shouldUseRegionAsObstacle,
		makeRegionObstacleTarget,
		makePouredFillObstacleTargets,
		getComponentPads,
	};
})(namespace);
