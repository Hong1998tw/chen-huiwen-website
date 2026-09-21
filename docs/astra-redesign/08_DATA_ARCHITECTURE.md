# Data and build architecture

Retain existing canonical models: achievement stable id/title/summary/categories/subcategories/district/villages/scope/locationName/coordinates/locationNote/status/budget/history/sources/updated/related/imageMetadata. Do not invent agencies or last_verified. `updated` rendered as 內容更新; history date retains original precision. Stage/status remains existing reviewed literal. Missing coordinates means text-only, not geocoded guesses.

Home selection config contains only stable IDs and UI grouping; generator reads public records via is_public and fails on unpublished IDs. It emits title, summary, status, updated and links from those same records. Existing builder drives list/detail/map; search indexes final HTML; sitemap retains existing routes. No second editable content truth.

New shared civic build step runs before search generation, applies a versioned shared CSS layer to public top-level HTML, generates homepage previews; the service task strip is static page markup; existing templates/builders remain authoritative. Repeated build must be byte-identical. Does not import Notion/private registry bytes.

Architecture-change gate: existing stack sufficient; framework migration rejected (no user value; risks URL/build regressions). Shared shell build reduces drift without changing hosting. Cost: all generated routes acquire one stylesheet reference. URL impact none. Rollback: local branch baseline 5aeddfd; restore by Git in isolated worktree, never overwrite original dirty checkout.
