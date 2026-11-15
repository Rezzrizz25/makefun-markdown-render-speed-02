# makefun-markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Rezzrizz25/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Rezzrizz25/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Marked, tuned: a faster drop-in for marked 18.1.3's `marked.parse` that returns byte-for-byte identical HTML. It forks marked's own tokenizer and renderer, then replaces the hot dispatch: at each block and inline position a first-character check picks the one or two tokenizers that can match, instead of trying all of them; plain text runs are scanned with a single character-class pass instead of the giant backtracking text rule; paragraphs are scanned line by line; lists are split with character checks instead of per-line regexes. Every construct still goes through marked's own tokenizers and renderer, so the output is marked's output — only the dispatch is new. Built for make.fun — enter via https://make.fun/r/v4m1pbv2.

Local grade on the practice set: **720/720 cases identical to marked**. The 40 generated README documents render in ~550 ms vs ~720 ms for marked itself (~1.3× faster); the whole 720-case set in ~620 ms vs ~780 ms. Differential fuzzing against marked on 120,000 random markdown documents found no divergence.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR` (default `/input`) — a `cases.json` array of `{"id", "markdown"}` — renders each with `parse`, and writes the HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`). It needs only Node (22+) and the files in this repository; no install, no network, no dependencies beyond the vendored marked under `vendor/marked/` (MIT, see its `LICENSE` and `NOTICE`).

## Approach

`parse.js` is a dependency-free ES module exporting `parse(markdown)`:

- **Same pipeline, faster dispatch.** A fresh `Lexer` is built per call and its `blockTokens` / `inlineTokens` are overridden as instance properties. The block loop dispatches on the first line's first character (space, code, fences, heading, hr, blockquote, list, html, def, table, setext heading, paragraph — in marked's trial order), and the inline loop dispatches on the current character (escape, tag, link, emphasis, code span, strikethrough, autolink, URL, text). Tokenizers that cannot match a position are never called.
- **Fast text runs.** `scanTextEnd` finds the end of a plain-text run with one native pattern scan (email `@`, scheme `://`, `www.`, `mailto:`/`xmpp:`) plus character-class checks, instead of running marked's text rule, and merges adjacent text tokens exactly as marked does.
- **Cheap emphasis/link gates.** `maskSrc` (the emphasis mask) is skipped when a run holds no maskable construct; emphasis and strikethrough are skipped when a pre-scan finds no possible closer; the link rule is skipped when no `](` lies ahead.
- **Fast paragraphs and lists.** Paragraphs are scanned line by line against the paragraph rule's interrupt set (hr, ATX heading, blockquote, fences, list, HTML block, table, blank line), including its edge cases (a spaces-only final line is paragraph text; `</pre>` does not interrupt; only `1.`/`1)` lists interrupt). Lists are split with character checks that mirror marked's per-line interrupt regexes, including its lazy-continuation quirk where a dedented line starting at column 4 after tab expansion ends the item.
- **Fallback.** If the fast path ever throws, `parse` falls back to `marked.parse(markdown)`, so a bug degrades to marked's speed, never to wrong output.

## Layout

- `main.ts` — the driver: reads `/input/cases.json`, writes `/output/html.json`.
- `parse.js` — the fast parser (ES module, no dependencies, no network, no clock, no environment reads).
- `vendor/marked/` — marked 18.1.3, vendored byte-for-byte (MIT), with its `LICENSE` and `NOTICE`.
- `LICENSE` — MIT (Rezzrizz25).

---

<sub>Entered on [make.fun](https://make.fun/?ref=v4m1pbv2&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
