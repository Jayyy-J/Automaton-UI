// ============================================================================
// AUTOMATON — simulated live ledger backend
// ----------------------------------------------------------------------------
// This server does NOT connect to any real payment rail or task marketplace.
// It generates plausible, randomized "task" and "wallet" events and persists
// them to a local SQLite file (automaton.db) so the history survives
// restarts (Ubuntu VM) and keeps growing when deployed to a domain.
//
// IMPORTANT: label this clearly as a preview/simulation environment to anyone
// who views it — the figures are illustrative, not real financial activity.
//
// WEEKLY RULE: each business week (Saturday 00:00 → Friday 23:59:59, Colombia
// time) is planned in advance so it always closes with a net profit between
// WEEKLY_PROFIT_MIN and WEEKLY_PROFIT_MAX. Individual event timestamps are
// spaced 15 min – 3 h apart, same as before — only now the amounts are
// computed up front so the week's math works out exactly, instead of purely
// independent randomness that could drift arbitrarily high or low.
// ============================================================================

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "automaton.db");

// ---- config (tweak freely) -------------------------------------------------
const STARTING_BALANCE = 1922.3; // USD, seeded only on first run (or via RESET_BALANCE_TO)
const MONTHLY_MAINTENANCE = 150.0; // USD "cost to stay alive" per month

// Gap between consecutive events (credit or debit, same cadence for both)
const EVENT_MIN_GAP_MS = 15 * 60 * 1000; // 15 min
const EVENT_MAX_GAP_MS = 3 * 60 * 60 * 1000; // 3 h

// Weekly net-profit target range. Each week (Sat–Fri, Colombia time) gets a
// random target in this range, and the week's events are sized so the
// cumulative net (credits - debits) lands exactly on that target by Friday.
const WEEKLY_PROFIT_MIN = 35;
const WEEKLY_PROFIT_MAX = 195;

const CREDIT_MIN = 0.5;
const CREDIT_MAX = 25;
const DEBIT_MIN = 0.1;
const DEBIT_MAX = 5;
const CREDIT_PROBABILITY = 0.55; // share of weekly slots typed as "credit"

// Colombia is UTC-5 year-round (no DST) — used so "closes every Friday"
// matches Juan's local week, regardless of the server's own timezone.
const TZ_OFFSET_HOURS = -5;

// Simulación activa por defecto. Para pausarla (congelar saldo/historial tal
// como están) pon SIMULATION_ENABLED=false en las variables de entorno.
const SIMULATION_ENABLED = process.env.SIMULATION_ENABLED !== "false";

const TASK_NAMES = [
  "Web scraping — catálogo de precios",
  "Etiquetado de datos — visión artificial",
  "Monitoreo de API — uptime check",
  "Moderación de contenido — cola de revisión",
  "Generación de reportes — resumen diario",
  "Investigación web — recolección de leads",
  "Transcripción de audio — fragmento corto",
  "Análisis de sentimiento — reseñas de clientes",
  "Sincronización de inventario — proveedor externo",
  "Respuesta automática — soporte nivel 1",
  "Extracción de PDF — datos estructurados",
  "Verificación de enlaces — salud del sitio",
  "Clasificación de imágenes — control de calidad",
  "Resumen de noticias — sector energético",
  "Enriquecimiento de base de datos — contactos B2B",
];

const DEBIT_REASONS = [
  "Costo de cómputo — instancia en la nube",
  "Ancho de banda — transferencia de datos",
  "API de terceros — cuota de uso",
  "Almacenamiento — snapshot horario",
  "Reintento de tarea fallida — penalización",
  "Latencia de red — recarga de sesión",
];

// ---- db setup ---------------------------------------------------------------
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS wallet (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('credit','debit')),
    amount REAL NOT NULL,
    label TEXT NOT NULL,
    balance_after REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS planned_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    scheduled_ts TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('credit','debit')),
    amount REAL NOT NULL,
    label TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_planned_due ON planned_events (fired, scheduled_ts);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const walletRow = db.prepare("SELECT * FROM wallet WHERE id = 1").get();
if (!walletRow) {
  db.prepare(
    "INSERT INTO wallet (id, balance, updated_at) VALUES (1, ?, ?)"
  ).run(STARTING_BALANCE, new Date().toISOString());
}
const bootRow = db.prepare("SELECT value FROM meta WHERE key = 'boot_at'").get();
if (!bootRow) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('boot_at', ?)").run(
    new Date().toISOString()
  );
}

// ---- one-time reset via env var --------------------------------------------
// Set RESET_BALANCE_TO=1922.30 in Railway once to force the wallet back to
// that value and clear history/plans, then remove the variable — otherwise
// every restart will wipe it again.
if (process.env.RESET_BALANCE_TO !== undefined) {
  const resetVal = parseFloat(process.env.RESET_BALANCE_TO);
  if (!isNaN(resetVal)) {
    db.exec(
      "DELETE FROM events; DELETE FROM planned_events; DELETE FROM meta WHERE key LIKE 'week_target_%';"
    );
    db.prepare("UPDATE wallet SET balance = ?, updated_at = ? WHERE id = 1").run(
      Math.round(resetVal * 100) / 100,
      new Date().toISOString()
    );
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('boot_at', ?)").run(
      new Date().toISOString()
    );
    console.log(
      `🔄 Saldo reiniciado a $${resetVal} por RESET_BALANCE_TO. Quita esa variable de entorno para que no se repita en cada reinicio.`
    );
  }
}

const getWallet = db.prepare("SELECT * FROM wallet WHERE id = 1");
const updateWallet = db.prepare(
  "UPDATE wallet SET balance = ?, updated_at = ? WHERE id = 1"
);
const insertEvent = db.prepare(
  "INSERT INTO events (ts, type, amount, label, balance_after) VALUES (?,?,?,?,?)"
);
const recentEvents = db.prepare(
  "SELECT * FROM events ORDER BY id DESC LIMIT ?"
);
const eventsSince = db.prepare(
  "SELECT * FROM events WHERE ts >= ? ORDER BY id ASC"
);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function randBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Colombia-week helpers --------------------------------------------------
function colombiaShifted(date) {
  return new Date(date.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
}

// Returns the real UTC Date for the most recent Saturday 00:00:00 Colombia
// time (the start of the current business week).
function currentWeekStart(now = new Date()) {
  const col = colombiaShifted(now);
  const dow = col.getUTCDay(); // 0=Sun ... 6=Sat, in "Colombia-shifted" terms
  const daysSinceSaturday = (dow + 1) % 7; // Sat->0, Sun->1, ... Fri->6
  const colMidnight = new Date(
    Date.UTC(col.getUTCFullYear(), col.getUTCMonth(), col.getUTCDate())
  );
  const colWeekStart = new Date(
    colMidnight.getTime() - daysSinceSaturday * 24 * 3600 * 1000
  );
  return new Date(colWeekStart.getTime() - TZ_OFFSET_HOURS * 3600 * 1000);
}

function weekEndFromStart(weekStartUTC) {
  return new Date(weekStartUTC.getTime() + 7 * 24 * 3600 * 1000 - 1);
}

// Splits `sum` into `n` positive parts, each within [lo, hi], summing exactly
// to `sum` (assuming lo*n <= sum <= hi*n, which callers should ensure).
function partitionBounded(sum, n, lo, hi) {
  if (n <= 0) return [];
  let remaining = round2(sum);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const slotsLeft = n - i - 1;
    if (slotsLeft === 0) {
      parts.push(Math.min(hi, Math.max(lo, round2(remaining))));
      break;
    }
    const minFeasible = Math.max(lo, remaining - hi * slotsLeft);
    const maxFeasible = Math.min(hi, remaining - lo * slotsLeft);
    const lowB = Math.min(minFeasible, maxFeasible);
    const highB = Math.max(minFeasible, maxFeasible);
    let amt = round2(randBetween(lowB, highB));
    amt = Math.min(hi, Math.max(lo, amt));
    parts.push(amt);
    remaining = round2(remaining - amt);
  }
  return parts;
}

// ---- weekly plan generation --------------------------------------------------
function generateWeeklyPlanIfMissing(weekStartDate) {
  const weekStartKey = weekStartDate.toISOString();
  const existing = db
    .prepare("SELECT COUNT(*) AS c FROM planned_events WHERE week_start = ?")
    .get(weekStartKey);
  if (existing.c > 0) return;

  const weekEndDate = weekEndFromStart(weekStartDate);
  const target = round2(randBetween(WEEKLY_PROFIT_MIN, WEEKLY_PROFIT_MAX));

  // 1) lay out event timestamps across the week, 15min-3h apart
  const slots = [];
  let t = weekStartDate.getTime() + randBetween(EVENT_MIN_GAP_MS, EVENT_MAX_GAP_MS);
  while (t <= weekEndDate.getTime()) {
    slots.push(t);
    t += randBetween(EVENT_MIN_GAP_MS, EVENT_MAX_GAP_MS);
  }
  if (slots.length === 0) {
    slots.push(
      Math.min(
        weekStartDate.getTime() + EVENT_MIN_GAP_MS,
        weekEndDate.getTime()
      )
    );
  }

  // 2) type each slot credit/debit
  const types = slots.map(() =>
    Math.random() < CREDIT_PROBABILITY ? "credit" : "debit"
  );

  // safety floor: at least 30% of slots must be credit so the bounded
  // partition below always has enough room to hit the target
  const minCredits = Math.max(1, Math.ceil(types.length * 0.3));
  let creditCount = types.filter((t) => t === "credit").length;
  for (let i = 0; i < types.length && creditCount < minCredits; i++) {
    if (types[i] === "debit") {
      types[i] = "credit";
      creditCount++;
    }
  }

  // 3) debit amounts: natural random, no constraint
  const debitAmounts = types.map((ty) =>
    ty === "debit" ? round2(randBetween(DEBIT_MIN, DEBIT_MAX)) : null
  );
  const sumDebits = round2(
    debitAmounts.reduce((s, a) => s + (a || 0), 0)
  );

  // 4) credit amounts: bounded partition so total credits - total debits = target
  const creditIdx = types
    .map((ty, i) => (ty === "credit" ? i : -1))
    .filter((i) => i >= 0);
  const creditTargetSum = round2(target + sumDebits);
  const creditAmounts = partitionBounded(
    creditTargetSum,
    creditIdx.length,
    CREDIT_MIN,
    CREDIT_MAX
  );

  // 5) assemble + insert
  const insertPlanned = db.prepare(
    `INSERT INTO planned_events (week_start, scheduled_ts, type, amount, label, fired)
     VALUES (?,?,?,?,?,0)`
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertPlanned.run(...r);
  });

  let ci = 0;
  const rows = [];
  for (let i = 0; i < slots.length; i++) {
    const ts = new Date(slots[i]).toISOString();
    if (types[i] === "credit") {
      rows.push([weekStartKey, ts, "credit", creditAmounts[ci++], pick(TASK_NAMES)]);
    } else {
      rows.push([weekStartKey, ts, "debit", debitAmounts[i], pick(DEBIT_REASONS)]);
    }
  }
  insertMany(rows);

  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
  ).run(`week_target_${weekStartKey}`, String(target));

  const actualCreditSum = round2(creditAmounts.reduce((s, a) => s + a, 0));
  console.log(
    `📅 Plan semanal generado: ${weekStartKey} → objetivo neto $${target} ` +
      `(créditos $${actualCreditSum} - débitos $${sumDebits} = $${round2(
        actualCreditSum - sumDebits
      )}), ${rows.length} eventos`
  );
}

function ensureCurrentWeekPlanned() {
  generateWeeklyPlanIfMissing(currentWeekStart(new Date()));
}

// ---- delivering due events ---------------------------------------------------
function recordEvent(type, amount, label) {
  const wallet = getWallet.get();
  const newBalance = round2(
    type === "credit" ? wallet.balance + amount : wallet.balance - amount
  );
  const now = new Date().toISOString();
  updateWallet.run(newBalance, now);
  insertEvent.run(now, type, amount, label, newBalance);
}

function deliverDuePlannedEvents() {
  const nowIso = new Date().toISOString();
  const due = db
    .prepare(
      "SELECT * FROM planned_events WHERE fired = 0 AND scheduled_ts <= ? ORDER BY scheduled_ts ASC"
    )
    .all(nowIso);
  for (const ev of due) {
    recordEvent(ev.type, ev.amount, ev.label);
    db.prepare("UPDATE planned_events SET fired = 1 WHERE id = ?").run(ev.id);
  }
}

if (SIMULATION_ENABLED) {
  ensureCurrentWeekPlanned();
  deliverDuePlannedEvents(); // catch up on anything missed while the server was down
  setInterval(ensureCurrentWeekPlanned, 15 * 60 * 1000); // re-check every 15 min for the next week
  setInterval(deliverDuePlannedEvents, 60 * 1000); // deliver due events every minute
  console.log(
    "Simulación activa: eventos 15min–3h, cerrando cada semana (Colombia) con ganancia neta entre " +
      `$${WEEKLY_PROFIT_MIN} y $${WEEKLY_PROFIT_MAX}.`
  );
} else {
  console.log(
    "Simulación pausada (SIMULATION_ENABLED=false) — el saldo y el historial quedan congelados."
  );
}

// ---- http api -----------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// Busca el frontend de forma case-insensitive (Linux/Railway distingue
// mayúsculas de minúsculas — "Index.html" NO es lo mismo que "index.html").
// Revisa primero public/, luego la raíz del repo.
function findIndexHtml(dir) {
  if (!fs.existsSync(dir)) return null;
  const match = fs
    .readdirSync(dir)
    .find((f) => f.toLowerCase() === "index.html");
  return match ? path.join(dir, match) : null;
}

const publicDir = path.join(__dirname, "public");
let staticDir, indexPath;

const foundInPublic = findIndexHtml(publicDir);
const foundInRoot = findIndexHtml(__dirname);

if (foundInPublic) {
  staticDir = publicDir;
  indexPath = foundInPublic;
  console.log(`Frontend encontrado en ${indexPath}`);
} else if (foundInRoot) {
  staticDir = __dirname;
  indexPath = foundInRoot;
  console.log(
    `Frontend encontrado en ${indexPath} (raíz del repo, no en public/)`
  );
} else {
  staticDir = publicDir;
  indexPath = path.join(publicDir, "index.html");
  console.error(
    `⚠️  No se encontró ningún archivo index.html (en cualquier combinación de mayúsculas/minúsculas) ni en public/ ni en la raíz del repo (${__dirname}).`
  );
}

app.use(express.static(staticDir));

app.get("/", (req, res) => {
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res
      .status(500)
      .send(
        "Falta index.html en el deploy. Revisa que el archivo esté commiteado en el repo (en public/ o en la raíz)."
      );
  }
});

app.get("/api/status", (req, res) => {
  const wallet = getWallet.get();
  const boot = db.prepare("SELECT value FROM meta WHERE key = 'boot_at'").get();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todays = eventsSince.all(startOfDay.toISOString());
  const todayCredit = round2(
    todays.filter((e) => e.type === "credit").reduce((s, e) => s + e.amount, 0)
  );
  const todayDebit = round2(
    todays.filter((e) => e.type === "debit").reduce((s, e) => s + e.amount, 0)
  );

  const dailyMaintenance = MONTHLY_MAINTENANCE / 30;
  const daysOfRunwayLeft = wallet.balance / dailyMaintenance;

  const weekStart = currentWeekStart(new Date());
  const weekStartKey = weekStart.toISOString();
  const weekTargetRow = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(`week_target_${weekStartKey}`);
  const weekEvents = eventsSince.all(weekStartKey);
  const weekNet = round2(
    weekEvents.reduce(
      (s, e) => s + (e.type === "credit" ? e.amount : -e.amount),
      0
    )
  );

  res.json({
    balance: wallet.balance,
    updated_at: wallet.updated_at,
    boot_at: boot ? boot.value : null,
    monthly_maintenance: MONTHLY_MAINTENANCE,
    daily_maintenance: round2(dailyMaintenance),
    runway_days: round2(daysOfRunwayLeft),
    alive: wallet.balance > 0,
    today_credit: todayCredit,
    today_debit: todayDebit,
    today_net: round2(todayCredit - todayDebit),
    today_events: todays.length,
    week_start: weekStartKey,
    week_target: weekTargetRow ? parseFloat(weekTargetRow.value) : null,
    week_net_so_far: weekNet,
  });
});

app.get("/api/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  res.json(recentEvents.all(limit));
});

app.listen(PORT, () => {
  console.log(`Automaton simulation running on http://localhost:${PORT}`);
  console.log(`DB persisted at ${DB_PATH}`);
});
