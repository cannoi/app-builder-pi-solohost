# Security

App Builder uses a protected rootless Docker socket sandbox instead of the host Docker socket. Generated apps do not receive container-engine credentials.

The Builder controller can build and test images through the configured Docker socket. Because that API is powerful, it must not be exposed publicly without strong authentication and transport protection.

Generated project scans continue to block secrets, privileged settings and unsafe host mounts. A project that attempts to mount `/var/run/docker.sock` remains a security finding and is not treated as a safe deployment.
