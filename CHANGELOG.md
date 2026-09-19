# Changelog

## 1.4.13

- ⬆ Zip imports an app, unpacks it, and flattens a single wrapper folder.
- ⬇ Zip downloads a real .zip via blob (works in Pi Desktop WebView).
- runWithRepair is inside the pipeline again so Run is not "runProject is not defined".


## 1.4.14
- Native preview serves index.html + /health even when package.json start script crashes (fixes fetch failed on Run).

## 1.4.15
- Preview iframe no longer proxies to Builder :8080. Uses the app preview port.
