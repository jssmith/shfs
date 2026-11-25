# Reaching the drive: Cloudflare Tunnel

The VM opens no inbound ports. `cloudflared` on the VM makes an outbound
connection to Cloudflare, and Cloudflare forwards requests for the drive's
hostname down that connection to `http://localhost:8787`.

**Cloudflare terminates TLS.** Clients (claude.ai, ChatGPT, Claude Code, the
test clients) speak HTTPS to Cloudflare's edge, using a certificate Cloudflare
issues for your hostname. From the edge to the VM the traffic runs inside the
tunnel (encrypted), and the drive itself serves plain HTTP on localhost. So:

- the drive never holds a TLS certificate or key;
- Cloudflare can see request contents (MCP calls, OAuth codes and tokens) in
  the clear at its edge. Accepted for the development VM with synthetic data;
  revisit for the real drive (threat model);
- `AGENT_DRIVE_PUBLIC_URL` must be the `https://` address, because OAuth
  metadata and redirects are built from it, not from the local request.

## 1. First test, no domain: a quick tunnel

On the VM (over Session Manager), with the drive running:

```sh
cloudflared tunnel --no-autoupdate --url http://localhost:8787
# prints: https://<random-words>.trycloudflare.com
```

or, as a service: `systemctl start cloudflared-quick`, then
`journalctl -u cloudflared-quick | grep trycloudflare`.

Then set the address and restart the drive, since OAuth metadata names it:

```sh
sudo sed -i 's#^AGENT_DRIVE_PUBLIC_URL=.*#AGENT_DRIVE_PUBLIC_URL=https://<random-words>.trycloudflare.com#' /etc/agent-drive/agent-drive.env
sudo systemctl restart agent-drive
```

Quick tunnels get a new random address on every start, have no uptime
guarantee, and Cloudflare documents a limit of 200 in-flight requests and **no
Server-Sent Events** for them. MCP Streamable HTTP answers a POST either with
JSON or with an SSE stream; the SDK's server transport uses SSE unless
`enableJsonResponse: true` is set. So a quick tunnel is for checking the path
(health, OAuth metadata, sign-in); use the named tunnel for real MCP clients,
or run the server with JSON responses while on a quick tunnel.

## 2. Named tunnel on Johann's domain

Once, in the Cloudflare dashboard (the domain's DNS must be on Cloudflare):

1. **Zero Trust → Networks → Tunnels → Create a tunnel**, type *Cloudflared*,
   name `agent-drive-dev`.
2. On the install step, copy only the **token** (the long string after
   `--token`). Do not run the install command it shows; `setup.sh` already
   installed `cloudflared` and a unit for it.
3. **Public hostname**: subdomain `drive-dev`, domain `<your domain>`,
   service type `HTTP`, URL `localhost:8787`. Cloudflare creates the DNS
   record. Leave Access policies off for this hostname: OAuth is the drive's
   own, and MCP clients cannot pass a Cloudflare Access login.
4. Under the hostname's *Additional application settings → HTTP Settings*,
   leave *No Chunked Encoding* off (MCP streams responses).

On the VM, put the token in place without it touching the shell history or the
repository, then start the tunnel:

```sh
sudo install -m 0600 /dev/null /etc/cloudflared/agent-drive.token
sudo tee /etc/cloudflared/agent-drive.token > /dev/null   # paste the token, then Ctrl-D
sudo sed -i 's#^AGENT_DRIVE_PUBLIC_URL=.*#AGENT_DRIVE_PUBLIC_URL=https://drive-dev.<your-domain>#' /etc/agent-drive/agent-drive.env
sudo systemctl restart agent-drive
sudo systemctl enable --now cloudflared-agent-drive
```

Check from anywhere:

```sh
curl https://drive-dev.<your-domain>/healthz
curl https://drive-dev.<your-domain>/.well-known/oauth-authorization-server
```

and from this repository, the scripted client signs in and lists the tools:

```sh
node test/harness/client/run.ts --url https://drive-dev.<your-domain>/mcp --login browser
```

The MCP URL to give claude.ai, ChatGPT and Claude Code is
`https://drive-dev.<your-domain>/mcp`.

**Alternative:** a locally managed tunnel with ingress in a file instead of the
dashboard: see `config.example.yml`. Use one or the other, not both.

## Settings worth knowing

| Setting | Value | Why |
| --- | --- | --- |
| SSL/TLS mode for the zone | any; the origin is reached through the tunnel, not over the internet | Tunnel traffic does not use the zone's origin TLS setting |
| Always Use HTTPS | on | OAuth redirect URIs and metadata are `https://` |
| Bot Fight Mode / Super Bot Fight Mode | off for this hostname, or skip rules for `/mcp`, `/token`, `/register`, `/.well-known/*` | MCP clients are bots by definition; a challenge page breaks them |
| Caching | none: the drive sends `cache-control: no-store` on OAuth endpoints; add a Cache Rule "bypass" for the hostname to be sure | |
| Request timeout | 100 s on free plans for a response to *start*; streamed (SSE) responses keep going while data flows | Long tool calls should stream progress or return early (relevant to the approval wait in A1) |
