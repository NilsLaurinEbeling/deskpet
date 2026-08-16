# Phase 1 — so testest du das Overlay

Phase 1 liefert genau eine Sache: ein transparentes, immer sichtbares Fenster mit
einem Platzhalter-Tier darin, das die Maus nur dort abfängt, wo es tatsächlich
Pixel hat. Kein Verhalten, keine Fotos, keine Einstellungen — das kommt in den
Phasen 2–4.

## Voraussetzungen

- Windows 10/11 (Phase 1 ist Windows-only, siehe CLAUDE.md §3)
- [Rust](https://rustup.rs/) (stable, ≥ 1.77.2) inkl. MSVC-Buildtools
- Node ≥ 20
- WebView2-Runtime (auf aktuellen Windows-Installationen bereits vorhanden)

## Starten

```bash
npm install
npm run tauri dev
```

Beim ersten Start kompiliert Rust einige Minuten. Danach erscheint **kein**
normales Fenster — nur das Tier über allem anderen, unten mittig auf dem
Bildschirm, und links oben ein Debug-Panel (nur im Dev-Modus).

Beenden: `Strg+C` im Terminal. Das Overlay hat bewusst keinen Schließen-Knopf
und taucht in keinem Fensterwechsler auf; das Tray-Menü kommt in Phase 4.

## Das Debug-Panel

Links oben, nur bei `npm run tauri dev`:

| Zeile | Bedeutung |
|---|---|
| `fps` | Render-Rate, sollte bei ~30 liegen (bewusst gedrosselt) |
| `window` | Fenstergröße in logischen Pixeln + DPI-Faktor, z. B. `2560x1440 @1.5x` |
| `ground y` | Bodenlinie = Unterkante des Arbeitsbereichs (Bildschirm minus Taskleiste) |
| `cursor` | Mausposition, **vom Rust-Poller geliefert** — bewegt sie sich, läuft der Poller |
| `over pet` | Cursor steht auf einem undurchsichtigen Pixel des Tieres |
| `interactive` | Fenster nimmt gerade Mausklicks an |
| `mask` | Auflösung der Alpha-Maske und ihre Größe in Bytes |
| `clicks` / `dragging` | zählt empfangene Klicks bzw. zeigt an, ob gerade gezogen wird |

`over pet` ist die interessante Zeile: Sie muss exakt an der Silhouette
umspringen, nicht am Bounding-Rechteck.

## Akzeptanzkriterien durchgehen

### 1. Das Bild schwebt über allen anderen Fenstern

Öffne ein beliebiges Fenster (Explorer, Browser) und maximiere es. Das Tier
bleibt sichtbar, ohne Rahmen, ohne Schatten, ohne weißen Kasten drumherum.

### 2. Ein Klick neben das Bild landet in der Anwendung darunter

Schiebe ein Fenster so unter das Tier, dass Text oder Buttons direkt neben der
Silhouette liegen, und klicke dort. Der Klick muss im Fenster darunter ankommen.

Der spannendere Test sind die **Löcher** in der Silhouette — der Platzhalter hat
sie absichtlich:

- die Lücke **zwischen den beiden Ohren**
- der Zwischenraum **zwischen Schwanz und Körper**
- die Einbuchtungen links und rechts **zwischen Kopf und Rumpf**

Klicks dort müssen durchfallen, obwohl der Cursor innerhalb des umgebenden
Rechtecks steht. Im Debug-Panel bleibt `over pet` dabei auf `false`.

### 3. Ein Klick auf das Bild wird von der App empfangen

Klicke mitten auf das Tier: Es staucht sich kurz, der Zähler `clicks` steigt.
Mit gedrückter Maustaste lässt es sich verschieben (`dragging: true`) — die
Maske folgt dabei, du kannst also nach dem Loslassen direkt wieder zugreifen.

### 4. Die App taucht nicht in Alt-Tab und nicht in der Taskleiste auf

`Alt+Tab` gedrückt halten: kein deskpet-Eintrag. In der Taskleiste ebenfalls
nichts. Und: Klicke ins Tier, während du in einem Editor tippst — der Editor
behält den Fokus, der Textcursor blinkt weiter. Das ist `WS_EX_NOACTIVATE`,
gesetzt in `src-tauri/src/platform/windows.rs`.

### 5. Kein Flackern des Fokus an der Kante

Fahre langsam über den Rand der Silhouette, dann schnell hin und her. `over pet`
und `interactive` dürfen nicht im Wechsel zappeln; der Mauszeiger darf nicht
zwischen Pfeil und Hand springen. Das Fenster wird beim Verlassen erst nach drei
aufeinanderfolgenden Fehlschlägen wieder durchlässig (Hysterese in
`src-tauri/src/hittest.rs`).

### Zusätzlich: DPI

Wenn du einen zweiten Monitor oder eine Skalierung ≠ 100 % hast: Stelle unter
*Einstellungen → System → Anzeige* die Skalierung auf 150 % und melde dich neu
an. Das Tier muss weiterhin auf der Bodenlinie stehen und die Maske muss
weiterhin exakt sitzen — im Debug-Panel steht dann `@1.5x`.

## Wie das Click-Through funktioniert

Windows kennt nur „Fenster schluckt Klicks" oder „nicht". Deshalb:

1. Das Frontend baut aus dem Sprite eine **1-Bit-Alphamaske** in Viertelauflösung
   (`src/windows/overlay/hitmask.ts`) und lädt sie einmal pro Sprite hoch.
   Bewegt sich das Tier nur, wird ausschließlich das Rechteck aktualisiert.
2. Ein Rust-Thread pollt die globale Cursorposition mit 30 Hz
   (`GetCursorPos`, kein Umweg über die Event-Loop) und testet sie gegen die Maske.
3. Treffer → `set_ignore_cursor_events(false)`. Kein Treffer → nach drei Ticks
   zurück auf `true`.
4. Dieselbe Position geht als Event ans Frontend, damit das Tier ab Phase 3 auf
   den Cursor reagieren kann, obwohl das Fenster keine DOM-Events sieht.

## Tests

```bash
npm run typecheck                 # TypeScript, strict
cd src-tauri && cargo test        # Maskenlogik inkl. Vertragstest
```

Der Vertragstest (`agrees_with_the_frontend_mask`) prüft die Rust-Trefferabfrage
gegen eine Maske, die das **echte Frontend** erzeugt hat — Bitreihenfolge,
Zeilenreihenfolge und Koordinatensystem müssen zwischen TypeScript und Rust
zusammenpassen, und genau das ist die fehleranfälligste Stelle der Phase.

Die Vorlage dafür wird so neu erzeugt (nötig, wenn sich der Platzhalter ändert):

```bash
node scripts/gen-assets.mjs          # Platzhalter-Sprite + App-Icons
node scripts/gen-hitmask-fixture.mjs # Maske daraus, via Headless-Chromium
```

`scripts/pet-preview.html` rendert das Sprite ohne Tauri im Browser
(`npx vite`, dann `/scripts/pet-preview.html`) — praktisch, um an Größe und
Anker zu drehen, ohne die App zu starten.

## Was Phase 1 bewusst noch nicht kann

- Nur der **Primärmonitor**. Die Fensterverwaltung ist bereits pro Monitor
  indiziert (`overlay`, `overlay-1`, …), es wird nur noch nicht mehr als einer
  angelegt.
- Kein Verhalten: Das Tier atmet und lässt sich schieben, mehr nicht. Zustände,
  Laufen, Schlafen und Schwerkraft sind Phase 3.
- Keine eigenen Fotos, kein Onboarding, keine Einstellungen, kein Tray-Icon.
- Keine Vollbild-Erkennung — über einem Vollbild-Spiel kann das Overlay noch
  stören.

## Wenn etwas nicht funktioniert

| Symptom | Ursache / Abhilfe |
|---|---|
| Roter Balken oben im Bild | Ein Command ist fehlgeschlagen; der Text nennt den Grund. Fehler bleiben absichtlich sichtbar. |
| Tier sichtbar, aber Klicks gehen ins Leere | `mask` im Debug-Panel ist `—`: Das Frontend hat nie eine Maske hochgeladen. Terminalausgabe auf `[deskpet]`-Zeilen prüfen. |
| Alles schluckt Klicks | Umgekehrter Fall — die Maske wurde hochgeladen, aber die Fenstergeometrie passt nicht. `window` im Panel mit der echten Auflösung vergleichen. |
| Schwarzes Rechteck statt Transparenz | Grafiktreiber/WebView2 zu alt. WebView2-Runtime aktualisieren. |
| Overlay nach Monitorwechsel verschwunden | Sollte sich nach ~1 s selbst zurückholen (`overlay::resync`). Tut es das nicht: Terminalausgabe mitschicken. |

## Entwicklung auf Linux/macOS

Baubar und startbar, aber nur eingeschränkt sinnvoll: Die Windows-spezifischen
Fensterstile fallen weg (`src-tauri/src/platform/fallback.rs`), und echte
Transparenz braucht unter X11 einen laufenden Compositor. Die Maskenlogik und
die Tests laufen überall.
