import namespace from '../namespace.js'
(function (global) {
	'use strict';

	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};
	const {
		distance,
		roundCoordinate,
		cross,
		pointKey,
		dotProduct,
		polygonSignedArea,
		interpolatePoint,
	} = namespace.geometryUtils;

	function collectNumbers(source, output) {
		if (!Array.isArray(source)) {
			return;
		}

		for (const item of source) {
			if (Array.isArray(item)) {
				collectNumbers(item, output);
			}
			else if (typeof item === 'number' && Number.isFinite(item)) {
				output.push(item);
			}
		}
	}

	function getPolygonBounds(source, padding = 0) {
		const values = [];
		collectNumbers(source, values);
		if (values.length < 4) {
			return undefined;
		}

		const xs = [];
		const ys = [];
		for (let index = 0; index < values.length - 1; index += 2) {
			xs.push(values[index]);
			ys.push(values[index + 1]);
		}

		return {
			minX: Math.min(...xs) - padding,
			minY: Math.min(...ys) - padding,
			maxX: Math.max(...xs) + padding,
			maxY: Math.max(...ys) + padding,
		};
	}

	function getPolygonSize(source) {
		const bounds = getPolygonBounds(source);
		if (!bounds) {
			return undefined;
		}

		return {
			width: bounds.maxX - bounds.minX,
			height: bounds.maxY - bounds.minY,
		};
	}

	function compactPolygonPoints(points, minDistance) {
		const compacted = [];

		for (const point of points) {
			const previous = compacted[compacted.length - 1];
			if (!previous || distance(previous, point) >= minDistance) {
				compacted.push(point);
			}
		}

		if (compacted.length > 1 && distance(compacted[0], compacted[compacted.length - 1]) < minDistance) {
			compacted.pop();
		}

		return compacted;
	}

	function makePolygonSourceFromPoints(points) {
		if (points.length < 3) {
			return [];
		}

		const first = points[0];
		const source = [roundCoordinate(first.x), roundCoordinate(first.y), 'L'];

		for (let index = 1; index < points.length; index += 1) {
			source.push(roundCoordinate(points[index].x), roundCoordinate(points[index].y));
		}

		source.push(roundCoordinate(first.x), roundCoordinate(first.y));

		return source;
	}

	function isFlatPolygonSource(source) {
		return Array.isArray(source)
			&& source.some(value => typeof value === 'number' && Number.isFinite(value));
	}

	function getPolygonSourceParts(source) {
		if (!Array.isArray(source)) {
			return [];
		}

		if (isFlatPolygonSource(source)) {
			return [source];
		}

		return source.flatMap(getPolygonSourceParts);
	}

	function makePointsFromFlatPolygonSource(source) {
		if (!Array.isArray(source)) {
			return [];
		}

		const numbers = source.filter(value => typeof value === 'number' && Number.isFinite(value));
		const points = [];
		for (let index = 0; index < numbers.length - 1; index += 2) {
			points.push({
				x: numbers[index],
				y: numbers[index + 1],
			});
		}

		if (points.length > 1 && distance(points[0], points[points.length - 1]) <= 0.001) {
			points.pop();
		}

		return cleanBoundaryPoints(points);
	}

	function makePointsFromPolygonSource(source) {
		const part = getPolygonSourceParts(source)
			.map(makePointsFromFlatPolygonSource)
			.find(points => points.length >= 3);

		return part || [];
	}

	function orientPolygonPoints(points, desiredSign) {
		const cleaned = cleanBoundaryPoints(points);
		if (cleaned.length < 3) {
			return cleaned;
		}

		const area = polygonSignedArea(cleaned);
		if ((desiredSign >= 0 && area < 0) || (desiredSign < 0 && area > 0)) {
			return cleaned.slice().reverse();
		}

		return cleaned;
	}

	function makeOrientedPolygonSource(points, desiredSign) {
		return makePolygonSourceFromPoints(orientPolygonPoints(points, desiredSign));
	}

	function uniquePoints(points) {
		const seen = new Set();
		const unique = [];

		for (const point of points) {
			const key = pointKey(point);
			if (!seen.has(key)) {
				seen.add(key);
				unique.push(point);
			}
		}

		return unique;
	}

	function convexHull(points) {
		const sorted = uniquePoints(points)
			.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);

		if (sorted.length <= 1) {
			return sorted;
		}

		const lower = [];
		for (const point of sorted) {
			while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
				lower.pop();
			}
			lower.push(point);
		}

		const upper = [];
		for (let index = sorted.length - 1; index >= 0; index -= 1) {
			const point = sorted[index];
			while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
				upper.pop();
			}
			upper.push(point);
		}

		lower.pop();
		upper.pop();

		return lower.concat(upper);
	}

	function removeCollinearPoints(points) {
		if (points.length < 4) {
			return points;
		}

		const cleaned = [];
		for (let index = 0; index < points.length; index += 1) {
			const previous = points[(index - 1 + points.length) % points.length];
			const current = points[index];
			const next = points[(index + 1) % points.length];
			const area = Math.abs(cross(previous, current, next));

			if (area > 0.001) {
				cleaned.push(current);
			}
		}

		return cleaned.length >= 3 ? cleaned : points;
	}

	function cleanBoundaryPoints(points) {
		let cleaned = compactPolygonPoints(points, 0.001);
		cleaned = removeCollinearPoints(cleaned);
		cleaned = compactPolygonPoints(cleaned, 0.001);

		return cleaned.length >= 3 ? cleaned : points;
	}

	function polygonPointKeysMatch(first, second) {
		return Array.isArray(first)
			&& Array.isArray(second)
			&& first.length === second.length
			&& first.every((point, index) => pointKey(point) === pointKey(second[index]));
	}

	function pointInsideBox(point, box) {
		return point.x >= box.minX
			&& point.x <= box.maxX
			&& point.y >= box.minY
			&& point.y <= box.maxY;
	}

	function pointOnSegment(point, start, end) {
		const epsilon = 0.001;
		return Math.abs(cross(start, end, point)) <= epsilon
			&& point.x >= Math.min(start.x, end.x) - epsilon
			&& point.x <= Math.max(start.x, end.x) + epsilon
			&& point.y >= Math.min(start.y, end.y) - epsilon
			&& point.y <= Math.max(start.y, end.y) + epsilon;
	}

	function segmentsIntersect(a, b, c, d) {
		const epsilon = 0.001;
		const abC = cross(a, b, c);
		const abD = cross(a, b, d);
		const cdA = cross(c, d, a);
		const cdB = cross(c, d, b);

		if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
			&& ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) {
			return true;
		}

		return pointOnSegment(c, a, b)
			|| pointOnSegment(d, a, b)
			|| pointOnSegment(a, c, d)
			|| pointOnSegment(b, c, d);
	}

	function segmentIntersectsBox(start, end, box) {
		if (pointInsideBox(start, box) || pointInsideBox(end, box)) {
			return true;
		}

		const topLeft = { x: box.minX, y: box.minY };
		const topRight = { x: box.maxX, y: box.minY };
		const bottomRight = { x: box.maxX, y: box.maxY };
		const bottomLeft = { x: box.minX, y: box.maxY };

		return segmentsIntersect(start, end, topLeft, topRight)
			|| segmentsIntersect(start, end, topRight, bottomRight)
			|| segmentsIntersect(start, end, bottomRight, bottomLeft)
			|| segmentsIntersect(start, end, bottomLeft, topLeft);
	}

	function getBoxCorners(box) {
		return [
			{ x: box.minX, y: box.minY },
			{ x: box.maxX, y: box.minY },
			{ x: box.maxX, y: box.maxY },
			{ x: box.minX, y: box.maxY },
		];
	}

	function pointOnPolygonBoundary(point, polygon) {
		for (let index = 0; index < polygon.length; index += 1) {
			if (pointOnSegment(point, polygon[index], polygon[(index + 1) % polygon.length])) {
				return true;
			}
		}

		return false;
	}

	function pointInPolygon(point, polygon) {
		if (pointOnPolygonBoundary(point, polygon)) {
			return true;
		}

		let inside = false;
		for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
			const current = polygon[index];
			const previous = polygon[previousIndex];
			const crossesRay = (current.y > point.y) !== (previous.y > point.y);
			if (!crossesRay) {
				continue;
			}

			const intersectionX = (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y) + current.x;
			if (point.x < intersectionX) {
				inside = !inside;
			}
		}

		return inside;
	}

	function getContourSamplePoints(contour) {
		if (!Array.isArray(contour) || contour.length === 0) {
			return [];
		}

		const samples = [];
		const center = contour.reduce((sum, point) => ({
			x: sum.x + point.x,
			y: sum.y + point.y,
		}), { x: 0, y: 0 });
		samples.push({
			x: center.x / contour.length,
			y: center.y / contour.length,
		});

		for (let index = 0; index < contour.length; index += 1) {
			const start = contour[index];
			const end = contour[(index + 1) % contour.length];
			for (const ratio of [0, 0.25, 0.5, 0.75]) {
				samples.push(interpolatePoint(start, end, ratio));
			}
		}

		return samples;
	}

	function polygonCoversContour(polygon, contour) {
		if (!Array.isArray(contour) || contour.length < 3) {
			return true;
		}

		return getContourSamplePoints(contour).every(point => pointInPolygon(point, polygon));
	}

	function polygonCoversTargetContours(polygon, targetKeepInContours = []) {
		return targetKeepInContours.every(contour => polygonCoversContour(polygon, contour));
	}

	function boxTouchesPolygonInterior(box, polygon) {
		const center = { x: box.centerX, y: box.centerY };
		return pointInPolygon(center, polygon)
			|| getBoxCorners(box).some(corner => pointInPolygon(corner, polygon));
	}

	function pointToSegmentDistance(point, start, end) {
		const segment = {
			x: end.x - start.x,
			y: end.y - start.y,
		};
		const lengthSquared = segment.x * segment.x + segment.y * segment.y;
		if (lengthSquared <= 0.000001) {
			return distance(point, start);
		}

		const ratio = Math.min(1, Math.max(0, dotProduct({
			x: point.x - start.x,
			y: point.y - start.y,
		}, segment) / lengthSquared));
		return distance(point, {
			x: start.x + segment.x * ratio,
			y: start.y + segment.y * ratio,
		});
	}

	function segmentToSegmentDistance(firstStart, firstEnd, secondStart, secondEnd) {
		if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) {
			return 0;
		}

		return Math.min(
			pointToSegmentDistance(firstStart, secondStart, secondEnd),
			pointToSegmentDistance(firstEnd, secondStart, secondEnd),
			pointToSegmentDistance(secondStart, firstStart, firstEnd),
			pointToSegmentDistance(secondEnd, firstStart, firstEnd),
		);
	}

	function pointsNearlyEqual(first, second) {
		return distance(first, second) <= 0.001;
	}

	function segmentsShareEndpoint(firstStart, firstEnd, secondStart, secondEnd) {
		return pointsNearlyEqual(firstStart, secondStart)
			|| pointsNearlyEqual(firstStart, secondEnd)
			|| pointsNearlyEqual(firstEnd, secondStart)
			|| pointsNearlyEqual(firstEnd, secondEnd);
	}

	function makePathSegments(points) {
		const segments = [];
		for (let index = 0; index < points.length - 1; index += 1) {
			const start = points[index];
			const end = points[index + 1];
			if (distance(start, end) > 0.001) {
				segments.push({ start, end });
			}
		}

		return segments;
	}

	function makeBoundarySegments(points) {
		const segments = [];
		for (let index = 0; index < points.length; index += 1) {
			const start = points[index];
			const end = points[(index + 1) % points.length];
			if (distance(start, end) > 0.001) {
				segments.push({ start, end, index });
			}
		}

		return segments;
	}

	function getPathLength(points) {
		let length = 0;
		for (let index = 0; index < points.length - 1; index += 1) {
			length += distance(points[index], points[index + 1]);
		}

		return length;
	}

	namespace.polygonUtils = {
		collectNumbers,
		getPolygonBounds,
		getPolygonSize,
		compactPolygonPoints,
		makePolygonSourceFromPoints,
		isFlatPolygonSource,
		getPolygonSourceParts,
		makePointsFromFlatPolygonSource,
		makePointsFromPolygonSource,
		orientPolygonPoints,
		makeOrientedPolygonSource,
		uniquePoints,
		convexHull,
		removeCollinearPoints,
		cleanBoundaryPoints,
		polygonPointKeysMatch,
		pointInsideBox,
		pointOnSegment,
		segmentsIntersect,
		segmentIntersectsBox,
		getBoxCorners,
		pointOnPolygonBoundary,
		pointInPolygon,
		getContourSamplePoints,
		polygonCoversContour,
		polygonCoversTargetContours,
		boxTouchesPolygonInterior,
		pointToSegmentDistance,
		segmentToSegmentDistance,
		pointsNearlyEqual,
		segmentsShareEndpoint,
		makePathSegments,
		makeBoundarySegments,
		getPathLength,
	};
})(namespace);
