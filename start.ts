// Telegram's channel plugin as a spur: this stands in front of it on stdio. It says what the spur
// needs (a Telegram bot, kind "key") in its handshake, takes the bot's token from the user's
// connections (handing in, once, one a `.env` still keeps), and only then starts the plugin with
// it, replaying the handshake to it. Everything else passes through as it is. Until the bot is
// connected it serves no tools, and once it is, it ends so its host starts it again with the token.
//   bun start.ts <plugin folder>   (run.sh fetches the plugin and runs this)
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const CONNECTIONS = "ax.switch/connections"
const REACHES = "ax.switch/reaches"
const ADDED = "connection.added"
const NEED = { provider: "telegram", kind: "key", label: "Telegram", scopes: [], multiple: false }

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")

const plugin = process.argv[2] ?? "plugin"
const home = process.env.TELEGRAM_STATE_DIR ?? "home"
const envFile = path.join(home, ".env")

const send = (m: Json) => {
  process.stdout.write(`${JSON.stringify(m)}\n`)
}

// Requests of its own to the client, answered on stdin.
let asks = 0
const waiting = new Map<string, (m: Json) => void>()
const ask = async (method: string, params: Json): Promise<Json> => {
  asks += 1
  const id = `telegram-ask-${String(asks)}`
  const answer = new Promise<Json>((resolve) => {
    waiting.set(id, resolve)
  })
  send({ jsonrpc: "2.0", id, method, params })
  const m = await answer
  if (isJson(m.error)) {
    throw new Error(`${method}: ${str(m.error.message) || "refused"}`)
  }
  return isJson(m.result) ? m.result : {}
}

/** A token a Switchboard copy kept in `.env`: handed in once under the bot's own name, then dropped. */
const adoptKept = async () => {
  if (!existsSync(envFile)) {
    return
  }
  const lines = readFileSync(envFile, "utf-8").split("\n")
  const token = lines.find((l) => l.startsWith("TELEGRAM_BOT_TOKEN="))?.slice(19).trim() ?? ""
  if (token === "") {
    return
  }
  const me: unknown = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json()
  const bot = isJson(me) && isJson(me.result) ? str(me.result.username) : ""
  if (bot === "") {
    throw new Error("The kept token isn't a bot's")
  }
  await ask("connections/adopt", { provider: NEED.provider, account: bot, grant: { secret: token } })
  writeFileSync(
    envFile,
    lines.filter((l) => !l.startsWith("TELEGRAM_BOT_TOKEN=")).join("\n"),
    { mode: 0o600 },
  )
}

/** The bot's token, or "" while no bot is connected. */
const tokenOf = async () => {
  await adoptKept()
  const list = await ask("connections/list", { provider: NEED.provider })
  const accounts = Array.isArray(list.accounts) ? list.accounts.filter(isJson) : []
  const account = str(accounts[0]?.account)
  if (account === "") {
    return ""
  }
  return str((await ask("connections/token", { provider: NEED.provider, account })).token)
}

// Until the plugin runs: the handshake is answered here, the rest held.
let initialize: Json | null = null
const held: string[] = []
let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">> | null = null
// No bot connected: it answers for itself, with no tools.
let unconnected = false

const handshake = (m: Json) => {
  const params = isJson(m.params) ? m.params : {}
  send({
    jsonrpc: "2.0",
    id: m.id,
    result: {
      protocolVersion: str(params.protocolVersion) || "2025-06-18",
      serverInfo: { name: "telegram", version: "1" },
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
        extensions: {
          [CONNECTIONS]: { needs: [NEED] },
          [REACHES]: { follows: [ADDED] },
        },
      },
    },
  })
}

const failed = (error: unknown) => {
  process.stderr.write(`telegram: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

// Each client that shakes hands is asked for word of the bot's connecting.
const follow = () => {
  void ask("switch/follow", { types: [ADDED] }).catch(failed)
}

const asUnconnected = (m: Json) => {
  if (m.method === "switch/event") {
    const params = isJson(m.params) ? m.params : {}
    const payload = isJson(params.payload) ? params.payload : {}
    if (params.type === ADDED && payload.provider === NEED.provider) {
      process.exit(0)
    }
    return
  }
  if (m.id === undefined || typeof m.method !== "string") {
    return
  }
  if (m.method === "initialize") {
    handshake(m)
    follow()
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [] } })
  } else if (m.method === "ping") {
    send({ jsonrpc: "2.0", id: m.id, result: {} })
  } else {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Telegram isn't connected" } })
  }
}

const start = async () => {
  const token = await tokenOf()
  if (token === "") {
    unconnected = true
    for (const line of held.splice(0)) {
      const m: unknown = JSON.parse(line)
      if (isJson(m)) {
        asUnconnected(m)
      }
    }
    follow()
    return
  }
  const proc = Bun.spawn(["bun", "--preload", "./readonly.ts", "server.ts"], {
    cwd: plugin,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: token },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  child = proc
  // Its own answer to the replayed handshake is already given.
  const replayed = initialize === null ? null : `replay-${String(initialize.id)}`
  if (initialize !== null) {
    proc.stdin.write(`${JSON.stringify({ ...initialize, id: replayed })}\n`)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  }
  for (const line of held.splice(0)) {
    proc.stdin.write(`${line}\n`)
  }
  void proc.exited.then((code) => process.exit(code))
  let rest = ""
  for await (const chunk of proc.stdout) {
    rest += new TextDecoder().decode(chunk)
    const lines = rest.split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines.filter((l) => l.trim() !== "")) {
      const m: unknown = JSON.parse(line)
      if (!(isJson(m) && m.id === replayed)) {
        process.stdout.write(`${line}\n`)
      }
    }
  }
}

const received = (line: string) => {
  const m: unknown = JSON.parse(line)
  if (!isJson(m)) {
    return
  }
  if (m.method === undefined && typeof m.id === "string" && waiting.has(m.id)) {
    waiting.get(m.id)?.(m)
    waiting.delete(m.id)
    return
  }
  if (unconnected) {
    asUnconnected(m)
    return
  }
  if (m.method === "initialize" && initialize === null) {
    initialize = m
    handshake(m)
    void start().catch(failed)
    return
  }
  if (m.method === "notifications/initialized" && child === null) {
    return
  }
  if (child === null) {
    held.push(line)
  } else {
    child.stdin.write(`${line}\n`)
  }
}

let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  const lines = buffer.split("\n")
  buffer = lines.pop() ?? ""
  for (const line of lines.filter((l) => l.trim() !== "")) {
    received(line)
  }
}
child?.kill()
