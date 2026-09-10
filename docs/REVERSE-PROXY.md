# Reverse proxy

Loom binds to `127.0.0.1:$LOOM_PORT` on the host by default (see [Configuration](CONFIGURATION.md)). It's not meant to face the internet directly. Put a reverse proxy in front of it for HTTPS and a real hostname.

Whatever proxy you use, also set `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` in `.env` to the public URL, then run `docker compose up -d` again.

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

    client_max_body_size 0;  # uploads can be big

    location / {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # HLS streaming holds the connection open while segments are made
        proxy_read_timeout 60s;
        proxy_buffering off;
    }
}
```

## Traefik (Docker labels)

To have Traefik find Loom through Docker labels instead of a config file, add these to the `loom-web` service in `compose.yml`, and remove the `ports:` mapping since Traefik reaches it over the Docker network:

```yaml
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.loom.rule=Host(`loom.example.com`)"
      - "traefik.http.routers.loom.tls.certresolver=letsencrypt"
      - "traefik.http.services.loom.loadbalancer.server.port=3000"
```

## Cloudflare Tunnel

Handy if your server has no public IP you can reach (common with CGNAT and most home ISPs). `cloudflared` runs as its own process or container and makes an outbound-only tunnel. Point it at a local Caddy or nginx, not the container port, so proxy behavior (headers, timeouts) stays in one place.

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

Two things to check with any proxy:
- **No body size limit.** Large video uploads need `client_max_body_size 0;` in nginx, or the equivalent for your proxy.
- **Long enough timeouts.** The first request for a region of a video can take a few seconds while HLS segments are made. A very short proxy timeout cuts that off. 60 seconds is a safe minimum.
