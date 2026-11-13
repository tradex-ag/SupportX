import type { CapabilityState, SourcePlatform } from "../core/contracts.ts";

/**
 * Researched connector status, shown in the UI and docs. "documented" means the
 * vendor documents the operation; it does NOT mean this project implements it or
 * that an account was tested. Research date: 2026-10-21 (docs/CONNECTORS.md).
 */
export interface ConnectorDescriptor {
  platform: SourcePlatform | "microsoft" | "weclapp";
  label: string;
  transport: string;
  implementation: "implemented" | "via_microsoft_mail" | "planned";
  receive: CapabilityState;
  reply: CapabilityState;
  accountTestNeeded: ReadonlyArray<string>;
  notes: string;
}

export const CONNECTOR_CATALOG: ReadonlyArray<ConnectorDescriptor> = [
  {
    platform: "microsoft",
    label: "Microsoft 365 (Graph)",
    transport: "Graph Mail API: Delta je Ordner, Reply, optionale Change Notifications",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "Exchange-Online-Postfach und App-Registrierung (Mail.Read, später Mail.Send als Anwendungsberechtigung)",
      "Postfachbeschränkung per Exchange RBAC for Applications (erlaubtes und nicht erlaubtes Postfach testen)",
      "Bleibt der x-supportx-outbox-id-Header in Gesendete Elemente erhalten (Abgleich nach Timeout)?",
      "Weiterleiten: Gehen die Datei-Anhänge der Original-Mail mit, und bleibt der Marker-Header in der weitergeleiteten Kopie erhalten?",
    ],
    notes: "Eine 202-Antwort von Graph ist eine Annahme, kein Zustellnachweis.",
  },
  {
    platform: "weclapp",
    label: "weclapp (REST API v2)",
    transport: "Lesend: salesOrder, shipment (parcels[]), salesInvoice",
    implementation: "implemented",
    receive: "not_implemented",
    reply: "not_implemented",
    accountTestNeeded: [
      "In welchem Feld steht die Marktplatz-Bestellnummer (orderNumberAtCustomer, orderNumber, ecommerceOrder.ecommerceId)?",
      "Woran sind Verkäuferkonten im Auftrag erkennbar (salesChannel, Kunde, E-Commerce-Verbindung, Tag)?",
      "Filter shipment?mainSalesOrderId-eq liefert alle Teillieferungen?",
      "Bestehende Integrationen des Token-Nutzers vor jeder Token-Erneuerung prüfen",
    ],
    notes: "Einzige Bestelldatenquelle im ersten Build.",
  },
  {
    platform: "docmorris",
    label: "DocMorris",
    transport: "E-Mail über den Microsoft-Anschluss (vom Projektinhaber bestätigt)",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "documented",
    accountTestNeeded: ["Absender, Reply-To und Zuordnung einer kontrollierten Antwort zum DocMorris-Vorgang anhand einer echten Nachricht"],
    notes: "Kein eigener API-Connector nötig. Versand bleibt gesperrt, bis der Rückweg geprüft ist.",
  },
  {
    platform: "amazon",
    label: "Amazon (Buyer-Seller-Messaging-Relay)",
    transport: "Relay-E-Mail über den Microsoft-Anschluss",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "documented",
    accountTestNeeded: [
      "Absenderadresse in Seller Central (Messaging Permissions) freigeschaltet",
      "Kontrollierte Antwort erscheint im richtigen Seller-Central-Vorgang",
    ],
    notes: "Die SP-API Messaging API ist kein allgemeiner Posteingang; sie bietet nur bestimmte Aktionen je Bestellung.",
  },
  {
    platform: "shopify",
    label: "Shopify (Support-E-Mail)",
    transport: "E-Mail über den Microsoft-Anschluss",
    implementation: "via_microsoft_mail",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: ["Kontaktformular/Support-Mails landen im angebundenen Postfach"],
    notes: "Kein Shopify-Bestellanschluss; Bestellungen kommen aus weclapp. Shopify-Inbox-Chats nur bei tatsächlicher Nutzung prüfen.",
  },
  {
    platform: "ebay",
    label: "eBay (Commerce Message API)",
    transport: "OAuth je Verkäuferkonto; getConversations / getConversation / send_message, Abruf alle 5 min",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "Eigenes eBay-Keyset mit Scope commerce.message und RuName auf /oauth/ebay/callback",
      "Filtert start_time nach Erstellung oder letzter Aktivität der Konversation?",
      "Wie erscheint die eBay-Bestellnummer in der Nachricht (nur Artikelnummer = keine Bestellung)?",
      "Kontrollierte Testantwort erscheint in der eBay-Konversation",
    ],
    notes: "Nur Mitglieder-Konversationen, keine eBay-Systemnachrichten. NEW_MESSAGE-Push noch nicht angebunden.",
  },
  {
    platform: "kaufland",
    label: "Kaufland (Seller API Tickets)",
    transport: "HMAC-signiert; GET /tickets/messages, GET /tickets/{id}, POST /tickets/{id}/messages, Abruf alle 5 min",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "API-Schlüssel aus dem Seller Portal",
      "Werte von author.role (Käufer, Verkäufer, Kaufland-Service)",
      "In welchem weclapp-Feld steht die Kaufland-Bestellnummer (id_order)?",
      "Kontrollierte Testantwort im Ticket sichtbar",
    ],
    notes: "Antworten werden mit interim_notice=false gesendet (normale, kundensichtbare Antwort). Kein Ticket-Push dokumentiert.",
  },
  {
    platform: "shop_apotheke",
    label: "Shop Apotheke (Mirakl M10/M11/M12)",
    transport: "Mirakl-Posteingang der Betreiber-Instanz; Abruf bei offenem Posteingang (höchstens alle 10 min) und per Klick, Hintergrundabruf nur mit Freigabe",
    implementation: "implemented",
    receive: "configured",
    reply: "configured",
    accountTestNeeded: [
      "Adresse der Shop-Apotheke-Mirakl-Instanz und Nachrichtenrechte des API-Schlüssels",
      "Freigabe des Betreibers für Hintergrundabruf (Mirakl: synchron beim Öffnen des Posteingangs)",
      "Format der Bestellnummer (MMP_ORDER) in weclapp",
      "Kontrollierte Testantwort an Kunde bzw. Betreiber",
    ],
    notes: "Empfänger kommt aus dem Vorgang selbst (Kunde oder Betreiber), nie aus dem Entwurf.",
  },
];
