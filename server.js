
// ============================================================================
// AUTOMATON — simulated live ledger backend (multi-usuario)
// ----------------------------------------------------------------------------
// This server does NOT connect to any real payment rail or task marketplace.
// It generates plausible, randomized "task" and "wallet" events per usuario y
// los persiste en un archivo SQLite local (DB_PATH) para que el historial
// sobreviva reinicios/redeploys (Railway Volume montado en /data).
//
// IMPORTANT: label this clearly as a preview/simulation environment to anyone
// who views it — the figures are illustrative, not real financial activity.
//
// MULTI-USUARIO: cada cuenta (role='user') tiene su propio wallet, historial
// de eventos, flota de bots, retiros y planificación semanal, completamente
// aislados por user_id. Las cuentas role='admin' no tienen wallet propio —
// solo administran (crean) cuentas nuevas desde el panel /admin.
//
// LOGIN: no hay registro público. Las únicas formas de crear una cuenta son
// (1) la migración/seed de una sola vez descrita más abajo, y (2) el panel de
// administración (requiere estar logueado como admin).
//
// WEEKLY RULE: cada semana de negocio (sábado 00:00 → viernes 23:59:59, hora
// Colombia) se planifica por adelantado para que la ganancia neta de TAREAS
// (créditos - débitos, sin contar retiros) cierre en un rango aleatorio entre
// WEEKLY_PROFIT_MIN y WEEKLY_PROFIT_MAX. Esto corre de forma independiente
// para cada usuario con role='user'.
// ============================================================================

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 4000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "automaton.db");

// ---- config (tweak freely) -------------------------------------------------
// Valores de arranque para CUALQUIER automaton nuevo (una cuenta recién creada
// desde el panel de admin arranca exactamente así, igual que arrancaba esta
// app la primerísima vez que se desplegó).
const STARTING_BALANCE = 1922.3; // USD
const INITIAL_BOT_COUNT = 26;
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

// Bot fleet: from INITIAL_BOT_COUNT, cada vez que la ganancia neta acumulada
// de TAREAS (créditos - débitos; retiros no cuentan) avanza BOT_MILESTONE_USD,
// se agrega un bot nuevo a la flota de ESE usuario y el contador se reinicia.
const BOT_MILESTONE_USD = 150;

// Cada bot nuevo dispara un retiro automático de este monto (si el saldo
// alcanza; si no, se retira lo que haya disponible) a esta dirección fija.
const AUTO_WITHDRAW_USD = 50;
const AUTO_WITHDRAW_ADDRESS = "9b37eChVGn3rSQRRMCLGj76GxGZx2d4tTBc9tcDBnWSP";

// Colombia is UTC-5 year-round (no DST) — used so "closes every Friday"
// matches the local week, regardless of the server's own timezone.
const TZ_OFFSET_HOURS = -5;

// Simulación activa por defecto. Para pausarla (congelar saldo/historial tal
// como están) pon SIMULATION_ENABLED=false en las variables de entorno.
const SIMULATION_ENABLED = process.env.SIMULATION_ENABLED !== "false";

// Cuentas creadas una sola vez por el seed/migración (ver más abajo). Las
// contraseñas NUNCA viven en el código fuente — se leen de variables de
// entorno de Railway (SEED_ADMIN_PASSWORD / SEED_JORGE_PASSWORD) solo en el
// momento de crear la cuenta por primera vez; de ahí en adelante solo existe
// el hash bcrypt guardado en la base de datos. Si la cuenta ya existe, estas
// variables ya no se usan para nada (se pueden borrar de Railway).
const ADMIN_EMAIL = "jota71663@gmail.com";
const JORGE_EMAIL = "jryesid@gmail.com";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || null;
const SEED_JORGE_PASSWORD = process.env.SEED_JORGE_PASSWORD || null;

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

function tableExists(name) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}
function hasColumn(table, col) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === col);
}

// ---- tablas que nunca tuvieron forma "single-tenant" ------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`);

// ---- helpers genéricos --------------------------------------------------
function round2(n) {
  return Math.round(n * 100) / 100;
}
function randBetween(min, max) {
  return Math.random() * (max - min) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function nowIso() {
  return new Date().toISOString();
}

function getSystemMeta(key) {
  const row = db.prepare("SELECT value FROM system_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
function setSystemMeta(key, value) {
  db.prepare(
    "INSERT INTO system_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, String(value));
}

function getMeta(userId, key) {
  const row = db
    .prepare("SELECT value FROM meta WHERE user_id = ? AND key = ?")
    .get(userId, key);
  return row ? row.value : null;
}
function setMeta(userId, key, value) {
  db.prepare(
    "INSERT INTO meta (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value"
  ).run(userId, key, String(value));
}

function getUserByEmail(email) {
  return db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(String(email).trim().toLowerCase());
}
function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function createUserRow(email, passwordHash, role) {
  const info = db
    .prepare(
      "INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?,?,?)"
    )
    .run(String(email).trim().toLowerCase(), passwordHash, role, nowIso());
  return info.lastInsertRowid;
}

// Deja a un usuario nuevo (role='user') exactamente en el mismo punto de
// partida con el que arrancaba esta app la primera vez que se desplegó:
// mismo saldo inicial y misma flota de bots semilla.
function bootstrapNewUserAutomaton(userId) {
  const now = nowIso();
  db.prepare(
    "INSERT INTO wallet (user_id, balance, updated_at) VALUES (?,?,?)"
  ).run(userId, STARTING_BALANCE, now);
  setMeta(userId, "boot_at", now);
  const insertBot = db.prepare(
    "INSERT INTO bots (user_id, label, created_at) VALUES (?,?,?)"
  );
  const seedBots = db.transaction((n) => {
    for (let i = 1; i <= n; i++) {
      insertBot.run(userId, `BOT-${String(i).padStart(3, "0")}`, now);
    }
  });
  seedBots(INITIAL_BOT_COUNT);
  setMeta(userId, "bot_count", String(INITIAL_BOT_COUNT));
  setMeta(userId, "bot_progress_net", "0");
}

// ---- migración de esquema (single-tenant -> multi-tenant) + seed de cuentas
// -----------------------------------------------------------------------------
// Si las tablas de datos (wallet/events/...) todavía tienen la forma vieja
// (sin columna user_id), significa que estamos corriendo por primera vez
// contra la base de datos de producción anterior a este cambio.
//
// TODO este bloque — detectar, renombrar las tablas viejas a "*_legacy"
// (nunca se borran, quedan de respaldo), crear las tablas nuevas, crear las
// cuentas admin/Jorge y copiar los datos — corre dentro de UNA sola
// transacción. Así, si el proceso se cae a la mitad (ej. el contenedor se
// reinicia justo en ese instante), en el próximo arranque no queda nada a
// medio migrar: o se aplicó todo, o no se aplicó nada y se reintenta desde
// cero de forma segura.
const legacyWalletDetected =
  tableExists("wallet") && !hasColumn("wallet", "user_id");
const SEED_KEY = "v2_multiuser_seed_done";

const runSchemaMigrationAndSeed = db.transaction(() => {
  if (legacyWalletDetected) {
    const legacyTables = [
      "wallet",
      "events",
      "planned_events",
      "withdrawals",
      "bots",
      "meta",
    ];
    for (const t of legacyTables) {
      if (tableExists(t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_legacy`);
    }
    console.log(
      "🗄️  Esquema anterior (single-tenant) detectado — tablas renombradas a *_legacy (no se borran, quedan de respaldo)."
    );
  }

  // Tablas multi-tenant: se crean limpias si no existían, o si se acaban de
  // liberar los nombres arriba. Esto corre en CADA arranque (idempotente),
  // no solo la primera vez.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      balance REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      ts TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('credit','debit')),
      amount REAL NOT NULL,
      label TEXT NOT NULL,
      balance_after REAL NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','withdrawal'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, id);
    CREATE TABLE IF NOT EXISTS planned_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      week_start TEXT NOT NULL,
      scheduled_ts TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('credit','debit')),
      amount REAL NOT NULL,
      label TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_planned_due ON planned_events (user_id, fired, scheduled_ts);
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      ts TEXT NOT NULL,
      address TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','auto_bot'))
    );
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      user_id INTEGER NOT NULL REFERENCES users(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
  `);

  // El seed de cuentas + migración de datos sí debe correr una sola vez
  // (igual que los ajustes de una sola vez que ya existían en este archivo,
  // guardado como bandera en system_meta).
  if (getSystemMeta(SEED_KEY)) return;

  {
    const adminAlreadyExists = !!getUserByEmail(ADMIN_EMAIL);
    const jorgeAlreadyExists = !!getUserByEmail(JORGE_EMAIL);
    const missingVars = [];
    if (!adminAlreadyExists && !SEED_ADMIN_PASSWORD) missingVars.push("SEED_ADMIN_PASSWORD");
    if (!jorgeAlreadyExists && !SEED_JORGE_PASSWORD) missingVars.push("SEED_JORGE_PASSWORD");
    if (missingVars.length > 0) {
      // Aborta TODA la transacción (nada de lo de arriba se guarda) en vez
      // de crear cuentas a medias o con una contraseña por defecto — más
      // seguro fallar fuerte y claro que arrancar en un estado inconsistente.
      throw new Error(
        `Faltan variables de entorno para crear las cuentas iniciales: ${missingVars.join(", ")}. ` +
          "Configúralas en Railway → Variables y vuelve a desplegar."
      );
    }

    let admin = getUserByEmail(ADMIN_EMAIL);
    if (!admin) {
      const id = createUserRow(
        ADMIN_EMAIL,
        bcrypt.hashSync(SEED_ADMIN_PASSWORD, 12),
        "admin"
      );
      console.log(`👤 Cuenta admin creada: ${ADMIN_EMAIL} (sin wallet propio).`);
      admin = getUserById(id);
    }

    let jorge = getUserByEmail(JORGE_EMAIL);
    const jorgeIsNew = !jorge;
    if (jorgeIsNew) {
      const id = createUserRow(
        JORGE_EMAIL,
        bcrypt.hashSync(SEED_JORGE_PASSWORD, 12),
        "user"
      );
      jorge = getUserById(id);
    }

    if (legacyWalletDetected) {
      // Copia el estado completo de la base de datos anterior (single-tenant)
      // a la cuenta de Jorge — sin perder ni alterar nada de lo que ya existía.
      const legacyWallet = tableExists("wallet_legacy")
        ? db.prepare("SELECT * FROM wallet_legacy WHERE id = 1").get()
        : null;
      if (legacyWallet) {
        db.prepare(
          "INSERT INTO wallet (user_id, balance, updated_at) VALUES (?,?,?)"
        ).run(jorge.id, legacyWallet.balance, legacyWallet.updated_at);
      }

      if (tableExists("events_legacy")) {
        const legacyEvents = db
          .prepare("SELECT * FROM events_legacy ORDER BY id ASC")
          .all();
        const insertEv = db.prepare(
          "INSERT INTO events (user_id, ts, type, amount, label, balance_after, kind) VALUES (?,?,?,?,?,?,?)"
        );
        for (const e of legacyEvents) {
          const kind = e.label && e.label.startsWith("Retiro a billetera")
            ? "withdrawal"
            : "task";
          insertEv.run(
            jorge.id,
            e.ts,
            e.type,
            e.amount,
            e.label,
            e.balance_after,
            kind
          );
        }
        console.log(`📜 Migrados ${legacyEvents.length} eventos históricos a Jorge.`);
      }

      if (tableExists("planned_events_legacy")) {
        const legacyPlanned = db
          .prepare("SELECT * FROM planned_events_legacy ORDER BY id ASC")
          .all();
        const insertPl = db.prepare(
          `INSERT INTO planned_events (user_id, week_start, scheduled_ts, type, amount, label, fired)
           VALUES (?,?,?,?,?,?,?)`
        );
        for (const p of legacyPlanned) {
          insertPl.run(
            jorge.id,
            p.week_start,
            p.scheduled_ts,
            p.type,
            p.amount,
            p.label,
            p.fired
          );
        }
      }

      if (tableExists("withdrawals_legacy")) {
        const legacyWithdrawals = db
          .prepare("SELECT * FROM withdrawals_legacy ORDER BY id ASC")
          .all();
        const insertW = db.prepare(
          "INSERT INTO withdrawals (user_id, ts, address, amount, balance_after, kind) VALUES (?,?,?,?,?,'manual')"
        );
        for (const w of legacyWithdrawals) {
          insertW.run(jorge.id, w.ts, w.address, w.amount, w.balance_after);
        }
        console.log(
          `💸 Migrados ${legacyWithdrawals.length} retiros históricos a Jorge.`
        );
      }

      if (tableExists("bots_legacy")) {
        const legacyBots = db
          .prepare("SELECT * FROM bots_legacy ORDER BY id ASC")
          .all();
        const insertB = db.prepare(
          "INSERT INTO bots (user_id, label, created_at) VALUES (?,?,?)"
        );
        for (const b of legacyBots) {
          insertB.run(jorge.id, b.label, b.created_at);
        }
        console.log(`🤖 Migrados ${legacyBots.length} bots a Jorge.`);
      }

      if (tableExists("meta_legacy")) {
        const legacyMeta = db.prepare("SELECT * FROM meta_legacy").all();
        for (const m of legacyMeta) {
          setMeta(jorge.id, m.key, m.value);
        }
      }

      console.log(
        "✅ Migración completa: el estado de producción existente ahora pertenece a la cuenta de Jorge (jryesid@gmail.com)."
      );
    } else if (jorgeIsNew) {
      // No había datos previos que migrar (base nueva) — Jorge arranca como
      // cualquier cuenta nueva.
      bootstrapNewUserAutomaton(jorge.id);
    }

    setSystemMeta(SEED_KEY, nowIso());
  }
});

try {
  runSchemaMigrationAndSeed();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}

// ---- Solana address validation ----------------------------------------------
// Solana public keys are base58-encoded 32-byte values. A regex alone only
// checks the character set (excludes 0/O/I/l, 32-44 chars) — decoding to
// confirm the payload is exactly 32 bytes catches malformed strings that
// happen to match the pattern but aren't a real key length.
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_MAP[BASE58_ALPHABET[i]] = i;

function base58Decode(str) {
  let bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (!(c in BASE58_MAP)) return null;
    let carry = BASE58_MAP[c];
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < str.length - 1 && str[k] === "1"; k++) {
    bytes.push(0);
  }
  return bytes.reverse();
}

function isValidSolanaAddress(address) {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return false;
  const decoded = base58Decode(trimmed);
  return !!decoded && decoded.length === 32;
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

// ---- weekly plan generation (por usuario) -----------------------------------
// `planFromDate` is where slot generation actually starts (normally very
// close to weekStartDate in steady state). When a plan is created mid-week —
// a fresh user creation mid-week — it's forced to "now" so the very first
// event is always at least EVENT_MIN_GAP_MS in the future, never a backlog of
// already-past timestamps that would burst-deliver on startup.
function generateWeeklyPlanIfMissing(userId, weekStartDate, planFromDate) {
  const weekStartKey = weekStartDate.toISOString();
  const existing = db
    .prepare(
      "SELECT COUNT(*) AS c FROM planned_events WHERE user_id = ? AND week_start = ?"
    )
    .get(userId, weekStartKey);
  if (existing.c > 0) return;

  const weekEndDate = weekEndFromStart(weekStartDate);
  const planStart =
    planFromDate && planFromDate.getTime() > weekStartDate.getTime()
      ? planFromDate
      : weekStartDate;

  // If the plan starts mid-week (user creation happened partway through),
  // scale the target proportionally to the time actually remaining —
  // asking a 3-hour tail-end of the week to hit a full week's $35-195
  // target with only 1-3 events isn't just unrealistic-looking, it can be
  // mathematically infeasible within the per-event $0.50-$25 credit cap.
  const fullWeekMs = weekEndDate.getTime() - weekStartDate.getTime();
  const remainingMs = Math.max(0, weekEndDate.getTime() - planStart.getTime());
  const timeFraction = Math.min(1, remainingMs / fullWeekMs);
  const scaledMin = Math.max(1, round2(WEEKLY_PROFIT_MIN * timeFraction));
  const scaledMax = Math.max(scaledMin, round2(WEEKLY_PROFIT_MAX * timeFraction));
  const target = round2(randBetween(scaledMin, scaledMax));

  // 1) lay out event timestamps from planStart through the end of the week,
  // 15min-3h apart — never before planStart, so nothing is already "due".
  const slots = [];
  let t = planStart.getTime() + randBetween(EVENT_MIN_GAP_MS, EVENT_MAX_GAP_MS);
  while (t <= weekEndDate.getTime()) {
    slots.push(t);
    t += randBetween(EVENT_MIN_GAP_MS, EVENT_MAX_GAP_MS);
  }
  if (slots.length === 0) {
    slots.push(
      Math.min(planStart.getTime() + EVENT_MIN_GAP_MS, weekEndDate.getTime())
    );
  }

  // 2) type each slot credit/debit
  const types = slots.map(() =>
    Math.random() < CREDIT_PROBABILITY ? "credit" : "debit"
  );

  // safety floor: at least 30% of slots must be credit so the bounded
  // partition below usually has enough room to hit the target
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
  let sumDebits = round2(
    debitAmounts.reduce((s, a) => s + (a || 0), 0)
  );

  // 4) credit amounts: bounded partition so total credits - total debits = target
  let creditIdx = types
    .map((ty, i) => (ty === "credit" ? i : -1))
    .filter((i) => i >= 0);

  // Hard feasibility guarantee: with n credit slots capped at CREDIT_MAX
  // each, the target is only reachable if n*CREDIT_MAX >= target+sumDebits.
  // If not (very few slots, e.g. a short tail-end week), convert debit
  // slots to credit — which helps twice: fewer debits to cover, more
  // credit slots to cover them with — until it's provably reachable.
  while (
    creditIdx.length * CREDIT_MAX < round2(target + sumDebits) &&
    types.includes("debit")
  ) {
    const debitIdx = types.findIndex((ty) => ty === "debit");
    sumDebits = round2(sumDebits - debitAmounts[debitIdx]);
    debitAmounts[debitIdx] = null;
    types[debitIdx] = "credit";
    creditIdx.push(debitIdx);
  }

  const creditTargetSum = round2(target + sumDebits);
  const creditAmounts = partitionBounded(
    creditTargetSum,
    creditIdx.length,
    CREDIT_MIN,
    CREDIT_MAX
  );

  // 5) assemble + insert
  const insertPlanned = db.prepare(
    `INSERT INTO planned_events (user_id, week_start, scheduled_ts, type, amount, label, fired)
     VALUES (?,?,?,?,?,?,0)`
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insertPlanned.run(...r);
  });

  let ci = 0;
  const rows = [];
  for (let i = 0; i < slots.length; i++) {
    const ts = new Date(slots[i]).toISOString();
    if (types[i] === "credit") {
      rows.push([
        userId,
        weekStartKey,
        ts,
        "credit",
        creditAmounts[ci++],
        pick(TASK_NAMES),
      ]);
    } else {
      rows.push([
        userId,
        weekStartKey,
        ts,
        "debit",
        debitAmounts[i],
        pick(DEBIT_REASONS),
      ]);
    }
  }
  insertMany(rows);

  setMeta(userId, `week_target_${weekStartKey}`, String(target));

  const actualCreditSum = round2(creditAmounts.reduce((s, a) => s + a, 0));
  const scaleNote =
    timeFraction < 0.999
      ? ` (semana parcial, ${Math.round(timeFraction * 100)}% del tiempo — rango escalado a $${scaledMin}-$${scaledMax})`
      : "";
  console.log(
    `📅 [user ${userId}] Plan semanal generado: semana ${weekStartKey} (eventos desde ${planStart.toISOString()}) → objetivo neto $${target}${scaleNote} ` +
      `(créditos $${actualCreditSum} - débitos $${sumDebits} = $${round2(
        actualCreditSum - sumDebits
      )}), ${rows.length} eventos`
  );
}

function ensureCurrentWeekPlanned(userId) {
  const now = new Date();
  generateWeeklyPlanIfMissing(userId, currentWeekStart(now), now);
}

// ---- wallet / events / bots helpers (por usuario) ---------------------------
const getWalletStmt = db.prepare("SELECT * FROM wallet WHERE user_id = ?");
const updateWalletStmt = db.prepare(
  "UPDATE wallet SET balance = ?, updated_at = ? WHERE user_id = ?"
);
const insertEventStmt = db.prepare(
  "INSERT INTO events (user_id, ts, type, amount, label, balance_after, kind) VALUES (?,?,?,?,?,?,?)"
);
const recentEventsStmt = db.prepare(
  "SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?"
);
const taskEventsSinceStmt = db.prepare(
  "SELECT * FROM events WHERE user_id = ? AND kind = 'task' AND ts >= ? ORDER BY id ASC"
);

function getWallet(userId) {
  return getWalletStmt.get(userId);
}
function updateWallet(userId, balance, ts) {
  updateWalletStmt.run(balance, ts, userId);
}
function insertEvent(userId, ts, type, amount, label, balanceAfter, kind) {
  insertEventStmt.run(userId, ts, type, amount, label, balanceAfter, kind);
}

// Retiro automático de $50 a la dirección fija, disparado cada vez que se
// crea un bot nuevo. Si el saldo es menor a $50, se retira lo que haya
// disponible (retiro parcial) en vez de omitirlo o dejar el saldo negativo.
// No cuenta para la regla de ganancia semanal ni para el progreso de bots —
// por eso NO pasa por recordEvent()/updateBotProgress(), igual que un retiro
// manual, y se marca kind='withdrawal' para quedar excluido de esos cálculos.
function autoWithdrawOnBotCreation(userId) {
  const wallet = getWallet(userId);
  if (!wallet) return;
  const amt = round2(Math.min(AUTO_WITHDRAW_USD, Math.max(0, wallet.balance)));
  if (amt <= 0) {
    console.log(
      `⚠️  [user ${userId}] Bot nuevo creado pero saldo es $0 — se omite el retiro automático.`
    );
    return;
  }
  const partial = amt < AUTO_WITHDRAW_USD;
  const label =
    "Retiro automático — bot duplicado" + (partial ? " (parcial, saldo insuficiente)" : "");
  const newBalance = round2(wallet.balance - amt);
  const now = nowIso();
  updateWallet(userId, newBalance, now);
  insertEvent(userId, now, "debit", amt, label, newBalance, "withdrawal");
  db.prepare(
    "INSERT INTO withdrawals (user_id, ts, address, amount, balance_after, kind) VALUES (?,?,?,?,?,'auto_bot')"
  ).run(userId, now, AUTO_WITHDRAW_ADDRESS, amt, newBalance);
  console.log(
    `💸 [user ${userId}] Retiro automático de $${amt}${partial ? " (parcial)" : ""} por bot duplicado.`
  );
}

function createNewBot(userId) {
  const countRaw = getMeta(userId, "bot_count");
  let count = countRaw ? parseInt(countRaw, 10) : INITIAL_BOT_COUNT;
  count += 1;
  const label = `BOT-${String(count).padStart(3, "0")}`;
  const now = nowIso();
  db.prepare("INSERT INTO bots (user_id, label, created_at) VALUES (?,?,?)").run(
    userId,
    label,
    now
  );
  setMeta(userId, "bot_count", String(count));
  console.log(
    `🤖 [user ${userId}] Nuevo bot creado: ${label} (ganancia neta acumulada alcanzó un múltiplo de $${BOT_MILESTONE_USD})`
  );
  autoWithdrawOnBotCreation(userId);
}

// Advances the running "net profit toward next bot" counter and creates as
// many bots as the delta earns (handles a single large credit crossing
// several $150 milestones at once). Only called for task credit/debit
// events — withdrawals never touch this.
function updateBotProgress(userId, netDelta) {
  let progress = parseFloat(getMeta(userId, "bot_progress_net") || "0");
  progress = round2(progress + netDelta);
  while (progress >= BOT_MILESTONE_USD) {
    progress = round2(progress - BOT_MILESTONE_USD);
    createNewBot(userId);
  }
  setMeta(userId, "bot_progress_net", String(progress));
}

function recordEvent(userId, type, amount, label) {
  const wallet = getWallet(userId);
  const newBalance = round2(
    type === "credit" ? wallet.balance + amount : wallet.balance - amount
  );
  const now = nowIso();
  updateWallet(userId, newBalance, now);
  insertEvent(userId, now, type, amount, label, newBalance, "task");
  updateBotProgress(userId, type === "credit" ? amount : -amount);
}

function deliverDuePlannedEvents(userId) {
  const due = db
    .prepare(
      "SELECT * FROM planned_events WHERE user_id = ? AND fired = 0 AND scheduled_ts <= ? ORDER BY scheduled_ts ASC"
    )
    .all(userId, nowIso());
  for (const ev of due) {
    recordEvent(userId, ev.type, ev.amount, ev.label);
    db.prepare("UPDATE planned_events SET fired = 1 WHERE id = ?").run(ev.id);
  }
}

function allAutomatonUserIds() {
  return db
    .prepare("SELECT id FROM users WHERE role = 'user'")
    .all()
    .map((r) => r.id);
}

function ensureAllUsersPlanned() {
  for (const uid of allAutomatonUserIds()) ensureCurrentWeekPlanned(uid);
}
function deliverAllDuePlannedEvents() {
  for (const uid of allAutomatonUserIds()) deliverDuePlannedEvents(uid);
}

if (SIMULATION_ENABLED) {
  ensureAllUsersPlanned();
  deliverAllDuePlannedEvents(); // catch up on anything missed while the server was down
  setInterval(ensureAllUsersPlanned, 15 * 60 * 1000); // re-check every 15 min for the next week
  setInterval(deliverAllDuePlannedEvents, 60 * 1000); // deliver due events every minute
  console.log(
    "Simulación activa: eventos 15min–3h, cerrando cada semana (Colombia) con ganancia neta entre " +
      `$${WEEKLY_PROFIT_MIN} y $${WEEKLY_PROFIT_MAX}, por cada usuario registrado.`
  );
} else {
  console.log(
    "Simulación pausada (SIMULATION_ENABLED=false) — el saldo y el historial quedan congelados para todos los usuarios."
  );
}

// ---- sesiones -----------------------------------------------------------
const SESSION_COOKIE = "automaton_sid";
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // respaldo server-side; la cookie en sí es de sesión de navegador

function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_MS);
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)"
  ).run(id, userId, now.toISOString(), expiresAt.toISOString());
  return id;
}
function destroySession(id) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}
function getSessionUser(sid) {
  if (!sid) return null;
  const row = db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ? AND sessions.expires_at > ?`
    )
    .get(sid, nowIso());
  return row || null;
}

// Hash fijo usado solo para que bcrypt.compare tarde lo mismo cuando el
// email no existe — evita que el tiempo de respuesta delate qué emails
// están registrados.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 12);

// ---- http api -----------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // Railway termina TLS y reenvía X-Forwarded-Proto
app.disable("x-powered-by");
app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  const sid = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  req.user = getSessionUser(sid);
  req.sessionId = sid || null;
  next();
});

function requireAuthApi(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "No autenticado." });
  next();
}
function requireRoleApi(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "No autenticado." });
    if (req.user.role !== role)
      return res.status(403).json({ error: "No autorizado." });
    next();
  };
}

// Busca un archivo de forma case-insensitive (Linux/Railway distingue
// mayúsculas de minúsculas — "Index.html" NO es lo mismo que "index.html").
function findFileCaseInsensitive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  const match = fs
    .readdirSync(dir)
    .find((f) => f.toLowerCase() === filename.toLowerCase());
  return match ? path.join(dir, match) : null;
}

const publicDir = path.join(__dirname, "public");

function findIndexHtml(dir) {
  return findFileCaseInsensitive(dir, "index.html");
}

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

const loginPath =
  findFileCaseInsensitive(publicDir, "login.html") ||
  path.join(publicDir, "login.html");
const adminPath =
  findFileCaseInsensitive(publicDir, "admin.html") ||
  path.join(publicDir, "admin.html");

function landingFor(user) {
  if (!user) return "/login";
  return user.role === "admin" ? "/admin" : "/";
}

// ---- páginas (protegidas antes de exponer los estáticos) --------------------
app.get(["/login", "/login.html"], (req, res) => {
  if (req.user) return res.redirect(landingFor(req.user));
  if (!fs.existsSync(loginPath)) {
    return res.status(500).send("Falta public/login.html en el deploy.");
  }
  res.sendFile(loginPath);
});

app.get(["/admin", "/admin.html"], (req, res) => {
  if (!req.user) return res.redirect("/login");
  if (req.user.role !== "admin") return res.redirect("/");
  if (!fs.existsSync(adminPath)) {
    return res.status(500).send("Falta public/admin.html en el deploy.");
  }
  res.sendFile(adminPath);
});

app.get(["/", /^\/index\.html$/i], (req, res) => {
  if (!req.user) return res.redirect("/login");
  if (req.user.role !== "user") return res.redirect(landingFor(req.user));
  if (!fs.existsSync(indexPath)) {
    return res
      .status(500)
      .send(
        "Falta index.html en el deploy. Revisa que el archivo esté commiteado en el repo (en public/ o en la raíz)."
      );
  }
  res.sendFile(indexPath);
});

app.use(express.static(staticDir, { index: false }));

// ---- auth api -----------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son obligatorios." });
    }
    const user = getUserByEmail(email);
    const ok = await bcrypt.compare(
      String(password),
      user ? user.password_hash : DUMMY_PASSWORD_HASH
    );
    if (!user || !ok) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
    const sid = createSession(user.id);
    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      path: "/",
      // sin maxAge/expires a propósito: cookie de sesión de navegador.
    });
    res.json({ ok: true, role: user.role, redirect: landingFor(user) });
  } catch (err) {
    // bcrypt.compare es async — si llegara a rechazar, un throw sin capturar
    // aquí se perdería como unhandled rejection y podría tumbar el proceso
    // para TODOS los usuarios (multi-tenant). Mejor responder 500 y loguear.
    console.error("Error en /api/login:", err);
    res.status(500).json({ error: "Error interno del servidor." });
  }
});

app.post("/api/logout", (req, res) => {
  if (req.sessionId) destroySession(req.sessionId);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireAuthApi, (req, res) => {
  res.json({ email: req.user.email, role: req.user.role });
});

// ---- admin api ------------------------------------------------------------
app.get("/api/admin/users", requireRoleApi("admin"), (req, res) => {
  const users = db
    .prepare("SELECT id, email, role, created_at FROM users ORDER BY id ASC")
    .all();
  const enriched = users.map((u) => {
    if (u.role !== "user") return u;
    const wallet = getWallet(u.id);
    const botCount = getMeta(u.id, "bot_count");
    return {
      ...u,
      balance: wallet ? wallet.balance : null,
      bot_count: botCount ? parseInt(botCount, 10) : null,
    };
  });
  res.json(enriched);
});

app.post("/api/admin/users", requireRoleApi("admin"), (req, res) => {
  const { email, password } = req.body || {};
  // Charset restringido a propósito (nada de <>"'&\` ni espacios): el admin
  // panel muestra este email luego en la lista de cuentas, y así queda
  // excluida cualquier posibilidad de inyectar HTML/JS vía el email.
  if (
    !email ||
    typeof email !== "string" ||
    !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim())
  ) {
    return res.status(400).json({ error: "Ingresa un email válido." });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res
      .status(400)
      .json({ error: "La contraseña debe tener al menos 8 caracteres." });
  }
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
  }

  let userId;
  try {
    const passwordHash = bcrypt.hashSync(password, 12);
    // Atómico: si bootstrapNewUserAutomaton fallara a mitad de camino, no
    // debe quedar un usuario a medias sin wallet/bots.
    userId = db.transaction(() => {
      const id = createUserRow(email, passwordHash, "user");
      bootstrapNewUserAutomaton(id);
      return id;
    })();
  } catch (err) {
    if (String(err.code).startsWith("SQLITE_CONSTRAINT")) {
      // Otra petición creó el mismo email en el instante entre el check de
      // arriba y este insert.
      return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
    }
    throw err;
  }
  ensureCurrentWeekPlanned(userId);

  const created = getUserById(userId);
  res.status(201).json({
    id: created.id,
    email: created.email,
    role: created.role,
    created_at: created.created_at,
    balance: STARTING_BALANCE,
    bot_count: INITIAL_BOT_COUNT,
  });
});

// ---- automaton api (solo cuentas role='user', cada una ve SOLO lo suyo) ----
app.get("/api/status", requireRoleApi("user"), (req, res) => {
  const userId = req.user.id;
  const wallet = getWallet(userId);
  const bootAt = getMeta(userId, "boot_at");

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todays = taskEventsSinceStmt.all(userId, startOfDay.toISOString());
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
  const weekTarget = getMeta(userId, `week_target_${weekStartKey}`);
  const weekEvents = taskEventsSinceStmt.all(userId, weekStartKey);
  const weekNet = round2(
    weekEvents.reduce(
      (s, e) => s + (e.type === "credit" ? e.amount : -e.amount),
      0
    )
  );

  res.json({
    balance: wallet.balance,
    updated_at: wallet.updated_at,
    boot_at: bootAt,
    monthly_maintenance: MONTHLY_MAINTENANCE,
    daily_maintenance: round2(dailyMaintenance),
    runway_days: round2(daysOfRunwayLeft),
    alive: wallet.balance > 0,
    today_credit: todayCredit,
    today_debit: todayDebit,
    today_net: round2(todayCredit - todayDebit),
    today_events: todays.length,
    week_start: weekStartKey,
    week_target: weekTarget ? parseFloat(weekTarget) : null,
    week_net_so_far: weekNet,
  });
});

app.get("/api/events", requireRoleApi("user"), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  res.json(recentEventsStmt.all(req.user.id, limit));
});

app.post("/api/withdraw", requireRoleApi("user"), (req, res) => {
  const userId = req.user.id;
  const { address, amount } = req.body || {};

  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "La dirección es obligatoria." });
  }
  const trimmedAddress = address.trim();
  if (!isValidSolanaAddress(trimmedAddress)) {
    return res
      .status(400)
      .json({ error: "La dirección no tiene un formato válido de Solana." });
  }

  const amt = round2(parseFloat(amount));
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ error: "El monto debe ser mayor a 0." });
  }

  const wallet = getWallet(userId);
  if (amt > wallet.balance) {
    return res.status(400).json({ error: "Saldo insuficiente para ese retiro." });
  }

  const newBalance = round2(wallet.balance - amt);
  const now = nowIso();
  const shortAddr = `${trimmedAddress.slice(0, 4)}…${trimmedAddress.slice(-4)}`;

  updateWallet(userId, newBalance, now);
  insertEvent(
    userId,
    now,
    "debit",
    amt,
    `Retiro a billetera — ${shortAddr}`,
    newBalance,
    "withdrawal"
  );
  db.prepare(
    "INSERT INTO withdrawals (user_id, ts, address, amount, balance_after, kind) VALUES (?,?,?,?,?,'manual')"
  ).run(userId, now, trimmedAddress, amt, newBalance);

  res.json({ ok: true, balance: newBalance, amount: amt, address: trimmedAddress });
});

app.get("/api/withdrawals", requireRoleApi("user"), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  res.json(
    db
      .prepare(
        "SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?"
      )
      .all(req.user.id, limit)
  );
});

app.get("/api/bots", requireRoleApi("user"), (req, res) => {
  const userId = req.user.id;
  const countRaw = getMeta(userId, "bot_count");
  const progressRaw = getMeta(userId, "bot_progress_net");
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  res.json({
    count: countRaw ? parseInt(countRaw, 10) : INITIAL_BOT_COUNT,
    progress_to_next: progressRaw ? parseFloat(progressRaw) : 0,
    milestone_usd: BOT_MILESTONE_USD,
    bots: db
      .prepare("SELECT * FROM bots WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .all(userId, limit),
  });
});

// Manejador de errores final: cualquier excepción no capturada en una ruta
// (sync o pasada vía next(err)) termina aquí en vez de dejar que el
// manejador por defecto de Express filtre el stack trace al cliente cuando
// NODE_ENV no está en "production".
app.use((err, req, res, next) => {
  console.error("Error no manejado:", err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status < 500 ? "Solicitud inválida." : "Error interno del servidor.",
  });
});

app.listen(PORT, () => {
  console.log(`Automaton simulation running on http://localhost:${PORT}`);
  console.log(`DB persisted at ${DB_PATH}`);
});
