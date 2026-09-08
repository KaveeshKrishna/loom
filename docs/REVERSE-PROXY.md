# Reverse Proxy Setup

Loom binds to `127.0.0.1:$LOOM_PORT` on the host by default (see [Configuration](CONFIGURATION.md)) — it is not meant to be exposed to the internet directly. Put a reverse proxy in front of it for TLS termination and a proper hostname.

Whichever proxy you use, remember to also set `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` in `.env` to match the public URL, and restart (`docker compose up -d`) after changing them.

## Caddy

Caddy handles HTTPS automatically via Let's Encrypt if it can reach the internet on ports 80/443.

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

    client_max_body_size 0;  # uploads can be large

    location / {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # HLS video streaming holds connections open while segments generate
        proxy_read_timeout 60s;
        proxy_buffering off;
    }
}
```

## Traefik (Docker labels)

If you'd rather let Traefik discover Loom via Docker labels instead of a static config file, add these to the `loom-web` service in `compose.yml` (and remove the `ports:` mapping, since Traefik will reach it over the Docker network directly):

```yaml
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.loom.rule=Host(`loom.example.com`)"
      - "traefik.http.routers.loom.tls.certresolver=letsencrypt"
      - "traefik.http.services.loom.loadbalancer.server.port=3000"
```

## Cloudflare Tunnel

Useful if your server has no directly reachable public IP (common behind CGNAT / most residential ISPs). `cloudflared` runs as its own process/container and creates an outbound-only tunnel; pair it with a local reverse proxy (Caddy/nginx) as above rather than pointing it at the container port directly, so you keep normal proxy behavior (headers, timeouts) in one place.

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

## Large uploads and long-running requests

Two things worth checking regardless of which proxy you use:
- **No hard body-size limit** — uploads of large video files need `client_max_body_size 0;` (nginx) or the equivalent unlimited setting for your proxy.
- **Reasonable read/proxy timeouts** — HLS segment generation can take a few seconds for the first request to a given region of a video; a very short proxy timeout can cut that off. 60 seconds is a safe floor.
