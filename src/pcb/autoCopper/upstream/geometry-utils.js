import namespace from '../namespace.js'
(function (global) {
	'use strict';

	function toNumber(value, fallback) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	function rotateBox(width, height, rotation) {
		const radians = toNumber(rotation, 0) * Math.PI / 180;
		const cos = Math.abs(Math.cos(radians));
		const sin = Math.abs(Math.sin(radians));
		return {
			width: width * cos + height * sin,
			height: width * sin + height * cos,
		};
	}

	function normalizePadRotationDegrees(rotation) {
		const value = toNumber(rotation, 0);
		const eighthTurn = Math.PI / 4;
		if (Math.abs(value) <= Math.PI * 2 + 0.001) {
			const snappedRadians = Math.round(value / eighthTurn) * eighthTurn;
			if (Math.abs(value - snappedRadians) <= 0.001) {
				return snappedRadians * 180 / Math.PI;
			}
		}

		return value;
	}

	function distance(a, b) {
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function roundCoordinate(value) {
		return Math.round(value * 1000) / 1000;
	}

	function cross(origin, a, b) {
		return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
	}

	function pointKey(point) {
		return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
	}

	function toRadians(degrees) {
		return toNumber(degrees, 0) * Math.PI / 180;
	}

	function rotateLocalPoint(point, rotation) {
		const radians = toRadians(rotation);
		const cos = Math.cos(radians);
		const sin = Math.sin(radians);
		return {
			x: point.x * cos - point.y * sin,
			y: point.x * sin + point.y * cos,
		};
	}

	function rotateWorldDirectionToLocal(direction, rotation) {
		return rotateLocalPoint(direction, -rotation);
	}

	function vectorLength(vector) {
		return Math.hypot(vector.x, vector.y);
	}

	function normalizeVector(vector) {
		const length = vectorLength(vector);
		if (length <= 0) {
			return { x: 0, y: 0 };
		}

		return {
			x: vector.x / length,
			y: vector.y / length,
		};
	}

	function reverseVector(vector) {
		return {
			x: -vector.x,
			y: -vector.y,
		};
	}

	function addVectors(a, b) {
		return {
			x: a.x + b.x,
			y: a.y + b.y,
		};
	}

	function dotProduct(a, b) {
		return a.x * b.x + a.y * b.y;
	}

	function polygonSignedArea(points) {
		let area = 0;
		for (let index = 0; index < points.length; index += 1) {
			const current = points[index];
			const next = points[(index + 1) % points.length];
			area += current.x * next.y - next.x * current.y;
		}

		return area / 2;
	}

	function getOutwardNormal(start, end, signedArea) {
		const edge = {
			x: end.x - start.x,
			y: end.y - start.y,
		};

		return normalizeVector(signedArea >= 0
			? { x: edge.y, y: -edge.x }
			: { x: -edge.y, y: edge.x });
	}

	function interpolatePoint(start, end, ratio) {
		return {
			x: start.x + (end.x - start.x) * ratio,
			y: start.y + (end.y - start.y) * ratio,
		};
	}

	function pointToward(from, to, length) {
		const segmentLength = distance(from, to);
		if (segmentLength <= 0) {
			return { x: from.x, y: from.y };
		}

		const ratio = Math.min(1, Math.max(0, length / segmentLength));
		return {
			x: from.x + (to.x - from.x) * ratio,
			y: from.y + (to.y - from.y) * ratio,
		};
	}

	function quadraticPoint(start, control, end, ratio) {
		const inverse = 1 - ratio;
		return {
			x: inverse * inverse * start.x + 2 * inverse * ratio * control.x + ratio * ratio * end.x,
			y: inverse * inverse * start.y + 2 * inverse * ratio * control.y + ratio * ratio * end.y,
		};
	}

	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};
	namespace.geometryUtils = {
		toNumber,
		rotateBox,
		normalizePadRotationDegrees,
		distance,
		roundCoordinate,
		cross,
		pointKey,
		toRadians,
		rotateLocalPoint,
		rotateWorldDirectionToLocal,
		vectorLength,
		normalizeVector,
		reverseVector,
		addVectors,
		dotProduct,
		polygonSignedArea,
		getOutwardNormal,
		interpolatePoint,
		pointToward,
		quadraticPoint,
	};
})(namespace);
