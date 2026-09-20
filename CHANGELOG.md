# Changelog

## [2.1.0] - 2026-09-20
- Fixed Internet browsing architecture: external pages now load through a dedicated local Web Gateway instead of direct cross-origin iframe embedding.
- Added HTTP(S) proxying with redirect handling, HTML navigation/resource rewriting, cookies for the local proxy origin, timeout limits, and private-network SSRF blocking.
- Added dedicated proxy port 8081 / host port 18081 while keeping the main app on 8080 / 18080.
- Stripped upstream `X-Frame-Options` and CSP framing headers only inside the local gateway response so sites that prohibit iframe embedding can render in the browser surface.
- Kept Docker/host isolation: no Docker socket and no direct container-engine access.

## [2.0.0] - 2026-09-19
- Redesigned SoloHost Browser as a freeform spatial interface.
- Replaced the card dashboard with a floating constellation of apps.
- Added App Manager discovery, safe App Gateway routes, and quiet browser chrome.
- Bookmarks and history persist locally without blocking browsing when SoloHost is offline.

## [1.0.0] - 2025-02-20
- Initial release of SoloHost Browser & App Hub.
