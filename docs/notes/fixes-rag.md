# Виправлення в шарі RAG / сервісів / тестів

Зона правок: `modules/rag/{engine,prompts}.js`, `services/{ollama,logger}.service.js`,
`bootstrap/index.js`, `rpc/methods.js`, `tests/{test-rag,test-external,run-all-tests}.js`.

## Виправлено

| Файл | Що було | Що стало |
|---|---|---|
| `tests/test-rag.js:28`, `tests/test-external.js:40` | `process.exit(1)`, коли Ollama недоступна — RPC-сервер помирав разом із застосунком | кидається помилка; долю процесу вирішує лише термінальний запуск наприкінці файлу |
| `tests/test-rag.js:23`, `tests/test-external.js:30` | сигнатура без аргументів, прогресу немає | необов'язковий `onProgress(msg, pct)`; виклик без аргументів працює як раніше |
| `tests/test-external.js`, `tests/test-rag.js` | назавжди міняли глобальний `config.rag` | стан зберігається до прогону і відновлюється у `finally` |
| `modules/rag/engine.js:25` | `searchMode` приймався і ігнорувався | аргумент має пріоритет над конфігом; невідоме значення — помилка |
| `modules/rag/engine.js:36` | `config.rag.excludeLocalDocs` не читав ніхто | став значенням за замовчуванням для `excludeLocal` |
| `modules/rag/engine.js:104` | ранній вихід віддавав на 3 поля менше за звичайний | форма відповіді однакова в усіх гілках |
| `modules/rag/engine.js:238` | `[SOURCE_ID: X]` поза межами списку → сирий текст LLM разом із тегом | обробляється як відсутній тег (`NOT_FOUND`) |
| `modules/rag/engine.js:252` | `alternativeApps` містив увесь контекст, коли рекомендації немає | для маркерів `NOT_FOUND`/`INVALID_QUERY` список порожній |
| `services/ollama.service.js:74` | `data.models.map` без перевірки → «Ollama лежить», хоча вона відповіла | `Array.isArray`, сервер, що відповів, більше не рахується мертвим |
| `services/ollama.service.js:71` | `axios.get` без `timeout` — мовчазний порт вішав перевірку назавжди | `timeout: 5000`, як у bootstrap |
| `services/ollama.service.js:25` | строге порівняння назв: `llama3` ≠ `llama3:latest` | `isModelInstalled()` нормалізує відсутній тег |
| `services/ollama.service.js:39` | два джерела правди: `config.ollama` і `config.bootstrap.requiredModels` | `resolveModelLists()` — одне джерело для сервісу і bootstrap |
| `services/ollama.service.js:55` | моделі копіювались у конструкторі, `config.reload` на сервіс не впливав | геттери читають `config` щоразу |
| `bootstrap/index.js:59` | `config.bootstrap.autoPull` не читав ніхто | прапорець тягне відсутні обов'язкові моделі (за замовчуванням вимкнений) |
| `services/logger.service.js:17` | `path.resolve("logs")` — тека залежала від cwd | `config.paths.sidecarDir/logs` |
| `tests/test-rag.js`, `tests/test-external.js` | звіти писались у `process.cwd()/test-reports`, а `reports.list` читає `sidecar/test-reports` — під Tauri це різні теки | обидва місця беруть теку з конфіга |
| `tests/run-all-tests.js:24` | `spawn` без обробника `error` — збій запуску нікуди не доїжджав | додано `child.on("error", reject)` |
| `rpc/methods.js:241` | тести викликались без `onProgress`, плюс дубль перевірки Ollama | прогрес прокинуто, дубль прибрано |
| `tests/test-rag.js:63` | друкарська помилка `${modes.length}}` у банері | прибрана |

## Потребує правки поза зоною (не чіпав)

- **`src/dev/TestsSection.jsx:10-18`.** `verdict()` розрахований на булеве значення
  від `tests.run`. Тепер метод повертає об'єкт `{ok, totalCases, passed, failed,
  passRate, reportPath}` — панель покаже його як сирий JSON. Гілки `true`/`false`
  можна замінити на читабельний рядок з `passed`/`failed`/`passRate`.
- **`sidecar/src/cli/index.js:20-21`.** Імпорти `runRagTests`/`runExternalTests`
  не використовуються: CLI запускає тести окремими процесами через `runProcess()`.
  Мертві імпорти.
- **`config/pipeline.config.json`, `bootstrap.requiredModels`.** Після
  `resolveModelLists()` обов'язковий список виводиться з `config.ollama`, і
  перелічені там `qwen3:1.7b` / `qwen3-embedding:0.6b` — дублікати. Список можна
  лишити порожнім; він потрібен лише для моделей, яких немає в `config.ollama`.
- **`sidecar/src/services/db.service.js`, `saveChunks`.** Усі чанки лягають із
  `sourceType = 'WEB'`, тому `excludeLocal` (уже робочий на рівні `engine.js`)
  фактично нічого не відсіює. Причина — у пайплайні, не в RAG-шарі.
- **`job.cancel`.** `processQuery()` не приймає `AbortSignal`, тож пошук
  перервати нічим; кнопка скасування лише відв'язує UI. Потребує зміни сигнатур
  усього пайплайна.
