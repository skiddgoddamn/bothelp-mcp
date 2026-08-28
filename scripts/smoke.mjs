// Оффлайн-смоук: чистые хелперы транспорта и разбора графа, без сети.
import assert from "node:assert";
process.env.BOTHELP_MCP_NO_SERVE = "1";
const m = await import("../src/index.mjs");

// 1) uid формата 8hex-4hex
assert.match(m.genUid(), /^[0-9a-f]{8}-[0-9a-f]{4}$/, "genUid формат");

// 2) RPC-корреляция + heartbeat Primus на фейковом сокете
const sent = [];
const c = { sock: { send: (s) => sent.push(s) }, pending: new Map() };
const pr = m.rpcOn(c, "evX", { a: 1 }, 5000);
const frame = JSON.parse(sent.at(-1));
assert.equal(frame.method, "evX", "ушёл метод");
assert.deepEqual(frame.data, { a: 1 }, "ушёл data");

// сервер шлёт ping → мы отвечаем pong
m.handleMsg(c, JSON.stringify("primus::ping::123"));
assert.equal(sent.at(-1), JSON.stringify("primus::pong::123"), "pong на ping");

// ответ по uid резолвит промис
m.handleMsg(c, JSON.stringify({ event: frame.uid, data: { ok: true } }));
assert.deepEqual(await pr, { ok: true }, "resolve по event=uid");
assert.equal(c.pending.size, 0, "pending очищен");

// 3) извлечение рёбер (run_bot в кнопке + condition pos/neg) и координаты
const d = {
  complexBot: { id: 1, referral: "c1", title: "t", enabled: true, startStepReferral: "a" },
  diagram: { coordinates: [{ referral: "a", x: 1.4, y: 2.6 }] },
  steps: [
    { referral: "a", id: 10, type: "fb-referral", title: "A",
      flowData: { steps: [{ buttons: [{ actions: [{ action: "run_bot", value: "b" }] }] }] } },
    { referral: "b", id: 11, type: "condition",
      conditions: { positive: { action: "run_bot", value: "a" }, negative: { action: "run_bot", value: "c" } } },
  ],
};
const sum = m.scenarioSummary(d);
assert.equal(sum.counts.steps, 2, "2 узла");
assert.equal(sum.startStep, "a", "точка входа");
assert.deepEqual(sum.steps[0].to, ["b"], "ребро из кнопки");
assert.deepEqual(sum.steps[1].to.sort(), ["a", "c"], "рёбра условия pos/neg");
assert.deepEqual(sum.steps[0].pos, { x: 1, y: 3 }, "координаты округлены");
assert.equal(sum.counts.edges, 3, "всего рёбер");

console.log("ok smoke: transport + graph parsing");
