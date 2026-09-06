const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// Токен бота и порт из переменных окружения (или значения по умолчанию)
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./pushups.db');

// Инициализация базы данных
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS pushups (user_id INTEGER, count INTEGER, date DATE DEFAULT (date('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (user_id INTEGER PRIMARY KEY, start_time TEXT DEFAULT '09:00', end_time TEXT DEFAULT '21:00', frequency INTEGER DEFAULT 2)`);
});

const app = express();
app.use(express.json());

// HTML-страница Mini App (встроена прямо в файл)
const htmlPage = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Трекер отжиманий</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 15px; margin: 0; background: var(--tg-theme-bg-color, #f4f4f5); color: var(--tg-theme-text-color, #000); }
        .card { background: var(--tg-theme-secondary-bg-color, #ffffff); padding: 18px; border-radius: 12px; margin-bottom: 15px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        h3 { margin-top: 0; margin-bottom: 12px; font-size: 16px; }
        label { display: block; font-size: 13px; margin: 8px 0 4px; color: var(--tg-theme-hint-color, #888); }
        input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #ccc; box-sizing: border-box; font-size: 14px; margin-bottom: 8px; }
        button { width: 100%; padding: 12px; background: var(--tg-theme-button-color, #3390ec); color: var(--tg-theme-button-text-color, #ffffff); border: none; border-radius: 8px; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="card">
        <h3>📊 Прогресс отжиманий</h3>
        <canvas id="pushupChart"></canvas>
    </div>

    <div class="card">
        <h3>⚙️ Настройки напоминаний</h3>
        <label>Начало дня:</label>
        <input type="time" id="timeStart" value="09:00">
        <label>Конец дня:</label>
        <input type="time" id="timeEnd" value="21:00">
        <label>Интервал (часы):</label>
        <input type="number" id="freq" value="2" min="1" max="12">
        <button onclick="saveSettings()">Сохранить настройки</button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();

        const ctx = document.getElementById('pushupChart').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
                datasets: [{
                    label: 'Отжимания',
                    data: [20, 35, 40, 30, 50, 45, 60],
                    backgroundColor: tg.themeParams.button_color || '#3390ec',
                    borderRadius: 6
                }]
            },
            options: { responsive: true, scales: { y: { beginAtZero: true } } }
        });

        function saveSettings() {
            const start = document.getElementById('timeStart').value;
            const end = document.getElementById('timeEnd').value;
            const freq = document.getElementById('freq').value;
            
            tg.showPopup({
                title: 'Сохранено!',
                message: \`Напоминания с \${start} до \${end} каждые \${freq} ч.\`
            });
        }
    </script>
</body>
</html>
`;

// Раздача веб-интерфейса
app.get('/webapp', (req, res) => res.send(htmlPage));

// Старт бота
bot.start((ctx) => {
    const webAppUrl = process.env.WEBAPP_URL || 'https://your-domain.onrender.com/webapp';
    ctx.reply('Привет! Отправь мне число отжиманий текстом или открой веб-интерфейс:', {
        reply_markup: {
            inline_keyboard: [[
                { text: "📊 Статистика и Настройки", web_app: { url: webAppUrl } }
            ]]
        }
    });
});

// Запись отжиманий по числу в чате
bot.on('text', (ctx) => {
    const count = parseInt(ctx.message.text);
    if (!isNaN(count)) {
        db.run(`INSERT INTO pushups (user_id, count) VALUES (?, ?)`, [ctx.from.id, count], (err) => {
            if (err) return ctx.reply('❌ Ошибка сохранения.');
            ctx.reply(`✅ Записано: +${count} отжиманий! 🔥`);
        });
    } else {
        ctx.reply('Отправь просто число (например: 25).');
    }
});

// Планировщик напоминаний (проверка каждый час)
schedule.scheduleJob('0 * * * *', () => {
    const currentHour = new Date().getHours();
    db.each(`SELECT * FROM settings`, (err, row) => {
        if (err || !row) return;
        const start = parseInt(row.start_time.split(':')[0]);
        const end = parseInt(row.end_time.split(':')[0]);
        
        if (currentHour >= start && currentHour <= end && (currentHour % row.frequency === 0)) {
            bot.telegram.sendMessage(row.user_id, '🔔 Время размяться! Сделай подход и напиши число.');
        }
    });
});

bot.launch();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));