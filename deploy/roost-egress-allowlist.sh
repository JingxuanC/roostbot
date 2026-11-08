#!/bin/sh
# Default-deny egress for Roost workspace containers on a Docker bridge.
# Run as root on the Docker host. Re-run to refresh DNS allowlist entries.
#
#   ROOST_EGRESS_SUBNET=172.30.0.0/16 \
#   ROOST_EGRESS_CP_HOST=172.17.43.89 \
#   ROOST_EGRESS_DOMAINS="api.deepseek.com" \
#     sh deploy/roost-egress-allowlist.sh
set -eu
SUBNET=${ROOST_EGRESS_SUBNET:-172.30.0.0/16}
CP_HOST=${ROOST_EGRESS_CP_HOST:-172.17.43.89}
CP_PORT=${ROOST_EGRESS_CP_PORT:-8787}
DOMAINS=${ROOST_EGRESS_DOMAINS:-api.deepseek.com}
CHAIN=ROOST-EGRESS

sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -t nat -C POSTROUTING -s "$SUBNET" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "$SUBNET" -j MASQUERADE

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$CHAIN" -d "$CP_HOST" -p tcp --dport "$CP_PORT" -j ACCEPT
# Docker's embedded DNS (127.0.0.11) and occasional HTTP(S) downloads are
# intentionally not opened. Add only model/control-plane endpoints below.
for domain in $DOMAINS; do
  for ip in $(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u); do
    case "$ip" in 0.0.0.0|127.*|169.254.*) continue ;; esac
    iptables -A "$CHAIN" -d "$ip" -p tcp --dport 443 -j ACCEPT
  done
done
iptables -A "$CHAIN" -j REJECT
# Attach at the head once; subsequent runs reuse the same jump.
iptables -C FORWARD -s "$SUBNET" -j "$CHAIN" 2>/dev/null \
  || iptables -I FORWARD 1 -s "$SUBNET" -j "$CHAIN"
echo "egress allowlist applied: subnet=$SUBNET cp=$CP_HOST:$CP_PORT domains=$DOMAINS"
iptables -S "$CHAIN"
