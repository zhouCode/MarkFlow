# TODO

## Share Window

- [ ] Better display selection UI (choose target display explicitly)
- [ ] Share-window controls for reopen / focus / quick-close behavior
- [ ] Verify share-window behavior in real conferencing tools on macOS and Windows
- [ ] Verify Windows conferencing capture after disabling background throttling for both windows

## Notes (Private Speaker Notes)

- [ ] Stronger anchoring rules for notes inside complex structures (lists/tables)
- [ ] Optional explicit anchors (e.g. `<!-- note#myAnchor: ... -->`)
- [ ] Search/filter notes, and quick jump to anchor

## Editor

- [x] Visible edit-mode scrollbar for precise dragging
- [x] App-level zoom shortcuts for edit/share windows with hidden menu bars
- [x] Keep editor and notes panes side by side while staying usable in zoomed smaller windows
- [x] Keep the edit-window toolbar fixed while zoom shortcuts scale editor content only
- [x] Keep the share-window toolbar fixed while zoom shortcuts scale shared content only
- [ ] WYSIWYG / seamless editing mode (ProseMirror/TipTap-based)
- [ ] Outline / TOC panel
- [ ] Image paste + asset management
- [ ] Themes (multiple presets) and typography controls
- [ ] Export: PDF/HTML, with optional note inclusion modes

## Packaging / Release

- [x] App icons for macOS and Windows
- [x] Basic `electron-builder` distribution output
- [ ] Windows packaging verification
- [ ] GitHub Release publishing flow (`gh` auth + release update)
- [ ] Auto-update strategy (optional)
