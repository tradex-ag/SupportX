import type { CaseIntent } from "./contracts.ts";
import { classifyIntentByRules } from "./classify.ts";
import { asksForInvoice } from "./invoice-request.ts";

/**
 * What the customer wants, sorted on arrival without AI: an explicit invoice request
 * first (otherwise "Rechnung für mein Paket" would read as a parcel question), then
 * the keyword rules. A person can always change it; an AI draft may refine it.
 */
export function classifyTopic(customerText: string): CaseIntent {
  if (asksForInvoice(customerText)) return "invoice";
  return classifyIntentByRules(customerText);
}

export const TOPICS: ReadonlyArray<CaseIntent> = ["parcel_status", "wrong_item", "damaged_item", "return_request", "invoice", "product_question", "other"];

/** Topics with an automation besides the invoice: a fixed template from weclapp data, no AI. */
export const AUTOMATION_MODES = ["off", "draft", "send"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
export const AUTOMATABLE_TOPICS = ["parcel_status"] as const;
export type AutomatableTopic = (typeof AUTOMATABLE_TOPICS)[number];
