**Moved to [zachsents/switch](https://github.com/zachsents/switch/tree/main/extensions/telegram).** This repo is archived.

# switch-ext-telegram

Anthropic's Telegram channel plugin, as it ships.

A [Switch](https://switch.ax) extension on [switch-ext-kit](https://github.com/zachsents/switch-ext-kit). It fetches the plugin at a pinned commit
into `home/plugin` and runs it as a child MCP server: its tools are the plugin's own, and each message the bot gets is a `telegram.message`
event carrying who sent it, for Switch's inbox and Contacts, kept in the extension's outbox until Switch has it.

## Install

Ask Switch's agent to install `github:zachsents/switch-ext-telegram`, or add it in the desktop's Extensions view (⌘K, Extensions). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Make a bot with BotFather and connect it in Switch's connections (Telegram, a key). A `TELEGRAM_BOT_TOKEN=<token>` left in a `.env` in the
extension's `home/state` is handed to Switch's connections on its next start and dropped from the file. Its access list (`access.json`, from the
plugin's pairing) stays there. While Switch is read-only, it sends nothing, not even typing.
