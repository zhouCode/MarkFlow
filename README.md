# MarkFlow

A Markdown editor with a main writing window and a separate dockable notes companion window.

- Main window: document editing or preview
- Notes window: private speaker notes that can snap beside the main window

## Current status

MarkFlow now focuses on a simpler workflow:

- write and review Markdown in the main window
- keep speaker notes in a separate native companion window
- dock the notes window beside the main window with snap behavior

## Features

- Speaker notes extracted from Markdown comments: `<!-- note: ... -->`
- Separate native **MarkFlow Notes** window
- Notes aligned to the current document position in preview/edit mode
- Docking and snap behavior between the main window and notes window
- Light/dark theme toggle
- App icons configured for macOS and Windows builds

## Notes workflow

1. Work in the main window.
2. Click **Open Notes Window** or press `F5`.
3. Drag the notes window near the main window to snap it into place.
4. Scroll or jump by note, and the main document follows.

## Notes syntax

Use HTML comments in Markdown:

```md
# Section title

Visible content here.

<!-- note: Talk track for this section. -->
<!-- note: A second private note can be attached nearby as well. -->
```

Notes stay in the private companion window and are not rendered in the main document.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run start
```

## Package

```bash
npm run dist
```

Current packaging setup produces Electron distribution artifacts and includes app icons for macOS and Windows.
