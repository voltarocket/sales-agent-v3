# Sales Call Analyzer v3

Система анализа звонков менеджеров по продажам на базе ИИ.  
Телефон записывает разговор → локальный бэкенд передаёт файл → глобальный бэкенд транскрибирует и оценивает через Groq → десктоп показывает результаты в реальном времени.

---

## Содержание

- [Архитектура](#архитектура)
- [Структура проекта](#структура-проекта)
- [Быстрый старт для конечного пользователя](#быстрый-старт-для-конечного-пользователя)
- [Варианты развёртывания](#варианты-развёртывания)
  - [Вариант A — всё на одном сервере (разработка / тест)](#вариант-a--всё-на-одном-сервере-разработка--тест)
  - [Вариант B — распределённый продакшен](#вариант-b--распределённый-продакшен)
    - [Шаг 1 — Beget VPS: global backend + сайт](#шаг-1--beget-vps-global-backend--сайт)
    - [Шаг 2 — Локальный бэкенд в локальной сети](#шаг-2--локальный-бэкенд-в-локальной-сети)
    - [Шаг 3 — Desktop, Admin и Android приложения](#шаг-3--desktop-admin-и-android-приложения)
- [Сборка и выпуск релиза](#сборка-и-выпуск-релиза)
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
│  │  Python/FastAPI + PostgreSQL        │                        │
│  │  Менеджеры, звонки, контакты, Auth  │                        │
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
| Admin App | Local Backend | HTTP + `x-auth-token` | CRUD: менеджеры, звонки, настройки |
| Local Backend | Global Backend | HTTP | Аудио-файл или текст для анализа |
| Local Backend | Website Backend | HTTP | Проверка credentials при входе в Admin App |
| Website Backend | Global Backend | HTTP | Выдача лицензий при регистрации |

---

## Структура проекта

```
sales-agent-v3/
│
├── backend/                    ← Локальный бэкенд (Python/FastAPI :3001)
│   ├── main.py                 ← Весь API: Auth, звонки, контакты, менеджеры, WebSocket, AI-очередь
│   ├── init.sql                ← Схема БД (применяется при первом запуске Docker)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
│
├── global-backend/             ← Глобальный бэкенд (Python/FastAPI :3002)
│   ├── main.py                 ← /process, /analyze, /licenses, license guard, AI логика (Groq Whisper, LLM анализ)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
│
├── website/
│   ├── backend/                ← Website FastAPI :3003
│   │   ├── main.py             ← Регистрация, авторизация, выдача лицензий, /admin API
│   │   ├── Dockerfile
│   │   └── .env.example
│   └── frontend/               ← React + Vite
│       └── src/
│           ├── pages/Home.jsx          ← Лендинг + регистрация
│           ├── pages/Login.jsx         ← Вход
│           ├── pages/Dashboard.jsx     ← Ключ + кнопки скачать
│           └── pages/Admin.jsx         ← Управление пользователями
│
├── desktop/                    ← Electron (дашборд менеджера)
│   ├── src/main.js             ← Читает BACKEND_URL из installer или env
│   ├── installer.nsh           ← NSIS: доп. страница с вводом BACKEND_URL
│   └── package.json
│
├── admin/                      ← Electron (панель администратора)
│   ├── src/main.js             ← Вход через email/пароль сайта
│   ├── installer.nsh           ← NSIS: доп. страница с вводом BACKEND_URL
│   └── package.json
│
├── installer/                  ← Electron-визард установки бэкенда
│   └── src/
│       ├── main.js             ← Проверка Docker, запись .env, docker compose up
│       └── index.html          ← 4-шаговый UI мастера установки
│
├── android/                    ← Kotlin (запись звонков с телефона)
│
├── .github/workflows/
│   ├── release.yml             ← Сборка всех инсталляторов и создание GitHub Release
│   └── update-download-urls.yml← Вывод ссылок для website .env после релиза
│
├── docker-compose.yml          ← Всё на одном хосте (разработка / тест)
├── docker-compose.vps.yml      ← Global backend + website + postgres (VPS)
├── docker-compose.local.yml    ← Local backend + postgres (офисная машина)
└── package.json                ← npm-скрипты для разработки
```

---

## Быстрый старт для конечного пользователя

> Это раздел для клиентов, которые уже зарегистрировались на сайте.

**1. Скачайте и установите приложения** со страницы [Releases](https://github.com/voltarocket/sales-agent-v3/releases/latest) или из личного кабинета на сайте:

| Файл | Назначение |
|------|-----------|
| `SalesBackend-Installer.exe` | Локальный сервер — **один раз на офис** |
| `SalesAdmin-Setup.exe` | Панель администратора |
| `SalesAnalyzer-Setup.exe` | Приложение менеджера (на каждый ПК) |

**2. Установите бэкенд первым**

Запустите `SalesBackend-Installer.exe` от имени администратора. Визард:
- Проверит наличие Docker Desktop (предложит скачать если нет)
- Попросит ввести адрес сайта и Groq API ключ
- Автоматически скачает образы и запустит сервисы
- Покажет IP-адрес этого компьютера (нужен для шага 3)

**3. Установите Admin App и Desktop App**

При установке каждого из них введите IP из предыдущего шага:
```
http://192.168.1.X:3001
```

**4. Войдите в Admin App**

Используйте email и пароль от аккаунта на сайте. Лицензия активируется автоматически.

**5. Создайте менеджеров в Admin App**

Менеджеры входят в Desktop App через свой логин и пароль.

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
WEBSITE_URL=http://localhost:3003    # для входа в Admin App через аккаунт сайта
```

`website/backend/.env`:
```env
GLOBAL_ADMIN_SECRET=my-secret-123
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
docker compose up --build
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
Beget VPS   →  global backend + website (docker-compose.vps.yml)
Каждый офис →  local backend + desktop/admin на ПК (docker-compose.local.yml)
```

> **Важно:** Beget **shared hosting** не подходит — нужен **Beget VPS** (Linux, от ~300 руб/мес).

---

#### Шаг 1 — Beget VPS: global backend + сайт

**Требования:** Docker, Docker Compose, открытые порты `3002` и `3003`

**1.1. Загрузить проект на VPS**

```bash
git clone https://github.com/voltarocket/sales-agent-v3.git ~/sales && cd ~/sales
```

**1.2. Собрать фронтенд сайта**

```bash
cd website/frontend && npm install && npm run build && cd ../..
```

**1.3. Создать .env для global backend**

```bash
cp global-backend/.env.example global-backend/.env
nano global-backend/.env
```

```env
GROQ_API_KEY=gsk_...
ADMIN_SECRET=придумай-сложный-пароль
REQUIRE_LICENSE=true
```

**1.4. Создать .env для сайта**

```bash
cp website/backend/.env.example website/backend/.env
nano website/backend/.env
```

```env
GLOBAL_BACKEND_URL=http://global-backend:3002
GLOBAL_ADMIN_SECRET=придумай-сложный-пароль
SITE_ADMIN_USER=admin
SITE_ADMIN_PASS=сильный-пароль-для-владельца

# Ссылки из GitHub Releases (заполнить после первого релиза)
DOWNLOAD_DESKTOP=https://github.com/voltarocket/sales-agent-v3/releases/download/v1.0.0/SalesAnalyzer-Setup.exe
DOWNLOAD_ADMIN=https://github.com/voltarocket/sales-agent-v3/releases/download/v1.0.0/SalesAdmin-Setup.exe
DOWNLOAD_BACKEND=https://github.com/voltarocket/sales-agent-v3/releases/download/v1.0.0/SalesBackend-Installer.exe
DOWNLOAD_ANDROID=https://github.com/voltarocket/sales-agent-v3/releases/download/v1.0.0/sales-analyzer.apk
```

**1.5. Запустить**

```bash
docker compose -f docker-compose.vps.yml up -d --build
```

**1.6. Открыть порты в файрволе**

```bash
ufw allow 3002/tcp
ufw allow 3003/tcp
```

**1.7. Проверить**

```bash
curl http://BEGET-IP:3002/health   # → {"status":"ok"}
# Открой в браузере: http://BEGET-IP:3003
```

**1.8. (Рекомендуется) Nginx + SSL**

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

Один экземпляр на офис. Хранит звонки, контакты, менеджеров. AI-анализ получает от Global Backend на VPS.

**Требования:** Docker Desktop, открытый порт `3001` в локальной сети

> Проще всего использовать `SalesBackend-Installer.exe` из [Releases](https://github.com/voltarocket/sales-agent-v3/releases/latest) — он сделает всё автоматически.

**Ручная установка:**

```bash
cp backend/.env.example backend/.env
```

`backend/.env`:
```env
GLOBAL_BACKEND_URL=http://BEGET-IP:3002
GLOBAL_ADMIN_SECRET=придумай-сложный-пароль
WEBSITE_URL=https://yourdomain.com    # для входа в Admin App через аккаунт сайта

# FreePBX / SIP (если используется IP-телефония)
FREEPBX_HOST=192.168.1.100
FREEPBX_EXTENSION=1000
FREEPBX_PASSWORD=sip-password

# Telegram-уведомления (опционально)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

```bash
docker compose -f docker-compose.local.yml up -d --build
curl http://localhost:3001/api/health
```

Узнать LAN IP этой машины:
```powershell
ipconfig | findstr "IPv4"   # Windows
```

---

#### Шаг 3 — Desktop, Admin и Android приложения

> Проще всего использовать готовые инсталляторы из [Releases](https://github.com/voltarocket/sales-agent-v3/releases/latest) — при установке они попросят ввести IP бэкенда.

**Запуск в режиме разработки:**

```powershell
# Windows PowerShell
$env:BACKEND_URL = "http://192.168.1.50:3001"
$env:BACKEND_WS  = "ws://192.168.1.50:3001"
cd desktop && npm install && npm start
```

**Вход в Admin App:**  
Email и пароль от аккаунта на сайте. Лицензия активируется автоматически.

**Android:**  
Укажи `ws://192.168.1.50:3001` при первом запуске. Телефон должен быть в той же Wi-Fi сети.

---

## Сборка и выпуск релиза

Инсталляторы собираются автоматически через **GitHub Actions** при создании тега.

```bash
git tag v1.0.0
git push origin v1.0.0
```

Workflow `.github/workflows/release.yml`:
1. Запускает сборку на `windows-latest`
2. Собирает `desktop`, `admin` и `installer` через `electron-builder`
3. Создаёт GitHub Release с прикреплёнными `.exe` файлами
4. Второй workflow выводит готовые `DOWNLOAD_*` строки для `website/backend/.env`

После релиза обнови ссылки на VPS:

```bash
nano website/backend/.env   # обновить DOWNLOAD_* на новые URL из релиза
docker compose -f docker-compose.vps.yml restart website
```

**Ручная сборка:**

```bash
cd desktop   && npm install && npm run build   # → desktop/dist/
cd admin     && npm install && npm run build   # → admin/dist/
cd installer && npm install && npm run build   # → installer/dist/
```

---

## Разработка без Docker

```bash
# PostgreSQL должен быть запущен локально
psql -U sales -d sales_agent -f backend/init.sql

# Python бэкенды (FastAPI):
cd backend        && python main.py   # :3001
cd global-backend && python main.py   # :3002

# Website:
cd website/backend  && python main.py   # :3003
cd website/frontend && npm run dev      # :5173 (proxy → :3003)

# Electron:
cd desktop && npm start
cd admin   && npm start
```

---

## Как работает лицензия

1. Пользователь регистрируется на сайте → Website Backend выдаёт лицензионный ключ автоматически
2. Ключ отображается в личном кабинете (`/dashboard`)
3. При входе в Admin App (email + пароль сайта) → Local Backend получает ключ и активирует лицензию автоматически
4. При каждом AI-запросе Local Backend проверяет лицензию через Global Backend (кэш 1 час)
5. Если `LICENSE_KEY` не задан — dev-режим без ограничений
6. Если `REQUIRE_LICENSE=true` на Global Backend — запросы без валидного ключа возвращают `403`

---

## Сайт и панель администратора

| Страница | URL | Описание |
|----------|-----|----------|
| Лендинг | `/` | Регистрация |
| Вход | `/login` | Вход в аккаунт |
| Личный кабинет | `/dashboard` | Лицензионный ключ, ссылки на скачивание |
| Панель владельца | `/admin` | Управление пользователями |

**Вход в `/admin`:**
- Логин: `SITE_ADMIN_USER` (по умолчанию `admin`)
- Пароль: `SITE_ADMIN_PASS` (**обязательно сменить в продакшене**)

---

## Android-приложение

### Сборка в Android Studio

1. `File → Open → sales-agent-v3/android`
2. Дождись Gradle sync (~5 мин)
3. Нажми ▶ Run

### Подключение к бэкенду

При первом запуске введи адрес локального бэкенда:
```
ws://192.168.1.50:3001
```
Телефон и компьютер с бэкендом должны быть в одной Wi-Fi сети.

---

## API Reference

### Local Backend (:3001)

#### Auth

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/auth/login` | Вход менеджера (username + password) |
| GET | `/api/auth/me` | Текущий менеджер (заголовок `x-auth-token`) |
| POST | `/api/auth/admin` | Вход администратора (email + password от сайта) |
| POST | `/api/auth/logout` | Выход |

#### Данные

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/health` | Статус всех компонентов |
| GET | `/api/license/status` | Текущий статус лицензии |
| GET / POST | `/api/calls` | Список звонков / создать |
| PUT / DELETE | `/api/calls/:id` | Изменить / удалить |
| GET / POST | `/api/contacts` | Контакты |
| GET / PUT / DELETE | `/api/contacts/:id` | Контакт по ID |
| GET / POST | `/api/managers` | Менеджеры |
| GET | `/api/managers/:id/calls` | Звонки менеджера |
| PUT / DELETE | `/api/managers/:id` | Изменить / удалить |
| POST | `/api/managers/:id/stats` | Обновить статистику |
| DELETE | `/api/managers/:id/reset` | Сбросить статистику |
| GET | `/api/settings` | Все настройки |
| PUT | `/api/settings` | Обновить настройки (bulk) |
| PUT | `/api/settings/:key` | Обновить одну настройку |
| POST | `/api/notify` | Telegram-уведомление |
| GET | `/api/sip/config` | Конфигурация SIP/FreePBX |
| POST | `/api/transcribe` | Аудио → транскрипт (прокси) |
| POST | `/api/analyze` | Текст → анализ (прокси) |
| WS | `/` | Аудио-стрим от Desktop / Android |

### Global Backend (:3002)

Заголовок `X-Admin-Secret` для Admin-эндпоинтов.

| Метод | Путь | Доступ | Описание |
|-------|------|--------|----------|
| GET | `/health` | Public | Статус |
| POST | `/process` | License | Аудио → транскрипт + анализ |
| POST | `/analyze` | License | Текст → анализ |
| GET | `/plans` | Admin | Тарифные планы |
| GET | `/licenses` | Admin | Все лицензии |
| POST | `/licenses/issue` | Admin | Выдать лицензию |
| POST | `/licenses/validate` | Public | Проверить ключ |
| POST | `/licenses/usage` | Public | Записать использование |
| GET | `/licenses/:key/status` | Public | Статус лицензии |
| PATCH | `/licenses/:key` | Admin | Изменить лицензию |
| DELETE | `/licenses/:key` | Admin | Отозвать лицензию |

### Website Backend (:3003)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/auth/register` | Регистрация (авто-выдаёт лицензию) |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/verify` | Проверка credentials (используется Admin App) |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/user/me` | Данные пользователя + ключ |
| GET | `/api/user/downloads` | Ссылки на скачивание |
| POST | `/api/admin/login` | Вход владельца |
| GET | `/api/admin/users` | Список пользователей |
| GET | `/api/admin/stats` | Статистика |
| PATCH | `/api/admin/users/:id/toggle` | Блокировка пользователя |

---

## Groq лимиты (бесплатный план)

| Сервис | Модель | Лимит |
|--------|--------|-------|
| Транскрипция | Whisper Large v3 Turbo | 7 200 мин аудио / день |
| Анализ | LLaMA 3.3 70b | 14 400 запросов / день |

Ключи: [console.groq.com](https://console.groq.com) → API Keys → Create API Key
