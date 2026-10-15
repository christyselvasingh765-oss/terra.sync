/* ==========================================
   SITEGUARD AI — SAFETY DASHBOARD
   SOS • Offline Queue • Risk Score • Incidents
   ========================================== */

// If frontend and Flask backend are on different URLs,
// replace "" with your deployed Flask backend URL.
// Example: "https://your-backend.example.com"
const API_BASE = "";

const $ = (id) => document.getElementById(id);

const DB_NAME = "SiteGuardDB";
const DB_VERSION = 1;
const QUEUE_STORE = "offlineReports";
const LOCAL_STORE = "localIncidents";

let db;
let ppeViolations = 0;
let zoneViolations = 0;
let serverOpenIncidents = 0;
let localIncidents = [];
let isSyncing = false;

const dangerousZones = [
  "Crane Zone",
  "Excavation Zone",
  "Restricted Zone"
];

// ===== BASIC HELPERS =====

function apiUrl(path) {
  return API_BASE.replace(/\/$/, "") + path;
}

function setMessage(id, message, type = "") {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.classList.remove("success", "warning", "error");

  if (type) element.classList.add(type);
}

function safeText(value) {
  return String(value ?? "");
}

function getTime() {
  return new Date().toLocaleString();
}

function createId() {
  return "SG-" + Date.now() + "-" +
    Math.random().toString(36).slice(2, 7);
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Server request failed");
  }

  return data;
}

// ===== INDEXEDDB: OFFLINE STORAGE =====

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is not supported by this browser."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, {
          keyPath: "id"
        });
      }

      if (!database.objectStoreNames.contains(LOCAL_STORE)) {
        database.createObjectStore(LOCAL_STORE, {
          keyPath: "id"
        });
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error || new Error("Database could not open."));
    };
  });
}

function saveRecord(storeName, record) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Local database is unavailable."));
      return;
    }

    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function getAllRecords(storeName) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Local database is unavailable."));
      return;
    }

    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function deleteRecord(storeName, id) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Local database is unavailable."));
      return;
    }

    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ===== LOCAL INCIDENT HISTORY =====

async function addLocalIncident(incident) {
  const record = {
    id: incident.id || createId(),
    worker_id: incident.worker_id || "DEMO",
    location: incident.location || "Unknown",
    incident: incident.incident || "Safety alert",
    reported_at: incident.reported_at || getTime(),
    status: incident.status || "Open",
    local: true
  };

  await saveRecord(LOCAL_STORE, record);
  localIncidents = await getAllRecords(LOCAL_STORE);

  updateRiskScore();
  renderIncidentHistory();

  return record;
}

// ===== DASHBOARD CONNECTION STATUS =====

function updateConnectionStatus() {
  const online = navigator.onLine;
  const dot = $("dot");
  const network = $("network");

  if (dot) {
    dot.style.background = online ? "#54e7b1" : "#ff607a";
    dot.style.color = online ? "#54e7b1" : "#ff607a";
  }

  if (network) {
    network.textContent = online ? "ONLINE" : "OFFLINE";
  }
}

window.addEventListener("online", async () => {
  updateConnectionStatus();
  await syncOfflineReports();
  await loadDashboard();
  await loadIncidentHistory();
});

window.addEventListener("offline", () => {
  updateConnectionStatus();
});

// ===== OFFLINE QUEUE COUNT =====

async function updatePendingCount() {
  try {
    const reports = await getAllRecords(QUEUE_STORE);
    if ($("pending")) $("pending").textContent = reports.length;
  } catch (error) {
    console.error("Could not count queued reports:", error);
  }
}

// ===== EMERGENCY PHOTO PREVIEW =====

function setupMediaPreview(inputId, containerId, imageId, videoId) {
  const input = $(inputId);
  const container = $(containerId);
  const image = $(imageId);
  const video = $(videoId);

  if (!input || !container || !image || !video) return;

  let previousUrl = null;

  input.addEventListener("change", () => {
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl);
      previousUrl = null;
    }

    const file = input.files && input.files[0];

    image.hidden = true;
    video.hidden = true;
    container.hidden = true;

    if (!file) return;

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "video/quicktime"
    ];

    if (!allowed.includes(file.type)) {
      setMessage(
        "sosResult",
        "Choose a supported image or video file.",
        "error"
      );
      input.value = "";
      return;
    }

    // Keep uploads small for browser storage and network use.
    if (file.size > 5 * 1024 * 1024) {
      setMessage(
        "sosResult",
        "File is too large. Please select a file under 5 MB.",
        "error"
      );
      input.value = "";
      return;
    }

    previousUrl = URL.createObjectURL(file);
    container.hidden = false;

    if (file.type.startsWith("image/")) {
      image.src = previousUrl;
      image.hidden = false;
    } else {
      video.src = previousUrl;
      video.hidden = false;
    }
  });
}

// ===== PPE SAMPLE CHECKER =====

function setupPPEChecker() {
  const input = $("ppeFile");
  const button = $("ppeButton");

  if (!input || !button) return;

  let previousUrl = null;

  input.addEventListener("change", () => {
    const container = $("ppePreview");
    const image = $("ppeImage");
    const video = $("ppeVideo");

    if (previousUrl) URL.revokeObjectURL(previousUrl);
    previousUrl = null;

    if (container) container.hidden = true;
    if (image) image.hidden = true;
    if (video) video.hidden = true;

    const file = input.files && input.files[0];
    if (!file) return;

    if (!file.type.startsWith("image/") &&
        !file.type.startsWith("video/")) {
      setMessage("ppeResult", "Select an image or video file.", "error");
      input.value = "";
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setMessage("ppeResult", "Please select a sample under 5 MB.", "error");
      input.value = "";
      return;
    }

    previousUrl = URL.createObjectURL(file);

    if (container) container.hidden = false;

    if (file.type.startsWith("image/") && image) {
      image.src = previousUrl;
      image.hidden = false;
    } else if (video) {
      video.src = previousUrl;
      video.hidden = false;
    }

    setMessage(
      "ppeResult",
      "Sample selected. Click Analyse PPE Sample to continue.",
      "warning"
    );
  });

  button.addEventListener("click", async () => {
    const file = input.files && input.files[0];

    if (!file) {
      setMessage("ppeResult", "First select a sample image or video.", "warning");
      return;
    }

    // No trained computer-vision model is connected in this prototype.
    // This asks the operator to confirm the result manually.
    const violation = window.confirm(
      "DEMO PPE REVIEW\n\n" +
      "This prototype does not automatically detect helmets or vests.\n\n" +
      "Did the sample show a missing helmet or safety vest?\n\n" +
      "Press OK to record a simulated PPE violation, or Cancel if no violation was observed."
    );

    if (!violation) {
      setMessage(
        "ppeResult",
        "Manual demo review completed: no violation recorded. This is not an AI detection result.",
        "success"
      );
      return;
    }

    ppeViolations++;

    try {
      await addLocalIncident({
        worker_id: "PPE-REVIEW",
        location: "Manual PPE sample review",
        incident: "Possible missing helmet or safety vest",
        status: "Open"
      });

      setMessage(
        "ppeResult",
        "Demo PPE violation recorded. A trained PPE model is needed for automatic detection.",
        "warning"
      );
    } catch (error) {
      console.error(error);
      setMessage("ppeResult", "Could not save the PPE demo incident.", "error");
    }
  });
}

// ===== SIMULATED DANGEROUS ZONES =====

function setupDangerZones() {
  const button = $("zoneButton");
  const select = $("zone");

  if (!button || !select) return;

  button.addEventListener("click", async () => {
    const zone = select.value;
    const pin = $("workerPin");

    if (pin) {
      const positions = {
        "Safe Zone": ["50%", "77%"],
        "Crane Zone": ["25%", "30%"],
        "Excavation Zone": ["77%", "32%"],
        "Restricted Zone": ["90%", "85%"]
      };

      const position = positions[zone] || positions["Safe Zone"];
      pin.style.left = position[0];
      pin.style.top = position[1];
      pin.style.background = dangerousZones.includes(zone)
        ? "#ff607a"
        : "#55b4ff";
    }

    if (!dangerousZones.includes(zone)) {
      setMessage(
        "zoneResult",
        "Worker is in the simulated safe zone. No zone violation recorded.",
        "success"
      );
      updateRiskScore();
      return;
    }

    zoneViolations++;

    try {
      await addLocalIncident({
        worker_id: "DEMO-WORKER",
        location: zone,
        incident: "Simulated dangerous-zone entry",
        status: "Open"
      });

      setMessage(
        "zoneResult",
        "⚠ WARNING: Simulated worker entered " + zone +
          ". Supervisor review is required.",
        "warning"
      );
    } catch (error) {
      console.error(error);
      setMessage(
        "zoneResult",
        "Danger-zone alert triggered, but local history could not be saved.",
        "error"
      );
    }
  });
}

// ===== GPS LOCATION =====

function setupGPS() {
  const button = $("gpsButton");
  const locationInput = $("location");

  if (!button || !locationInput) return;

  button.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setMessage("sosResult", "GPS is not supported by this browser.", "error");
      return;
    }

    if (!navigator.onLine) {
      setMessage(
        "sosResult",
        "GPS may be unavailable offline. Enter the last known location manually.",
        "warning"
      );
      return;
    }

    button.disabled = true;
    button.textContent = "Getting location...";

    navigator.geolocation.getCurrentPosition(
      (position) => {
        locationInput.value =
          position.coords.latitude.toFixed(6) + ", " +
          position.coords.longitude.toFixed(6);

        button.disabled = false;
        button.textContent = "⌖ Use Current Location";

        setMessage(
          "sosResult",
          "Location captured. Review it before submitting.",
          "success"
        );
      },
      (error) => {
        button.disabled = false;
        button.textContent = "⌖ Use Current Location";

        const messages = {
          1: "Location permission was denied. Enter the location manually.",
          2: "Location is currently unavailable. Enter it manually.",
          3: "Location request timed out. Please try again."
        };

        setMessage(
          "sosResult",
          messages[error.code] || "Could not get location.",
          "warning"
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000
      }
    );
  });
}

// ===== WORKER SOS FORM =====

function setupSOSForm() {
  const form = $("sosForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const workerId = $("workerId").value.trim();
    const location = $("location").value.trim();
    const incident = $("incident").value;
    const photoInput = $("photo");
    const photo = photoInput.files && photoInput.files[0];

    if (!workerId || !location || !incident) {
      setMessage("sosResult", "Please fill in all required fields.", "error");
      return;
    }

    if (photo && photo.size > 5 * 1024 * 1024) {
      setMessage("sosResult", "Evidence file must be under 5 MB.", "error");
      return;
    }

    const report = {
      id: createId(),
      worker_id: workerId,
      location,
      incident,
      reported_at: getTime(),
      status: "Open",
      photo: photo || null
    };

    const button = $("sosSubmit");
    if (button) {
      button.disabled = true;
      button.textContent = "Submitting...";
    }

    try {
      if (navigator.onLine) {
        await sendEmergencyReport(report);

        setMessage(
          "sosResult",
          "Emergency report accepted by the configured backend. Confirm response with the supervisor.",
          "success"
        );

        await loadDashboard();
        await loadIncidentHistory();
      } else {
        await saveRecord(QUEUE_STORE, report);

        await addLocalIncident({
          ...report,
          status: "Pending sync"
        });

        setMessage(
          "sosResult",
          "OFFLINE: Report saved on this device. It has NOT reached the supervisor or emergency services yet.",
          "warning"
        );
      }

      await updatePendingCount();
      updateRiskScore();

      // Clear form only after a successful save/send.
      form.reset();
      const preview = $("photoPreview");
      if (preview) preview.hidden = true;
    } catch (error) {
      console.error("SOS submission:", error);

      // Network may have failed while the browser still reported online.
      try {
        await saveRecord(QUEUE_STORE, report);

        await addLocalIncident({
          ...report,
          status: "Pending sync"
        });

        setMessage(
          "sosResult",
          "Server could not be reached. Report saved locally for later sync; emergency help has NOT been notified.",
          "warning"
        );

        await updatePendingCount();
      } catch (storageError) {
        console.error("Local save failed:", storageError);
        setMessage(
          "sosResult",
          "Report could not be sent or saved locally. Call 112 directly in a real emergency.",
          "error"
        );
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "🚨 SUBMIT EMERGENCY SOS";
      }
    }
  });
}

async function sendEmergencyReport(report) {
  const formData = new FormData();

  formData.append("worker_id", report.worker_id);
  formData.append("location", report.location);
  formData.append("incident", report.incident);

  if (report.photo instanceof Blob) {
    formData.append(
      "photo",
      report.photo,
      report.photo.name || "emergency-evidence"
    );
  }

  const response = await fetch(apiUrl("/api/emergency"), {
    method: "POST",
    body: formData
  });

  return readJson(response);
}

// ===== AUTOMATIC SYNC WHEN ONLINE =====

async function syncOfflineReports() {
  if (!navigator.onLine || isSyncing || !db) return;

  isSyncing = true;

  try {
    const reports = await getAllRecords(QUEUE_STORE);

    for (const report of reports) {
      if (!navigator.onLine) break;

      try {
        await sendEmergencyReport(report);

        await deleteRecord(QUEUE_STORE, report.id);
        await deleteRecord(LOCAL_STORE, report.id).catch(() => {});

        // Remove the matching local record from the displayed history.
        localIncidents = localIncidents.filter(
          item => item.id !== report.id
        );
      } catch (error) {
        // Keep the report in the queue. Try again on the next connection.
        console.warn("Report still pending:", report.id, error);
        break;
      }
    }
  } catch (error) {
    console.error("Offline sync failed:", error);
  } finally {
    isSyncing = false;
    await updatePendingCount();
    await loadDashboard();
    await loadIncidentHistory();
    updateRiskScore();
  }
}

// ===== RISK SCORE =====

function updateRiskScore() {
  const openLocal = localIncidents.filter(
    item => item.status !== "Resolved"
  ).length;

  const score = Math.min(
    100,
    ppeViolations * 15 +
    zoneViolations * 20 +
    openLocal * 10 +
    serverOpenIncidents * 5
  );

  const scoreElement = $("risk");
  const levelElement = $("riskLevel");

  if (scoreElement) scoreElement.textContent = score;

  let level = "LOW";
  let cssClass = "risk-low";

  if (score >= 60) {
    level = "HIGH";
    cssClass = "high";
  } else if (score >= 30) {
    level = "MEDIUM";
    cssClass = "medium";
  }

  if (levelElement) {
    levelElement.textContent = level + " RISK";
    levelElement.className = cssClass;
  }
}

// ===== LOAD DASHBOARD FROM FLASK =====

async function loadDashboard() {
  if (!navigator.onLine) return;

  try {
    const response = await fetch(apiUrl("/api/dashboard"));
    const data = await readJson(response);

    if ($("workers") && data.workers !== undefined) {
      $("workers").textContent = data.workers;
    }

    if (data.open_incidents !== undefined) {
      serverOpenIncidents = Number(data.open_incidents) || 0;
    } else if (data.open_incident_count !== undefined) {
      serverOpenIncidents = Number(data.open_incident_count) || 0;
    }

    if ($("openCount")) {
      const pending = await getAllRecords(QUEUE_STORE);
      const localOpen = localIncidents.filter(
        item => item.status !== "Resolved"
      ).length;

      $("openCount").textContent =
        serverOpenIncidents + pending.length + localOpen;
    }

    updateRiskScore();
  } catch (error) {
    console.warn("Dashboard backend unavailable:", error);
  }
}

// ===== INCIDENT HISTORY =====

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function loadIncidentHistory() {
  if (navigator.onLine) {
    try {
      const response = await fetch(apiUrl("/api/dashboard"));
      const data = await readJson(response);

      const incidents =
        data.incident_history ||
        data.incidents ||
        [];

      if (Array.isArray(incidents)) {
        renderIncidentHistory(incidents);
        return;
      }
    } catch (error) {
      console.warn("Could not load server history:", error);
    }
  }

  renderIncidentHistory();
}

function renderIncidentHistory(serverIncidents = null) {
  const tbody = $("incidentRows");
  if (!tbody) return;

  const local = [...localIncidents];
  const all = serverIncidents === null
    ? local
    : [...serverIncidents, ...local];

  if (!all.length) {
    tbody.innerHTML =
      '<tr><td colspan="7">No incidents recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = all.map(item => {
    const id = item.id ?? item.incident_id ?? "—";
    const worker = item.worker_id ?? item.worker ?? "—";
    const location = item.location ?? "—";
    const incident = item.incident ?? item.description ?? "Safety incident";
    const reportedAt = item.reported_at ?? item.timestamp ?? "—";
    const status = item.status ?? "Open";
    const resolved = String(status).toLowerCase() === "resolved";
    const pending = String(status).toLowerCase().includes("pending");
    const isLocal = item.local === true ||
      local.some(localItem => localItem.id === id);

    return `
      <tr>
        <td>${escapeHTML(id)}</td>
        <td>${escapeHTML(worker)}</td>
        <td>${escapeHTML(location)}</td>
        <td>${escapeHTML(incident)}</td>
        <td>${escapeHTML(reportedAt)}</td>
        <td>
          <span class="status ${resolved ? "resolved" : ""}">
            ${escapeHTML(status)}
          </span>
        </td>
        <td>
          ${
            resolved || pending
              ? "—"
              : `<button class="resolve"
                   type="button"
                   data-id="${escapeHTML(id)}"
                   data-local="${isLocal ? "true" : "false"}">
                   Resolve
                 </button>`
          }
        </td>
      </tr>
    `;
  }).join("");
}

// Resolve button uses event delegation.
document.addEventListener("click", async event => {
  const button = event.target.closest(".resolve");
  if (!button) return;

  const id = button.dataset.id;
  const isLocal = button.dataset.local === "true";

  button.disabled = true;

  try {
    if (isLocal) {
      const record = localIncidents.find(item => item.id === id);

      if (record) {
        record.status = "Resolved";
        await saveRecord(LOCAL_STORE, record);
      }
    } else {
      const response = await fetch(
        apiUrl("/api/incidents/" + encodeURIComponent(id) + "/resolve"),
        { method: "PATCH" }
      );

      await readJson(response);
    }

    localIncidents = await getAllRecords(LOCAL_STORE);
    await loadDashboard();
    await loadIncidentHistory();
    updateRiskScore();
  } catch (error) {
    console.error("Could not resolve incident:", error);
    alert("Could not resolve incident. Check the backend connection.");
    button.disabled = false;
  }
});

// ===== BATTERY STATUS (IF BROWSER SUPPORTS IT) =====

async function setupBatteryStatus() {
  if (!("getBattery" in navigator)) return;

  try {
    const battery = await navigator.getBattery();

    const badge = document.createElement("span");
    badge.className = "network-badge";
    badge.id = "batteryBadge";
    badge.title = "Device battery status, if reported by the browser";

    const header = document.querySelector(".header-right");
    if (header) header.appendChild(badge);

    function updateBattery() {
      const percent = Math.round(battery.level * 100);
      const charging = battery.charging ? " · Charging" : "";
      badge.textContent = "🔋 " + percent + "%" + charging;
    }

    updateBattery();
    battery.addEventListener("levelchange", updateBattery);
    battery.addEventListener("chargingchange", updateBattery);
  } catch (error) {
    console.info("Battery API unavailable:", error);
  }
}

// ===== SERVICE WORKER / OFFLINE APP SHELL =====

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // Service workers require HTTPS or localhost.
  if (!window.isSecureContext) return;

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Offline app shell registration failed:", error);
  }
}

// ===== INITIALIZE APP =====

async function initializeApp() {
  updateConnectionStatus();

  try {
    await openDatabase();
    localIncidents = await getAllRecords(LOCAL_STORE);
    await updatePendingCount();
  } catch (error) {
    console.error("Local database unavailable:", error);
    setMessage(
      "sosResult",
      "Local offline storage is unavailable. Do not rely on offline reporting on this device.",
      "error"
    );
  }

  setupMediaPreview(
    "photo",
    "photoPreview",
    "photoImage",
    "photoVideo"
  );

  setupPPEChecker();
  setupDangerZones();
  setupGPS();
  setupSOSForm();

  const refreshButton = $("refreshButton");
  if (refreshButton) {
    refreshButton.addEventListener("click", async () => {
      await loadDashboard();
      await loadIncidentHistory();
      await updatePendingCount();
      updateConnectionStatus();
    });
  }

  await loadDashboard();
  await loadIncidentHistory();
  await syncOfflineReports();
  updateRiskScore();

  setupBatteryStatus();
  registerServiceWorker();
}

document.addEventListener("DOMContentLoaded", initializeApp);
