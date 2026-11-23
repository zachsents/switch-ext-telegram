// The plugin's polling loop, as start.ts hears it: loaded before the plugin (`bun --preload`), this
// says on stdout, as a `telegram/pulse` line start.ts takes out, how each of the loop's calls to
// Telegram went, and which updates it couldn't take in. An update whose handling fails is kept
// (in the state folder's skipped.json) and tried again after each poll until it goes through.
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Api, Bot } from "grammy"

type Update = Parameters<Bot["handleUpdate"]>[0]
interface Skipped {
  readonly why: string
  readonly at: number
  readonly update: Update
}

const PULSE = "telegram/pulse"
const KEPT = 100
const file = path.join(process.env.TELEGRAM_STATE_DIR ?? ".", "skipped.json")

const load = (): Record<string, Skipped> => {
  try {
    const kept: unknown = JSON.parse(readFileSync(file, "utf-8"))
    return typeof kept === "object" && kept !== null ? (kept as Record<string, Skipped>) : {}
  } catch {
    return {}
  }
}

const skipped = load()
let poll: string | null = null

const save = () => {
  try {
    writeFileSync(file, JSON.stringify(skipped), { mode: 0o600 })
  } catch (error) {
    process.stderr.write(`telegram: can't keep skipped updates: ${String(error)}\n`)
  }
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

const pulse = () => {
  const why = Object.fromEntries(Object.entries(skipped).map(([id, s]) => [id, s.why]))
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: PULSE, params: { poll, skipped: why } })}\n`,
  )
}

// Read-only refuses sends on purpose: a reply it couldn't make is no update it failed to take in.
const refused = (error: unknown) => said(error).startsWith("Read-only:")

const proto = Bot.prototype
const handle = proto.handleUpdate
const init = proto.init
let bot: Bot | null = null

proto.init = async function started(this: Bot, signal) {
  bot = this
  await init.call(this, signal)
}

proto.handleUpdate = async function handleUpdate(this: Bot, update, envelope) {
  try {
    await handle.call(this, update, envelope)
  } catch (error) {
    const cause = error instanceof Error && "error" in error ? error.error : error
    if (!refused(cause)) {
      skipped[String(update.update_id)] = { why: said(cause), at: Date.now(), update }
      for (const id of Object.keys(skipped).slice(0, -KEPT)) {
        Reflect.deleteProperty(skipped, id)
      }
      save()
    }
    throw error
  }
}

/** Those skipped before, again, one at a time; each that goes through is let go. */
const retry = async () => {
  const ids = Object.keys(skipped)
  if (bot === null || ids.length === 0) {
    return
  }
  for (const id of ids) {
    const kept = skipped[id]
    if (kept === undefined) {
      continue
    }
    try {
      await handle.call(bot, kept.update)
      Reflect.deleteProperty(skipped, id)
    } catch (error) {
      const cause = error instanceof Error && "error" in error ? error.error : error
      if (refused(cause)) {
        Reflect.deleteProperty(skipped, id)
      } else {
        skipped[id] = { ...kept, why: said(cause), at: Date.now() }
      }
    }
  }
  save()
}

// The loop's own calls: starting (getMe, deleteWebhook) and each poll (getUpdates).
const api: Record<string, unknown> = Api.prototype as unknown as Record<string, unknown>
for (const name of ["getMe", "deleteWebhook", "getUpdates"]) {
  const was = api[name]
  if (typeof was !== "function") {
    continue
  }
  api[name] = async function called(this: Api, ...args: unknown[]) {
    try {
      const got: unknown = await Reflect.apply(was, this, args)
      poll = null
      if (name === "getUpdates") {
        await retry()
      }
      pulse()
      return got
    } catch (error) {
      poll = said(error)
      pulse()
      throw error
    }
  }
}
