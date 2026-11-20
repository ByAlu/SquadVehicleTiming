"use strict";

const RouteMath = (() => {
  function legDistances(points, widthMeters, heightMeters) {
    return points.slice(1).map((current, index) => {
      const previous = points[index];
      return Math.hypot(
        (current.x - previous.x) * widthMeters,
        (current.y - previous.y) * heightMeters,
      );
    });
  }

  function routeLength(points, widthMeters, heightMeters) {
    return legDistances(points, widthMeters, heightMeters).reduce((total, distance) => total + distance, 0);
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

  return { legDistances, routeLength, travelSeconds, formatTime };
})();

if (typeof module !== "undefined") module.exports = RouteMath;
