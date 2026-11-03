/** Placeholders of text blocks, with the help text shown in the settings. No imports: also used by the web UI. */
export const SNIPPET_PLACEHOLDERS = {
  Name: "Name des Kunden",
  Bestellnummer: "Bestellnummer beim Marktplatz bzw. Shop",
  Auftragsnummer: "Auftragsnummer in weclapp",
  Bestelldatum: "Bestelldatum",
  Sendungsnummer: "Sendungsnummer(n)",
  Trackinglink: "Trackinglink(s) mit Sendungsnummer",
  Signatur: "Signatur aus den Einstellungen",
} as const;

export type SnippetPlaceholder = keyof typeof SNIPPET_PLACEHOLDERS;
