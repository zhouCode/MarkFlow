# MarkFlow

Markdown editor with dual-window presentation:

- Audience window: clean markdown content only
- Presenter window: content + synced speaker notes

## Features (Current)

- Speaker notes extracted from Markdown comments: `<!-- note: ... -->`
- Notes panel follows the primary scroll source (Preview or Editor)
- Presentation opens 2 windows (Presenter + Audience) and can exit with `Esc`
- Light/dark theme toggle

## Status / TODO

See [TODO.md](./TODO.md).

Note: `Slide Talk` and aspect ratio (`4:3` / `16:9`) are not considered complete yet and are tracked as TODO items.

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
