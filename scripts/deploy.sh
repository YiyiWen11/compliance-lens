#!/bin/bash
# 合规透镜部署脚本 v0.4.0
# 用法: sudo bash deploy.sh

set -e

echo "========================================"
echo "  合规透镜 Compliance Lens 部署脚本"
echo "  版本: v0.4.0"
echo "========================================"
echo

# 配置
DEPLOY_DIR="/opt/compliance-lens"
WWW_DIR="/var/www/compliance-lens"
PROXY_PORT=3000
NODE_VERSION="20"

echo "[1/8] 检查系统环境..."
if ! command -v nginx &> /dev/null; then
    echo "  ⚠️  Nginx 未安装，正在安装..."
    apt-get update -qq
    apt-get install -y -qq nginx
    echo "  ✅ Nginx 安装完成"
else
    echo "  ✅ Nginx 已安装"
fi

if ! command -v node &> /dev/null; then
    echo "  ⚠️  Node.js 未安装，正在安装..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs
    echo "  ✅ Node.js $(node -v) 安装完成"
else
    echo "  ✅ Node.js $(node -v) 已安装"
fi

if ! command -v pm2 &> /dev/null; then
    echo "  ⚠️  PM2 未安装，正在安装..."
    npm install -g pm2 --silent
    echo "  ✅ PM2 安装完成"
else
    echo "  ✅ PM2 已安装"
fi

echo
echo "[2/8] 创建部署目录..."
mkdir -p ${DEPLOY_DIR}
mkdir -p ${WWW_DIR}
echo "  ✅ 目录创建完成"

echo
echo "[3/8] 复制后端代理文件..."
# 假设当前目录有 proxy.js 和 package.json
cp proxy.js ${DEPLOY_DIR}/
cp package.json ${DEPLOY_DIR}/
cd ${DEPLOY_DIR}
npm install --silent
echo "  ✅ 后端代理依赖安装完成"

echo
echo "[4/8] 复制前端文件..."
cp index.html ${WWW_DIR}/
cp styles.css ${WWW_DIR}/
mkdir -p ${WWW_DIR}/public
cp -r public/* ${WWW_DIR}/public/
echo "  ✅ 前端文件复制完成"

echo
echo "[5/8] 设置 DeepSeek API Key..."
if [ -z "$DEEPSEEK_API_KEY" ]; then
    echo "  ⚠️  未检测到 DEEPSEEK_API_KEY 环境变量"
    read -p "  请输入你的 DeepSeek API Key: " API_KEY
    export DEEPSEEK_API_KEY="$API_KEY"
fi

# 写入 systemd 服务文件（持久化环境变量）
cat > /etc/systemd/system/compliance-lens-proxy.service << 'EOF'
[Unit]
Description=Compliance Lens Backend Proxy
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/compliance-lens
Environment="DEEPSEEK_API_KEY=REPLACE_ME"
ExecStart=/usr/bin/node /opt/compliance-lens/proxy.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 替换 API Key
sed -i "s|REPLACE_ME|$DEEPSEEK_API_KEY|g" /etc/systemd/system/compliance-lens-proxy.service
systemctl daemon-reload
echo "  ✅ 环境变量配置完成"

echo
echo "[6/8] 配置 Nginx..."
cat > /etc/nginx/sites-available/compliance-lens << EOF
server {
    listen 80;
    server_name _;

    # 前端静态文件
    location / {
        root ${WWW_DIR};
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }

    # 后端代理（隐藏 API Key）
    location /api/ {
        proxy_pass http://127.0.0.1:${PROXY_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # 健康检查
    location /health {
        proxy_pass http://127.0.0.1:${PROXY_PORT}/health;
    }
}
EOF

# 启用站点
ln -sf /etc/nginx/sites-available/compliance-lens /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t
echo "  ✅ Nginx 配置完成"

echo
echo "[7/8] 启动服务..."
systemctl enable compliance-lens-proxy
systemctl restart compliance-lens-proxy
systemctl restart nginx
echo "  ✅ 服务启动完成"

echo
echo "[8/8] 验证部署..."
sleep 2

# 检查后端代理
if curl -s http://127.0.0.1:${PROXY_PORT}/health | grep -q "ok"; then
    echo "  ✅ 后端代理运行正常"
else
    echo "  ❌ 后端代理启动失败，查看日志: journalctl -u compliance-lens-proxy -n 50"
fi

# 检查 Nginx
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/ | grep -q "200\|304"; then
    echo "  ✅ Nginx 运行正常"
else
    echo "  ❌ Nginx 启动失败，查看日志: nginx -t"
fi

echo
echo "========================================"
echo "  🎉 部署完成！"
echo "========================================"
echo
echo "访问地址:"
echo "  • 网站首页: http://124.221.3.7/"
echo "  • 健康检查: http://124.221.3.7/health"
echo
echo "常用命令:"
echo "  查看后端日志: journalctl -u compliance-lens-proxy -f"
echo "  重启后端:     systemctl restart compliance-lens-proxy"
echo "  重启 Nginx:   systemctl restart nginx"
echo "  查看 Nginx 日志: tail -f /var/log/nginx/access.log"
echo
echo "如果需要配置域名，修改:"
echo "  /etc/nginx/sites-available/compliance-lens"
echo
echo "========================================"
