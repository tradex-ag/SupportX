# Einrichtung (Selbstbetrieb)

Diese Anleitung führt von der lokalen Demo zur ersten echten Verbindung: Microsoft-Postfach → zentraler Posteingang → weclapp-Abgleich → Entwurf → Prüfung durch Mitarbeitende. Versand bleibt aus, bis er je Verbindung und Plattform ausdrücklich freigeschaltet ist.

## 1. Demo ohne Zugangsdaten

Voraussetzungen: Node.js 22.12 oder neuer, PostgreSQL 16 (lokal oder `docker compose up db`).

```bash
npm ci
createdb supportx            # bzw. Datenbank mit Benutzer supportx/supportx anlegen
npm run demo            # startet Testdoubles, Demo-Arbeitsbereich, Server und Worker
```

Öffnen: http://localhost:3000. Anmeldung mit `inhaber@demo-haendler.example.invalid` oder `service@demo-haendler.example.invalid`, Passwort `demo-passwort-nur-lokal`. Alles in der Demo ist synthetisch; weclapp und Microsoft werden durch lokale Testdoubles ersetzt (`packages/testing`). `npm run demo -- --reset` legt den Demo-Arbeitsbereich neu an.

## 2. Echte Installation

```bash
cp .env.example .env
# DATABASE_URL, APP_ENCRYPTION_KEY (32 Byte base64) setzen; DEMO_MODE und ALLOW_TEST_ENDPOINTS bleiben false
npm run db:migrate
SUPPORTX_ADMIN_PASSWORD='mindestens-10-Zeichen' npm run admin:create -- --email sie@firma.de --name "Ihr Name" --workspace "Firma GmbH"
npm run build:web
npm run start:server     # Web/API
npm run start:worker     # separater Prozess: Abgleich, Zuordnung, Entwürfe, Postausgang
```

Mit Docker: `.env` anlegen (inkl. `POSTGRES_PASSWORD`), dann `docker compose up -d --build`. Die Compose-Datei ist vorbereitet, aber in dieser Version noch nicht in einer Docker-Umgebung getestet.

Produktiv: hinter HTTPS betreiben, `SECURE_COOKIES=true`, `PUBLIC_BASE_URL` auf die öffentliche Adresse. `APP_ENCRYPTION_KEY` sicher aufbewahren: ohne ihn sind gespeicherte Zugangsdaten unlesbar.

### Betrieb auf einem eigenen Linux-Server

Für einen einzelnen Server (z. B. 2 vCPU, 4 GB RAM) mit Docker und einer (Sub-)Domain, deren DNS-Eintrag auf den Server zeigt:

```bash
git clone <Repository-URL> /opt/supportx && cd /opt/supportx
cp .env.example .env
# setzen: DOMAIN=inbox.ihre-firma.de, PUBLIC_BASE_URL=https://inbox.ihre-firma.de, SECURE_COOKIES=true,
#         POSTGRES_PASSWORD, APP_ENCRYPTION_KEY
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build
docker compose -f deploy/docker-compose.prod.yml --env-file .env exec -e SUPPORTX_ADMIN_PASSWORD='…' server \
  node --import tsx scripts/create-admin.ts --email sie@firma.de --name "Ihr Name" --workspace "Firma GmbH"
```

Caddy holt das HTTPS-Zertifikat automatisch (Ports 80 und 443 müssen frei und in der Firewall offen sein). Läuft auf dem Server schon ein anderer Webserver auf 80/443, den Caddy-Dienst weglassen und dort einen Proxy auf Port 3000 des `server`-Containers einrichten. Sicherung: `deploy/backup.sh` täglich per cron; Update: `git pull` und derselbe `up -d --build`-Befehl (Migrationen laufen beim Start).

**Automatische Updates (optional):** Der Server holt sich neue Stände selbst von einem Zweig (Standard `live`) und startet neu. So lässt sich bestimmen, wann ein Stand live geht: Wer den Zweig `live` nachzieht, spielt ein. Ändert man auf dem Server von Hand versionierte Dateien, gehen diese Änderungen beim nächsten Update verloren; `.env`, Theme und Sicherungen bleiben.

```bash
cp deploy/supportx-update.service deploy/supportx-update.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now supportx-update.timer
journalctl -u supportx-update.service -n 50   # Protokoll der Updates
```

Liegt die Installation nicht unter `/opt/supportx`, die Pfade in `supportx-update.service` anpassen.

## 3. Verkäuferkonten

*Einstellungen → Verkäuferkonten.* Je Marktplatz-/Shop-Konto ein Eintrag mit dem Merkmal, an dem seine Aufträge in weclapp erkennbar sind (z. B. `salesChannel = GROSS2` oder `ecommerceOrder.externalConnectionId`). Das Merkmal bitte an echten Aufträgen in weclapp prüfen. Ein Fall mit Konto sucht zuerst in seinem Konto, dann in ganz weclapp. Ein Fall ohne Konto sucht direkt in ganz weclapp, und ein eindeutiger Treffer setzt das Konto, dessen Merkmal zum Auftrag passt.

## 4. weclapp (nur lesend)

1. In weclapp einen **eigenen Benutzer nur für diese Anwendung** anlegen, mit Leserechten auf Aufträge, Lieferungen und Ausgangsrechnungen.
2. Für diesen Benutzer einen API-Token erzeugen.
3. *Einstellungen → weclapp*: `https://<mandant>.weclapp.com/webapp/api/v2` und Token eintragen, dann **Verbindung prüfen**.

Bestehende Tokens anderer Integrationen **nicht wiederverwenden und nicht erneuern**: Ein Token gehört zu einem weclapp-Benutzer, und eine Erneuerung kann laufende Integrationen (z. B. Artikel- oder Preisabgleich mit Schreibzugriff) unterbrechen. Die Anwendung ruft weclapp nur mit GET auf und erzeugt oder ändert nie Tokens.

Suchfelder sind standardmäßig `orderNumberAtCustomer` und `orderNumber`. Bitte an einem echten Auftrag prüfen, in welchem Feld die Marktplatz-Bestellnummer steht.

## 5. Microsoft-Postfach (Graph)

Unterstützt werden Exchange-Online-Postfächer, auch freigegebene Postfächer. Der Zugriff erfolgt app-basiert (Client Credentials), damit der Worker ohne angemeldete Person arbeiten kann.

1. **App-Registrierung** in Microsoft Entra ID anlegen (Einzelmandant). Geheimen Clientschlüssel erzeugen. Notieren: Verzeichnis-ID (Tenant), Anwendungs-ID (Client), Schlüssel.
2. **Zugriff auf genau das Servicepostfach beschränken** mit Exchange *RBAC for Applications*. Wichtig: in Entra **keine** mandantenweite Admin-Zustimmung für `Mail.Read`/`Mail.Send` erteilen. Entra-Berechtigungen gelten zusätzlich zu den RBAC-Rollen und würden die Beschränkung aufheben.

   ```powershell
   Connect-ExchangeOnline
   New-ServicePrincipal -AppId <Client-ID> -ObjectId <Objekt-ID der Unternehmensanwendung> -DisplayName "SupportX"
   New-ManagementScope -Name "SupportX Servicepostfach" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'service@firma.de'"
   New-ManagementRoleAssignment -App <Client-ID> -Role "Application Mail.Read" -CustomResourceScope "SupportX Servicepostfach"
   # erst wenn Versand geplant ist:
   New-ManagementRoleAssignment -App <Client-ID> -Role "Application Mail.Send" -CustomResourceScope "SupportX Servicepostfach"
   Test-ServicePrincipalAuthorization -Identity <Client-ID> -Resource service@firma.de      # erwartet: InScope = True
   Test-ServicePrincipalAuthorization -Identity <Client-ID> -Resource anderes@firma.de      # erwartet: InScope = False
   ```

3. *Einstellungen → Microsoft-Postfach verbinden*: Tenant, Client, Schlüssel, Postfachadresse, weitere eigene Absenderadressen (Aliase), Standard-Plattform und Standard-Konto. Dann **Zugriff prüfen** und **Jetzt abgleichen**.

Abgleich: Der Worker liest Posteingang und Gesendete Elemente per Delta-Abfrage (Standard alle 60 s). Push-Benachrichtigungen sind optional und brauchen eine öffentlich per HTTPS erreichbare `PUBLIC_BASE_URL`. Delegierte Berechtigungen (`Mail.Read.Shared`) werden nicht verwendet, da sie für app-basierte Benachrichtigungen freigegebener Postfächer nicht unterstützt sind.

## 6. Zuordnungsregeln (DocMorris, Amazon, Shop-Mails)

Regeln werten nur Metadaten aus (Absender-Domain/-Adresse, Empfänger, Betreff), nie den Nachrichtentext. Vorgehen je Plattform:

1. Eine **echte** Kundenanfrage der Plattform im Postfach öffnen und Absender, Reply-To und die Form der Bestellnummer notieren.
2. Regel anlegen, z. B. „Absender-Domain = <Domain aus der echten DocMorris-Mail> → DocMorris, Konto DocMorris“.
3. Im Posteingang prüfen, dass die nächste Anfrage der richtigen Plattform, dem richtigen Konto und dem richtigen weclapp-Auftrag zugeordnet wird.

Die Demo verwendet ausgedachte `.invalid`-Domains. Echte Absenderdomains von DocMorris und Amazon sind bewusst **nicht** vorbelegt.

## 6a. Marktplätze: eBay, Kaufland, Shop Apotheke

Alle drei kommen per Schnittstelle, nicht per Mail. Mails der Marktplätze sind nur Hinweise; Antworten per Mail kommen dort nicht an. Jede Verbindung startet im Entwurfsmodus. Vorher unter *Verkäuferkonten* je Marktplatz ein Konto mit dem passenden weclapp-Zuordnungsfeld anlegen und bei der Verbindung als Standard-Konto wählen.

**Kaufland**
1. Im Kaufland Seller Portal im API-Bereich Client Key und Secret Key anlegen.
2. *Einstellungen → Kaufland verbinden …*, beide Schlüssel eintragen, optional Storefront (z. B. `de`).
3. *Zugriff prüfen*, dann *Jetzt abrufen*. Danach fragt der Worker höchstens alle 5 Minuten neue Ticket-Nachrichten ab.

**eBay**
1. Im eBay Developer Program ein Production-Keyset anlegen (App ID, Cert ID) und einen RuName. Als *Auth accepted URL* des RuName eintragen: `https://<ihre-domain>/oauth/ebay/callback` (`PUBLIC_BASE_URL`).
   eBay schaltet ein Production-Keyset erst frei, wenn Kontolöschungen empfangen werden: In `.env` einen eigenen Zufallswert `EBAY_DELETION_VERIFICATION_TOKEN=` (32–80 Zeichen, nur Buchstaben, Ziffern, `_` und `-`, z. B. `openssl rand -hex 24`) setzen und SupportX neu starten. Im Developer Portal unter *Alerts & Notifications → Marketplace Account Deletion* als Endpunkt `https://<ihre-domain>/webhooks/ebay/account-deletion` und denselben Token eintragen, dann *Send Test Notification*. SupportX löscht bei einer echten Meldung alle Fälle dieses eBay-Nutzers; im Protokoll bleibt nur ein Hash.
2. *Einstellungen → eBay verbinden …*, App ID, Cert ID und RuName eintragen.
3. *Bei eBay anmelden* und mit dem **Verkäuferkonto** zustimmen (Recht „commerce.message“). Danach ruft SupportX Mitglieder-Nachrichten alle 5 Minuten ab.

**Shop Apotheke (Mirakl)**
1. Im Mirakl-Backoffice von Shop Apotheke in den Benutzereinstellungen den API-Schlüssel kopieren und die Adresse der Instanz notieren (`https://….mirakl.net`).
2. *Einstellungen → Shop Apotheke verbinden …*, Adresse und Schlüssel eintragen (Shop-ID nur bei mehreren Shops).
3. Mirakl sieht das Lesen nur beim Öffnen des Posteingangs vor. SupportX liest deshalb nur bei *Jetzt abrufen*. Erlaubt Shop Apotheke einen Hintergrundabruf, den Nachweis bei der Verbindung eintragen; erst dann ruft der Worker alle 15 Minuten ab.

Versand freischalten wie in Abschnitt 8, mit einer kontrollierten Testantwort im Marktplatz selbst.

## 6b. Amazon-Angebote deaktivieren (optional, Selling Partner API)

Damit lässt sich im Fall ein falsches Amazon-Angebot schließen (z. B. Angebot zeigt 2 statt 1 Flasche). Nachrichten von Amazon laufen weiter über das Postfach; dieser Zugang dient nur dieser einen Aktion.

1. **SP-API-App** (Developer Central des Betreibers): Die App braucht die Rolle **„Product Listing“**. Eine bestehende private oder öffentliche App kann genutzt werden, wenn sie diese Rolle hat. Client-ID und Client-Secret stehen unter „LWA-Zugangsdaten“.
2. **Autorisierung durch den Verkäufer:** Der Verkäufer autorisiert die App einmal für sein Verkäuferkonto (Seller Central → Apps und Services → Apps entwickeln bzw. Autorisierungslink der App). Dabei entsteht der **Refresh-Token** (beginnt mit `Atzr|`).
3. **Verkäufer-ID** (Händlertoken): Seller Central → Einstellungen → Kontoinformationen → Händlertoken.
4. In SupportX unter **Einstellungen → Amazon-Angebote** Region, Marktplätze, Verkäufer-ID, Client-ID, Client-Secret und Refresh-Token eintragen, speichern, **„Verbindung testen“**. Danach sind die Werte nur noch maskiert sichtbar; ändern geht nur über „Ändern“ (leere Felder behalten den gespeicherten Wert).
5. Im Fall (Amazon-Fälle) die Karte **„Amazon-Angebot“**: SKU prüfen (Vorschlag = Artikelnummer aus weclapp, muss nicht der Amazon-SKU entsprechen), „Angebot bei Amazon prüfen“, dann „Angebot deaktivieren …“ und im Dialog bestätigen.

SupportX setzt dabei ein Enddatum in der Vergangenheit am Angebot; Preis, Bestand und Texte bleiben. Wieder öffnen: in Seller Central das Enddatum des Angebots entfernen. Bis Amazon die Änderung verarbeitet hat, können einige Minuten vergehen. Bisher nur gegen einen lokalen Testdouble geprüft, noch nicht mit einem echten Konto.

## 7. Claude als KI-Anbieter

```
AI_PROVIDER=claude
ANTHROPIC_API_KEY=...
CLAUDE_MODEL=claude-opus-5-5
```

Claude erhält nur den Verlauf des Falls (ohne interne Notizen) und die belegten weclapp-Fakten und liefert einen strukturierten Vorschlag. Empfänger, Versandweg und Aktionen bestimmt immer der Server. Fällt Claude aus oder lehnt ab, wird eine Regelvorlage erzeugt und als solche gekennzeichnet. Ohne Schlüssel (`AI_PROVIDER=rules`) arbeitet alles mit Regelvorlagen.

## 8. Versand freischalten (erst nach Prüfung)

Für jede Plattform je Verbindung getrennt:

1. Eine echte Nachricht der Plattform prüfen: Absender, Reply-To, Zuordnung zu Konto und Auftrag.
2. Eine **kontrollierte Testantwort** auf eine Testbestellung oder an eine eigene Testadresse senden (z. B. manuell aus Outlook) und prüfen, dass sie im richtigen Thread ankommt: bei Amazon in Seller Central, bei DocMorris im Vorgang.
3. *Einstellungen → Geprüfte Antwortwege*: Plattform wählen und den Nachweis eintragen (Datum, Nachricht, Ergebnis).
4. `Application Mail.Send` per RBAC zuweisen (siehe 5.2), `SEND_MODE=enabled` setzen, Worker/Server neu starten, dann **Versand freischalten** an der Verbindung.

Danach gilt bei jedem Versand: nur nach menschlicher Freigabe, Freigabe verfällt bei neuer Kundennachricht oder geändertem Entwurf, höchstens eine Antwort je Kundennachricht. Antwortet Microsoft nicht rechtzeitig, steht der Auftrag auf „Versandstatus unklar“; der Worker sucht die Kopie in Gesendete Elemente und sendet nie automatisch erneut. Lässt sich das nicht klären, entscheidet eine Person („wurde gesendet“ / „wurde nicht gesendet“).
