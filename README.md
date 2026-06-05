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
    - [Шаг 1 — Глобальный бэкенд на VPS](#шаг-1--глобальный-бэкенд-на-vps)
    - [Шаг 2 — Сайт на Beget VPS](#шаг-2--сайт-на-beget-vps)
    - [Шаг 3 — Локальный бэкенд в локальной сети](#шаг-3--локальный-бэкенд-в-локальной-сети)
    - [Шаг 4 — Desktop и Admin приложения](#шаг-4--desktop-и-admin-приложения)
- [Разработка без Docker](#разработка-без-docker)
- [Как работает лицензия](#как-работает-лицензия)
- [Сайт и панель администратора](#сайт-и-панель-администратора)
- [Android-приложение](#android-приложение)
- [API Reference](#api-reference)
- [Groq лимиты](#groq-лимиты-бесплатный-план)

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERNET                                                        │
│                                                                  │
│  ┌───────────────────────────────┐                              │
│  │  WEBSITE  :3003               │   ← Beget VPS                │
│  │  React SPA + FastAPI          │                              │
│  │  Регистрация, скачивания,     │                              │
│  │  панель владельца системы     │                              │
│  └───────────────┬───────────────┘                              │
│                  │ GLOBAL_BACKEND_URL (HTTP)                    │
│  ┌───────────────▼───────────────┐                              │
│  │  GLOBAL BACKEND  :3002        │   ← Другой VPS               │
│  │  AI-шлюз: Groq Whisper + LLM  │                              │
│  │  Лицензирование               │                              │
│  │  PostgreSQL :5432             │                              │
│  └───────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
                  ▲ GLOBAL_BACKEND_URL (HTTP)
                  │
┌─────────────────┴───────────────────────────────────────────────┐
│  ЛОКАЛЬНАЯ СЕТЬ (офис)                                           │
│                                                                  │
│  ┌─────────────────────────────────────┐                        │
│  │  LOCAL BACKEND  :3001               │  ← один на офис        │
│  │  FastAPI + PostgreSQL               │                        │
│  │  Менеджеры, звонки, контакты        │                        │
│  └───────┬──────────────────┬──────────┘                        │
│          │ WebSocket        │ HTTP                               │
│  ┌───────▼──────┐  ┌────────▼───────┐                          │
│  │ Desktop App  │  │   Admin App    │  ← на каждом компьютере  │
│  │  (Electron)  │  │   (Electron)   │                          │
│  └──────────────┘  └────────────────┘                          │
│                                                                  │
│  ┌───────────────────────┐                                      │
│  │  Android / телефон    │  ← WebSocket ws://LAN-IP:3001        │
│  └───────────────────────┘                                      │
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
Beget VPS       →  сайт (регистрация, скачивания)
Другой VPS      →  global backend (AI + лицензии)
Каждый офис     →  local backend + desktop/admin на ПК
```

> **Важно:** Beget **shared hosting** не подходит — FastAPI требует постоянный процесс (uvicorn), а PostgreSQL на базовом shared не предоставляется. Нужен именно **Beget VPS** (Linux, от ~300 руб/мес).

---

#### Шаг 1 — Глобальный бэкенд на VPS

Этот сервис — центральный AI-шлюз. Запускается один раз, доступен всем остальным компонентам через интернет.

**Требования на VPS:** Docker, Docker Compose, открытый порт `3002`

**1.1. Скопировать файлы на VPS**

```bash
# на своём компьютере
scp -r global-backend/ backend/init.sql docker-compose.vps.yml user@VPS-IP:~/sales/
```

Или через git:
```bash
git clone <repo> ~/sales && cd ~/sales
```

**1.2. Создать .env**

```bash
cp global-backend/.env.example global-backend/.env
nano global-backend/.env
```

```env
PORT=3002
GROQ_API_KEY=gsk_...                  # https://console.groq.com → API Keys
ADMIN_SECRET=придумай-сложный-пароль  # используется во всех остальных компонентах
REQUIRE_LICENSE=true                  # включить проверку лицензий в продакшене
DATABASE_URL=postgresql://sales:sales_pass@postgres:5432/sales_agent
```

**1.3. Запустить**

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

**1.4. Открыть порт в файрволе VPS**

```bash
# UFW (Ubuntu)
ufw allow 3002/tcp

# firewalld (CentOS/RHEL)
firewall-cmd --permanent --add-port=3002/tcp && firewall-cmd --reload
```

**1.5. Проверить**

```bash
curl http://VPS-IP:3002/health
# → {"status":"ok","groq":true}
```

> Опционально: настрой nginx как reverse proxy и добавь SSL-сертификат (Let's Encrypt), чтобы использовать `https://api.yourdomain.com` вместо голого IP.

---

#### Шаг 2 — Сайт на Beget VPS

Сайт — публичная часть: регистрация пользователей, выдача лицензий, страница скачивания.

**Требования на Beget VPS:** Docker, Docker Compose, Node.js (для сборки фронтенда), открытый порт `3003` (или nginx на 80/443)

**2.1. Собрать фронтенд локально и загрузить на сервер**

```bash
# на своём компьютере
cd website/frontend
npm install
npm run build   # собирает React в website/backend/static/
cd ../..

# загрузить на Beget VPS
scp -r website/ backend/init.sql docker-compose.beget.yml user@BEGET-IP:~/sales/
```

**2.2. Создать .env**

```bash
cp website/backend/.env.example website/backend/.env
nano website/backend/.env
```

```env
PORT=3003
DATABASE_URL=postgresql://sales:sales_pass@postgres:5432/sales_agent

# Адрес глобального бэкенда (VPS из Шага 1)
GLOBAL_BACKEND_URL=http://VPS-IP:3002

# Тот же пароль, что ADMIN_SECRET в global-backend/.env
GLOBAL_ADMIN_SECRET=придумай-сложный-пароль

# Логин/пароль для страницы /admin на сайте
SITE_ADMIN_USER=admin
SITE_ADMIN_PASS=сильный-пароль-для-владельца

# Прямые ссылки на файлы для скачивания (куда ты выложишь сборки)
DOWNLOAD_DESKTOP=https://files.yourdomain.com/desktop-setup.exe
DOWNLOAD_ADMIN=https://files.yourdomain.com/admin-setup.exe
DOWNLOAD_BACKEND=https://files.yourdomain.com/docker-compose.local.yml
DOWNLOAD_ANDROID=https://files.yourdomain.com/sales-analyzer.apk
```

**2.3. Запустить**

```bash
docker compose -f docker-compose.beget.yml up -d --build
```

**2.4. Открыть порт**

```bash
ufw allow 3003/tcp
```

**2.5. Проверить**

Открой в браузере `http://BEGET-IP:3003` — должна появиться страница регистрации.

**2.6. (Рекомендуется) Nginx + SSL**

Установи nginx и certbot, создай конфиг:

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
certbot --nginx -d yourdomain.com
```

---

#### Шаг 3 — Локальный бэкенд в локальной сети

Один экземпляр на офис (или на каждый изолированный сегмент сети). Хранит звонки, контакты, менеджеров. Получает AI-анализ от глобального бэкенда.

**Требования на LAN-машине:** Docker, Docker Compose, Python 3.12 (если без Docker), ffmpeg

**3.1. Скопировать файлы**

```bash
# на LAN-машине (Windows — через PowerShell или Git Bash)
git clone <repo> C:\sales-agent
# или скопировать папки backend/ и docker-compose.local.yml вручную
```

**3.2. Создать .env**

```bash
cp backend/.env.example backend/.env
```

Открыть `backend/.env` и заполнить:

```env
PORT=3001
DATABASE_URL=postgresql://sales:sales_pass@postgres:5432/sales_agent

# Адрес глобального бэкенда (VPS из Шага 1)
GLOBAL_BACKEND_URL=http://VPS-IP:3002

# Тот же пароль, что ADMIN_SECRET в global-backend/.env
GLOBAL_ADMIN_SECRET=придумай-сложный-пароль

# Лицензионный ключ — получить на сайте после регистрации (Шаг 2)
# Оставь пустым для dev-режима без лицензии
LICENSE_KEY=SALES-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# FreePBX / SIP (если используется IP-телефония)
FREEPBX_HOST=192.168.1.100    # IP АТС
FREEPBX_DOMAIN=office.local
FREEPBX_EXTENSION=1000
FREEPBX_PASSWORD=sip-password

# Telegram-уведомления (опционально)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

**3.3. Запустить**

```bash
docker compose -f docker-compose.local.yml up -d --build
```

**3.4. Проверить**

```bash
curl http://localhost:3001/api/health
# → {"status":"ok","database":"connected","license":"..."}
```

**3.5. Узнать LAN IP машины**

```powershell
# Windows
ipconfig | findstr "IPv4"
# например: 192.168.1.50
```

```bash
# Linux
ip addr show | grep "inet "
```

Запомни этот IP — он понадобится в Шаге 4 для настройки Electron-приложений.

---

#### Шаг 4 — Desktop и Admin приложения

Electron-приложения работают на каждом компьютере менеджера / администратора. Им нужно знать адрес локального бэкенда из Шага 3.

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

При первом запуске Admin App потребует авторизацию — используй email и пароль с сайта (Шаг 2). Admin App вызывает `POST /api/auth/verify` на website backend для проверки credentials.

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
