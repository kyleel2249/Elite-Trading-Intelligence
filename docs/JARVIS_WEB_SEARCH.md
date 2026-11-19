# JARVIS internet search configuration

JARVIS supports Brave Search and Google Custom Search JSON API through a read-only web research intent.

## No additional Cloudflare bindings required

Provider credentials are submitted to the authenticated endpoint `/api/agents/jarvis/providers` and stored encrypted in the existing `ETI_EXECUTION_LOG` KV namespace. Encryption uses HKDF-SHA-256 and AES-256-GCM with the existing `ETI_EXECUTION_TOKEN` as key material. Credentials are never returned by the status endpoint or written to source files.

The existing execution token is the encryption root. If it is rotated, re-enter the search credentials; the previous encrypted record cannot be decrypted with the new token.

## Configure

Send an authenticated PUT request with any provider credentials you have:

```http
PUT /api/agents/jarvis/providers
Authorization: Bearer <ETI_EXECUTION_TOKEN>
Content-Type: application/json

{
  "braveApiKey": "<BRAVE_SEARCH_API_KEY>",
  "googleApiKey": "<GOOGLE_API_KEY>",
  "googleCx": "<GOOGLE_PROGRAMMABLE_SEARCH_ENGINE_ID>"
}
```

Use a secret manager or a trusted local terminal to send this request. Do not paste keys into GitHub source files, issues, or chat. You can configure only Brave, or Google (which requires both its API key and engine ID). Send an empty string for a field to clear it.

GET the same endpoint to see provider readiness; it never reveals credentials.

## Search behaviour

JARVIS queries configured providers concurrently, normalizes and de-duplicates links, returns provider labels and up to 12 combined results, and continues if one provider fails. Search findings are advisory only and cannot override deterministic market analysis, the Commander, Risk Manager, Security Analyst, or execution gateway.

## Google API availability caveat

The Google adapter targets the Custom Search JSON API (`https://www.googleapis.com/customsearch/v1`). Google's current documentation states that the API is closed to new customers and existing customers must transition by January 1, 2027. A Google key and Programmable Search Engine ID are required; new ETI users may not be able to obtain access. See https://developers.google.com/custom-search/v1/overview.

## Brave

Brave Search API credentials are required. See https://brave.com/search/api/.
