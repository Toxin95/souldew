# Privacy: what souldew sends

souldew has no account and no analytics. Your games, save files and runs stay on your computer; between players
only tracker data travels, encrypted with the key from your invite. The website's privacy policy (German, legally
binding): <https://souldew.app/datenschutz.html>.

This page is about the one thing souldew reports by itself: the anonymous **“playing now”** count.

## “Playing now”

The souldew Discord shows how many people are playing in souldew right now – the locked channel
“🎮 Playing now: N” and the bot's status (“Watching 42 trainers play souldew”). The team sees the same totals by
system, mode and version, to see how busy it gets and to plan for it.

### When

Only while a game **actually runs** in souldew's own players – the fast player, the 3DS player or the browser
player – from the moment the game has started (not while it loads) until it closes. Not in the library, not in a run's
board, not while an external emulator (mGBA, melonDS, Azahar) runs on its own.

- Once when the game has started, then once a minute (the bot may ask for a slower beat, up to every 15 minutes).
- Once more, “stopped”, when you close the game, switch the setting off, or quit souldew (at most 1.5 seconds; a
  crash or a lost connection simply means no more heartbeats – the bot forgets the game after 3 minutes).
- Offline, or when the bot can't be reached: nothing happens. No retry queue, no error, no log entry.

### What

The local souldew server (on your computer, not the page) sends one request:

```http
POST https://api.souldew.app/presence
Content-Type: application/json

{"sid":"3q2-7wZbQ0m0Zb5n9mCk4A","system":"gba","mode":"soullink","v":"2.7.4"}
```

| Field    | What it is                                                                                              |
|----------|---------------------------------------------------------------------------------------------------------|
| `sid`    | 16 random bytes (base64url), made when the game starts. New for every game, never written to disk, not derived from anything – not from your computer, your name, the run or the game. |
| `system` | `gb` (Game Boy and Game Boy Color), `gba`, `nds` or `3ds`.                                               |
| `mode`   | `solo` (a game from the library), `nuzlocke` or `soullink`.                                              |
| `v`      | the souldew version, e.g. `2.7.4`.                                                                       |

When the game closes: `{"sid":"…","stop":true}`. If `api.souldew.app` gives no answer at all (some DNS filters), the
same request goes to the bot's older address `souldew-discord-bot.sweeparena.workers.dev` – the same bot.

**Never sent:** your name or player name, a Discord account, the game's title or code, the ROM or anything about it,
file paths, run names, partners, Pokémon, progress, settings, or anything about your computer beyond what every
internet request carries (your IP address, see below).

### What the bot keeps

The bot is a Cloudflare Worker with a Cloudflare D1 database, run by the souldew team:

- **Per running game:** the `sid`, `system`, `mode`, `v` and the time of the last heartbeat. Deleted once the game has
  sent nothing for 3 minutes (the cleanup runs every 5 minutes), or at once with the “stopped” message.
- **History:** only totals – how many games ran, by system and by mode – one entry per 5 minutes, kept 90 days.
- **Not kept:** your IP address. Cloudflare necessarily sees it to deliver the request; the bot doesn't store it and
  doesn't log request bodies. To stop floods it allows each address 30 heartbeats a minute, using Cloudflare's
  in-memory rate limiter keyed by a hash of the address – nothing is written down.
- There are no profiles: a `sid` can't be linked to a person, and a new game gets a new one.

Anyone can read the totals: <https://api.souldew.app/presence> →
`{"online":42,"bySystem":{…},"byMode":{…},"byVersion":{…},"updated":"…","window":180}`.

### Switching it off

Settings › General › **“Count me in ‘playing now’ (anonymous)”** – on by default. Off applies at once: a running game
sends “stopped” right away and nothing more. The setting is stored in your local `config.json` as `"presence": false`.

The code: [`web/lib/presence.mjs`](../web/lib/presence.mjs) (when a game runs) and
[`server/lib/presence.mjs`](../server/lib/presence.mjs) (the request).

## Other connections

For completeness – none of these carry anything about you beyond the request itself:

- **Updates:** at start and every four hours souldew asks GitHub for a new version.
- **Playing together:** SoulLink apps find each other over public Nostr relays and then connect directly (WebRTC),
  with a public MQTT broker as a fallback. Only encrypted tracker data – never games or saves.
- **Pictures:** Pokémon sprites and game covers are loaded from public GitHub repositories (PokeAPI,
  libretro-thumbnails) and cached.
- **Discord, only if you set it up:** a Discord webhook you enter for a run, or Live runs (Settings › Discord), which
  post the events you share.
