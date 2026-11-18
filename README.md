# Agent Index – AI agent and tool catalogue

A low-cost public AI catalogue with a private admin dashboard, listing management, view analytics and a pay-per-search API using x402 / USDC on Base. The name is temporary.

## Render preview / free mode

Render web service on **free** plan. Free services sleep when unused, and the filesystem is **ephemeral**. Listings reset to the seeded defaults and views, admin edits and payment history *in this dashboard* disappear on redeploy or reboot. **Money already paid to the public wallet on Base is unaffected.** Do not count on admin financial records on the free instance. Upgrade to persistent storage before relying on the catalogue.

## Routes

- `/` public catalogue; `/search` filtered search; `/tools/<slug>` pages
- `/admin/login` password-protected admin, analytics, listing manager, AI payment log
- `/api/paid-search/info` JSON metadata and integration instructions
- `/api/paid-search?q=automation&limit=5` **x402 paywalled** tool search. Unpaid requests should return `402 Payment Required`; paid requests use USDC on Base mainnet.
- `/health` Render health check

The paid API is **$0.05 USDC per request** (USD cents, not GBP pence). Funds go directly to the configured Coinbase Wallet at `0x5e8685a52afe9bbe8e70e118816802672c74d3e1` on Base mainnet. Never put private keys in the repository or environment. The facilitator is third-party `https://facilitator.xpay.sh` and must be independently validated before high-volume use. A live payment has not been performed by the assistant, so payment settlement is not yet end-to-end verified.

## Environment

Set `NODE_ENV=production`, `SITE_NAME`, `DB_PATH=/tmp/catalogue.sqlite`, `APP_SECRET` (32+ random characters), and `ADMIN_PASSWORD` (12+ random characters). Render Blueprint generates APP_SECRET but requires you to set the admin password. The standard Render web service can be created with a GitHub repo and these variables. `PUBLIC_URL` should match the live URL for sitemap. 

## Local development

Requires Node 22.13+. `npm install` then set `APP_SECRET`, `ADMIN_PASSWORD` and `NODE_ENV=development`, run `npm start`. The paid route needs an x402-compatible paying client to test a real transaction. Never test with meaningful funds until verified. To test the original catalogue without package dependencies, run `START_SERVER=false node --test`.

The admin account uses a single password, no MFA. Views exclude recognised bots and logged-in admin browsing, with daily pseudonymous visitor hashing and 90-day retention. IP-based hashing is not fully anonymous: review privacy policy before business use.