#!/bin/bash
# Установка Ahazang на Ubuntu/Debian.  Запуск из папки server:  sudo bash install.sh
# Настройки (необязательно):  DOMAIN=ahazang.klegal.ru  ADMIN_IPS="1.2.3.4 5.6.7.8"  sudo -E bash install.sh
# Перенос со старого сервера: положите архив /root/ahazang-data.tgz (см. README) до запуска.
set -e
DOMAIN=${DOMAIN:-ahazang.klegal.ru}
PORT=${PORT:-443}
DIR=/opt/ahazang
SRC=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash install.sh"; exit 1; }

echo "== Адрес сервера"
IP=${IP:-$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')}
[ -n "$IP" ] || { echo "Домен $DOMAIN не найден в DNS. Добавьте A-запись на IP этого сервера и повторите."; exit 1; }
MYIPS=$(hostname -I 2>/dev/null || true)
echo "$DOMAIN → $IP"
case " $MYIPS " in *" $IP "*) ;; *) echo "Внимание: $IP не найден среди адресов сервера ($MYIPS). Если сервер за NAT — это нормально.";; esac

echo "== Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl coturn certbot openssl >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null; apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"

systemctl stop ahazang coturn 2>/dev/null || true
echo "== Проверка портов"
for p in 80 $PORT 3478 5349; do
  if ss -lntu | grep -qE "[:.]$p\s"; then echo "Порт $p занят другой программой:"; ss -lntup | grep -E "[:.]$p\s"; exit 1; fi
done

echo "== Файлы"
mkdir -p $DIR/data
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/public" $DIR/
cd $DIR && npm install --omit=dev --silent --no-audit --no-fund

echo "== Перенос данных со старого сервера"
if [ -f /root/ahazang-data.tgz ] && [ ! -f $DIR/data/db.json ]; then
  T=$(mktemp -d); tar xzf /root/ahazang-data.tgz -C "$T"
  [ -d "$T/data" ] && cp -a "$T/data/." $DIR/data/
  [ -f "$T/.env" ] && grep -E '^(VAPID_PUBLIC|VAPID_PRIVATE|ADMIN_PASSWORD)=' "$T/.env" > $DIR/.env.migrated || true
  rm -rf "$T"
  echo "Перенесено: $(du -sh $DIR/data | cut -f1)"
else
  echo "Архива /root/ahazang-data.tgz нет (или данные уже есть) — пропускаю"
fi

echo "== SSL-сертификат для $DOMAIN"
if [ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
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
TURN_PORT=3478
TURNS_PORT=5349
TURN_SECRET=$(openssl rand -hex 24)
MAX_FILE_MB=100
FILE_DAYS=365
E
  [ -f $DIR/.env.migrated ] && cat $DIR/.env.migrated >> $DIR/.env
fi
rm -f $DIR/.env.migrated
if [ -n "$ADMIN_IPS" ]; then sed -i '/^ADMIN_IPS=/d' $DIR/.env; echo "ADMIN_IPS=$ADMIN_IPS" >> $DIR/.env; fi
grep -q '^ADMIN_PASSWORD=' $DIR/.env || echo "ADMIN_PASSWORD=$(openssl rand -base64 15 | tr -d '/+=')" >> $DIR/.env
chmod 600 $DIR/.env; chmod 700 $DIR/data
SECRET=$(grep '^TURN_SECRET=' $DIR/.env | cut -d= -f2)

echo "== Сервер для звонков через посредника (coturn)"
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
min-port=40000
max-port=49999
fingerprint
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
stale-nonce=600
total-quota=200
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
E
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
# coturn должен читать ключ сертификата
chmod 755 /etc/letsencrypt/live /etc/letsencrypt/archive
chmod 644 /etc/letsencrypt/archive/$DOMAIN/privkey*.pem
systemctl enable coturn >/dev/null; systemctl restart coturn

echo "== Служба ahazang"
cat > /etc/systemd/system/ahazang.service <<E
[Unit]
Description=Ahazang
After=network-online.target
Wants=network-online.target
[Service]
WorkingDirectory=$DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
LimitNOFILE=65535
[Install]
WantedBy=multi-user.target
E
systemctl daemon-reload; systemctl enable ahazang >/dev/null; systemctl restart ahazang

# после продления сертификата — перезапуск (порт 80 при продлении свободен: certbot сам его занимает на минуту)
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nchmod 644 /etc/letsencrypt/archive/%s/privkey*.pem\nsystemctl restart ahazang coturn\n' "$DOMAIN" > /etc/letsencrypt/renewal-hooks/deploy/ahazang.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/ahazang.sh

echo "== Ежедневная копия базы (14 дней, /var/backups/ahazang)"
cat > /etc/cron.daily/ahazang-backup <<'E'
#!/bin/sh
mkdir -p /var/backups/ahazang && chmod 700 /var/backups/ahazang
tar czf /var/backups/ahazang/db-$(date +%F).tgz -C /opt/ahazang data/db.json .env 2>/dev/null
find /var/backups/ahazang -name 'db-*.tgz' -mtime +14 -delete
E
chmod +x /etc/cron.daily/ahazang-backup

echo "== Фаервол"
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp; ufw allow $PORT/tcp; ufw allow 3478; ufw allow 5349/tcp; ufw allow 40000:49999/udp
else
  echo "ufw не включён — если у хостинга есть внешний фаервол, откройте: 80/tcp, $PORT/tcp, 3478 tcp+udp, 5349/tcp, 40000-49999/udp"
fi

sleep 2; systemctl --no-pager -l status ahazang | head -5
echo
echo "Готово: https://$DOMAIN$([ "$PORT" = 443 ] || echo ":$PORT")  (в браузере — страница «Скачайте приложение»)"
echo "Админка: https://$DOMAIN$([ "$PORT" = 443 ] || echo ":$PORT")/admin.html"
echo "Пароль администратора: $(grep '^ADMIN_PASSWORD=' $DIR/.env | cut -d= -f2)   (хранится в $DIR/.env)"
