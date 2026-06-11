# Cisco Meraki Webhook Server & Live Monitor

A lightweight, modern, and open-source Cisco Meraki Webhook receiver and real-time dashboard. This application allows you to monitor and inspect Meraki dashboard alerts (such as port changes, device status, VPN events, config updates) instantly as they happen.

---

## 🌟 Features

* **FastAPI Backend**: Asynchronous and high-performance Python backend.
* **Real-time Event Feed**: Instantly pushes incoming webhooks to the browser using Server-Sent Events (SSE), eliminating the need for periodic API polling.
* **Persistent History**: Keeps the last 1,000 webhook alerts stored in a lightweight local SQLite database (`webhooks.db`) so logs survive container restarts.
* **Modern Dashboard (Glassmorphism)**: Dark mode responsive UI built with vanilla HTML/CSS/JS. It includes live stats counters, alert filtering, and search options.
* **JSON Syntax Highlighting**: A built-in code inspector formats and colorizes raw JSON payloads.
* **1Panel Compatibility**: Deployable via Docker Compose, making it immediately visible and manageable inside your **1Panel** container manager.
* **Bypass-Ready Cloudflare Configuration**: Fully compatible with Cloudflare Tunnel (no SSL setup needed on the host).

---

## 🛠️ Architecture & Working Principle

```
┌─────────────────┐             ┌─────────────────────┐
│  Cisco Meraki   │    POST     │   FastAPI Server    │
│    Dashboard    │ ──────────> │      /webhook       │
└─────────────────┘             └──────────┬──────────┘
                                           │
                                ┌──────────┴──────────┐
                   Save Log     │  Broadcast to SSE   │
                 ┌────────────> │  /api/events/sse    │
                 │              └──────────┬──────────┘
                 ▼                         │
          ┌──────────────┐                 │  Push Events
          │    SQLite    │                 ▼
          │ (webhooks.db)│      ┌─────────────────────┐
          └──────────────┘      │   HTML Dashboard    │
                                │   (Browser UI)      │
                                └─────────────────────┘
```

1. **Ingestion (`/webhook` POST)**: The Meraki dashboard sends HTTP POST requests containing JSON payloads to the `/webhook` endpoint.
2. **Persistence**: The server extracts metadata (alert type, network name, device serial, timestamp) and saves the raw payload into a local SQLite database, automatically pruning logs older than the latest 1,000 entries.
3. **Broadcasting (SSE)**: The server pushes new logs to connected browser clients via a persistent connection to `/api/events/sse` using HTML5 `EventSource`.

### Cloudflare Tunnel & Proxy Buffering
Standard reverse proxies (like Cloudflare Tunnel or Nginx) buffer response streams by default. For a real-time Server-Sent Events (SSE) connection, this would cause the stream to hang, keeping the UI stuck in a `"Connecting..."` loop. 
To bypass this buffering, the backend sets specific anti-buffering headers on the SSE response stream:
* `X-Accel-Buffering: no`
* `Cache-Control: no-cache`
* `Connection: keep-alive`

---

## 🚀 Deployment Instructions

### Local Prerequisites & Setup
1. Place your target SSH private key `Oracle-Ubuntu-24_copy.key` in the project root directory.
2. Ensure you have standard `ssh` and `tar` commands installed locally.

### Local Configuration (`deploy.env`)
The deployment script uses a local configuration file `deploy.env` to store your server settings privately. This file is ignored by Git and will never be pushed to GitHub:
* **Automatic Setup**: On your first run, `deploy.sh` will automatically create `deploy.env` from the template.
* **Auto-Save**: If the server IP is not set, the script will ask you to enter it in your terminal, and then **automatically write and save it** to your local `deploy.env` so you do not have to type it again in future runs.
* **Manual Setup**: You can manually copy the template and configure it:
  ```bash
  cp deploy.env.example deploy.env
  ```
  Then fill in your host IP (`DEPLOY_HOST`), user (`DEPLOY_USER`), and key filename (`DEPLOY_KEY`).

### Deploying (or Re-deploying)
To package, upload, and run the server on the remote host, simply execute the script:
```bash
bash deploy.sh
```
The script will secure SSH key permissions, compress assets, transfer them to the Oracle host, unpack them, and boot up the container under Docker Compose.

---

## ⚙️ Changing Server Configuration & IP

### 1. Changing the Server Host IP
If your Oracle host IP changes (e.g. you redeploy or change VM interfaces):
1. Open [deploy.sh](file:///Users/bo_tang/Documents/Meraki-webhook-server/deploy.sh).
2. Update the `HOST="your-new-ip"` variable at the top.
3. Run `bash deploy.sh` again to deploy to the new host.
4. **Cloudflare Tunnel Routing**: If your tunnel runs locally on the server (mapping local port `8000`), you only need to run the tunnel connector client on the new server. No Cloudflare domain routing updates are needed, as Cloudflare still resolves the tunnel connector to `localhost:8000`.

### 2. Enabling Webhook Validation & Password Protection (Security)
By default, the server is configured in **open test mode** (no dashboard password, no shared secret checks). If you want to secure the application:
1. Open [docker-compose.yml](file:///Users/bo_tang/Documents/Meraki-webhook-server/docker-compose.yml).
2. Configure the values under environment variables:
   ```yaml
   environment:
     # Add your Meraki Webhook Shared Secret
     - SHARED_SECRET=your_meraki_secret_here
     
     # Add a password to lock the dashboard interface
     - DASHBOARD_PASSWORD=your_secure_password
   ```
3. Run `bash deploy.sh` to apply the updates.
4. *Note: If a password is set, the dashboard will display a lock screen. Enter your password to authenticate. The browser will store a session token in `localStorage`.*

---

## 📌 Meraki Dashboard Setup Checklist

When registering the receiver in the Meraki Dashboard (**Organization > Configure > API & Webhooks**):
1. **Name**: `Oracle VM` (or any label).
2. **URL**: Must point to the `/webhook` path:
   ```text
   https://webhook-oracle.bt-node.com/webhook
   ```
3. **Payload Template**: Keep the default `Meraki (included)`.
4. **Shared Secret**: Set it to match the `SHARED_SECRET` environment variable in your `docker-compose.yml` (leave empty in Meraki if the server environment variable is empty).
5. Click **Save** and select **Send test**.

---

## 🔍 Troubleshooting

* **Dashboard stuck on "Connecting..."**:
  Ensure you perform a **hard refresh** (`Cmd + Shift + R` on Mac, `Ctrl + F5` on Windows) to clear any cached JavaScript. Ensure no browser adblockers or browser security extensions are blocking EventSource connections.
* **Meraki Webhook Tests Fail**:
  Verify that your Meraki URL ends with `/webhook`. If you send it to `https://webhook-oracle.bt-node.com/`, the server returns an HTTP 405/404 because the root URL does not accept POST requests.
