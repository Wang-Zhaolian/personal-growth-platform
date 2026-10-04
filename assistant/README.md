# Personal Growth Plus Companion

A small, generic Windows localhost client for personal productivity websites. It authenticates with Sign in with ChatGPT, stores tokens locally, requests a model response, and returns text to the paired website for review. It has no database access and no endpoint that can commit application records.

The source in this repository is intended to remain public under the MIT license. Public source and successful OAuth sign-in alone do not guarantee that a ChatGPT account, workspace, client, or use case can use subscription inference. The authorization response must grant both inference scopes and an actual completed Responses request must succeed.

## Requirements

- Windows 10 or later
- Node.js 22.13 or later
- A ChatGPT account that OpenAI allows to use plan inference from an open-source client

## Start

Set GROWTH_SITE_ORIGIN to the exact HTTPS origin of your own website and run node server.mjs. The service binds only to 127.0.0.1:41739. Open that address locally, select **Continue with ChatGPT**, and review the requested permissions. Then open the website’s AI panel and enter the one-time code shown on the local page.

Each computer has its own persisted host ID and encrypted credentials. The first sign-in dynamically registers a client; later sign-ins reuse its issued client ID. The service uses Authorization Code with PKCE, validates the ID-token signature, issuer, audience, expiry, nonce, and returning account identity against OpenAI’s published JWKS, then verifies the granted scopes before enabling inference.

Access, refresh, and ID tokens are encrypted with Windows DPAPI for the current Windows user in the local application-data folder. They are not sent to the website and are not part of any website data export. Requests use the public Responses API, store false, and stream true. A request counts as successful only after response.completed. No prompts or tokens are written to logs.

## Pairing and network boundary

The HTTP service listens on the IPv4 loopback address only. Browser APIs accept requests only from the configured exact HTTPS origin, require a random per-browser pairing token, and handle the browser’s Private Network Access preflight. The pairing code is displayed only by the local page and rate-limited. Keep it private and pair only your own browser.

The paired website sends the selected records and current request to this local service; the service sends that text to OpenAI for inference. Review the website’s privacy policy and use the assistant only with a website you control.

## Configuration

GROWTH_SITE_ORIGIN is required and must exactly match your website origin. GROWTH_COMPANION_PORT can change the default port, but the website client must be configured to use the same port. The stable host ID and protected credentials live under %LOCALAPPDATA%\\PersonalGrowthAssistant.

## Limitations

This is a personal Windows helper, not a remotely hosted inference proxy. OpenAI determines account eligibility, available models, app limits, and usage. Plus plan limits are shared with other apps using the same account. If authorization is declined, scopes are missing, the account is ineligible, or a request is interrupted or limited, AI generation stays unavailable; the paired website must continue to offer its manual features.

## License

MIT. See LICENSE.
