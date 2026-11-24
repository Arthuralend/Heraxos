# Публикация Ahazang Messenger в App Store

Сборки попадают в App Store Connect автоматически (GitHub Actions → TestFlight).
Ниже — что заполнить в App Store Connect (appstoreconnect.apple.com → Apps → Ahazang).

---

## 1. Название и основные сведения — App Information

| Поле | Значение |
|---|---|
| Name | **Ahazang Messenger** |
| Subtitle | Защищённые звонки и чаты |
| Primary Category | Social Networking |
| Secondary Category | Utilities |
| Content Rights | Не содержит чужого контента |
| Age Rating | ответы ниже, п. 6 |

Под иконкой на телефоне остаётся короткое **Ahazang** (так задумано).

## 2. Цена и доступность — Pricing and Availability

1. **Price:** выберите цену **$9.99** (в списке цен Apple это ближайшая к $10; цены для других стран Apple подставит сам).
2. **Availability:** все страны, **кроме China mainland** — Apple не допускает приложения с CallKit
   (системный экран звонка) в Китае. Снимите галочку «China mainland».

## 3. 100 бесплатных кодов для знакомых — Promo Codes

Промокоды дают бесплатно скачать платное приложение.

1. Дождитесь, когда версия будет **одобрена и выпущена** (Ready for Distribution) — коды выдаются только для
   вышедшей версии.
2. App Store Connect → ваше приложение → вкладка **App Store** → слева **Promo Codes** (или меню «⋯» → Promo Codes).
3. Введите **100** → примите условия → **Generate**. Скачайте файл с кодами.
4. Раздайте по одному коду. Друг открывает App Store → фото профиля → **«Погасить подарочную карту или код»**
   → вводит код → приложение скачивается бесплатно.

Важно:
- код одноразовый и действует **28 дней** с момента создания — создавайте коды, когда готовы раздать;
- лимит — **100 кодов на каждую версию**; для следующей сотни выпустите обновление (новую версию);
- по промокодам нельзя оставлять отзывы в App Store (так решает Apple).

## 4. Описание для App Store — версия 1.0

**Promotional Text (170 символов):**
> Звонки и переписка, которые видите только вы и собеседник. Голосовые, видеосообщения, файлы и игры — всё со сквозным шифрованием.

**Description:**
```
Ahazang Messenger — защищённые звонки и сообщения для семьи и друзей.

• Аудио- и видеозвонки в высоком качестве — на системном экране звонка, даже когда телефон заблокирован
• Сквозное шифрование сообщений, фото, файлов, голосовых и видеосообщений: ключи хранятся только на ваших устройствах
• Голосовые и видеосообщения-кружки — удерживайте кнопку и говорите
• Групповые видеозвонки до 5 человек
• Свой 6-значный номер: добавляйте людей по номеру, без телефонной книги
• Удаляйте любые сообщения у себя и у собеседника
• Шахматы и шашки вдвоём прямо во время звонка — видите друг друга и чей ход
• Блокировка и жалобы, удаление аккаунта в один шаг
• Без рекламы и без отслеживания

Поддержка: armenoid@gmail.com
```

**Keywords (100 символов):**
`мессенджер,звонки,видеозвонок,шифрование,чат,голосовые,безопасный,приватный,шахматы,messenger`

**Support URL:** `https://ahazang.klegal.ru/support.html`
**Privacy Policy URL:** `https://ahazang.klegal.ru/privacy.html`
**Copyright:** `2026 Ahazang`

Скриншоты: iPhone 6.9" (1320 × 2868) — минимум 3 штуки: список чатов, переписка с голосовым,
звонок, шахматы во время звонка. Не показывайте на скриншотах Android и танки.

## 5. Для проверяющего Apple — App Review Information

**Обязательно создайте два тестовых аккаунта** (в админке или через регистрацию в приложении), например
`appreview1` / `appreview2` с паролями, и добавьте их друг другу в контакты.

- **Sign-in required:** да. Username: `appreview1`, Password: `…`
- **Notes** (вставьте по-английски):
```
Ahazang Messenger is a native VoIP calling and end-to-end encrypted messaging app.

Native features: CallKit (system call screen, lock-screen answering), PushKit VoIP notifications,
native WebRTC audio/video engine with speaker/earpiece/Bluetooth routing, picture-in-picture
video during in-app games.

Test accounts (already contacts of each other):
  appreview1 / <password>
  appreview2 / <password>
To test a call: sign in with appreview1 on one device and appreview2 on another device,
open Contacts and tap the phone or video icon.

Messages, photos, files and voice/video messages are end-to-end encrypted (ECDH P-256 + AES-256-GCM).
Users can report and block other users (chat menu "⋮"); reports are reviewed within 24 hours.
Account deletion: Settings → Delete account.
Contact: armenoid@gmail.com
```

## 6. Возрастной рейтинг — Age Rating

- Пользовательский контент / общение между пользователями: **да** (обмен сообщениями)
- Неограниченный доступ в интернет (браузер): **нет**
- Остальные пункты (насилие, азартные игры и т. п.): **нет / none**
- Игры (шахматы, шашки) — не азартные.

## 7. Конфиденциальность — App Privacy

**Data Used to Track You:** нет.
**Data Linked to You:**
- *Contact Info → Name* (логин) — App Functionality
- *Identifiers → User ID* (логин и 6-значный номер) — App Functionality
- *User Content → Other User Content* (зашифрованные сообщения и файлы — содержимое серверу недоступно) — App Functionality
- *User Content → Customer Support* (письма в поддержку, жалобы) — App Functionality

**Не собираем:** местоположение, контакты телефона, историю браузера, покупки, данные о здоровье,
рекламные идентификаторы, аналитику.

## 8. Шифрование — Export Compliance

При каждой сборке App Store Connect спросит про шифрование (сборка будет «Missing Compliance»):
1. «Does your app use encryption?» — **Yes**
2. «Does your app qualify for any of the exemptions…?» — **Yes** → вариант про
   **стандартные алгоритмы шифрования** (используются ECDH, AES-GCM, DTLS-SRTP — стандартные, не собственные).
3. Ежегодный отчёт в BIS (Annual Self-Classification Report): с 2021 года для большинства массовых
   приложений со стандартным шифрованием он не требуется. Если App Store Connect после ответов попросит
   документы — ответьте по подсказкам Apple или напишите мне.
4. Для продаж во **Франции** Apple может попросить декларацию (ANSSI); если не хотите возиться —
   временно уберите Францию из списка стран.

## 9. Перед отправкой — чек-лист

- [ ] Сервер обновлён до последней версии (на iPhone нет «Танчиков 3D»)
- [ ] Сборка с последним номером выбрана в версии 1.0
- [ ] Ответ про шифрование дан
- [ ] Тестовые аккаунты созданы и указаны в App Review Information
- [ ] Цена $9.99, Китай исключён
- [ ] Скриншоты загружены, описание, ключевые слова, ссылки поддержки и политики заполнены
- [ ] App Privacy заполнена
- [ ] **Submit for Review**
