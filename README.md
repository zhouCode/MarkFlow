# MarkFlow

Markdown editor with a private workspace plus a separate native share window:

- Main window: document area + private speaker notes
- Share window: clean markdown content only

## Features

- Speaker notes extracted from Markdown comments: `<!-- note: ... -->`
- Notes panel follows the primary scroll source (Preview or Editor)
- Share workflow opens a separate native window that conferencing tools can share directly
- Light/dark theme toggle

## Sharing workflow

1. Keep working in the main window.
2. Click **Open Share Window** or press `F5`.
3. In Zoom / Meet / Teams, choose **MarkFlow Share Window**.
4. Private notes remain visible only in the main window.

## Dev

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run start
```
