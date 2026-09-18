# Changelog

## 1.4.14
- Run/preview no longer depends on the generated app listening on a random port.
- If index.html exists, Builder serves the UI and /health itself. A crashing Express start script no longer produces "fetch failed".
