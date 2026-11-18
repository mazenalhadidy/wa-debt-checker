# CLAUDE.md — read this first (owner's rules and the project's decisions)

The WhatsApp debt checker of «محل الباشمهندس»: reads WhatsApp chats / pictures and writes the final calculation.
Netlify (edge function + blobs) or local (`local/server.mjs`, Claude or Ollama). The shop app is a separate
repository: `mazenalhadidy/elbshmds`. Details: `README.md`. Every change is small and in the existing style.

## How to work with the owner
- **Never push to GitHub** unless he asks in that message. Commit, then give him the ready zip:
  `npm run package` → `release/wa-debt-checker.zip` (copy to `<scratchpad>/wa-debt-checker-READY.zip`),
  and the shop zip too — **both zips are ALWAYS the last thing of every final reply**.
- **Screenshots**: none while working; at the END send the ones taken while testing (phone 390 px first).
- Reply in English, short and plain; Arabic only for the exact UI words. Ask only when a choice really changes the result.
- Before finishing: `npm test`; check the page in the browser (Playwright, 390 px and 1280 px). Say plainly when the
  AI answers were mocked (no API key here).
- UI: Modern Standard Arabic, no obvious instructions, calculations left-to-right like a calculator (a line breaks
  only between numbers, a new line starts with its sign).

## Decisions
- Prompts, rules and JSON schemas live on the server (`lib/ai.js`); the page sends a task name. Prompt caching on.
- Input: WhatsApp export (.zip/.txt) OR pictures + pasted messages.
- Ready-to-use Windows package: `npm --prefix ai-tool run package` → `ai-tool/release/wa-debt-checker.zip`
  (START.cmd, one bundled server file, only Node.js needed). Give him that zip when the AI tool changes.
- **Everything by itself**: choosing the chat runs it all — who is the shop (AI, every chat), the start (the last
  account closing, found by meaning), every message, the final calculation. No questions, no options, little text.
  Then the owner TALKS to it («صحّح أو اسأل», task `chat`, strong model): it answers and applies actions
  (fix a message, start from a message, opening balance, who is the shop, remember a rule). The messages list below
  is for fixing by hand; every fix (talk or hand) is kept for this chat and taught for the next ones.
- Who is the shop: past answers are evidence, not rules; a known name that seems to switch side is said in the talk,
  never changed silently.
- Split transfers («تم ٥٠٠٠٠» after receipts) count once; a calculator statement is the start and is checked against
  the chat; terms older than the chat are "before the chat", not errors.

- The messages list is for checking only: one line per message says what the AI understood; tap a message to fix it.
  Unsure messages are read again by the strong model automatically — the owner is never asked per message.
- The start is understood from Egyptian Arabic by meaning («بدايتنا ١٢ الف»، «أولنا»، «رصيدك عندنا»…); start words
  with a number are a safety net under the AI.
