// Anthropic's Telegram channel plugin, as it ships at a pinned commit: fetched once into the
// extension's home, readonly.ts and pulse.ts put beside it, and run as a child MCP server on stdio
// (plain JSON-RPC lines) with readonly.ts and pulse.ts preloaded.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { writeFileAtomic } from "switch-ext-kit"
import type { Json } from "switch-ext-kit"

const PIN = "d7d32797e7e02708d0bb00ffe8b8f2397dc1aea6"
const REPO = "https://github.com/anthropics/claude-plugins-official"
export const HOME = path.resolve("home")
/** The plugin's own state (`TELEGRAM_STATE_DIR`): its `.env`, `access.json`, inbox. */
export const STATE = path.join(HOME, "state")
const PLUGIN = path.join(HOME, "plugin")
const PRELOADS = path.resolve(import.meta.dir, "..", "preload")

/** The plugin's tools at the pin, as its `tools/list` gives them; `speaks` where they send. */
export const PLUGIN_TOOLS = [
  {
    name: "reply",
    speaks: true,
    description:
      "Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or documents.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        text: { type: "string" },
        reply_to: {
          type: "string",
          description:
            "Message ID to thread under. Use message_id from the inbound <channel> block.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each.",
        },
        format: {
          type: "string",
          enum: ["text", "markdownv2"],
          description:
            "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "react",
    speaks: true,
    description:
      "Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        emoji: { type: "string" },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "download_attachment",
    speaks: false,
    description:
      "Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.",
    inputSchema: {
      type: "object",
      properties: {
        file_id: { type: "string", description: "The attachment_file_id from inbound meta" },
      },
      required: ["file_id"],
    },
  },
  {
    name: "edit_message",
    speaks: true,
    description:
      "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
        message_id: { type: "string" },
        text: { type: "string" },
        format: {
          type: "string",
          enum: ["text", "markdownv2"],
          description:
            "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
        },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
] as const

const run = (cmd: readonly string[], cwd: string) => {
  const done = Bun.spawnSync([...cmd], { cwd, stdout: "pipe", stderr: "inherit" })
  // Its stdout is the extension's MCP channel: anything a command says goes to stderr.
  process.stderr.write(done.stdout)
  if (done.exitCode !== 0) {
    throw new Error(`${cmd.slice(0, 2).join(" ")} failed`)
  }
}

/** The plugin at its pin in `home/plugin`, fetched only when the pin changes, its deps installed. */
export const preparePlugin = (): void => {
  const pinned = path.join(PLUGIN, ".pin")
  if (!existsSync(pinned) || readFileSync(pinned, "utf-8").trim() !== PIN) {
    mkdirSync(HOME, { recursive: true })
    const tmp = mkdtempSync(path.join(HOME, ".plugin-"))
    try {
      run(["git", "init", "-q"], tmp)
      run(["git", "remote", "add", "origin", REPO], tmp)
      run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", PIN], tmp)
      run(["git", "sparse-checkout", "set", "external_plugins/telegram"], tmp)
      run(["git", "checkout", "-q", "FETCH_HEAD"], tmp)
      rmSync(PLUGIN, { recursive: true, force: true })
      renameSync(path.join(tmp, "external_plugins", "telegram"), PLUGIN)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    writeFileAtomic(pinned, `${PIN}\n`)
  }
  for (const file of ["readonly.ts", "pulse.ts"]) {
    copyFileSync(path.join(PRELOADS, file), path.join(PLUGIN, file))
  }
  mkdirSync(STATE, { recursive: true })
  run([process.execPath, "install", "--no-summary"], PLUGIN)
}

export interface Child {
  /** A `tools/call`, answered with its JSON-RPC response. */
  readonly call: (name: string, args: unknown) => Promise<Json>
  readonly exited: Promise<number>
  readonly kill: () => void
}

const line = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/** The plugin running with the bot's token; each message of its own (no answer) goes to `heard`. */
export const spawnPlugin = (token: string, heard: (m: Json) => void): Child => {
  const proc = Bun.spawn(
    [process.execPath, "--preload", "./readonly.ts", "--preload", "./pulse.ts", "server.ts"],
    {
      cwd: PLUGIN,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: token, TELEGRAM_STATE_DIR: STATE },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  )
  const send = (m: Json) => {
    void proc.stdin.write(`${JSON.stringify(m)}\n`)
  }
  let asked = 0
  const waiting = new Map<string, (m: Json) => void>()
  const request = async (method: string, params: Json) => {
    const { promise, resolve } = Promise.withResolvers<Json>()
    asked += 1
    const id = `telegram-${String(asked)}`
    waiting.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
    return await promise
  }
  const received = (text: string) => {
    const m = line(text)
    if (Option.isNone(m)) {
      process.stderr.write(`telegram: dropped a line that isn't JSON: ${text.slice(0, 200)}\n`)
      return
    }
    const { id } = m.value
    const answered = typeof id === "string" ? waiting.get(id) : undefined
    if (id === undefined) {
      heard(m.value)
    } else if (answered !== undefined && typeof id === "string" && m.value.method === undefined) {
      waiting.delete(id)
      answered(m.value)
    }
  }
  void (async () => {
    const decoder = new TextDecoder()
    let rest = ""
    for await (const chunk of proc.stdout) {
      rest += decoder.decode(chunk, { stream: true })
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const l of lines.filter((x) => x.trim() !== "")) {
        received(l)
      }
    }
  })()
  const ready = (async () => {
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "switch", version: "1" },
    })
    send({ jsonrpc: "2.0", method: "notifications/initialized" })
  })()
  return {
    call: async (name, args) => {
      await ready
      return await request("tools/call", { name, arguments: args })
    },
    exited: proc.exited,
    kill: () => {
      proc.kill()
    },
  }
}
