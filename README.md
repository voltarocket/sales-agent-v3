# Sales Call Analyzer v3

Система анализа звонков менеджеров по продажам на базе ИИ.  
Телефон записывает разговор → локальный бэкенд передаёт файл → глобальный бэкенд транскрибирует и оценивает через Groq → десктоп показывает результаты в реальном времени.

---

## Содержание

- [Архитектура](#архитектура)
- [Структура проекта](#структура-проекта)
- [Варианты развёртывания](#варианты-развёртывания)
  - [Вариант A — всё на одном сервере (разработка / тест)](#вариант-a--всё-на-одном-сервере-разработка--тест)
  - [Вариант B — распределённый продакшен](#вариант-b--распределённый-продакшен)
    - [Шаг 1 — Beget VPS: global backend + сайт](#шаг-1--beget-vps-global-backend--сайт)
    - [Шаг 2 — Локальный бэкенд в локальной сети](#шаг-2--локальный-бэкенд-в-локальной-сети)
    - [Шаг 3 — Desktop, Admin и Android приложения](#шаг-3--desktop-admin-и-android-приложения)
- [Разработка без Docker](#разработка-без-docker)
- [Как работает лицензия](#как-работает-лицензия)
- [Сайт и панель администратора](#сайт-и-панель-администратора)
- [Android-приложение](#android-приложение)
- [API Reference](#api-reference)
- [Groq лимиты](#groq-лимиты-бесплатный-план)

---

## Архитектура

```
┌──────────────────────────────────────────────────────────────────┐
│  BEGET VPS  (один сервер, docker-compose.vps.yml)                │
│                                                                  │
│  ┌───────────────────────────────┐                              │
│  │  WEBSITE  :3003               │                              │
│  │  React SPA + FastAPI          │                              │
│  │  Регистрация, скачивания,     │                              │
│  │  панель владельца системы     │                              │
│  └───────────────┬───────────────┘                              │
│                  │ http://global-backend:3002 (Docker-сеть)     │
│  ┌───────────────▼───────────────┐                              │
│  │  GLOBAL BACKEND  :3002        │                              │
│  │  AI-шлюз: Groq Whisper + LLM  │                              │
│  │  Лицензирование               │                              │
│  └───────────────┬───────────────┘                              │
│                  │                                              │
│            PostgreSQL :5432                                     │
└──────────────────────────────────────────────────────────────────┘
                  ▲ http://BEGET-IP:3002
                  │
┌─────────────────┴───────────────────────────────────────────────┐
│  ЛОКАЛЬНАЯ СЕТЬ (офис, docker-compose.local.yml)                 │
│                                                                  │
│  ┌─────────────────────────────────────┐                        │
│  │  LOCAL BACKEND  :3001               │  ← один на офис        │
│  │  FastAPI + PostgreSQL               │                        │
│  │  Менеджеры, звонки, контакты        │                        │
│  └───────┬──────────────────┬──────────┘                        │
│          │ WebSocket        │ HTTP                               │
│  ┌───────▼──────┐  ┌────────▼───────┐  ┌──────────────────┐   │
│  │ Desktop App  │  │   Admin App    │  │  Android / тел.  │   │
│  │  (Electron)  │  │   (Electron)   │  │  ws://LAN-IP:3001│   │
│  └──────────────┘  └────────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Потоки данных

| Откуда | Куда | Протокол | Что передаётся |
|--------|------|----------|----------------|
| Desktop / Android | Local Backend | WebSocket | Аудио-поток, статус звонка |
| Admin App | Local Backend | HTTP | CRUD: менеджеры, звонки, настройки |
| Local Backend | Global Backend | HTTP | Аудио-файл или текст для анализа |
| Local Backend | Global Backend | HTTP | Валидация лицензионного ключа |
| Website Backend | Global Backend | HTTP | Выдача лицензий при регистрации |

---

## Структура проекта

```
sales-agent-v3/
│
├── backend/                    ← Локальный бэкенд (Python / FastAPI :3001)
│   ├── main.py                 ← Весь API: звонки, контакты, менеджеры, WebSocket
│   ├── init.sql                ← Схема БД (применяется при первом запуске Docker)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
│
├── global-backend/             ← Глобальный бэкенд (Python / FastAPI :3002)
│   ├── main.py                 ← /process, /analyze, /licenses
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
│
├── website/
│   ├── backend/                ← Website FastAPI :3003
│   │   ├── main.py             ← Регистрация, авторизация, выдача лицензий, /admin API
│   │   ├── static/             ← Собранный React (git-ignored, см. Шаг 2)
│   │   ├── requirements.txt
│   │   ├── Dockerfile
│   │   └── .env.example
│   └── frontend/               ← React + Vite
│       ├── src/
│       │   ├── pages/Home.jsx          ← Лендинг + регистрация
│       │   ├── pages/Login.jsx         ← Вход
│       │   ├── pages/Dashboard.jsx     ← Ключ + кнопки скачать
│       │   └── pages/Admin.jsx         ← Управление пользователями
│       └── vite.config.js      ← Proxy /api → :3003, build → ../backend/static
│
├── desktop/                    ← Electron (дашборд менеджера)
│   └── src/
│       ├── main.js             ← BACKEND_WS + BACKEND_URL из env
│       ├── renderer.js         ← UI: звонки, менеджеры, аналитика
│       └── preload.js
│
├── admin/                      ← Electron (панель администратора)
│   └── src/
│       ├── main.js             ← BACKEND_URL из env, auth через website /api/auth/verify
│       ├── renderer.js         ← UI: менеджеры, лицензии, настройки
│       └── preload.js
│
├── android/                    ← Kotlin (запись звонков с телефона)
│
├── docker-compose.yml          ← Всё на одном хосте (разработка / тест)
├── docker-compose.vps.yml      ← Только global-backend + postgres (для VPS)
├── docker-compose.beget.yml    ← Только website + postgres (для Beget VPS)
├── docker-compose.local.yml    ← Только local-backend + postgres (для LAN-машины)
└── package.json                ← npm-скрипты для разработки и деплоя
```

---

## Варианты развёртывания

### Вариант A — всё на одном сервере (разработка / тест)

Подходит для быстрого запуска и проверки. Все сервисы на одной машине.

**Требования:** Docker Desktop, Node.js LTS

**1. Скопировать .env файлы**

```bash
cp global-backend/.env.example global-backend/.env
cp backend/.env.example backend/.env
cp website/backend/.env.example website/backend/.env
```

**2. Заполнить обязательные переменные**

`global-backend/.env`:
```env
GROQ_API_KEY=gsk_...          # https://console.groq.com → API Keys
ADMIN_SECRET=my-secret-123    # произвольная строка, запомни её
```

`backend/.env`:
```env
GLOBAL_ADMIN_SECRET=my-secret-123   # та же строка, что ADMIN_SECRET выше
```

`website/backend/.env`:
```env
GLOBAL_ADMIN_SECRET=my-secret-123   # та же строка
SITE_ADMIN_USER=admin
SITE_ADMIN_PASS=сильный-пароль
```

**3. Собрать фронтенд сайта**

```bash
cd website/frontend
npm install
npm run build     # → website/backend/static/
cd ../..
```

**4. Запустить**

```bash
npm run docker:up
# или: docker compose up --build
```

Сервисы:
- Сайт: http://localhost:3003
- Local Backend: http://localhost:3001
- Global Backend: http://localhost:3002

**5. Запустить Electron-приложения**

```bash
npm run install:all
npm run dev:desktop    # дашборд менеджера
npm run dev:admin      # панель администратора
```

---

### Вариант B — распределённый продакшен

```
Beget VPS   →  global backend + website (один сервер, docker-compose.vps.yml)
Каждый офис →  local backend + desktop/admin на ПК (docker-compose.local.yml)
```

> **Важно:** Beget **shared hosting** не подходит — FastAPI требует постоянный процесс (uvicorn), а PostgreSQL на базовом shared не предоставляется. Нужен **Beget VPS** (Linux, от ~300 руб/мес). Global backend и сайт живут на одном VPS.

---

#### Шаг 1 — Beget VPS: global backend + сайт

Один сервер держит и AI-шлюз, и публичный сайт. Внутри Docker-сети они общаются напрямую, наружу торчат порты 3002 (API) и 3003 (сайт).

**Требования:** Docker, Docker Compose, Node.js (для сборки фронтенда), открытые порты `3002` и `3003`

**1.1. Загрузить проект на VPS**

```bash
git clone <repo> ~/sales && cd ~/sales
```

Или через scp:
```bash
scp -r . user@BEGET-IP:~/sales/
```

**1.2. Собрать фронтенд сайта** (один раз перед запуском)

```bash
cd website/frontend && npm install && npm run build && cd ../..
```

**1.3. Создать .env для global backend**

```bash
cp global-backend/.env.example global-backend/.env
nano global-backend/.env
```

```env
PORT=3002
GROQ_API_KEY=gsk_...                  # https://console.groq.com → API Keys
ADMIN_SECRET=придумай-сложный-пароль  # запомни — нужен во всех остальных .env
REQUIRE_LICENSE=true                  # включить проверку лицензий в продакшене
```

**1.4. Создать .env для сайта**

```bash
cp website/backend/.env.example website/backend/.env
nano website/backend/.env
```

```env
PORT=3003
# Внутри Docker-сети — не меняй эту строку
GLOBAL_BACKEND_URL=http://global-backend:3002

# Тот же пароль, что ADMIN_SECRET выше
GLOBAL_ADMIN_SECRET=придумай-сложный-пароль

# Логин/пароль для страницы /admin на сайте
SITE_ADMIN_USER=admin
SITE_ADMIN_PASS=сильный-пароль-для-владельца

# Ссылки на файлы для скачивания (после того как выложишь сборки)
DOWNLOAD_DESKTOP=https://files.yourdomain.com/desktop-setup.exe
DOWNLOAD_ADMIN=https://files.yourdomain.com/admin-setup.exe
DOWNLOAD_BACKEND=https://files.yourdomain.com/docker-compose.local.yml
DOWNLOAD_ANDROID=https://files.yourdomain.com/sales-analyzer.apk
```

**1.5. Запустить**

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

**1.6. Открыть порты в файрволе**

```bash
# UFW (Ubuntu — стандарт на Beget VPS)
ufw allow 3002/tcp   # global backend API (нужен local-backend в офисах)
ufw allow 3003/tcp   # сайт

# firewalld (CentOS/RHEL)
firewall-cmd --permanent --add-port=3002/tcp --add-port=3003/tcp && firewall-cmd --reload
```

**1.7. Проверить**

```bash
curl http://BEGET-IP:3002/health
# → {"status":"ok","groq":true}
```

Открой в браузере `http://BEGET-IP:3003` — должна появиться страница регистрации.

**1.8. (Рекомендуется) Nginx + SSL для сайта**

```bash
apt install nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/sales`:
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3003;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/sales /etc/nginx/sites-enabled/
certbot --nginx -d yourdomain.com
nginx -s reload
```

---

#### Шаг 2 — Локальный бэкенд в локальной сети

Один экземпляр на офис (или на каждый изолированный сегмент сети). Хранит звонки, контакты, менеджеров. Получает AI-анализ от глобального бэкенда на Beget VPS.

**Требования на LAN-машине:** Docker, Docker Compose, открытый порт `3001` в локальной сети (не в интернете)

**2.1. Скопировать файлы**

```powershell
# Windows — PowerShell или Git Bash
git clone <repo> C:\sales-agent
# или скопировать папки backend/ и docker-compose.local.yml вручную
```

```bash
# Linux
git clone <repo> ~/sales-agent
```

**2.2. Создать .env**

```bash
cp backend/.env.example backend/.env
```

Открыть `backend/.env` и заполнить:

```env
PORT=3001
DATABASE_URL=postgresql://sales:sales_pass@postgres:5432/sales_agent

# Адрес глобального бэкенда на Beget VPS (из Шага 1)
GLOBAL_BACKEND_URL=http://BEGET-IP:3002

# Тот же пароль, что ADMIN_SECRET в global-backend/.env
GLOBAL_ADMIN_SECRET=придумай-сложный-пароль

# Лицензионный ключ — получить на сайте после регистрации (Шаг 1)
# Оставь пустым для dev-режима без лицензии
LICENSE_KEY=SALES-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# FreePBX / SIP (если используется IP-телефония)
FREEPBX_HOST=192.168.1.100    # IP АТС в локальной сети
FREEPBX_DOMAIN=office.local
FREEPBX_EXTENSION=1000
FREEPBX_PASSWORD=sip-password

# Telegram-уведомления (опционально)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

**2.3. Запустить**

```bash
docker compose -f docker-compose.local.yml up -d --build
```

**2.4. Проверить**

```bash
curl http://localhost:3001/api/health
# → {"status":"ok","database":"connected","license":"..."}
```

**2.5. Узнать LAN IP этой машины**

```powershell
# Windows
ipconfig | findstr "IPv4"
# например: 192.168.1.50
```

```bash
# Linux
ip addr show | grep "inet "
```

Запомни этот IP — он понадобится в Шаге 3 для Desktop/Admin приложений и Android.

---

#### Шаг 3 — Desktop, Admin и Android приложения

Electron-приложения работают на каждом компьютере менеджера / администратора. Им нужно знать адрес локального бэкенда из Шага 2.

##### Запуск в режиме разработки (с нужным бэкендом)

**Windows — PowerShell:**
```powershell
# Desktop (дашборд менеджера)
$env:BACKEND_URL = "http://192.168.1.50:3001"
$env:BACKEND_WS  = "ws://192.168.1.50:3001"
cd desktop
npm install
npm start

# Admin (панель администратора) — в другом терминале
$env:BACKEND_URL = "http://192.168.1.50:3001"
cd admin
npm install
npm start
```

**Linux / macOS:**
```bash
BACKEND_URL=http://192.168.1.50:3001 BACKEND_WS=ws://192.168.1.50:3001 npm start
```

##### Сборка установщика (.exe / .dmg / .AppImage)

```bash
# Desktop
cd desktop
npm install
BACKEND_URL=http://192.168.1.50:3001 BACKEND_WS=ws://192.168.1.50:3001 npm run build
# → dist/desktop-setup.exe (Windows)

# Admin
cd admin
npm install
BACKEND_URL=http://192.168.1.50:3001 npm run build
# → dist/admin-setup.exe
```

> Если local-backend крутится на том же компьютере, где запускается Desktop/Admin — оставь `localhost` (значение по умолчанию). Меняй только когда бэкенд на другой машине в сети.

##### Вход в Admin App

При первом запуске Admin App потребует авторизацию — используй email и пароль с сайта (Шаг 1). Admin App вызывает `POST /api/auth/verify` на website backend для проверки credentials.

##### Android в локальной сети

Android-приложение подключается к local-backend по WebSocket точно так же, как Desktop App. При первом запуске приложение показывает экран логина с полем адреса бэкенда:

1. Введи адрес local-backend: `ws://192.168.1.50:3001` (LAN IP из Шага 2)
2. Введи логин и пароль менеджера (создаются в Admin App)
3. Адрес сохраняется — при следующих запусках восстанавливается автоматически
4. Изменить адрес потом можно в вкладке **Настройки** → поле URL → кнопка **Сохранить**

**Условие:** телефон должен быть в той же Wi-Fi сети, что и машина с local-backend.

---

## Разработка без Docker

```bash
# PostgreSQL должен быть запущен локально
# Применить схему БД:
psql -U sales -d sales_agent -f backend/init.sql

# Установить зависимости Python
pip install -r backend/requirements.txt
pip install -r global-backend/requirements.txt
pip install -r website/backend/requirements.txt

# Запустить сервисы по отдельности (в трёх терминалах):
python global-backend/main.py    # :3002
python backend/main.py           # :3001
python website/backend/main.py   # :3003

# Фронтенд сайта в режиме watch:
cd website/frontend && npm run dev    # http://localhost:5173 (proxy → :3003)

# Electron:
npm run dev:desktop
npm run dev:admin
```

Или сразу всё через concurrently:
```bash
npm run dev         # global + local + desktop
npm run dev:all     # + admin panel
```

---

## Как работает лицензия

1. Пользователь регистрируется на сайте → Website Backend автоматически вызывает `POST /licenses/issue` на Global Backend → создаётся лицензионный ключ вида `SALES-XXXXXXXX...`
2. Пользователь видит ключ на странице Dashboard и копирует его
3. Ключ прописывается в `backend/.env` → `LICENSE_KEY=SALES-...`
4. При старте Local Backend валидирует ключ через Global Backend (кэш 1 час)
5. Каждый AI-вызов (транскрипция + анализ) проверяет лицензию и записывает usage
6. Если `LICENSE_KEY` не задан — работает в dev-режиме без ограничений (все AI-запросы проходят)
7. Если `REQUIRE_LICENSE=true` на Global Backend — запросы без валидного ключа отклоняются с `403`

---

## Сайт и панель администратора

Сайт доступен по адресу Beget VPS (или `http://localhost:3003` в dev-режиме).

| Страница | URL | Описание |
|----------|-----|----------|
| Лендинг | `/` | Регистрация / вход |
| Личный кабинет | `/dashboard` | Лицензионный ключ, ссылки на скачивание |
| Панель владельца | `/admin` | Управление пользователями |

**Вход в панель владельца** (`/admin`):
- Логин: значение `SITE_ADMIN_USER` (по умолчанию `admin`)
- Пароль: значение `SITE_ADMIN_PASS` (по умолчанию `admin`, **обязательно сменить**)
- Доступно: список всех пользователей, статистика, блокировка/разблокировка

---

## Android-приложение

### Сборка в Android Studio

1. `File → Open → sales-agent-v3/android`
2. Дождись Gradle sync (5–10 мин при первом запуске)
3. `Tools → Device Manager → Create Device → Pixel 7 → Android 14` (для эмулятора)
4. Нажми ▶ Run

### Подключение к бэкенду

В приложении открой вкладку **Настройки** и укажи адрес локального бэкенда:

```
ws://192.168.1.50:3001
```

Телефон и компьютер с local-backend должны быть в одной Wi-Fi сети.

---

## API Reference

### Local Backend (:3001)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/health` | Статус всех компонентов |
| GET | `/api/license/status` | Текущий статус лицензии |
| POST | `/api/license/activate` | Активировать лицензионный ключ |
| GET / POST | `/api/calls` | Список звонков / создать звонок |
| PUT / DELETE | `/api/calls/{id}` | Изменить / удалить звонок |
| GET / POST | `/api/contacts` | Контакты |
| GET / PUT / DELETE | `/api/contacts/{id}` | Контакт по ID |
| GET / POST | `/api/managers` | Менеджеры |
| PUT / DELETE | `/api/managers/{id}` | Изменить / удалить менеджера |
| POST | `/api/managers/{id}/stats` | Обновить статистику менеджера |
| DELETE | `/api/managers/{id}/reset` | Сбросить статистику |
| GET / PUT | `/api/settings/{key}` | Настройки |
| POST | `/api/notify` | Telegram-уведомление |
| GET | `/api/sip/config` | Конфигурация SIP/FreePBX |
| POST | `/api/transcribe` | Аудио → транскрипт (прокси к Global Backend) |
| POST | `/api/analyze` | Текст → анализ (прокси к Global Backend) |
| GET | `/api/jobs/{id}` | Статус фонового задания |
| GET | `/api/plans` | Тарифные планы |
| GET | `/api/licenses` | Список лицензий |
| WS | `/` | WebSocket-стрим (аудио от Desktop / Android) |

### Global Backend (:3002)

Запросы, требующие прав администратора, передают заголовок `X-Admin-Secret: <ADMIN_SECRET>`.

| Метод | Путь | Доступ | Описание |
|-------|------|--------|----------|
| GET | `/health` | Public | Статус сервиса |
| POST | `/process` | License | Аудио-файл → транскрипт + анализ |
| POST | `/analyze` | License | Текст → анализ звонка |
| GET | `/plans` | Admin | Список тарифных планов |
| GET | `/licenses` | Admin | Список всех лицензий |
| POST | `/licenses/issue` | Admin | Выдать новую лицензию |
| POST | `/licenses/validate` | Public | Проверить лицензионный ключ |
| POST | `/licenses/usage` | Public | Записать использование |
| GET | `/licenses/{key}/status` | Public | Статус конкретной лицензии |
| PATCH | `/licenses/{key}` | Admin | Изменить параметры лицензии |
| DELETE | `/licenses/{key}` | Admin | Отозвать лицензию |

### Website Backend (:3003)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/auth/register` | Регистрация (авто-выдаёт лицензию) |
| POST | `/api/auth/login` | Вход пользователя |
| POST | `/api/auth/verify` | Проверка credentials (используется Admin App) |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/user/me` | Данные пользователя + лицензионный ключ |
| GET | `/api/user/downloads` | Ссылки на скачивание приложений |
| POST | `/api/admin/login` | Вход владельца системы |
| GET | `/api/admin/users` | Список зарегистрированных пользователей |
| GET | `/api/admin/stats` | Статистика (пользователи, звонки) |
| PATCH | `/api/admin/users/{id}/toggle` | Заблокировать / разблокировать пользователя |

---

## Groq лимиты (бесплатный план)

| Сервис | Модель | Лимит |
|--------|--------|-------|
| Транскрипция | Whisper Large v3 Turbo | 7 200 мин аудио / день |
| Анализ | LLaMA 3.3 70b | 14 400 запросов / день |

Ключи: [console.groq.com](https://console.groq.com) → API Keys → Create API Key
