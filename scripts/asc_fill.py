#!/usr/bin/env python3
"""Заполняет карточку Ahazang Messenger в App Store Connect через API.

Переменные окружения: KEY_ID, ISSUER_ID, KEYPATH (файл .p8), APPREVIEW_PASSWORDS ("логин:пароль логин:пароль"),
необязательно REVIEW_PHONE, REVIEW_FIRST, REVIEW_LAST.
Каждый шаг независим: ошибка одного не останавливает остальные, в конце — сводка.
"""
import glob, hashlib, json, os, sys, time
import jwt, requests

API = 'https://api.appstoreconnect.apple.com'
BUNDLE = 'am.ahazang.app'
SHOTS = sorted(glob.glob(os.path.join(os.path.dirname(__file__), '..', 'docs', 'appstore', 'screenshots', '*.png')))

T = {
    'name': 'Ahazang Messenger',
    'subtitle': 'Защищённые звонки и чаты',
    'privacy': 'https://ahazang.klegal.ru/privacy.html',
    'support': 'https://ahazang.klegal.ru/support.html',
    'promo': 'Звонки и переписка, которые видите только вы и собеседник. Голосовые, видеосообщения, файлы и игры — всё со сквозным шифрованием.',
    'keywords': 'мессенджер,звонки,видеозвонок,шифрование,чат,голосовые,безопасный,приватный,шахматы,messenger',
    'copyright': '2026 Ahazang',
    'description': """Ahazang Messenger — защищённые звонки и сообщения для семьи и друзей.

• Аудио- и видеозвонки в высоком качестве — на системном экране звонка, даже когда телефон заблокирован
• Сквозное шифрование сообщений, фото, файлов, голосовых и видеосообщений: ключи хранятся только на ваших устройствах
• Голосовые и видеосообщения-кружки — удерживайте кнопку и говорите
• Групповые видеозвонки до 5 человек
• Свой 6-значный номер: добавляйте людей по номеру, без телефонной книги
• Удаляйте любые сообщения у себя и у собеседника
• Шахматы и шашки вдвоём прямо во время звонка — видите друг друга и чей ход
• Блокировка и жалобы, удаление аккаунта в один шаг
• Без рекламы и без отслеживания

Поддержка: armenoid@gmail.com""",
}

results = []


def token():
    key = open(os.environ['KEYPATH']).read()
    now = int(time.time())
    return jwt.encode({'iss': os.environ['ISSUER_ID'], 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'},
                      key, algorithm='ES256', headers={'kid': os.environ['KEY_ID'], 'typ': 'JWT'})


TOK = token()


def call(method, path, body=None, params=None, ok=(200, 201, 204)):
    r = requests.request(method, API + path, headers={'Authorization': 'Bearer ' + TOK, 'Content-Type': 'application/json'},
                         json=body, params=params, timeout=60)
    if r.status_code not in ok:
        try:
            errs = r.json().get('errors', [])
            msg = '; '.join(f"{e.get('title')}: {e.get('detail')}" for e in errs) or r.text[:400]
        except Exception:
            msg = r.text[:400]
        raise RuntimeError(f'{method} {path} → {r.status_code}: {msg}')
    return r.json() if r.content else {}


def step(name):
    def wrap(fn):
        def run(*a, **k):
            try:
                out = fn(*a, **k)
                results.append(('✅', name, out or ''))
                print(f'✅ {name} {out or ""}', flush=True)
                return out
            except Exception as e:
                results.append(('❌', name, str(e)))
                print(f'❌ {name}: {e}', flush=True)
        return run
    return wrap


app = call('GET', '/v1/apps', params={'filter[bundleId]': BUNDLE})['data']
if not app:
    sys.exit('Приложение с bundle id am.ahazang.app не найдено в App Store Connect')
APP = app[0]['id']
print('Приложение:', app[0]['attributes'].get('name'), APP)

infos = call('GET', f'/v1/apps/{APP}/appInfos')['data']
# редактируемая карточка — та, что ещё не опубликована
INFO = next((i for i in infos if i['attributes'].get('appStoreState') not in ('READY_FOR_SALE', 'READY_FOR_DISTRIBUTION')), infos[0])['id']


@step('Название, подзаголовок, политика конфиденциальности')
def app_info_loc():
    locs = call('GET', f'/v1/appInfos/{INFO}/appInfoLocalizations')['data']
    done = []
    for l in locs:
        call('PATCH', f"/v1/appInfoLocalizations/{l['id']}", {'data': {'type': 'appInfoLocalizations', 'id': l['id'], 'attributes': {
            'name': T['name'], 'subtitle': T['subtitle'], 'privacyPolicyUrl': T['privacy']}}})
        done.append(l['attributes']['locale'])
    return ', '.join(done)


@step('Категории: Social Networking / Utilities')
def categories():
    call('PATCH', f'/v1/appInfos/{INFO}', {'data': {'type': 'appInfos', 'id': INFO, 'relationships': {
        'primaryCategory': {'data': {'type': 'appCategories', 'id': 'SOCIAL_NETWORKING'}},
        'secondaryCategory': {'data': {'type': 'appCategories', 'id': 'UTILITIES'}}}}})


@step('Возрастной рейтинг')
def age_rating():
    d = call('GET', f'/v1/appInfos/{INFO}/ageRatingDeclaration')['data']
    attrs = d['attributes']
    TRUE = {'messagingAndChat', 'userGeneratedContent'}
    SKIP = {'kidsAgeBand', 'ageRatingOverride', 'ageRatingOverrideV2', 'koreaAgeRatingOverride', 'developerAgeRatingInfoUrl',
            'gracRatingClassificationNumber'}
    BOOL = {'gambling', 'unrestrictedWebAccess', 'seventeenPlus', 'lootBox', 'parentalControls', 'ageAssurance', 'advertising',
            'healthOrWellnessTopics', 'messagingAndChat', 'userGeneratedContent', 'datingAndRelationships', 'sharedLocation',
            'socialMedia', 'socialMediaAgeRestricted'}
    out = {}
    for k in attrs:
        if k in SKIP:
            continue
        out[k] = (k in TRUE) if k in BOOL or isinstance(attrs[k], bool) else 'NONE'
    try:
        call('PATCH', f"/v1/ageRatingDeclarations/{d['id']}", {'data': {'type': 'ageRatingDeclarations', 'id': d['id'], 'attributes': out}})
        return f'{len(out)} пунктов'
    except RuntimeError as e:  # по одному — чтобы понять, какой пункт не подходит
        bad = []
        for k, v in out.items():
            try:
                call('PATCH', f"/v1/ageRatingDeclarations/{d['id']}", {'data': {'type': 'ageRatingDeclarations', 'id': d['id'], 'attributes': {k: v}}})
            except RuntimeError:
                bad.append(k)
        if bad:
            raise RuntimeError(f'не приняты: {", ".join(bad)} ({e})')
        return 'по одному пункту'


def get_version():
    vs = call('GET', f'/v1/apps/{APP}/appStoreVersions', params={'filter[platform]': 'IOS', 'limit': 20})['data']
    editable = [v for v in vs if v['attributes'].get('appStoreState') in (
        'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY')]
    if editable:
        return editable[0]
    if vs:
        raise RuntimeError('нет редактируемой версии: ' + ', '.join(f"{v['attributes']['versionString']} {v['attributes'].get('appStoreState')}" for v in vs))
    return call('POST', '/v1/appStoreVersions', {'data': {'type': 'appStoreVersions', 'attributes': {'platform': 'IOS', 'versionString': '1.0'},
                                                           'relationships': {'app': {'data': {'type': 'apps', 'id': APP}}}}})['data']


VER = None
try:
    VER = get_version()
    print('Версия:', VER['attributes']['versionString'], VER['attributes'].get('appStoreState'))
except Exception as e:
    results.append(('❌', 'Версия 1.0', str(e)))
    print('❌ версия:', e)


@step('Copyright')
def copyright_():
    call('PATCH', f"/v1/appStoreVersions/{VER['id']}", {'data': {'type': 'appStoreVersions', 'id': VER['id'], 'attributes': {'copyright': T['copyright']}}})


@step('Описание, ключевые слова, рекламный текст, ссылка поддержки')
def version_loc():
    locs = call('GET', f"/v1/appStoreVersions/{VER['id']}/appStoreVersionLocalizations")['data']
    for l in locs:
        call('PATCH', f"/v1/appStoreVersionLocalizations/{l['id']}", {'data': {'type': 'appStoreVersionLocalizations', 'id': l['id'], 'attributes': {
            'description': T['description'], 'keywords': T['keywords'], 'promotionalText': T['promo'], 'supportUrl': T['support']}}})
    return ', '.join(l['attributes']['locale'] for l in locs)


@step('Скриншоты iPhone 6.7/6.9″')
def screenshots():
    locs = call('GET', f"/v1/appStoreVersions/{VER['id']}/appStoreVersionLocalizations")['data']
    n = 0
    for l in locs:
        sets = call('GET', f"/v1/appStoreVersionLocalizations/{l['id']}/appScreenshotSets")['data']
        s = next((x for x in sets if x['attributes']['screenshotDisplayType'] == 'APP_IPHONE_67'), None)
        if not s:
            s = call('POST', '/v1/appScreenshotSets', {'data': {'type': 'appScreenshotSets', 'attributes': {'screenshotDisplayType': 'APP_IPHONE_67'},
                     'relationships': {'appStoreVersionLocalization': {'data': {'type': 'appStoreVersionLocalizations', 'id': l['id']}}}}})['data']
        for old in call('GET', f"/v1/appScreenshotSets/{s['id']}/appScreenshots")['data']:
            call('DELETE', f"/v1/appScreenshots/{old['id']}")
        for path in SHOTS:
            data = open(path, 'rb').read()
            shot = call('POST', '/v1/appScreenshots', {'data': {'type': 'appScreenshots', 'attributes': {'fileName': os.path.basename(path), 'fileSize': len(data)},
                        'relationships': {'appScreenshotSet': {'data': {'type': 'appScreenshotSets', 'id': s['id']}}}}})['data']
            for op in shot['attributes']['uploadOperations']:
                part = data[op['offset']:op['offset'] + op['length']]
                hdr = {h['name']: h['value'] for h in op.get('requestHeaders') or []}
                r = requests.request(op['method'], op['url'], headers=hdr, data=part, timeout=120)
                if r.status_code >= 300:
                    raise RuntimeError(f'загрузка части скриншота: {r.status_code}')
            call('PATCH', f"/v1/appScreenshots/{shot['id']}", {'data': {'type': 'appScreenshots', 'id': shot['id'], 'attributes': {
                'uploaded': True, 'sourceFileChecksum': hashlib.md5(data).hexdigest()}}})
            n += 1
    return f'{n} файлов'


@step('Сборка для версии и ответ про шифрование')
def build():
    bs = call('GET', '/v1/builds', params={'filter[app]': APP, 'sort': '-uploadedDate', 'limit': 10, 'filter[processingState]': 'VALID'})['data']
    if not bs:
        raise RuntimeError('нет обработанных сборок — подождите, пока Apple обработает новую')
    b = bs[0]
    num = b['attributes']['version']
    note = ''
    if b['attributes'].get('usesNonExemptEncryption') is None:
        try:  # декларация: стандартные алгоритмы, ничего своего
            decl = call('POST', '/v1/appEncryptionDeclarations', {'data': {'type': 'appEncryptionDeclarations', 'attributes': {
                'appDescription': 'End-to-end encrypted messaging and calls using standard algorithms (ECDH P-256, AES-256-GCM, DTLS-SRTP).',
                'containsProprietaryCryptography': False, 'containsThirdPartyCryptography': True, 'availableOnFrenchStore': True},
                'relationships': {'app': {'data': {'type': 'apps', 'id': APP}}}}})['data']
            call('PATCH', f"/v1/builds/{b['id']}/relationships/appEncryptionDeclaration", {'data': {'type': 'appEncryptionDeclarations', 'id': decl['id']}})
            note = ', шифрование: декларация отправлена'
        except RuntimeError as e:
            note = f', шифрование — ответьте вручную ({e})'
    call('PATCH', f"/v1/appStoreVersions/{VER['id']}/relationships/build", {'data': {'type': 'builds', 'id': b['id']}})
    return f'сборка {num}{note}'


@step('Данные для проверяющего (тестовые аккаунты, заметки)')
def review():
    pairs = [p.split(':', 1) for p in os.environ.get('APPREVIEW_PASSWORDS', '').split() if ':' in p]
    if not pairs:
        raise RuntimeError('секрет APPREVIEW_PASSWORDS пуст')
    accts = '\n'.join(f'  {u} / {p}' for u, p in pairs)
    notes = f"""Ahazang Messenger is a native VoIP calling and end-to-end encrypted messaging app.

Native features: CallKit (system call screen, lock-screen answering), PushKit VoIP notifications,
native WebRTC audio/video engine with speaker/earpiece/Bluetooth routing, picture-in-picture
video during in-app games (chess, checkers).

Test accounts (already contacts of each other):
{accts}
To test a call: sign in with the first account on one device and the second on another device,
open Contacts and tap the phone or video icon. Voice/video messages: hold the mic button in a chat.

Messages, photos, files and voice/video messages are end-to-end encrypted (ECDH P-256 + AES-256-GCM).
Users can report and block other users (chat menu); reports are reviewed within 24 hours.
Messages can be deleted for both sides (long press a message). Account deletion: Settings → Delete account.
Contact: armenoid@gmail.com"""
    attrs = {'demoAccountRequired': True, 'demoAccountName': pairs[0][0], 'demoAccountPassword': pairs[0][1], 'notes': notes,
             'contactEmail': 'armenoid@gmail.com'}
    for env, key in (('REVIEW_FIRST', 'contactFirstName'), ('REVIEW_LAST', 'contactLastName'), ('REVIEW_PHONE', 'contactPhone')):
        if os.environ.get(env):
            attrs[key] = os.environ[env]
    try:
        cur = call('GET', f"/v1/appStoreVersions/{VER['id']}/appStoreReviewDetail")['data']
    except RuntimeError:
        cur = None
    if cur:
        call('PATCH', f"/v1/appStoreReviewDetails/{cur['id']}", {'data': {'type': 'appStoreReviewDetails', 'id': cur['id'], 'attributes': attrs}})
    else:
        call('POST', '/v1/appStoreReviewDetails', {'data': {'type': 'appStoreReviewDetails', 'attributes': attrs,
             'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': VER['id']}}}}})
    return 'имя и телефон для связи — допишите вручную' if 'contactPhone' not in attrs else ''


@step('Цена: бесплатно')
def price_free():
    pts = call('GET', f'/v1/apps/{APP}/appPricePoints', params={'filter[territory]': 'USA', 'limit': 200})['data']
    free = next((p for p in pts if float(p['attributes'].get('customerPrice') or 0) == 0), None)
    if not free:
        raise RuntimeError('не найдена цена 0')
    call('POST', '/v1/appPriceSchedules', {
        'data': {'type': 'appPriceSchedules', 'relationships': {
            'app': {'data': {'type': 'apps', 'id': APP}},
            'baseTerritory': {'data': {'type': 'territories', 'id': 'USA'}},
            'manualPrices': {'data': [{'type': 'appPrices', 'id': '${price0}'}]}}},
        'included': [{'type': 'appPrices', 'id': '${price0}', 'attributes': {'startDate': None},
                      'relationships': {'appPricePoint': {'data': {'type': 'appPricePoints', 'id': free['id']}}}}]})


@step('Страны: все, кроме Китая (CallKit там запрещён)')
def availability():
    try:
        av = call('GET', f'/v1/apps/{APP}/appAvailabilityV2')['data']
    except RuntimeError:
        av = None
    if av:
        tas = call('GET', f"/v2/appAvailabilities/{av['id']}/territoryAvailabilities", params={'limit': 200, 'include': 'territory'})['data']
        chn = next((t for t in tas if (t.get('relationships', {}).get('territory', {}).get('data') or {}).get('id') == 'CHN'), None)
        if chn and chn['attributes'].get('available'):
            call('PATCH', f"/v1/territoryAvailabilities/{chn['id']}", {'data': {'type': 'territoryAvailabilities', 'id': chn['id'], 'attributes': {'available': False}}})
            return 'Китай отключён'
        return 'Китай уже отключён' if chn else 'настройка есть'
    terrs = []
    url, params = '/v1/territories', {'limit': 200}
    terrs = [t['id'] for t in call('GET', url, params=params)['data']]
    inc, rel = [], []
    for i, t in enumerate(terrs):
        lid = '${t%d}' % i
        rel.append({'type': 'territoryAvailabilities', 'id': lid})
        inc.append({'type': 'territoryAvailabilities', 'id': lid, 'attributes': {'available': t != 'CHN'},
                    'relationships': {'territory': {'data': {'type': 'territories', 'id': t}}}})
    call('POST', '/v2/appAvailabilities', {'data': {'type': 'appAvailabilities', 'attributes': {'availableInNewTerritories': True},
         'relationships': {'app': {'data': {'type': 'apps', 'id': APP}}, 'territoryAvailabilities': {'data': rel}}}, 'included': inc})
    return f'{len(rel) - 1} стран, без Китая'


app_info_loc()
categories()
age_rating()
if VER:
    copyright_()
    version_loc()
    screenshots()
    build()
    review()
price_free()
availability()

print('\n==== Итог ====')
for mark, name, info in results:
    print(f'{mark} {name}' + (f' — {info}' if info else ''))
print('\nВручную: App Privacy (вопросы о данных) и кнопка «Add for Review» / «Submit for Review».')
