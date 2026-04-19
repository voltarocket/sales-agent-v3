#!/bin/bash

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')

# Проверяем только Bash-команды
[ "$TOOL" != "Bash" ] && exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Блокируем git push в любом виде
if echo "$CMD" | grep -qE '(^|[;&|])\s*git\s+push(\s|$)'; then
  echo '{"decision":"block","reason":"🚫 git push заблокирован. Изменения готовы — сообщи пользователю, он запушит сам."}'
  exit 0
fi

# Блокируем создание новых веток
if echo "$CMD" | grep -qE 'git\s+(checkout\s+-[bB]|switch\s+-c|branch\s+[^-])'; then
  echo '{"decision":"block","reason":"🚫 Создание новых веток заблокировано. Работай только в текущей ветке."}'
  exit 0
fi

# Блокируем worktree
if echo "$CMD" | grep -qE 'git\s+worktree\s+add'; then
  echo '{"decision":"block","reason":"🚫 git worktree add заблокирован. Не создавай клоны веток."}'
  exit 0
fi

exit 0