<div align="center">

# dsh-vision-opencode

[中文](https://github.com/poiuyjie/dsh-vision-opencode) ｜ [**English**](README.en.md)

*点击上方链接切换语言 · Click the links above to switch languages*

</div>

> **DeepSeek can't see images? Here's an OpenCode-powered multimodal drop-in alternative.**

<p align="center">
  <img src="assets/demo.png" alt="dsh-vision-opencode demo" width="860" />
</p>

A plugin for DeepSeek Harness (DSH) that adds a **configurable vision model** alongside your text-only main model. Your main model (e.g. DeepSeek) can't read images? No problem — images are first understood by a vision model (e.g. MiMo-V2.5) and turned into text, which is then handed to your main model. You never have to swap out your primary model.

- A "vision model" dropdown next to the input box (auto-lists every image-capable model across providers)
- A `vision_read_image` tool: the main model proactively calls it whenever it needs to understand an image (OCR / charts / scene description), with system-prompt guidance
- **Auto-conversion** when the user sends an image in chat: the image is analyzed into text by the vision model first, then given to the main model (the main model never receives the image itself)
- Fault tolerance: 60s per-call timeout, one automatic retry for retriable failures, and a graceful placeholder-text fallback when retries are exhausted (the main model still answers and tells the user)
- Auto-whitelists the image-submission gate (`modelOverrides`) on install; one-click restore on uninstall

## Supported Systems

Tested and verified on **Ubuntu 24.04**. Other systems (macOS, other distros, ...) should be compatible in theory but are unverified; if you hit issues, clone the repo and let an AI tweak it for you:

```bash
git clone https://github.com/poiuyjie/dsh-vision-opencode
```

> Compatibility: built and verified against **DSH `0.1.0-rc.6`**. It relies on two undocumented runtime behaviors — agent-loop requests deep-frozen in the `llm/stream` waterfall, and cordis waterfall `next()` replaying original arguments. If DSH behavior changes in a later rc, upgrade this plugin or turn off the `autoConvert` escape hatch (see below).

## One-click Install / Uninstall

```bash
# Install (idempotent, safe to re-run; restart dsh afterwards)
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash -s -- \
  --vision-provider opencode-go --vision-model mimo-v2.5 \
  --main-provider opencode-go --main-model deepseek-v4-pro --main-model deepseek-v4-flash \
  --proxy http://127.0.0.1:7897

# Uninstall (running it while dsh is up auto-restores modelOverrides; also idempotent)
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.sh | bash
```

- Only pass `--proxy` if your network needs it to reach GitHub/npm.
- `--main-provider` / `--main-model` describe your text main model and are used to auto-whitelist the image-submission gate; omit them and configure manually instead (see below).
- The scripts only touch: the profile's `package.json` dependency, the `cordis.patch.yml` registration entry, and the `vision-opencode` section in `settings.yaml`. Fully idempotent. Uninstall prefers calling the plugin's own `/vision-opencode/uninstall` endpoint to restore `modelOverrides`; if dsh isn't running it degrades to a warning plus manual instructions.

## Manual Install

### Option A: Install from GitHub

```bash
cd ~/.dsh/profiles/web
pnpm add github:poiuyjie/dsh-vision-opencode
```

### Option B: Install from npm

> ⚠️ Not published to npm yet (the package does not exist on the registry). Once published, the shorter command below will work:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-vision-opencode   # not available yet — use Option A for now
```

## Register in cordis

Edit `~/.dsh/profiles/web/cordis.patch.yml` and append:

```yaml
- insert:
    - id: vision-opencode
      name: 'dsh-vision-opencode'
```

## Configuration

Edit `~/.dsh/settings.yaml`:

```yaml
vision-opencode:
  provider: opencode-go      # provider route for the vision model
  model: mimo-v2.5          # vision model id (must really accept images)
  autoConvert: true         # auto-convert toggle (stability escape hatch; set false if problems)
  mainProvider: opencode-go # provider route for the main model (under the pi-ai adapter)
  mainModels:               # text-only main model ids (auto-whitelist the image gate)
    - deepseek-v4-pro
    - deepseek-v4-flash
```

Restart `dsh`. A "vision model" dropdown appears next to the input box; the first selection is written back into settings.

> `mainProvider`/`mainModels` may be left empty: the plugin then changes no config, but sending images to a text-only main model will be rejected by DSH's built-in submission gate (DSH's default safety behavior). Manually declare `input: [text, image]` for the main model under `llm-pi-ai.providers.<provider>.modelOverrides` instead.

## Uninstall (self-clean first, then remove)

```bash
# 1. With dsh running, self-clean once: clears this plugin's settings, removes its modelOverrides
curl -X POST http://127.0.0.1:3080/vision-opencode/uninstall

# 2. Stop dsh (Ctrl+C)

# 3. Remove the dependency and registration entry
cd ~/.dsh/profiles/web
pnpm remove dsh-vision-opencode
#    Edit cordis.patch.yml and remove the vision-opencode insert entry (if only comments remain, replace the file with [])

# 4. Restart dsh
```

> After step 1, `settings.yaml` may keep a single leftover line `vision-opencode: {}` (the placeholder of cleared plugin settings) — harmless; you can delete it in step 3. The one-click uninstall script removes it for you.

**If you skip step 1**: leftover `modelOverrides` in settings will make the text-only main model "claim" to support images, and later image messages will hit the real API and error out. Either manually remove this plugin's entries under `llm-pi-ai.providers.<provider>.modelOverrides` in `settings.yaml`, or run `curl -X POST .../vision-opencode/uninstall` and restart.

A plugin load failure won't take DSH down: the cordis loader isolates per entry — a failed plugin shows as failed in "Settings → Plugins" while everything else keeps working.

## Error Handling Matrix

| Situation | Behavior |
|---|---|
| Rate-limit / timeout / 5xx / transport errors on the vision call | Retry once after 800ms backoff (2 attempts total) |
| Non-retriable failures (AUTH/4xx, etc.) | No retry; fall back immediately |
| Retries exhausted (auto-convert path) | Fall back to placeholder text; the main model still answers and informs the user |
| Retries exhausted (`vision_read_image` tool path) | Tool result is `isError` (benign); the main model continues |
| A single call hangs | Independent 60s timeout per attempt |
| User cancels the turn | Abort immediately; no pointless fallback |
| Unexpected plugin bug | Last resort: all images degrade to placeholder text; the turn is never killed |

## Rollback / Escape Hatch

- To only disable auto-conversion (keep the tool and selector): set `vision-opencode.autoConvert: false` in `settings.yaml` and restart.
- Full rollback: run the uninstall flow above. After rollback, behavior equals the uninstalled state (image messages are normally rejected by DSH's gate and never hit the API).

## Known Limitations

- The frontend selector is a hand-written DSH client bundle (`window.__ModuleLoader__` format); the client interface may change between rc releases. If the selector doesn't appear, open the browser console and file the error as an issue.
- The `SYNTHETIC_IMAGE_MODELS` blacklist (top of index.js) is a hardcoded legacy leftover; prefer the `mainModels` config — both merge automatically.
- Auto-conversion happens at request time; the analyzed text is not written into the persistent session log (it can still survive session compaction, since compaction requests pass through the same conversion waterfall).
- Auto-whitelisting of the main-model gate is only supported under the pi-ai adapter; configure manually for other adapters.

## License

MIT
