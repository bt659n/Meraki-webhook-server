#!/usr/bin/env bash

# Exit on any error
set -e

# Configuration
# 1. Auto-create deploy.env from template if missing
if [ ! -f "deploy.env" ] && [ -f "deploy.env.example" ]; then
    cp deploy.env.example deploy.env
    echo -e "\033[1;33mCreated 'deploy.env' from template. Please configure it for future deployments.\033[0m"
fi

# 2. Load local configuration if present
if [ -f "deploy.env" ]; then
    export $(grep -v '^#' deploy.env | xargs)
fi

HOST="${DEPLOY_HOST:-}"
USER="${DEPLOY_USER:-ubuntu}"
KEY="${DEPLOY_KEY:-Oracle-Ubuntu-24_copy.key}"
REMOTE_DIR="/home/ubuntu/meraki-webhook-server"
TARBALL="meraki_webhook_project.tar.gz"

# 3. Prompt if IP is not set, and save it to deploy.env automatically
if [ -z "$HOST" ]; then
    echo -e "\033[1;33mWarning: Target server host IP not set in deploy.env.\033[0m"
    read -p "Please enter the target server IP address: " HOST
    
    if [ -f "deploy.env" ]; then
        # Check if DEPLOY_HOST line exists and replace it, or append
        if grep -q "DEPLOY_HOST=" deploy.env; then
            # Support both macOS (needs '') and Linux sed syntaxes
            sed -i '' "s/DEPLOY_HOST=.*/DEPLOY_HOST=$HOST/" deploy.env 2>/dev/null || sed -i "s/DEPLOY_HOST=.*/DEPLOY_HOST=$HOST/" deploy.env
        else
            echo "DEPLOY_HOST=$HOST" >> deploy.env
        fi
        echo -e "\033[0;32m✓ IP address saved to deploy.env for future runs.\033[0m"
    fi
fi

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}===================================================${NC}"
echo -e "${BLUE}    Meraki Webhook Server - Remote Deployer       ${NC}"
echo -e "${BLUE}===================================================${NC}"

# 1. Check local key file
if [ ! -f "$KEY" ]; then
    echo -e "${RED}Error: Key file '$KEY' not found in current directory!${NC}"
    exit 1
fi

# 2. Fix key permissions
echo -e "${BLUE}[1/6] Securing private key permissions...${NC}"
chmod 600 "$KEY"
echo -e "${GREEN}✓ Key file permissions set to 600.${NC}"

# 3. Test connection & check Docker
echo -e "${BLUE}[2/6] Connecting to target Oracle host (${HOST})...${NC}"
ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$USER@$HOST" "echo 'Connection successful!'" || {
    echo -e "${RED}Error: Cannot connect to $HOST via SSH.${NC}"
    echo -e "Please verify your network connection and target IP address."
    exit 1
}

echo -e "${BLUE}Checking Docker installation on host...${NC}"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$USER@$HOST" "docker --version && docker compose version" || {
    echo -e "${YELLOW}Warning: Docker or Docker Compose was not found or failed to report version.${NC}"
    echo -e "Attempting to install docker and docker-compose-plugin automatically..."
    ssh -i "$KEY" -o StrictHostKeyChecking=no "$USER@$HOST" "sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2" || {
        echo -e "${RED}Error: Failed to install Docker on the host. Please install Docker manually first.${NC}"
        exit 1
    }
}
echo -e "${GREEN}✓ Target host environment validation completed.${NC}"

# 4. Pack project files locally
echo -e "${BLUE}[3/6] Packaging project files...${NC}"
tar -czf "$TARBALL" app.py requirements.txt Dockerfile docker-compose.yml templates static
echo -e "${GREEN}✓ Project files archived in $TARBALL.${NC}"

# 5. Upload files to host
echo -e "${BLUE}[4/6] Transferring project to host...${NC}"
# Create remote directory if not exists
ssh -i "$KEY" -o StrictHostKeyChecking=no "$USER@$HOST" "mkdir -p $REMOTE_DIR"
# Upload
scp -i "$KEY" -o StrictHostKeyChecking=no "$TARBALL" "$USER@$HOST:$REMOTE_DIR/"
echo -e "${GREEN}✓ Transfer complete.${NC}"

# 6. Extract project files on host
echo -e "${BLUE}[5/6] Unpacking project files on host...${NC}"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$USER@$HOST" "tar -xzf $REMOTE_DIR/$TARBALL -C $REMOTE_DIR/ && rm $REMOTE_DIR/$TARBALL"
# Clean up local tarball
rm "$TARBALL"
echo -e "${GREEN}✓ Files unpacked in $REMOTE_DIR.${NC}"

# 7. Start container on host
echo -e "${BLUE}[6/6] Launching Docker container on host...${NC}"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$USER@$HOST" "cd $REMOTE_DIR && sudo docker compose down --remove-orphans && sudo docker compose up -d --build"
echo -e "${GREEN}✓ Docker Compose project built and running in detached mode!${NC}"

# Print Final Instructions
echo -e "\n${GREEN}===================================================${NC}"
echo -e "${GREEN}         DEPLOYMENT SUCCESSFUL!                    ${NC}"
echo -e "${GREEN}===================================================${NC}"
echo -e "Your Meraki Webhook Server is now running on the host."
echo -e "Local Address: ${BLUE}http://127.0.0.1:8000${NC} (inside the host)"
echo -e "Public Port: ${BLUE}http://${HOST}:8000${NC}\n"

echo -e "${YELLOW}Next Steps:${NC}"
echo -e "1. ${YELLOW}Cloudflare Tunnel Setup:${NC}"
echo -e "   Since you have a tunnel, configure it in Cloudflare to route your domain"
echo -e "   (e.g., webhook.yourdomain.com) to ${BLUE}http://localhost:8000${NC} on this host."
echo -e "2. ${YELLOW}1Panel Visibility:${NC}"
echo -e "   Log in to your 1Panel dashboard. Go to 'Containers' or 'Docker'."
echo -e "   You will see ${BLUE}meraki-webhook-server${NC} listed as running. You can view its logs,"
echo -e "   restart status, and metrics directly inside 1Panel!"
echo -e "3. ${YELLOW}Configure Meraki Webhook:${NC}"
echo -e "   - Go to Meraki Dashboard -> Organization -> Configure -> API & Webhooks."
echo -e "   - Add a Webhook Receiver."
echo -e "   - URL: ${BLUE}https://your-cloudflare-domain.com/webhook${NC}"
echo -e "   - Shared secret: ${BLUE}meraki_secret${NC} (configurable in ${BLUE}docker-compose.yml${NC})"
echo -e "   - Click 'Send test' to verify. The alert will pop up instantly on your live web monitor!"
echo -e "4. ${YELLOW}Access Web Dashboard:${NC}"
echo -e "   - URL: ${BLUE}https://your-cloudflare-domain.com${NC}"
echo -e "   - Password: ${BLUE}admin${NC} (configurable in ${BLUE}docker-compose.yml${NC})"
echo -e "==================================================="
