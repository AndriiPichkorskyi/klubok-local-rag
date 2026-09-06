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
| `tests.run` | `{axes?, concurrency?, overrideChatModel?, overrideEmbedModel?}` | `runRagTests(onProgress, {axes, control, overrideChatModel, overrideEmbedModel})` |
| `tests.runExternal` | `{axes?, concurrency?, overrideChatModel?, overrideEmbedModel?}` | `runExternalTests(onProgress, {axes, control, overrideChatModel, overrideEmbedModel})` |
| `tests.pause` | `{id}` | ставить активний `tests.run*` на паузу після завершення вже запущених кейсів |
| `tests.resume` | `{id, concurrency?}` | продовжує паузу; може змінити паралельність, напр. на `1` |
| `tests.plan` | `{kind?, axes?}` | ціна прогону ДО запуску (нічого не запускає) |
| `reports.list` | — | список файлів у `sidecar/test-reports/` |
| `reports.read` | `{name}` | вміст одного звіту; `name` — лише ім'я файлу, без шляхів |
| `job.cancel` | `{id}` | скасувати довгу операцію (див. «Скасування довгих операцій») |
| `walkthrough.start` | `{appId, goal, docId?}` | модуль 2.5: створює сесію ведення по інтерфейсу |
| `walkthrough.step` | `{sessionId, screenshotPath, frontmost?, appRunning?, debug?}` | наступний крок за знімком екрана |
| `walkthrough.stuck` | `{sessionId, screenshotPath, frontmost?, debug?}` | повторний аналіз того самого екрана іншим промптом |
| `walkthrough.history` | `{sessionId}` | усі кроки сесії з сирими відповідями моделі |
| `walkthrough.finish` | `{sessionId}` | закриває сесію і видаляє знімки |

Усі методи `pipeline.*` додатково мають у результаті поле `cancelled` (boolean).
Усі методи, що **пишуть** у базу (`pipeline.*`, `db.clear`), беруть файл-замок;
методи читання (`query`, `db.stats`, `reports.*`, `ping`, `bootstrap.*`, `config.*`,
`tests.*`, `walkthrough.*`) не беруть його ніколи.

## Уточнення до окремих методів

### `query`
`searchMode` — один із `vector` / `fts` / `hybrid`; будь-яке інше значення
відхиляється помилкою методу (мовчазний фолбек ховав би друкарську помилку).
Поле не передане або `null` — береться `config.rag.searchMode`.
`excludeLocal` не передане або `null` — береться `config.rag.excludeLocalDocs`.
Обидва параметри реально впливають на гілку пошуку; фактичні значення
повертаються в `result.retrievalStats.searchMode` і `.excludeLocal`.

Осі бенчмарку (`rag.systemPromptMode`, `rag.seed`, `rag.temperature`) на `query`
теж діють, але лише через значення за замовчуванням із конфіга: окремих
параметрів методу для них немає навмисно — це осі експерименту, а не ручки
користувача. Типовий конфіг (`system` / `42` / `0.1`) дає рівно той самий
запит до Ollama, що й до їх появи.

`processQuery()` має п'ятий, необов'язковий аргумент `overrides` (`{seed,
temperature}`), яким бенчмарк задає зерно на ОДИН виклик — це потрібно осі
`seed: "random"`, де кожен кейс має власне зерно, а глобальний `config` спільний
для трьох паралельних задач. **На RPC-методі `query` це ніяк не позначилось**:
параметра для нього немає, і незадані значення беруться з конфіга, як і раніше.
Фактичні значення повертаються в `result.retrievalStats.seed` і `.temperature`
(нові поля; `searchMode` та `excludeLocal` лишились на місці).

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
      "vectorizedApps": 129,              // унікальних програм у фактичній LanceDB
      "sqliteVectorizedApps": 129,        // старий прапорець SQLite, для діагностики
      "vectorizedSource": "lancedb",      // покриття пораховане з реальної LanceDB
      "notVectorizedApps": 0,
      "ready": true,                      // векторизовані ВСІ програми
      "lancedb": {"path": "…/lancedb_data_qwen3-embedding_0.6b",
                  "exists": true, "tableExists": true, "chunks": 15788,
                  "apps": 129, "sourceTypes": {"WEB": 14183, "INTENT": 60},
                  "sizeBytes": 73341439, "sizeMb": "69.94", "files": 712}
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

Список моделей **не захардкоджений**: він об'єднує конфіг (`embedModelName` +
`bootstrap.requiredModels` + `bootstrap.optionalModels`) із фактичними теками
`sidecar/lancedb_data_*`. Тому база, створена старим конфігом або окремим
експериментом, теж потрапляє в `models`. Покриття рахується за унікальними
`appName` у LanceDB; старий SQLite-прапорець лишається окремим діагностичним
полем. Осиротілі технічні колонки `vectorized_*` не є моделями й окремими
рядками не повертаються.
Поля `appsCount` і `chunksCount` лишаються сумісними з попередньою версією.

### `bootstrap.check`
Повертає `{platform, scanDirs, ollama, models, ready, actions, checkedAt}`, де
`ready` — чи можна працювати, а `actions` — список того, що зробити людині.
`models` = `{required, optional, missingRequired, missingOptional, autoPulled}`.
Обов'язковий список виводиться з `config.ollama` (чат + вектори) плюс
`config.bootstrap.requiredModels`; окремого другого джерела правди немає.
Якщо `config.bootstrap.autoPull` = `true`, метод сам тягне відсутні обов'язкові
моделі (з подіями `progress`) і перелічує їх у `models.autoPulled`.

### `walkthrough.*`
Модуль 2.5. Повний контракт (сценарій, три системи координат, два режими) —
`docs/contracts/walkthrough.md`; тут лише те, що стосується протоколу.

* Методи **не беруть файл-замок**: вони лише читають `apps`, `document_links`,
  `web_documents` і `chunks_fts`. Схему і дані не змінюють.
* `walkthrough.step` і `walkthrough.stuck` — **довгі й скасовні**: `ctx.signal`
  доходить до HTTP-запиту в Ollama (`axios`), тож `job.cancel({id})` обриває
  саме виклик зору, а метод завершується штатним кадром
  `{"cancelled": true, "method": "walkthrough.step", ...}` — як і будь-яка
  інша скасована задача.
* Обидва шлють `progress` без `pct`: зменшення кадру і виклик моделі.

`walkthrough.start` повертає `{sessionId, appName, planned[]}` плюс довідкові
поля `stepSource`, `docs[]` (які саме статті довідки взято), `docsSource`
(`docId` / `fts` / `any` / `none`) і `screenshotDir`. У режимі `vision`
`planned` порожній: плану немає за задумом.

`walkthrough.step` і `walkthrough.stuck` повертають РІВНО ту форму, що описана
в `walkthrough.md`: `{stepIndex, totalSteps, instruction, target, state, source,
elapsedMs}` плюс необов'язковий `debug` (див. «Режим розробника»). Уточнення:

* `totalSteps` — довжина плану в режимі `plan`; у режимі `vision` завжди `null`.
* `source` — `plan` лише тоді, коли інструкцію справді взято з плану. Якщо в
  режимі `plan` зір каже, що екран не той (`app_not_started`, `wrong_window`,
  `unclear`), інструкцію дає зір і `source` дорівнює `vision`: вести людину до
  кнопки у вікні, якого немає, гірше, ніж відступити від плану.
  **Третє значення — `frontmost`**: крок узагалі не питали в моделі, стан
  визначила ОС (див. нижче). Наявні `vision` і `plan` не перейменовувались.

#### `frontmost`: стан визначає ОС, а не зір

`walkthrough.step` приймає необов'язковий `frontmost` — те, що віддав
`frontmost_app()`: `{name, bundleId}` (плюс необов'язковий `isSelf`). Якщо він
переданий і попереду **не** програма сесії, модуль сам виставляє стан і
**не звертається до зору взагалі**: підказка «перейдіть у вікно Фотографій»
не потребує аналізу зображення і не має коштувати десятків секунд.

* зіставлення — спершу за `bundleId` (не залежить від мови системи), і лише за
  його відсутності за назвою. Назва у `frontmost` локалізована («Фотографії»),
  а в базі лежить англійська («Photos»), тож **розбіжність назв ніколи не
  перекриває збіг за bundleId**. Локалізовану назву, підтверджену bundleId,
  сесія запам'ятовує і далі впізнає її без bundleId.
* `wrong_window` — попереду інша програма (зокрема наше ж вікно підказки:
  `isSelf: true`).
* `app_not_started` — лише коли ОС прямо сказала, що програму не запущено:
  необов'язковий `appRunning: false` (це `alreadyRunning`/`pid` із `launch_app()`).
  Без цього поля здогадів не робимо, стан буде `wrong_window`.
* коли ОС підтвердила потрібне вікно, зір усе одно викликається, але з
  **звуженою задачею**: у промпті прямо сказано, що програма вже відкрита й
  активна, а `enum` схеми звужено до `ready | done | unclear`. Якщо модель
  усе-таки поверне `wrong_window`/`app_not_started`, це буде `unclear` із
  нотаткою санітарії, а рамка з такої суперечливої відповіді відкидається.
* `frontmost` не передано — поведінка та сама, що й до його появи: стан
  визначає зір, промпт і схема з повним переліком станів.

`walkthrough.stuck` теж приймає `frontmost`, але тільки щоб звузити промпт:
людина просить подивитись на екран ще раз, тож зір викликається завжди.

#### Режим розробника (`debug`)

`config.walkthrough.debug` (або `debug: true` у параметрах виклику — має
перевагу над конфігом) додає у відповідь `step`/`stuck` блок `debug`. Коли
режим вимкнено, **ключа в відповіді немає взагалі**: звичайна відповідь не
роздувається. Порожні поля з блока прибираються.

| Поле | Що це |
|---|---|
| `stateSource` | `frontmost` \| `vision` \| `plan` \| `fallback` — як визначено стан |
| `visionCalls` | скільки звернень до моделі коштував цей крок (0 або 1) |
| `allowedStates` | перелік станів, доступний моделі в цьому виклику |
| `system`, `prompt` | надісланий промпт як є |
| `raw` | сирий текст моделі ДО розбору; `modelFailure` — причина, якщо виклику не було |
| `model`, `durationMs`, `ollamaMs` | модель і тривалості |
| `imagePath`, `imageBytes`, `sentWidth`, `sentHeight` | кадр, надісланий моделі |
| `originalPath`, `originalWidth`, `originalHeight`, `originalBytes`, `resized` | кадр до зменшення |
| `screenSummary` | що модель написала про екран |
| `dropped` | нотатки санітарії: що саме відкинули й чому |
| `frontmost` | `{provided, matched, by, name, bundleId, learnedAlias, appRunning, reason}` |

`walkthrough.history({sessionId})` віддає всю сесію: `{sessionId, appId, appName,
goal, stepSource, stepIndex, appAliases[], createdAt, durationMs, totalSteps,
visionCalls, deterministicSteps, steps[]}`. Кожен крок — `{index, stepIndex, kind,
instruction, state, source, decidedBy, target, screenSummary, notes[], raw,
elapsedMs, at}`, де `raw` — сира відповідь моделі (`null` на кроках, де моделі
не питали). Метод читає лише пам'ять процесу: він синхронний, не бере замок і
не шле `progress`.
* `stepIndex` зсувається лише після корисного кроку: після стану `unclear` і
  після `walkthrough.stuck` він лишається тим самим.
* `target` — `null` завжди, коли елемента не видно, а також коли модель
  назвала елемент, але сама ж повідомила `app_not_started`/`wrong_window`.
  Координати рамки — **нормалізовані 0..1** відносно кадру; переводить їх у
  точки той, хто малює (див. `walkthrough.md`).

**Помилки моделі — це `state`, а не кадр `error`.** Недоступна Ollama, таймаут
(`walkthrough.visionTimeoutSec`), відповідь не за схемою, відсутній знімок
(не наданий дозвіл на запис екрана) — усе це повертається як звичайний крок зі
станом `unclear` і поясненням у `instruction`. Кадром `error` завершуються лише
помилки виклику: невідома сесія, порожній `goal`, невідомий `stepSource`,
відсутня в базі програма, непідтримувана платформа.

### `tests.run`, `tests.runExternal`
Обидва шлють події `progress` з `pct` по ходу прогону і повертають об'єкт
`{ok, totalCases, passed, failed, passRate, reportPath}` (`ok` — жоден кейс не
провалився). Недоступна Ollama — це `error` у відповіді, а не завершення
процесу. Глобальний `config` після прогону лишається таким, яким був до нього.

Опційний `concurrency` задає кількість паралельних кейсів саме для цього
прогону. Без нього береться `rag.testConcurrency` із конфіга. Значення мусить
бути додатним цілим числом; його також можна змінити через `tests.resume`.

**Обидва** методи перебирають **ту саму матрицю режимів** — `rag.benchmark.axes`
у `config/pipeline.config.json`. Осі ШІСТЬ: `search`, `xml`, `reorder`,
`systemPrompt` (`system` / `inline` / `none`), `seed` (числа, `null` або
`"random"`) і `temperature` (числа 0…2). Режими — повний добуток осей; щоб
зафіксувати вісь, у ній лишають одне значення. Типові значення конфіга дають
ті самі 12 режимів і ті самі їх назви, що й раніше; вісь, яка стоїть на
легасі-значенні (`sp=system`, `seed=42`, `t=0.1`) і не варіює, у назві режиму
не згадується взагалі.

`tests.runExternal` використовує парний набір однакових задач: англійські
запити з `tests/test-external-cases.js` та їхні українські відповідники з
`tests/test-external-cases-uk.js`. Обидві версії мають однаковий
`comparisonId`, тип і очікувану програму, тому `byLanguage` порівнює саме мову,
а не різну складність вибірок. Очікування — назви програм із цієї бази, а не
capability-id з іншого проєкту; арифметика, нагадування і системний запис екрана
є валідними задачами. Старий прогін збережено у
`tests/test-external.legacy.js`. Назви режимів ті самі, що й у `tests.run`;
звіти відрізняються полем `benchmarkKind` і префіксом `report-external-`.

### `tests.pause`, `tests.resume`

Обидва методи приймають серверний `id` активного `tests.run` або
`tests.runExternal`. Пауза не обриває HTTP-запит посеред відповіді: уже активні
кейси завершуються і дописують результат, але нові з черги не стартують.

`tests.resume({id, concurrency: 1})` продовжує той самий прогін з одного потоку;
вже готові кейси не повторюються. Без `concurrency` лишається поточне значення.
Відповідь обох методів: `{id, method, paused, concurrency, active, queued}`.
Неактивний id, не-тестова задача або `concurrency < 1` — помилка методу.

**`axes` у параметрах** (панель розробника) перекриває осі поштучно: задана
вісь замінює конфігову цілком, незадана береться з конфіга. Тобто конфіг
лишається джерелом за замовчуванням, а інтерфейс — способом поставити разовий
експеримент, не редагуючи JSON. Помилкове значення (невідомий `searchMode`,
`temperature` поза 0…2, повтори в осі, порожня вісь, невідома назва осі) — це
`error` методу ДО першого запиту до LLM.

Очікувану кількість прогонів (`режими × кейси`) обидва методи друкують і шлють
першим кадром `progress` ще до першого запиту до LLM. `rag.benchmark.maxModes`
(0 = без обмеження) не дає випадково запустити всю матрицю: перевищення —
це `error` до початку прогону, і той самий ліміт бачить панель ще до запуску
(див. `tests.plan`).

**Вісь `seed: "random"`.** Це не ще одна точка поруч із `1, 2, 3`: кожен кейс
отримує ВЛАСНЕ випадкове зерно (`crypto.randomInt`), тож режим міряє власну
нестабільність системи, а не порівнює налаштування. Наслідки в контракті:
* фактичне зерно кожного кейса лежить у полі `seed` його результату
  (і `seedSource: "fixed" | "random"`) — без цього прогін не відтворити;
* такий режим НЕ потрапляє ні в `seedGroups`, ні в `axisComparison`
  (порівнювати побайтово вивід на випадковому зерні немає сенсу);
* усереднення по ньому живе в окремому блоці `randomSeedRuns`.

Звіт пишеться на диск **поступово**, пакетами до 50 готових JSON-фрагментів, а
не одним обсягом наприкінці. Поки прогін триває, файл має ім'я
`<звіт>.json.partial`; після штатного завершення з'являється `.json`, а
`.partial` прибирається.
Кожна видима версія `.partial` є валідним JSON-знімком: поточний режим має
`summary: null` та `inProgress: true`, а заміна файла відбувається атомарно.

**Форма звіту розширилась** (стара частина — `timestamp`, `totalCases`,
`models`, `modes.*.summary` — лишилась на місці, тож `cli/reports.js` і
`src/dev/ReportTable.jsx` читають звіт як читали):

```jsonc
{
  "timestamp": "…", "totalCases": 26,
  "models": {"embed": "…", "chat": "…"},
  "benchmarkKind": "rag",              // або "external"
  "axes": {…},                          // матриця, якою отримано звіт
  "modeCount": 12, "expectedRuns": 312,
  "defaults": {"enableJsonFormat": true, "topK": 15, "excludeLocalDocs": false},
  "modes": {
    "<режим>": {
      "params": {"search","xml","reorder","systemPrompt","seed",
                 "temperature","chatModel","embedModel","seedKind"},  // перед results
      "results": [ {…, "rawOutputHash": "<sha256 сирої відповіді LLM>",
                    "comparisonId": "external-01",     // у парних EXTERNAL-кейсах
                    "language": "uk"|"en"|"neutral",
                    "languageSource": "explicit"|"auto",
                    "seed": 42|1659155928|null,          // НОВЕ: чим отримано кейс
                    "seedSource": "fixed"|"random",      // НОВЕ
                    "temperature": 0.1} ],               // НОВЕ
      "summary": {…, "wallTimeMs": 26123,                // НОВЕ: час «від першого
                     "byLanguage": {"uk": {…}, "en": {…}, "neutral": {…}}}
    }
  },
  "seedGroups": {…},          // обидва тести: розкид pass rate по seed-ах
  "axisComparison": […],      // обидва тести: побайтовий збіг виводу між парами
  "axisImpact": {…},          //               режимів, що різняться однією віссю
  "languageBreakdown": {…},   // обидва тести: мовна розбивка
  "randomSeedRuns": {…}       // лише коли в осі seed є "random"
}
```

* `seedGroups["<режим без seed>"].passRate` = `{values, mean, min, max, stdev, spread}`.
  σ — популяційне: у звіті лежать УСІ прогони групи, а не вибірка з них.
* `axisComparison[i]` = `{axis, from, to, fromValue, toValue, cases, identical,
  differing, identicalPct}`. `identical === cases` означає, що вісь не змінила
  побайтово нічого — це сильніший доказ інертності, ніж однаковий pass rate.
* **Мовна розбивка.** Корпус документації україномовний, а частина запитів —
  англійська, тож pass rate рахується ще й окремо по мовах. Мов ТРИ:
  `uk`, `en` і `neutral` — назви брендів («Photoshop»), безглуздя
  («asdfasdf qwerty», «івапівпавіп») і символьні токени («pdf»), які не
  належать жодній мові й не потрапляють ні в українську, ні в англійську
  метрику. Мова задана ЯВНО полем `language` у `tests/test-cases.js` і
  `tests/test-external-cases.js` / `tests/test-external-cases-uk.js`;
  автовизначення (`franc-min`) — лише запобіжник для нових
  кейсів без поля, і такий кейс має `languageSource: "auto"`, а їхню кількість
  звіт показує в `languageBreakdown.guessedCases`.
* `summary.byLanguage.<мова>` = `{cases, passed, failed, guessed, passRate}`;
  `passRate: null` означає «мови в наборі немає», а не 0%.
* `languageBreakdown` = `{guessedCases, totals, byMode, bySearchAxis, gap}`.
  `byMode["<режим>"].gap` — розрив `uk − en` у процентних пунктах;
  `bySearchAxis` відповідає на питання, чи залежить розрив від режиму пошуку;
  `gap.stable` = розкид розриву між режимами не більший за 5 п.п.
* `randomSeedRuns` = `{note, modes: {"<режим>": {groupName, cases, distinctSeeds,
  repeatedSeeds, seedSample, seedsTruncated, passed, failed, passRate}}}`.
  `seedSample` — перші 12 зерен; ПОВНИЙ перелік завжди лежить у полі `seed`
  кожного результату, і саме він потрібен для відтворення.
* `summary.wallTimeMs` — час режиму «від першого кейса до останнього».
  Додане поле, бо `totalTimeMs` означає в двох тестах різне: у `tests.run` це
  той самий wall-час, а в `tests.runExternal` — СУМА тривалостей кейсів (так
  його рахував цей тест завжди, і перейменовувати його ми не стали). Оцінка
  часу в `tests.plan` рахується саме з `wallTimeMs`.
* `tests.runExternal` тепер віддає ПОВНИЙ звіт тієї самої форми, що й
  `tests.run`, разом із осьовим хвостом (`seedGroups`, `axisComparison`,
  `axisImpact`): режимів у нього більше не один. Обидва тести формують звіт
  ОДНИМ записувачем (`tests/report-stream.js`), тож порядок ключів у файлі й
  у таблиці збігається. Старі external-звіти з єдиним режимом `external_hybrid`
  читаються як читались: жодне поле не перейменовано.

Наслідки потокового запису:

* обірваний прогін лишає на диску валідний `*.json.partial` з усім, що встигло
  дорахуватись;
* `reports.list` і `reports.read` таких файлів **не бачать** (фільтр `.json`),
  але людина або інший інструмент може безпечно прочитати знімок напряму.

### `tests.plan`
Ціна прогону ДО його запуску. Нічого не запускає, нічого не змінює, замок не
бере, прогресу не шле. Панель розробника смикає метод на кожну зміну осей
(з паузою 250 мс), щоб людина бачила вартість нічного прогону перш ніж його
почати.

```jsonc
// params: {"kind": "rag" | "external", "axes": {…}}   — обидва необов'язкові
{
  "kind": "external",
  "axes": {…},          // осі, якими піде прогін (конфіг + перекриття з params)
  "configAxes": {…},    // осі самого конфіга — панель показує, що успадковано
  "modeNames": ["hybrid+XML+Reorder|t=0.5|seed=1", …],
  "modeCount": 6, "caseCount": 68, "totalRuns": 408,
  "maxModes": 36, "blocked": false, "blockedReason": null,
  "lines": ["Матриця режимів …", …],   // той самий опис, що друкує сам прогін
  "estimate": {"msPerRun": 6712, "totalMs": 6161616,
               "concurrency": 3, "source": "останній звіт report-external-….json"}
}
```

* `caseCount` для `external` рахується ТИМ САМИМ кодом, що й прогін
  (`loadExternalCases`), тому після зміни набору план одразу показує новий масштаб.
  Значення кешується на час життя процесу.
* `estimate.msPerRun` — wall-час одного прогону з ОСТАННЬОГО звіту того ж виду
  (поле `summary.wallTimeMs`; у старих звітах — `totalTimeMs`, для external
  поділений на `rag.testConcurrency`). Звітів немає — береться виміряний
  типовий темп, і про це прямо сказано в `estimate.source`.
* `blocked: true` означає, що прогін із такими осями впав би на запобіжнику
  `maxModes`; `blockedReason` — той самий текст, який видав би сам прогін.
  Панель у цьому стані блокує кнопки запуску, а не дає натиснути й почекати
  годину пайплайна заради помилки в кінці.
* Помилкові осі — `error` методу з тим самим повідомленням, що й у прогоні.

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

Файлове журналювання керується `config.logging.enabled`. За замовчуванням у
поточному конфігу воно вимкнене: `sidecar/logs` не створюється і файли
`sidecar.N.log` / `queries.log` не дописуються. Це не стосується журналу
walkthrough — у нього окремий тумблер `walkthrough.journal`.

Коли тумблер увімкнено, усе, що описано вище, паралельно лягає у файл — саме тому, що stdout зникає разом
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
