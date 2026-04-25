# Sales Call Analyzer v3

Система анализа звонков менеджеров по продажам.
Телефон пишет разговор → локальный бэкенд обрабатывает → глобальный бэкенд транскрибирует и анализирует через ИИ → десктоп показывает результаты.

---

## Архитектура

```
                    ┌─────────────────────────────────┐
                    │  WEBSITE  :3003                  │
                    │  React SPA (Vite)                │
                    │  Регистрация / Скачать приложения│
                    │  FastAPI + PostgreSQL             │
                    └──────────────┬──────────────────┘
                                   │ /api/auth/verify
Desktop / Admin (Electron)         │
        │ REST + WebSocket         │
        ▼                          ▼
┌─────────────────────────────────────────────────────┐
│  LOCAL BACKEND  :3001  (Python / FastAPI)           │
│  Бизнес-логика + PostgreSQL                         │
│  Менеджеры, звонки, контакты, настройки             │
│  In-memory кэш — лицензия + счётчики                │
│  Проверка лицензии перед каждым AI-вызовом          │
└──────────────────────────┬──────────────────────────┘
                           │ HTTP (audio + text)
                           ▼
┌─────────────────────────────────────────────────────┐
│  GLOBAL BACKEND  :3002  (Python / FastAPI)          │
│  AI-шлюз: Groq Whisper + LLaMA 3.3 70b             │
│  Лицензирование: выдача ключей, валидация           │
└──────────────────────────┬──────────────────────────┘
                           │
                    PostgreSQL :5432
```

---

## Структура проекта

```
sales-agent-v3/
├── backend/              ← Локальный бэкенд (Python / FastAPI :3001)
│   ├── main.py           ← Весь API: звонки, контакты, менеджеры, лицензия, WebSocket
│   ├── init.sql          ← Схема БД (авто-применяется в Docker)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── global-backend/       ← Глобальный бэкенд (Python / FastAPI :3002)
│   ├── main.py           ← /process, /analyze, /plans, /licenses
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env.example
├── website/              ← Сайт для регистрации и скачивания
│   ├── backend/          ← FastAPI :3003
│   │   ├── main.py       ← Регистрация, авторизация, выдача лицензий, admin API
│   │   ├── requirements.txt
│   │   ├── Dockerfile
│   │   └── .env.example
│   └── frontend/         ← React + Vite
│       ├── src/
│       │   ├── pages/Home.jsx       ← Лендинг + регистрация
│       │   ├── pages/Login.jsx      ← Вход
│       │   ├── pages/Dashboard.jsx  ← Лицензионный ключ + скачать
│       │   └── pages/Admin.jsx      ← Управление пользователями
│       └── vite.config.js
├── desktop/              ← Electron (дашборд менеджера)
├── admin/                ← Electron (панель администратора)
│   └── src/
│       ├── main.js       ← IPC + auth через website API
│       ├── renderer.js   ← Весь UI (менеджеры, лицензии, настройки)
│       └── preload.js    ← IPC bridge
├── android/              ← Kotlin (запись звонков с телефона)
├── docker-compose.yml    ← Поднимает все сервисы
└── package.json          ← Скрипты для разработки
```

---

## Быстрый старт (Docker)

### 1. Зависимости

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js LTS](https://nodejs.org) (для Electron-приложений и сборки фронтенда)
- [Python 3.12+](https://www.python.org) (для локальной разработки без Docker)
- [ffmpeg](https://ffmpeg.org/download.html) (для разработки без Docker)

### 2. Настройка .env файлов

```bash
# Глобальный бэкенд — AI-ключи
cp global-backend/.env.example global-backend/.env
# вставь GROQ_API_KEY и ADMIN_SECRET

# Локальный бэкенд
cp backend/.env.example backend/.env
# вставь GLOBAL_ADMIN_SECRET (= ADMIN_SECRET выше)

# Сайт
cp website/backend/.env.example website/backend/.env
```

Минимально необходимые переменные:

| Файл | Переменная | Значение |
|------|-----------|----------|
| `global-backend/.env` | `GROQ_API_KEY` | Ключ с [console.groq.com](https://console.groq.com) |
| `global-backend/.env` | `ADMIN_SECRET` | Любая строка-пароль |
| `backend/.env` | `GLOBAL_ADMIN_SECRET` | Та же строка, что `ADMIN_SECRET` выше |

### 3. Сборка фронтенда сайта

```bash
cd website/frontend
npm install
npm run build      # собирает в website/backend/static/
```

### 4. Запуск

```bash
npm run docker:up
```

Поднимает: PostgreSQL, Global Backend (:3002), Local Backend (:3001), Website (:3003).

### 5. Electron-приложения (отдельно)

```bash
npm run install:all    # установить зависимости
npm run dev:desktop    # дашборд менеджера
npm run dev:admin      # панель администратора
```

---

## Разработка без Docker

```bash
# Установить зависимости Python
pip install -r backend/requirements.txt
pip install -r global-backend/requirements.txt
pip install -r website/backend/requirements.txt

# Запустить по отдельности:
python backend/main.py           # local-backend  :3001
python global-backend/main.py    # global-backend :3002
python website/backend/main.py   # website        :3003

# Фронтенд сайта в режиме разработки:
npm run dev:website              # http://localhost:5173

# Electron:
npm run dev:desktop
npm run dev:admin
```

---

## Как работает регистрация и лицензия

1. Пользователь заходит на сайт `:3003` и регистрируется (имя, email, пароль)
2. При регистрации автоматически создаётся **лицензионный ключ** (безлимитный план)
3. На странице Dashboard пользователь видит свой ключ и кнопки скачать приложения
4. Ключ добавляется в `backend/.env`:

```env
LICENSE_KEY=SALES-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

5. При входе в **Admin App** используется тот же email и пароль с сайта
6. Локальный бэкенд при старте валидирует ключ через global-backend (кэш 1 час)
7. Без валидного ключа — AI-вызовы (транскрипция + анализ) блокируются

### Dev-режим

Если `LICENSE_KEY` не задан в `backend/.env` — все AI-запросы работают без ограничений.

---

## Сайт (`/admin`)

Страница `http://localhost:3003/admin` — панель управления пользователями для владельца системы.

- Логин: `admin` / `admin` (настраивается через `SITE_ADMIN_USER` / `SITE_ADMIN_PASS`)
- Просмотр всех зарегистрированных пользователей
- Статистика: всего пользователей, активных, проанализированных звонков
- Блокировка / разблокировка пользователей

---

## Android

### Запуск в Android Studio

1. `File → Open → sales-agent-v3/android`
2. Дождись Gradle sync (5–10 мин первый раз)
3. Создай эмулятор: `Tools → Device Manager → Create Device → Pixel 7 → Android 14`
4. Нажми ▶ Run

### Подключение к бэкенду

В приложении: вкладка **Настройки** → адрес бэкенда:

```
ws://192.168.1.XXX:3001
```

Телефон и компьютер должны быть в одной Wi-Fi сети.

---

## API Reference

### Local Backend (:3001)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/health` | Статус всех компонентов |
| GET | `/api/license/status` | Текущий статус лицензии |
| POST | `/api/license/activate` | Активировать лицензионный ключ |
| GET/POST | `/api/calls` | Звонки |
| PUT/DELETE | `/api/calls/{id}` | Изменить / удалить звонок |
| GET/POST | `/api/contacts` | Контакты |
| GET/PUT/DELETE | `/api/contacts/{id}` | Контакт по ID |
| GET/POST | `/api/managers` | Менеджеры |
| PUT/DELETE | `/api/managers/{id}` | Изменить / удалить менеджера |
| POST | `/api/managers/{id}/stats` | Обновить статистику менеджера |
| DELETE | `/api/managers/{id}/reset` | Сбросить статистику |
| GET/PUT | `/api/settings/{key}` | Настройки |
| POST | `/api/notify` | Telegram-уведомление |
| GET | `/api/sip/config` | Конфигурация SIP/FreePBX |
| POST | `/api/transcribe` | Аудио → транскрипт (прокси) |
| POST | `/api/analyze` | Текст → анализ (прокси) |
| GET | `/api/jobs/{id}` | Статус задачи |
| GET | `/api/plans` | Тарифные планы (прокси) |
| GET | `/api/licenses` | Список лицензий (прокси) |

### Global Backend (:3002)

| Метод | Путь | Доступ | Описание |
|-------|------|--------|----------|
| GET | `/health` | Public | Статус сервиса |
| POST | `/process` | License | Аудио → транскрипт + анализ |
| POST | `/analyze` | License | Текст → анализ |
| GET | `/plans` | Admin | Список планов |
| GET | `/licenses` | Admin | Список лицензий |
| POST | `/licenses/issue` | Admin | Выдать лицензию |
| POST | `/licenses/validate` | Public | Валидировать ключ |
| PATCH | `/licenses/{key}` | Admin | Изменить лицензию |
| DELETE | `/licenses/{key}` | Admin | Отозвать лицензию |

Admin-запросы требуют заголовок `X-Admin-Secret`.

### Website (:3003)

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/auth/register` | Регистрация (авто-выдаёт лицензию) |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/verify` | Проверка credentials (для Electron) |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/user/me` | Данные пользователя + ключ |
| GET | `/api/user/downloads` | Ссылки на скачивание |
| POST | `/api/admin/login` | Вход администратора сайта |
| GET | `/api/admin/users` | Список пользователей |
| GET | `/api/admin/stats` | Статистика |
| PATCH | `/api/admin/users/{id}/toggle` | Блок / разблок |

---

## Groq лимиты (бесплатный план)

| Сервис | Лимит в день |
|--------|-------------|
| Транскрипция (Whisper Large v3) | 7 200 минут аудио |
| Анализ (LLaMA 3.3 70b) | 14 400 запросов |
