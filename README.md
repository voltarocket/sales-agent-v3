# Sales Call Analyzer v3

Система анализа звонков менеджеров по продажам.
Телефон пишет разговор → локальный бэкенд ставит задачу → глобальный бэкенд транскрибирует и анализирует через ИИ → десктоп показывает результаты.

---

## Архитектура

```
Desktop / Admin (Electron)
        │ REST + WebSocket
        ▼
┌─────────────────────────────────┐
│  LOCAL BACKEND  :3001           │
│  Бизнес-логика + PostgreSQL     │
│  Менеджеры, звонки, контакты    │
│  Redis — очередь задач + кэш    │
│  Проверка лицензии              │
└────────────┬────────────────────┘
             │ HTTP (audio + text)
             ▼
┌─────────────────────────────────┐
│  GLOBAL BACKEND  :3002          │
│  AI-шлюз: Groq Whisper + LLaMA  │
│  Лицензирование (выдача ключей) │
│  Управление тарифными планами   │
└─────────────────────────────────┘
             │
     ┌───────┴───────┐
     ▼               ▼
 PostgreSQL :5432   Redis :6379
```

---

## Структура проекта

```
sales-agent-v3/
├── backend/              ← Локальный бэкенд (Node.js + Express)
│   ├── server.js         ← API + WebSocket + прокси к global-backend
│   ├── db.js             ← PostgreSQL пул
│   ├── redis.js          ← ioredis + статусы задач
│   ├── license.js        ← Валидация лицензии, кэш, rate limit
│   ├── init.sql          ← Схема БД (авто-применяется в Docker)
│   └── .env.example
├── global-backend/       ← Глобальный бэкенд (Node.js + Express)
│   ├── server.js         ← /process, /analyze, /plans, /licenses
│   ├── licenses.js       ← Операции с лицензиями и планами (PostgreSQL)
│   └── .env.example
├── desktop/              ← Electron (дашборд менеджера)
├── admin/                ← Electron (панель администратора)
│   └── src/
│       ├── main.js       ← IPC + локальная БД
│       ├── renderer.js   ← Весь UI (менеджеры, лицензии, настройки)
│       └── preload.js    ← IPC bridge
├── android/              ← Kotlin (запись звонков с телефона)
├── docker-compose.yml    ← Поднимает все 4 сервиса
└── package.json          ← Скрипты для разработки
```

---

## Быстрый старт (Docker)

### 1. Зависимости

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js LTS](https://nodejs.org) (для Electron-приложений)
- [ffmpeg](https://ffmpeg.org/download.html) (для локальной разработки без Docker)

### 2. Настройка .env файлов

```bash
# Глобальный бэкенд — AI-ключи
cp global-backend/.env.example global-backend/.env
notepad global-backend/.env   # вставь GROQ_API_KEY и ADMIN_SECRET

# Локальный бэкенд
cp backend/.env.example backend/.env
notepad backend/.env          # вставь GLOBAL_ADMIN_SECRET (= ADMIN_SECRET выше)
```

Минимально необходимые переменные:

| Файл | Переменная | Значение |
|------|-----------|----------|
| `global-backend/.env` | `GROQ_API_KEY` | Ключ с [console.groq.com](https://console.groq.com) |
| `global-backend/.env` | `ADMIN_SECRET` | Любая строка-пароль для администратора |
| `backend/.env` | `GLOBAL_ADMIN_SECRET` | Та же строка, что `ADMIN_SECRET` выше |

### 3. Запуск

```bash
npm run docker:up
```

Это поднимет: PostgreSQL, Redis, Global Backend, Local Backend.

### 4. Electron-приложения (отдельно)

```bash
npm run install:all    # установить зависимости
npm run dev:desktop    # дашборд менеджера
npm run dev:admin      # панель администратора
```

---

## Разработка без Docker

Требуется локально: Node.js, PostgreSQL, Redis, ffmpeg.

```bash
# Запустить всё сразу
npm run dev:all

# Или по отдельности:
npm run dev:global    # global-backend :3002
npm run dev:local     # local-backend  :3001
npm run dev:desktop   # Electron менеджер
npm run dev:admin     # Electron администратор
```

---

## Лицензирование

### Как работает

1. **Глобальный бэкенд** выдаёт лицензионные ключи и хранит тарифные планы в PostgreSQL.
2. **Локальный бэкенд** при старте валидирует ключ (результат кэшируется в Redis на 1 час).
3. Перед каждым AI-вызовом проверяется счётчик использования в Redis.
4. После успешного анализа — счётчик инкрементируется и асинхронно отправляется в global-backend.

### Тарифные планы (по умолчанию)

| План | Устройств | Запросов/мес |
|------|-----------|-------------|
| `basic` | 1 | 100 |
| `pro` | 5 | 1 000 |
| `enterprise` | ∞ | ∞ |

Планы хранятся в базе данных и редактируются через **Admin Panel → Лицензии → Тарифные планы**.

### Выдать лицензию через Admin Panel

1. Открой Admin Panel
2. Войди (по умолчанию: `admin` / `admin`)
3. Перейди в раздел **Лицензии**
4. Нажми **+ Выдать лицензию**, выбери клиента и план
5. Скопируй выданный ключ и добавь в `backend/.env`:

```env
LICENSE_KEY=SALES-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
DEVICE_ID=my-server-1   # опционально, иначе auto
```

### Выдать лицензию через API

```bash
curl -X POST http://localhost:3002/licenses/issue \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{ "customer": "ООО Ромашка", "plan": "pro" }'
```

### Изменить план лицензии

Через Admin Panel: раздел **Лицензии** → выпадающий список в строке лицензии.

Или через API:

```bash
curl -X PATCH http://localhost:3002/licenses/SALES-XXXX... \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{ "plan": "enterprise" }'
```

### Изменить условия плана

Через Admin Panel: **Лицензии → Тарифные планы → ✏ (редактировать)**.

Или через API:

```bash
curl -X PUT http://localhost:3002/plans/pro \
  -H "X-Admin-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{ "max_devices": 10, "requests_per_month": 2000 }'
```

### Dev-режим (без лицензии)

Если `LICENSE_KEY` не задан в `backend/.env` — все AI-запросы работают без ограничений.

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

Узнать IP компьютера:

```bash
ipconfig    # Windows
```

Телефон и компьютер должны быть в одной Wi-Fi сети.

---

## API Reference

### Local Backend (:3001)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/health` | Статус всех компонентов |
| GET | `/api/license/status` | Текущий статус лицензии |
| GET/POST | `/api/calls` | Звонки |
| GET/POST/PUT/DELETE | `/api/contacts` | Контакты |
| GET/POST/PUT/DELETE | `/api/managers` | Менеджеры |
| GET/PUT | `/api/settings` | Настройки |
| POST | `/api/notify` | Telegram уведомление |
| GET | `/api/plans` | Список тарифных планов |
| POST | `/api/plans` | Создать план |
| PUT | `/api/plans/:name` | Изменить план |
| GET | `/api/licenses` | Список лицензий |
| POST | `/api/licenses/issue` | Выдать лицензию |
| PUT | `/api/licenses/:key` | Изменить план лицензии |
| DELETE | `/api/licenses/:key` | Отозвать лицензию |

### Global Backend (:3002)

| Метод | Путь | Доступ | Описание |
|-------|------|--------|----------|
| GET | `/health` | Public | Статус сервиса |
| POST | `/process` | License | Аудио → транскрипт + анализ |
| POST | `/analyze` | License | Текст → анализ |
| GET | `/plans` | Admin | Список планов |
| POST | `/plans` | Admin | Создать план |
| PUT | `/plans/:name` | Admin | Изменить план |
| DELETE | `/plans/:name` | Admin | Удалить план |
| GET | `/licenses` | Admin | Список лицензий |
| POST | `/licenses/issue` | Admin | Выдать лицензию |
| POST | `/licenses/validate` | Public | Валидировать ключ |
| PATCH | `/licenses/:key` | Admin | Изменить лицензию |
| DELETE | `/licenses/:key` | Admin | Отозвать лицензию |

Admin-запросы требуют заголовок `X-Admin-Secret`.

---

## Groq лимиты (бесплатный план)

| Сервис | Лимит в день |
|--------|-------------|
| Транскрипция (Whisper Large v3) | 7 200 минут аудио |
| Анализ (LLaMA 3.3 70b) | 14 400 запросов |
