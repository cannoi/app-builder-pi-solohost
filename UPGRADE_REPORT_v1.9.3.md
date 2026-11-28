# UPGRADE REPORT — v1.9.3

VERSION: 1.9.3 · FLAG DEFAULT: shadow

## COMPLETED THIS PASS
- CREATE shadowInspect
- improve eng checkpoint + flag=on pre-validation (non-blocking)
- Snapshot pruneRetention
- secret_scan step
- mobile viewport option
- checkpoints API
- i18n Engineering strings

## TESTS
- engineering-v193 + v192 (run in session)

## STILL DEFERRED / NOT VERIFIED
- M11 MCP
- Full DARE v2 new deterministic rules
- flag=on autonomous write loop (only pre-validation when on)
- Full npm test (477) regression this session
- Docker image / live Chromium / live GitHub

## PRODUCT PRINCIPLES PRESERVED
- EN+VI UI, chat language follows user
- No new runtime dependencies
- SoloHost contract untouched
- Feedback Hub secrets not modified (per prior request)
