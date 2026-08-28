# Контракт RPC: Tauri (Rust) ↔ sidecar (Node)

Єдине джерело правди про протокол. Змінюєш протокол — спершу правиш цей файл.

## Транспорт
WebSocket, `ws://127.0.0.1:<config.rpc.port>` (за замовчуванням 17817), лише localhost.
Кожне повідомлення — один JSON-об'єкт. Перший фрейм від клієнта:
`{"type":"auth","token":"<config.rpc.token>"}`.
Сервер підтверджує кадром `{"type":"auth","ok":true}`, інакше закриває з'єднання
(код 4001 — перший кадр не auth, 4003 — невірний токен).

## Три типи повідомлень

```jsonc
// 1. Запит (Rust → Node)
{"id": 42, "method": "pipeline.vectorize", "params": {}}

// 2. Прогрес (Node → Rust, скільки завгодно разів, без відповіді)
{"type": "progress", "id": 42, "msg": "Чанк 340 з 1200", "pct": 28}
// Rust додає сюди поле "ref" — мітку, з якою фронтенд зробив виклик.

// 3. Результат (Node → Rust, рівно один раз на кожен id)
{"id": 42, "result": {...}}
{"id": 42, "error": {"message": "...", "stack": "..."}}
```

`id` — ціле число, генерує Rust. **Фронтенд свого `id` не бачить**, тому передає
у `rpc()` власну мітку `clientRef`; Rust повертає її в кожній події прогресу як `ref`.
Фільтруй прогрес за `ref`, ніколи не за `id` і ніколи за порядком надходження.
`id` — `pct` — 0..100 або `null`, якщо невідомо.
Прогрес — це існуючий колбек `onProgress` кожної функції пайплайна, нічого нового.

## Методи

| Метод | params | Обгортає |
|---|---|---|
| `ping` | — | перевірка живості, повертає `{ok:true, pid, version}` |
| `bootstrap.check` | — | модуль 2.1: OS, наявність ollama, список моделей |
| `bootstrap.pullModel` | `{model}` | `ollama pull` з прогресом |
| `config.get` | — | поточний конфіг |
| `config.reload` | — | `reloadConfig()` — перечитати JSON з диска |
| `query` | `{text, searchMode?, excludeLocal?}` | `processQuery()` |
| `pipeline.scanApps` | — | `runScanApps()` |
| `pipeline.fetchDocs` | — | `runFetchDocs()` |
| `pipeline.fetchLocalDocs` | — | `runFetchLocalDocs()` |
| `pipeline.keywordAugmentation` | — | `runKeywordAugmentation()` |
| `pipeline.vectorize` | — | `runVectorize()` |
| `pipeline.vectorizeIntents` | — | `runVectorizeIntents()` |
| `pipeline.fullSync` | `{models?}` | послідовність вище |
| `db.stats` | — | статистика (як пункт «📊» у CLI) |
| `db.clear` | `{target}` | `target`: all/web/local/apps/document_links/raw_html/web_documents/lancedb/intents |
| `tests.run` | — | `runRagTests()` |
| `tests.runExternal` | — | `runExternalTests()` |
| `reports.list` | — | список файлів у `sidecar/test-reports/` |
| `reports.read` | `{name}` | вміст одного звіту; `name` — лише ім'я файлу, без шляхів |
| `job.cancel` | `{id}` | скасувати довгу операцію |

## Правила
1. Один `id` — рівно одна фінальна відповідь. Прогрес не рахується.
2. Жоден метод не блокує сервер: довгі задачі виконуються паралельно, WebSocket лишається чутливим.
3. Sidecar **не** знає про Tauri. Його можна запустити з термінала (`npm run sidecar:dev`)
   і смикати будь-яким WebSocket-клієнтом. Це вимога, а не побажання.
4. Помилка методу = `error` у відповіді, а не падіння процесу.
5. Помилка рівня протоколу (невалідний JSON, дубль `id`) приходить з `"id": null`.
   Клієнт мусить логувати такі кадри, а не мовчки відкидати.
6. Після перезапуску sidecar усі запити «в польоті» вважаються втраченими:
   міст завершує їх локальною помилкою і не чекає відповіді.
