# Deployment

Factory:

```bash
docker compose up -d --build
```

The Builder itself is still distributed as a normal SoloHost Docker image. Its built-in app-build/test engine uses the SoloHost Docker socket; users do not configure a separate Sandbox API. `DOCKER_MODE=power` is the default.

Generated apps keep the SoloHost-compatible `Dockerfile` contract and expose port `8080` inside their image. Playwright validates the temporary preview before the Builder reports success.
