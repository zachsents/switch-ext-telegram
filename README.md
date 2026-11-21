# switch-ext-telegram

Anthropic's Telegram channel plugin, as it ships.

A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`, a Switchboard appendage) that Switch runs through
[switch-ext-kit](https://github.com/zachsents/switch-ext-kit)'s shim. Its messages carry who sent them, for Switch's inbox and Contacts.

## Install

Ask Switch's agent to install `github:zachsents/switch-ext-telegram`, or add it in the desktop's Extensions view (⌘K, Extensions). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Make a bot with BotFather. Put `TELEGRAM_BOT_TOKEN=<token>` in a `.env` in the extension's `home/state` once: on its next start it hands the token to Switch's connections and drops it from the file. Its access list (`access.json`, from the plugin's pairing) stays there. While Switch is read-only, it sends nothing, not even typing.
