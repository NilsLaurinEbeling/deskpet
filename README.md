# deskpet

> Arbeitstitel. Vor dem ersten Release umbenennen.

Ein Desktop-Begleiter, der aus echten Fotos deines Haustiers entsteht und auf
dem Bildschirm lebt. Alles läuft lokal: kein Backend, keine API-Calls, keine
laufenden Kosten — und die Fotos verlassen den Rechner nie.

## Stand

**Phase 1 von 5** — das transparente Overlay-Fenster mit alphagenauem
Click-Through. Das Tier ist noch ein generierter Platzhalter.

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Overlay-Fenster, Click-Through-Hit-Testing | ✅ |
| 2 | Fotos freistellen (ONNX, lokal) | offen |
| 3 | Verhalten: laufen, schlafen, reagieren, fallen | offen |
| 4 | Onboarding, ID-Karte, Einstellungen, Tray | offen |
| 5 | Release-Pipeline, Updater, Landingpage | offen |

## Loslegen

```bash
npm install
npm run tauri dev
```

Wie du Phase 1 abnimmst, steht in **[docs/phase-1-testing.md](docs/phase-1-testing.md)**.

## Aufbau

```
src/
  windows/overlay/   Pixi-Stage, Sprite, Alphamaske, Debug-Panel
  shared/            typisierte Wrapper um Commands und Events
src-tauri/src/
  overlay.rs         Fenster pro Monitor anlegen, platzieren, nachführen
  hittest.rs         Alphamaske + 30-Hz-Cursor-Poller mit Hysterese
  commands/window.rs Commands des Overlays
  platform/          Windows-Fensterstile, Fallback für andere Systeme
scripts/             Generatoren für Platzhalter-Assets und Testvorlagen
```

Die Projektvorgaben — Ziele, Stack, Phasen, Konventionen — stehen in
`CLAUDE.md`.

## Skripte

| Befehl | Zweck |
|---|---|
| `npm run tauri dev` | App im Entwicklungsmodus |
| `npm run typecheck` | TypeScript, strict |
| `npm run build` | Frontend bauen |
| `npm run gen:assets` | Platzhalter-Sprite und App-Icons neu erzeugen |
| `cargo test` (in `src-tauri/`) | Maskenlogik inkl. TS↔Rust-Vertragstest |

## Lizenz / Rechtliches

Eigenständige Neuentwicklung. Eigene Wortmarke, eigene Bildsprache, eigene
Texte — siehe `CLAUDE.md` §10.
