# Reverse proxy

Loom binds to 127.0.0.1:$LOOM_PORT on the host by default (see [Configuration](CONFIGURATION.md)), it's not meant to face the internet directly. Put a reverse proxy in front of it for HTTPS and a real hostname.

Whatever proxy you use, also set BETTER_AUTH_URL and TRUSTED_ORIGINS in .env to the public URL, then run docker compose up -d again.

## Caddy

Caddy gets HTTPS certificates from Let's Encrypt on its own if it can reach the internet on ports 80 and 443.

```caddyfile
loom.example.com {
    reverse_proxy 127.0.0.1:8085
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

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

To have Traefik find Loom through Docker labels instead of a config file, add these to the loom-web service in compose.yml, and remove the ports mapping since Traefik reaches it over the Docker network:

```yaml
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.loom.rule=Host(`loom.example.com`)"
      - "traefik.http.routers.loom.tls.certresolver=letsencrypt"
      - "traefik.http.services.loom.loadbalancer.server.port=3000"
```

## Cloudflare Tunnel

Handy if your server has no public IP you can reach, common with CGNAT and most home ISPs. cloudflared runs as its own process or container and makes an outbound-only tunnel. Point it at a local Caddy or nginx, not the container port, so proxy behavior like headers and timeouts stays in one place.

```yaml
# /etc/cloudflared/config.yml
tunnel: <your-tunnel-id>
credentials-file: /path/to/<tunnel-id>.json
ingress:
  - hostname: loom.example.com
    service: http://127.0.0.1:80   # your local Caddy/nginx, not the container
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel-name> loom.example.com
sudo systemctl restart cloudflared
```

## Big uploads and slow requests

Things worth checking with any proxy:

- Request size. Uploads are sent in chunks of 32 MB by default (`LOOM_UPLOAD_CHUNK_MB`), so the proxy only needs to allow requests somewhat larger than one chunk. In nginx that's `client_max_body_size 128m;`. This is also why uploads work through Cloudflare, which caps requests at 100 MB. Keep the chunk size below your proxy's limit.
- Timeouts. The first request for a region of a video can take a few seconds while HLS segments are made, and a very short proxy timeout will cut that off. 60 seconds is a safe minimum.
- Live updates. `/api/events` is a Server-Sent Events stream that stays open. Proxies must not buffer it: `proxy_buffering off` in nginx; Caddy and Cloudflare handle it automatically. If it's buffered, Loom still works, but new thumbnails take a few seconds longer to appear.
- Client IP. Pass `X-Forwarded-For` so sign-in and share-password rate limiting apply per visitor rather than to the proxy itself.
- Share links. `/s/…` pages and `/api/share/…` are meant to be reachable without logging in. If you put extra authentication in front of Loom (Cloudflare Access, Authelia, basic auth), exempt those two paths if you want share links to work for people without an account.
