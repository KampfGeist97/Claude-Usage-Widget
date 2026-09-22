# Claude Usage Widget — Tauri 2

Portable Windows-11-Tray-App für die Anzeige der Claude-Nutzungslimits.

## Zielverhalten

- startet standardmäßig unsichtbar im Windows-Infobereich (Tray)
- Linksklick auf das Tray-Icon: Dashboard ein-/ausblenden
- Klick außerhalb des Widgets: wieder ausblenden
- kein Taskleisten-Button (`skipTaskbar`)
- Always-on-top
- `X` blendet nur aus; beendet wird über Tray-Menü oder Einstellungen
- optionaler Autostart mit Windows
- Auto-Refresh: 1 / 2 / 5 / 10 Minuten
- OAuth/PKCE direkt aus der App — Claude Code wird nicht benötigt
- OAuth-Token im Windows Credential Manager, nicht in einer Klartextdatei
- keine Python-/Node-/Rust-Laufzeit beim Endanwender

## Wichtige technische Einschränkung

Die App nutzt für die Nutzungsdaten den internen Anthropic-Endpunkt:

`https://api.anthropic.com/api/oauth/usage`

und den von Claude Code verwendeten OAuth-Client. Diese Schnittstellen sind keine zugesicherte öffentliche Drittanbieter-API. Anthropic kann OAuth-Parameter, Response-Schema oder Endpunkt ändern. Der Parser unterstützt derzeit sowohl das ältere Legacy-Schema als auch `limits[]`.

## Portable Windows-Ausgabe

Die fertige Laufzeit ist genau eine native Tauri-EXE. Eine komplett EXE-freie Tray-Anwendung ist unter Windows nicht möglich. Die App braucht beim Endanwender keine separat installierte Programmiersprache. Windows 11 bringt Microsoft Edge WebView2 bereits mit.

`src-tauri/tauri.conf.json` setzt `webviewInstallMode` bewusst auf `skip`, weil die Zielplattform Windows 11 ist und kein Installer gewünscht ist.

## Lokal bauen

Nur zum **Bauen** werden benötigt:

1. Rust stable
2. Microsoft Visual Studio C++ Build Tools / Desktop development with C++
3. Node.js

Dann im Projektordner:

```powershell
npm install
npm run build -- --no-bundle
```

Die portable EXE liegt anschließend unter:

```text
src-tauri\target\release\ClaudeUsageWidget.exe
```

Der Zielrechner selbst benötigt diese Build-Werkzeuge nicht.

## Ohne lokale Build-Umgebung

Das Repository enthält `.github/workflows/build-windows.yml`. Wenn der Ordner in ein GitHub-Repository geladen wird, kann über **Actions → Build Windows Portable → Run workflow** auf einem Windows-Runner gebaut werden. Das Artefakt enthält anschließend die portable `ClaudeUsageWidget.exe`.

## Sicherheit

- OAuth: Authorization Code + PKCE (S256)
- zufälliger `state` gegen Callback-Verwechslung
- Callback nur auf `127.0.0.1`/`localhost`
- Access- und Refresh-Token werden im Windows Credential Manager gespeichert
- Token werden nicht an das WebView-Frontend übergeben
- Frontend erhält nur Usage-Daten
- keine Telemetrie im Projekt

## Hinweis zu Antivirus / SmartScreen

Eine nicht signierte, unbekannte Windows-EXE kann trotz unauffälligem Quellcode von SmartScreen oder heuristischen AV-Systemen beanstandet werden. Tauri vermeidet zwar typische PyInstaller-Probleme, ersetzt aber keine Code-Signatur. Für private Nutzung kann die portable EXE lokal gebaut werden; für breitere Verteilung ist eine Authenticode-Signatur sinnvoll.
