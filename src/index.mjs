#!/usr/bin/env node
/**
 * bothelp-mcp — MCP-сервер для чтения и СБОРКИ сценариев ботов в BotHelp
 * (Telegram/VK/MAX/WhatsApp) через приватный WebSocket-RPC конструктора «flow2».
 *
 * Публичный Open API BotHelp (api.bothelp.io) сценарии только читает и запускает.
 * Сам конструктор правит граф через WS `wss://<host>/ws/<id>` (библиотека Primus):
 *   send    {"method":"evXxx","data":<...>,"uid":"<rand>"}
 *   receive {"event":"<uid>","data":<...>}
 * Этот MCP — тонкая обёртка над теми же методами (по аналогии с zaytsv-mcp).
 *
 * Авторизация (сессия оператора, не Open-API токен):
 *   1) GET https://<sub>.bothelp.io/session/<sub>/<sessionId>  → {sessionId, operator, wsUrl}
 *   2) открыть ws по wsUrl, отправить authHandshake {sessionId}
 * sessionId берётся из залогиненной вкладки конструктора (DevTools → WS → authHandshake).
 *
 * ENV: BOTHELP_SUBDOMAIN, BOTHELP_SESSION_ID, BOTHELP_COOKIE
 * Zero-dep на Node ≥22 (глобальный WebSocket). На Node <22 — `npm i ws` (авто-фолбэк).
 */

import { createInterface } from "node:readline";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const VERSION = "0.1.0";
const CONFIG_DIR = path.join(os.homedir(), ".bothelp-mcp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// ---------- config / auth ----------
function readCfgFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
// Claude Code при незаданной env отдаёт литерал "${VAR}" — его нельзя считать значением.
function envVal(v) { const s = (v || "").trim(); return s && !s.startsWith("${") ? s : ""; }
function getCfg() {
  const f = readCfgFile();
  return {
    subdomain: envVal(process.env.BOTHELP_SUBDOMAIN) || f.subdomain || "",
    sessionId: envVal(process.env.BOTHELP_SESSION_ID) || f.sessionId || "",
    cookie:    envVal(process.env.BOTHELP_COOKIE)     || f.cookie    || "",
  };
}
function saveCfg(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...readCfgFile(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* windows */ }
  return next;
}
function isAuthed() { const c = getCfg(); return !!(c.subdomain && c.sessionId); }

const NO_AUTH_HELP =
  "Нет доступа к конструктору BotHelp — не настроена сессия.\n\n" +
  "ПРОЩЕ ВСЕГО (login_password): пришли subdomain (воркспейс, напр. `formula`) + email + пароль\n" +
  "от аккаунта BotHelp — я вызову login_password, получу sessionId сам и сохраню.\n\n" +
  "Альтернатива (set_session, без пароля):\n" +
  "1) Залогинься в воркспейс и открой любой сценарий (https://<workspace>.bothelp.io/flow2/flow-builder/<id>/edit).\n" +
  "2) DevTools (F12) → Network → фильтр WS → соединение `/ws/...` → Messages.\n" +
  "3) Первый ОТПРАВЛЕННЫЙ кадр = {\"method\":\"authHandshake\",\"data\":{\"sessionId\":\"...\"}} — скопируй sessionId.\n" +
  "4) subdomain = `<workspace>` из адреса. Вызови set_session (subdomain + sessionId).\n\n" +
  "Подсказка ассистенту: попроси email+пароль → login_password; либо subdomain+sessionId → set_session.";

// ---------- WebSocket transport (Primus-совместимо) ----------
let WSImpl = globalThis.WebSocket;
async function getWS() {
  if (WSImpl) return WSImpl;
  try { WSImpl = (await import("ws")).default; return WSImpl; }
  catch { throw new Error("Нужен Node ≥22 (глобальный WebSocket) или пакет ws. Обнови Node, либо `npm i ws`."); }
}

// Нормализуем оба API (глобальный undici WebSocket и пакет ws) к одному виду.
async function openSocket(url, origin) {
  const Impl = await getWS();
  const isPkg = Impl !== globalThis.WebSocket;
  const sock = isPkg ? new Impl(url, { headers: origin ? { Origin: origin } : {} }) : new Impl(url);
  const wire = (evt, fn) => { if (sock.addEventListener) sock.addEventListener(evt, fn); else sock.on(evt, fn); };
  return {
    raw: sock,
    send: (s) => sock.send(s),
    close: () => { try { sock.close(); } catch { /* ignore */ } },
    onOpen: (fn) => wire("open", () => fn()),
    onMessage: (fn) => wire("message", (ev) => fn(isPkg ? String(ev) : String(ev.data))),
    onClose: (fn) => wire("close", () => fn()),
    onError: (fn) => wire("error", (e) => fn(e)),
  };
}

export const genUid = () =>
  crypto.randomBytes(6).toString("hex").replace(/^(.{8})(.{4})$/, "$1-$2");

// Обработка входящего текстового кадра: heartbeat Primus + сопоставление event→uid.
export function handleMsg(c, s) {
  if (s.startsWith('"primus::ping::')) { try { c.sock.send(s.replace("ping", "pong")); } catch { /* ignore */ } return; }
  if (s.startsWith('"primus::pong::')) return;
  let o; try { o = JSON.parse(s); } catch { return; }
  if (o && o.event && c.pending.has(o.event)) {
    const p = c.pending.get(o.event);
    c.pending.delete(o.event);
    clearTimeout(p.timer);
    p.resolve(o.data);
  }
  // прочее (pushNewMessage, pushTriggerChange, ...) — серверные push-события, игнорируем
}

export function rpcOn(c, method, data, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const uid = genUid();
    const timer = setTimeout(() => { c.pending.delete(uid); reject(new Error(`RPC ${method} — таймаут ${timeout}мс`)); }, timeout);
    if (timer.unref) timer.unref();
    c.pending.set(uid, { resolve, reject, timer });
    try { c.sock.send(JSON.stringify({ method, data, uid })); }
    catch (e) { clearTimeout(timer); c.pending.delete(uid); reject(e); }
  });
}

let conn = null, connecting = null;

// Упрощённый логин по email/паролю → sessionId (реверс формы auth.bothelp.io):
// POST https://<sub>.bothelp.io/login/<sub>?source=web  {login,password} → {sessionId|sessionToken}
async function passwordLogin(subdomain, email, password) {
  const url = `https://${subdomain}.bothelp.io/login/${encodeURIComponent(subdomain)}?source=web`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: `https://${subdomain}.bothelp.io`,
        Referer: `https://${subdomain}.bothelp.io/auth`,
      },
      body: JSON.stringify({ login: email, password }),
    });
  } catch (e) { throw new Error(`Не достучались до ${subdomain}.bothelp.io: ${e?.message || e}`); }
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`Логин отклонён (HTTP ${res.status}). ${text.slice(0, 200)}`);
  if (data && data.error) throw new Error(`Логин отклонён: ${JSON.stringify(data.error)} (обычно неверный email/пароль).`);
  const sid = data && (data.sessionId || data.sessionToken);
  if (!sid) throw new Error(`Логин не вернул sessionId. Проверь subdomain/email/пароль. Ответ: ${text.slice(0, 200)}`);
  return String(sid);
}

// Гарантировать сессию: если не задана, но в env есть BOTHELP_EMAIL/PASSWORD (+SUBDOMAIN) — авто-логин.
async function ensureSession() {
  if (isAuthed()) return;
  const sub = envVal(process.env.BOTHELP_SUBDOMAIN);
  const email = envVal(process.env.BOTHELP_EMAIL);
  const pw = envVal(process.env.BOTHELP_PASSWORD);
  if (sub && email && pw) { saveCfg({ subdomain: sub, sessionId: await passwordLogin(sub, email, pw) }); return; }
  throw new Error(NO_AUTH_HELP);
}

async function resolveSession() {
  const { subdomain, sessionId, cookie } = getCfg();
  const url = `https://${subdomain}.bothelp.io/session/${encodeURIComponent(subdomain)}/${encodeURIComponent(sessionId)}`;
  let res;
  try { res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} }); }
  catch (e) { throw new Error(`Не достучались до ${subdomain}.bothelp.io: ${e?.message || e}`); }
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    throw new Error(`Сессия недействительна (HTTP ${res.status}). sessionId истёк или неверный subdomain.\n` +
      "Возьми свежий sessionId из DevItools → WS → authHandshake и вызови set_session. " +
      "Если бэкенд требует куку — передай её тоже (set_session cookie).");
  }
  if (!res.ok) throw new Error(`GET /session → HTTP ${res.status}. ${text.slice(0, 300)}`);
  let data; try { data = JSON.parse(text); } catch { throw new Error("Ответ /session не JSON — вероятно, редирект на логин. Проверь sessionId/куку."); }
  if (!data.wsUrl || !data.wsUrl.host) throw new Error("В ответе /session нет wsUrl — сессия не активна.");
  return { wsUrl: data.wsUrl, sessionId: data.sessionId || sessionId, operator: data.operator || null };
}

async function connect() {
  if (conn && conn.ready && conn.sock.raw.readyState === 1) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    await ensureSession();
    const { subdomain } = getCfg();
    const info = await resolveSession();
    const endpoint = `${info.wsUrl.proto}://${info.wsUrl.host}${info.wsUrl.pathname}`;
    const sock = await openSocket(endpoint, `https://${subdomain}.bothelp.io`);
    const c = { sock, pending: new Map(), operator: null, ready: false, ping: null };
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("WS: таймаут подключения (15с)")), 15000);
      if (to.unref) to.unref();
      sock.onOpen(() => { clearTimeout(to); res(); });
      sock.onError((e) => { clearTimeout(to); rej(new Error("WS ошибка: " + (e?.message || e))); });
    });
    sock.onMessage((s) => handleMsg(c, s));
    sock.onClose(() => {
      for (const [, p] of c.pending) { clearTimeout(p.timer); p.reject(new Error("WS закрыт")); }
      c.pending.clear();
      if (c.ping) clearInterval(c.ping);
      if (conn === c) conn = null;
    });
    const hs = await rpcOn(c, "authHandshake", { sessionId: info.sessionId }, 15000);
    if (hs && hs.error) throw new Error("authHandshake отклонён: " + JSON.stringify(hs.error));
    c.operator = (hs && hs.operator) || info.operator || null;
    c.ready = true;
    c.ping = setInterval(() => { try { c.sock.send(JSON.stringify("primus::ping::" + Date.now())); } catch { /* ignore */ } }, 25000);
    if (c.ping.unref) c.ping.unref();
    return c;
  })()
    .then((c) => { conn = c; return c; })
    .finally(() => { connecting = null; });
  return connecting;
}

async function rpc(method, data, timeout) { const c = await connect(); return rpcOn(c, method, data, timeout); }

// ---------- граф: сводка + извлечение рёбер ----------
// Переходы в BotHelp зашиты экшенами {action:"run_bot", value:"<referral цели>"} —
// в кнопках, в conditions.positive/negative и в block.actions. Глубокий скан их собирает.
export function deepRunBot(obj, out) {
  if (Array.isArray(obj)) { for (const x of obj) deepRunBot(x, out); return; }
  if (obj && typeof obj === "object") {
    if (obj.action === "run_bot" && obj.value != null) out.push(String(obj.value));
    for (const k in obj) deepRunBot(obj[k], out);
  }
}

export function scenarioSummary(d) {
  const cb = d.complexBot || {};
  const coords = {};
  for (const p of (d.diagram?.coordinates || [])) coords[p.referral] = { x: Math.round(p.x), y: Math.round(p.y) };
  const steps = (d.steps || []).map((s) => {
    const t = []; deepRunBot(s, t);
    return {
      referral: s.referral, id: s.id, type: s.type,
      title: s.title || s.name || null,
      parent: s.parentReferral || null,
      pos: coords[s.referral] || null,
      to: [...new Set(t)],
    };
  });
  return {
    id: cb.id, referral: cb.referral, title: cb.title, enabled: cb.enabled,
    startStep: cb.startStepReferral,
    counts: { steps: steps.length, edges: steps.reduce((n, s) => n + s.to.length, 0) },
    steps,
  };
}

function readJsonFile(p) {
  const abs = path.resolve(String(p).replace(/^~(?=$|[/\\])/, os.homedir()));
  let raw; try { raw = fs.readFileSync(abs, "utf8"); } catch { throw new Error(`Файл не найден: ${abs}`); }
  try { return JSON.parse(raw); } catch (e) { throw new Error(`Невалидный JSON: ${abs}. ${e?.message || e}`); }
}

// ---------- MCP tools ----------
const TOOLS = [
  { name: "setup", description: "Показать статус авторизации и пошаговую инструкцию подключения. Вызывай первым при незнании, что делать, или при ошибке доступа.", inputSchema: { type: "object", properties: {} } },
  { name: "login_password", description: "УПРОЩЁННЫЙ вход: по subdomain + email + паролю от аккаунта BotHelp получить sessionId и сохранить сессию (реверс формы логина: POST /login/<sub>?source=web). Не нужен DevTools. Пароль нигде не сохраняется — хранится только полученный sessionId.", inputSchema: { type: "object", properties: { subdomain: { type: "string", description: "Воркспейс, часть <sub>.bothelp.io (напр. formula)" }, email: { type: "string" }, password: { type: "string" } }, required: ["subdomain", "email", "password"] } },
  { name: "set_session", description: "Сохранить сессию конструктора BotHelp: subdomain (воркспейс, напр. `formula`) и sessionId (из DevTools → WS → authHandshake). Опц. cookie, если бэкенд её требует. Применяется сразу. Альтернатива login_password.", inputSchema: { type: "object", properties: { subdomain: { type: "string", description: "Поддомен воркспейса, часть <sub>.bothelp.io" }, sessionId: { type: "string", description: "sessionId из кадра authHandshake" }, cookie: { type: "string", description: "(необязательно) заголовок Cookie для /session" } }, required: ["subdomain", "sessionId"] } },
  { name: "whoami", description: "Проверить сессию: подключиться и вернуть оператора (id, login, name). Быстрый тест авторизации.", inputSchema: { type: "object", properties: {} } },
  { name: "list_scenarios", description: "Список сценариев (complexBots) воркспейса: id, referral, title, enabled, adapterType. id нужен для get_scenario/add_block/save_layout.", inputSchema: { type: "object", properties: {} } },
  { name: "list_funnels", description: "Список воронок (funnels): id, referral, title, isEnabled. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_scenario", description: "Получить сценарий по id (evGetComplexBot). Граф БОЛЬШОЙ (могут быть сотни блоков, >100КБ) — по умолчанию отдаётся summary (узлы: referral/type/title/позиция + рёбра `to` из run_bot). raw:true — полный JSON; saveToFile — записать полный граф на диск и вернуть только сводку+путь.", inputSchema: { type: "object", properties: { id: { type: "string" }, raw: { type: "boolean", description: "true = полный JSON сценария целиком" }, saveToFile: { type: "string", description: "Путь: записать полный граф (JSON) на диск, вернуть сводку + путь" } }, required: ["id"] } },
  { name: "add_block", description: "Создать/обновить блок сценария (evAddBot). Передай bot-объект инлайном (bot) или файлом (botFile). Форма: {id?, title, referral, adapterType, adapterConnectorId, parentReferral, enabled, aiAgent, flowData:{steps:[...]}}. Переходы задаются экшенами {action:'run_bot', value:'<referral цели>'} в кнопках/условиях. Возвращает сохранённый блок (type=fb-referral/action/condition/delay).", inputSchema: { type: "object", properties: { bot: { type: "object", description: "Объект блока (обёртка {bot:...} добавляется автоматически)" }, botFile: { type: "string", description: "Путь к локальному JSON блока вместо инлайн bot" } } } },
  { name: "delete_block", description: "Удалить блок по числовому id (evDeleteBot → {success:true}).", inputSchema: { type: "object", properties: { id: { type: "string", description: "числовой id блока (поле id, не referral)" } }, required: ["id"] } },
  { name: "save_layout", description: "Сохранить раскладку канваса (evPutComplexBotDiagram): координаты узлов. Передай complexBotId и coordinates:[{referral,x,y}]. Делай ПОСЛЕ add_block, чтобы новый блок встал на место.", inputSchema: { type: "object", properties: { complexBotId: { type: "string" }, coordinates: { type: "array", items: { type: "object", properties: { referral: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["referral", "x", "y"] } } }, required: ["complexBotId", "coordinates"] } },
  { name: "update_scenario", description: "Сохранить настройки сценария / точку входа (evPutComplexBot). Передай complexBot-объект (в т.ч. startStepReferral — какой блок стартовый, title, enabled). Обёртка {complexBot:...} добавляется автоматически.", inputSchema: { type: "object", properties: { complexBot: { type: "object" }, complexBotFile: { type: "string", description: "Путь к локальному JSON вместо инлайн complexBot" } } } },
  { name: "get_triggers", description: "Триггеры сценария (evGetTriggersComplexBot): точки входа/автоправила. Read-only.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "call", description: "Escape-hatch: вызвать ЛЮБОЙ ev-метод конструктора напрямую (весь API — однородный WS-RPC). method — имя (напр. evGetComplexBots, evCopyComplexBotByToken, evGenerateComplexBotToken), data — payload любого типа (объект/строка/число/массив), как в кадре {method,data,uid}. Для методов, у которых нет отдельной обёртки.", inputSchema: { type: "object", properties: { method: { type: "string", description: "имя ev-метода" }, data: { description: "payload любого JSON-типа (по умолчанию {})" } }, required: ["method"] } },
];

async function handleCall(params) {
  const a = (params && params.arguments) || {};
  switch (params && params.name) {
    case "setup": {
      if (isAuthed()) {
        const c = getCfg();
        return okResult(`✅ Сессия настроена: ${c.subdomain}.bothelp.io (sessionId …${c.sessionId.slice(-6)}). ` +
          `Проверь через whoami. Дальше: list_scenarios, get_scenario, add_block, save_layout.`);
      }
      return okResult(NO_AUTH_HELP);
    }
    case "login_password": {
      const subdomain = String(a.subdomain || "").trim().replace(/\.bothelp\.io.*$/i, "").replace(/^https?:\/\//, "");
      const email = String(a.email || "").trim();
      const password = String(a.password || "");
      if (!subdomain || !email || !password) throw new Error("Нужны subdomain, email и password.");
      const sessionId = await passwordLogin(subdomain, email, password);
      saveCfg({ subdomain, sessionId });
      if (conn) { conn.sock.close(); conn = null; }
      let check = "";
      try { const c = await connect(); check = `\nВошли как ${c.operator?.login || c.operator?.name || "?"}.`; }
      catch (e) { check = `\n⚠️ sessionId получен, но подключение не прошло: ${(e.message || "").split("\n")[0]}`; }
      return okResult(`✅ Вход по паролю успешен, сессия сохранена (${CONFIG_FILE}). Пароль не сохранён.${check}`);
    }
    case "set_session": {
      const subdomain = String(a.subdomain || "").trim().replace(/\.bothelp\.io.*$/i, "").replace(/^https?:\/\//, "");
      const sessionId = String(a.sessionId || "").trim();
      if (!subdomain || !sessionId) throw new Error("Нужны subdomain (воркспейс) и sessionId (из authHandshake).");
      const patch = { subdomain, sessionId };
      if (a.cookie) patch.cookie = String(a.cookie).trim();
      saveCfg(patch);
      if (conn) { conn.sock.close(); conn = null; } // переподключиться с новой сессией
      let check = "";
      try { const c = await connect(); check = `\nПроверка: подключились как ${c.operator?.login || c.operator?.name || "?"}.`; }
      catch (e) { check = `\n⚠️ Сохранено, но подключиться не вышло: ${(e.message || "").split("\n")[0]}`; }
      return okResult(`✅ Сессия сохранена (${CONFIG_FILE}).${check}`);
    }
    case "whoami": {
      const c = await connect();
      return okResult({ operator: c.operator, subdomain: getCfg().subdomain });
    }
    case "list_scenarios": {
      const list = await rpc("evGetComplexBots", []);
      const arr = Array.isArray(list) ? list : [];
      return okResult(arr.map((b) => ({ id: b.id, referral: b.referral, title: b.title, enabled: b.enabled, adapterType: b.adapterType })));
    }
    case "list_funnels": {
      const list = await rpc("evGetFunnels", {});
      const arr = Array.isArray(list) ? list : [];
      return okResult(arr.map((f) => ({ id: f.id, referral: f.referral, title: f.title, isEnabled: f.isEnabled })));
    }
    case "get_scenario": {
      if (!a.id) throw new Error("Передай id сценария (см. list_scenarios).");
      const d = await rpc("evGetComplexBot", String(a.id));
      if (a.saveToFile) {
        const abs = path.resolve(String(a.saveToFile).replace(/^~(?=$|[/\\])/, os.homedir()));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(d, null, 2));
        return okResult({ savedTo: abs, ...scenarioSummary(d), note: "Полный граф записан в файл; здесь — сводка." });
      }
      if (a.raw) return okResult(d);
      return okResult(scenarioSummary(d));
    }
    case "add_block": {
      const bot = a.botFile ? readJsonFile(a.botFile) : a.bot;
      if (!bot || typeof bot !== "object") throw new Error("Передай bot (объект блока) или botFile (путь к JSON).");
      const inner = bot.bot && typeof bot.bot === "object" ? bot.bot : bot; // допускаем и обёрнутый, и голый
      // ВАЖНО: сервер требует поле soft в конверте data — без него evAddBot возвращает {error:100 "Failed to update bot"}.
      // soft:false = обычная запись (создание/полное обновление блока), как шлёт flow-builder. Проверено живьём (customerId 38252).
      return okResult(await rpc("evAddBot", { bot: inner, soft: a.soft === true }));
    }
    case "delete_block": {
      const id = Number(a.id);
      if (!Number.isFinite(id)) throw new Error("id блока должен быть числом (поле id из get_scenario, не referral).");
      return okResult(await rpc("evDeleteBot", id));
    }
    case "save_layout": {
      if (!a.complexBotId) throw new Error("Передай complexBotId.");
      if (!Array.isArray(a.coordinates)) throw new Error("Передай coordinates:[{referral,x,y}].");
      const complexBotId = Number(a.complexBotId) || a.complexBotId;
      return okResult(await rpc("evPutComplexBotDiagram", { complexBotId, complexBotDiagram: { coordinates: a.coordinates } }));
    }
    case "update_scenario": {
      const cb = a.complexBotFile ? readJsonFile(a.complexBotFile) : a.complexBot;
      if (!cb || typeof cb !== "object") throw new Error("Передай complexBot (объект) или complexBotFile.");
      const inner = cb.complexBot && typeof cb.complexBot === "object" ? cb.complexBot : cb;
      return okResult(await rpc("evPutComplexBot", { complexBot: inner }));
    }
    case "get_triggers": {
      if (!a.id) throw new Error("Передай id сценария.");
      const id = Number(a.id);
      return okResult(await rpc("evGetTriggersComplexBot", Number.isFinite(id) ? id : String(a.id)));
    }
    case "call": {
      if (!a.method) throw new Error("Передай method (имя ev-метода).");
      const data = a.data === undefined ? {} : a.data;
      return okResult(await rpc(String(a.method), data));
    }
    default:
      throw new Error(`Неизвестный инструмент: ${params && params.name}`);
  }
}

const okResult = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const errResult = (e) => ({ isError: true, content: [{ type: "text", text: "❌ " + (e?.message || String(e)) }] });

// ---------- JSON-RPC stdio (MCP) ----------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

function serve() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;
    let req; try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    try {
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bothelp-mcp", version: VERSION } } });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        let result; try { result = await handleCall(params); } catch (e) { result = errResult(e); }
        send({ jsonrpc: "2.0", id, result });
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (id !== undefined && id !== null) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (e) {
      if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e) } });
    }
  });
  const c = getCfg();
  process.stderr.write(`[bothelp-mcp] MCP ${VERSION}. Сессия: ${c.subdomain && c.sessionId ? c.subdomain + ".bothelp.io" : "не задана (вызови setup)"}.\n`);
}

// Не стартуем stdio-цикл под тестами (smoke.mjs импортирует хелперы).
if (!process.env.BOTHELP_MCP_NO_SERVE) serve();
