# Paper Finder (Chrome / Edge / Brave, Manifest V3)

Search a topic, filter by journal quartile and impact, and download open-access PDFs automatically.

## Install
1. Unzip this folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `paper-finder` folder.
4. Pin the extension, open it, and add your email under **Settings** (Unpaywall requires it).

## One-time: import journal quartiles
1. On scimagojr.com go to Journal Rankings and click **Download data** (CSV).
2. In the extension, open Settings and choose that file. The quartile filter turns on.

## Search order
In the popup, tick the sites to use and move them Up or Down. The extension searches them from the top, one after another, and stops as soon as it has the number of papers you asked for. Sources: Google Scholar, OpenAlex, Semantic Scholar, Europe PMC (open access), arXiv (preprints, no journal metrics).
Every paper is matched to OpenAlex by DOI to get its journal quartile and impact, so the filters work for all sources. Papers with no DOI are kept only when no quartile or impact filter is set.

## Google Scholar mode
- When Google Scholar is ticked, the extension opens a background Scholar tab and reads each results page.
- If Google shows a CAPTCHA, the tab comes to the front. Solve it and the search continues by itself.
- Each Scholar result is matched to OpenAlex by title to get its DOI, journal quartile and impact. Results that cannot be matched are kept only when no quartile or impact filter is set.
- Scholar pages are read slowly (3 to 6 seconds apart, at most 4 pages) to avoid blocks. If Scholar falls short, the next source in your order fills the rest.
- Scholar has no citation sort or open-access filter, so those options apply to OpenAlex only. "Newest" works on both.

## How it works
- OpenAlex finds papers by topic and gives each journal's 2-year mean citedness (shown as IF, an approximation of the Impact Factor).
- PDF fallback chain: the Scholar [PDF] link, OpenAlex locations, Unpaywall, Semantic Scholar, Europe PMC. Each link is checked to be a real PDF before downloading.
- Files go to `Downloads/PaperFinder/<topic>/Year_Journal_Title.pdf`. Export CSV saves the results table.
- Papers with no open-access copy are listed with a DOI link instead of being downloaded.

## Notes
- `<all_urls>` permission is needed to check PDF links on any publisher or repository host.
- The IF column is not the Clarivate Impact Factor, which has no free API.
- Journals missing from the SCImago file are excluded when a quartile filter is on.
