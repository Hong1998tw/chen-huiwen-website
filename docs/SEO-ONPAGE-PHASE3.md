# SEO On-page Phase 3

## Baseline and boundaries

- Original Phase 3 baseline: `52244158452574afdf429cabf45641bce18eb4a0`
- Reconciliation baseline (latest canonical `main`): `0c3072ca63f1161619073d7e6bebcfcfb3c36f9c`
- Branch: `seo/onpage-optimization-20260909-v3`
- Canonical host remains `https://hong1998tw.github.io/chen-huiwen-website/`.
- This phase does not change `huiwen.tw`, DNS, Cloudflare, GitHub Pages settings, redirects, production, Drive, Notion, Search Console, or the political-donation process.

## Page intent inventory

| Page | Search intent | Structured data | Internal-link role |
| --- | --- | --- | --- |
| `/` | 陳慧文、高雄市議員、鳳山服務與問政入口 | WebSite, Person, Organization | Root to all primary sections |
| `about.html` | 學經歷與公共服務 | ProfilePage, Person | Contextual links to政績、政見、新聞 |
| `achievements.html` | 鳳山政績與建設追蹤 | CollectionPage, BreadcrumbList | Hub to generated case pages |
| `vision.html` | 2026 與歷屆政見 | CollectionPage, BreadcrumbList | Link to人物與服務脈絡 |
| `news.html` | 新聞、議會問政、地方服務紀錄 | CollectionPage, BreadcrumbList | Natural links to related first-party cases |
| `activities.html` | 活動公告與服務處資訊 | CollectionPage, BreadcrumbList | Entry to gallery and past activity records |
| `gallery.html` | 公開活動與服務現場相片 | ImageGallery, BreadcrumbList | Contextual entry from activities |
| `service.html` | 鳳山服務處、電話、地址與諮詢 | ContactPage, Organization | Link to petition where appropriate |
| `petition.html` | 鳳山服務案件陳情與問題反映 | ContactPage | Link back to service context |
| `political-donation.html` | 115 年政治獻金專戶與捐贈須知 | WebPage, BreadcrumbList | Informational link from homepage |

## Deterministic gate

Run `python3 scripts/validate_seo.py` offline. It checks title/description uniqueness, canonical and `og:url`, OG/Twitter image metadata including both image alts, JSON-LD parsing and page-type coverage, URL host identity, continuous breadcrumb positions, sitemap/robots consistency, valid `lastmod`, language, 404 noindex, contextual inbound links, and indexable-page orphans. It exits zero only when the contract passes.

Generated case pages keep Article + BreadcrumbList JSON-LD and derive descriptions from the canonical record summary. When a record has no verified summary, the fallback explicitly says it is an index and verification-status page; it does not assert an outcome.

## Verification boundaries

The validator is offline and cannot establish Search Console indexing, external-link availability, social-platform rendering, or live GitHub Pages deployment. Those remain separate checks for the deployment/migration phases.

## Sitemap date boundary

All 55 indexable sitemap entries carry `lastmod` `2026-09-09` because every public HTML page was regenerated or had metadata/structured-data/internal-link content changed in this Phase 3 reconciliation working tree on that date. The two Stage 2 pages (`achievement-fengshan-station-overview.html` and `history-meilidao.html`) remain included, and the 404 remains excluded. Dates are explicit source metadata, not filesystem mtimes.
