# Install App Builder on SoloHost

SoloHost only **pulls** a public Docker image. It never builds from this ZIP.

If SoloHost stays on **Downloading** and never starts the container, the image is missing or private.

## Required image

`ghcr.io/cannoi/app-builder-pi-solohost:1.4.21`

## Fix infinite Downloading

1. Push this project to GitHub and wait until **Actions → Build SoloHost image** is green.
2. Open GitHub → Packages → `app-builder-pi-solohost`.
3. Package settings → **Change visibility → Public**.
4. Confirm the tag `1.4.21` exists.
5. In SoloHost, paste only:
   - `docker-compose.yml`
   - `config_options.yml`
6. Install again.

Do not paste the full source ZIP as the SoloHost package. SoloHost needs the two files above plus a public image.

## Local run without SoloHost pull

```bash
docker compose -f docker-compose.build.yml up -d --build
```

Then open `http://127.0.0.1:18781`.
