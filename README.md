# Claude Usage Widget — Tauri 2

Version 2.2.2

Portable Windows-11-Tray-App für die Anzeige der Claude-Nutzungslimits.

## Zielverhalten

- startet standardmäßig unsichtbar im Windows-Infobereich (Tray)
- Linksklick auf das Tray-Icon: Dashboard ein-/ausblenden
- sichere Startposition unten rechts **innerhalb des Windows-Arbeitsbereichs** (oberhalb der Taskleiste)
- Dashboard über den Titelbereich frei verschiebbar
- Einstellung **Widget-Position merken**: zuletzt verschobene Position beibehalten oder beim Wiedereinblenden wieder unten rechts positionieren
- Einstellung **Bei Fokusverlust ausblenden**: wahlweise Tray-Popup-Verhalten oder dauerhaft sichtbares Always-on-top-Mini-Dashboard
- kein Taskleisten-Button (`skipTaskbar`)
- Always-on-top
- `X` blendet nur aus; beendet wird über Tray-Menü oder Einstellungen
- optionaler Autostart mit Windows
- Auto-Refresh: 1 / 2 / 5 / 10 Minuten
- OAuth/PKCE direkt aus der App — Claude Code wird nicht benötigt
- OAuth-Token im Windows Credential Manager, nicht in einer Klartextdatei
- keine Python-/Node-/Rust-Laufzeit beim Endanwender
- Release-Build verwendet das Windows-GUI-Subsystem; dadurch öffnet sich beim Start **kein CMD-/Konsolenfenster**

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

## Änderungen in 2.2.0

- Neue Einstellung `Bei Fokusverlust ausblenden`. Standard ist **Aus**: Das Widget bleibt sichtbar und always-on-top, auch wenn du in andere Programme klickst.
- Bei aktivierter Option verhält es sich wie ein klassisches Tray-Popup und blendet sich beim Fokusverlust automatisch aus.
- Manuelles Ausblenden funktioniert unabhängig davon weiterhin über `×` oder einen erneuten Linksklick auf das Tray-Icon.
- Die Einstellung wird zusammen mit den Widget-Positionseinstellungen persistent gespeichert.

## Änderungen in 2.1.0

- Tray-Positioner entfernt; die Fensterposition wird jetzt gegen den echten Monitor-`work_area` berechnet. Dadurch bleibt das Widget oberhalb der Taskleiste und vollständig im sichtbaren Bereich.
- Position kann über den linken Kopfbereich frei verschoben werden.
- Neue Einstellung `Widget-Position merken`. Sie wird zusammen mit der letzten Fensterposition unter dem App-Konfigurationsverzeichnis gespeichert.
- Gespeicherte Positionen werden beim Wiederherstellen auf einen vorhandenen Monitor-Arbeitsbereich begrenzt. Das hilft nach Monitor-/Docking-Wechseln.
- Release-EXE startet ohne sichtbares Konsolenfenster.


## v2.2.1

- Fix Tauri 2 work-area type handling on Windows (`PhysicalRect` instead of generic `Rect`).
- Fix Rust borrow lifetime when persisting moved window position.


## v2.2.2

- OAuth-Token-Request verwendet jetzt `Accept: application/json, text/plain, */*` und einen kompatibleren HTTP-Client-Header.
- Windows-Build nutzt für HTTPS jetzt `native-tls` statt `rustls`, damit der Windows-Zertifikatsspeicher (inkl. Unternehmens-Root-CAs) berücksichtigt wird.
- Separate Connect- und Gesamt-Timeouts für OAuth/Usage-Requests.
- Detaillierte OAuth-Fehlerdiagnose: Timeout/Connect/TLS-Ursache, HTTP-Status und gekürzter Response-Body werden angezeigt.
- Erfolgreiche, aber unerwartete OAuth-Antworten zeigen jetzt ebenfalls einen gekürzten Response-Body zur Diagnose.
