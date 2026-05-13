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

  /* ── Constants ── */
  const CATEGORIES = [
    { key: "schools",   label: "School",       color: "#00e5ff", amenity: '"amenity"="school"' },
    { key: "colleges",  label: "College",      color: "#b388ff", amenity: '"amenity"~"college|university"' },
    { key: "hospitals", label: "Hospital",     color: "#ff5252", amenity: '"amenity"="hospital"' },
    { key: "nursing",   label: "Nursing Home", color: "#ff9100", amenity: '"amenity"="nursing_home"' },
    { key: "cinemas",   label: "Cinema",       color: "#ff40ff", amenity: '"amenity"="cinema"' }
  ];

  const OVERPASS_URL  = "https://overpass-api.de/api/interpreter";
  const GEOCODE_URL   = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

  /* ── Map & View ── */
  const map  = new Map({ basemap: "dark-gray-vector" });
  const view = new MapView({
    container: "viewDiv",
    map,
    center: [78.9629, 20.5937],
    zoom: 5
  });

  /* ── Layers ── */
  const circleLayer = new GraphicsLayer({ id: "circle" });
  const pinLayer    = new GraphicsLayer({ id: "pin" });
  map.add(circleLayer, 0);

  const catLayers = {};
  CATEGORIES.forEach(cat => {
    const layer = new GraphicsLayer({ id: cat.key, title: cat.label });
    catLayers[cat.key] = layer;
    map.add(layer);
  });

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
    drawCircleAndPin(lat, lon, radiusKm);
    view.goTo({ center: [lon, lat], zoom: Math.max(10, 15 - Math.floor(radiusKm / 3)) });

    try {
      const settled = await Promise.allSettled(
        CATEGORIES.map(cat => fetchWithRetry(cat, lat, lon, radiusKm, signal))
      );
      if (signal.aborted) return;

      const failed = [];
      allFacilities = settled.flatMap((r, i) => {
        if (r.status === "rejected") {
          if (r.reason?.name !== "AbortError") failed.push(CATEGORIES[i].label);
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

  // Retry wrapper — up to 2 retries with 800 ms / 1600 ms backoff
  async function fetchWithRetry(cat, lat, lon, radiusKm, signal, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchCategory(cat, lat, lon, radiusKm, signal);
      } catch (err) {
        if (err.name === "AbortError" || attempt === retries) throw err;
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }

  /* ── Overpass fetch (one category) ── */
  async function fetchCategory(cat, lat, lon, radiusKm, signal) {
    const r = radiusKm * 1000;
    const q = `[out:json][timeout:30];
(
  node[${cat.amenity}](around:${r},${lat},${lon});
  way[${cat.amenity}](around:${r},${lat},${lon});
  relation[${cat.amenity}](around:${r},${lat},${lon});
);
out center tags;`;

    const fetchSig = AbortSignal.any
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
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
      return [{ id: el.id, cat: cat.key, label: cat.label, color: cat.color, name, address, lat: elLat, lon: elLon, dist, board }];
    });
  }

  function buildAddress(tags) {
    const t = tags;
    const parts = [
      // building / plot number
      t["addr:housenumber"] || t["addr:flats"],
      // street / road
      t["addr:street"] || t["addr:place"],
      // locality / neighbourhood
      t["addr:suburb"] || t["addr:quarter"] || t["addr:neighbourhood"] || t["addr:locality"],
      // city / town / village
      t["addr:city"] || t["addr:town"] || t["addr:village"] || t["addr:hamlet"],
      // district (common in Indian OSM data)
      t["addr:district"],
      // state
      t["addr:state"],
      // PIN code
      t["addr:postcode"]
    ].filter(Boolean);

    if (parts.length) return parts.join(", ");
    // fallback: unstructured tags some Indian mappers use
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
      else                          msg = "No facilities found in this area.";
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
      </div>`;
    }).join("");
  }

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
        Name:     f.name,
        Category: f.label,
        Address:  f.address || "",
        Board:    f.board || ""
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
