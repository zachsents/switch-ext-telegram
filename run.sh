#!/bin/sh
# Anthropic's Telegram channel plugin, as it ships at a pinned commit, fetched once into the
# extension's home and run behind start.ts (its token from Switch's connections) with readonly.ts
# and pulse.ts preloaded.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home=${SB_HOME:-$here/home}
pin=d7d32797e7e02708d0bb00ffe8b8f2397dc1aea6
plugin=$home/plugin
if [ "$(cat "$plugin/.pin" 2>/dev/null)" != "$pin" ]; then
  tmp=$(mktemp -d)
  git -C "$tmp" init -q
  git -C "$tmp" remote add origin https://github.com/anthropics/claude-plugins-official
  git -C "$tmp" fetch -q --depth 1 --filter=blob:none origin "$pin"
  git -C "$tmp" sparse-checkout set external_plugins/telegram
  git -C "$tmp" checkout -q FETCH_HEAD
  rm -rf "$plugin" && mkdir -p "$home"
  mv "$tmp/external_plugins/telegram" "$plugin"
  rm -rf "$tmp"
  echo "$pin" > "$plugin/.pin"
fi
cp "$here/readonly.ts" "$here/pulse.ts" "$plugin/"
mkdir -p "$home/state"
export TELEGRAM_STATE_DIR="$home/state"
cd "$plugin"
bun install --no-summary 1>&2
exec bun "$here/start.ts" .
