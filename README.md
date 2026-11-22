# Ahazang

Защищённые звонки, сообщения и файлы на собственном сервере. Работает только в приложениях для Android и iPhone.

- `server/` — сервер (Node.js, WebRTC, сквозное шифрование сообщений и файлов, TURN, админка). Установка и перенос данных: `server/README.md`.
- корень репозитория — приложение для Android (вход по логину и паролю, входящий звонок на весь экран, работа без сервисов Google).
- `ios/` — приложение для iPhone.

**Скачать Android-приложение:** [Ahazang.apk](https://github.com/Arthuralend/Heraxos/releases/latest/download/Ahazang.apk)

APK собирается автоматически (GitHub Actions) при каждом изменении в ветке `main`. Ключ подписи хранится в секретах репозитория (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`).
