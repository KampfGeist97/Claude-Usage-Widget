# Migration from Tauri branch to Electron v3

Recommended branch name: `electron-v3`.

The Electron source is a replacement implementation, not an in-place Tauri patch.

## Files/directories to remove from the Electron branch

If the branch was created from the previous Tauri code, remove these old Tauri-only paths after copying the Electron v3 source:

- `src-tauri/`
- old Tauri-generated `dist/` / `target/` directories if present

The following project files are replaced by the Electron v3 versions:

- `package.json`
- `.github/workflows/build-windows.yml`
- `ui/`
- `README.md`

## Requirements preserved from v2.2.x

- Tray application
- click tray icon to show/hide
- no ordinary taskbar entry
- frameless and Always-on-top
- draggable header
- bottom-right initial/default position above the Windows taskbar
- optional remembered position
- automatic clamping back into a visible monitor work area
- optional hide-on-focus-loss
- manual refresh
- 1/2/5/10-minute refresh settings
- optional Windows autostart
- X hides; tray Quit exits
- packaged app opens without a CMD/console window

## Replaced subsystem

Removed:

- Tauri/Rust runtime
- Claude Code OAuth client ID
- OAuth token exchange
- Windows Credential Manager OAuth token storage

Added:

- Electron/Chromium persistent partition `persist:claude-usage`
- isolated Claude login window
- hidden authenticated Claude web context
- same-origin usage fetches from the authenticated page

The Electron profile is deliberately separate from Claude Desktop and normal browsers.
