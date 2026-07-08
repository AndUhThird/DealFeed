# DealFeed

Every live Regulation CF offering in the US, aggregated daily from public SEC filings, presented as a scrollable feed with plain-English summaries and red flags.

**How it works:** a script (`pipeline/fetch.mjs`) searches SEC EDGAR for recent Form C filings, parses each one, generates a summary and red flags from the numbers, and writes everything to `docs/data.json`. The website (`docs/index.html`) displays that data. A GitHub Action runs the script automatically every morning. Total running cost: $0 (plus ~$12/year if you add a custom domain).

DealFeed touches no money, takes no fees from issuers, and makes no recommendations — it lists and links, like a newspaper. Keep it that way (see "Legal guardrails" below).

---

## Deploy it (one-time setup, ~20 minutes, no coding)

1. **Create a GitHub account** at github.com (free).

2. **Create a new repository.** Click "+" → "New repository". Name it `dealfeed`, set it to **Public**, click "Create repository".

3. **Upload this folder.** On the empty repo page, click "uploading an existing file", then drag ALL the contents of this `dealfeed` folder in (the `pipeline` folder, `docs` folder, `README.md`, and the `.github` folder — if your computer hides the `.github` folder, use GitHub Desktop instead, or press Cmd+Shift+. in Finder to show hidden files). Commit.

4. **Set your contact email.** SEC requires automated scripts to identify themselves. Open `.github/workflows/update.yml` on GitHub, click the pencil to edit, and make sure the `SEC_USER_AGENT` line has your real email. Commit.

5. **Turn on the website.** Repo → Settings → Pages → under "Build and deployment", Source: "Deploy from a branch", Branch: `main`, Folder: `/docs`. Save.

6. **Run the pipeline once.** Repo → Actions tab → enable workflows if prompted → click "Update deals daily" → "Run workflow". Wait ~2–4 minutes for it to finish (green check).

7. **Visit your site** at `https://YOUR-USERNAME.github.io/dealfeed/`. It ships with seed data, and the Action refreshes it every morning from that day's SEC filings.

## Run it on your own computer (optional)

Install Node.js (nodejs.org, LTS version), then in a terminal:

    cd dealfeed
    node pipeline/fetch.mjs --test    # offline test of the parser
    node pipeline/fetch.mjs           # real fetch: writes docs/data.json

Then open `docs/index.html` in a browser.

## Upgrades, in order of value

1. **Custom domain** (~$12/yr): buy one (Namecheap/Cloudflare), add it in repo Settings → Pages.
2. **Analytics**: add Plausible or PostHog (one script tag in `index.html`) so you can measure the only numbers that matter — weekly return visits and clicks to SEC filings/companies.
3. **Email digest**: a weekly "new deals this week" email (Buttondown or Beehiiv, free tiers). This is your retention engine.
4. **AI summaries**: replace `summarize()` in `pipeline/fetch.mjs` with a call to the Claude API for richer prose. Store the API key as a GitHub Actions secret (Settings → Secrets → Actions), never in the code.
5. **Deep links to offering pages**: the filing names the platform but not the campaign URL; add a lookup step that finds each deal's page on Wefunder/StartEngine/etc. so "Invest" goes straight to the offering.
6. **More filing types**: handle C-U (progress updates — these contain amounts actually raised!) and C-W (withdrawals) to show funding progress and remove dead deals.

## Legal guardrails (do not skip)

- Never take compensation from issuers or platforms tied to whether anyone invests.
- Never rank deals, pick "top deals," or personalize recommendations. Filters the user sets themselves are fine.
- Keep the disclaimer visible: aggregated public data, not investment advice, investing happens on the registered platform.
- Add Terms of Service and Privacy Policy pages before promoting publicly.
- Before charging anyone money or accepting any platform partnership, talk to a securities lawyer.

## Files

    dealfeed/
      README.md                        <- you are here
      pipeline/
        fetch.mjs                      <- the EDGAR pipeline (zero dependencies)
        fixtures/sample_form_c.xml     <- real filing used by --test
      docs/                            <- the website (GitHub Pages serves this)
        index.html
        data.json                      <- regenerated daily by the Action
      .github/workflows/update.yml     <- the daily automation
