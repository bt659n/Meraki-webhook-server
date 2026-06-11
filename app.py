import os
import json
import sqlite3
import asyncio
import hashlib
from typing import Optional, List
from fastapi import FastAPI, Request, Response, HTTPException, Depends, Query, status
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Meraki Webhook Server", version="1.0")

# Configurations from environment variables
SHARED_SECRET = os.environ.get("SHARED_SECRET", "")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
DB_PATH = os.environ.get("DB_PATH", "/data/webhooks.db")

# Ensure database directory exists
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

# Generate expected session token if password is set
EXPECTED_TOKEN = hashlib.sha256(DASHBOARD_PASSWORD.encode()).hexdigest() if DASHBOARD_PASSWORD else ""

# SSE clients list (holds asyncio.Queue objects)
sse_clients: List[asyncio.Queue] = []

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS webhooks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
            occurred_at TEXT,
            alert_type TEXT,
            network_name TEXT,
            device_name TEXT,
            device_serial TEXT,
            raw_payload TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

def save_webhook(occurred_at: str, alert_type: str, network_name: str, device_name: str, device_serial: str, raw_payload: str):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO webhooks (occurred_at, alert_type, network_name, device_name, device_serial, raw_payload)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (occurred_at, alert_type, network_name, device_name, device_serial, raw_payload))
    
    # Keep database size capped to latest 1000 items
    cursor.execute("""
        DELETE FROM webhooks WHERE id NOT IN (
            SELECT id FROM webhooks ORDER BY id DESC LIMIT 1000
        )
    """)
    conn.commit()
    conn.close()

def get_webhooks_from_db(limit: int = 100):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, timestamp, occurred_at, alert_type, network_name, device_name, device_serial, raw_payload 
        FROM webhooks 
        ORDER BY id DESC 
        LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

# Authentication helper
def verify_token(token: Optional[str] = None):
    if not DASHBOARD_PASSWORD:
        return True
    if not token or token != EXPECTED_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing dashboard token"
        )
    return True

# Dependable function to get token from header or query param
def get_auth_token(request: Request, token: Optional[str] = Query(None)):
    if token:
        return token
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header.split(" ")[1]
    return None

class AuthRequest(BaseModel):
    password: str

@app.post("/api/auth")
async def login(auth: AuthRequest):
    if not DASHBOARD_PASSWORD:
        return {"authenticated": True, "token": ""}
    
    if auth.password == DASHBOARD_PASSWORD:
        return {"authenticated": True, "token": EXPECTED_TOKEN}
    else:
        raise HTTPException(status_code=401, detail="Incorrect password")

@app.get("/api/auth/status")
async def auth_status(token: Optional[str] = Depends(get_auth_token)):
    is_required = bool(DASHBOARD_PASSWORD)
    is_valid = False
    if not is_required:
        is_valid = True
    elif token and token == EXPECTED_TOKEN:
        is_valid = True
    return {"required": is_required, "valid": is_valid}

@app.post("/webhook")
async def receive_webhook(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")
    
    # 1. Validate Shared Secret if configured
    if SHARED_SECRET:
        incoming_secret = payload.get("sharedSecret")
        if incoming_secret != SHARED_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized: Shared Secret mismatch")
            
    # 2. Extract key fields
    occurred_at = payload.get("occurredAt", payload.get("sentAt", ""))
    alert_type = payload.get("alertType", "Unknown Alert")
    network_name = payload.get("networkName", "N/A")
    device_name = payload.get("deviceName", "N/A")
    device_serial = payload.get("deviceSerial", "N/A")
    raw_payload_str = json.dumps(payload)
    
    # 3. Save to database
    save_webhook(occurred_at, alert_type, network_name, device_name, device_serial, raw_payload_str)
    
    # 4. Broadcast to all active SSE dashboard clients
    event_data = {
        "occurred_at": occurred_at,
        "alert_type": alert_type,
        "network_name": network_name,
        "device_name": device_name,
        "device_serial": device_serial,
        "raw_payload": raw_payload_str
    }
    
    # Broadcast asynchronously
    for queue in sse_clients:
        await queue.put(json.dumps(event_data))
        
    return Response(content="Webhook processed successfully", media_type="text/plain", status_code=200)

@app.get("/api/events")
async def get_events(limit: int = 100, token: Optional[str] = Depends(get_auth_token)):
    verify_token(token)
    return get_webhooks_from_db(limit)

@app.get("/api/events/sse")
async def sse_endpoint(token: Optional[str] = Depends(get_auth_token)):
    # Verify authentication for SSE stream
    try:
        verify_token(token)
    except HTTPException:
        raise HTTPException(status_code=401, detail="Unauthorized")
        
    async def event_generator():
        queue = asyncio.Queue()
        sse_clients.append(queue)
        try:
            # Send initial keep-alive
            yield "data: {\"type\": \"connected\"}\n\n"
            while True:
                data = await queue.get()
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            sse_clients.remove(queue)
            
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

# Serve Frontend SPA
@app.get("/", response_class=HTMLResponse)
async def serve_dashboard():
    # We will read and serve index.html directly
    html_file = os.path.join(os.path.dirname(__file__), "templates", "index.html")
    if os.path.exists(html_file):
        with open(html_file, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse(content="<h1>Dashboard index.html not found!</h1>", status_code=404)

# Mount static folder for JS/CSS
app.mount("/static", StaticFiles(directory="static"), name="static")
