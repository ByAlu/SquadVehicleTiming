"use strict";

const AutoPath = (() => {
  const terrainMath = typeof module === "undefined" ? Terrain : require("./terrain.js");
  const collisionMath = typeof module === "undefined" ? Collision : require("./collision.js");
  const directions = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

  class MinQueue {
    entries = [];

    push(entry) {
      const entries = this.entries;
      let index = entries.length;
      entries.push(entry);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (entries[parent].cost <= entry.cost) break;
        entries[index] = entries[parent];
        index = parent;
      }
      entries[index] = entry;
    }

    pop() {
      const entries = this.entries;
      const first = entries[0];
      const last = entries.pop();
      if (!entries.length) return first;
      let index = 0;
      while (index * 2 + 1 < entries.length) {
        let child = index * 2 + 1;
        if (child + 1 < entries.length && entries[child + 1].cost < entries[child].cost) child++;
        if (last.cost <= entries[child].cost) break;
        entries[index] = entries[child];
        index = child;
      }
      entries[index] = last;
      return first;
    }
  }

  function find(start, end, terrain, width, height, { tracked, speedKmh, collision }) {
    if (!(width > 0 && height > 0 && speedKmh > 0) || !terrain) return null;
    const { columns, rows } = terrain.grid;
    const dxMeters = width / columns;
    const dyMeters = height / rows;
    const speed = speedKmh / 3.6;
    const diagonal = Math.hypot(dxMeters, dyMeters);
    const steps = directions.map(([dx, dy]) => ({ dx, dy, distance: Math.hypot(dx * dxMeters, dy * dyMeters) }));
    const cellPace = terrain.surfaces.map((surface) => surface.type === "Water" ? 0 : terrainMath.paceForSurface(surface, tracked));
    const columnAt = (x) => Math.min(columns - 1, Math.floor(x * columns));
    const rowAt = (y) => Math.min(rows - 1, Math.floor(y * rows));
    const startX = columnAt(start.x);
    const startY = rowAt(start.y);
    const endX = columnAt(end.x);
    const endY = rowAt(end.y);
    const startId = startY * columns + startX;
    const endId = endY * columns + endX;
    const center = (x, y) => ({ x: (x + 0.5) / columns, y: (y + 0.5) / rows });
    const blocked = (a, b) => collision && collisionMath.segment(a, b, collision) === "blocked";

    function passable(x, y) {
      const cell = terrain.rows[y]?.[x];
      return cell && cellPace[cell[3]] > 0;
    }

    function lowerBound(x, y) {
      const dx = Math.abs(endX - x);
      const dy = Math.abs(endY - y);
      const both = Math.min(dx, dy);
      return (both * diagonal + (dx - both) * dxMeters + (dy - both) * dyMeters) / speed;
    }

    function canStep(x, y, nx, ny, distance) {
      if (!passable(nx, ny) || (x !== nx && y !== ny && (!passable(nx, y) || !passable(x, ny)))) return false;
      return Math.abs(terrain.rows[ny][nx][0] - terrain.rows[y][x][0]) <= 4.5 * distance;
    }

    function directPassable() {
      const deltaX = (end.x - start.x) * columns;
      const deltaY = (end.y - start.y) * rows;
      const stepX = Math.sign(deltaX);
      const stepY = Math.sign(deltaY);
      let x = startX;
      let y = startY;
      let crossingX = stepX ? (x + (stepX > 0 ? 1 : 0) - start.x * columns) / deltaX : Infinity;
      let crossingY = stepY ? (y + (stepY > 0 ? 1 : 0) - start.y * rows) / deltaY : Infinity;
      while (x !== endX || y !== endY) {
        const tx = x === endX ? Infinity : crossingX;
        const ty = y === endY ? Infinity : crossingY;
        const dx = tx <= ty + 1e-10 ? stepX : 0;
        const dy = ty <= tx + 1e-10 ? stepY : 0;
        if (!canStep(x, y, x + dx, y + dy, Math.hypot(dx * dxMeters, dy * dyMeters))) return false;
        x += dx;
        y += dy;
        if (dx) crossingX += 1 / Math.abs(deltaX);
        if (dy) crossingY += 1 / Math.abs(deltaY);
      }
      return true;
    }

    if (!passable(startX, startY) || !passable(endX, endY)) return null;
    const direct = !blocked(start, end) && directPassable();
    const directResult = direct ? { via: [], direct: true } : null;
    if (startId === endId || blocked(start, center(startX, startY)) || blocked(center(endX, endY), end)) return directResult;
    const costs = new Float64Array(rows * columns).fill(Infinity);
    const previous = new Int32Array(costs.length).fill(-1);
    const visited = new Uint8Array(costs.length);
    const queue = new MinQueue();
    costs[startId] = 0;
    queue.push({ id: startId, cost: lowerBound(startX, startY) });

    while (queue.entries.length) {
      const { id } = queue.pop();
      if (visited[id]) continue;
      if (id === endId) return { via: pathPoints(previous, endId, columns, rows, start, end), direct };
      visited[id] = 1;
      const x = id % columns;
      const y = Math.floor(id / columns);
      const cell = terrain.rows[y][x];
      for (const { dx, dy, distance } of steps) {
        const nx = x + dx;
        const ny = y + dy;
        if (!canStep(x, y, nx, ny, distance)) continue;
        const nextId = ny * columns + nx;
        if (visited[nextId] || (collision && blocked(center(x, y), center(nx, ny)))) continue;
        const next = terrain.rows[ny][nx];
        const grade = (next[0] - cell[0]) / (10 * distance);
        const pace = terrainMath.paceForGrade(grade, 1);
        const resistance = (1 / cellPace[cell[3]] + 1 / cellPace[next[3]]) / 2;
        const cost = costs[id] + distance * Math.hypot(1, grade) * resistance / (speed * pace);
        if (cost >= costs[nextId]) continue;
        costs[nextId] = cost;
        previous[nextId] = id;
        queue.push({ id: nextId, cost: cost + lowerBound(nx, ny) });
      }
    }
    return directResult;
  }

  function pathPoints(previous, endId, columns, rows, start, end) {
    const cells = [];
    for (let id = endId; id >= 0; id = previous[id]) cells.push(id);
    cells.reverse();
    // Combine consecutive steps in the same direction without cutting corners.
    return cells.filter((id, index) => index === 0 || index === cells.length - 1 ||
      id - cells[index - 1] !== cells[index + 1] - id ||
      2 * (id % columns) !== cells[index - 1] % columns + cells[index + 1] % columns)
      .map((id) => ({ x: (id % columns + 0.5) / columns, y: (Math.floor(id / columns) + 0.5) / rows }))
      .filter((point) => (point.x !== start.x || point.y !== start.y) && (point.x !== end.x || point.y !== end.y));
  }

  return { find };
})();

if (typeof module !== "undefined") module.exports = AutoPath;
