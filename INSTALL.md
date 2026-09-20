# Installation Guide

1. Install via SoloHost or `docker compose -f docker-compose.yml up -d`.
2. Set the host port in SoloHost settings.
3. Open `http://localhost:<HOST_PORT>`.
4. Registered SoloHost apps appear in the home constellation through `GET /api/apps`.


## Internet browsing gateway

Version 2.1 starts a separate local Web Gateway on container port `8081`, mapped to host `127.0.0.1:18081`. Keep both ports mapped. The browser UI uses the gateway for external HTTP/HTTPS pages so sites that send `X-Frame-Options` or CSP `frame-ancestors` can be displayed inside the embedded viewport.
