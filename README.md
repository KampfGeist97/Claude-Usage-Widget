# Claude Usage Widget — Electron v3

Windows tray widget for live Claude.ai subscription usage. This branch replaces the previous Tauri/OAuth implementation with an isolated persistent Chromium session.

## Why Electron v3

The widget logs into `claude.ai` in its own sandboxed Electron browser profile. Usage is then fetched **inside that authenticated Claude page** via same-origin `fetch()`. Chromium supplies cookies itself; the widget renderer never receives the Claude `sessionKey`.

The data source is Claude.ai's internal endpoint used by the web app:

`GET /api/organizations/{orgId}/usage`

This endpoint is not a documented public third-party API and can change.

## Preserved requirements

- Windows tray icon; left-click toggles the widget.
- No normal taskbar button while the widget is running.
- Frameless Always-on-top widget.
- Freely draggable by the header.
- Starts at the bottom-right **inside the monitor work area**, above the taskbar.
- Setting: remember last widget position or return to bottom-right when shown.
- Saved position is clamped back onto a visible monitor after display changes.
- Setting: hide on focus loss or remain visible as a mini-dashboard.
- Auto-refresh: 1 / 2 / 5 / 10 minutes.
- Manual refresh.
- Optional Windows autostart.
- Closing the widget hides it; tray → Quit actually exits.
- No console/CMD window in the packaged build.
- No Python, Rust, Claude Code, or separate runtime required on the target PC.

## Claude session architecture

```text
Electron main process
├─ WidgetWindow (local HTML, sandboxed preload bridge)
├─ Hidden ClaudeWindow
│  └─ partition: persist:claude-usage
│     └─ https://claude.ai
└─ LoginWindow (only visible when needed)
   └─ same persistent partition
```

Remote Claude pages use:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`

The hidden Claude page executes:

1. `GET /api/organizations`
2. resolves `lastActiveOrg` if available, otherwise first account organization
3. `GET /api/organizations/{orgId}/usage`
4. returns only the JSON response to the main process

The local widget receives only normalized usage information. It does not receive authentication cookies.

## First start

1. Start the app.
2. Click **Mit Claude anmelden**.
3. Sign in normally in the Claude window.
4. As soon as `/api/organizations` succeeds, the login window hides and the widget fetches live usage.
5. Future starts reuse Electron's persistent Claude browser profile until the Claude session expires.

**Important:** this is a separate Claude session. It does not read Claude Desktop's cookies or your normal browser profile.

## Build on GitHub Actions

Create/use a branch named `electron` or `electron-v3`, copy this project into the branch root and commit it.

Then:

**Actions → Build Electron Windows → Run workflow**

The artifact is:

`ClaudeUsageWidget-electron-v3-windows-x64`

It contains the complete `win-unpacked` directory. Extract it and start:

`Claude Usage Widget.exe`

Electron needs several files next to the EXE, so **do not copy only the EXE out of `win-unpacked`**.

No installer is required.

## Local development (optional)

Requires Node.js 24 only for development:

```powershell
npm ci
npm start
```

Production users do not need Node.js.

## Data locations

Electron stores app settings and its private browser profile below the normal Windows Electron `userData` directory for this app. The Claude session is in Electron's `persist:claude-usage` partition.

Use **Claude-Verbindung trennen** to clear that private session.

Do not commit `node_modules`, `dist`, Electron profile data, cookies, or screenshots containing account information.

## Current limitations

- The Claude.ai Usage endpoint is internal/undocumented.
- Response fields may change; the parser supports the known fixed fields plus a generic `limits[]` shape.
- If Claude/Cloudflare introduces a browser challenge, the widget will show the actual HTTP/browser error instead of treating it as an expired session.
- Multiple organizations: the widget prefers `lastActiveOrg` when visible to page JavaScript; otherwise it uses the first organization returned by Claude.

## Version

3.0.0
