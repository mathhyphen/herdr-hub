# herdr-hub

**English** | [简体中文](./README.zh-CN.md)

**A zero-dependency, single-file service that turns herdr agent sessions scattered across multiple servers into one mobile-first web UI.**

## What it solves

Scenario (fictional but typical): you have three GPU servers `srv-a` / `srv-b` / `srv-c`, each running a dozen conversation agents inside herdr. Mid-task they **stop and wait for your confirmation** — for a `y`, for an Enter — before they continue. You are not at your desk:

- SSH + tmux on a phone is barely usable: the soft keyboard cannot send vim keys, a flaky network drops the session, and 80 columns of text scroll into misery;
- by the time you get back to your desk, several agents have been standing around for half an hour.

herdr-hub answers in one line: **open a URL → see who needs you → tap once to unblock.**

## Demo (12 shots · 33 seconds · fictional data)

<p align="center">
  <img width="300" alt="herdr-hub demo: three server tabs · conversation detail · ⌨ key panel one-tap unblock · 🎤 voice input (all fictional data)" src="_demo/video/herdr_ui_final.gif">
</p>

> The server names / project names / paths / conversations on screen are all fabricated demo data, and the footage has passed a privacy self-check (frame-by-frame visual transcription, forbidden term `residual={}`, verdict `PASS`; evidence in `_demo/video/privacy_check.txt`, which is not published with the repository).

## Features

- **Three server tabs — aggregated, but kept apart**: every machine behind a single URL, yet the tabs on top give **one screen per machine, never mixed**, swipe left/right to switch. Lists group by `needs you / working / idle`; each row shows a status dot, the repository name, the agent type, and what it said last (preview).
- **Conversation detail (a chat view, not a terminal)**: your prompts bubble on the right; the agent's reply renders as body text (code blocks, tables, links); **transcript** and **tool calls** fold into a single card (collapsed: one line `› bash find …`; expand to see input and output); **thinking** stays collapsed by default.
- **⌨ Key panel to unblock**: `esc / ↑ / ↓ / tab / y / n / 1 / 2 / Ctrl-C`, sent straight into that agent's terminal — when an agent sits waiting for `y`/Enter, one tap on your phone keeps it moving.
- **🔊 Read-aloud**: the top-right of the detail page reads the latest reply aloud with system speech synthesis (markdown is stripped first, so code blocks are never spoken), tap again to stop. The browser's built-in `speechSynthesis`, zero backend.
- **⋯ Session management**: re-pick the session record, show the session file path, reload the conversation; the `▤` in the top-right also toggles between the conversation and the raw terminal screen.
- **🎤 Voice input**: record a snippet to fill the input box — **fills only, never auto-sends**.
- **Token auth**: every page and every API requires `?t=<token>`; anything missing gets 401.

## Architecture notes

1. **Each server runs its own herdr CLI (over SSH)**. The hub embeds no herdr protocol of its own — it SSHes into each machine and runs **that machine's own** herdr command (remote commands are always built from argv arrays with POSIX single-quote escaping). So **different proto versions coexist with no negotiation** — the hub never "talks protocol" to them; proto 16 and 19 ran side by side in testing without conflicts.
2. **Read/write separation**: read = parse the session file and render chat bubbles; write = send into the pane. A parse failure never blocks you from sending a message.
3. **Transcript parsing**: pi and codex session files differ in format (pi gives a path, `agent_session.kind="path"`; codex gives an id, `kind="id"` → the matching `rollout-*.jsonl`), and the files can be huge (a single codex one reaches 20MB+), so only the tail is `tail`ed — never the whole file.
4. **Same-cwd ambiguity returns `ambiguous` plus candidates for you to pick — never a guess**: when herdr cannot report the exact path, the hub lists the candidates so you claim one once and it gets remembered (`pane-bindings.json`), instead of picking one and showing the wrong conversation — **prefer returning "ambiguous" over ever showing another agent's conversation**.
5. **Zero npm dependencies = one file, `hub.mjs`**: Node built-ins only, `npm install` simply does not exist here; the icon is a PNG hand-rolled from zlib at runtime.
6. **Robustness**: servers are fully isolated from each other (one going down only takes down its own tab, 15-second backoff); the cache is written only on a definite conclusion (one SSH hiccup never gets recorded as "this machine has no sessions"); session file paths pass strict allowlisting (safe characters, must end in `.jsonl`, must live under an allowed sessions directory).

## Quick start

```bash
git clone <repo>
cp servers.example.json servers.json          # your servers
cp hub.config.example.json hub.config.json    # optional: speech service URL
echo "<your token>" > token.txt
node hub.mjs
```

Open `http://<host>:8787/?t=<token>` in a browser (the token is stored in the browser after the first visit, so you never retype it).

Phone: reach it directly from the same LAN or inside Tailscale; in Safari use "Share → Add to Home Screen" and from then on it runs full-screen, like a native app.

> `pane-bindings.example.json` is a reference sample — you normally never create it by hand; the frontend writes `pane-bindings.json` automatically when a claim happens.

## Configuration

### `servers.json` (required; see `servers.example.json`)

| Field | Meaning |
|---|---|
| `id` | Short name, used as the panel's tab key and in `pane-bindings` (e.g. `srv-a`) |
| `label` | Name displayed in the UI |
| `host` | SSH target (can be a Host alias straight from `~/.ssh/config`) |
| `bin` | **Absolute path of the herdr executable on that machine** — a non-interactive SSH PATH usually omits `~/.local/bin`, so an absolute path is mandatory (a lesson learned the hard way) |

Adding a server = adding one row; no code changes.

### `hub.config.json` (optional, speech recognition; see `hub.config.example.json`)

| Field | Meaning |
|---|---|
| `asr.url` | Your local speech model endpoint, e.g. `http://127.0.0.1:8123/v1/audio/transcriptions` |
| `asr.token` | Fill in if the endpoint needs auth, otherwise leave empty |
| `asr.language` | e.g. `zh` |
| `asr.field` | Audio field name, default `file` |
| `asr.model` | Model name, may stay empty |
| `asr.timeoutMs` | Timeout, default 60000 |

Protocol: the hub POSTs `multipart/form-data` to `asr.url` (`file` = audio binary, webm/m4a/wav, plus `language`) and your service returns `{"text": "..."}` — whisper.cpp server's `/inference` and the OpenAI-compatible `/v1/audio/transcriptions` both qualify as-is, **no code changes**: fill it in, refresh the page, and 🎤 appears.

### `pane-bindings.json` (auto-generated; see `pane-bindings.example.json`)

key = `<serverId>:<paneId>`, value = the absolute path of that agent's session file. Written only in the "several agents in the same directory, herdr cannot report the path, you claim it by hand" case.

### `token.txt`

One line holding your own token; never commit it to any repo (already gitignored here).

### Environment variables

`HUB_PORT` (default 8787), `HUB_BIND` (default 0.0.0.0), `HUB_TOKEN` (set to `off` to disable auth), `HUB_TAIL_BYTES` (how many trailing bytes of a transcript to read).

## Security

- **Token required, 401 otherwise**: pages and every `/api/*` demand `?t=` or an equivalent header.
- **Bind to the LAN or Tailscale only — do not expose it to the public internet** — this hub holds the SSH path into all of your servers.
- `servers.json` / `token.txt` / `hub.config.json` / `pane-bindings.json` **are listed in `.gitignore` and never upload**; the repo carries only `*.example.json` with fictional values.
- **HTTPS** (iOS **requires HTTPS** before it grants microphone access) — one Tailscale command:

  ```bash
  tailscale serve --bg --https 443 http://127.0.0.1:8787
  ```

  Your phone then visits `https://<your-machine-name>.<your-tailnet-domain>`, with the certificate issued automatically by Tailscale.

## Known limitations (honest version)

- **The machine running the hub must stay online**: the hub is essentially an SSH bridge from this machine to each server; shut this machine down and it stops working. For 24×7, move it to an always-on machine and run `node hub.mjs` — no platform dependencies.
- **Status comes from 6-second polling, not push** (4 seconds on the conversation detail page); once a list is open, previews are backfilled in the background, so individual rows can take ten-plus seconds.
- **Voice input currently hardcodes `127.0.0.1:8123`**: a phone browser resolves that to the phone's own loopback address, so **a direct connection fails**. The hub already ships a `/api/transcribe` proxy endpoint; moving the frontend onto it is a clear TODO.
- **The send path has never been tested end-to-end** (text is never injected into an agent you are actively working with just to test); failure detection is verified, and `POST /api/send` with `{"dry":true}` echoes back the command it would run, if you want to inspect command construction.
- Multi-line input is collapsed to a single line before sending (a bare newline in a TUI means "submit"); after a hub restart the "duration" counter resets, and it shows nothing rather than a fake "just now".

## License

MIT — see [LICENSE](LICENSE).
