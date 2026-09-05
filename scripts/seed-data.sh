#!/usr/bin/env bash
#
# Насіння даних для зібраного застосунку.
#
# Зібраний .app тримає базу в ~/Library/Application Support/<identifier>, і при
# першому запуску вона порожня — застосунок будує індекс сам. Це правильно, але
# на демонстрації чекати повну індексацію ніхто не буде, тому цей скрипт кладе
# туди вже готову базу з теки проєкта.
#
#   scripts/seed-data.sh           копія (так треба для чистої машини)
#   scripts/seed-data.sh --link    символьні посилання (миттєво, для розробки)
#   scripts/seed-data.sh --force   перезаписати те, що вже лежить у теці даних
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$PROJECT_DIR/src-tauri/tauri.conf.json"

# Ідентифікатор беремо з конфіга Tauri: два джерела правди тут швидко розійдуться.
IDENTIFIER="$(sed -n 's/.*"identifier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONF" | head -1)"
[ -n "$IDENTIFIER" ] || { echo "Не знайшов identifier у $CONF" >&2; exit 1; }

# Модель ембедингу теж із конфіга — тека LanceDB називається за нею.
EMBED_MODEL="$(sed -n 's/.*"embedModelName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT_DIR/config/pipeline.config.json" | head -1)"
[ -n "$EMBED_MODEL" ] || { echo "Не знайшов embedModelName у конфізі" >&2; exit 1; }
LANCE_DIR="lancedb_data_${EMBED_MODEL/:/_}"

SOURCE="${SEED_SOURCE:-$PROJECT_DIR/sidecar}"
DEST="$HOME/Library/Application Support/$IDENTIFIER"

LINK=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --link) LINK=1 ;;
    --force) FORCE=1 ;;
    *) echo "Невідомий аргумент: $arg" >&2; exit 2 ;;
  esac
done

echo "Джерело:   $SOURCE"
echo "Призначення: $DEST"
echo "Модель:    $EMBED_MODEL → $LANCE_DIR"
echo

mkdir -p "$DEST"

# Переносимо рівно два об'єкти: метадані і векторну базу ПОТОЧНОЇ моделі.
# Інші lancedb_data_* — інструмент бенчмаркінгу, застосунку вони не потрібні.
place() {
  local name="$1"
  local from="$SOURCE/$name"
  local to="$DEST/$name"

  if [ ! -e "$from" ]; then
    echo "! немає $from — пропускаю"
    return
  fi
  if [ -e "$to" ] || [ -L "$to" ]; then
    if [ "$FORCE" -eq 1 ]; then
      rm -rf "$to"
    else
      echo "= $name уже є в теці даних (--force перезапише)"
      return
    fi
  fi

  if [ "$LINK" -eq 1 ]; then
    ln -s "$from" "$to"
    echo "→ $name (символьне посилання)"
  else
    cp -R "$from" "$to"
    echo "+ $name ($(du -sh "$to" | cut -f1))"
  fi
}

place "rag_metadata.sqlite"
place "$LANCE_DIR"

echo
echo "У теці даних зараз:"
ls -la "$DEST"
