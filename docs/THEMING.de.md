# Design je Installation anpassen

Jede SupportX-Installation kann wie die Website des Kunden aussehen: eigener Name, Logo, Farben, Schriften und Eckenradius. Das Design steht in einer Datei, nicht im Code. Ein Update von SupportX überschreibt es nicht.

## Ohne Server-Zugang: in der Oberfläche (je Arbeitsbereich)

Der Inhaber eines Arbeitsbereichs kann das Design selbst anpassen, unter **Einstellungen → Design**:

1. **Vorlage herunterladen**: eine `DESIGN.md` mit allen Feldern und den aktuellen Werten.
2. Werte ändern (Farben, Schriften, Eckenradius, Name oben links) und **DESIGN.md hochladen**. Auch andere DESIGN.md-Dateien werden gelesen: Fließtext mit Rolle und Farbe, Token-Tabellen (`--brand: #…`) und Dateien mit Kopfbereich (`colors:`, `on-surface`, `fontFamily`, `rounded`).
3. Die ganze Seite zeigt sofort eine **Vorschau**. Gespeichert wird erst mit **Übernehmen**, **Verwerfen** stellt den alten Stand her.
4. **Logo hochladen**: PNG, JPG oder WebP bis 300 KB, steht dann oben links statt des Namens. SVG wird nicht angenommen (kann Skripte enthalten).
5. **Auf Standard zurücksetzen** entfernt Farben, Schriften, Name und Logo des Arbeitsbereichs.

Schlecht lesbare Farbpaare werden nicht übernommen, externe Schriftdateien und Links nicht geladen. Das Design des Arbeitsbereichs liegt über dem Design der Installation (unten).

## Für die ganze Installation (Server)

1. Auf dem Server neben `deploy/` einen Ordner `theme/` anlegen.
2. Darin eine `theme.json` ablegen (Vorlagen: `examples/themes/`), dazu bei Bedarf Logo und Schriftdateien.
3. In `.env` die Zeile `THEME_DIR=/app/theme` ergänzen.
4. Den Server neu starten: `docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d server`.

Ist die Datei fehlerhaft, startet SupportX mit dem Standard-Design und schreibt den Grund ins Log (`docker compose … logs server`).

## Aufbau von `theme.json`

Alle Angaben sind optional. Was fehlt, kommt aus dem Standard-Design.

| Feld | Bedeutung |
| --- | --- |
| `productName` | Name oben links, auf der Anmeldeseite und im Browser-Tab |
| `tagline` | Zeile unter dem Namen auf der Anmeldeseite |
| `logo` | Dateiname im Theme-Ordner (`.svg`, `.png`, `.webp`, `.jpg`). Ersetzt den Namen als Schriftzug |
| `colors.background` | Seitenhintergrund |
| `colors.surface` | Karten, Listen, Eingabefelder |
| `colors.text` / `colors.textSecondary` | Haupt- und Nebentext |
| `colors.muted` / `colors.soft` | Hinweise, Beschriftungen |
| `colors.line` | Trennlinien und Rahmen |
| `colors.primary` / `colors.primaryText` | Hauptknöpfe (Hintergrund und Schrift) |
| `colors.accent` | Markierungen, Fokusrahmen, kleines Quadrat vor dem Namen |
| `fonts.sans` / `fonts.mono` | Schriftfamilien als CSS-Liste |
| `fonts.files` | eigene Schriftdateien im Theme-Ordner: `{ "family": "…", "file": "….woff2", "weight": 400 }` |
| `radius` | Eckenradius in Pixeln (0 bis 24) |

Farben immer als `#rrggbb`. Schriften und Logo müssen im Theme-Ordner liegen. Fremde Server (z. B. Google Fonts) lädt SupportX bewusst nicht, damit keine Kundendaten an Dritte gehen.

Statusfarben (grün für „bereit“, rot für Fehler) bleiben absichtlich gleich, damit Warnungen in jedem Design erkennbar sind.

## Aus einem Screenshot oder einer Design-Beschreibung

Einen Screenshot der Kunden-Website oder eine vorhandene `DESIGN.md` an Claude geben, mit dem Satz „Mach daraus eine theme.json für SupportX nach docs/THEMING.de.md“. Claude liest Hintergrund, Text-, Linien-, Knopf- und Akzentfarbe sowie den Eckenradius ab und schreibt die Datei. Logo und Schriftdateien liefert der Kunde, sie werden einfach in den Theme-Ordner gelegt.

Danach prüfen: Hauptknöpfe gut lesbar (Kontrast `primary` zu `primaryText`) und Text auf `surface` gut lesbar.
