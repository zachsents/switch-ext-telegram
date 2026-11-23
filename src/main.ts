// Telegram's channel plugin as an extension: the plugin runs behind it as a child MCP server, with
// the bot's token from the user's connections (handing in, once, one a `.env` still keeps). Its
// tools are the plugin's own, passed through; each message the plugin hears is a `telegram.message`
// event. Until a bot is connected its tools say so, and once one is, it ends so its host starts it
// again with the token. Its `heartbeat` event (vitals/telegram) says what is failing now.
import { chmodSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Context, Deferred, Effect, Layer, Option, Queue, Schema } from "effect"
import {
  AppEvents,
  defineApp,
  defineRecord,
  Host,
  isJson,
  Models,
  serveStdio,
  writeFileAtomic,
} from "switch-ext-kit"
import type { AppEventsService, Draft, Followed, HostService, Json, Tool } from "switch-ext-kit"

import { BEAT_MS, Heartbeat, heart, pulseOf } from "./heartbeat.ts"
import type { Pulse } from "./heartbeat.ts"
import { PLUGIN_TOOLS, preparePlugin, spawnPlugin, STATE } from "./plugin.ts"
import type { Child } from "./plugin.ts"

const NAME = "telegram"
const ADDED = "connection.added"
const CHANNEL = "notifications/claude/channel"
const PULSE = "telegram/pulse"
const ENV_FILE = path.join(STATE, ".env")
const KEPT = "TELEGRAM_BOT_TOKEN="

/** A channel's message: one of the user's own front doors (a bot only they can message). */
export const Message = defineRecord("telegram.message", {
  kind: "message",
  stream: `comms/${NAME}`,
})

const str = (v: unknown) => (typeof v === "string" ? v : "")

/** The plugin's `notifications/claude/channel` as the shim made it: its sender is the user. */
const message = (params: Json): Draft => {
  const meta = isJson(params.meta) ? params.meta : {}
  const text = (k: string) => str(meta[k])
  const id =
    text("message_id") === "" ? crypto.randomUUID() : `${text("chat_id")}:${text("message_id")}`
  const ts = text("ts") === "" ? new Date().toISOString() : text("ts")
  const content = str(params.content)
  return Message.record(
    { content, meta },
    {
      id,
      at: ts,
      sender: { handle: text("user") || text("user_id"), via: NAME, me: true },
      message: {
        id: `${NAME}:${id}`,
        conversation: `${NAME}:${text("chat_id")}`,
        text: content,
        at: Date.parse(ts),
        channel: NAME,
      },
    },
  )
}

const failed = (error: unknown) =>
  Effect.sync(() => {
    process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })

const decodeMe = Schema.decodeUnknownOption(
  Schema.Struct({ result: Schema.Struct({ username: Schema.String }) }),
)

/** The plugin, once it runs: a tool call is answered by it. */
export class Bot extends Context.Service<
  Bot,
  { readonly call: (name: string, args: unknown) => Effect.Effect<string, Error> }
>()("telegram/Bot") {
  static readonly layer: Layer.Layer<Bot, never, HostService | AppEventsService> = Layer.effect(
    Bot,
    Effect.gen(function* making() {
      const host = yield* Host
      const events = yield* AppEvents
      // The running plugin, or `null` while no bot is connected.
      const started = yield* Deferred.make<Child | null>()
      const beat = heart()
      let pulse: Pulse = { poll: null, skipped: {} }
      const emit = (draft: Draft | null) =>
        draft === null ? Effect.void : events.emit(draft).pipe(Effect.catch(failed))

      /** A token a Switchboard copy kept in `.env`: handed in once under the bot's own name, then dropped. */
      const adoptKept = Effect.gen(function* adopting() {
        if (!existsSync(ENV_FILE)) {
          return
        }
        const lines = readFileSync(ENV_FILE, "utf-8").split("\n")
        const token =
          lines
            .find((l) => l.startsWith(KEPT))
            ?.slice(KEPT.length)
            .trim() ?? ""
        if (token === "") {
          return
        }
        const me = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
            const got: unknown = await res.json()
            return got
          },
          // Its URL holds the token: the error says nothing of it.
          catch: () => new Error("Can't reach Telegram to check the kept token"),
        })
        const bot = yield* Effect.succeed(
          Option.match(decodeMe(me), { onNone: () => "", onSome: (m) => m.result.username }),
        ).pipe(
          Effect.filterOrFail(
            (b) => b !== "",
            () => new Error("The kept token isn't a bot's"),
          ),
        )
        yield* host.request(
          "connections/adopt",
          { provider: NAME, account: bot, grant: { secret: token } },
          Schema.Unknown,
        )
        writeFileAtomic(ENV_FILE, lines.filter((l) => !l.startsWith(KEPT)).join("\n"))
        chmodSync(ENV_FILE, 0o600)
      })

      /** The bot's token, or "" while no bot is connected. */
      const tokenOf = Effect.gen(function* token() {
        yield* adoptKept
        const account = (yield* host.accounts(NAME))[0] ?? ""
        return account === "" ? "" : yield* host.token(NAME, account)
      })

      // What the plugin says of its own: its messages, and its polling loop's pulse.
      const heard = yield* Queue.unbounded<Json>()
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* hearing() {
            const m = yield* Queue.take(heard)
            const params = isJson(m.params) ? m.params : {}
            if (m.method === CHANNEL) {
              yield* emit(message(params))
            } else if (m.method === PULSE) {
              pulse = pulseOf(params)
              yield* emit(beat(true, pulse))
            }
          }),
        ),
      )

      const start = Effect.gen(function* starting() {
        const token = yield* tokenOf
        if (token === "") {
          yield* Deferred.succeed(started, null)
          // No loop runs until a bot is connected: it says so on its own beat.
          yield* Effect.forever(
            Effect.andThen(
              Effect.suspend(() => emit(beat(false, pulse))),
              Effect.sleep(BEAT_MS),
            ),
          )
        }
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            spawnPlugin(token, (m) => {
              Queue.offerUnsafe(heard, m)
            }),
          ),
          (c) => Effect.sync(c.kill),
        )
        void child.exited.then((code) => process.exit(code))
        yield* Deferred.succeed(started, child)
      })
      yield* Effect.forkScoped(start.pipe(Effect.catch(failed)))

      // Word of the bot's connecting: with none connected, it ends so its host starts it with one.
      const added = (e: Followed) =>
        Effect.gen(function* adding() {
          if (!isJson(e.payload) || e.payload.provider !== NAME) {
            return
          }
          if ((yield* Deferred.await(started)) === null) {
            // After the kit has kept this event as handled, so a restart doesn't hear it again.
            setTimeout(() => process.exit(0), 1000)
          }
        })
      yield* Effect.forkScoped(host.follow([ADDED], added).pipe(Effect.catch(failed)))

      return {
        call: (name, args) =>
          Effect.gen(function* calling() {
            const child = yield* Deferred.await(started)
            if (child === null) {
              return yield* Effect.fail(new Error("Telegram isn't connected"))
            }
            const m = yield* Effect.promise(async () => await child.call(name, args ?? {}))
            if (isJson(m.error)) {
              return yield* Effect.fail(new Error(str(m.error.message) || "refused"))
            }
            const result = isJson(m.result) ? m.result : {}
            const content = Array.isArray(result.content) ? result.content.filter(isJson) : []
            // Its answers are text: one block each.
            const text = content.map((c) => str(c.text)).join("\n")
            return result.isError === true ? yield* Effect.fail(new Error(text)) : text
          }),
      }
    }),
  )
}

/** Any input passes as it is, to the plugin, which reads it; its schema is listed as it gave it. */
const literal = (schema: Readonly<Record<string, unknown>>): Tool<Bot>["input"] => ({
  "~standard": {
    version: 1,
    vendor: NAME,
    validate: (value) => ({ value }),
    jsonSchema: { input: () => ({ ...schema }), output: () => ({ ...schema }) },
  },
})

const tools = PLUGIN_TOOLS.map((t): Tool<Bot> => ({
  name: t.name,
  description: t.description,
  readOnly: false,
  speaks: t.speaks,
  appOnly: false,
  input: literal(t.inputSchema),
  run: (input) =>
    Effect.gen(function* running() {
      return yield* (yield* Bot).call(t.name, input)
    }),
}))

const app = defineApp<Bot>({
  name: NAME,
  version: "1",
  connections: [{ provider: NAME, kind: "key", label: "Telegram", scopes: [], multiple: false }],
  reaches: { follows: [ADDED] },
  tools,
  events: [Message, Heartbeat],
})

preparePlugin()
await serveStdio(app, Layer.provideMerge(Bot.layer, Models.layer))
