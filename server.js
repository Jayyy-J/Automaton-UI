// ============================================================================
// AUTOMATON — simulated live ledger backend
// ----------------------------------------------------------------------------
// This server does NOT connect to any real payment rail or task marketplace.
// It generates plausible, randomized "task" and "wallet" events on an interval
// and persists them to a local SQLite file (automaton.db) so the history
// survives restarts (Ubuntu VM) and keeps growing when deployed to a domain.
//
// IMPORTANT: label this clearly as a preview/simulation environment to anyone
// who views it — the figures are illustrative, not real financial activity.
// ============================================================================

const express = require("express");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "automaton.db");

// ---- config (tweak freely) -------------------------------------------------
const STARTING_BALANCE = 340.0; // USD, seeded only on first run
const MONTHLY_MAINTENANCE = 150.0; // USD "cost to stay alive" per month
// Credits (tareas completadas) — esporádicas
const MIN_CREDIT_MS = 15 * 60 * 1000; // 15 min
const MAX_CREDIT_MS = 10 * 60 * 60 * 1000; // 10 h

// Debits (cómputo, DB, ancho de banda) — más constantes, como costos de infra reales
const MIN_DEBIT_MS = 5 * 60 * 1000; // 5 min
const MAX_DEBIT_MS = 60 * 60 * 1000; // 1 h

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

// ---- simulation loops ---------------------------------------------------
// Credits and debits run on independent random clocks: credits are
// sporadic (a task finished and got paid), debits are frequent and
// steady (infra keeps costing money whether or not a task just landed).
function recordEvent(type, amount, label) {
  const wallet = getWallet.get();
  const newBalance = round2(
    type === "credit" ? wallet.balance + amount : wallet.balance - amount
  );
  const now = new Date().toISOString();

  updateWallet.run(newBalance, now);
  insertEvent.run(now, type, amount, label, newBalance);
}

function creditTick() {
  recordEvent("credit", round2(randBetween(0.5, 25)), pick(TASK_NAMES));
  scheduleCredit();
}

function debitTick() {
  recordEvent("debit", round2(randBetween(0.1, 5)), pick(DEBIT_REASONS));
  scheduleDebit();
}

function scheduleCredit() {
  setTimeout(creditTick, randBetween(MIN_CREDIT_MS, MAX_CREDIT_MS));
}

function scheduleDebit() {
  setTimeout(debitTick, randBetween(MIN_DEBIT_MS, MAX_DEBIT_MS));
}

scheduleCredit();
scheduleDebit();

// ---- http api -----------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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
