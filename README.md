# Sales Call Analyzer

Система анализа звонков менеджеров по продажам.
Телефон пишет разговор → сервер транскрибирует и анализирует → десктоп показывает результаты.

---

## Структура

```
sales-agent-v3/
├── backend/       ← Node.js API + WebSocket сервер
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── desktop/       ← Electron приложение (дашборд руководителя)
│   ├── src/
│   │   ├── main.js      ← Electron main process
│   │   ├── preload.js   ← IPC bridge
│   │   ├── index.html   ← Shell
│   │   └── renderer.js  ← Весь UI
│   └── package.json
├── android/       ← Kotlin Android приложение (телефон менеджера)
└── package.json
```

---

## Установка зависимостей

```bash
cd backend && npm install
cd ../desktop && npm install
cd ..
```

---

## Файл .env

Создай файл `backend/.env` со следующим содержимым:

```
GROQ_API_KEY=gsk_твой_ключ_с_console.groq.com
PORT=3001
```

Через bash:

```bash
notepad backend/.env
```

---

## Запуск (два отдельных терминала)

### Терминал 1 — Бэкенд

```bash
cd ~/Downloads/sales-agent-v3/backend
npm run dev
```

Ожидаемый вывод:

```
🚀  http://localhost:3001
    STT    : groq
    LLM    : groq
    ffmpeg : ✓
    DB     : sales.json
```

### Терминал 2 — Десктоп (Electron)

Открой новое окно Git Bash и запусти:

```bash
cd ~/Downloads/sales-agent-v3/desktop
npm start
```

Откроется окно приложения с вкладками: История, Контакты, Менеджеры, Аналитика.

---

## Как работает система

```
Менеджер звонит с телефона (Android)
    ↓
Android приложение пишет оба голоса автоматически
    ↓
Стримит аудио на бэкенд по Wi-Fi (WebSocket)
    ↓
Бэкенд: Groq Whisper → транскрипт → LLaMA → анализ
    ↓
На телефоне: "Сохранить клиента?" → Да/Нет
    ↓
Руководитель видит результат в Electron на компьютере
```

---

## Android — запуск в Android Studio

### Шаг 1 — Открыть проект

```
Android Studio → File → Open →
выбери папку: sales-agent-v3/android
```

Дождись Gradle sync (5-10 минут первый раз).

### Шаг 2 — Указать IP бэкенда

Открой файл:

```
app → src → main → java → com → sales → analyzer → MainActivity.kt
```

Найди строку и замени IP на свой:

```kotlin
var backendUrl = "ws://10.0.2.2:3001"
```

Узнать IP компьютера (в cmd):

```
ipconfig
```

Смотри строку `IPv4 Address` — например `192.168.1.105`.

Телефон и компьютер должны быть в одной Wi-Fi сети.

### Шаг 3 — Создать эмулятор

```
Tools → Device Manager → Create Device →
Pixel 7 → Android 14 → Finish
```

Нажми ▶ чтобы запустить эмулятор.

### Шаг 4 — Запустить приложение

Нажми зелёную кнопку **▶ Run** вверху (Shift+F10).

Приложение установится на эмулятор.

### Шаг 5 — Установить как телефон по умолчанию

В эмуляторе:

```
Settings → Apps → Default Apps → Phone App → Sales Analyzer
```

### Шаг 6 — Тестовый звонок

В эмуляторе нажми `...` (Extended Controls) → вкладка **Phone** → нажми **Call Device**.

Или позвони между двумя эмуляторами — набери `5556` на первом эмуляторе.

После завершения звонка появится экран с анализом и вопросом "Сохранить клиента?".

### Установка на реальный телефон

1. На телефоне: Настройки → О телефоне → нажми 7 раз на "Номер сборки"
2. Настройки → Для разработчиков → USB-отладка → включить
3. Подключи телефон кабелем к компьютеру → подтверди на телефоне
4. В Android Studio выбери телефон вместо эмулятора → нажми ▶ Run

---

## Groq лимиты (бесплатно)

| Сервис                 | Лимит в день      |
| ---------------------- | ----------------- |
| Транскрипция (Whisper) | 7 200 минут аудио |
| Анализ (LLaMA 70b)     | 14 400 запросов   |
