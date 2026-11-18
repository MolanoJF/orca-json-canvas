# JSON Canvas for Orca

Open, read and edit Obsidian-compatible `.canvas` boards inside Orca. Cards, notes, images, groups
and connections look, navigate and save like they do in Obsidian, so a board keeps working in
both tools. Requires Orca 1.4.246 or later.

![JSON Canvas showing a demo board with notes, images, groups, a table and connections](images/cover.png)

| | |
| --- | --- |
| ![Editing a card with live Markdown preview and a note suggestion popup](images/editing.png) | ![Dragging a new connection between two cards](images/connecting.png) |
| Live Markdown preview and `[[note]]` suggestions | Drag from an edge dot to connect cards |
| ![Selecting cards and choosing a color, in light mode](images/light-selection.png) | ![Adding a note from the vault with the note picker](images/note-picker.png) |
| Light and dark, matching Orca's theme | Add notes and media from your vault |

## Install

1. In Orca, open **Settings → Plugins** and find **JSON Canvas** by **MolanoJF** in the community
   marketplace.
2. Install it and approve its trusted worker (see *Permissions* below).
3. Open any `.canvas` file and choose the **Canvas** view beside **Source**.

The raw JSON always stays available in the **Source** tab.

## Permissions and privacy

The worker is a small Node process that runs with your user account's access to the machine, which
is why Orca asks you to approve it. It reads workspace information and its own settings, resolves
local images and notes, and writes only the Markdown notes you edit inline and the images you paste (into a `Sources/`
folder beside the canvas, never over an existing file), and only inside a known vault. The editor frame is sandboxed (no file system, no network). There is no telemetry.

This is an independent project, not affiliated with or endorsed by Obsidian.

**Saving:** edits mark the Orca tab as modified; press **Ctrl+S** (Cmd+S on macOS) to write the
file. Orca does not let plugins save on their own. Files are written in Obsidian's own format
(tab-indented, one card per line, same key order) to keep diffs small when moving between editors.

## Editing (as in Obsidian)

| Action | Input |
| --- | --- |
| Add a card | Double-click the canvas, or click/drag a button in the bottom toolbar (card, note, media) |
| Edit a card | Double-click it, Enter, or the pencil in the selection menu |
| Select | Click; Shift+click to add; drag on the canvas for a selection box; Ctrl+A |
| Move | Drag (groups carry the cards inside them); Arrow keys nudge (Shift = 5 steps) |
| Duplicate | Alt+drag, or right-click → Duplicate |
| Resize | Drag any edge or corner (Shift+corner keeps the ratio) |
| Connect | Hover a card's edge, drag from its dot to another card; drop on empty canvas to add a connected card |
| Reconnect an edge | Select it, drag one of its ends |
| Edit a label | Double-click a group label or an edge |
| Color, group, align, line direction, background | Selection menu above the selection |
| Delete | Delete / Backspace |
| Copy, cut, paste | Ctrl+C / Ctrl+X / Ctrl+V (pasted text or URLs become cards; pasted images are saved and become image cards) |
| Undo / redo | Ctrl+Z / Ctrl+Shift+Z, or the buttons on the right |
| Read-only | Gear → Read-only; the lock turns editing back on |
| Snapping | Gear → Snap to grid / Snap to objects (guides show while dragging) |

The card editor is CodeMirror with Obsidian-style live preview: markdown marks hide except on the
line you are on, `[[` suggests notes from the vault, Ctrl+B / Ctrl+I toggle bold and italic, lists
continue on Enter. Double-clicking a note card edits the note itself; that writes the `.md` file
directly, and refuses if the note changed on disk meanwhile.

## Pasting images

Paste an image (a screenshot, or one copied from a browser or another app) and it is saved as a
new file in a `Sources/` folder next to the `.canvas` file, then added as an image card at the
pointer. `Sources/` is created on the first paste. Files are named `Pasted image <timestamp>.png`
(or keep the copied file's name), and an existing file is never overwritten. PNG, JPEG, GIF, WebP,
BMP and AVIF up to 20 MB are accepted.

Orca does not tell the editor where the `.canvas` file is, so the worker finds the board by
matching its card ids against the `.canvas` files in the vault. If the board is new and unsaved,
or two canvases are copies of each other, the paste asks you to press Ctrl+S once and try again.

## Viewing

Text cards render Obsidian-flavoured Markdown (wikilinks, embeds, highlights, tags, callouts, tasks,
tables, comments). File cards show images, video, audio and notes (or one `#heading`/`#^block`);
PDFs and other files are placeholders that open in Orca. Link cards open the URL in the browser,
because Orca frames have no network. The camera, grid, label scaling, edge curves and zoomed-out
placeholders follow Obsidian.

Navigation: scroll pans, Shift+scroll pans sideways, Ctrl+scroll / Space+scroll / pinch zooms,
Space+drag or middle-drag pans, Shift+1 zoom to fit, Shift+2 zoom to selection.

## Differences from Obsidian

- No autosave: press Ctrl+S.
- While editing a card, tables, images and callouts show as Markdown source (inline syntax is
  live-previewed).
- No web page previews in link cards, no PDF rendering, no tag search, no "Convert to file",
  no drag-and-drop of files from outside.

## How it works

The editor frame is sandboxed (no file system, no network) and only receives the canvas text. A
small worker (`worker/main.js`, Node) finds the vault (the Orca workspace holding the canvas, or
the folder above it with `.obsidian`), resolves paths and links the way Obsidian does, streams files
to the frame in chunks, lists vault files for the pickers, and writes notes edited inline. It only
touches files inside a known vault. If a vault is not an Orca workspace, add its folder under
Settings → Plugins → JSON Canvas → *Extra vault folders*.

## Development

Loaded as a development plugin: `orca plugin dev load <this folder>`. Code edits reload on save.
Frame errors appear in `orca plugin logs local.json-canvas`. `marked` and CodeMirror 6 (MIT)
are vendored in `editor/vendor/`. Icon paths come from Lucide (ISC); third-party notices ship
alongside the code.

To preview the included demo without installing the plugin:

```bash
VAULT="$PWD/dev/demo" ORCA_CLI="$(command -v orca)" node dev/harness.mjs dev/demo/demo.canvas 5179
```

```powershell
$env:VAULT = (Resolve-Path dev/demo).Path
$env:ORCA_CLI = (Get-Command orca).Source
node dev/harness.mjs dev/demo/demo.canvas 5179
```

Open `http://127.0.0.1:5179/editor/index.html?theme=dark` (or `theme=light`). The harness
keeps canvas edits in memory, stubs note writes, and does not open real Orca tabs.

To rebuild CodeMirror, run `npm ci` in `build/codemirror`, then:

```text
npx esbuild entry.js --bundle --format=esm --minify --outfile=../../editor/vendor/codemirror.js
```

Validate before releasing with `orca plugin validate . --json`. Releases are version tags
matching `orca-plugin.json`; the `orca-plugin` repository topic enables marketplace discovery.

Run the tests with `npm test`.

## Feedback

Bug reports and feature requests are welcome in
[GitHub issues](https://github.com/MolanoJF/orca-json-canvas/issues). For rendering bugs, attach
the `.canvas` file (or a trimmed copy) and your Orca version.

## License

MIT. See [LICENSE](LICENSE); bundled third-party notices are in `editor/`.
