# MarkFlow

MarkFlow is an Electron Markdown editor designed for teaching and live walkthroughs. It combines a Markdown lesson document, private speaker notes, and internal web tabs so one shared window can show both course material and tools such as Remix.

## Highlights

- Markdown editor with classroom-friendly rendered editing
- Internal web tabs for `http/https` pages, including Remix IDE
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
2. Use **New Tab** or `Ctrl/Cmd+Shift+R` to open Remix inside MarkFlow.
3. Switch between the lesson and Remix with `Ctrl/Cmd+1` / `Ctrl/Cmd+2`.
4. Use `Ctrl/Cmd +/-/0` to zoom the active Markdown or web content for screen sharing.
5. Enable **Present** mode when you want read-oriented classroom interaction.
6. Open speaker notes with `F5` when you need private teaching prompts.

## Internal web tabs

- Markdown `http/https` links can be opened in internal tabs with `Ctrl/Cmd + click`.
- The address bar accepts URLs and opens/navigates internal web tabs.
- Web tabs keep their own zoom level.
- Remote web content is isolated from Node integration.

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
