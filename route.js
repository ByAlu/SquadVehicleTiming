"use strict";

const RouteMath = (() => {
  function routeLength(points, widthMeters, heightMeters) {
    let distance = 0;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const current = points[index];
      distance += Math.hypot(
        (current.x - previous.x) * widthMeters,
        (current.y - previous.y) * heightMeters,
      );
    }
    return distance;
  }

  function travelSeconds(distanceMeters, speedKmh) {
    return distanceMeters / (speedKmh / 3.6);
  }

  function formatTime(seconds) {
    const rounded = Math.max(1, Math.round(seconds));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor(rounded / 60) % 60;
    const parts = [];
    if (hours) parts.push(`${hours}h`);
    if (hours || minutes) parts.push(`${minutes}m`);
    parts.push(`${rounded % 60}s`);
    return parts.join(" ");
  }

  return { routeLength, travelSeconds, formatTime };
})();

if (typeof module !== "undefined") module.exports = RouteMath;
