const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

// Переменные окружения
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./pushups.db');

// Инициализация базы данных
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS pushups (
        user_id INTEGER, 
        count INTEGER, 
        date DATE DEFAULT (date('now'))
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER PRIMARY KEY, 
        start_time TEXT DEFAULT '09:00', 
        end_time TEXT DEFAULT '21:00', 
        frequency INTEGER DEFAULT 2
    )`);
});

const app = express();
app.use(express.json());

// --- API ENDPOINTS ДЛЯ MINI APP ---

// 1. Получение статистики за последние 7 дней
app.get('/api/stats', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.json({ labels: [], data: [] });

    const sql = `
        SELECT date(date) as date_str, SUM(count) as total
        FROM pushups
        WHERE user_id = ? AND date >= date('now', '-6 days')
        GROUP BY date(date)
    `;

    db.all(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const resultMap = {};
        (rows || []).forEach(r => { resultMap[r.date_str] = r.total; });

        const labels = [];
        const data = [];
        const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const isoDate = d.toISOString().split('T')[0];
            const dayLabel = dayNames[d.getDay()];

            labels.push(dayLabel);
            data.push(resultMap[isoDate] || 0);
        }

        res.json({ labels, data });
    });
});

// 2. Получение текущих настроек пользователя
app.get('/api/settings', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.json({ start_time: '09:00', end_time: '21:00', frequency: 2 });

    db.get(`SELECT * FROM settings WHERE user_id = ?`, [userId], (err, row) => {
        if (err || !row) {
            return res.json({ start_time: '09:00', end_time: '21:00', frequency: 2 });
        }
        res.json(row);
    });
});

// 3. Сохранение настроек пользователя
app.post('/api/settings', (req, res) => {
    const { user_id, start_time, end_time, frequency } = req.body;
    if (!user_id) return res.status(400).json({ error: 'No user_id provided' });

    const sql = `
        INSERT INTO settings (user_id, start_time, end_time, frequency)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            frequency = excluded.frequency
    `;

    db.run(sql, [user_id, start_time, end_time, parseInt(frequency) || 2], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- HTML ИНТЕРФЕЙС MINI APP ---

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
        input { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid #ccc; box-sizing: border-box; font-size: 14px; margin-bottom: 8px; background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #000); }
        button { width: 100%; padding: 12px; background: var(--tg-theme-button-color, #3390ec); color: var(--tg-theme-button-text-color, #ffffff); border: none; border-radius: 8px; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="card">
        <h3>📊 Прогресс за 7 дней</h3>
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

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : null;
        let chartInstance = null;

        function renderChart(labels, data) {
            const ctx = document.getElementById('pushupChart').getContext('2d');
            if (chartInstance) chartInstance.destroy();
            
            chartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Отжимания',
                        data: data,
                        backgroundColor: tg.themeParams.button_color || '#3390ec',
                        borderRadius: 6
                    }]
                },
                options: { responsive: true, scales: { y: { beginAtZero: true } } }
            });
        }

        async function loadAppData() {
            if (!userId) {
                renderChart(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'], [0, 0, 0, 0, 0, 0, 0]);
                return;
            }

            // Загрузка статистики
            try {
                const resStats = await fetch('/api/stats?user_id=' + userId);
                const stats = await resStats.json();
                renderChart(stats.labels || [], stats.data || []);
            } catch(e) { console.error('Ошибка загрузки статистики:', e); }

            // Загрузка настроек
            try {
                const resSettings = await fetch('/api/settings?user_id=' + userId);
                const settings = await resSettings.json();
                if (settings) {
                    if (settings.start_time) document.getElementById('timeStart').value = settings.start_time;
                    if (settings.end_time) document.getElementById('timeEnd').value = settings.end_time;
                    if (settings.frequency) document.getElementById('freq').value = settings.frequency;
                }
            } catch(e) { console.error('Ошибка загрузки настроек:', e); }
        }

        async function saveSettings() {
            const start = document.getElementById('timeStart').value;
            const end = document.getElementById('timeEnd').value;
            const freq = document.getElementById('freq').value;

            if (!userId) {
                tg.showPopup({ title: 'Внимание', message: 'Запустите приложение через Telegram.' });
                return;
            }

            try {
                const res = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: userId,
                        start_time: start,
                        end_time: end,
                        frequency: freq
                    })
                });

                if (res.ok) {
                    tg.showPopup({
                        title: 'Сохранено!',
                        message: 'Напоминания установлены с ' + start + ' до ' + end + ' каждые ' + freq + ' ч.'
                    });
                } else {
                    tg.showPopup({ title: 'Ошибка', message: 'Не удалось сохранить настройки.' });
                }
            } catch(e) {
                tg.showPopup({ title: 'Ошибка', message: 'Сетевая ошибка.' });
            }
        }

        loadAppData();
    </script>
</body>
</html>
`;

// Маршруты для открытия Mini App
app.get('/webapp', (req, res) => res.send(htmlPage));
app.get('/', (req, res) => res.send(htmlPage));

// --- ЛОГИКА ТЕЛЕГРАМ-БОТА ---

bot.start((ctx) => {
    const webAppUrl = process.env.WEBAPP_URL || 'https://sport-ya.onrender.com/webapp';
    ctx.reply('Привет! Отправь мне число отжиманий текстом или открой веб-интерфейс:', {
        reply_markup: {
            inline_keyboard: [[
                { text: "📊 Статистика и Настройки", web_app: { url: webAppUrl } }
            ]]
        }
    });
});

// Ввод количества отжиманий текстом
bot.on('text', (ctx) => {
    const count = parseInt(ctx.message.text);
    if (!isNaN(count) && count > 0) {
        db.run(`INSERT INTO pushups (user_id, count) VALUES (?, ?)`, [ctx.from.id, count], (err) => {
            if (err) return ctx.reply('❌ Ошибка сохранения.');
            ctx.reply(`✅ Записано: +${count} отжиманий! 🔥`);
        });
    } else {
        ctx.reply('Отправь просто число (например: 25).');
    }
});

// Планировщик напоминаний (каждый час)
schedule.scheduleJob('0 * * * *', () => {
    const currentHour = new Date().getHours();
    db.each(`SELECT * FROM settings`, (err, row) => {
        if (err || !row) return;
        const start = parseInt(row.start_time.split(':')[0]);
        const end = parseInt(row.end_time.split(':')[0]);

        if (currentHour >= start && currentHour <= end && (currentHour % row.frequency === 0)) {
            bot.telegram.sendMessage(row.user_id, '🔔 Время размяться! Сделай подход отжиманий и отправь мне число.').catch(() => {});
        }
    });
});

bot.launch();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
