import namespace from '../namespace.js'
(function (global) {
	'use strict';

	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};
	const {
		SAFE_COPPER_WIDTH,
		TRACE_CAP_SEGMENTS,
		COPPER_NODE_CONTOUR_SEGMENTS,
		ROUND_RECT_CORNER_SEGMENTS,
		OBSTACLE_LATERAL_MARGIN,
		SINGLE_TARGET_SEGMENTS,
		DEFAULT_CONFIG,
	} = namespace.constants;
	const {
		toNumber,
		rotateLocalPoint,
		rotateWorldDirectionToLocal,
		vectorLength,
		normalizeVector,
		reverseVector,
		dotProduct,
	} = namespace.geometryUtils;
	const {
		convexHull,
		cleanBoundaryPoints,
	} = namespace.polygonUtils;

	function getConfigExpansion(config) {
		return Math.max(0, toNumber(
			config.padBboxExpansion,
			toNumber(config.expansion, DEFAULT_CONFIG.padBboxExpansion),
		));
	}

	function applyBoundaryMargins(targets, config) {
		const boundaryMargin = getConfigExpansion(config);
		return targets.map(target => ({
			...target,
			boundaryMargin,
		}));
	}

	function getTargetBoundaryMargin(target, fallback) {
		return Math.max(0, toNumber(target.boundaryMargin, fallback));
	}

	function calculatePourMargin(config) {
		return getConfigExpansion(config);
	}

	function makeTargetMarginReductionCandidates(targets, margin) {
		const expandableIndexes = targets
			.map((target, index) => getTargetBoundaryMargin(target, margin) > 0 ? index : -1)
			.filter(index => index >= 0);
		const candidates = [];

		for (const index of expandableIndexes) {
			candidates.push({
				targets: targets.map((target, targetIndex) => targetIndex === index
					? { ...target, boundaryMargin: 0, boundaryReducedExpansion: true }
					: target),
				reducedCount: 1,
			});
		}

		if (expandableIndexes.length > 1) {
			candidates.push({
				targets: targets.map(target => ({
					...target,
					boundaryMargin: 0,
					boundaryReducedExpansion: true,
				})),
				reducedCount: expandableIndexes.length,
			});
		}

		return candidates;
	}

	function makeCirclePoints(center, radius, segments = TRACE_CAP_SEGMENTS * 2) {
		const points = [];
		const count = Math.max(8, segments);
		for (let index = 0; index < count; index += 1) {
			const angle = Math.PI * 2 * index / count;
			points.push({
				x: center.x + Math.cos(angle) * radius,
				y: center.y + Math.sin(angle) * radius,
			});
		}

		return points;
	}

	function getTraceClearanceRadius(trace, clearance) {
		return Math.max(
			toNumber(trace.lineWidth, SAFE_COPPER_WIDTH) / 2 + clearance,
			SAFE_COPPER_WIDTH / 2,
		);
	}

	function makeTraceCapsulePoints(trace, clearance) {
		const start = {
			x: toNumber(trace.startX, trace.x),
			y: toNumber(trace.startY, trace.y),
		};
		const end = {
			x: toNumber(trace.endX, trace.x),
			y: toNumber(trace.endY, trace.y),
		};
		const radius = getTraceClearanceRadius(trace, clearance);
		const direction = normalizeVector({
			x: end.x - start.x,
			y: end.y - start.y,
		});

		if (vectorLength(direction) <= 0) {
			return makeCirclePoints(start, radius);
		}

		const perpendicular = {
			x: -direction.y,
			y: direction.x,
		};
		const perpendicularAngle = Math.atan2(perpendicular.y, perpendicular.x);
		const points = [
			{
				x: start.x + perpendicular.x * radius,
				y: start.y + perpendicular.y * radius,
			},
			{
				x: end.x + perpendicular.x * radius,
				y: end.y + perpendicular.y * radius,
			},
		];

		for (let index = 1; index <= TRACE_CAP_SEGMENTS; index += 1) {
			const angle = perpendicularAngle - Math.PI * index / TRACE_CAP_SEGMENTS;
			points.push({
				x: end.x + Math.cos(angle) * radius,
				y: end.y + Math.sin(angle) * radius,
			});
		}

		points.push({
			x: start.x - perpendicular.x * radius,
			y: start.y - perpendicular.y * radius,
		});

		for (let index = 1; index <= TRACE_CAP_SEGMENTS; index += 1) {
			const angle = perpendicularAngle - Math.PI - Math.PI * index / TRACE_CAP_SEGMENTS;
			points.push({
				x: start.x + Math.cos(angle) * radius,
				y: start.y + Math.sin(angle) * radius,
			});
		}

		return cleanBoundaryPoints(points);
	}

	function getTargetCenterPoint(target) {
		return {
			x: target.x,
			y: target.y,
			target,
		};
	}

	function getCenterHullTargets(targets) {
		return convexHull(targets.map(getTargetCenterPoint))
			.map(point => point.target)
			.filter(Boolean);
	}

	function makeWorldPoint(target, localPoint) {
		const rotated = rotateLocalPoint(localPoint, target.rotation);
		return {
			x: target.x + rotated.x,
			y: target.y + rotated.y,
		};
	}

	function getShapeWidth(target) {
		return Math.max(toNumber(target.shapeWidth, target.width), SAFE_COPPER_WIDTH);
	}

	function getShapeHeight(target) {
		return Math.max(toNumber(target.shapeHeight, target.height), SAFE_COPPER_WIDTH);
	}

	function getBoundaryShapeKind(target) {
		return target.boundaryShapeKind || target.shapeKind;
	}

	function getCopperNodeShapeWidth(target) {
		const value = toNumber(target && target.shapeWidth, toNumber(target && target.width, Number.NaN));
		return Number.isFinite(value) && value > 0 ? value : SAFE_COPPER_WIDTH;
	}

	function getCopperNodeShapeHeight(target) {
		const value = toNumber(target && target.shapeHeight, toNumber(target && target.height, Number.NaN));
		return Number.isFinite(value) && value > 0 ? value : SAFE_COPPER_WIDTH;
	}

	function makeLocalEllipseContourPoints(width, height, segments = COPPER_NODE_CONTOUR_SEGMENTS) {
		const radiusX = Math.max(width, 0) / 2;
		const radiusY = Math.max(height, 0) / 2;
		const count = Math.max(12, segments);
		const points = [];
		for (let index = 0; index < count; index += 1) {
			const angle = Math.PI * 2 * index / count;
			points.push({
				x: Math.cos(angle) * radiusX,
				y: Math.sin(angle) * radiusY,
			});
		}

		return points;
	}

	function makeLocalRoundedRectContourPoints(width, height, roundRadius = 0) {
		const halfWidth = Math.max(width, 0) / 2;
		const halfHeight = Math.max(height, 0) / 2;
		const radius = Math.min(
			Math.max(0, toNumber(roundRadius, 0)),
			halfWidth,
			halfHeight,
		);

		if (radius <= 0.001) {
			return [
				{ x: -halfWidth, y: -halfHeight },
				{ x: halfWidth, y: -halfHeight },
				{ x: halfWidth, y: halfHeight },
				{ x: -halfWidth, y: halfHeight },
			];
		}

		const corners = [
			{ x: halfWidth - radius, y: -halfHeight + radius, start: -Math.PI / 2, end: 0 },
			{ x: halfWidth - radius, y: halfHeight - radius, start: 0, end: Math.PI / 2 },
			{ x: -halfWidth + radius, y: halfHeight - radius, start: Math.PI / 2, end: Math.PI },
			{ x: -halfWidth + radius, y: -halfHeight + radius, start: Math.PI, end: Math.PI * 3 / 2 },
		];
		const points = [];
		for (const corner of corners) {
			for (let index = 0; index <= ROUND_RECT_CORNER_SEGMENTS; index += 1) {
				const angle = corner.start + (corner.end - corner.start) * index / ROUND_RECT_CORNER_SEGMENTS;
				points.push({
					x: corner.x + Math.cos(angle) * radius,
					y: corner.y + Math.sin(angle) * radius,
				});
			}
		}

		return cleanBoundaryPoints(points);
	}

	function makeLocalOblongContourPoints(width, height, segments = COPPER_NODE_CONTOUR_SEGMENTS) {
		const halfWidth = Math.max(width, 0) / 2;
		const halfHeight = Math.max(height, 0) / 2;
		const capSegments = Math.max(6, Math.round(segments / 2));
		const points = [];

		if (Math.abs(width - height) <= 0.001) {
			return makeLocalEllipseContourPoints(width, height, segments);
		}

		if (width > height) {
			const radius = halfHeight;
			const rightCenterX = halfWidth - radius;
			const leftCenterX = -rightCenterX;
			for (let index = 0; index <= capSegments; index += 1) {
				const angle = -Math.PI / 2 + Math.PI * index / capSegments;
				points.push({
					x: rightCenterX + Math.cos(angle) * radius,
					y: Math.sin(angle) * radius,
				});
			}
			for (let index = 0; index <= capSegments; index += 1) {
				const angle = Math.PI / 2 + Math.PI * index / capSegments;
				points.push({
					x: leftCenterX + Math.cos(angle) * radius,
					y: Math.sin(angle) * radius,
				});
			}
			return cleanBoundaryPoints(points);
		}

		const radius = halfWidth;
		const bottomCenterY = halfHeight - radius;
		const topCenterY = -bottomCenterY;
		for (let index = 0; index <= capSegments; index += 1) {
			const angle = 0 + Math.PI * index / capSegments;
			points.push({
				x: Math.cos(angle) * radius,
				y: bottomCenterY + Math.sin(angle) * radius,
			});
		}
		for (let index = 0; index <= capSegments; index += 1) {
			const angle = Math.PI + Math.PI * index / capSegments;
			points.push({
				x: Math.cos(angle) * radius,
				y: topCenterY + Math.sin(angle) * radius,
			});
		}

		return cleanBoundaryPoints(points);
	}

	function makeLocalRegularPolygonContourPoints(diameter, sideCount) {
		const radius = Math.max(diameter, 0) / 2;
		const count = Math.max(3, Math.round(toNumber(sideCount, 3)));
		const points = [];
		for (let index = 0; index < count; index += 1) {
			const angle = -Math.PI / 2 + Math.PI * 2 * index / count;
			points.push({
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
			});
		}

		return points;
	}

	function makeCopperNodeBodyContourPoints(target) {
		if (!target) {
			return [];
		}

		const width = getCopperNodeShapeWidth(target);
		const height = getCopperNodeShapeHeight(target);
		const shapeKind = target.shapeKind || getBoundaryShapeKind(target);
		let localPoints = [];

		if (shapeKind === 'polygon' && Array.isArray(target.localPolygonPoints) && target.localPolygonPoints.length >= 3) {
			localPoints = target.localPolygonPoints;
		}
		else if (shapeKind === 'regular-polygon') {
			localPoints = makeLocalRegularPolygonContourPoints(width, target.sideCount);
		}
		else if (shapeKind === 'oval') {
			localPoints = makeLocalOblongContourPoints(width, height);
		}
		else if (shapeKind === 'rect') {
			localPoints = makeLocalRoundedRectContourPoints(width, height, target.roundRadius);
		}
		else {
			localPoints = makeLocalEllipseContourPoints(width, height);
		}

		return cleanBoundaryPoints(localPoints.map(point => makeWorldPoint(target, point)));
	}

	function getShapeProjectionRadius(target, direction, shouldUseDynamicShape) {
		if (!shouldUseDynamicShape) {
			return 0;
		}

		const localDirection = rotateWorldDirectionToLocal(direction, target.rotation);
		const halfWidth = getShapeWidth(target) / 2;
		const halfHeight = getShapeHeight(target) / 2;

		if (getBoundaryShapeKind(target) === 'rect') {
			return Math.abs(localDirection.x) * halfWidth + Math.abs(localDirection.y) * halfHeight;
		}

		return Math.hypot(halfWidth * localDirection.x, halfHeight * localDirection.y);
	}

	function getObstacleLimitedMargin(target, direction, margin, shouldUseDynamicShape, obstacles) {
		if (!Array.isArray(obstacles) || obstacles.length === 0) {
			return margin;
		}

		const unit = normalizeVector(direction);
		if (vectorLength(unit) <= 0) {
			return margin;
		}

		const perpendicular = {
			x: -unit.y,
			y: unit.x,
		};
		const targetForwardRadius = getShapeProjectionRadius(target, unit, shouldUseDynamicShape);
		const targetLateralRadius = getShapeProjectionRadius(target, perpendicular, shouldUseDynamicShape);
		let limitedMargin = margin;

		for (const obstacle of obstacles) {
			const offset = {
				x: obstacle.x - target.x,
				y: obstacle.y - target.y,
			};
			const forwardDistance = dotProduct(offset, unit);
			if (forwardDistance <= 0) {
				continue;
			}

			const obstacleForwardRadius = getShapeProjectionRadius(obstacle, reverseVector(unit), true);
			const obstacleLateralRadius = getShapeProjectionRadius(obstacle, perpendicular, true);
			const edgeGap = forwardDistance - targetForwardRadius - obstacleForwardRadius;
			if (edgeGap >= margin * 2) {
				continue;
			}

			const lateralDistance = Math.abs(dotProduct(offset, perpendicular));
			const lateralLimit = targetLateralRadius + obstacleLateralRadius + OBSTACLE_LATERAL_MARGIN;
			if (lateralDistance > lateralLimit) {
				continue;
			}

			limitedMargin = Math.min(limitedMargin, Math.max(0, edgeGap / 2));
		}

		return limitedMargin;
	}

	function rectOffsetSupportPoint(target, direction, margin) {
		const localDirection = rotateWorldDirectionToLocal(direction, target.rotation);
		const width = getShapeWidth(target) / 2 + margin;
		const height = getShapeHeight(target) / 2 + margin;
		const epsilon = 0.000001;
		return makeWorldPoint(target, {
			x: Math.abs(localDirection.x) < epsilon ? 0 : Math.sign(localDirection.x) * width,
			y: Math.abs(localDirection.y) < epsilon ? 0 : Math.sign(localDirection.y) * height,
		});
	}

	function ellipseSupportPoint(target, direction) {
		const localDirection = rotateWorldDirectionToLocal(direction, target.rotation);
		const radiusX = getShapeWidth(target) / 2;
		const radiusY = getShapeHeight(target) / 2;
		const denominator = Math.hypot(radiusX * localDirection.x, radiusY * localDirection.y);

		if (denominator <= 0) {
			return { x: target.x, y: target.y };
		}

		return makeWorldPoint(target, {
			x: radiusX * radiusX * localDirection.x / denominator,
			y: radiusY * radiusY * localDirection.y / denominator,
		});
	}

	function targetSupportPoint(target, direction, margin, shouldUseDynamicShape, obstacles) {
		const unit = normalizeVector(direction);
		const targetMargin = getTargetBoundaryMargin(target, margin);
		const limitedMargin = getObstacleLimitedMargin(target, unit, targetMargin, shouldUseDynamicShape, obstacles);
		if (shouldUseDynamicShape && getBoundaryShapeKind(target) === 'rect') {
			return rectOffsetSupportPoint(target, unit, limitedMargin);
		}

		const point = shouldUseDynamicShape ? ellipseSupportPoint(target, unit) : { x: target.x, y: target.y };
		return {
			x: point.x + unit.x * limitedMargin,
			y: point.y + unit.y * limitedMargin,
		};
	}

	function getRotatedAxis(target, localAxis) {
		return rotateLocalPoint(localAxis, target.rotation);
	}

	function makeRectExpandedCornerPoints(target, margin, shouldUseDynamicShape, obstacles) {
		if (!shouldUseDynamicShape || getBoundaryShapeKind(target) !== 'rect') {
			return makeSingleTargetBoundary(target, margin, shouldUseDynamicShape, obstacles);
		}

		const xAxis = getRotatedAxis(target, { x: 1, y: 0 });
		const yAxis = getRotatedAxis(target, { x: 0, y: 1 });
		const targetMargin = getTargetBoundaryMargin(target, margin);
		const rightMargin = getObstacleLimitedMargin(target, xAxis, targetMargin, shouldUseDynamicShape, obstacles);
		const leftMargin = getObstacleLimitedMargin(target, reverseVector(xAxis), targetMargin, shouldUseDynamicShape, obstacles);
		const topMargin = getObstacleLimitedMargin(target, reverseVector(yAxis), targetMargin, shouldUseDynamicShape, obstacles);
		const bottomMargin = getObstacleLimitedMargin(target, yAxis, targetMargin, shouldUseDynamicShape, obstacles);
		const halfWidth = getShapeWidth(target) / 2;
		const halfHeight = getShapeHeight(target) / 2;

		return [
			makeWorldPoint(target, { x: -halfWidth - leftMargin, y: -halfHeight - topMargin }),
			makeWorldPoint(target, { x: halfWidth + rightMargin, y: -halfHeight - topMargin }),
			makeWorldPoint(target, { x: halfWidth + rightMargin, y: halfHeight + bottomMargin }),
			makeWorldPoint(target, { x: -halfWidth - leftMargin, y: halfHeight + bottomMargin }),
		];
	}

	function makeSingleTargetBoundary(target, margin, shouldUseDynamicShape, obstacles) {
		if (shouldUseDynamicShape && getBoundaryShapeKind(target) === 'rect') {
			return makeRectExpandedCornerPoints(target, margin, shouldUseDynamicShape, obstacles);
		}

		const points = [];
		for (let index = 0; index < SINGLE_TARGET_SEGMENTS; index += 1) {
			const angle = Math.PI * 2 * index / SINGLE_TARGET_SEGMENTS;
			points.push(targetSupportPoint(target, {
				x: Math.cos(angle),
				y: Math.sin(angle),
			}, margin, shouldUseDynamicShape, obstacles));
		}

		return points;
	}

	function makeTargetContourPoints(target, margin, shouldUseDynamicShape, obstacles) {
		return makeSingleTargetBoundary(target, margin, shouldUseDynamicShape, obstacles);
	}

	namespace.targetGeometry = {
		getConfigExpansion,
		applyBoundaryMargins,
		getTargetBoundaryMargin,
		calculatePourMargin,
		makeTargetMarginReductionCandidates,
		makeCirclePoints,
		getTraceClearanceRadius,
		makeTraceCapsulePoints,
		getTargetCenterPoint,
		getCenterHullTargets,
		makeWorldPoint,
		getShapeWidth,
		getShapeHeight,
		getBoundaryShapeKind,
		getCopperNodeShapeWidth,
		getCopperNodeShapeHeight,
		makeLocalEllipseContourPoints,
		makeLocalRoundedRectContourPoints,
		makeLocalOblongContourPoints,
		makeLocalRegularPolygonContourPoints,
		makeCopperNodeBodyContourPoints,
		getShapeProjectionRadius,
		getObstacleLimitedMargin,
		rectOffsetSupportPoint,
		ellipseSupportPoint,
		targetSupportPoint,
		getRotatedAxis,
		makeRectExpandedCornerPoints,
		makeSingleTargetBoundary,
		makeTargetContourPoints,
	};
})(namespace);
