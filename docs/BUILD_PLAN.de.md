# SupportX – Build-Brief

Stand: 21. Oktober 2026. Arbeitstitel, noch kein veröffentlichter Produktname.

## 1. Ziel und Stand dieses Pakets

Ein eigenständiges, selbst betreibbares Projekt bündelt Kundenanfragen von Microsoft-E-Mail, Amazon, eBay, Kaufland, Shop Apotheke, DocMorris und Shopify. Es verknüpft die Anfragen mit passenden Bestellungen und Paketen, bereitet Antworten vor und automatisiert ausdrücklich freigegebene Standardfälle. Die erste KI-Anbindung ist Claude. Andere Anbieter können später denselben Vertrag erfüllen. Ein zusätzlicher MCP-Zugang macht die Funktionen aus kompatiblen KI-Anwendungen nutzbar.

**Festgelegte Datenführung:** Sämtliche Bestellungen liegen bereits in weclapp. Deshalb ist weclapp die einzige Quelle für Bestell- und Versandkontext des ersten Builds. Die Plattformanbindungen liefern Nachrichten und nehmen Antworten entgegen. Ein zusätzlicher Bestellimport aus Shopify, Amazon oder DocMorris gehört nicht zum Startumfang.

**Bestätigter DocMorris-Eingang:** Laut Projektinhaber kommen DocMorris-Anfragen per E-Mail. Sie werden bereits im ersten Microsoft-Meilenstein aufgenommen und mit weclapp abgeglichen. Ein eigener DocMorris-API-Connector ist dafür nicht erforderlich. Vor dem Aktivieren von Antworten ist nur der konkrete E-Mail-Rückweg zum richtigen Vorgang zu prüfen.

Dieses Paket ist ein Architektur-Starter: recherchierter Bauplan, Schnittstellenverträge, kleine lokale Entscheidungslogik, synthetische Beispiele und Tests. Eine Oberfläche, Datenbank, echte Plattformanschlüsse, ein laufender KI-Agent und Nachrichtenversand sind noch nicht implementiert. Es wurde kein Kundenkonto verbunden und kein GitHub-Repository veröffentlicht.

Die Untersuchung unterscheidet drei Zustände: eine Funktion ist offiziell dokumentiert, eine konkrete Installation hat dafür Zugang, und die Funktion wurde mit diesem Konto erfolgreich getestet. Erst der dritte Zustand kann später die automatische Ausführung freischalten.

## 2. Umfang der ersten nutzbaren Version

Die Inbox zeigt je Vorgang den Kanal, das Verkäuferkonto, die Zuordnung, den Gesprächsverlauf, die Antwortfrist, den Bearbeitungsstatus und den zuständigen Mitarbeiter. Daneben stehen Bestellung, Positionen, Teillieferungen und Pakete mit Quellen und Datenstand. Eine Antwortvorschau erklärt, auf welchen Informationen sie beruht und ob etwas fehlt.

Zum Start gehören hinein:

- Klassifikation: Paketstatus, Lieferung fehlt, falscher Artikel, beschädigte Ware, Retoure, Rechnung, Produktfrage und sonstiger Fall.
- Antwortentwürfe, Übersetzung in die Kundensprache und konfigurierbare Tonalität.
- Gemeinsame Regeln je Workspace, Verkäuferkonto und Kanal; keine fest eingebauten firmenbezogenen Kulanzbeträge.
- Freigabe, Bearbeitung, interne Notizen, Zuständigkeit und eine nachvollziehbare Entscheidungshistorie.
- Wiederanlauf nach Fehlern, Übersicht über unterbrochene Verbindungen und eine Pausefunktion je Konto.
- Getrennte Anzeige von Versandauftrag, vom Anbieter angenommener Nachricht und bestätigtem Ergebnis, soweit der Kanal diese Information liefert.

Finanzielle Aktionen und Änderungen am Warenfluss sind eigene Ausbaustufen: Erstattung, Ersatzlieferung, Storno und Retourenerstellung brauchen jeweils einen passenden Adapter und eine eigene Regel. Ein Antwortentwurf darf einen solchen Vorgang vorschlagen, aber nicht als bereits erledigt darstellen.

## 3. Ergebnis der Schnittstellenprüfung

Die vollständige technische Matrix und alle Primärquellen stehen in [CONNECTORS.md](CONNECTORS.md) und [SOURCES.md](SOURCES.md).

| System | Geplanter Weg | Noch konkret zu prüfen |
| --- | --- | --- |
| Microsoft | Graph für Lesen und Antworten; Benachrichtigungen plus Delta-Abgleich | Postfachtyp, erlaubte Postfächer, tatsächliche Absenderidentität, Admin-Einrichtung |
| Amazon | Buyer-Seller-E-Mail-Relay über Microsoft; Bestellkontext ausschließlich aus weclapp | Autorisierte Absenderadresse, Original-Reply-Route, Zuordnung und Sichtbarkeit im Verkäuferkonto |
| eBay | Commerce Message API für Konversationen und Antworten | OAuth-Zugriff, Ereignisabonnement, Bestellzuordnung bei nur vorhandener Listing-Referenz |
| Kaufland | Ticket- und Nachrichten-API | Konto-/Partnerzugang, Abgleichfrequenz, Ticketzuständigkeit |
| Shop Apotheke | Mirakl-Adapter mit Shop-Apotheke-Profil | Nachrichtenrechte, Empfänger und vom Betreiber erlaubte Hintergrundsynchronisation |
| DocMorris | Bestätigter E-Mail-Eingang über Microsoft; Bestellung in weclapp nachschlagen | Reply-To und Zuordnung einer kontrollierten E-Mail-Antwort zum richtigen Vorgang |
| Shopify | Support-E-Mails über Microsoft; kein direkter Shopify-Bestellanschluss | Nur falls verwendet: gesonderter Nachrichtenweg für Shopify Inbox |
| weclapp | Einziger lesender Datenadapter für Aufträge, Lieferungen und Rechnungen im ersten Build | API-Feldmapping, Paketdatenstand und exakte Zuordnung zu Marktplatzkonten |

### Amazon richtig einordnen

Die öffentlich dokumentierte Messaging-API ist kein universeller Nachrichtenposteingang. Sie bietet bestimmte Aktionen je Bestellung, teilweise mit individuell formuliertem Text. Für einen normalen laufenden Käuferdialog planen wir das von Amazon vorgesehene Relay mit einem autorisierten eigenen Absender. Die Nachricht bleibt dadurch Teil der Amazon-Kommunikation. Ein erfolgreicher Microsoft-Aufruf ist noch kein Zustellnachweis. [AMZ-1–AMZ-6 in SOURCES.md]

### DocMorris per E-Mail und Shopify-Support

Der Projektinhaber hat den E-Mail-Eingang für DocMorris bestätigt. Der Build nutzt deshalb denselben Microsoft-Connector wie für andere Support-Mails; ein eigener DocMorris-Nachrichtenconnector ist nicht erforderlich. Der Rückweg wird anhand einer tatsächlichen Nachricht und einer kontrollierten Antwort geprüft. Die öffentlich dokumentierte DocMorris-GraphQL-Schnittstelle ist für diese Integration nicht erforderlich; ihre Bestellfunktionen werden durch weclapp abgedeckt. [DM-1–DM-3]

Bei Shopify genügt der vorhandene Support-E-Mail-Weg; eine direkte Shopify-Anbindung entfällt. Nur falls zusätzlich Shopify-Inbox-Chats verwendet werden, bleibt deren Nachrichtenzugang gesondert zu klären. E-Mail wird dort als Antwortweg aktiviert, wo sie tatsächlich in den richtigen Kundenfall zurückführt. [SHOP-1–SHOP-3]

## 4. Architekturentscheidung

Empfohlen ist ein modularer TypeScript-Monolith mit getrenntem Web- und Worker-Prozess. Das hält Installation und Entwicklung überschaubar und lässt die fachlichen Adapter trotzdem unabhängig erweitern.

| Baustein | Vorschlag | Zweck |
| --- | --- | --- |
| Oberfläche | Next.js / React | Inbox, Fallansicht, Regeln, Kontoeinrichtung und Freigaben |
| API und Fachlogik | Node.js / TypeScript | Authentifizierung, Mandantengrenzen, Fallbearbeitung und gemeinsame Ausführungsregeln |
| Persistenz | Eigene PostgreSQL-Datenbank | Konversationen, Verknüpfungen, Entscheidungen, Synchronisationsstände und Versandaufträge |
| Hintergrundarbeit | Eigener Worker mit datenbankgestützten Jobs und Outbox | Abgleich, Modellaufrufe und kontrollierter Versand |
| Anhänge | Abstraktion für privates lokales Volume oder S3-kompatiblen Speicher | Zugriffskontrolle und Löschung getrennt von Nachrichtenmetadaten |
| KI | Gemeinsamer Provider-Vertrag, Claude zuerst | Modellwechsel ohne Neuaufbau der Kanäle |
| Externe KI-Verbindung | MCP-Server über dieselbe Fachlogik | Kontrollierter Zugriff aus einer kompatiblen Claude- oder anderen KI-Anwendung |
| Betrieb | Docker Compose als erstes Lieferziel | Web, Worker, Datenbank und benötigter Speicher reproduzierbar installieren |

Die Infrastruktur ist ein Vorschlag für den anschließenden Build; im Starter gibt es noch keine Compose-Datei oder laufenden Dienste. Die Datenbank bleibt unabhängig von anderen Produkten. Infrastruktur darf auf demselben Server laufen, Daten und Berechtigungen bleiben getrennt. Zusätzliche Dienste wie Redis oder ein Vektorspeicher werden erst eingeführt, wenn ein konkreter Bedarf besteht.

## 5. Die drei wichtigsten Erweiterungspunkte

**MessageChannel:** Liest Nachrichten und versendet Antworten innerhalb eines bestätigten externen Vorgangs. Der Adapter kennt Thread, Händlerkonto und erlaubte Antwortwege. Er meldet seine Fähigkeiten einzeln: Lesen, Antworten, Anhänge, Hintergrundabgleich und Statusänderungen.

**OrderProvider:** Liefert Aufträge, Bestellpositionen, Lieferungen, Pakete und erforderlichenfalls Rechnungsinformationen. Im ersten Build wird ausschließlich weclapp implementiert. Der Vertrag bleibt erweiterbar, damit andere Betreiber später ihre eigene Warenwirtschaft ergänzen können. Aus dieser Erweiterbarkeit entsteht keine Pflicht, zusätzliche Bestellimporte für die vorhandene Installation zu bauen.

**AiProvider:** Nimmt einen begrenzten Fallkontext an und liefert eine strukturierte Empfehlung: Anliegen, Antwortentwurf, Faktenreferenzen, fehlende Informationen und vorgeschlagene Aktionen. Seine Selbsteinschätzung ist kein Ausführungsrecht. Die Ausführung entscheidet eine gemeinsame serverseitige Regelprüfung.

Ein späterer ActionProvider für Erstattungen oder Ersatzlieferungen erhält eigene Funktionen, Berechtigungen und Wiederholungsschutz. Er wird nicht versteckt in die allgemeine Textantwort eingebaut.

## 6. Ablauf eines Falls

1. Ein Adapter empfängt ein Ereignis oder ruft erlaubte Änderungen ab. Er prüft Herkunft, Konto und externe IDs.
2. Eingang und Folgejob werden gemeinsam gespeichert. Wiederholte Zustellungen erzeugen keinen zweiten Vorgang.
3. Die Nachricht wird einem Gespräch zugeordnet. Eine Benachrichtigungs-E-Mail zu einem bereits nativ importierten Ticket wird nur bei belegter Identität als Kopie verknüpft.
4. Das System sucht die passende Bestellung innerhalb des richtigen Händlerkontos. Bei mehreren Treffern fragt es nach oder legt den Fall zur Prüfung vor.
5. Es lädt benötigte ERP- und Versandinformationen mit Zeitstempel. Widersprüchliche Daten bleiben sichtbar.
6. Die KI klassifiziert und erstellt einen Vorschlag. Unnötige personenbezogene Daten werden dafür nicht mitgegeben.
7. Die Regelprüfung entscheidet zwischen Entwurf, menschlicher Bearbeitung und erlaubter automatischer Antwort.
8. Unmittelbar vor Versand werden Nachrichtenversion, Route, aktuelle Regel und relevante Fakten erneut geprüft. Ein Mitarbeiter oder Kunde kann den Fall inzwischen verändert haben.
9. Ein Versandauftrag wird atomar reserviert und über den ursprünglichen Kanal ausgeführt. Unklare Ergebnisse werden abgeglichen, nicht blind wiederholt.
10. Antworten außerhalb der Anwendung werden eingelesen, soweit der Kanal sie zugänglich macht. So konkurriert die KI nicht mit einem bereits antwortenden Mitarbeiter.

## 7. Wie weit die Automation gehen soll

| Stufe | Verhalten | Einsatz |
| --- | --- | --- |
| Entwürfe | Die KI ordnet zu, recherchiert Daten und formuliert; ein Mensch sendet | Standard beim ersten Anschluss |
| Freigegebene Standardantworten | Eng definierte Vorlagen werden mit geprüften Fakten automatisch befüllt und versendet | Erster Autopilot für eindeutige Paketfragen |
| Regelbasierte Bearbeitung | Nachfragen und weitere definierte Schritte dürfen automatisch laufen | Nach Auswertung echter, überprüfter Fälle |
| Geschäftsaktionen | Erstattung, Retoure oder Ersatz unter eigenen Grenzen und Berechtigungen | Spätere, separat abgenommene Erweiterung |

Der mitgelieferte lokale Kern demonstriert bewusst nur die Prüfung enger Trackingantworten. Freie KI-Texte bleiben dort Entwürfe. Das ist kein grundsätzliches Produktlimit, sondern ein klar prüfbarer Startpunkt.

### Beispiel: „Wo ist mein Paket?“

Das System findet Bestellung und alle betroffenen Pakete in weclapp. Es unterscheidet Labelerstellung, ERP-Versandmeldung und einen tatsächlichen Carrier-Scan, sofern dieser in weclapp vorliegt. Bei ausreichender Datenlage formuliert es eine Statusauskunft. Liegt nur eine verifizierte Trackingreferenz vor, kann eine eigene neutrale Vorlage diese mitteilen, ohne Versand, Zustellung oder ein Lieferdatum zu behaupten. Eine zusätzliche Carrier-API ist keine Voraussetzung des ersten Builds. Bei Teillieferungen benennt die Antwort die einzelnen Pakete. Der mitgelieferte lokale Beispielkern deckt nur den engeren Fall belegter Carrier-Meldungen ab; die neutrale Trackinglink-Vorlage ist Teil der späteren Serviceimplementierung.

### Beispiel: „Falscher Artikel geliefert“

Das System erkennt die Reklamation, verknüpft die betroffene Position und berücksichtigt bereits mitgesendete Informationen oder Fotos. Es kann eine passende Rückfrage vorbereiten. Eine Ersatzlieferung oder Erstattung wird als vorgeschlagene Aktion dargestellt. Später lässt sich die tatsächliche Ausführung über hinterlegte Bedingungen erlauben, etwa nur für bestimmte Fälle und Beträge. Eine erfolgreiche Durchführung muss der zuständige Anbieter bestätigen, bevor die Antwort sie behauptet.

## 8. Claude und austauschbare KI

Es gibt zwei unterschiedliche Zugänge, die sich ergänzen:

**Automatischer Betrieb:** Ein Worker ruft den ausgewählten KI-Provider über dessen API auf. Er läuft unabhängig davon, ob jemand eine Chat-Anwendung geöffnet hat. API-Zugang, Modell, Kostenlimit und erlaubte Daten werden je Installation beziehungsweise Workspace konfiguriert.

**Interaktive Arbeit:** Ein MCP-Server stellt Funktionen wie Fallliste, Falldetails, Bestellkontext, Entwurfserstellung und Freigabeanfrage bereit. Eine kompatible KI-Anwendung kann damit arbeiten. Versand erhält keine Sonderrechte: Die gleiche Prüfung gilt für Worker, Weboberfläche und MCP. MCP ersetzt weder den Worker noch die Plattformautorisierung. [AI-1–AI-2]

Konkrete Modellnamen werden konfiguriert, nicht in die fachlichen Regeln eingebaut. Ein Anbieterwechsel verändert keine Berechtigung. Optional kann eine Installation vollständig mit manueller Bearbeitung und ohne KI laufen.

## 9. weclapp sauber neu anbinden

Die Datenführung ist entschieden: Die relevanten Bestellungen liegen in weclapp. Die technische Einrichtung prüft jetzt die API-Felder, Berechtigungen und Verknüpfungen dieser vorhandenen Daten. Eine bestehende Artikelintegration wird dafür um die benötigten lesenden Auftrags- und Lieferfunktionen ergänzt beziehungsweise als eigenständiger Adapter neu umgesetzt.

Ein kleiner Datencheck nutzt anonymisierte Beispiele je Marktplatz: Plattform-Bestellnummer, Verkäuferkonto, weclapp-Auftrag, Lieferungen und Pakete. Das aktuelle OpenAPI-Schema enthält Paketinformationen unter `parcels[]`; alte einzelne Trackingfelder sind als veraltet markiert. Die Zuordnung darf mehrere Pakete nicht auf ein Feld reduzieren. [WC-1]

URL und Token werden vom Betreiber für seine Verbindung hinterlegt und serverseitig geschützt. Keine fest eingebauten Händlerdaten und keine Tokens im Browser. Vor dem Erzeugen eines neuen Tokens sind bestehende Integrationen zu prüfen: Laut weclapp-Dokumentation kann eine Neugenerierung die vorherigen Tokens dieses Nutzers ungültig machen. Ein dedizierter Integrationsnutzer ist eine zu prüfende Option, keine bereits vorhandene Voraussetzung. [WC-1]

## 10. Baufolge und Abnahme

**Meilenstein 0 – Zugänge und Datenbelege:** Pilotpostfach und Verkäuferkonto festlegen, fünf typische anonymisierte Fälle und die zugehörigen Aufträge prüfen. DocMorris-Rückweg und Mirakl-Synchronisationsrecht früh klären. Damit werden Zugangshürden sichtbar, bevor der Hauptbuild darauf angewiesen ist.

**Meilenstein 1 – Inbox mit Microsoft und weclapp:** Kontoeinrichtung, serverseitige Secrets, Postfachabgleich einschließlich DocMorris-E-Mails, Fallansicht, Auftragszuordnung und interne Notizen. Abnahme: Eine echte Pilotanfrage erscheint einmal und mit der richtigen Bestellung; eine DocMorris-Anfrage wird dem Kanal und dem passenden weclapp-Auftrag zugeordnet. Unklare Zuordnungen bleiben offen.

**Meilenstein 2 – Claude und E-Mail-Antworten:** Strukturierte Entwürfe, Belege, Freigabe, versionierte Outbox, Amazon-Relay und der geprüfte DocMorris-E-Mail-Rückweg. Abnahme: Kontrollierte Antworten landen jeweils im richtigen Amazon- beziehungsweise DocMorris-Vorgang; ein Versandtimeout erzeugt keine blinde Wiederholung. Solange der DocMorris-Rückweg ungeprüft ist, bleiben Empfang, Auftragsabgleich und Entwürfe nutzbar, der Versand bleibt deaktiviert.

**Meilenstein 3 – Kaufland und eBay:** Native Nachrichten lesen und beantworten, Aliase für E-Mail-Kopien, Kontotrennung und manuelle Antworten außerhalb der Anwendung berücksichtigen. Abnahme: gleiche Bestellung oder gleicher Text in verschiedenen Konten bleiben getrennt.

**Meilenstein 4 – Shop Apotheke und verbleibende Nachrichtenwege:** Mirakl nach geklärter Sync-Strategie. DocMorris- und Shopify-Support-E-Mails sind bereits durch Microsoft abgedeckt; es wird kein zusätzlicher Bestellconnector gebaut. Shopify-Inbox-Chats werden nur bei tatsächlicher Nutzung gesondert untersucht. Offene Nachrichtenfähigkeiten werden sichtbar ausgewiesen, nicht als fertige Integration beworben.

**Meilenstein 5 – begrenzter Autopilot und MCP:** Standardfälle mit frischen Belegen automatisch bearbeiten, externen KI-Zugang mit identischen Rechten bereitstellen. Quote manueller Korrekturen, fehlerhafte Zuordnungen, Doppelantworten, Kosten und Wiederöffnungen messen. Keine pauschale Automatisierungsquote ohne tatsächliche Falldaten versprechen.

**Meilenstein 6 – reproduzierbare öffentliche Veröffentlichung:** Installationsweg, Migrationen, Backup/Wiederherstellung, CI, Lizenzhinweise, Beispieldaten und Betriebshinweise. Repositoryname, Eigentümer und Copyright-Angabe vor Veröffentlichung festlegen. Das Detailbacklog steht in [ROADMAP.md](ROADMAP.md).

## 11. Lizenz (AGPL-3.0) und Betrieb durch andere Händler

Seit 04.11.2026 (Lars) steht SupportX unter AGPL-3.0-only, vorher MIT (bis 0.8.0). Andere dürfen das Projekt verwenden, ändern, weitergeben und kommerziell einsetzen. Wer eine geänderte Fassung weitergibt oder anderen über das Netz anbietet, muss ihren vollständigen Quellcode unter derselben Lizenz offenlegen (AGPL § 13). Urheberhinweis, `NOTICE` und die sichtbare Nennung von SupportX, ASEIO, TradeX International AG und Lars Orlamünde in der Oberfläche bleiben Pflicht (AGPL § 7 b). Rückgabe ans Original-Repository ist erwünscht (Pull Request, siehe CONTRIBUTING.md), lässt sich aber nicht erzwingen. [OS-1]

Jede Installation bringt eigene Plattformzugänge und Schlüssel mit. Öffentlich verfügbarer Quellcode ersetzt keine Amazon-App-Registrierung, kein Kaufland-Partnerverfahren und keine Microsoft-Berechtigung. Ein späterer gemeinsamer Hostingdienst für fremde Händler ist ein eigenes Betriebsmodell mit zusätzlichen Anforderungen.

Das öffentliche Repository enthält nur generischen Code, erfundene Testdaten, Beispielkonfiguration und Dokumentation. Bestehender proprietärer Produktcode wird nicht ohne ausdrückliche Lizenzklärung übernommen.

## 12. Offene Produktentscheidungen

1. Welches Microsoft-Postfach und welche Verkäuferkonten bilden den ersten Piloten? Handelt es sich um Microsoft 365 mit Exchange Online und gegebenenfalls freigegebenen Postfächern?
2. Werden Antworten auf die bestätigten DocMorris-E-Mails im richtigen Vorgang angenommen? Dies ist anhand einer tatsächlichen Nachricht und einer kontrollierten Antwort zu prüfen. Shopify Inbox muss nur geklärt werden, falls dort zusätzlich Chats genutzt werden.
3. Unter welchem GitHub-Konto und Namen soll das Projekt veröffentlicht werden, und welcher Copyright-Inhaber soll genannt werden?

Bis diese Antworten vorliegen gelten im Build die hier benannten Arbeitsannahmen: eigenständiges Projekt, weclapp als einzige Bestelldatenquelle, konfigurierbare Konten, eigene Datenbank, Entwurfsmodus und keine freigeschalteten Live-Aktionen.
