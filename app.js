require([
  "esri/Map",
  "esri/views/MapView",
  "esri/Graphic",
  "esri/layers/GraphicsLayer"
], function (Map, MapView, Graphic, GraphicsLayer) {

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ── Organo Projects (static) ── */
  const ORGANO_PROJECTS = [
    { name: "Organo Antharam",       lat: 17.316, lon: 78.135, pincode: "501503", address: "Sy. No. 130–134, Antharam Chettampally Gate, Chevella, Telangana 501503",      area: "Chevella, Hyderabad" },
    { name: "Organo Naandi",         lat: 17.336, lon: 78.250, pincode: "500075", address: "Through Yenkapalli Village, Moinabad, Aziznagar, Hyderabad, Telangana 500075", area: "Moinabad / Aziznagar, Hyderabad" },
    { name: "Organo Damaragidda",    lat: 17.279, lon: 78.090, pincode: "501503", address: "8436+68R Damaragidda, Telangana 501503",                                       area: "Damaragidda, Chevella" },
    { name: "Organo Kandawada",      lat: 17.312, lon: 78.110, pincode: "501503", address: "Kandawada, Chevella, Telangana 501503",                                        area: "Kandawada, Chevella" },
    { name: "Organo Ibrahimpalle",   lat: 17.300, lon: 78.160, pincode: "501503", address: "Ibrahimpalle, Chevella Mandal, Telangana 501503",                              area: "Ibrahimpally / Chevella" },
    { name: "Organo Depalle",        lat: 16.648, lon: 78.115, pincode: "509202", address: "Balanagar, Depalle, Telangana 509202",                            area: "Depalle, Mahbubnagar" },
    { name: "Organo Aloor",          lat: 17.360, lon: 78.020, pincode: "501503", address: "Aloor / Kistapur side, Telangana 501503",                                     area: "Kistapur / Aloor region" },
    { name: "Organo Palgutta",       lat: 17.290, lon: 78.120, pincode: "501503", address: "Palgutta, Chevella region, Telangana 501503",                                 area: "Chevella region" },
    { name: "Organo Rurban Nest",    lat: 18.672, lon: 78.094, pincode: "503230",        address: "Delivered project",                                                           area: "Nizamabad" },
    { name: "Organo Rurban Lofts",   lat: 17.310, lon: 78.130, pincode: "501503", address: "828G+2V, Angadichittampalle, Beside Antharam, Chevella, Telangana 501503",    area: "Angadichittampalle / Antharam region, Chevella, Hyderabad" }
  ];

  /* ── Constants ── */
  const CATEGORIES = [
    { key: "schools",   label: "School",       color: "#00e5ff", amenity: '"amenity"="school"' },
    { key: "colleges",  label: "College",      color: "#b388ff", amenity: '"amenity"~"college|university"' },
    { key: "hospitals", label: "Hospital",     color: "#ff5252", amenity: '"amenity"="hospital"' },
    { key: "nursing",   label: "Nursing Home", color: "#ff9100", amenity: '"amenity"="nursing_home"' },
    { key: "cinemas",   label: "Cinema",       color: "#ff40ff", amenity: '"amenity"="cinema"' }
  ];

  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  const GEOCODE_URL  = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

  /* ── Map & View ── */
  const map  = new Map({ basemap: "dark-gray-vector" });
  const view = new MapView({
    container: "viewDiv",
    map,
    center: [78.9629, 20.5937],
    zoom: 5
  });

  /* ── Layers ── */
  const circleLayer    = new GraphicsLayer({ id: "circle" });
  const referenceLayer = new GraphicsLayer({ id: "reference" });
  const pinLayer       = new GraphicsLayer({ id: "pin" });
  map.add(circleLayer, 0);
  map.add(referenceLayer);

  const catLayers = {};
  CATEGORIES.forEach(cat => {
    const layer = new GraphicsLayer({ id: cat.key, title: cat.label });
    catLayers[cat.key] = layer;
    map.add(layer);
  });

  const organoLayer = new GraphicsLayer({ id: "organo", title: "Organo Projects" });
  catLayers["organo"] = organoLayer;
  map.add(organoLayer);

  map.add(pinLayer);

  /* ── State ── */
  let abortCtrl     = null;
  let allFacilities      = [];
  let renderedFacilities = [];
  let searchCenter       = null;
  let filterQuery   = "";
  const visibleCats = new Set(CATEGORIES.map(c => c.key));

  /* ── DOM refs ── */
  const searchInput    = document.getElementById("search-input");
  const radiusSlider   = document.getElementById("radius-slider");
  const radiusInput    = document.getElementById("radius-input");
  const facilityFilter = document.getElementById("facility-filter");
  const filterClear    = document.getElementById("filter-clear");

  function setRadius(val) {
    val = Math.min(20, Math.max(1, Math.round(val) || 1));
    radiusSlider.value = val;
    radiusInput.value  = val;
    return val;
  }

  /* ── Listeners ── */
  document.getElementById("search-btn").addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });

  const debouncedSearch = debounce((lat, lon, r) => runSearch(lat, lon, r), 400);

  radiusSlider.addEventListener("input", () => {
    const val = setRadius(+radiusSlider.value);
    if (searchCenter) debouncedSearch(searchCenter.lat, searchCenter.lon, val);
  });

  radiusInput.addEventListener("change", () => {
    const val = setRadius(+radiusInput.value);
    if (searchCenter) runSearch(searchCenter.lat, searchCenter.lon, val);
  });

  document.getElementById("export-btn").addEventListener("click", exportExcel);

  facilityFilter.addEventListener("input", () => {
    filterQuery = facilityFilter.value.trim().toLowerCase();
    filterClear.style.display = filterQuery ? "flex" : "none";
    renderList(allFacilities);
  });

  filterClear.addEventListener("click", () => {
    facilityFilter.value = "";
    filterQuery = "";
    filterClear.style.display = "none";
    facilityFilter.focus();
    renderList(allFacilities);
  });

  /* ── Facility list — delegated events (one listener per gesture, not one per item per search) ── */
  const facilityListEl = document.getElementById("facility-list");
  let lastHoveredItem = null;

  facilityListEl.addEventListener("click", e => {
    const item = e.target.closest(".facility-item");
    if (!item) return;
    const f = renderedFacilities[+item.dataset.index];
    if (!f) return;
    view.goTo({ center: [f.lon, f.lat], zoom: 17 });
    view.popup.open({ title: f.name, content: buildPopupContent(f),
      location: { type: "point", latitude: f.lat, longitude: f.lon } });
  });

  facilityListEl.addEventListener("mouseover", e => {
    const item = e.target.closest(".facility-item");
    if (!item || item === lastHoveredItem) return;
    lastHoveredItem = item;
    const f = renderedFacilities[+item.dataset.index];
    if (!f) return;
    view.popup.open({ title: f.name, content: buildPopupContent(f),
      location: { type: "point", latitude: f.lat, longitude: f.lon } });
    view.goTo({ center: [f.lon, f.lat] }, { duration: 350, easing: "ease-in-out" });
  });

  facilityListEl.addEventListener("mouseleave", () => { lastHoveredItem = null; });

  document.querySelectorAll(".toggle input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      const layer = catLayers[cb.dataset.cat];
      if (layer) layer.visible = cb.checked;
      cb.checked ? visibleCats.add(cb.dataset.cat) : visibleCats.delete(cb.dataset.cat);
      renderList(allFacilities);
      updateStats(allFacilities);
    });
  });

  view.on("click", async e => {
    if (e.native?.target?.closest(".esri-popup")) return; // let popup handle its own clicks
    const hit = await view.hitTest(e, { include: Object.values(catLayers) });
    if (hit.results.length > 0) return;
    const { latitude: lat, longitude: lon } = e.mapPoint;
    searchCenter = { lat, lon };
    searchInput.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    runSearch(lat, lon, +radiusSlider.value);
  });

  // Show popup on hover over map dots; never auto-close (user closes with ✕ or a new search clears it)
  let hoverTimer = null;
  view.on("pointer-move", e => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      view.hitTest(e, { include: Object.values(catLayers) }).then(({ results }) => {
        const hit = results[0];
        if (hit?.graphic?.attributes?.name) {
          view.popup.open({ features: [hit.graphic], location: hit.graphic.geometry });
          view.container.style.cursor = "pointer";
        } else {
          view.container.style.cursor = "default";
        }
      });
    }, 150);
  });

  /* ── Geocode ── */
  async function doSearch() {
    const query = searchInput.value.trim();
    if (!query) return;
    showSpinner("Geocoding location…");
    try {
      const loc = await geocodeLocation(query);
      searchCenter = loc;
      await runSearch(loc.lat, loc.lon, +radiusSlider.value);
    } catch (err) {
      hideSpinner();
      showToast("Could not find location: " + err.message, true);
    }
  }

  async function geocodeLocation(query) {
    const params = new URLSearchParams({
      SingleLine: query,
      outFields:  "Match_addr",
      f:          "json",
      maxLocations: 1,
      countryCode: "IND"
    });
    const res  = await fetch(`${GEOCODE_URL}?${params}`);
    if (!res.ok) throw new Error("Geocode request failed");
    const data = await res.json();
    if (!data.candidates?.length) throw new Error("No results found");
    const c = data.candidates[0];
    return { lat: c.location.y, lon: c.location.x, label: c.attributes.Match_addr };
  }

  /* ── Main search ── */
  async function runSearch(lat, lon, radiusKm) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const { signal } = abortCtrl;

    filterQuery = "";
    facilityFilter.value = "";
    filterClear.style.display = "none";
    view.popup.close();

    showSpinner("Fetching facilities…");
    referenceLayer.removeAll();
    drawCircleAndPin(lat, lon, radiusKm);
    updateNearestOrgano(lat, lon);
    view.goTo({ center: [lon, lat], zoom: Math.max(10, 15 - Math.floor(radiusKm / 3)) });

    try {
      const settled = await Promise.allSettled(
        CATEGORIES.map((cat, i) =>
          new Promise(res => setTimeout(res, i * 300))
            .then(() => signal.aborted ? Promise.reject(Object.assign(new Error, { name: "AbortError" })) : fetchWithRetry(cat, lat, lon, radiusKm, signal))
        )
      );
      if (signal.aborted) return;

      const failed = [];
      allFacilities = settled.flatMap((r, i) => {
        if (r.status === "rejected") {
          if (r.reason?.name !== "AbortError") {
            failed.push(CATEGORIES[i].label);
            console.error(`[${CATEGORIES[i].label}]`, r.reason?.message);
          }
          return [];
        }
        return r.value;
      });

      const warnEl = document.getElementById("search-warn");
      if (warnEl) warnEl.textContent = failed.length
        ? `⚠ Could not load: ${failed.join(", ")}`
        : "";

      renderMap(allFacilities);
      renderList(allFacilities);
      updateStats(allFacilities);
    } catch (err) {
      if (err.name !== "AbortError") console.error(err);
    } finally {
      if (!signal.aborted) hideSpinner();
    }
  }

  // Retry wrapper — up to 3 retries with 1000 ms / 2000 ms / 3000 ms backoff
  async function fetchWithRetry(cat, lat, lon, radiusKm, signal, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchCategory(cat, lat, lon, radiusKm, signal);
      } catch (err) {
        if (err.name === "AbortError" || attempt === retries) throw err;
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  /* ── Overpass fetch (one category) ── */
  async function fetchCategory(cat, lat, lon, radiusKm, signal) {
    const r = radiusKm * 1000;
    const q = `[out:json][timeout:60];
(
  node[${cat.amenity}](around:${r},${lat},${lon});
  way[${cat.amenity}](around:${r},${lat},${lon});
  relation[${cat.amenity}](around:${r},${lat},${lon});
);
out center tags;`;

    const fetchSig = AbortSignal.any
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : signal;
    const res = await fetch(OVERPASS_URL, { method: "POST", body: q, signal: fetchSig });
    if (!res.ok) throw new Error(`Overpass error for ${cat.key}`);
    let data;
    try { data = await res.json(); }
    catch { throw new Error(`Bad response from Overpass for ${cat.key}`); }

    return (data.elements || []).flatMap(el => {
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) return [];
      const tags    = el.tags || {};
      const name    = tags.name || tags["name:en"] || `Unnamed ${cat.label}`;
      const address = buildAddress(tags);
      const dist    = haversine(lat, lon, elLat, elLon);
      const board   = cat.key === "schools" ? detectBoard(tags, name) : null;
      const nearest = ORGANO_PROJECTS.reduce((best, p) => {
        const d = haversine(elLat, elLon, p.lat, p.lon);
        return d < best._dist ? { ...p, _dist: d } : best;
      }, { _dist: Infinity });
      const organoPin   = nearest.pincode || "";
      const organoGroup = nearest.name
        ? (organoPin
            ? ORGANO_PROJECTS.filter(p => p.pincode === organoPin)
                .map(p => ({ name: p.name, dist: haversine(elLat, elLon, p.lat, p.lon) }))
                .sort((a, b) => a.dist - b.dist)
            : [{ name: nearest.name, dist: nearest._dist }])
        : [];
      return [{ id: el.id, cat: cat.key, label: cat.label, color: cat.color, name, address, lat: elLat, lon: elLon, dist, board, organoPin, organoGroup }];
    });
  }

  function buildAddress(tags) {
    const t = tags;
    const parts = [
      t["addr:housenumber"] || t["addr:flats"],
      t["addr:street"] || t["addr:place"],
      t["addr:suburb"] || t["addr:quarter"] || t["addr:neighbourhood"] || t["addr:locality"],
      t["addr:city"] || t["addr:town"] || t["addr:village"] || t["addr:hamlet"],
      t["addr:district"],
      t["addr:state"],
      t["addr:postcode"]
    ].filter(Boolean);
    if (parts.length) return parts.join(", ");
    return t.address || t["contact:address"] || t.note || "";
  }

  /* ── Haversine ── */
  function haversine(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2 +
                 Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                 Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ── School board detection ── */
  function detectBoard(tags, name) {
    const haystack = [
      tags["school:board"], tags.operator, tags.brand, tags["name:en"], name
    ].filter(Boolean).join(" ").toLowerCase();

    if (/\bicse\b|cisce/.test(haystack))              return "ICSE";
    if (/\bcbse\b|central board/.test(haystack))       return "CBSE";
    if (/\bib\b|international baccalaureate/.test(haystack)) return "IB";
    return "State";
  }

  /* ── Map rendering ── */
  function drawCircleAndPin(lat, lon, radiusKm) {
    circleLayer.removeAll();
    pinLayer.removeAll();

    const degPerKm = 1 / 111;
    const latR     = radiusKm * degPerKm;
    const lonR     = radiusKm * degPerKm / Math.cos(lat * Math.PI / 180);
    const ring     = [];
    for (let i = 0; i <= 360; i++) {
      const a = i * Math.PI / 180;
      ring.push([lon + lonR * Math.cos(a), lat + latR * Math.sin(a)]);
    }

    circleLayer.add(new Graphic({
      geometry: { type: "polygon", rings: [ring], spatialReference: { wkid: 4326 } },
      symbol: {
        type: "simple-fill",
        color: [255, 255, 255, 0.05],
        outline: { color: [255, 255, 255, 0.35], width: 1.5 }
      }
    }));

    pinLayer.add(new Graphic({
      geometry: { type: "point", longitude: lon, latitude: lat },
      symbol: {
        type: "simple-marker",
        style: "cross",
        color: [255, 255, 255, 1],
        size: 18,
        outline: { color: [255, 255, 255, 1], width: 2.5 }
      }
    }));
  }

  function renderMap(facilities) {
    CATEGORIES.forEach(cat => catLayers[cat.key].removeAll());

    facilities.forEach(f => {
      catLayers[f.cat].add(new Graphic({
        geometry: { type: "point", longitude: f.lon, latitude: f.lat },
        symbol: {
          type: "simple-marker",
          style: "circle",
          color: f.color,
          size: 8,
          outline: { color: [0, 0, 0, 0.45], width: 1 }
        },
        attributes: f,
        popupTemplate: {
          title: "{name}",
          content: buildPopupContent(f)
        }
      }));
    });
  }

  function buildPopupContent(f) {
    let html = `<div class="popup-body"><span class="popup-cat" style="color:${f.color}">${f.label}</span>`;
    if (f.address) html += `<p>${escHtml(f.address)}</p>`;
    html += `<p>Distance: <strong>${f.dist.toFixed(2)} km</strong></p>`;
    if (f.organoGroup?.length) {
      if (f.organoGroup.length === 1) {
        html += `<p>Nearest Organo: <strong>${escHtml(f.organoGroup[0].name)}</strong> (${f.organoGroup[0].dist.toFixed(2)} km)</p>`;
      } else {
        html += `<p>Organo Projects nearby${f.organoPin ? ` (PIN: ${escHtml(f.organoPin)})` : ""}:</p><ul style="margin:4px 0 0 0;padding-left:16px">`;
        f.organoGroup.forEach(o => { html += `<li><strong>${escHtml(o.name)}</strong> &mdash; ${o.dist.toFixed(2)} km</li>`; });
        html += `</ul>`;
      }
    }
    if (f.board) html += `<p>Board: <strong>${f.board}</strong></p>`;
    return html + `</div>`;
  }

  /* ── Sidebar list ── */
  function renderList(facilities) {
    let visible = [...facilities].filter(f => visibleCats.has(f.cat));
    if (filterQuery) {
      visible = visible.filter(f =>
        f.name.toLowerCase().includes(filterQuery) ||
        f.address.toLowerCase().includes(filterQuery)
      );
    }
    const sorted    = visible.sort((a, b) => a.dist - b.dist);
    renderedFacilities  = sorted;
    const container = document.getElementById("facility-list");
    document.getElementById("list-total").textContent = `(${sorted.length})`;

    if (sorted.length === 0) {
      let msg;
      if (filterQuery)             msg = `No facilities match &ldquo;${escHtml(filterQuery)}&rdquo;`;
      else if (allFacilities.length) msg = "No facilities visible — try enabling more layers.";
      else                          msg = "No facilities found in this area. Try increasing the radius or searching a larger nearby town.";
      container.innerHTML = `<div class="no-results">${msg}</div>`;
      return;
    }

    container.innerHTML = sorted.map((f, i) => {
      const badge = f.board
        ? `<span class="board-badge board-${f.board.toLowerCase()}">${f.board}</span>`
        : "";
      return `<div class="facility-item" style="--item-color:${f.color}" data-index="${i}">
        <div class="fi-top">
          <span class="fi-name">${escHtml(f.name)}</span>
          ${badge}
        </div>
        <div class="fi-meta">
          <span class="fi-cat" style="color:${f.color}">${f.label}</span>
          <span class="fi-dist">${f.dist.toFixed(2)} km</span>
        </div>
        ${f.address ? `<div class="fi-addr">${escHtml(f.address)}</div>` : ""}
        ${f.organoGroup?.length
          ? `<div class="fi-organo"><span class="fi-organo-dot"></span>${
              f.organoGroup.length === 1
                ? `${escHtml(f.organoGroup[0].name)} &nbsp;&middot;&nbsp; ${f.organoGroup[0].dist.toFixed(2)} km`
                : `${f.organoGroup.length} Organo projects &nbsp;&middot;&nbsp; PIN ${escHtml(f.organoPin)}`
            }</div>`
          : ""}
      </div>`;
    }).join("");
  }

  /* ── Nearest Organo reference ── */
  function updateNearestOrgano(lat, lon) {
    const nearest = ORGANO_PROJECTS.reduce((best, p) => {
      const d = haversine(lat, lon, p.lat, p.lon);
      return d < best._dist ? { ...p, _dist: d } : best;
    }, { _dist: Infinity });
    if (!nearest.name) return;

    const pin   = nearest.pincode || "";
    const group = pin
      ? ORGANO_PROJECTS
          .filter(p => p.pincode === pin)
          .map(p => ({ ...p, _dist: haversine(lat, lon, p.lat, p.lon) }))
          .sort((a, b) => a._dist - b._dist)
      : [{ ...nearest }];

    document.getElementById("nop-label").textContent =
      group.length > 1 ? `Organo Projects · PIN ${pin}` : "Nearest Organo Project";

    const list = document.getElementById("nop-list");
    list.innerHTML = group.map((p, i) =>
      `<div class="nop-item" data-idx="${i}">
        <span class="nop-name">${escHtml(p.name)}</span>
        <span class="nop-dist">${p._dist.toFixed(2)} km away · ${escHtml(p.area)}</span>
      </div>`
    ).join("");

    list.querySelectorAll(".nop-item").forEach(el => {
      const p = group[+el.dataset.idx];
      el.addEventListener("click", () => {
        view.goTo({ center: [p.lon, p.lat], zoom: 15 });
        view.popup.open({
          title: p.name,
          content: buildOrganoPopupContent(p),
          location: { type: "point", latitude: p.lat, longitude: p.lon }
        });
      });
    });

    document.getElementById("nearest-organo").classList.remove("hidden");

    group.forEach(p => {
      referenceLayer.add(new Graphic({
        geometry: {
          type: "polyline",
          paths: [[[lon, lat], [p.lon, p.lat]]],
          spatialReference: { wkid: 4326 }
        },
        symbol: { type: "simple-line", color: [255, 213, 79, 0.75], width: 1.5, style: "dash" }
      }));
      referenceLayer.add(new Graphic({
        geometry: { type: "point", longitude: p.lon, latitude: p.lat },
        symbol: {
          type: "simple-marker",
          style: "diamond",
          color: [255, 213, 79, 0],
          size: 22,
          outline: { color: [255, 213, 79, 0.9], width: 2 }
        }
      }));
    });
  }

  /* ── Organo Projects ── */
  function renderOrganoProjects() {
    ORGANO_PROJECTS.forEach(p => {
      organoLayer.add(new Graphic({
        geometry: { type: "point", longitude: p.lon, latitude: p.lat },
        symbol: {
          type: "simple-marker",
          style: "diamond",
          color: "#ffd54f",
          size: 14,
          outline: { color: [0, 0, 0, 0.6], width: 1.5 }
        },
        attributes: { ...p, isOrgano: true },
        popupTemplate: { title: p.name, content: buildOrganoPopupContent(p) }
      }));
    });
  }

  function buildOrganoPopupContent(p) {
    let html = `<div class="popup-body"><span class="popup-cat" style="color:#ffd54f">Organo Project</span>`;
    html += `<p>${escHtml(p.area)}</p>`;
    if (p.address) html += `<p>${escHtml(p.address)}</p>`;
    if (p.pincode) html += `<p>Pincode: <strong>${escHtml(p.pincode)}</strong></p>`;
    return html + `</div>`;
  }

  function renderOrganoList() {
    const container = document.getElementById("organo-list");
    document.getElementById("organo-total").textContent = `(${ORGANO_PROJECTS.length})`;
    container.innerHTML = ORGANO_PROJECTS.map((p, i) =>
      `<div class="organo-item" data-index="${i}">
        <div class="oi-name">${escHtml(p.name)}</div>
        <div class="oi-area">${escHtml(p.area)}</div>
        ${p.pincode ? `<div class="oi-pin">PIN: ${escHtml(p.pincode)}</div>` : ""}
      </div>`
    ).join("");

    container.addEventListener("click", e => {
      const item = e.target.closest(".organo-item");
      if (!item) return;
      const p = ORGANO_PROJECTS[+item.dataset.index];
      if (!p) return;
      view.goTo({ center: [p.lon, p.lat], zoom: 15 });
      view.popup.open({
        title: p.name,
        content: buildOrganoPopupContent(p),
        location: { type: "point", latitude: p.lat, longitude: p.lon }
      });
    });
  }

  renderOrganoProjects();
  renderOrganoList();

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── Stats ── */
  function updateStats(facilities) {
    CATEGORIES.forEach(cat => {
      const el   = document.getElementById(`stat-${cat.key}`);
      const card = el?.closest(".stat-card");
      const on   = visibleCats.has(cat.key);
      if (el)   el.textContent  = on ? facilities.filter(f => f.cat === cat.key).length : "—";
      if (card) card.style.opacity = on ? "1" : "0.35";
    });
  }

  /* ── Excel export ── */
  function exportExcel() {
    if (!allFacilities.length) { showToast("No facilities to export.", true); return; }
    if (typeof XLSX === "undefined") { showToast("Excel library failed to load — please refresh.", true); return; }

    // restore last selection from sessionStorage, default all-checked on first use
    const saved = storageGet("exportCats");
    const boxes = [...document.querySelectorAll("[data-export-cat]")];
    boxes.forEach(cb => { cb.checked = saved ? saved.includes(cb.dataset.exportCat) : true; });

    const checkedCount = boxes.filter(b => b.checked).length;
    const master = document.getElementById("export-all");
    master.checked       = checkedCount === boxes.length;
    master.indeterminate = checkedCount > 0 && checkedCount < boxes.length;

    document.getElementById("export-modal").classList.remove("hidden");
  }

  // "All" master checkbox
  document.getElementById("export-all").addEventListener("change", e => {
    document.querySelectorAll("[data-export-cat]").forEach(cb => { cb.checked = e.target.checked; });
  });

  // individual category checkboxes → sync master
  document.querySelectorAll("[data-export-cat]").forEach(cb => {
    cb.addEventListener("change", () => {
      const boxes   = [...document.querySelectorAll("[data-export-cat]")];
      const checked = boxes.filter(b => b.checked).length;
      const master  = document.getElementById("export-all");
      master.checked       = checked === boxes.length;
      master.indeterminate = checked > 0 && checked < boxes.length;
    });
  });

  document.getElementById("export-cancel").addEventListener("click", () => {
    document.getElementById("export-modal").classList.add("hidden");
  });

  document.getElementById("export-confirm").addEventListener("click", () => {
    const selected = new Set(
      [...document.querySelectorAll("[data-export-cat]:checked")].map(cb => cb.dataset.exportCat)
    );
    if (!selected.size) { showToast("Select at least one category.", true); return; }

    const rows = [...allFacilities]
      .filter(f => selected.has(f.cat))
      .sort((a, b) => a.dist - b.dist)
      .map(f => ({
        Name:                          f.name,
        Category:                      f.label,
        Address:                       f.address || "",
        Board:                         f.board || "",
        "Nearest Organo Project":      f.organoGroup?.[0]?.name || "",
        "Dist to Nearest Organo (km)": f.organoGroup?.[0] ? f.organoGroup[0].dist.toFixed(2) : "",
        "All Same-PIN Organo Projects": f.organoGroup?.length > 1
          ? f.organoGroup.map(o => `${o.name} (${o.dist.toFixed(2)} km)`).join("; ")
          : ""
      }));

    storageSet("exportCats", [...selected]);

    const now  = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 8).replace(/:/g, "-");

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Facilities");
    XLSX.writeFile(wb, `facilities_${date}_${time}.xlsx`);
    document.getElementById("export-modal").classList.add("hidden");
  });

  /* ── Spinner ── */
  function showSpinner(msg) {
    document.getElementById("spinner-msg").textContent = msg || "Loading…";
    document.getElementById("spinner-overlay").classList.remove("hidden");
  }

  function hideSpinner() {
    document.getElementById("spinner-overlay").classList.add("hidden");
  }

  /* ── Toast ── */
  function showToast(msg, isError = false) {
    const el = document.getElementById("toast");
    if (!el) return;
    clearTimeout(el._timer);
    el.textContent = msg;
    el.className = "toast toast-visible" + (isError ? " toast-error" : "");
    el._timer = setTimeout(() => { el.className = "toast"; }, 4500);
  }

  /* ── sessionStorage wrappers (safe in private/incognito mode) ── */
  function storageGet(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; }
  }
  function storageSet(key, val) {
    try { sessionStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode or quota exceeded */ }
  }
});
