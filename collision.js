"use strict";

const Collision = (() => {
  function load(map) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `maps/${encodeURIComponent(map.name)}/collision.js`;
      script.onload = () => {
        script.remove();
        const data = script.collisionData;
        if (data?.map === map.name && data.schemaVersion === 1 && data.grid?.columns > 0 &&
            data.rows?.length === data.grid.rows && data.rows.every((row) =>
              typeof row === "string" && row.length === data.grid.columns && /^[.#?]+$/.test(row))) resolve(data);
        else reject(new Error("Collision grid does not match the selected map."));
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Collision grid unavailable."));
      };
      document.head.append(script);
    });
  }

  function segment(a, b, data) {
    if (!data) return "unknown";
    const { columns, rows } = data.grid;
    const ax = a.x * columns;
    const ay = a.y * rows;
    const bx = b.x * columns;
    const by = b.y * rows;
    const dx = bx - ax;
    const dy = by - ay;
    if (![ax, ay, bx, by].every(Number.isFinite) || Math.min(ax, bx, ay, by) < 0 ||
        Math.max(ax, bx) > columns || Math.max(ay, by) > rows) return "unknown";
    let x = Math.min(columns - 1, Math.floor(ax));
    let y = Math.min(rows - 1, Math.floor(ay));
    const endX = Math.min(columns - 1, Math.floor(bx));
    const endY = Math.min(rows - 1, Math.floor(by));
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    let crossingX = dx ? (x + (dx > 0 ? 1 : 0) - ax) / dx : Infinity;
    let crossingY = dy ? (y + (dy > 0 ? 1 : 0) - ay) / dy : Infinity;
    let unknown = false;

    function blocked(column, row) {
      const cell = data.rows[row]?.[column];
      if (cell !== "." && cell !== "#") unknown = true;
      return cell === "#";
    }

    // Check both sides when the segment runs along an internal cell boundary.
    const onVerticalBoundary = !dx && ax > 0 && ax < columns && Number.isInteger(ax);
    const onHorizontalBoundary = !dy && ay > 0 && ay < rows && Number.isInteger(ay);
    while (true) {
      if (blocked(x, y) || (onVerticalBoundary && blocked(x - 1, y)) ||
          (onHorizontalBoundary && blocked(x, y - 1))) return "blocked";
      if (x === endX && y === endY) return unknown ? "unknown" : "clear";
      const tx = x === endX ? Infinity : crossingX;
      const ty = y === endY ? Infinity : crossingY;
      const crossX = tx <= ty + 1e-10;
      const crossY = ty <= tx + 1e-10;
      if (crossX && crossY && (blocked(x + stepX, y) || blocked(x, y + stepY))) return "blocked";
      if (crossX) {
        x += stepX;
        crossingX += 1 / Math.abs(dx);
      }
      if (crossY) {
        y += stepY;
        crossingY += 1 / Math.abs(dy);
      }
    }
  }

  function path(points, data) {
    let status = "clear";
    for (let index = 1; index < points.length; index++) {
      const check = segment(points[index - 1], points[index], data);
      if (check === "blocked") return check;
      if (check === "unknown") status = check;
    }
    return status;
  }

  return { load, segment, path };
})();

if (typeof module !== "undefined") module.exports = Collision;
