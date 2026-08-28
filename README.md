# bothelp-mcp

MCP-сервер для **чтения и сборки сценариев ботов в BotHelp** (Telegram/VK/MAX/WhatsApp)
прямо из Claude Code — по аналогии с [zaytsv-mcp](https://github.com/skiddgoddamn/zaytsv-mcp),
но для чужого сервиса BotHelp.

Zero-dependency (Node ≥22, глобальный `WebSocket`; на Node <22 — `npm i ws`, авто-фолбэк).

## Почему WebSocket, а не Open API

Публичный REST **Open API** BotHelp (`api.bothelp.io`) сценарии только **читает и запускает** —
редактировать граф им нельзя. Веб-конструктор «flow2» правит сценарий через приватный
**WebSocket-RPC** (библиотека Primus):

```
send    {"method":"evXxx","data":<...>,"uid":"<rand>"}
receive {"event":"<uid>","data":<...>}
heartbeat: "primus::ping::<ts>" / "primus::pong::<ts>"
```

Этот MCP — тонкая обёртка над теми же методами.

> ⚠️ Протокол приватный и недокументированный — может измениться без предупреждения.
> Обкатывай на **тестовом** боте: `add_block` / `delete_block` / `save_layout` меняют
> живой сценарий.

## Модель данных сценария

`evGetComplexBot("<id>")` возвращает граф целиком:

```
{ complexBot, steps[], diagram:{coordinates:[{referral,x,y}]}, externalRequests, usedTags }
```

- **Узлы** — `steps[]`. Тип: `fb-referral` (сообщение), `action`, `condition`, `delay`.
  У каждого `referral` (id узла), `flowData` (контент: текст, кнопки, `answerField`+валидатор), `parentReferral`.
- **Рёбра** — экшены `{"action":"run_bot","value":"<referral цели>"}` внутри кнопок,
  `conditions.positive` / `conditions.negative` и `actions[]` блока.
- **Вход** — `complexBot.startStepReferral`. **Раскладка** — `diagram.coordinates`.

`get_scenario` по умолчанию отдаёт компактную **сводку** (узлы + рёбра `to`), т.к. полный граф бывает >100 КБ.

## Авторизация

Сессия оператора (не Open-API токен `id:secret`). Два способа:

**A. Проще — `login_password`** (email/пароль → sessionId сам):
`login_password { subdomain, email, password }`. Под капотом
`POST https://<sub>.bothelp.io/login/<sub>?source=web {login,password}` → `{sessionId}`.
Пароль нигде не сохраняется — в конфиг пишется только полученный `sessionId`.

**B. Без пароля — `set_session`** (готовый sessionId):
1. Залогинься и открой сценарий (`https://<workspace>.bothelp.io/flow2/flow-builder/<id>/edit`).
2. DevTools (F12) → **Network** → фильтр **WS** → `/ws/...` → **Messages**.
3. Первый кадр — `{"method":"authHandshake","data":{"sessionId":"..."}}`. Скопируй `sessionId`.
4. `set_session { subdomain, sessionId }`. Если бэкенд требует куку — передай `cookie`.

Под капотом обоих: `GET https://<sub>.bothelp.io/session/<sub>/<sessionId>` → `{sessionId, operator, wsUrl}` → ws + `authHandshake`.

ENV: `BOTHELP_SUBDOMAIN`, `BOTHELP_SESSION_ID`, `BOTHELP_COOKIE`.
**Headless/CI:** задай `BOTHELP_SUBDOMAIN` + `BOTHELP_EMAIL` + `BOTHELP_PASSWORD` — сервер сам залогинится при первом вызове.

## Установка

```jsonc
// .mcp.json / настройки Claude Code
{
  "mcpServers": {
    "bothelp-mcp": { "command": "node", "args": ["/абс/путь/bothelp-mcp/src/index.mjs"] }
  }
}
```

## Инструменты

| Tool | Метод BotHelp | Назначение |
|---|---|---|
| `setup` | — | статус сессии + инструкция |
| `login_password` | — | вход по subdomain+email+паролю → sessionId (проще всего) |
| `set_session` | — | сохранить subdomain + sessionId (+cookie) |
| `whoami` | `authHandshake` | проверить сессию, вернуть оператора |
| `list_scenarios` | `evGetComplexBots` | список сценариев (id/referral/title/enabled) |
| `list_funnels` | `evGetFunnels` | список воронок |
| `get_scenario` | `evGetComplexBot` | граф по id (сводка / `raw` / `saveToFile`) |
| `add_block` | `evAddBot` | создать/обновить блок |
| `delete_block` | `evDeleteBot` | удалить блок по числовому id |
| `save_layout` | `evPutComplexBotDiagram` | сохранить координаты канваса |
| `update_scenario` | `evPutComplexBot` | настройки / точка входа `startStepReferral` |
| `get_triggers` | `evGetTriggersComplexBot` | триггеры сценария |
| `call` | любой `ev*` | escape-hatch: вызвать любой метод напрямую |

`call` — потому что весь API однородный. Через него доступно то, у чего нет обёртки, напр.
клон по share-токену: `evGenerateComplexBotToken` → `evCopyComplexBotByToken`.

## Пример: добавить блок-сообщение

```jsonc
// add_block
{ "bot": {
  "title": "Приветствие",
  "referral": "1700000000001",           // уникальный id узла
  "adapterType": "telegram",
  "adapterConnectorId": "<connectorId бота>",
  "parentReferral": "<referral сценария c...>",
  "enabled": true,
  "flowData": { "steps": [{
    "type": "message",
    "message": { "type": "text", "text": "Привет, {%first_name%}!" },
    "buttons": [{ "type": "postback", "title": "Дальше",
      "actions": [{ "action": "run_bot", "value": "<referral следующего блока>" }] }]
  }] }
}}
```
Затем `save_layout` с `coordinates:[{referral, x, y}]`, чтобы блок встал на канвасе.

## Разработка

```bash
npm run check   # node --check
npm test        # оффлайн-смоук: транспорт (uid/ping/pong/rpc) + разбор графа
```

## Лицензия

MIT. Неофициальный клиент; не аффилирован с BotHelp. Используй на свой риск и в рамках ToS сервиса.
