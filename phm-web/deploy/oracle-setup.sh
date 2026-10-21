#!/usr/bin/env bash
# ============================================================
# deploy/oracle-setup.sh —— 在 Oracle Cloud 永久免费机器上把这个站跑起来
# ============================================================
# 适用：Ubuntu 22.04 / 24.04（ARM 或 x86 都行）
#
# 【为什么是本脚本，不是"点几下控制台"】
#   这台机器的用法和 PaaS 完全不同：你要对 Linux 负责。脚本把「Nginx 反代 +
#   systemd 常驻 + Let's Encrypt 证书 + 防火墙」这四件最容易漏的事一次做完，
#   并且**每一步都会打印它做了什么**，出问题时能自己往下查。
#
# 【它不会做的事】
#   · 不会替你在 Oracle 控制台创建实例（那要你的账号和信用卡）
#   · 不会替你改 Oracle 的 Security List（云侧防火墙，只能在控制台点）
#   · 不会写入 Neon 密码（你要么先放好 .env，要么脚本会提示你填）
#
# 【用法】
#   sudo bash oracle-setup.sh                     # 只跑服务，不配域名
#   sudo DOMAIN=phm.play bash oracle-setup.sh     # 顺便申请证书并配好域名
#
# ⚠ 跑之前请确认两件事：
#   ① Oracle 控制台的 Security List 已放行 80/443（否则下面第 6 步一定失败）
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
say "1/7 安装 Node 22、Nginx、Certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates nginx certbot python3-certbot-nginx git >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node -v) / npm $(npm -v)"

# ── 2) 运行账号与目录 ────────────────────────────────────────
say "2/7 建运行账号 ${APP_USER} 与目录 ${APP_DIR}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

# ── 3) 代码 ──────────────────────────────────────────────────
say "3/7 放代码（把 phm-web 的内容 scp 到 ${APP_DIR} 之后重跑本脚本）"
if [ ! -f "$APP_DIR/server.mjs" ]; then
  warn "${APP_DIR} 里还没有 server.mjs。"
  echo "  在**你的电脑**上执行（把 phm-web 整个目录传上去）："
  echo "    scp -r phm-web/* ubuntu@<公网IP>:${APP_DIR}/"
  echo "  传完再跑一次本脚本。"
  exit 1
fi
# node_modules 必须存在（pg 是运行期依赖）
if [ ! -d "$APP_DIR/node_modules" ]; then
  say "   缺 node_modules，就地安装（pg 是纯 JS，ARM 上不需要编译）"
  (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ── 4) 环境变量 ──────────────────────────────────────────────
say "4/7 检查 .env"
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

# ── 5) systemd ───────────────────────────────────────────────
say "5/7 写 systemd 单元（开机自启 + 挂了自动拉起）"
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
  && echo "  ✅ /api/health 通" \
  || warn "  本机 /api/health 不通，先看 journalctl -u phm -n 50"

# ── 6) 防火墙（Oracle 的两个坑都在这里）──────────────────────
say "6/7 放行 80/443"
# 坑一：Oracle 的 Ubuntu 镜像自带 iptables 规则，默认**只放行 22**，
#       云控制台的 Security List 放行了也没用 —— 必须本地也放。
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 6 -p tcp --dport $p -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null 2>&1 || true
  echo "  iptables 已放行 80/443（重启后由 netfilter-persistent 保留）"
fi
# 坑二：云侧的 Security List 只能在控制台改，脚本改不了
warn "别忘了在 Oracle 控制台 → 实例 → 子网 → Security List 里加 0.0.0.0/0 的 80/443 入站"

# ── 7) Nginx + 证书 ──────────────────────────────────────────
say "7/7 配置 Nginx 反代"
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
  ln -sf /etc/nginx/sites-available/phm /etc/nginx/sites-enabled/phm
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo "  Nginx 已指向 127.0.0.1:${PORT}"
  say "申请 HTTPS 证书（Let's Encrypt）"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect || \
    warn "证书失败：先确认 ${DOMAIN} 的 A 记录已指到本机公网 IP，且 80 端口能从外网访问"
else
  warn "没传 DOMAIN，只跑本机。要绑域名：sudo DOMAIN=phm.play bash oracle-setup.sh"
fi

say "完成"
echo "  本机： http://127.0.0.1:${PORT}"
[ -n "$DOMAIN" ] && echo "  公网： https://${DOMAIN}"
echo "  日志： journalctl -u phm -f"
echo "  重启： systemctl restart phm"
