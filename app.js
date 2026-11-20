"use strict";

const find = (id) => document.getElementById(id);
const sdk = window.squadSdkData;
const vehicles = window.squadVehicles;
const mapSelect = find("map-select");
const factionSelect = find("faction-select");
const vehicleSelect = find("vehicle-select");
const configurationSelect = find("configuration");
const widthInput = find("width");
const heightInput = find("height");
const speedInput = find("speed");
const speedLabel = find("speed-label");
const speedField = speedInput.parentElement;
const viewport = find("viewport");
const stage = find("stage");
const image = find("map-image");
const overlay = find("overlay");
const cursor = find("cursor");
const mapMessage = find("map-message");
const svgNamespace = "http://www.w3.org/2000/svg";
const numeric = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const route = [];
const edits = [];
const scales = new Map();
const speeds = new Map();
const configurations = new Map();
const drivingModels = new WeakMap();
const vehiclesByFaction = new Map();
const selectedVehicles = new Map();
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
let activeDrivingModel = null;
let activeGroundVehicle = false;
let activeTrackedVehicle = false;
let terrainGrid = null;
let routeTerrain = null;
let terrainStatus = "unavailable";
let nodeTimes = [];
let legTimes = [];

function selectMap() {
  finishGesture();
  const map = sdk.maps[mapSelect.selectedIndex];
  const request = ++loadId;
  terrainGrid = null;
  terrainStatus = map.sourceLayer ? "loading" : "unavailable";
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
    Terrain.load(map).then((grid) => {
      if (request !== loadId) return;
      terrainGrid = grid;
      terrainStatus = "ready";
      updateEstimate();
    }).catch(() => {
      if (request !== loadId) return;
      terrainStatus = "unavailable";
      updateEstimate();
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
  const vehicle = vehicles[Number(vehicleSelect.value)];
  selectedVehicles.set(vehicle.faction, vehicleSelect.value);
  find("vehicle-detail").textContent = vehicle.type ?? "";
  configurationSelect.replaceChildren();
  for (const [index, profile] of (vehicle.drivingProfiles ?? []).entries()) {
    if (!drivingModels.has(profile)) drivingModels.set(profile, Driving.prepare(profile));
    if (drivingModels.get(profile)) configurationSelect.add(new Option(profile.name, index));
  }
  const hasChoices = configurationSelect.options.length > 1;
  configurationSelect.hidden = !hasChoices;
  find("configuration-label").hidden = !hasChoices;
  configurationSelect.value = configurations.get(vehicle.id) ?? configurationSelect.options[0]?.value ?? "";
  selectConfiguration();
}

function selectConfiguration() {
  const vehicle = vehicles[Number(vehicleSelect.value)];
  const profile = configurationSelect.value === "" ? null : vehicle.drivingProfiles[Number(configurationSelect.value)];
  activeDrivingModel = profile ? drivingModels.get(profile) : null;
  activeGroundVehicle = vehicle.type !== "Helicopter" && vehicle.type !== "Boat";
  activeTrackedVehicle = profile?.tracked ?? (vehicle.type === "Tank" || /track/i.test(vehicle.type));
  speedLabel.hidden = speedField.hidden = speedInput.disabled = Boolean(activeDrivingModel);
  speedLabel.textContent = activeGroundVehicle ? "Average speed on firm, flat ground" : "Average route speed";
  speedInput.value = activeDrivingModel ? "" : (speeds.get(vehicle.id) ?? vehicle.assumedSpeedKmh ?? "");
  find("speed-detail").textContent = activeDrivingModel
    ? "SDK driving profile. Starts and stops at rest."
    : "Average-speed estimate.";
  updateEstimate();
}

function formatDistance(meters) {
  return meters >= 1000 ? `${numeric.format(meters / 1000)} km` : `${numeric.format(meters)} m`;
}

function updateEstimate() {
  const width = widthInput.valueAsNumber;
  const height = heightInput.valueAsNumber;
  const speed = speedInput.valueAsNumber;
  const distances = width >= 1 && height >= 1 ? RouteMath.legDistances(route, width, height) : [];
  const distance = distances.reduce((total, meters) => total + meters, 0);
  const useTerrain = activeGroundVehicle && terrainGrid && distance > 0;
  if (useTerrain && !routeTerrain) routeTerrain = Terrain.sampleRoute(route, width, height, terrainGrid);
  const terrain = useTerrain ? routeTerrain : null;
  const conditions = terrain?.sampledMeters ? Terrain.drivingConditions(terrain.pieces, activeTrackedVehicle) : null;
  const hasSpeed = speedInput.validity.valid && speed >= 0.1;
  legTimes = [];
  if (distance > 0 && (activeDrivingModel || hasSpeed)) {
    if (conditions) {
      const pieceTimes = activeDrivingModel ? Driving.travelTerrainPieceSeconds(conditions, activeDrivingModel) :
        conditions.map((piece) => RouteMath.travelSeconds(piece.distance, speed * piece.speedFactor));
      legTimes = distances.map(() => 0);
      pieceTimes.forEach((seconds, index) => { legTimes[terrain.pieces[index].legIndex] += seconds; });
    } else {
      legTimes = activeDrivingModel ? Driving.travelLegSeconds(distances, activeDrivingModel) :
        distances.map((meters) => RouteMath.travelSeconds(meters, speed));
    }
  }
  nodeTimes = [0];
  for (const time of legTimes) nodeTimes.push(nodeTimes.at(-1) + time);
  const seconds = nodeTimes.at(-1);
  find("distance").textContent = distance > 0 ? formatDistance(distance) : "—";
  const hasEstimate = seconds > 0 && Number.isFinite(seconds);
  find("time").textContent = hasEstimate ? RouteMath.formatTime(seconds) : "—";
  find("average-speed").textContent = hasEstimate ? `${numeric.format(distance / seconds * 3.6)} km/h` : "—";

  const terrainDetail = find("terrain-detail");
  if (activeGroundVehicle && terrain) {
    const percent = (meters) => Math.min(100, Math.round(meters / distance * 100));
    const water = terrain.waterMeters > 0 ? " Water crossing speed is unverified." : "";
    terrainDetail.textContent = `Terrain ${percent(terrain.sampledMeters)}% sampled · ${percent(terrain.classifiedMeters)}% classified.${water}`;
  } else {
    terrainDetail.textContent = terrainStatus === "loading" ? "Loading terrain…" : "Terrain unavailable for this map.";
  }
  terrainDetail.hidden = !activeGroundVehicle || (!terrain && terrainStatus === "ready");
  renderRouteLabels();
  find("route-node-list").replaceChildren(...route.map((_, index) => {
    const item = document.createElement("li");
    const timing = index ? `, ${legTimeLabel(index - 1)} from node ${index}` : "";
    item.textContent = `Node ${index + 1}, ${nodeTimeLabel(index)} elapsed${timing}`;
    return item;
  }));
}

function updateButtons() {
  find("undo").disabled = !edits.length;
  find("clear").disabled = !route.length;
  find("zoom-in").disabled = !drawnWidth || zoom >= 7;
  find("zoom-out").disabled = !drawnWidth || zoom <= 1;
  find("zoom-fit").disabled = !drawnWidth;
}

function mapLabel(x, y, label, className) {
  const text = document.createElementNS(svgNamespace, "text");
  text.setAttribute("x", x);
  text.setAttribute("y", y);
  text.setAttribute("class", className);
  text.textContent = label;
  return text;
}

function nodeTimeLabel(index) {
  if (index === 0) return "0s";
  return Number.isFinite(nodeTimes[index]) ? RouteMath.formatTime(nodeTimes[index]) : "—";
}

function legTimeLabel(index) {
  return Number.isFinite(legTimes[index]) ? RouteMath.formatTime(legTimes[index]) : "—";
}

function renderRouteLabels() {
  const markers = document.createDocumentFragment();
  const timings = document.createDocumentFragment();
  route.forEach((point, index) => {
    const x = point.x * drawnWidth;
    const y = point.y * drawnHeight;
    const marker = document.createElementNS(svgNamespace, "circle");
    marker.setAttribute("cx", x);
    marker.setAttribute("cy", y);
    marker.setAttribute("r", 11);
    const labelOnLeft = x > drawnWidth - 86;
    const elapsed = mapLabel(x + (labelOnLeft ? -15 : 15), y, nodeTimeLabel(index), "node-time");
    elapsed.setAttribute("text-anchor", labelOnLeft ? "end" : "start");
    markers.append(marker, mapLabel(x, y, String(index + 1), "node-number"), elapsed);
    if (index) {
      const previous = route[index - 1];
      const midY = (previous.y + point.y) * drawnHeight / 2;
      timings.append(mapLabel((previous.x + point.x) * drawnWidth / 2,
        midY + (midY < 24 ? 13 : -13), legTimeLabel(index - 1), "leg-time"));
    }
  });
  find("markers").replaceChildren(markers);
  find("leg-times").replaceChildren(timings);
}

function renderRoute() {
  const points = route.map(({ x, y }) => `${x * drawnWidth},${y * drawnHeight}`).join(" ");
  find("route-shadow").setAttribute("points", points);
  find("route-line").setAttribute("points", points);
  cursor.setAttribute("cx", keyboardPoint.x * drawnWidth);
  cursor.setAttribute("cy", keyboardPoint.y * drawnHeight);
  cursor.setAttribute("visibility", keyboardActive ? "visible" : "hidden");
}

function routeChanged() {
  routeTerrain = null;
  find("route-status").textContent = route.length ? `${route.length} ${route.length === 1 ? "node" : "nodes"}` : "Add node 1.";
  renderRoute();
  updateEstimate();
  updateButtons();
}

function clearRoute() {
  finishGesture();
  route.length = 0;
  edits.length = 0;
  routeChanged();
}

function undo() {
  finishGesture();
  if (!edits.length) return;
  const { index, removed } = edits.pop();
  if (removed) route.splice(index, 0, removed);
  else route.splice(index, 1);
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

function appendPoint(point) {
  const previous = route.at(-1);
  if (previous && previous.x === point.x && previous.y === point.y) return;
  edits.push({ index: route.length });
  route.push(point);
  routeChanged();
}

function removeNodeAt(point) {
  let nearest = -1;
  let radius = 14;
  route.forEach((node, index) => {
    const distance = Math.hypot((node.x - point.x) * drawnWidth, (node.y - point.y) * drawnHeight);
    if (distance <= radius) {
      nearest = index;
      radius = distance;
    }
  });
  if (nearest < 0) return;
  const [removed] = route.splice(nearest, 1);
  edits.push({ index: nearest, removed });
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
        appendPoint(point);
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
  if (!drawnWidth || gesture || document.activeElement !== viewport || event.ctrlKey) return;
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
    appendPoint({ ...keyboardPoint });
    renderRoute();
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
  configurationSelect.addEventListener("change", () => {
    configurations.set(vehicles[Number(vehicleSelect.value)].id, configurationSelect.value);
    selectConfiguration();
  });
  for (const input of [widthInput, heightInput]) {
    input.addEventListener("input", () => {
      scales.set(mapSelect.value, [widthInput.value, heightInput.value]);
      routeTerrain = null;
      updateMapDetail();
      updateEstimate();
    });
  }
  speedInput.addEventListener("input", () => {
    speeds.set(vehicles[Number(vehicleSelect.value)].id, speedInput.value);
    updateEstimate();
  });
  find("draw").addEventListener("click", () => setMode("draw"));
  find("pan").addEventListener("click", () => setMode("pan"));
  find("undo").addEventListener("click", undo);
  find("clear").addEventListener("click", clearRoute);
  find("zoom-out").addEventListener("click", () => centerZoom(zoom / 1.5));
  find("zoom-in").addEventListener("click", () => centerZoom(zoom * 1.5));
  find("zoom-fit").addEventListener("click", fitMap);
  new ResizeObserver(() => centerZoom(zoom)).observe(viewport);
  selectFaction();
  selectMap();
} else {
  for (const control of document.querySelectorAll("button, input, select")) control.disabled = true;
  find("map-heading").textContent = "Route map";
  mapMessage.hidden = false;
  mapMessage.textContent = "SDK data is missing. See the README to export it.";
}
