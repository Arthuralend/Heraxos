#!/bin/bash
# Установка Heraxos на Ubuntu/Debian. Запуск: sudo bash install.sh
set -e
IP=82.26.86.235
DOMAIN=${DOMAIN:-82-26-86-235.sslip.io}   # бесплатный домен на ваш IP; можно задать свой: DOMAIN=call.example.com bash install.sh
PORT=${PORT:-8445}
DIR=/opt/heraxos

echo "== Пакеты"
apt-get update -qq
apt-get install -y -qq curl coturn certbot >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null; apt-get install -y -qq nodejs >/dev/null
fi

echo "== Переход со «Звонков» (если были установлены)"
if systemctl list-unit-files | grep -q '^zvonki.service'; then systemctl disable --now zvonki >/dev/null 2>&1 || true; rm -f /etc/systemd/system/zvonki.service /etc/letsencrypt/renewal-hooks/deploy/zvonki.sh; [ -f /opt/zvonki/.env ] && [ ! -f $DIR/.env ] && mkdir -p $DIR && grep -v '^ADMIN' /opt/zvonki/.env > $DIR/.env; systemctl stop coturn 2>/dev/null || true; fi

systemctl stop heraxos coturn 2>/dev/null || true
echo "== Проверка портов"
for p in $PORT 3478 5349; do ss -lntu | grep -q ":$p " && { echo "Порт $p занят! Задайте другой PORT=..."; exit 1; }; done

echo "== Файлы"
mkdir -p $DIR; cp -r server.js package.json public $DIR/
cd $DIR && npm install --omit=dev --silent

echo "== SSL-сертификат для $DOMAIN"
if [ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  if ss -lnt | grep -q ':80 '; then
    echo "Порт 80 занят — временно останавливаю то, что на нём, нельзя автоматически."
    echo "Освободите порт 80 на минуту или выпустите сертификат вручную: certbot certonly --webroot ..."; exit 1
  fi
  certbot certonly --standalone -d $DOMAIN --agree-tos --register-unsafely-without-email -n
fi
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
KEY=/etc/letsencrypt/live/$DOMAIN/privkey.pem

echo "== Конфиг"
if [ ! -f $DIR/.env ]; then
  cat > $DIR/.env <<E
PORT=$PORT
DOMAIN=$DOMAIN
CERT=$CERT
KEY=$KEY
TURN_HOST=$DOMAIN
TURN_SECRET=$(openssl rand -hex 24)
E
fi
if ! grep -q '^ADMIN_PASSWORD=' $DIR/.env; then echo "ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')" >> $DIR/.env; fi
chmod 600 $DIR/.env
SECRET=$(grep TURN_SECRET $DIR/.env | cut -d= -f2)

echo "== TURN (coturn)"
cat > /etc/turnserver.conf <<E
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=$IP
realm=$DOMAIN
use-auth-secret
static-auth-secret=$SECRET
cert=$CERT
pkey=$KEY
min-port=49160
max-port=49200
fingerprint
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
E
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
# coturn должен читать ключ сертификата
chmod 755 /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 644 /etc/letsencrypt/archive/$DOMAIN/privkey*.pem
systemctl enable coturn >/dev/null; systemctl restart coturn

echo "== Служба"
cat > /etc/systemd/system/heraxos.service <<E
[Unit]
Description=Heraxos
After=network.target
[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) server.js
Restart=always
[Install]
WantedBy=multi-user.target
E
systemctl daemon-reload; systemctl enable heraxos >/dev/null; systemctl restart heraxos

# автоперезапуск после обновления сертификата
echo -e "#!/bin/sh\nsystemctl restart heraxos coturn" > /etc/letsencrypt/renewal-hooks/deploy/heraxos.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/heraxos.sh

echo "== Фаервол"
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow $PORT/tcp; ufw allow 80/tcp; ufw allow 3478; ufw allow 5349/tcp; ufw allow 49160:49200/udp
fi

sleep 1; systemctl --no-pager -l status heraxos | head -5
echo
echo "Готово:  https://$DOMAIN:$PORT"
echo "Админ:   https://$DOMAIN:$PORT/admin.html"
echo "Пароль администратора: $(grep '^ADMIN_PASSWORD=' $DIR/.env | cut -d= -f2)   (хранится в $DIR/.env)"
