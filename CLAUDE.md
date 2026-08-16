# CLAUDE.md — deskpet

> Arbeitstitel: `deskpet`. Vor dem ersten Release umbenennen (Name, Bundle-ID, Fenstertitel).

## 1. Projektziel

Eine kostenlose Desktop-App, die aus echten Fotos eines Haustiers einen interaktiven
Begleiter macht, der auf dem Desktop lebt: herumläuft, schläft, auf den Cursor
reagiert, sich anfassen lässt.

**Harte Randbedingung: 0 € laufende Kosten pro Nutzer.** Es gibt kein Backend, keine
API-Calls, keine Cloud-Inferenz. Alles läuft lokal auf dem Rechner des Nutzers. Jede
Architekturentscheidung wird an dieser Bedingung gemessen — wenn ein Feature einen
Server braucht, wird das Feature anders gebaut oder gestrichen.

**Zweite Randbedingung: die Fotos verlassen niemals den Rechner.** Das ist Feature und
Marketing-Argument zugleich, nicht nur Datenschutz-Pflicht.

## 2. Tech-Stack (festgelegt, nicht zur Diskussion)

| Bereich | Technologie |
|---|---|
| App-Shell | Tauri v2 (Rust) |
| Frontend | React 18 + TypeScript + Vite |
| Rendering | PixiJS v8 (WebGL, Canvas für das Pet) |
| Styling | Tailwind CSS (nur im Onboarding/Settings-Fenster) |
| Freistellung | ONNX Runtime via `ort` Crate (Rust-Backend) |
| Persistenz | `tauri-plugin-store` (JSON) für Settings, Dateisystem für Assets |
| Build/Release | GitHub Actions → GitHub Releases, `tauri-plugin-updater` |

Tauri-Plugins: `store`, `fs`, `dialog`, `autostart`, `updater`, `opener`, `os`.

## 3. Nicht-Ziele (bewusst weggelassen)

- Keine generative KI, keine Bild-Generierung, keine Diffusion-Modelle.
- Kein Account-System, kein Login, keine Synchronisation.
- Keine Monetarisierung, kein Paywall, keine Telemetrie.
- Kein mobiler Client.
- Phase 1 ist **Windows-only**. macOS kommt später (siehe §9).

## 4. Architektur

```
deskpet/
├── src/                          # React-Frontend
│   ├── windows/
│   │   ├── overlay/              # Transparentes Pet-Fenster
│   │   │   ├── OverlayApp.tsx
│   │   │   ├── PetStage.ts       # PixiJS-Setup, Render-Loop
│   │   │   ├── PetSprite.ts      # Sprite + Transformationen
│   │   │   └── hitmask.ts        # Alpha-Maske fürs Click-Through
│   │   ├── onboarding/           # Wizard: Name, Alter, Fotos
│   │   └── settings/             # Einstellungsfenster
│   ├── behavior/
│   │   ├── stateMachine.ts       # IDLE | WALK | SLEEP | REACT | DRAGGED
│   │   ├── states/               # Eine Datei pro State
│   │   ├── director.ts           # Entscheidet, welcher State als Nächstes kommt
│   │   └── animations.ts         # Squash/Stretch/Bob/Hop-Kurven
│   ├── pet/
│   │   ├── types.ts              # Pet-Datenmodell
│   │   ├── storage.ts            # Laden/Speichern
│   │   └── poseClassifier.ts     # Ordnet Fotos den States zu
│   └── shared/                   # Hooks, Utils, IPC-Wrapper
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs
│   │   ├── commands/
│   │   │   ├── segmentation.rs   # ONNX-Freistellung
│   │   │   ├── window.rs         # Click-Through, Fenster-Flags
│   │   │   └── pet.rs            # Datei-I/O für Pet-Assets
│   │   ├── platform/
│   │   │   └── windows.rs        # WS_EX_TOOLWINDOW etc.
│   │   └── model/
│   │       └── downloader.rs     # ONNX-Modell beim ersten Start holen
│   └── tauri.conf.json
└── docs/
```

### Fensterkonzept

Drei Fenster, unabhängig voneinander:

1. **overlay** — transparent, rahmenlos, always-on-top, nicht in der Taskleiste, deckt
   den kompletten Bildschirm ab. Enthält nur den PixiJS-Canvas.
2. **onboarding** — normales Fenster, 900×640, wird beim ersten Start gezeigt.
3. **settings** — normales Fenster, 720×560, aus dem Tray-Menü erreichbar.

Bei mehreren Monitoren: **ein overlay-Fenster pro Monitor**, das Pet kann zwischen
ihnen wechseln. Für Phase 1 reicht der Primärmonitor, aber die Fensterverwaltung von
Anfang an so bauen, dass n Fenster möglich sind.

## 5. Datenmodell

```ts
type PetId = string; // uuid

interface Pet {
  id: PetId;
  name: string;
  age: number | null;
  gender: 'male' | 'female' | 'unknown';
  species: 'cat' | 'dog' | 'other';
  createdAt: string;          // ISO
  avatarPhotoId: string;      // welches Foto ist das Profilbild
  photos: PetPhoto[];
}

interface PetPhoto {
  id: string;
  originalPath: string;       // appDataDir/pets/<petId>/originals/<id>.png
  cutoutPath: string;         // appDataDir/pets/<petId>/cutouts/<id>.png (RGBA)
  pose: PoseTag;
  width: number;
  height: number;
  anchorY: number;            // 0..1, wo die "Füße" sind — für Bodenkontakt
}

type PoseTag = 'sit' | 'stand' | 'lie' | 'sleep' | 'portrait' | 'unknown';

interface Settings {
  scale: number;              // 0.5 .. 2.0
  speed: number;              // 0.5 .. 2.0
  activePetId: PetId | null;
  autostart: boolean;
  clickThrough: boolean;      // wenn false: Pet ignoriert Maus komplett
  monitorIds: string[];
}
```

Speicherort: `appDataDir()/deskpet/`. Settings über `tauri-plugin-store` in
`settings.json`, Pets in `pets.json` + Bilddateien daneben.

## 6. Phasen

Arbeite die Phasen der Reihe nach ab. **Jede Phase muss lauffähig und manuell testbar
sein, bevor die nächste beginnt.** Am Ende jeder Phase committen.

---

### Phase 1 — Overlay-Fenster, das funktioniert

Das ist die technisch riskanteste Phase. Wenn das hier nicht sauber läuft, ist der
Rest wertlos.

**Aufgaben**

- Tauri-v2-Projekt aufsetzen, Vite + React + TS.
- `tauri.conf.json`: Overlay-Fenster mit
  `transparent: true`, `decorations: false`, `alwaysOnTop: true`,
  `skipTaskbar: true`, `resizable: false`, `shadow: false`, `focus: false`.
- Für macOS später: `app.macOSPrivateApi: true` (sonst keine echte Transparenz).
- Windows-spezifisch in `src-tauri/src/platform/windows.rs`: über das `windows`-Crate
  `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE` auf das Fenster-Handle setzen, damit es weder
  in Alt-Tab noch in der Taskleiste auftaucht und beim Klick nicht den Fokus klaut.
- PixiJS-Stage mit transparentem Hintergrund, ein Platzhalter-PNG rendern.
- Fenster auf die volle Größe des Primärmonitors setzen (`currentMonitor()`,
  Skalierungsfaktor beachten — auf 150%-DPI-Displays sonst falsche Koordinaten).

**Click-Through-Hit-Testing** (der kritische Teil):

- Das Fenster steht standardmäßig auf `setIgnoreCursorEvents(true)`.
- Ein Rust-seitiger Timer pollt mit ~30 Hz die globale Cursorposition.
- Die Position wird gegen eine Alpha-Maske des aktuell gerenderten Frames geprüft:
  Das Frontend hält eine `Uint8Array`-Bitmaske (1 Bit pro Pixel, downsampled auf 1/4
  Auflösung reicht) der aktuellen Pet-Position und schickt bei jeder Positionsänderung
  nur die Bounding-Box + Maske ans Backend.
- Cursor über einem gesetzten Pixel → `setIgnoreCursorEvents(false)`, sonst `true`.
- **Hysterese einbauen:** nicht bei jedem Frame togglen, sondern mit ~3 Frames Verzögerung
  beim Verlassen. Sonst flackert der Fokus und der Cursor zappelt.

**Akzeptanzkriterien**

- Das Platzhalter-Bild schwebt sichtbar über allen anderen Fenstern.
- Ein Klick neben das Bild landet in der Anwendung darunter.
- Ein Klick auf das Bild wird von der App empfangen.
- Die App taucht nicht in Alt-Tab und nicht in der Taskleiste auf.
- Kein Flackern des Fokus beim Bewegen der Maus über die Kante des Bildes.

---

### Phase 2 — Foto rein, Cutout raus

**Aufgaben**

- ONNX-Modell `isnet-general-use.onnx` (~180 MB): **nicht in den Installer packen.**
  Beim ersten Start aus GitHub Releases in `appDataDir()/models/` laden, mit
  SHA256-Prüfung und Fortschrittsanzeige.
- `segmentation.rs`: `ort`-Crate, Modell einmal laden und im Tauri-State halten
  (nicht pro Aufruf neu initialisieren — das dauert Sekunden).
- Pipeline pro Foto: Resize auf 1024×1024 → Inferenz → Alpha-Maske → auf
  Originalgröße zurück → RGBA-PNG schreiben.
- **Nachbearbeitung ist Pflicht, sonst sehen Fellkanten aus wie ausgeschnitten:**
  Maske um 1–2 px erodieren, dann Gaußscher Weichzeichner (σ ≈ 1.5) auf den
  Alphakanal, dann Farbentsäumung (Alpha-Premultiply gegen die Hintergrundfarbe).
- Autocrop auf die Bounding-Box des nicht-transparenten Bereichs.
- `anchorY` bestimmen: unterste Zeile mit Alpha > 0.5, relativ zur Höhe.
- Inferenz auf einem Rust-Thread laufen lassen, Fortschritt per Event ans Frontend —
  die UI darf nicht einfrieren.

**Manuelles Nachbessern (nicht optional):** Die Segmentierung wird bei ~20 % der Fotos
danebenliegen. Ein Radierer/Wiederherstellen-Werkzeug mit Pinselgröße auf einem
Canvas, direkt im Wizard nach der Vorschau. Ohne das ist die App unbrauchbar.

**Akzeptanzkriterien**

- Ein Foto per Drag & Drop wird in < 5 s freigestellt.
- Ergebnis hat weiche, nicht ausgefranste Fellkanten und keinen farbigen Saum.
- Nachbesserung mit dem Radierer funktioniert und wird gespeichert.

---

### Phase 3 — Verhalten

Der Charme entsteht hier, nicht in der Grafik. Nimm dir Zeit für die Kurven.

**State Machine** — `IDLE`, `WALK`, `SLEEP`, `REACT`, `DRAGGED`, `FALLING`.

- `IDLE` — steht/sitzt, atmet (Sinus-Scale auf Y, Amplitude ~2 %, Periode ~3 s),
  gelegentliches Blinzeln durch kurzes Y-Squash.
- `WALK` — bewegt sich horizontal, leichtes vertikales Bobbing, Squash beim
  "Aufsetzen". Sprite bei Richtungswechsel horizontal spiegeln.
- `SLEEP` — nach ~90 s ohne Nutzerinteraktion, langsameres Atmen, optional Z-Partikel.
- `REACT` — Cursor kommt näher als 150 px: kurz zusammenzucken, dann dem Cursor
  zuwenden. Nach 3 s zurück zu `IDLE`.
- `DRAGGED` — Maus gedrückt: folgt dem Cursor, leichtes Nachziehen (Lerp 0.2),
  Rotation proportional zur Geschwindigkeit.
- `FALLING` — nach dem Loslassen: Schwerkraft bis zur "Bodenlinie", Squash beim
  Aufprall, ein kleiner Bounce.

**Director** — wählt alle 8–20 s (zufällig) einen neuen State, gewichtet nach
Tageszeit und Idle-Dauer. Wichtig: Das Pet darf nie länger als ~30 s exakt dasselbe
tun, sonst wirkt es tot.

**Bodenlinie** — unterer Bildschirmrand minus Taskleistenhöhe. Später: Fensterkanten
als begehbare Flächen (`enumerate windows` unter Windows). Nicht in Phase 3.

**Sprite-Auswahl aus Fotos** — jeder State bevorzugt bestimmte `PoseTag`s
(`SLEEP` → `sleep`/`lie`, `WALK` → `stand`, `IDLE` → `sit`). Fehlt ein Tag, wird das
nächstbeste Foto benutzt. Das ist der Kern des kostenlosen Ansatzes: Die hochgeladenen
Fotos *sind* die Animation-Keyframes.

**Akzeptanzkriterien**

- Das Pet wirkt über 5 Minuten Beobachtung lebendig und wiederholt sich nicht sichtbar.
- Ziehen, Fallenlassen und Aufprall fühlen sich physikalisch plausibel an.
- CPU-Last im Leerlauf unter 3 % auf einem Mittelklasse-Notebook.

---

### Phase 4 — Onboarding, ID-Karte, Settings

**Wizard-Schritte:**

1. Begrüßung + Art wählen (Katze/Hund/Anderes)
2. Name, Alter, Geschlecht
3. Fotos hinzufügen (1–8, Drag & Drop), Avatar markieren
4. Freistellung mit Fortschritt + Vorschau + Radierer
5. Pose-Zuordnung bestätigen (automatischer Vorschlag, manuell änderbar)
6. Fertig-Screen mit generierter "Einzugs-Karte" (Avatar, Name, Alter, Datum, ID)

**Pose-Klassifikation ohne KI-Kosten:** Für Phase 4 reicht eine heuristische
Vorbelegung nach Seitenverhältnis der Bounding-Box (breit & flach → `lie`, hoch &
schmal → `sit`/`stand`, sehr quadratisch und formatfüllend → `portrait`). Der Nutzer
korrigiert in Schritt 5. Ein CLIP-Modell wäre genauer, kostet aber weitere 300 MB
Download — erst wenn die Heuristik nachweislich nervt.

**Settings-Fenster:** Größe, Geschwindigkeit, aktives Pet wechseln, Pet bearbeiten,
Autostart, Click-Through global aus, Pet verstecken, Monitor-Auswahl.

**Tray-Icon:** Pet anzeigen/verstecken, Einstellungen, Beenden.

**Akzeptanzkriterien**

- Kompletter Weg vom Erststart bis zum laufenden Pet ohne Erklärung schaffbar.
- Zweites Pet anlegen und zwischen Pets wechseln funktioniert.
- Nach Neustart des Rechners (mit Autostart) ist das Pet wieder da.

---

### Phase 5 — Release-Pipeline

- GitHub Action: Build auf `windows-latest` bei Tag-Push, Artefakt an GitHub Release.
- `tauri-plugin-updater` gegen ein `latest.json` im Release.
- Landingpage (Next.js auf Vercel): Hero, GIF vom Pet in Aktion, Download-Button,
  "Deine Fotos verlassen nie deinen Rechner", FAQ, Impressum, Datenschutzerklärung.
- **SmartScreen-Hinweis auf der Downloadseite**, solange nicht signiert wird —
  offensiv und ehrlich erklären, sonst brechen die meisten Installationen ab.

## 7. Konventionen

- TypeScript strict. Kein `any`.
- Rust: `thiserror` für Fehlertypen, keine `unwrap()` in Command-Handlern.
- Alle Tauri-Commands geben `Result<T, AppError>` zurück, Frontend behandelt Fehler
  explizit mit sichtbarer Meldung — stilles Scheitern ist verboten.
- Kein State im Render-Loop, der nicht in `PetStage` liegt.
- Die Render-Loop läuft mit `requestAnimationFrame`, aber **gedrosselt auf 30 FPS**
  und pausiert komplett, wenn das Pet schläft und die Maus weit weg ist.
  Akkulaufzeit ist ein Feature.
- Commit-Messages auf Englisch, Konventionalformat (`feat:`, `fix:`, `chore:`).

## 8. Bekannte Fallstricke

| Problem | Gegenmaßnahme |
|---|---|
| DPI-Skalierung ≠ 100 % → Pet an falscher Position | Immer mit `PhysicalPosition`/`PhysicalSize` rechnen, `scaleFactor()` explizit anwenden |
| Fokus-Klau beim Klick auf das Overlay | `WS_EX_NOACTIVATE` + `focus: false` |
| Vollbild-Spiele: Overlay liegt darüber oder verschwindet | Vollbild-Erkennung, Pet automatisch verstecken |
| ONNX-Modell blockiert den Main-Thread | Inferenz auf `tokio::task::spawn_blocking` |
| Monitor wird abgesteckt → Fenster im Nirwana | Auf `WindowEvent::Moved`/Monitor-Änderung horchen und zurückholen |
| Freigestelltes Tier hat weißen Saum | Farbentsäumung, nicht nur Alpha-Blur |

## 9. macOS (später, nicht jetzt)

Erst nach validierter Windows-Version. Zusätzlich nötig: `macOSPrivateApi: true`,
`NSWindow.level` auf `.floating`, `collectionBehavior` für alle Spaces, Universal
Binary, und ein Apple Developer Account (99 $/Jahr) für die Notarisierung — ohne die
meldet macOS die App als beschädigt.

## 10. Rechtliches

Diese App ist eine eigenständige Neuentwicklung. Die Funktionsidee ist frei, aber
Namen, Texte, Icons, Farbwelt und Layout-Details bestehender Produkte werden **nicht**
übernommen. Eigene Wortmarke, eigene Bildsprache, eigene Texte.
