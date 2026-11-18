// Datos compartidos entre la app y el service worker (IndexedDB)
const DB_NAME = "citas-db";
const STORE = "kv";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet(key, fallback) {
  const db = await openDB();
  return new Promise((resolve) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result === undefined ? fallback : r.result);
    r.onerror = () => resolve(fallback);
  });
}
async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Fechas ----
// Avisos por defecto: el día antes a las 20:00 y el mismo día 2 horas antes
const DEFAULT_SETTINGS = { eveTime: "20:00", hoursBefore: 2 };

function apptDate(a) {
  const [y, m, d] = a.date.split("-").map(Number);
  const [hh, mm] = (a.time || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
// Una cita sigue "pendiente" hasta 2 horas después de su hora
function isUpcoming(a, now = new Date()) { return apptDate(a).getTime() + 2 * 3600000 > now.getTime(); }

function eveTrigger(a, s) {
  const d = apptDate(a); const [h, m] = s.eveTime.split(":").map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m);
}
function dayTrigger(a, s) {
  const d = apptDate(a);
  const t = new Date(d.getTime() - s.hoursBefore * 3600000);
  const morning = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 0);
  // Nunca antes de las 7:00 del mismo día (salvo que la cita sea antes de esa hora)
  return t < morning && d > morning ? morning : t;
}
function modeText(a) { return a.mode === "telefono" ? "Te llamarán por teléfono" : "Presencial"; }
function apptTitle(a) { return a.specialty + (a.doctor ? " (" + a.doctor + ")" : ""); }
function apptBody(a, when) {
  const lines = [`${when} a las ${a.time} · ${modeText(a)}`];
  if (a.mode !== "telefono" && a.place) lines.push("📍 " + a.place);
  const docs = (a.docs || []).filter((d) => d.text);
  if (docs.length) lines.push("📄 Llevar: " + docs.map((d) => d.text).join(", "));
  return lines.join("\n");
}

// Muestra los avisos que toquen (una sola vez cada uno)
async function notifyDueIfNeeded(registration, now = new Date()) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return 0;
  const [appts, settings, notified] = await Promise.all([dbGet("appts", []), dbGet("settings", DEFAULT_SETTINGS), dbGet("notified", {})]);
  let count = 0;
  for (const a of appts) {
    const start = apptDate(a);
    if (start <= now) continue;
    const eve = eveTrigger(a, settings), day = dayTrigger(a, settings);
    // Aviso del día anterior (solo si aún no es el día de la cita)
    if (!notified[a.id + ":eve"] && now >= eve && now < startOfDay(start)) {
      await registration.showNotification("🩺 Mañana: " + apptTitle(a), {
        body: apptBody(a, "Mañana"), icon: "icon-192.png", badge: "icon-192.png", tag: a.id + "-eve", requireInteraction: true,
      });
      notified[a.id + ":eve"] = 1; count++;
    }
    if (!notified[a.id + ":day"] && now >= day) {
      await registration.showNotification("🩺 Hoy: " + apptTitle(a), {
        body: apptBody(a, "Hoy"), icon: "icon-192.png", badge: "icon-192.png", tag: a.id + "-day", requireInteraction: true, vibrate: [300, 150, 300],
      });
      notified[a.id + ":eve"] = 1; notified[a.id + ":day"] = 1; count++;
    }
  }
  // Limpia avisos de citas que ya no existen
  const ids = new Set(appts.map((a) => a.id));
  for (const k of Object.keys(notified)) if (!ids.has(k.split(":")[0])) delete notified[k];
  await dbSet("notified", notified);
  return count;
}
