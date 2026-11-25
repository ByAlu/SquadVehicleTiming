"use strict";

const find = (id) => document.getElementById(id);
const sdk = window.squadSdkData;
const vehicles = window.squadVehicles;
const mapSelect = find("map-select");
const factionSelect = find("faction-select");
const vehicleSelect = find("vehicle-select");
const addVehicleButton = find("add-vehicle");
const autoPathButton = find("auto-path");
const removeAutoPathButton = find("remove-auto-path");
const autoPathStatus = find("auto-path-status");
const widthInput = find("width");
const heightInput = find("height");
const viewport = find("viewport");
const stage = find("stage");
const image = find("map-image");
const overlay = find("overlay");
const cursor = find("cursor");
const mapMessage = find("map-message");
const svgNamespace = "http://www.w3.org/2000/svg";
const numeric = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const vehicleColors = ["#e1fa91", "#85d9ff", "#ffc180", "#f0a7ef", "#91edc6", "#ffaaa8", "#bbc1ff", "#ffdf75"];

const route = [];
const edits = [];
const scales = new Map();
const speeds = new Map();
const configurations = new Map();
const drivingModels = new WeakMap();
const vehiclesByFaction = new Map();
const selectedVehicles = new Map();
const comparisons = new Map();
const routeEstimates = new Map();
const terrainEdges = new Map();
const collisionEdges = new Map();
const keyboardPoint = { x: 0.5, y: 0.5 };
let keyboardActive = false;
let mode = "draw";
let gesture = null;
let loadId = 0;
let zoom = 1;
let left = 0;
let mapTop = 0;
let drawnWidth = 0;
let drawnHeight = 0;
let terrainGrid = null;
let terrainStatus = "unavailable";
let collisionGrid = null;
let collisionStatus = "unavailable";
let selectedNode = null;

function selectMap() {
  finishGesture();
  const map = sdk.maps[mapSelect.selectedIndex];
  const request = ++loadId;
  terrainGrid = null;
  terrainStatus = map.sourceLayer ? "loading" : "unavailable";
  collisionGrid = null;
  collisionStatus = map.sourceLayer ? "loading" : "unavailable";
  clearRoute();
  const scale = scales.get(map.name) ?? [map.widthMeters ?? "", map.heightMeters ?? ""];
  [widthInput.value, heightInput.value] = scale;
  find("calibration").open = !map.widthMeters;
  find("map-heading").textContent = map.name;
  viewport.setAttribute("aria-label", `${map.name} route map`);
  updateMapDetail();
  updateEstimate();
  stage.classList.remove("ready");
  drawnWidth = 0;
  drawnHeight = 0;
  updateButtons();
  mapMessage.hidden = false;
  mapMessage.textContent = "Loading minimap…";
  const src = `maps/${encodeURIComponent(map.name)}/minimap.webp`;
  const incoming = new Image();
  incoming.onload = () => {
    if (request !== loadId) return;
    image.src = src;
    image.width = incoming.naturalWidth;
    image.height = incoming.naturalHeight;
    mapMessage.hidden = true;
    stage.classList.add("ready");
    fitMap();
  };
  incoming.onerror = () => {
    if (request === loadId) mapMessage.textContent = "The minimap image could not be loaded.";
  };
  incoming.src = src;
  if (map.sourceLayer) {
    Collision.load(map, window.squadWaterData?.[map.name]).then((grid) => {
      if (request !== loadId) return;
      collisionGrid = grid;
      collisionStatus = "ready";
      collisionEdges.clear();
      terrainEdges.clear();
      routeEstimates.clear();
      updateEstimate();
      updateButtons();
    }).catch(() => {
      if (request !== loadId) return;
      collisionStatus = "unavailable";
      updateEstimate();
      updateButtons();
    });
    Terrain.load(map).then((grid) => {
      if (request !== loadId) return;
      terrainGrid = grid;
      terrainStatus = "ready";
      collisionEdges.clear();
      routeEstimates.clear();
      updateEstimate();
      updateButtons();
    }).catch(() => {
      if (request !== loadId) return;
      terrainStatus = "unavailable";
      updateEstimate();
      updateButtons();
    });
  }
}

function updateMapDetail() {
  const map = sdk.maps[mapSelect.selectedIndex];
  const manual = scales.has(map.name);
  if (widthInput.validity.valid && heightInput.validity.valid && widthInput.value && heightInput.value) {
    find("map-detail").textContent = `${numeric.format(widthInput.valueAsNumber)} × ${numeric.format(heightInput.valueAsNumber)} m · ${manual ? "Custom scale" : map.scaleLabel}`;
  } else {
    find("map-detail").textContent = "Enter the minimap width and height to measure this route.";
  }
}

function selectFaction() {
  const faction = factionSelect.value;
  const indices = vehiclesByFaction.get(faction);
  const names = new Map();
  for (const index of indices) {
    const { name } = vehicles[index];
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  vehicleSelect.replaceChildren(...indices.map((index) => {
    const { name, type } = vehicles[index];
    const label = names.get(name) > 1 && type ? `${name} · ${type}` : name;
    return new Option(label, index);
  }));
  vehicleSelect.value = selectedVehicles.get(faction) ?? String(indices[0]);
  selectVehicle();
}

function selectVehicle() {
  selectedVehicles.set(factionSelect.value, vehicleSelect.value);
  const added = comparisons.has(Number(vehicleSelect.value));
  addVehicleButton.disabled = vehicleSelect.value === "" || added;
  addVehicleButton.textContent = added ? "Added" : "Add vehicle";
}

function nextVehicleColor() {
  const used = new Set([...comparisons.values()].map(({ color }) => color));
  let color;
  let index = 0;
  do {
    color = vehicleColors[index] ?? `hsl(${((index * 137.508) % 360).toFixed(2)} 85% 77%)`;
    index++;
  } while (used.has(color));
  return color;
}

function refreshVehicleEstimate(index) {
  for (const estimates of routeEstimates.values()) estimates.delete(index);
  updateEstimate();
  updateButtons();
}

function canAutoRoute({ ground, model, speed }) {
  return ground && (model || speed >= 0.1);
}

function addVehicle() {
  const vehicleIndex = Number(vehicleSelect.value);
  const vehicle = vehicles[vehicleIndex];
  if (vehicleSelect.value === "" || !vehicle || comparisons.has(vehicleIndex)) return;
  const card = find("vehicle-comparison-template").content.firstElementChild.cloneNode(true);
  const color = nextVehicleColor();
  const ground = vehicle.type !== "Helicopter" && vehicle.type !== "Boat";
  const comparison = { vehicle, color, ground, card, model: null, speed: NaN, tracked: false };
  card.style.setProperty("--vehicle-color", color);
  card.querySelector(".vehicle-name").textContent = vehicle.name;
  card.querySelector(".vehicle-detail").textContent = [vehicle.faction, vehicle.type].filter(Boolean).join(" · ");
  const remove = card.querySelector(".remove-vehicle");
  remove.setAttribute("aria-label", `Remove ${vehicle.name}, ${vehicle.faction}`);
  remove.addEventListener("click", () => {
    comparisons.delete(vehicleIndex);
    card.remove();
    selectVehicle();
    vehicleSelect.focus();
    refreshVehicleEstimate(vehicleIndex);
  });

  const configurationField = card.querySelector(".configuration-field");
  const configurationSelect = configurationField.querySelector("select");
  for (const [index, profile] of (vehicle.drivingProfiles ?? []).entries()) {
    if (!drivingModels.has(profile)) drivingModels.set(profile, Driving.prepare(profile));
    if (drivingModels.get(profile)) configurationSelect.add(new Option(profile.name, index));
  }
  configurationField.hidden = configurationSelect.options.length < 2;
  configurationSelect.setAttribute("aria-label", `${vehicle.name} configuration`);
  configurationSelect.value = configurations.get(vehicle.id) ?? configurationSelect.options[0]?.value ?? "";
  const speedField = card.querySelector(".vehicle-speed");
  const speedInput = speedField.querySelector("input");
  const speedLabel = ground ? "Average speed on firm, flat ground" : "Average route speed";
  speedField.querySelector(".vehicle-speed-label").textContent = speedLabel;
  speedInput.setAttribute("aria-label", `${vehicle.name} ${speedLabel.toLowerCase()} in km/h`);
  speedInput.value = speeds.get(vehicle.id) ?? vehicle.assumedSpeedKmh ?? "";
  comparison.speed = speedInput.validity.valid ? speedInput.valueAsNumber : NaN;
  speedInput.addEventListener("input", () => {
    speeds.set(vehicle.id, speedInput.value);
    comparison.speed = speedInput.validity.valid ? speedInput.valueAsNumber : NaN;
    refreshVehicleEstimate(vehicleIndex);
  });
  const applyConfiguration = () => {
    const profile = configurationSelect.value === "" ? null : vehicle.drivingProfiles[Number(configurationSelect.value)];
    comparison.model = profile ? drivingModels.get(profile) : null;
    comparison.tracked = profile?.tracked ?? (vehicle.type === "Tank" || /track/i.test(vehicle.type));
    speedField.hidden = Boolean(comparison.model);
    refreshVehicleEstimate(vehicleIndex);
  };
  configurationSelect.addEventListener("change", () => {
    configurations.set(vehicle.id, configurationSelect.value);
    applyConfiguration();
  });
  comparisons.set(vehicleIndex, comparison);
  find("vehicle-comparisons").append(card);
  selectVehicle();
  applyConfiguration();
}

function formatDistance(meters) {
  return meters >= 1000 ? `${numeric.format(meters / 1000)} km` : `${numeric.format(meters)} m`;
}

function pathTo(node) {
  const path = [];
  for (let current = node; current; current = current.parent) path.push(current);
  return path.reverse();
}

function edgePoints(node, via = []) {
  return [node.parent, ...via, node];
}

function geometryFor(path, index) {
  return path.flatMap((node) => [...(node.routes?.get(index) ?? []), node]);
}

function edgeCollision(node, via) {
  const key = via?.length ? via : node;
  if (!collisionEdges.has(key)) {
    const points = edgePoints(node, via);
    const water = Collision.waterGrid(terrainGrid, collisionGrid);
    const flooded = water && Collision.path(points, water) === "blocked";
    collisionEdges.set(key, flooded ? "water" : Collision.path(points, collisionGrid));
  }
  return collisionEdges.get(key);
}

function pathCollision(path, index) {
  let status = "clear";
  for (const node of path.slice(1)) {
    const edge = edgeCollision(node, node.routes?.get(index));
    if (edge === "water") return edge;
    if (edge === "blocked" || (edge === "unknown" && status === "clear")) status = edge;
  }
  return status;
}

function sampleTerrain(points, width, height) {
  const heights = Collision.elevations(collisionGrid);
  const ground = heights ? { grid: collisionGrid.grid, heights } : null;
  return Terrain.sampleRoute(points, width, height, terrainGrid, ground);
}

function samplePathTerrain(path, index, width, height) {
  const terrain = { pieces: [], sampledMeters: 0, classifiedMeters: 0, waterMeters: 0 };
  for (const node of path.slice(1)) {
    const via = node.routes?.get(index);
    const key = via?.length ? via : node;
    if (!terrainEdges.has(key)) {
      terrainEdges.set(key, sampleTerrain(edgePoints(node, via), width, height));
    }
    const edge = terrainEdges.get(key);
    terrain.pieces.push(...edge.pieces);
    terrain.sampledMeters += edge.sampledMeters;
    terrain.classifiedMeters += edge.classifiedMeters;
    terrain.waterMeters += edge.waterMeters;
  }
  return terrain;
}

function timeForConditions(model, speed, conditions) {
  return model ? Driving.travelTerrainSeconds(conditions, model) :
    conditions.reduce((time, piece) => time + RouteMath.travelSeconds(piece.distance, speed * piece.speedFactor), 0);
}

function estimatePath(node, width, height) {
  const estimates = routeEstimates.get(node) ?? new Map();
  const pending = [...comparisons].filter(([index]) => !estimates.has(index));
  if (!pending.length) return;
  const path = pathTo(node);
  for (const [index, { model, speed, ground, tracked }] of pending) {
    const distance = width >= 1 && height >= 1 ? RouteMath.routeLength(geometryFor(path, index), width, height) : 0;
    const collision = ground ? pathCollision(path, index) : null;
    const { pieces, ...coverage } = distance > 0 && terrainGrid && ground ? samplePathTerrain(path, index, width, height) : {};
    let seconds = null;
    if (distance > 0 && collision !== "blocked" && collision !== "water" && (model || speed >= 0.1)) {
      if (coverage.sampledMeters) {
        seconds = timeForConditions(model, speed, Terrain.drivingConditions(pieces, tracked));
      } else {
        seconds = model ? Driving.travelSeconds(distance, model) : RouteMath.travelSeconds(distance, speed);
      }
    }
    estimates.set(index, { distance, seconds, collision, terrain: pieces ? coverage : null });
  }
  routeEstimates.set(node, estimates);
}

function updateEstimate() {
  const width = widthInput.valueAsNumber;
  const height = heightInput.valueAsNumber;
  for (const node of route) estimatePath(node, width, height);
  const estimates = routeEstimates.get(selectedNode);
  const selectedNumber = route.indexOf(selectedNode) + 1;
  const estimatePathDetail = find("estimate-path");
  estimatePathDetail.hidden = !selectedNumber;
  estimatePathDetail.textContent = selectedNumber > 1 ? `Node 1 → Node ${selectedNumber}` : "Node 1";
  find("empty-vehicles").hidden = comparisons.size > 0;
  const checks = [];
  for (const [index, { card, vehicle, ground }] of comparisons) {
    const { distance, seconds, collision, terrain } = estimates?.get(index) ?? {};
    if (ground && selectedNode?.parent) checks.push(collision);
    const hasEstimate = seconds > 0 && Number.isFinite(seconds);
    const eta = collision === "water" ? "Blocked by water" : collision === "blocked" ? "Blocked" : selectedNumber === 1 ? "0s" :
      hasEstimate ? RouteMath.formatTime(seconds) : "—";
    const time = card.querySelector(".vehicle-time");
    time.textContent = eta;
    time.setAttribute("aria-label", `${vehicle.name} travel time ${eta}`);
    const average = card.querySelector(".vehicle-average");
    average.textContent = hasEstimate ? `${numeric.format(distance / seconds * 3.6)} km/h avg` : "";
    const distanceOutput = card.querySelector(".vehicle-distance");
    distanceOutput.textContent = collision !== "water" && distance > 0 ? formatDistance(distance) : "";
    const terrainDetail = card.querySelector(".vehicle-terrain");
    terrainDetail.hidden = !ground || !selectedNode?.parent || (!terrain && terrainStatus === "ready");
    if (terrain) {
      const percent = (meters) => Math.min(100, Math.round(meters / distance * 100));
      const water = collision !== "water" && !collisionGrid?.water && terrain.waterMeters > 0 ? " Water crossing speed is unverified." : "";
      terrainDetail.textContent = `Terrain ${percent(terrain.sampledMeters)}% sampled · ${percent(terrain.classifiedMeters)}% classified.${water}`;
    } else {
      terrainDetail.textContent = terrainStatus === "loading" ? "Loading terrain…" : "Terrain unavailable for this map.";
    }
  }
  const collision = checks.includes("water") ? "water" :
    checks.includes("blocked") ? "blocked" : checks.includes("unknown") ? "unknown" : "clear";
  const collisionDetail = find("collision-detail");
  collisionDetail.hidden = !checks.length;
  collisionDetail.dataset.status = collision === "water" ? "blocked" : collision;
  const collisionMessages = {
    clear: "No blockers detected in sampled collision cells.",
    blocked: "Vehicle collision detected on at least one selected path.",
    unknown: "Part of at least one selected path has no collision sample.",
    water: "Water blocks at least one selected ground route.",
  };
  collisionDetail.textContent = collisionGrid || collision === "water" ? collisionMessages[collision] ?? "" :
    collisionStatus === "loading" ? "Loading collision data…" : "Collision data unavailable for this map.";
  renderRoute();
  renderRouteLabels();
  find("route-node-list").replaceChildren(...route.map((node, index) => {
    const item = document.createElement("li");
    const parent = node.parent ? `, connected to node ${route.indexOf(node.parent) + 1}` : ", start";
    const selection = node === selectedNode ? ", selected" : "";
    const elapsed = [...comparisons].map(([vehicleIndex, { vehicle }]) =>
      `${vehicle.name} (${vehicle.faction}), ${nodeTimeLabel(node, vehicleIndex)} elapsed`);
    item.textContent = [`Node ${index + 1}${parent}${selection}`, ...elapsed].join(". ");
    return item;
  }));
}

function updateButtons() {
  find("undo").disabled = !edits.length;
  find("clear").disabled = !route.length;
  find("zoom-in").disabled = !drawnWidth || zoom >= 7;
  find("zoom-out").disabled = !drawnWidth || zoom <= 1;
  find("zoom-fit").disabled = !drawnWidth;
  const calibrated = widthInput.valueAsNumber >= 1 && heightInput.valueAsNumber >= 1;
  const eligible = [...comparisons.values()].some(canAutoRoute);
  autoPathButton.disabled = !selectedNode?.parent || !terrainGrid || collisionStatus === "loading" || !eligible || !calibrated;
  removeAutoPathButton.hidden = !selectedNode?.routes?.size;
  if (!selectedNode?.parent) autoPathStatus.textContent = "Select a child node to route from its parent.";
  else if (!terrainGrid) autoPathStatus.textContent = terrainStatus === "loading" ? "Loading terrain…" : "Auto-routing needs terrain data for this map.";
  else if (collisionStatus === "loading") autoPathStatus.textContent = "Loading collision data…";
  else if (!eligible) autoPathStatus.textContent = "Add a ground vehicle with a valid speed to auto-route.";
  else if (!calibrated) autoPathStatus.textContent = "Enter the map width and height to auto-route.";
  else autoPathStatus.textContent = "Find a route from the parent node for each selected ground vehicle.";
}

function forgetAutoRoutes(node) {
  for (const via of node.routes?.values() ?? []) {
    terrainEdges.delete(via);
    collisionEdges.delete(via);
  }
  routeEstimates.clear();
}

function setLinkRoutes(node, routes) {
  edits.push({ rerouted: node, routes: node.routes, selection: node });
  forgetAutoRoutes(node);
  node.routes = routes.size ? routes : undefined;
  routeChanged();
}

function autoRouteLink() {
  if (autoPathButton.disabled) return;
  const node = selectedNode;
  const width = widthInput.valueAsNumber;
  const height = heightInput.valueAsNumber;
  const endpoints = [node.parent, node];
  const water = Collision.waterGrid(terrainGrid, collisionGrid);
  const flooded = water && endpoints.find((point) => Collision.segment(point, point, water) === "blocked");
  if (flooded) {
    autoPathStatus.textContent = `Node ${route.indexOf(flooded) + 1} is in water. Place it on clear ground.`;
    return;
  }
  if (collisionGrid) {
    const unavailable = endpoints.findIndex((point) => Collision.segment(point, point, collisionGrid) !== "clear");
    if (unavailable >= 0) {
      const number = route.indexOf(endpoints[unavailable]) + 1;
      autoPathStatus.textContent = `Node ${number} is in a blocked or unsampled collision cell. Place it on clear ground.`;
      return;
    }
  }
  const routes = new Map(node.routes);
  const byDriveType = new Map();
  let routed = 0;
  let detours = 0;
  let failures = 0;
  let changed = false;
  for (const [index, comparison] of comparisons) {
    if (!canAutoRoute(comparison)) continue;
    const { tracked, model, speed } = comparison;
    if (!byDriveType.has(tracked)) {
      // Top speed scales every search cost equally. The full timing model below
      // can still prefer the straight link for an individual vehicle.
      const speedKmh = model ? model.samples.at(-1).speed * 3.6 : speed;
      const result = AutoPath.find(node.parent, node, terrainGrid, width, height, { tracked, speedKmh, collision: collisionGrid });
      const straight = result?.direct && result.via.length ? sampleTerrain(edgePoints(node), width, height).pieces : null;
      const detour = straight ? sampleTerrain(edgePoints(node, result.via), width, height).pieces : null;
      byDriveType.set(tracked, { result, straight, detour });
    }
    const { result, straight, detour } = byDriveType.get(tracked);
    if (!result) {
      failures++;
      continue;
    }
    let via = result.via;
    if (straight) {
      const travelTime = (pieces) => timeForConditions(model, speed, Terrain.drivingConditions(pieces, tracked));
      if (travelTime(straight) <= travelTime(detour)) via = [];
    }
    routed++;
    if (via.length) detours++;
    const previous = routes.get(index);
    if (!previous || previous.length !== via.length || previous.some(({ x, y }, point) => x !== via[point].x || y !== via[point].y)) {
      routes.set(index, via);
      changed = true;
    }
  }
  if (!routed) {
    autoPathStatus.textContent = "No route found through sampled terrain and collision cells. Try a different pair of nodes.";
    return;
  }
  if (changed) setLinkRoutes(node, routes);
  const failed = failures ? ` No route for ${failures}.` : "";
  autoPathStatus.textContent = `Routed ${routed} ground ${routed === 1 ? "vehicle" : "vehicles"}. ${detours} using a detour.${failed}`;
}

function removeAutoRoute() {
  if (!selectedNode?.routes?.size) return;
  setLinkRoutes(selectedNode, new Map());
  autoPathStatus.textContent = "Auto-routes removed.";
  const focusTarget = autoPathButton.disabled ? viewport : autoPathButton;
  focusTarget.focus({ preventScroll: true });
}

function mapLabel(x, y, label, className) {
  const text = document.createElementNS(svgNamespace, "text");
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.setAttribute("class", className);
  text.textContent = label;
  return text;
}

function nodeTimeLabel(node, vehicleIndex) {
  if (!node.parent) return "0s";
  const estimate = routeEstimates.get(node)?.get(vehicleIndex);
  if (estimate?.collision === "blocked" || estimate?.collision === "water") return "Blocked";
  const seconds = estimate?.seconds;
  return Number.isFinite(seconds) ? RouteMath.formatTime(seconds) : "—";
}

function renderRouteLabels() {
  const markers = document.createDocumentFragment();
  route.forEach((point, index) => {
    const x = point.x * drawnWidth;
    const y = point.y * drawnHeight;
    const marker = document.createElementNS(svgNamespace, "circle");
    marker.setAttribute("cx", x);
    marker.setAttribute("cy", y);
    marker.setAttribute("r", 11);
    if (point === selectedNode) marker.setAttribute("class", "selected-node");
    markers.append(marker, mapLabel(x, y, String(index + 1), "node-number"));
    const height = (comparisons.size - 1) * 15;
    const startY = Math.max(8, Math.min(y - height / 2, drawnHeight - height - 8));
    const labelOnLeft = x > drawnWidth - 86;
    let row = 0;
    for (const [vehicleIndex, { color }] of comparisons) {
      const elapsed = mapLabel(x + (labelOnLeft ? -15 : 15), startY + row * 15, nodeTimeLabel(point, vehicleIndex), "node-time");
      elapsed.setAttribute("text-anchor", labelOnLeft ? "end" : "start");
      elapsed.style.color = color;
      markers.append(elapsed);
      row++;
    }
  });
  find("markers").replaceChildren(markers);
}

function renderRoute() {
  const position = ({ x, y }) => `${x * drawnWidth},${y * drawnHeight}`;
  const pathData = (points) => points.map((point, index) => `${index ? "L" : "M"}${position(point)}`).join(" ");
  const selected = new Set(pathTo(selectedNode));
  const manual = [];
  const selectedManual = [];
  const shadow = new Set();
  const blocked = new Set();
  const automatic = document.createDocumentFragment();
  for (const node of route) {
    if (!node.parent) continue;
    const groups = new Map();
    const straight = pathData(edgePoints(node));
    const hasAutoRoute = [...comparisons.keys()].some((index) => node.routes?.has(index));
    let hasManual = !comparisons.size && edgeCollision(node) !== "water";
    for (const [index, { color, ground }] of comparisons) {
      const via = node.routes?.get(index);
      if (!via && hasAutoRoute) continue;
      const obstruction = ground ? edgeCollision(node, via) : null;
      if (obstruction === "water") continue;
      const d = via ? pathData(edgePoints(node, via)) : straight;
      if (via) {
        const group = groups.get(d) ?? [];
        group.push(color);
        groups.set(d, group);
      } else {
        hasManual = true;
      }
      if (obstruction === "blocked") blocked.add(d);
    }
    if (hasManual) {
      manual.push(straight);
      shadow.add(straight);
      if (selected.has(node)) selectedManual.push(straight);
    }
    for (const [d, colors] of groups) {
      shadow.add(d);
      const edge = document.createElementNS(svgNamespace, "path");
      edge.setAttribute("d", d);
      edge.setAttribute("class", selected.has(node) ? "vehicle-route selected-vehicle-route" : "vehicle-route");
      edge.style.color = colors.length === 1 ? colors[0] : "var(--accent)";
      automatic.append(edge);
    }
  }
  find("route-shadow").setAttribute("d", [...shadow].join(" "));
  find("route-line").setAttribute("d", manual.join(" "));
  find("selected-route").setAttribute("d", selectedManual.join(" "));
  find("vehicle-routes").replaceChildren(automatic);
  find("blocked-route").setAttribute("d", [...blocked].join(" "));
  cursor.setAttribute("cx", keyboardPoint.x * drawnWidth);
  cursor.setAttribute("cy", keyboardPoint.y * drawnHeight);
  cursor.setAttribute("visibility", keyboardActive ? "visible" : "hidden");
}

function routeChanged() {
  const number = route.indexOf(selectedNode) + 1;
  find("route-status").textContent = number ? `Node ${number} selected · ${route.length} ${route.length === 1 ? "node" : "nodes"}` : "Add node 1.";
  updateEstimate();
  updateButtons();
}

function clearRoute() {
  finishGesture();
  route.length = 0;
  selectedNode = null;
  edits.length = 0;
  routeEstimates.clear();
  terrainEdges.clear();
  collisionEdges.clear();
  routeChanged();
}

function undo() {
  finishGesture();
  if (!edits.length) return;
  const { index, removed, children, selection, rerouted, routes } = edits.pop();
  if (rerouted) {
    forgetAutoRoutes(rerouted);
    rerouted.routes = routes;
  } else if (removed) {
    route.splice(index, 0, removed);
    for (const child of children) {
      child.node.parent = removed;
      child.node.routes = child.routes;
    }
    routeEstimates.clear();
    terrainEdges.clear();
    collisionEdges.clear();
  } else {
    const [added] = route.splice(index, 1);
    routeEstimates.delete(added);
    terrainEdges.delete(added);
    collisionEdges.delete(added);
  }
  selectedNode = selection;
  routeChanged();
}

function positionMap() {
  const maxLeft = viewport.clientWidth - drawnWidth;
  const maxTop = viewport.clientHeight - drawnHeight;
  left = maxLeft > 0 ? maxLeft / 2 : Math.max(maxLeft, Math.min(left, 0));
  mapTop = maxTop > 0 ? maxTop / 2 : Math.max(maxTop, Math.min(mapTop, 0));
  stage.style.transform = `translate(${left}px, ${mapTop}px)`;
}

function layoutMap(nextZoom, anchorX, anchorY) {
  if (!stage.classList.contains("ready")) return;
  const x = drawnWidth ? (anchorX - left) / drawnWidth : 0.5;
  const y = drawnHeight ? (anchorY - mapTop) / drawnHeight : 0.5;
  const imageWidth = Number(image.getAttribute("width"));
  const imageHeight = Number(image.getAttribute("height"));
  const fit = Math.min(viewport.clientWidth / imageWidth, viewport.clientHeight / imageHeight);
  zoom = Math.max(1, Math.min(nextZoom, 7));
  drawnWidth = imageWidth * fit * zoom;
  drawnHeight = imageHeight * fit * zoom;
  left = anchorX - x * drawnWidth;
  mapTop = anchorY - y * drawnHeight;
  stage.style.width = `${drawnWidth}px`;
  stage.style.height = `${drawnHeight}px`;
  overlay.setAttribute("viewBox", `0 0 ${drawnWidth} ${drawnHeight}`);
  find("zoom-fit").textContent = `${Math.round(zoom * 100)}%`;
  positionMap();
  renderRoute();
  renderRouteLabels();
  updateButtons();
}

function centerZoom(level) {
  layoutMap(level, viewport.clientWidth / 2, viewport.clientHeight / 2);
}

function fitMap() {
  drawnWidth = 0;
  drawnHeight = 0;
  centerZoom(1);
}

function localPoint(event) {
  const bounds = viewport.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function mapPoint(point) {
  return { x: (point.x - left) / drawnWidth, y: (point.y - mapTop) / drawnHeight };
}

function inside({ x, y }) {
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

function nodeIndexAt(point) {
  let nearest = -1;
  let radius = 14;
  route.forEach((node, index) => {
    const distance = Math.hypot((node.x - point.x) * drawnWidth, (node.y - point.y) * drawnHeight);
    if (distance <= radius) {
      nearest = index;
      radius = distance;
    }
  });
  return nearest;
}

function selectOrAddNode(point) {
  const index = nodeIndexAt(point);
  if (index >= 0) {
    selectedNode = route[index];
  } else {
    edits.push({ index: route.length, selection: selectedNode });
    selectedNode = { ...point, parent: selectedNode };
    route.push(selectedNode);
  }
  routeChanged();
}

function removeNodeAt(point) {
  const nearest = nodeIndexAt(point);
  if (nearest < 0) return;
  const [removed] = route.splice(nearest, 1);
  const children = route.filter((node) => node.parent === removed);
  const parent = removed.parent ?? children[0] ?? null;
  edits.push({ index: nearest, removed, children: children.map((node) => ({ node, routes: node.routes })), selection: selectedNode });
  for (const child of children) {
    child.parent = child === parent ? null : parent;
    child.routes = undefined;
  }
  if (selectedNode === removed) selectedNode = parent;
  routeEstimates.clear();
  terrainEdges.clear();
  collisionEdges.clear();
  routeChanged();
}

function finishGesture() {
  if (!gesture) return;
  const { id } = gesture;
  gesture = null;
  if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
}

function setMode(nextMode) {
  finishGesture();
  mode = nextMode;
  find("draw").setAttribute("aria-pressed", mode === "draw");
  find("pan").setAttribute("aria-pressed", mode === "pan");
  viewport.classList.toggle("pan", mode === "pan");
}

viewport.addEventListener("pointerdown", (event) => {
  if (!drawnWidth || event.button !== 0 || gesture) return;
  const position = localPoint(event);
  const point = mapPoint(position);
  if (mode === "draw" && !inside(point)) return;
  viewport.focus({ preventScroll: true });
  keyboardActive = false;
  gesture = { id: event.pointerId, position, moved: false };
  viewport.setPointerCapture(event.pointerId);
  renderRoute();
});

viewport.addEventListener("pointermove", (event) => {
  if (gesture?.id !== event.pointerId) return;
  const position = localPoint(event);
  if (mode === "pan") {
    left += position.x - gesture.position.x;
    mapTop += position.y - gesture.position.y;
    gesture.position = position;
    positionMap();
  } else if (Math.hypot(position.x - gesture.position.x, position.y - gesture.position.y) > 5) {
    gesture.moved = true;
  }
});

for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  viewport.addEventListener(eventName, (event) => {
    if (gesture?.id !== event.pointerId) return;
    if (eventName === "pointerup" && mode === "draw" && !gesture.moved) {
      const position = localPoint(event);
      const point = mapPoint(position);
      if (inside(point) && Math.hypot(position.x - gesture.position.x, position.y - gesture.position.y) <= 5) {
        selectOrAddNode(point);
      }
    }
    finishGesture();
  });
}

viewport.addEventListener("contextmenu", (event) => {
  if (!drawnWidth || gesture || event.button !== 2) return;
  event.preventDefault();
  removeNodeAt(mapPoint(localPoint(event)));
});

viewport.addEventListener("wheel", (event) => {
  if (!drawnWidth || gesture || !event.deltaY || event.ctrlKey) return;
  event.preventDefault();
  const { x, y } = localPoint(event);
  layoutMap(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), x, y);
}, { passive: false });

viewport.addEventListener("keydown", (event) => {
  if (!drawnWidth || gesture) return;
  const directions = { ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0] };
  if (Object.hasOwn(directions, event.key)) {
    const [dx, dy] = directions[event.key];
    keyboardActive = true;
    keyboardPoint.x = Math.max(0, Math.min(1, keyboardPoint.x + dx * 12 / drawnWidth));
    keyboardPoint.y = Math.max(0, Math.min(1, keyboardPoint.y + dy * 12 / drawnHeight));
    const x = left + keyboardPoint.x * drawnWidth;
    const y = mapTop + keyboardPoint.y * drawnHeight;
    left += Math.max(10 - x, 0) + Math.min(viewport.clientWidth - 10 - x, 0);
    mapTop += Math.max(10 - y, 0) + Math.min(viewport.clientHeight - 10 - y, 0);
    positionMap();
    renderRoute();
  } else if ((event.key === "Enter" || event.key === " ") && mode === "draw") {
    keyboardActive = true;
    selectOrAddNode(keyboardPoint);
  } else if (event.key === "Delete" && keyboardActive) {
    removeNodeAt(keyboardPoint);
  } else if (event.key === "+" || event.key === "=") {
    centerZoom(zoom * 1.5);
  } else if (event.key === "-") {
    centerZoom(zoom / 1.5);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    undo();
  } else {
    return;
  }
  event.preventDefault();
});

viewport.addEventListener("blur", () => {
  keyboardActive = false;
  renderRoute();
});

if (sdk?.maps.length && vehicles?.length) {
  find("version").textContent = `SDK ${sdk.version}`;
  for (const map of sdk.maps) mapSelect.add(new Option(map.name, map.name));
  mapSelect.value = sdk.maps.some((map) => map.name === "Yehorivka") ? "Yehorivka" : sdk.maps[0].name;
  vehicles.forEach(({ faction }, index) => {
    if (!vehiclesByFaction.has(faction)) {
      vehiclesByFaction.set(faction, []);
      factionSelect.add(new Option(faction, faction));
    }
    vehiclesByFaction.get(faction).push(index);
  });
  mapSelect.addEventListener("change", selectMap);
  factionSelect.addEventListener("change", selectFaction);
  vehicleSelect.addEventListener("change", selectVehicle);
  addVehicleButton.addEventListener("click", addVehicle);
  autoPathButton.addEventListener("click", autoRouteLink);
  removeAutoPathButton.addEventListener("click", removeAutoRoute);
  for (const input of [widthInput, heightInput]) {
    input.addEventListener("input", () => {
      scales.set(mapSelect.value, [widthInput.value, heightInput.value]);
      routeEstimates.clear();
      terrainEdges.clear();
      updateMapDetail();
      updateEstimate();
      updateButtons();
    });
  }
  find("draw").addEventListener("click", () => setMode("draw"));
  find("pan").addEventListener("click", () => setMode("pan"));
  find("undo").addEventListener("click", undo);
  find("clear").addEventListener("click", clearRoute);
  find("zoom-out").addEventListener("click", () => centerZoom(zoom / 1.5));
  find("zoom-in").addEventListener("click", () => centerZoom(zoom * 1.5));
  find("zoom-fit").addEventListener("click", fitMap);
  new ResizeObserver(() => centerZoom(zoom)).observe(viewport);
  selectFaction();
  addVehicle();
  selectMap();
} else {
  for (const control of document.querySelectorAll("button, input, select")) control.disabled = true;
  find("map-heading").textContent = "Route map";
  mapMessage.hidden = false;
  mapMessage.textContent = "SDK data is missing. See the README to export it.";
}
