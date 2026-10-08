# Reverse proxy setup

Loom binds to `127.0.0.1:$LOOM_PORT` on the host by default (see [Configuration](CONFIGURATION.md)). It isn't meant to be exposed to the internet directly. Put a reverse proxy in front of it for HTTPS and a proper hostname, or use a tunnel if your server has no reachable public IP.

Whichever you use, set `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` in `.env` to the public URL, then apply it with `docker compose up -d`. `BETTER_AUTH_URL` is also the address share links are built from.

## What any proxy needs

| Requirement | Why | nginx setting |
|---|---|---|
| Request bodies larger than one upload chunk | Uploads are sent in 32 MB chunks by default (`LOOM_UPLOAD_CHUNK_MB`) | `client_max_body_size 128m;` |
| Don't buffer `/api/events` | Live updates are a long-lived Server-Sent Events stream | `proxy_buffering off;` and a long `proxy_read_timeout` on that location |
| Timeouts of at least 60 s | The first request for a region of a converted video waits for FFmpeg | `proxy_read_timeout 60s;` |
| Pass the client IP | Sign-in and share-password rate limits apply per visitor, not to the proxy | `X-Forwarded-For` header |
| Leave `/s/…` and `/api/share/…` open | Share links must work for people without an account | Exempt them from any extra auth layer |

Caddy and Cloudflare handle SSE streaming automatically and have no body limit below the chunk size (Cloudflare caps requests at 100 MB, which is why the chunk size maximum is 95 MB).

## Caddy

Caddy obtains and renews HTTPS certificates from Let's Encrypt automatically, as long as it can reach the internet on ports 80 and 443.

```caddyfile
loom.example.com {
    reverse_proxy 127.0.0.1:8085
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

No extra settings are needed: Caddy flushes event streams immediately and doesn't limit request size by default.

## nginx

```nginx
server {
    listen 443 ssl;
    server_name loom.example.com;

    ssl_certificate     /etc/letsencrypt/live/loom.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/loom.example.com/privkey.pem;

    client_max_body_size 128m;  # uploads arrive in 32 MB chunks

    location / {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # HLS streaming holds the connection open while segments are made
        proxy_read_timeout 60s;
        proxy_buffering off;
        proxy_request_buffering off;
    }

    # Live updates (Server-Sent Events): never buffer, keep the connection open
    location /api/events {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

## Traefik (Docker labels)

To have Traefik discover Loom through Docker labels instead of a static config file, add these to the `loom-web` service. Put them in a `compose.override.yml` rather than editing `compose.yml`, so updates never conflict with your changes (see [Upgrading → Local changes](UPGRADING.md#local-changes)). Remove the `ports:` mapping too, since Traefik reaches the container over the Docker network:

```yaml
services:
  loom-web:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.loom.rule=Host(`loom.example.com`)"
      - "traefik.http.routers.loom.tls.certresolver=letsencrypt"
      - "traefik.http.services.loom.loadbalancer.server.port=3000"
```

## Cloudflare Tunnel

Useful when your server has no directly reachable public IP (common behind CGNAT and most residential ISPs). `cloudflared` runs as its own process or container and creates an outbound-only tunnel. Point it at a local Caddy or nginx rather than the container port, so proxy behavior (headers, timeouts) stays in one place.

```yaml
# /etc/cloudflared/config.yml
tunnel: <your-tunnel-id>
credentials-file: /path/to/<tunnel-id>.json
ingress:
  - hostname: loom.example.com
    service: http://127.0.0.1:80   # your local Caddy/nginx, not the container directly
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel-name> loom.example.com
sudo systemctl restart cloudflared
```

Two Cloudflare limits matter, and Loom is built to fit both:

- **100 MB request bodies.** Uploads go in 32 MB chunks (maximum 95 MB), so any file size works.
- **100-second request timeout.** Copies run as background jobs and return immediately, so big copies don't hit it.

## Extra authentication in front of Loom

If you put another login layer in front of Loom (Cloudflare Access, Authelia, basic auth), exempt `/s/*` and `/api/share/*` if you want share links to work for people without an account. Everything else can stay behind it.
