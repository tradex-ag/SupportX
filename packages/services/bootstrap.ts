import { checkClaudeKey, claudeWithKey, createAiProvider } from "../ai/index.ts";
import { operatorEbayApp, type AppConfig } from "../storage/config.ts";
import { createPool } from "../storage/db.ts";
import { SecretBox } from "../storage/secrets.ts";
import { defaultConnectorFactory } from "./connections.ts";
import type { AppContext } from "./context.ts";

export function createContext(config: AppConfig, overrides: Partial<AppContext> = {}): AppContext {
  return {
    db: overrides.db ?? createPool(config.DATABASE_URL),
    config,
    secrets: overrides.secrets ?? new SecretBox(config.APP_ENCRYPTION_KEY),
    ai: overrides.ai ?? createAiProvider(config),
    aiWithKey: overrides.aiWithKey ?? ((apiKey) => claudeWithKey(config, apiKey)),
    checkAiKey: overrides.checkAiKey ?? ((apiKey) => checkClaudeKey(apiKey, config.CLAUDE_MODEL)),
    connectors: overrides.connectors ?? defaultConnectorFactory(config.ALLOW_TEST_ENDPOINTS, operatorEbayApp(config)),
    now: overrides.now ?? (() => new Date()),
  };
}
