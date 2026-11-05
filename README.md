# 📄 Paper Finder — Academic Research Web Scraping Extension

An automated academic web scraping and paper retrieval system (Chrome / Edge / Brave Manifest V3 extension). Search research topics across multiple scholarly databases, filter by journal quartiles (Q1–Q4) and impact metrics, and automatically scrape and download open-access PDFs.

---

## 🚀 Features

- **Multi-Source Scraping**: Scrapes and aggregates research papers across:
  - Google Scholar
  - OpenAlex
  - Semantic Scholar
  - Europe PMC (Open Access)
  - arXiv (Preprints)
- **Automated Fallback Chain**: Resolves open-access PDFs through Google Scholar PDF links, OpenAlex locations, Unpaywall, Semantic Scholar, and Europe PMC.
- **Smart Filtering**:
  - SCImago journal quartile filtering (Q1, Q2, Q3, Q4)
  - 2-year mean citedness / impact metrics
  - Minimum citation thresholds
- **Organized Storage**: Automatically categorizes downloaded research papers into topic-specific directories (`PaperFinder/<topic>/Year_Journal_Title.pdf`).
- **Export Capabilities**: Exports tabular metadata and DOI references to CSV.

---

## 📂 Repository Structure

```
.
├── paper-finder/            # Chrome/Edge Manifest V3 extension source code
│   ├── manifest.json        # Extension configuration & permissions
│   ├── background.js        # Background service worker & scraping pipeline
│   ├── popup.html           # Extension UI popup
│   ├── popup.js             # User interaction, search ordering & settings
│   ├── popup.css            # Popup styling
│   ├── scholar.js           # Google Scholar content script & CAPTCHA handling
│   ├── icons/               # Extension icons
│   └── README.md            # Extension-specific setup instructions
│
├── PaperFinder/             # Scraped research papers and open-access PDFs
│   ├── 3d_mesh_segmentation/ # Sample scraped papers for 3D Mesh Segmentation
│   ├── 3D_mess_segmentation/ # Additional scraped segmentation literature
│   └── mesh_CNN/            # Scraped MeshCNN literature
│
└── README.md                # Repository overview and documentation
```

---

## 🛠️ Installation & Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/sohanur-1234/web-scraping.git
   ```
2. Open your Chromium browser (Chrome, Edge, Brave) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the [`paper-finder/`](paper-finder) folder.
5. Pin the extension and configure your settings (add email for Unpaywall access and optionally import SCImago journal rankings CSV).

---

## 🔍 How Scraping Works

1. **Query Dispatch**: Dispatches the topic query to configured scholarly engines in user-defined priority order.
2. **Metadata Matching**: Matches extracted records against OpenAlex by DOI or title to retrieve citation and journal impact statistics.
3. **PDF Resolution**: Resolves direct PDF URLs through the fallback chain, validates headers, and triggers downloads into `PaperFinder/<topic>/`.
