#!/usr/bin/env bash
# ============================================================
# deploy/vps-setup.sh —— 在任意一台 Ubuntu / Debian 机器上把这个站跑起来
# ============================================================
# 适用：Ubuntu 22.04 / 24.04、Debian 12（x86 或 ARM 都行）
# 用过的地方：雨云免费 VPS、Oracle Cloud 免费实例
#
# 【为什么是本脚本，不是"点几下控制台"】
#   自己买机器和用 PaaS 完全不同：你要对 Linux 负责。脚本把「开机自启 +
#   Nginx 反代 + 防火墙 + 小内存机器的 swap」这四件最容易漏的事一次做完，
#   并且**每一步都打印它做了什么**，出问题时能自己往下查。
#
# 【它不会做的事】
#   · 不会替你在厂商控制台创建实例（那要你的账号）
#   · 不会替你改云侧安全组（只能在控制台点）
#   · 不会写入 Neon 密码（你要么先放好 .env，要么脚本会提示你填）
#
# 【用法】
#   sudo bash vps-setup.sh                      # 不要域名，用 http://公网IP 直接访问
#   sudo DOMAIN=phm.example.com bash vps-setup.sh   # 顺便申请 HTTPS 证书
#
# ⚠ 没有域名也能正常跑。**大陆机器 + 不绑域名是不需要备案的**，
#   直接用 IP 访问即可；只有「域名指向大陆服务器」才要 ICP 备案。
#
# ⚠ 跑之前请确认：
#   ① 厂商控制台的安全组已放行 80（有域名的话再加 443）
#   ② 你手里有 Neon 的**直连**连接串（host 不带 -pooler）
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/phm}"
APP_USER="${APP_USER:-phm}"
PORT="${PORT:-8080}"
DOMAIN="${DOMAIN:-}"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 跑"; exit 1; }

# ── 1) 系统依赖 ──────────────────────────────────────────────
say "1/7 安装 Node 22、Nginx（有域名才装 Certbot）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates nginx git >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node -v) / npm $(npm -v)"

# ── 2) swap（小内存机器必需）────────────────────────────────
say "2/7 检查内存与 swap"
MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
echo "  内存 ${MEM_MB}MB"
if [ "$MEM_MB" -lt 2000 ] && [ ! -f /swapfile ]; then
  # 1GB 内存的机器上 Node + Nginx 够用，但**谱面分析是 CPU/内存双吃的**，
  # 一旦并发两张就可能被 OOM Killer 干掉，而且是静默重启（systemd 会拉起，
  # 用户只看到"偶尔 502"）。加 1G swap 是最便宜的保险。
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "  已加 1G swap（并在 /etc/fstab 里持久化）"
else
  echo "  跳过（内存够或已有 swap）"
fi

# ── 3) 运行账号与目录 ────────────────────────────────────────
say "3/7 建运行账号 ${APP_USER} 与目录 ${APP_DIR}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

# ── 4) 代码 ──────────────────────────────────────────────────
say "4/7 放代码"
if [ ! -f "$APP_DIR/server.mjs" ]; then
  warn "${APP_DIR} 里还没有 server.mjs。"
  echo "  在**你的电脑**上执行（把 phm-web 整个目录传上去）："
  echo "    scp -r phm-web/* root@<公网IP>:${APP_DIR}/"
  echo "  传完再跑一次本脚本。"
  exit 1
fi
if [ ! -d "$APP_DIR/node_modules" ]; then
  say "   缺 node_modules，就地安装（pg 是纯 JS，ARM 上不需要编译）"
  (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ── 5) 环境变量 ──────────────────────────────────────────────
say "5/7 检查 .env"
if [ ! -f "$APP_DIR/.env" ]; then
  warn "${APP_DIR}/.env 不存在。最少需要这两行："
  echo "    PHM_NEON_URL=postgresql://…（**直连**，host 不带 -pooler）"
  echo "    PHM_STATIC_ONLY=0     ← 关键：仓库里带 .static-only 标记，不写这行就是静态指路牌"
  echo "  填好后再跑一次本脚本。"
  exit 1
fi
grep -q '^PHM_NEON_URL=' "$APP_DIR/.env" || { warn ".env 里没有 PHM_NEON_URL"; exit 1; }
grep -q '^PHM_STATIC_ONLY=0' "$APP_DIR/.env" || {
  warn ".env 里没有 PHM_STATIC_ONLY=0 —— 会部署成静态指路牌（账号/成绩/API 全 410）"
  echo "  要全功能站就加上这一行。"
  exit 1
}
chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ── 6) systemd ───────────────────────────────────────────────
say "6/7 写 systemd 单元（开机自启 + 挂了自动拉起）"
cat >/etc/systemd/system/phm.service <<UNIT
[Unit]
Description=P.H.M. Standard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=PORT=${PORT}
ExecStart=/usr/bin/node ${APP_DIR}/server.mjs
Restart=always
RestartSec=3
# Neon 会空闲缩到零，唤醒可能要十几秒 —— 别让 systemd 以为它挂了
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now phm >/dev/null
sleep 3
systemctl is-active --quiet phm || { warn "服务没起来，看日志：journalctl -u phm -n 50 --no-pager"; exit 1; }
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null \
  && echo "  ✅ 本机 /api/health 通" \
  || warn "  本机 /api/health 不通，先看 journalctl -u phm -n 50"

# ── 7) Nginx ─────────────────────────────────────────────────
say "7/7 配置 Nginx"
if [ -n "$DOMAIN" ]; then
  cat >/etc/nginx/sites-available/phm <<NGINX
server {
  listen 80;
  server_name ${DOMAIN};
  client_max_body_size 32m;     # 谱面 zip 可能不小
  location / {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;    # 分析接口慢，别 60s 就掐
  }
}
NGINX
  rm -f /etc/nginx/sites-enabled/default
else
  # 没域名：接管 80 端口当默认站点，直接 http://公网IP 访问。
  # 这样地址里没有 :8080，看起来正常，也不用备案。
  cat >/etc/nginx/sites-available/phm <<NGINX
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  client_max_body_size 32m;
  location / {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }
}
NGINX
  rm -f /etc/nginx/sites-enabled/default
fi
ln -sf /etc/nginx/sites-available/phm /etc/nginx/sites-enabled/phm
nginx -t && systemctl reload nginx
echo "  Nginx 已指向 127.0.0.1:${PORT}"

if [ -n "$DOMAIN" ]; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  say "申请 HTTPS 证书（Let's Encrypt）"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect || \
    warn "证书失败：先确认 ${DOMAIN} 的 A 记录已指到本机公网 IP，且 80 端口能从外网访问"
else
  warn "没有域名，用 http://公网IP 访问。想要 HTTPS 和好记的地址，再买域名 + 备案。"
fi

# ── 收尾 ─────────────────────────────────────────────────────
PUBIP=$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '<公网IP>')
say "完成"
echo "  访问：  http://${PUBIP}/            （有域名则是 https://${DOMAIN}）"
echo "  本机：  http://127.0.0.1:${PORT}"
echo "  日志：  journalctl -u phm -f"
echo "  重启：  systemctl restart phm"
echo ""
warn "如果浏览器打不开，先查厂商控制台的**安全组**是否放行 80（云侧防火墙，脚本改不了）"
