# Контракт адаптера платформи

Адаптер — єдине місце, де живуть знання про конкретну ОС. Решта sidecar працює
лише через цей інтерфейс. Отримати адаптер: `getPlatformAdapter()` з
`sidecar/src/platform/index.js` (без аргументу — поточна ОС).

## Поля

| Поле | Тип | Значення |
|---|---|---|
| `platform` | string | як `process.platform`: `darwin`, `win32`, `linux` |
| `name` | string | людська назва: `macOS`, `Windows`, `Linux` |
| `supported` | boolean | `true` лише в macOS; решта — заглушки |
| `reason` | string | чому не підтримується (лише коли `supported: false`) |

## Методи

| Метод | Повертає | Опис |
|---|---|---|
| `getScanDirs()` | `string[]` | директорії, які треба сканувати на цій ОС |
| `scanApplications(onProgress)` | `Promise<App[]>` | встановлені програми; macOS делегує в `modules/indexer/scanner.js` |
| `findLocalDocs(app)` | `Promise<string[]>` | абсолютні шляхи до html-файлів довідки програми; немає довідки — `[]` |
| `launchApp(identifier)` | `Promise<{launched, identifier}>` | запуск за bundleId або шляхом (потрібно модулю walkthrough) |

`App` — те, що вже віддає `scanner.js`:
`{ name, bundleId, path, helpBookFolder, hpdProjectIdentifier }`.
`onProgress(msg)` — той самий колбек, що й у пайплайні.

## Правила

1. `supported: false` означає, що **кожен** метод кидає виняток з українським
   поясненням. Заглушка не повертає `[]` чи `null`: порожній результат виглядає
   як успішне сканування і ховає проблему.
2. Викликати методи адаптера дозволено лише після перевірки `supported`
   (виняток — `bootstrap.check`, який саме цю перевірку й робить).
3. Невідома платформа не є аварією: `getPlatformAdapter()` віддає адаптер із
   `supported: false`, а не кидає виняток.
4. Адаптер не містить власної логіки сканування — він обгортає наявний код ОС.
