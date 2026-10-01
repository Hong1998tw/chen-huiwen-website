# Cloudflare static frontend delivery

## Contract
GitHub main remains the source and release history. The public frontend is built from the existing explicit _site allowlist for the assets-only huiwen-website target. The verified preview origin is https://huiwen-website.lihong.workers.dev; the canonical public origin stays https://www.huiwen.tw/.

No request-time main module, run_worker_first, Worker Caching, database, cron, new token or paid plan is introduced. Cloudflare Builds reuses the repository connection and deployment identity already used by the administrative frontend. Static requests and assets follow Cloudflare's published Static Assets billing; build use still counts against the account's existing allowance.

## Normal publication
1. Owner publishes through the existing standalone CMS.
2. The same publisher opens a bounded PR; required checks, trusted path guard and native auto-merge remain mandatory.
3. Main triggers Cloudflare Builds: install pinned validators, run quality.py, build_cloudflare_public.py, then pinned Wrangler with wrangler.public.jsonc.
4. The build copies only build_public.py output and adds deployment.json, with the exact sourceCommit and publication-manifest digest. Internal data, repository code, credentials and management files stay excluded.
5. cloudflare-public.yml is read-only: it waits until the production origin serves that exact commit and artifact digest. Its successful receipt is the CMS deployed layer.
6. production-verification.yml follows that successful exact-SHA receipt and retains independent HTTP, all-public-page, snapshot and native-browser checks. BLOCKED is never PASS.

## Initial migration
Keep www and the old Pages site unchanged until Cloudflare preview has passed:
- every artifact file's bytes, existing directory aliases and private-path 404 checks;
- all reviewed HTML paths, canonical URLs and critical facts;
- seven-width reading, keyboard and interaction checks.

The preview workflow does not submit forms or touch authenticated management data. Only after preview passes may the approved hostname move to the new static Worker. Then confirm the domain binding, live deployment manifest, exact source revision, public delivery job and the complete production checks. A build result or domain change alone is not production verification.

## Pages recovery
pages.yml no longer deploys on every main push. Its existing manual workflow remains available as a recovery tool. Do not stop or delete the old Pages deployment before migration verification.

The pre-migration source baseline is 459b80df48d6c77eef768eb8643c8c688c4ed360. The old www DNS target was the proxied CNAME hong1998tw.github.io. Runtime receipts and the exact Cloudflare version are recorded separately after native read-back.

For an urgent hosting rollback, restore the verified prior hostname route only under the applicable authorization, leaving source and security gates intact. Then use a reviewed PR to reconcile deployment-target.json and the delivery/production workflow routing. Do not pretend a Pages run is a Cloudflare receipt, roll back with a raw old HTML copy, or disable Access/WAF to obtain a passing result.

## Legacy Notion redeploy compatibility
The standalone CMS has no redeploy queue or action route in this change. The prior Notion executor is not enabled or given new permissions.

If that separately controlled legacy executor is used with the Cloudflare provider, its redeploy helper creates a guarded PR changing only data/deployment-request.json. This operational metadata is excluded from _site. The public content sources are unchanged; the new deployment.json release revision will change. Stable claim/PR identifiers support recovery after an uncertain response. Publisher credentials cannot change runtime configuration, workflows, scripts, content or CNAME through this domain.

The existing Pages helper remains the legacy fallback only for the Pages provider. Provider changes fail closed rather than misclassify a stale run.

## Evidence
- The first Cloudflare-local artifact run checked 339 exact file responses and 7 directory/root aliases, with private-path checks; this is candidate/local-runtime evidence.
- Actual preview and production success must be recorded from their own workflow runs and Cloudflare native resources.
- Design-only checkpoint 679632188aa073dda0da8bac0c9f1fda06477fac passed the original five workflow groups and new reading regression before the migration phase.
- Real-device, screen-reader and human usability testing remain separately outstanding.

References:
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/ci-cd/builds/
