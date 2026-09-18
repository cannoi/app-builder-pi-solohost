# Security

- Never commit `.env` or real API keys.
- The app listens on `0.0.0.0:8080` inside the container for SoloHost deployment.
- Do not add `docker.sock` or privileged mode unless the deployment architecture explicitly requires it.
