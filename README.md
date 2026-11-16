<p align="center">
  <img src="public/conceit-icon.png" alt="Conceit" width="128" height="128">
</p>

<h1 align="center">Conceit</h1>

<p align="center">A local-first desktop canvas for mood boards, with an AI partner that can read the board.</p>

---

Conceit is a lightweight desktop app (Tauri 2) for collecting and arranging visual references. Drop in images, videos, notes, colors and drawings, connect them with lines, arrange them in a click, and ask an AI to help build the board.

## Features

- **Boards are files you own.** Each board is a single `.conceit` file (SQLite), autosaved, with media stored inside so it opens complete on any Mac.
- **Infinite canvas.** Pan, zoom, multi-select, snap to grid, undo/redo, mini map.
- **Cards.** Notes, images (paste, URL or drag from Finder), videos (YouTube, Vimeo, local files), color swatches (HEX / RGB / HSL), freehand drawings.
- **Lines.** Connect cards with styled lines: curved, elbow or straight, dashes, arrowheads, labels.
- **Arrange.** Grid, Masonry, Bento, Flow and Scatter layouts, animated, one undo step.
- **Export.** PNG or PDF of the whole board or a selection.
- **AI board partner (⌘J).** Chat about the board or a selection. It suggests notes, palettes, reference slots and reorganizations as ghost cards you keep or dismiss. Works with the Claude Code CLI, the Codex CLI, or your own Anthropic API key (stored in the macOS keychain). There is no hosted service.

## Development

Requires [pnpm](https://pnpm.io), [Rust](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev        # run the desktop app
pnpm build            # type-check and build the frontend
cd src-tauri && cargo test
```

Built with Tauri 2, React 19, React Flow, Yjs and TypeScript.
