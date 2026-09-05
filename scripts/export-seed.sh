#!/usr/bin/env bash
#
# Архів даних для розповсюдження (щоб комісія не чекала повну індексацію).
#
# Що робить: копіює базу, СТИСКАЄ в копії сиру довідку до витягнутих статей,
# робить VACUUM, додає векторну базу поточної моделі, пакує все в один tar.gz.
#
# Чому це працює: сира сторінка Apple важить ~525 КБ, а стаття з неї — ~6 КБ,
# і застосунок показує саме статтю (`engine.js` проганяє прочитане через
# `extractMainHtml`). Отже в архів кладемо вже витягнуте — розмітка на видачі
# лишається такою самою, а база меншає в десятки разів. Код застосунку при цьому
# не змінюється взагалі.
#
# РОБОЧА БАЗА НЕ ЧІПАЄТЬСЯ: усі операції — над копією.
#
#   scripts/export-seed.sh                 → release/klubok-data.tar.gz
#   scripts/export-seed.sh --drop-html     викинути довідку цілком (менший архів,
#                                          стаття показується з Markdown-тексту)
#   scripts/export-seed.sh /шлях/кудись
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DROP_HTML=0
POSITIONAL=""
for arg in "$@"; do
  case "$arg" in
    --drop-html) DROP_HTML=1 ;;
    -*) echo "Невідомий аргумент: $arg" >&2; exit 2 ;;
    *) POSITIONAL="$arg" ;;
  esac
done

OUT_DIR="${POSITIONAL:-$PROJECT_DIR/release}"
STAGE="$OUT_DIR/stage"

CONF="$PROJECT_DIR/src-tauri/tauri.conf.json"
IDENTIFIER="$(sed -n 's/.*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONF" | head -1)"
EMBED_MODEL="$(sed -n 's/.*"embedModelName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT_DIR/config/pipeline.config.json" | head -1)"
LANCE_DIR="lancedb_data_${EMBED_MODEL/:/_}"
ARCHIVE="$OUT_DIR/klubok-data.tar.gz"

command -v sqlite3 >/dev/null || { echo "Потрібен sqlite3 (є в macOS штатно)" >&2; exit 1; }
[ -f "$PROJECT_DIR/sidecar/rag_metadata.sqlite" ] || { echo "Немає sidecar/rag_metadata.sqlite" >&2; exit 1; }
[ -d "$PROJECT_DIR/sidecar/$LANCE_DIR" ] || { echo "Немає sidecar/$LANCE_DIR" >&2; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "1/4 копіюю базу ($(du -h "$PROJECT_DIR/sidecar/rag_metadata.sqlite" | cut -f1))…"
cp "$PROJECT_DIR/sidecar/rag_metadata.sqlite" "$STAGE/rag_metadata.sqlite"

if [ "$DROP_HTML" -eq 1 ]; then
  echo "2/4 викидаю довідку цілком і роблю VACUUM…"
  sqlite3 "$STAGE/rag_metadata.sqlite" "DELETE FROM raw_html;"
else
  echo "2/4 стискаю довідку до статей (extractMainHtml)…"
  node "$PROJECT_DIR/sidecar/src/cli/compact-raw-html.js" "$STAGE/rag_metadata.sqlite"
  echo "    VACUUM (кілька хвилин)…"
fi
sqlite3 "$STAGE/rag_metadata.sqlite" "VACUUM;"

echo "3/4 копіюю векторну базу $LANCE_DIR ($(du -sh "$PROJECT_DIR/sidecar/$LANCE_DIR" | cut -f1))…"
cp -R "$PROJECT_DIR/sidecar/$LANCE_DIR" "$STAGE/$LANCE_DIR"

# Інструкція їде разом з архівом: людина, яка його завантажила, не має бігати
# по репозиторію, щоб дізнатись, куди це кладеться.
cat > "$STAGE/ЯК-РОЗПАКУВАТИ.txt" <<TXTEOF
База знань для застосунку Klubok.

Розпакувати саме в теку даних застосунку:

  mkdir -p "\$HOME/Library/Application Support/$IDENTIFIER"
  tar -xzf klubok-data.tar.gz -C "\$HOME/Library/Application Support/$IDENTIFIER"

Після цього запустіть Klubok і одразу питайте, наприклад:
  «як зробити запис екрана»

Що всередині:
  rag_metadata.sqlite   метадані програм, посилання на довідку, FTS-індекс
  $LANCE_DIR   векторна база для моделі $EMBED_MODEL

Сирі сторінки довідки в архів не входять: замість них лежить уже витягнута
стаття з кожної сторінки (те саме, що показує застосунок). Тому архів важить
десятки мегабайтів замість гігабайтів, а видача виглядає так само.
TXTEOF

echo "4/4 пакую…"
mkdir -p "$OUT_DIR"
tar -czf "$ARCHIVE" -C "$STAGE" "rag_metadata.sqlite" "$LANCE_DIR" "ЯК-РОЗПАКУВАТИ.txt"

echo
echo "База після чистки: $(du -h "$STAGE/rag_metadata.sqlite" | cut -f1)"
echo "Архів:             $(du -h "$ARCHIVE" | cut -f1)  →  $ARCHIVE"
echo
echo "Проміжна тека лишилась для перевірки: $STAGE"
echo "Прибрати: rm -rf \"$STAGE\""
