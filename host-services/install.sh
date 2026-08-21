#!/usr/bin/env bash
# Loom Mount Service — Installation Script
# Run as root or with sudo: sudo bash install.sh
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: This script must be run as root."
  exit 1
fi

# Create config directory
mkdir -p /etc/loom
chmod 700 /etc/loom

# Create env file if it doesn't exist
ENV_FILE="/etc/loom/mount-service.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'EOF'
# Loom Mount Service environment
# REQUIRED: Must match MOUNT_SERVICE_SECRET in /srv/apps/loom/.env
MOUNT_SERVICE_SECRET=change_this_to_match_your_dot_env

# REQUIRED: The device path of your Samsung T7 (e.g. /dev/sdb1)
# Find it with: lsblk -f
T7_DEVICE=/dev/sdb1

# OPTIONAL: Mount point (default is below)
T7_MOUNT_POINT=/srv/storage/personal/media
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE — EDIT THIS FILE before starting the service."
  echo "  Set MOUNT_SERVICE_SECRET to match your .env"
  echo "  Set T7_DEVICE to your Samsung T7 device path (check: lsblk -f)"
fi

# Copy service file
cp /srv/apps/loom/host-services/loom-mount.service /etc/systemd/system/loom-mount.service

# Reload systemd
systemctl daemon-reload
systemctl enable loom-mount.service

echo ""
echo "=== Loom Mount Service installed ==="
echo "NEXT STEPS:"
echo "  1. Edit /etc/loom/mount-service.env and set your secrets."
echo "  2. Run: sudo systemctl start loom-mount"
echo "  3. Check: sudo systemctl status loom-mount"
