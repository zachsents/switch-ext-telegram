// Telegram's channel plugin, as it ships, held to reading when SWITCH_READ_ONLY is set: loaded
// before it (`bun --preload`), this refuses every Bot API method that writes to Telegram (a
// message, a reaction, typing, the bot's commands), so the plugin's own fire-and-forget calls
// fail quietly. Getting updates and files still works.
import { Api } from "grammy"

const READS = new Set(["getMe", "getUpdates", "getFile", "deleteWebhook", "getChat"])

if (process.env.SWITCH_READ_ONLY === "1") {
  const proto: object = Api.prototype
  for (const name of Object.getOwnPropertyNames(proto)) {
    const was: unknown = Reflect.get(proto, name)
    if (name !== "constructor" && !READS.has(name) && typeof was === "function") {
      Reflect.set(proto, name, async () => {
        throw new Error(`Read-only: ${name} refused`)
      })
    }
  }
  process.stderr.write("telegram: read-only, sending nothing\n")
}
