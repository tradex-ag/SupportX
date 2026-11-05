# Contributing

Contributions should keep the implementation status explicit (see docs/CONNECTORS.md).

## Local development

Use Node.js 22.12 or newer and PostgreSQL 16. `npm ci`, then `npm run typecheck` and `npm test` (integration tests use `TEST_DATABASE_URL`, default `postgres://supportx:supportx@127.0.0.1:5432/supportx_test`, and truncate all tables there). `npm run demo` starts the full application with synthetic data. Dependencies are pinned in `package-lock.json`; CI runs the same steps (`.github/workflows/ci.yml`).

## Connector contributions

Keep message transport separate from order context. Supply an official source for every platform endpoint, the API version, authentication requirements, pagination behavior, rate-limit behavior and account validation procedure. Unknown functionality must remain unavailable until verified. Do not create a mock that reports a successful live send.

Tests should cover account isolation, pagination, duplicate ingress, message routing, expired credentials, rate limits and ambiguous outbound outcomes. Use synthetic fixtures or properly de-identified fixtures that contain no live identifiers or credentials. Include separate test steps for a controlled account integration; do not send messages to real customers as part of CI.

## AI provider contributions

Return the common structured proposal contract. Do not introduce a provider-specific bypass of authorization, evidence validation or approval. Model configuration, credentials, telemetry and cost controls belong to the operator's workspace. A model provider must not become an implicit dependency of all connectors.

## Licensing and how to give changes back

SupportX is licensed under AGPL-3.0-only with the attribution term in [NOTICE](NOTICE). If you run a modified SupportX for others or distribute it, you must publish your source under the same license. Please do not stop there: open a pull request against https://github.com/tradex-ag/SupportX so the improvement reaches everyone.

By opening a pull request you confirm that you wrote the contribution or are otherwise entitled to submit it, that it is licensed under AGPL-3.0-only, and that you grant TradeX International AG a perpetual, worldwide, non-exclusive, royalty-free right to use, change, sublicense and relicense the contribution, including under other license terms. You keep your own copyright. Add a `Signed-off-by:` line to each commit (`git commit -s`, Developer Certificate of Origin, https://developercertificate.org/) to state this.

Submit only material you are entitled to license under these terms. Preserve upstream license notices where applicable. Review dependency licenses before introducing them. Do not copy marketplace documentation, platform SDKs or proprietary application modules into the repository without checking their respective licenses.
