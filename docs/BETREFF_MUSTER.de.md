# Betreff-Muster als Sortierregel

Automatische Mails (Marktplatz, Warenwirtschaft, Shop) haben immer denselben Betreff-Text
und setzen Beträge, Bestell- oder Antragsnummern ein. Statt nur nach Absender kann man sie
nach diesem Betreff-Muster als „Werbung & Infos“ (oder umgekehrt als Kundenanfrage) einordnen.

## Analyse: Wo wird ein Betreff individuell?

Untersucht an Systemmeldungen eines Marktplatzes (Zahlen hier ersetzt):

| Betreff (Beispiel) | Muster | erstes individuelles Zeichen |
| --- | --- | ---: |
| `26.95 EUR Rückerstattung veranlasst – Bestellung 302-1111111-1111111` | `* EUR Rückerstattung veranlasst - Bestellung *` | 0 |
| `Dein SAFE-T-Antrag 10001-20002-3000003 wurde für die Bestellung 302-4444444-4444444 eingereicht` | `Dein SAFE-T-Antrag * wurde für die Bestellung * eingereicht` | 19 |
| `Ergebnis des Garantieantrags für Bestellung 306-2222222-2222222` | `Ergebnis des Garantieantrags für Bestellung *` | 44 |
| `Benachrichtigung zur Rücksendegenehmigung für die Bestellung 302-6666666-6666666` | `Benachrichtigung zur Rücksendegenehmigung für die Bestellung *` | 61 |
| `Fehler bei Bestand Synchronisation` | (gleich, nichts Individuelles) | – |

Ergebnis: Das Individuelle steht **nicht ab einer festen Zeichenzahl**. Mal steht der Betrag
ganz vorn, mal die Antragsnummer in der Mitte, mal die Bestellnummer am Ende. Ein Schnitt
„die ersten N Zeichen“ würde entweder alle Rückerstattungen verfehlen oder verschiedene
Meldungen zusammenwerfen. Verlässlich ist dagegen: **Jedes Wort mit einer Ziffer ist
individuell** (Betrag, Bestell-, Antrags-, Paketnummer, Datum), alle anderen Wörter sind
die Vorlage. Innerhalb einer Meldungsart unterschieden sich die Betreffs nur in diesen Wörtern.

## Regeln

- `subjectPattern()` (`packages/core/subject-pattern.ts`) ersetzt jedes Wort mit Ziffer durch `*`;
  benachbarte werden ein `*`. Gedankenstriche und Leerzeichen werden vereinheitlicht,
  Groß-/Kleinschreibung zählt nicht.
- Ein `*` steht für eine Folge von Wörtern mit Ziffern oder für genau ein beliebiges Wort
  (z. B. einen Namen, den man von Hand durch `*` ersetzt; zwei Wörter = `* *`).
- Der ganze Betreff muss passen: `AW: …`, `WG: …` oder ein vom Kunden verlängerter Betreff
  fallen nicht unter das Muster der Systemmeldung.
- Ein Muster braucht mindestens 8 feste Buchstaben, sonst passt es auf fast alles.
- Reihenfolge der eigenen Regeln: Absender-Adresse vor Betreff-Muster vor Absender-Domain;
  eigene Regeln vor der automatischen Erkennung.

## Ablauf in der Oberfläche

Im Fall „Keine Kundenanfrage“ → „Alle mit diesem Betreff-Muster …“: SupportX schlägt das
Muster vor, man kann es ändern und sieht sofort, auf wie viele bestehende Fälle es passt,
wie viele davon umsortiert werden, und Beispiele. Beim Speichern werden diese Fälle
umsortiert (nicht die von Hand eingeordneten und nicht die schon beantworteten), und jede
neue Mail mit dem Muster wird beim Eingang so eingeordnet. Unter Einstellungen →
„Werbung erkennen“ stehen alle Regeln mit Trefferzahl und lassen sich entfernen.
