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
- A runtime `vision-image-analysis` skill that guides the main model to call `vision_read_image` for OCR, charts, screenshots, and scenes; it gracefully falls back to tool and prompt guidance when DSH's skill service is absent
- **Auto-conversion** for chat attachments, with native DSH `notice` context injections showing in-progress, completed, failed, and cache-reuse states
- Exact route scoping: only configured `mainProvider/mainModels` routes are intercepted; other providers and natively multimodal main models retain DSH's native image handling
- Fault tolerance: 60s per-call timeout, one automatic retry for retriable failures, and a graceful placeholder-text fallback when retries are exhausted (the main model still answers and tells the user)
- Auto-whitelists the image-submission gate (`modelOverrides`), records prior values privately, and restores only plugin-owned fields that users have not changed since

## Supported Systems

Tested and verified on **Ubuntu 24.04**. Other systems (macOS, other distros, ...) should be compatible in theory but are unverified; if you hit issues, clone the repo and let an AI tweak it for you:

```bash
git clone https://github.com/poiuyjie/dsh-vision-opencode
```

> Compatibility: built and verified against **DSH `0.1.0-rc.6`**. It relies on two undocumented runtime behaviors — agent-loop requests deep-frozen in the `llm/stream` waterfall, and cordis waterfall `next()` replaying original arguments. If DSH behavior changes in a later rc, upgrade this plugin or turn off the `autoConvert` escape hatch (see below).

## One-click Install / Uninstall

```bash
# Install (idempotent, safe to re-run; restart dsh afterwards)
# No vision model is preset: without --vision-*, pick one after install from the
# "识图模型" dropdown next to the input box (it lists image-capable models across
# all your providers; --vision-* is optional, to pin a specific vision model)
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/install.sh | bash -s -- \
  --main-provider opencode-go --main-model deepseek-v4-pro --main-model deepseek-v4-flash \
  --proxy http://127.0.0.1:7897

# Uninstall (running it while dsh is up auto-restores modelOverrides; also idempotent)
curl -fsSL https://raw.githubusercontent.com/poiuyjie/dsh-vision-opencode/main/scripts/uninstall.sh | bash
```

- `--vision-provider` / `--vision-model` are optional: pass them only to pin a specific vision model; otherwise pick one after install from the "识图模型" dropdown next to the input box (auto-lists image-capable models across all your providers).
- Only pass `--proxy` if your network needs it to reach GitHub/npm.
- `--main-provider` / `--main-model` describe your text main model and are used to auto-whitelist the image-submission gate; omit them and configure manually instead (see below).
- The scripts only touch: the profile's `package.json` dependency, the `cordis.patch.yml` registration entry, and the `vision-opencode` section in `settings.yaml`. Re-running the installer updates the GitHub dependency while preserving configuration idempotently. Uninstall prefers calling the plugin's own `/vision-opencode/uninstall` endpoint to restore `modelOverrides`; if dsh isn't running it degrades to a warning plus manual instructions.

## Manual Install

### Option A: Install from GitHub

```bash
cd ~/.dsh/profiles/web
pnpm add -w github:poiuyjie/dsh-vision-opencode
# Newer DSH profile dirs are pnpm workspace roots (they contain pnpm-workspace.yaml),
# so -w is required; drop -w on older DSH without that file.
```

### Option B: Install from npm

> ⚠️ Not published to npm yet (the package does not exist on the registry). Once published, the shorter command below will work:

```bash
cd ~/.dsh/profiles/web
pnpm add -w dsh-vision-opencode   # not available yet — use Option A for now; -w as above
```

## Register in cordis

Edit `~/.dsh/profiles/web/cordis.patch.yml` and append:

```yaml
- insert:
    - id: vision-opencode
      name: 'dsh-vision-opencode'
```

> If the file contains an empty-array placeholder line `[]` (left by the one-click uninstall script), delete it before appending — `[]` followed by an entry is parsed as two YAML documents and dsh will fail to boot.

## Configuration

Edit `~/.dsh/settings.yaml`:

```yaml
vision-opencode:
  provider: ''              # provider route for the vision model; empty = not chosen (selector shows 「识图模型」)
  model: ''                 # vision model id; empty = not chosen (written back once you pick from the dropdown)
  autoConvert: true         # auto-convert toggle (stability escape hatch; set false if problems)
  mainProvider: opencode-go # provider route for the main model (under the pi-ai adapter)
  mainModels:               # text-only main model ids (auto-whitelist the image gate)
    - deepseek-v4-pro
    - deepseek-v4-flash
```

Restart `dsh`. A "vision model" dropdown appears next to the input box — it auto-lists every image-capable model across your providers; it shows a 「识图模型」 placeholder until you pick one, and your pick is written back into settings.

Chat attachments and workspace images use complementary paths. Attachments must be converted before a text-only main request is sent, so their progress appears as a visible `vision-opencode` context injection. For a later workspace path, screenshot, chart, or OCR task, the model can load the `vision-image-analysis` skill and call `vision_read_image`. Both paths use any multimodal provider/model selected in the dropdown; OpenCode Go is not required.

`autoConvert` applies only when both `mainProvider` and a `mainModels` entry match. Configuring `opencode-go/deepseek-v4-flash`, for example, does not intercept the same model id under another provider, and switching to a native multimodal main model preserves its native image path.

> `mainProvider`/`mainModels` may be left empty: the plugin then changes no config, but sending images to a text-only main model will be rejected by DSH's built-in submission gate (DSH's default safety behavior). Manually declare `input: [text, image]` for the main model under `llm-pi-ai.providers.<provider>.modelOverrides` instead.

## Uninstall (self-clean first, then remove)

```bash
# 1. With dsh running, self-clean once: clears this plugin's settings, removes its modelOverrides
curl -X POST -H 'x-vision-opencode-action: uninstall' http://127.0.0.1:3080/vision-opencode/uninstall

# 2. Stop dsh (Ctrl+C)

# 3. Remove the dependency and registration entry
cd ~/.dsh/profiles/web
pnpm remove dsh-vision-opencode
#    Edit cordis.patch.yml and remove the vision-opencode insert entry (if only comments remain, replace the file with [])

# 4. Restart dsh
```

> After step 1, `settings.yaml` may keep a single leftover line `vision-opencode: {}` (the placeholder of cleared plugin settings) — harmless; you can delete it in step 3. The one-click uninstall script removes it for you.

**If you skip step 1**: leftover `modelOverrides` can make a text-only main model claim image support and send later images to the real API. Restore the corresponding `input` field manually, or call `/vision-opencode/uninstall` with the header shown above and restart. Legacy entries upgraded from 0.2.x have no ownership record; 0.3.x intentionally will not guess-delete them, so they require one manual cleanup based on their real prior value.

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
| Main model is not listed in `mainModels` | No interception; native image handling remains intact |

## Rollback / Escape Hatch

- To only disable auto-conversion (keep the tool and selector): set `vision-opencode.autoConvert: false` in `settings.yaml` and restart.
- Full rollback: run the uninstall flow above. After rollback, behavior equals the uninstalled state (image messages are normally rejected by DSH's gate and never hit the API).

## Known Limitations

- The frontend selector is a hand-written DSH client bundle (`window.__ModuleLoader__` format); the client interface may change between rc releases. If the selector doesn't appear, open the browser console and file the error as an issue.
- Auto-conversion happens at request time; the analyzed text is not written into the persistent session log (it can still survive session compaction, since compaction requests pass through the same conversion waterfall).
- Auto-whitelisting of the main-model gate is only supported under the pi-ai adapter; configure manually for other adapters.
- Version 0.2.x did not record gate ownership. Existing legacy `modelOverrides` require a one-time manual review; the plugin no longer deletes entries based on guessed model names.

## License

MIT
