# Ключі Info.plist, які варто витягувати (витягнуто з архіву tauri-app)

Поточний `sidecar/src/modules/indexer/scanner.js` читає базовий набір.
Нижче — повний список з `_archive_tauri-app/src-tauri/src/platform/macos_metadata.rs`.
Використати у фазі 2 при доопрацюванні macOS-адаптера. Код звідти НЕ копіювати — тільки цей список.

## Ідентифікація
CFBundleIdentifier, CFBundleName, CFBundleDisplayName,
CFBundleShortVersionString, CFBundleVersion, CFBundlePackageType,
LSApplicationCategoryType, NSHumanReadableCopyright

## Довідка (найцінніше для RAG)
CFBundleHelpBookName, CFBundleHelpBookFolder
→ шлях: `Contents/Resources/<HelpBookFolder>` або `Contents/Resources/<lang>.lproj/<...>`

## Що програма вміє робити (сигнал наміру користувача)
- CFBundleDocumentTypes → CFBundleTypeName, CFBundleTypeExtensions,
  CFBundleTypeMIMETypes, CFBundleTypeRole, LSItemContentTypes
- UTExportedTypeDeclarations / UTImportedTypeDeclarations →
  UTTypeIdentifier, UTTypeDescription, UTTypeConformsTo, UTTypeTagSpecification
- CFBundleURLTypes → CFBundleURLName, CFBundleURLSchemes
- NSServices → NSMenuItem, NSMessage, NSSendTypes, NSReturnTypes, NSSendFileTypes

## Дозволи = натяк на можливості
NSCameraUsageDescription, NSMicrophoneUsageDescription,
NSAudioCaptureUsageDescription, NSSpeechRecognitionUsageDescription,
NSDocumentsFolderUsageDescription
(корисно: наявність NSAudioCaptureUsageDescription = програма вміє писати звук)

## Локалізовані назви (українська мова запиту)
- `Contents/Resources/<lang>.lproj/InfoPlist.strings`
- `Contents/Resources/<lang>.loctable`
Дає українську назву програми, що прямо покращує пошук українською.
