# Fall-Gedächtnis: ähnliche Fälle wiederfinden und schneller antworten

Status: **Konzept, noch nicht gebaut.** Gebaut wird erst nach Freigabe durch den Projektinhaber.
Basis: SupportX 0.9.2.

## 1. Ziel

SupportX soll sich merken, was in einem Fall entschieden und getan wurde, und diese Erfahrung
in ähnlichen neuen Fällen anbieten:

> „In 3 ähnlichen Fällen (gleicher Artikel, Kunde nennt andere Menge als bestellt) wurde 2× ‚Kunde hat recht‘
> entschieden, Teilerstattung 25 %. Ursache 2×: Angebot falsch eingestellt.“

Der Mensch entscheidet weiter immer selbst. Das Gedächtnis schlägt vor, es klickt nichts und
erzeugt keine KI-Antwort ohne Klick (bestehende Regel: keine KI-Kosten vor der Entscheidung).

## 2. Was es schon gibt (und genutzt wird)

| Daten | Wo | Nutzen fürs Gedächtnis |
| --- | --- | --- |
| Anliegen (`topic`, Quelle auto/ai/person) | `conversations.topic` (Migration 016) | Hauptschlüssel der Ähnlichkeit |
| Entscheidung (`customer_right`, `customer_wrong`, `ask_customer`, `custom`) | `drafts.decision` (008/009) | was entschieden wurde |
| Maßnahme danach (`none`, `replacement`, `refund`, `partial_refund`, `return`, `question`, `other`) + Notiz | `conversations.outcome`, `outcome_note` (007) | was getan wurde |
| Gesendete Antwort | `drafts` mit Status `sent` / `outbox` | Vorlage für die nächste Antwort |
| Bestellpositionen mit Artikelnummer | weclapp-Snapshot im Fall (`order_links`), schon in `reports.ts` je Artikel ausgewertet | „gleicher Artikel“ |
| Plausibilitäts-Hinweise (Menge/Größe/Farbe Kunde ≠ Bestellung, Bestelltitel ≠ weclapp-Artikel) | `core/title-check.ts`, `drafts.issues` | Muster wie „falsch eingestelltes Angebot“ |
| Plattform | `conversations.source_platform` | Gewichtung (Amazon-Fälle zuerst Amazon-Vorbilder) |

Es fehlt nur dreierlei: ein **eigener, datensparsamer Eintrag pro abgeschlossenem Fall**, eine
**Ursache** („warum ist das passiert“) und ein **Erstattungsanteil** statt nur „Teilerstattung“.

## 3. Empfehlung in einem Satz

Ein **regelbasiertes Gedächtnis ohne Embeddings und ohne KI-Kosten**: beim Abschluss eines Falls
entsteht ein anonymer Eintrag (Anliegen, Artikelnummern, Hinweis-Muster, Entscheidung, Maßnahme,
Ursache, Antwort als Vorlage mit Platzhaltern). Ein neuer Fall sucht per Schlüssel-Abgleich in
PostgreSQL, zeigt die Treffer als Karte und bietet „Antwort wie damals“ kostenlos als Vorlage an.
Claude bekommt die Vorbilder nur, wenn der Mensch ohnehin auf einen Entscheidungsknopf klickt.

## 4. Datenmodell (eine Tabelle, zwei Spalten mehr)

```sql
-- Ursache und Erstattungsanteil am Fall (vom Team gesetzt, wie outcome).
ALTER TABLE conversations
  ADD COLUMN cause text,             -- Schlüssel aus der Ursachenliste des Workspace oder 'other'
  ADD COLUMN refund_percent smallint CHECK (refund_percent BETWEEN 0 AND 100);

-- Ursachenliste je Workspace (pflegbar wie Textbausteine), Startwerte siehe 7.
ALTER TABLE workspaces ADD COLUMN case_causes jsonb NOT NULL DEFAULT '[...]';

CREATE TABLE case_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  conversation_id uuid,              -- Rückverweis solange der Fall existiert; ON DELETE SET NULL
  source_platform text NOT NULL,
  topic text NOT NULL,
  article_numbers text[] NOT NULL DEFAULT '{}',   -- aus dem weclapp-Snapshot
  hint_kinds text[] NOT NULL DEFAULT '{}',        -- z. B. 'quantity_mismatch', 'size_mismatch', 'order_vs_article'
  decision text,                     -- customer_right | customer_wrong | ask_customer | custom
  outcome text,                      -- wie conversations.outcome
  refund_percent smallint,
  cause text,
  note text,                         -- bereinigte outcome_note (siehe 8)
  reply_template text,               -- gesendete Antwort mit Platzhaltern statt Personendaten
  excluded boolean NOT NULL DEFAULT false,         -- „nicht als Vorbild verwenden“
  closed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX case_memory_lookup ON case_memory (workspace_id, topic, closed_at DESC) WHERE NOT excluded;
CREATE INDEX case_memory_articles ON case_memory USING gin (article_numbers);
```

Bewusst **nicht** im Eintrag: Kundenname, E-Mail-/Relay-Adresse, Anschrift, Bestellnummern,
Sendungsnummern, Rechnungsnummern, Originaltext des Kunden.

`title-check.ts` bekommt dafür feinere, stabile Hinweis-Arten (`quantity_mismatch`, `size_mismatch`,
`colour_mismatch`, `order_vs_article`) statt nur `customer_vs_order`. Das ist eine kleine Änderung an
einer reinen Funktion mit bestehenden Tests.

## 5. Wann ein Eintrag entsteht und sich ändert (Lernen)

- **Anlegen/aktualisieren** im Service `packages/services/case-memory.ts`, aufgerufen aus `setOutcome`
  und beim Statuswechsel auf „Erledigt“: Eintrag entsteht, sobald der Fall erledigt ist **und** eine
  Maßnahme gesetzt ist. Ein Fall hat höchstens einen Eintrag (Schlüssel `conversation_id`); ändert das
  Team Maßnahme, Ursache oder Erstattung später, wird der Eintrag überschrieben. So lernt das
  Gedächtnis aus dem Feld „Was wurde danach gemacht?“.
- **Fall wieder geöffnet** (neue Kundennachricht): Eintrag bleibt, wird beim nächsten Abschluss
  aktualisiert.
- **Antwortvorlage** nur aus einer tatsächlich gesendeten bzw. als gesendet markierten Antwort; ohne
  gesendete Antwort bleibt `reply_template` leer.
- **Rückmeldung zum Vorschlag:** übernimmt das Team einen Vorschlag, wird das im Audit-Log vermerkt
  (`memory.suggestion_used`). Daraus lässt sich später messen, ob die Vorschläge taugen; in die
  Bewertung fließt es im MVP nicht ein.
- **Altbestand:** ein einmaliger Job legt Einträge für alle schon erledigten Fälle mit Maßnahme an.

## 6. Ähnlichkeit (ohne Embeddings)

Kandidaten: gleicher Workspace, `excluded = false`, gleiches Anliegen **oder** gemeinsame
Artikelnummer, höchstens 24 Monate alt. Punkte je Kandidat:

| Merkmal | Punkte |
| --- | ---: |
| gemeinsame Artikelnummer | 4 |
| gleiche Hinweis-Art (z. B. Menge genannt ≠ bestellt) | 3 |
| gleiches Anliegen | 2 |
| gleiche Plattform | 1 |
| jünger als 90 Tage | 1 |

Angezeigt werden Treffer ab 4 Punkten, höchstens 5, plus eine Zusammenfassung über alle Treffer.
Die Gewichte stehen als Konstanten in einer reinen Funktion in `packages/core/similar-cases.ts`
und werden mit synthetischen Fällen getestet.

**Warum keine Embeddings im MVP:** Anthropic bietet keine eigene Embedding-API; ein zweiter Anbieter
(z. B. Voyage oder OpenAI) hieße zweiter Schlüssel, zweite Kostenstelle und Kundentext an einen weiteren
Dienst. Die stärksten Signale (Artikel, Anliegen, Plausibilitäts-Hinweis) sind ohnehin strukturiert.
Ausbaustufe 2 wäre PostgreSQL-Volltext (`tsvector`, deutsch) auf einer kurzen, anonymen
Anliegen-Zusammenfassung, ebenfalls ohne Fremddienst. Embeddings erst, wenn die Trefferqualität
nachweislich nicht reicht.

## 7. Anzeige im Fall und Vorbefüllung

**Karte „Ähnliche Fälle“** direkt über dem Block „Antwort“ (nur wenn es Treffer gibt):

```
ÄHNLICHE FÄLLE (3)                        gleicher Artikel · Menge genannt ≠ bestellt
2× Kunde hat recht → Teilerstattung 25 %  ·  1× Erst nachgefragt
Ursache: 2× Angebot falsch eingestellt
  05.11.26  Amazon  Kunde hat recht · Teilerstattung 25 % · Angebot falsch eingestellt  [Fall] [Antwort wie damals]
  …
```

- Der Entscheidungsknopf, den die Mehrheit der Treffer genommen hat, bekommt den Zusatz
  „wie in 2 von 3 ähnlichen Fällen“. Er wird **nicht** vorgewählt oder automatisch geklickt.
- **„Antwort wie damals“** übernimmt die Vorlage des Treffers als Entwurf, füllt die Platzhalter aus
  dem aktuellen Fall und weclapp (gleicher Mechanismus wie die Textbausteine,
  `core/snippet-placeholders.ts`). **0 Tokens.** Danach normal prüfen, ändern, freigeben.
- **Klick auf „Kunde hat recht“ usw.:** Claude bekommt zusätzlich einen Block `<precedents>` mit bis zu
  zwei anonymen Vorbildern (Entscheidung, Maßnahme, Ursache, Antwortvorlage). Im Prompt steht: Vorbilder
  zeigen Ton und Vorgehen, sind aber keine Fakten und kein Versprechen; Erstattungen nennt die Antwort
  weiter nur, wenn sie freigegeben sind (Regel 4 bleibt).
- **Artikel-Warnung:** wurde für einen Artikel mindestens 2× „Angebot falsch eingestellt“ notiert,
  zeigt die Karte „Angebot für Artikel X prüfen“. Die Auswertung bekommt dieselbe Spalte je Artikel.
- **Ergebnis-Block:** neben „Was wurde danach gemacht?“ zwei neue Felder: **Ursache** (Liste) und
  **Erstattung in %** (nur bei Teilerstattung). Ursachen-Startliste je Workspace, in den Einstellungen
  änderbar: Angebot/Listing falsch eingestellt · Falsch kommissioniert · Transportschaden ·
  Produktmangel · Kunde hat sich geirrt · Lieferung verspätet · Sonstiges.

## 8. Datenschutz und Mandantentrennung

- Jede Abfrage bindet `workspace_id`; Fremd-Workspace-Einträge sind nie Kandidaten. Kein Austausch
  zwischen Kunden-Installationen oder Workspaces.
- **Antwortvorlage anonymisieren** vor dem Speichern: bekannte Werte des Falls (Kundenname,
  Anrede-Zeile, Bestell-, Sendungs-, Rechnungsnummer, Beträge, Daten, Tracking-Links) werden durch
  Platzhalter ersetzt; danach ein Muster-Filter für E-Mail-Adressen, Telefonnummern, IBAN und
  Postanschriften. Bleibt etwas Verdächtiges übrig, wird keine Vorlage gespeichert (Eintrag ohne Text).
- `note` läuft durch denselben Filter; das Eingabefeld sagt „ohne Namen und Adressen“.
- **Gesundheitsfälle** (Risiko `health`) bekommen keinen Vorlagentext, nur die strukturierten Felder.
- **Löschen:** je Eintrag „aus dem Gedächtnis entfernen“, „Gedächtnis leeren“ je Workspace
  (Owner/Admin, Audit-Log), automatische Löschung nach 24 Monaten durch den Worker,
  `purgeWorkspace` und die eBay-Kontolöschung entfernen die zugehörigen Einträge mit.
- Rechte wie beim Fall: lesen darf, wer den Fall sehen darf; Ursache/Erstattung setzen, wer die
  Maßnahme setzen darf.

## 9. Kosten

| Schritt | Tokens |
| --- | --- |
| Eintrag anlegen, anonymisieren, suchen, Karte anzeigen | 0 (nur PostgreSQL und Regeln) |
| „Antwort wie damals“ | 0 |
| Entwurf per Entscheidungsknopf mit Vorbildern | nur bei Treffern, zusätzlich wenige hundert Eingabe-Tokens (zwei kurze Vorlagen), kein zusätzlicher Aufruf |

Das läuft wie bisher über den Claude-Schlüssel des Workspace. Es gibt keinen neuen Fremddienst.

## 10. MVP-Umfang (ein Release, Vorschlag 0.10.0)

1. Migration 018: `case_memory`, `conversations.cause`, `conversations.refund_percent`, `workspaces.case_causes`.
2. `core/similar-cases.ts` (Punkte, Zusammenfassung) und `core/memory-anonymize.ts` (Platzhalter + Filter), beide als reine Funktionen mit Unit-Tests.
3. Feinere Hinweis-Arten in `core/title-check.ts`.
4. `services/case-memory.ts`: Eintrag schreiben/aktualisieren, suchen, ausschließen, löschen, Altbestand-Job, 24-Monats-Löschung im Worker.
5. API-Routen und UI: Karte „Ähnliche Fälle“, „Antwort wie damals“, Ursache + Erstattung % im Ergebnis-Block, Ursachenliste in den Einstellungen, „Gedächtnis leeren“.
6. `<precedents>` im Prompt (`PROMPT_VERSION` → `reply-draft.v3`) mit Regel „Vorbilder sind keine Fakten“.
7. Integrationstests: fremder Workspace sieht nichts, gleicher Artikel in zwei Workspaces, Anonymisierung (Name, Bestellnummer, Tracking, E-Mail landen nicht im Eintrag), Gesundheitsfall ohne Text, Löschen per Eintrag/Workspace/eBay-Kontolöschung, Maßnahme nachträglich geändert aktualisiert den Eintrag, Fall gelöscht → Eintrag bleibt ohne Rückverweis.

**Nicht im MVP:** Embeddings, Volltextsuche, automatisches Senden auf Basis von Vorbildern,
Bewertung der Vorschläge, Übertragung zwischen Workspaces.

## 11. Offene Fragen an den Projektinhaber

1. **Ursache als Liste:** passt die Startliste aus Abschnitt 7, oder fehlen Gründe?
2. **Erstattung in Prozent** (wie im Beispiel 25 %) oder in Euro, oder beides?
3. **Vorbilder automatisch in Claude:** beim Klick auf einen Entscheidungsknopf immer mitgeben, oder nur über einen eigenen Knopf „mit ähnlichen Fällen schreiben“?
4. **Aufbewahrung:** 24 Monate und danach automatisch löschen, einverstanden?
5. **Altbestand:** schon erledigte Fälle mit Maßnahme sofort ins Gedächtnis übernehmen?
