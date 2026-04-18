# Sales Call Analyzer

Десктопное приложение для анализа звонков менеджеров по продажам.

## Структура

```
sales-agent-v3/
├── backend/       ← Node.js API + WebSocket сервер
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── desktop/       ← Electron приложение
│   ├── src/
│   │   ├── main.js      ← Electron main process
│   │   ├── preload.js   ← IPC bridge
│   │   ├── index.html   ← Shell
│   │   └── renderer.js  ← Весь UI
│   └── package.json
├── android/       ← Kotlin Android приложение
└── package.json   ← запуск всего одной командой
```

## Запуск

### 1. Установить зависимости
```bash
npm run install:all
```

### 2. Создать .env
```bash
cp backend/.env.example backend/.env
notepad backend/.env
```
Вставить:
```
GROQ_API_KEY=gsk_твой_ключ
PORT=3001
```

### 3. Запустить
```bash
npm run dev
```

Откроется Electron окно с полным дашбордом.

## Как пользоваться

1. Вкладка **Звонок** — выбери менеджера, введи номер клиента, нажми "Начать запись"
2. Говори с клиентом — микрофон пишется и стримится на бэкенд
3. Нажми "Завершить звонок" — AI автоматически транскрибирует и анализирует
4. Появится окно: "Сохранить клиента?" → Да/Нет
5. Контакты, история, менеджеры — в соответствующих вкладках

## Android

Открой папку `android/` в Android Studio.
Измени IP в `MainActivity.kt`:
```kotlin
var backendUrl = "ws://192.168.1.XXX:3001"
```
Узнать IP: `ipconfig` → IPv4 Address
