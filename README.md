# DealFeed

Every live Regulation CF offering in the US, aggregated daily from public SEC filings, presented as a scrollable feed with plain-English summaries and red flags.

**How it works:** a script (`pipeline/fetch.mjs`) searches SEC EDGAR for recent Form C filings, parses each one, generates a summary and red flags from the numbers, and writes everything to `docs/data.json`. The website (`docs/index.html`) displays that data. A GitHub Action runs the script automatically every morning. Total running cost: $0 (plus ~$12/year if you add a custom domain).

DealFeed touches no money, takes no fees from issuers, and makes no recommendations — it lists and links, like a newspaper. Keep it that way (see "Legal guardrails" below).

