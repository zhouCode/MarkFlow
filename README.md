# MarkFlow

MarkFlow is an Electron Markdown editor designed for teaching and live walkthroughs. It combines a Markdown lesson document, private speaker notes, and internal web tabs so one shared window can show both course material and tools such as Remix.

## Highlights

- Markdown editor with classroom-friendly rendered editing
- Internal web tabs for `http/https` pages, including Remix IDE
- Local `.html` / `.htm` files alongside Markdown in the workspace, rendered in the same document area
- One-window screen sharing: switch between Markdown and Remix without changing shared windows
- Address bar for internal web tabs
- Quick-open Remix / configurable quick URL
- Presentation mode to reduce accidental edits during class
- Private dockable **MarkFlow Notes** companion window
- Search first, expandable replace UI
- PDF export with print-oriented image handling
- Light/dark theme toggle
- App icons configured for macOS and Windows builds

## Classroom workflow

1. Open your Markdown lesson document.
2. Use **Function → Open Remix** or `Ctrl/Cmd+Shift+R` to open Remix inside MarkFlow. Set its saved URL under **Function → 默认url设置**; **恢复默认** selects `https://app.remix.live/` (click **保存** to apply). The address bar and **New Tab** open a one-off URL without changing this setting. Existing saved addresses and open tabs are preserved; migrate Remix workspaces separately when changing sites.
3. Switch between the lesson and Remix with `Ctrl/Cmd+1` / `Ctrl/Cmd+2`.
4. Use `Ctrl/Cmd +/-/0` to zoom the active Markdown or web content for screen sharing.
5. Enable **Present** mode when you want read-oriented classroom interaction.
6. Open speaker notes with `F5` when you need private teaching prompts.

## Internal web tabs

- Markdown `http/https` links can be opened in internal tabs with `Ctrl/Cmd + click`.
- The address bar accepts URLs and opens/navigates internal web tabs.
- Web tabs keep their own zoom level.
- Remote web content is isolated from Node integration.

## Local HTML files

- Use **Function → Open File** (or `Ctrl/Cmd+O`) to open a `.html` or `.htm` file, or select one from **Open Folder**'s file list.
- HTML is rendered as a page in the current document area, not edited as Markdown and not opened in an additional top tab. The file sidebar stays visible so HTML and Markdown can be selected at the same level; the existing document tab shows the selected file's name.
- Switching from Markdown to HTML uses the same unsaved-change confirmation as switching Markdown files. Save, discard, or cancel before switching. HTML previews are read-only; Markdown save/formatting/PDF operations do not modify HTML files.
- Relative images, stylesheets and browser scripts can load from the HTML file's directory and its subdirectories. Files outside that directory (including symlinks pointing outside) are blocked; keep page assets alongside the HTML file.
- Local pages run sandboxed, with no Node or MarkFlow API access, in a separate non-persistent session. Local HTML links stay within that directory; `http/https` links open separate web tabs.
- Document zoom shortcuts also work on HTML. Remote web tabs remain separate; `Ctrl/Cmd+1` returns to the current document (HTML or Markdown). HTML files can also be passed as application startup arguments or opened through the OS's existing Open With action.

## Menus and shortcuts

MarkFlow has two compact menus:

- **Function**: files, tabs, Remix, address bar, presentation mode, notes, theme, export, update
- **Edit**: undo/redo and common Markdown formatting

Common shortcuts:

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Switch to Markdown | `⌘1` | `Ctrl+1` |
| Switch to first web tab | `⌘2` | `Ctrl+2` |
| Open/switch to Remix | `⇧⌘R` | `Shift+Ctrl+R` |
| Focus address bar | `⌘L` | `Ctrl+L` |
| Close current web tab | `⌘W` | `Ctrl+W` |
| Toggle Present mode | `⇧⌘P` | `Shift+Ctrl+P` |
| Zoom in/out/reset | `⌘ +/-/0` | `Ctrl +/-/0` |
| Search | `⌘F` | `Ctrl+F` |
| Replace panel | `⌘H` | `Ctrl+H` |
| Open Function menu | `⌘,` or `Alt+M` | `Ctrl+,` or `Alt+M` |
| Open Edit menu | `Alt+E` | `Alt+E` |
| Toggle Notes window | `F5` | `F5` |

Markdown edit shortcuts include undo/redo, bold, italic, strikethrough, inline code, link insertion, code block insertion, headings, bullet/numbered lists, and task lists. Formatting commands are toggle-oriented where appropriate, so applying the same heading/list/text style again removes it.

## Notes workflow

1. Work in the main window.
2. Open notes with **Function → Toggle Notes** or press `F5`.
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

## Regression testing

On Windows, run `npm run test:smoke` to build and test the actual Electron app with Playwright. No separate browser download is needed. Tests use temporary documents and an isolated profile; results and screenshots are written to `output/playwright/`.

See [QA report and release workflow](docs/QA-2026-09-14.md) for findings, remaining work, and the existing GitHub Release process.

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
