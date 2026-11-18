# Changelog

## 1.1.1

- Image paste is more robust: if Orca does not send the frame a paste event for Ctrl/Cmd+V, or the
  event hides the image, the editor reads the clipboard directly.
- A paste that finds nothing usable now says what the clipboard held instead of doing nothing,
  and logs it to `orca plugin logs`.

## 1.1.0

- Paste images onto the canvas (Ctrl+V or right-click → Paste). They are saved to a `Sources/`
  folder beside the `.canvas` file, created on demand, and added as image cards. Files are never
  overwritten; only PNG, JPEG, GIF, WebP, BMP and AVIF up to 20 MB are accepted, checked by content.
- New worker calls `canvas.locateCanvas` (finds the canvas's folder) and `canvas.writeImage`.
- The worker may now write pasted images as well as inline Markdown edits; both stay inside the vault.

## 1.0.1

- Refreshed marketplace listing: new cover and four distinct screenshots (editing, connecting,
  light mode, note picker), clearer captions and alt text.
- Larger demo board (adds a table, a callout and a decision log) used for the screenshots.
- README rewritten for users first; development steps now cover bash as well as PowerShell.
- No code changes to the editor or worker.

## 1.0.0

- First release: view and edit Obsidian-compatible `.canvas` files in Orca.
