#!/usr/bin/env bash
set -e

echo "🚀 [1/4] 安装系统级依赖 (ffmpeg, nodejs, python3)..."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    curl git ffmpeg python3 python3-pip python3-venv build-essential

if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

INSTALL_DIR="/opt/napcat-agent"
mkdir -p "$INSTALL_DIR"
cp -r napcat-douyin-bot "$INSTALL_DIR/"
cp -r rag-memory-server "$INSTALL_DIR/"

echo "🧠 [2/4] 配置 RAG 记忆检索服务..."
cd "$INSTALL_DIR/rag-memory-server"
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
if [ ! -f .env ]; then cp .env.example .env; fi

echo "🤖 [3/4] 初始化 NapCat 交互插件..."
cd "$INSTALL_DIR/napcat-douyin-bot"
if [ ! -f bot_data.json ]; then cp bot_data.json.template bot_data.json; fi

echo "⚙️ [4/4] 注册 Systemd 守护进程..."
cat <<EOF > /etc/systemd/system/rag-memory-server.service
[Unit]
Description=RAG Memory Inverted Index Persona Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/rag-memory-server
ExecStart=$INSTALL_DIR/rag-memory-server/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8765
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat <<EOF > /etc/systemd/system/napcat-agent-bot.service
[Unit]
Description=NapCat Persona Agent Plugin Service
After=network.target rag-memory-server.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/napcat-douyin-bot
ExecStart=/usr/bin/node bot.mjs
Restart=always
RestartSec=3
Environment=ONEBOT_WS_URL=ws://127.0.0.1:3001
Environment=ONEBOT_HTTP_URL=http://127.0.0.1:3002

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now rag-memory-server.service
systemctl enable --now napcat-agent-bot.service

echo "🎉 部署完成！"
