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
| `db.stats` | — | статистика бази + готовність кожної моделі (див. нижче) |
| `db.clear` | `{target}` | `target`: all/web/local/apps/document_links/raw_html/web_documents/lancedb/intents |
| `db.unlock` | `{force?}` | примусово зняти файл-замок (див. «Замок на операції запису») |
| `tests.run` | — | `runRagTests(onProgress)` |
| `tests.runExternal` | — | `runExternalTests(onProgress)` |
| `reports.list` | — | список файлів у `sidecar/test-reports/` |
| `reports.read` | `{name}` | вміст одного звіту; `name` — лише ім'я файлу, без шляхів |
| `job.cancel` | `{id}` | скасувати довгу операцію (див. «Скасування довгих операцій») |

Усі методи `pipeline.*` додатково мають у результаті поле `cancelled` (boolean).
Усі методи, що **пишуть** у базу (`pipeline.*`, `db.clear`), беруть файл-замок;
методи читання (`query`, `db.stats`, `reports.*`, `ping`, `bootstrap.*`, `config.*`,
`tests.*`) не беруть його ніколи.

## Уточнення до окремих методів

### `query`
`searchMode` — один із `vector` / `fts` / `hybrid`; будь-яке інше значення
відхиляється помилкою методу (мовчазний фолбек ховав би друкарську помилку).
Поле не передане або `null` — береться `config.rag.searchMode`.
`excludeLocal` не передане або `null` — береться `config.rag.excludeLocalDocs`.
Обидва параметри реально впливають на гілку пошуку; фактичні значення
повертаються в `result.retrievalStats.searchMode` і `.excludeLocal`.

Результат завжди має однаковий набір полів, зокрема й тоді, коли пошук нічого
не знайшов: `{response, rawLlmOutput, recommendedApp, alternativeApps,
contextApps, executionTimeMs, ollamaMetrics, retrievalStats}`. Поля, яких немає
про що заповнити, дорівнюють `null` або `[]`.

### Скасування довгих операцій (`job.cancel`)
Сервер тримає окремий `AbortController` на кожен активний `id`. `job.cancel({id})`
смикає його і одразу відповідає:

```jsonc
{"cancelled": true, "alreadyCancelled": false, "id": 42,
 "method": "pipeline.vectorize", "startedAt": 1787920917667, "runningMs": 6002}
```

* `cancelled: false` буває лише тоді, коли задачі з таким `id` немає серед активних
  (уже завершилась або ніколи не існувала); у такій відповіді є поле `reason`.
* Повторне скасування тієї самої задачі повертає `alreadyCancelled: true`.
* Відповідь `job.cancel` — це **не** фінальна відповідь скасованої задачі. Свою
  відповідь та надсилає сама, як і будь-який інший метод (правило 1 нижче).

Сигнал доходить у цикли пайплайна, в HTTP-запити axios і в дочірній процес
`cli/run-vectorize.js`, який `pipeline.fullSync` запускає для «чужої» моделі:
процесу надсилається SIGTERM, а якщо він не помер за 2 с — SIGKILL.

**Скасування — не помилка.** Скасована операція завершується кадром `result`
(а не `error`) і повертає те, що встигла зробити:

```jsonc
{"id": 42, "result": {"chunks": 26, "cancelled": true}}
```

`pipeline.fullSync` додає ще `stoppedAt` — крок, на якому спинилися (`scanApps`,
`fetchDocs`, `fetchLocalDocs`, `keywordAugmentation`, `vectorize`,
`vectorize:<model>`, `vectorizeIntents`); при звичайному завершенні там `null`.
Модель, векторизацію якої обірвали в дочірньому процесі, має в `perModel`
значення `"cancelled"`.

Гарантії цілісності при скасуванні:
* цикли перевіряють сигнал **між ітераціями**, а не посеред запису в БД;
* уже збережені чанки лишаються збереженими;
* програма, обробку якої обірвали на середині, **не** позначається векторизованою,
  і її часткові вектори не зберігаються взагалі;
* обірваний запит TOC не позначає зміст завантаженим.

Якщо скасована операція все ж кине `AbortError` зсередини бібліотеки, сервер сам
перетворює його на `result` виду
`{"cancelled": true, "method": "...", "reason": "...", "durationMs": 1234}`.

### Замок на операції запису
Дві паралельні векторизації пишуть в одну `chunks_fts` і в одну LanceDB-таблицю
і псують дані (реальний випадок: дублікати INTENT- і WEB-чанків, витіснена
документація). Тому кожна операція запису бере **файл-замок** `sidecar/pipeline.lock`
(поруч із `rag_metadata.sqlite`):

```jsonc
{"pid": 82, "operation": "runVectorize", "startedAt": "2026-08-28T17:01:37.164Z",
 "argv": ["…/src/cli/run-vectorize.js"]}
```

Правила:
1. **Замок беруть** `runScanApps`, `runFetchDocs`, `runFetchLocalDocs`,
   `runKeywordAugmentation`, `runVectorize`, `runVectorizeIntents`, `pipeline.fullSync`,
   `db.clear` і скрипт `cli/run-vectorize.js`. Читання не бере замка ніколи.
2. **Зайнято — це відмова, а не черга.** Спроба почати другу операцію запису
   завершується кадром `error` із поясненням, хто тримає замок:
   `Операцію «runKeywordAugmentation» не запущено: базу вже змінює процес 82
   (операція «runVectorize», запущений 2026-08-28T17:01:37.164Z, 3 с тому)…`
   Це стосується і двох RPC-запитів в одному процесі, і окремих процесів
   (`npm run sidecar:cli`, `node src/cli/run-vectorize.js`), бо замок — у файлі.
3. **Протухлий замок перехоплюється.** Якщо у файлі PID неживого процесу
   (перевірка `process.kill(pid, 0)`) або файл зіпсовано, наступна операція
   мовчки забирає замок собі — `kill -9` не блокує систему назавжди.
   Додатковий запобіжник: живий власник щоп'ять секунд оновлює `mtime` файла
   («сигнал життя»), і замок без сигналу довше за 30 с теж вважається протухлим.
   Це закриває випадок, коли номер мертвого процесу дістався комусь іншому.
4. **`pipeline.fullSync` бере замок один раз на весь прогін.** Кроки всередині
   бачать, що замок уже їхній (`AsyncLocalStorage`), а дочірній процес
   векторизації «чужої» моделі успадковує його через змінну оточення
   `PIPELINE_LOCK_OWNER_PID` — інакше система блокувала б сама себе.
5. **Замок віддається завжди**: після успіху, помилки і скасування (`finally`),
   а також у штатному `process.on("exit")`. Після `kill -9` спрацьовує пункт 3.

`db.unlock` — примусове зняття:

```jsonc
// власник мертвий: знімаємо
{"unlocked": true, "wasLocked": true, "forced": false, "lock": {…}}
// власник живий: відмова, бо зняти замок у працюючого процесу = повернути гонку
{"unlocked": false, "wasLocked": true, "refused": true, "reason": "Замок тримає ЖИВИЙ процес 82…", "lock": {…}}
// замка не було
{"unlocked": false, "wasLocked": false, "lock": null}
```

`{"force": true}` знімає замок навіть у живого власника — лише коли людина
свідомо цього хоче.

### `db.stats`
Читає SQLite (~1.5 ГБ) і теки LanceDB, тому буває повільним. Повертає:

```jsonc
{
  "appsCount": 129,                       // рядків у таблиці apps
  "chunksCount": 15789,                   // рядків у LanceDB ПОТОЧНОЇ моделі
  "currentModel": "qwen3-embedding:0.6b", // config.embedModelName
  "lock": {                               // стан файла-замка (див. вище)
    "locked": true, "pid": 82, "operation": "runVectorize",
    "startedAt": "2026-08-28T17:01:37.164Z", "ageMs": 2005,
    "heartbeatAgeMs": 2008,                 // коли востаннє був сигнал життя
    "alive": true, "stale": false, "broken": false, "self": true,
    "path": "…/sidecar/pipeline.lock"
  },                                      // вільно: {"locked": false, "path": "…"}
  "models": [                             // готовність кожної моделі окремо
    {
      "model": "qwen3-embedding:0.6b",
      "column": "vectorized_0_6b",        // колонка-прапорець у таблиці apps
      "columnExists": true,
      "isCurrent": true,
      "vectorizedApps": 129,              // програм з прапорцем = 1
      "notVectorizedApps": 0,
      "ready": true,                      // векторизовані ВСІ програми
      "lancedb": {"path": "…/lancedb_data_qwen3-embedding_0.6b",
                  "exists": true, "sizeBytes": 73341439, "sizeMb": "69.94", "files": 712}
    },
    {"model": "qwen3-embedding:4b", "column": "vectorized_4b", "vectorizedApps": 0,
     "ready": false, "lancedb": {"exists": false, "sizeBytes": 0, "sizeMb": "0.00", "files": 0}}
  ],
  "chunksBySourceType": {"WEB": 14183, "LOCAL": 1416, "META": 129, "INTENT": 61},
  "chunksFtsTotal": 15789,
  "documentLinksBySourceType": {"WEB": 2257, "LOCAL": 100},
  "webDocumentsCount": 2357,
  "appsWithoutKeywords": 69,               // програми без ключових слів (і без INTENT-чанка)
  "sqlite": {"path": "…/rag_metadata.sqlite", "sizeBytes": 1516085248, "sizeMb": "1445.85"},
  "collectedAt": "2026-08-28T12:41:45.296Z"
}
```

Список моделей **не захардкоджений**: він виводиться з конфіга
(`embedModelName` + `bootstrap.requiredModels` + `bootstrap.optionalModels`) і
звіряється зі схемою таблиці `apps` — модель потрапляє у `models`, якщо в схемі є
її колонка `vectorized_<тег>` (або якщо це поточна модель). Колонка, для якої в
конфізі немає моделі, теж потрапляє у список, але з `"model": null`.
Поля `appsCount` і `chunksCount` лишаються сумісними з попередньою версією.

### `bootstrap.check`
Повертає `{platform, scanDirs, ollama, models, ready, actions, checkedAt}`, де
`ready` — чи можна працювати, а `actions` — список того, що зробити людині.
`models` = `{required, optional, missingRequired, missingOptional, autoPulled}`.
Обов'язковий список виводиться з `config.ollama` (чат + вектори) плюс
`config.bootstrap.requiredModels`; окремого другого джерела правди немає.
Якщо `config.bootstrap.autoPull` = `true`, метод сам тягне відсутні обов'язкові
моделі (з подіями `progress`) і перелічує їх у `models.autoPulled`.

### `tests.run`, `tests.runExternal`
Обидва шлють події `progress` з `pct` по ходу прогону і повертають об'єкт
`{ok, totalCases, passed, failed, passRate, reportPath}` (`ok` — жоден кейс не
провалився). Недоступна Ollama — це `error` у відповіді, а не завершення
процесу. Глобальний `config` після прогону лишається таким, яким був до нього.

Звіт пишеться на диск **поступово**, у міру готовності кожного кейса, а не одним
обсягом наприкінці. Форма файла не змінилась
(`{timestamp, totalCases, models, modes:{"<режим>":{results:[…], summary:{…}}}}`),
але поки прогін триває, файл має ім'я `<звіт>.json.partial` і перейменовується
на `.json` лише при штатному завершенні. Наслідки:

* обірваний прогін лишає на диску `*.json.partial` з усім, що встигло дорахуватись;
* `reports.list` і `reports.read` таких файлів **не бачать** (фільтр `.json`),
  тому інтерфейсу ніколи не дістається недописаний JSON.

## Попередження про пам'ять у `progress`

Sidecar стежить за купою V8 (межа береться з `v8.getHeapStatistics().heap_size_limit`,
не захардкоджена). Коли `heapUsed` перетинає 80% межі, сервер шле **звичайний кадр
`progress`** з `pct: null` і текстом-попередженням — по одному на кожну активну задачу,
всім автентифікованим клієнтам:

```jsonc
{"type": "progress", "id": 42, "pct": null,
 "msg": "⚠️ Пам'ять: купа V8 зайнята на 88.4% (495.3 з 560 МБ, RSS 575.1 МБ). Ще трохи — і процес буде вбито."}
```

Нового типу повідомлення немає навмисно: інтерфейс уже вміє показувати `progress`,
і людина бачить попередження там само, де хід операції — **до** падіння, а не після.
Повторюється воно лише коли стало відчутно гірше (крок 5% від межі). Якщо активних
задач немає, попередження йде тільки в журнал: у протоколі немає каналу без `id`.

## Діагностичний журнал sidecar

Усе, що описано вище, паралельно лягає у файл — саме тому, що stdout зникає разом
зі скролом термінала (інцидент 26.08: sidecar зник посеред бенчмарку, і слідів не
лишилось). Журнал: `sidecar/logs/sidecar.N.log`, символьне посилання
`sidecar/logs/current.log` завжди вказує на активний файл. Формат — JSON-рядки
(pino), поле `event` машинне, `msg` — українською.

| `event` | Коли |
|---|---|
| `process.start` | старт: `pid`, версія Node, платформа, `execArgv`, `heapLimitMb` |
| `rpc.listening` | сервер почав слухати |
| `rpc.connection.open` / `.close` | з'єднання відкрито / розірвано (з кодом) |
| `rpc.auth.ok` / `rpc.auth.failed` | автентифікація |
| `rpc.call.start` / `rpc.call.end` | межі кожного виклику: `method`, `durationMs`, `status`, зріз пам'яті |
| `rpc.unknown_method`, `rpc.duplicate_id`, `rpc.bad_request` | помилки рівня протоколу |
| `heartbeat` | пульс: зріз пам'яті + що саме зараз виконується |
| `process.signal`, `process.exit` | причина завершення |
| `process.uncaughtException`, `process.unhandledRejection` | збої, після яких процес живе далі |

`heartbeat` — головна річ для розтину. `SIGKILL` від OOM-killer і аварію нативного
модуля (`SIGSEGV`/`SIGABRT`) не перехоплює жоден обробник, тому «що робилося в цю
мить» треба записати **заздалегідь**: пульс щоп'ять секунд несе `inflight`
(список активних `id` з методами і тривалістю) і `stages` (наприклад, режим і номер
кейса бенчмарку). Запис синхронний (`sync: true`), тож після `kill -9` у файлі
лишається все, що встигло статися.

Ротація обов'язкова і вбудована: 5 МБ на файл × 5 старих копій (≈30 МБ стелі).
Налаштування — змінними оточення: `SIDECAR_LOG_DIR`, `SIDECAR_LOG_LEVEL`,
`SIDECAR_LOG_MAX_SIZE`, `SIDECAR_LOG_KEEP`, `SIDECAR_LOG_MEMORY_MS`,
`SIDECAR_LOG_HEAP_WARN`, `SIDECAR_LOG_HEAP_CRIT`.

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
