# MarkFlow

A Markdown editor with a private workspace and a separate native share window for screen sharing.

- Main window: document area + private speaker notes
- Share window: clean Markdown content only

## Current status

MarkFlow has moved away from slide/presenter mode and now focuses on a simpler workflow:

- write and review Markdown in the main window
- keep speaker notes private in the right pane
- open a separate native share window for Zoom / Meet / Teams
- share only the rendered document content

## Features

- Speaker notes extracted from Markdown comments: `<!-- note: ... -->`
- Notes panel aligned to the document and kept private in the main window
- Separate native **MarkFlow Share Window** for conferencing tools
- Live content sync between the main window and share window
- Light/dark theme toggle
- App icons configured for macOS and Windows builds

## Sharing workflow

1. Work in the main window.
2. Click **Open Share Window** or press `F5`.
3. In Zoom / Meet / Teams, choose **MarkFlow Share Window**.
4. Keep notes visible only in the main window.

## Notes syntax

Use HTML comments in Markdown:

```md
# Section title

Visible content here.

<!-- note: Talk track for this section. -->
<!-- note: A second private note can be attached nearby as well. -->
```

Notes stay in the private workspace and are not rendered in the share window.

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
