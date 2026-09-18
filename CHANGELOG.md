# Changelog

## 1.4.9

- Run preview is an in-process static server. It no longer depends on npm start or Playwright.
- Playwright is optional and cannot block a working preview.
- Publish still requires a passing Run (health + preview link).
- Factory compose stays without docker.sock.

