# Deployment

The Builder is distributed as a normal SoloHost Docker image, but the Builder process never mounts or connects to the host Docker socket.

Run/Check use the built-in native preview runtime. Publish uploads source to GitHub; GitHub Actions builds and pushes the final GHCR image.
