// The heartbeat: how the sense is, said by the loop that senses (pulse.ts reports it): every five
// minutes, and at once when what's failing changes.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { defineRecord, isJson } from "switch-ext-kit"
import type { Draft, Json } from "switch-ext-kit"

import { STATE } from "./plugin.ts"

export const Heartbeat = defineRecord("telegram.heartbeat", {
  kind: "observation",
  stream: "vitals/telegram",
})

export const BEAT_MS = 5 * 60_000

/** The polling loop's last word (pulse.ts): its last call's error, and updates it couldn't take in. */
export interface Pulse {
  readonly poll: string | null
  readonly skipped: Readonly<Record<string, string>>
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

/** A `telegram/pulse` line's params. */
export const pulseOf = (params: Json): Pulse => {
  const skipped = isJson(params.skipped) ? params.skipped : {}
  return {
    poll: typeof params.poll === "string" ? params.poll : null,
    skipped: Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, str(v)])),
  }
}

const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const NO_ONE = "access: no one is paired, so every message is dropped"

/** Who may write to the bot, as the plugin's access.json has it: nothing gets in without someone. */
const access = () => {
  const file = path.join(STATE, "access.json")
  if (!existsSync(file)) {
    return { trouble: NO_ONE, allowed: 0, pending: 0 }
  }
  const a = parsed(readFileSync(file, "utf-8"))
  if (Option.isNone(a)) {
    return { trouble: "access: access.json is unreadable", allowed: 0, pending: 0 }
  }
  const kept = isJson(a.value) ? a.value : {}
  const allowed = Array.isArray(kept.allowFrom) ? kept.allowFrom.length : 0
  const groups = isJson(kept.groups) ? Object.keys(kept.groups).length : 0
  const pending = isJson(kept.pending) ? Object.keys(kept.pending).length : 0
  if (kept.dmPolicy === "disabled") {
    return { trouble: "access: messages are off (dmPolicy disabled)", allowed, pending }
  }
  return { trouble: allowed + groups === 0 ? NO_ONE : null, allowed, pending }
}

/** What beats: each call is a heartbeat to emit, or `null` while nothing changed within five minutes. */
export const heart = (): ((connected: boolean, pulse: Pulse) => Draft | null) => {
  let beatAt = 0
  let said: string | null | undefined
  return (connected, pulse) => {
    const skipped = Object.entries(pulse.skipped)
    const latest = skipped.at(-1)
    const seen = access()
    const parts = connected
      ? [
          ...(pulse.poll === null ? [] : [`polling: ${pulse.poll}`]),
          ...(latest === undefined
            ? []
            : [
                `skipped ${String(skipped.length)} update${skipped.length === 1 ? "" : "s"} it couldn't take in (latest ${latest[0]}: ${latest[1]})`,
              ]),
          ...(seen.trouble === null ? [] : [seen.trouble]),
        ]
      : ["Telegram isn't connected"]
    const failing = parts.length === 0 ? null : parts.join("; ")
    if (Date.now() - beatAt < BEAT_MS && failing === said) {
      return null
    }
    said = failing
    beatAt = Date.now()
    return Heartbeat.record({
      entity: "sense:telegram",
      summary: (failing === null ? "Polling" : `Failing: ${failing}`).slice(0, 600),
      facts: {
        failing,
        polling: connected && pulse.poll === null,
        skipped: pulse.skipped,
        allowed: seen.allowed,
        pending: seen.pending,
      },
    })
  }
}
