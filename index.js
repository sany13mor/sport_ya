const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./pushups.db');

// Инициализация базы данных и WAL-режима для надежности
db.serialize(() => {
    db.run(`PRAGMA journal_mode = WAL`);
    
    db.run(`CREATE TABLE IF NOT EXISTS pushups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        count INTEGER,
        exercise TEXT DEFAULT 'pushups',
        type TEXT DEFAULT 'classic',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        start_time TEXT DEFAULT '09:00',
        end_time TEXT DEFAULT '21:00',
        frequency INTEGER DEFAULT 3,
        daily_goal INTEGER DEFAULT 100,
        is_paused INTEGER DEFAULT 0,
        next_reminder DATETIME
    )`);
});

const app = express();
app.use(express.json());

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ БАЗЫ ДАННЫХ ---

function getUserSettings(userId, callback) {
    db.get(`SELECT * FROM settings WHERE user_id = ?`, [userId], (err, row) => {
        if (!row) {
            const defaultSet = {
                user_id: userId,
                start_time: '09:00',
                end_time: '21:00',
                frequency: 3,
                daily_goal: 100,
                is_paused: 0
            };
            db.run(
                `INSERT INTO settings (user_id, start_time, end_time, frequency, daily_goal, is_paused) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, '09:00', '21:00', 3, 100, 0]
            );
            return callback(defaultSet);
        }
        callback(row);
    });
}

function logExercise(userId, username, count, exercise = 'pushups', type = 'classic', callback) {
    db.run(
        `INSERT INTO pushups (user_id, username, count, exercise, type) VALUES (?, ?, ?, ?, ?)`,
        [userId, username || 'Аноним', parseInt(count), exercise, type],
        function(err) {
            if (callback) callback(err, this?.lastID);
        }
    );
}

// --- API ENDPOINTS ---

app.post('/api/pushups', (req, res) => {
    const { user_id, username, count, exercise, type } = req.body;
    if (!user_id || !count) return res.status(400).json({ error: 'Неверные данные' });

    logExercise(user_id, username, count, exercise, type, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/user-summary', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'No user_id' });

    const todaySql = `SELECT SUM(count) as today_total FROM pushups WHERE user_id = ? AND date(created_at, 'localtime') = date('now', 'localtime')`;
    const totalSql = `SELECT SUM(count) as total_all, MAX(count) as max_set FROM pushups WHERE user_id = ?`;

    getUserSettings(userId, (settings) => {
        db.get(todaySql, [userId], (err, todayRow) => {
            db.get(totalSql, [userId], (err, totalRow) => {
                res.json({
                    today: todayRow?.today_total || 0,
                    total: totalRow?.total_all || 0,
                    max_set: totalRow?.max_set || 0,
                    settings: settings
                });
            });
        });
    });
});

app.get('/api/heatmap', (req, res) => {
    const userId = req.query.user_id;
    const sql = `
        SELECT date(created_at, 'localtime') as day, SUM(count) as total
        FROM pushups
        WHERE user_id = ? AND created_at >= date('now', '-29 days')
        GROUP BY date(created_at, 'localtime')
    `;
    db.all(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get('/api/export', (req, res) => {
    const userId = req.query.user_id;
    db.all(`SELECT created_at, exercise, type, count FROM pushups WHERE user_id = ? ORDER BY created_at DESC`, [userId], (err, rows) => {
        if (err) return res.status(500).send('Ошибка экспорта');
        let csv = 'Дата,Упражнение,Тип,Количество\n';
        (rows || []).forEach(r => {
            csv += `"${r.created_at}","${r.exercise}","${r.type}",${r.count}\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="workout_history.csv"');
        res.send(csv);
    });
});

app.post('/api/settings', (req, res) => {
    const { user_id, start_time, end_time, frequency, daily_goal, is_paused } = req.body;
    
    const sql = `
        UPDATE settings 
        SET start_time = ?, end_time = ?, frequency = ?, daily_goal = ?, is_paused = ?
        WHERE user_id = ?
    `;

    db.run(sql, [start_time, end_time, parseInt(frequency), parseInt(daily_goal), is_paused ? 1 : 0, user_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- iOS MATTE GLASS HTML ИНТЕРФЕЙС MINI APP ---

const htmlPage = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Matte Glass Fitness</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --bg-base: #0a0c10;
            --glass-card: rgba(255, 255, 255, 0.035);
            --glass-border: rgba(255, 255, 255, 0.07);
            --glass-input: rgba(0, 0, 0, 0.3);
            --accent-muted: #4a729a;
            --accent-gold: #c8a762;
            --accent-green: #3d8b6e;
            --text-main: #e1e4e8;
            --text-sub: #7a838f;
        }

        body {
            font-family: -apple-system, SF Pro Text, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 16px 16px 95px 16px;
            background: var(--bg-base);
            color: var(--text-main);
            min-height: 100vh;
            box-sizing: border-box;
            user-select: none;
            -webkit-user-select: none;
        }

        /* Ambient Glow Background Behind Glass */
        .ambient-blur {
            position: fixed;
            top: -100px;
            left: -100px;
            width: 300px;
            height: 300px;
            background: radial-gradient(circle, rgba(74, 114, 154, 0.12) 0%, rgba(0,0,0,0) 70%);
            z-index: -1;
            pointer-events: none;
        }

        .glass-card {
            background: var(--glass-card);
            backdrop-filter: blur(40px) saturate(120%);
            -webkit-backdrop-filter: blur(40px) saturate(120%);
            border: 1px solid var(--glass-border);
            border-radius: 20px;
            padding: 18px;
            margin-bottom: 14px;
        }

        .tab-content { display: none; }
        .tab-content.active { display: block; animation: fadeIn 0.25s cubic-bezier(0,0,0.2,1); }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .metric-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-sub); font-weight: 600; }
        .metric-val { font-size: 26px; font-weight: 700; color: var(--text-main); margin-top: 4px; }

        .progress-bar-bg {
            width: 100%;
            height: 8px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 6px;
            overflow: hidden;
            margin-top: 10px;
        }

        .progress-bar-fill {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #4a729a, #3d8b6e);
            border-radius: 6px;
            transition: width 0.5s ease;
        }

        /* Preset Buttons Grid */
        .preset-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 8px;
            margin-top: 12px;
        }

        .btn-matte {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--glass-border);
            color: var(--text-main);
            padding: 12px 0;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .btn-matte:active {
            transform: scale(0.96);
            background: rgba(255, 255, 255, 0.1);
        }

        .btn-primary {
            width: 100%;
            padding: 14px;
            border-radius: 14px;
            border: 1px solid rgba(255,255,255,0.1);
            background: rgba(74, 114, 154, 0.25);
            color: #fff;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 10px;
            backdrop-filter: blur(20px);
        }

        .btn-primary:active { opacity: 0.8; }

        /* Heatmap Grid */
        .heatmap-grid {
            display: grid;
            grid-template-columns: repeat(10, 1fr);
            gap: 6px;
            margin-top: 10px;
        }

        .heatmap-cell {
            aspect-ratio: 1;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.04);
        }

        /* TabBar */
        .tab-bar {
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            width: calc(100% - 40px);
            max-width: 400px;
            background: rgba(14, 17, 22, 0.85);
            backdrop-filter: blur(30px) saturate(150%);
            -webkit-backdrop-filter: blur(30px) saturate(150%);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 24px;
            display: flex;
            justify-content: space-around;
            padding: 10px 0;
            z-index: 1000;
        }

        .tab-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            color: var(--text-sub);
            font-size: 10px;
            cursor: pointer;
        }

        .tab-item.active { color: var(--accent-muted); }

        input, select {
            width: 100%;
            padding: 12px;
            border-radius: 10px;
            border: 1px solid var(--glass-border);
            background: var(--glass-input);
            color: #fff;
            box-sizing: border-box;
            margin-top: 6px;
            margin-bottom: 10px;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="ambient-blur"></div>

    <!-- ГЛАВНАЯ -->
    <div id="tab-home" class="tab-content active">
        <div class="glass-card">
            <div style="display: flex; justify-content: space-between;">
                <div>
                    <div class="metric-title">ПРОГРЕСС ЗА СЕГОДНЯ</div>
                    <div class="metric-val" id="todayText">0 / 100</div>
                </div>
                <div style="text-align: right;">
                    <div class="metric-title">РЕЖИМ</div>
                    <div style="font-size: 14px; margin-top: 6px; color: var(--accent-green);" id="statusBadge">🟢 Активен</div>
                </div>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" id="progressBar"></div>
            </div>
        </div>

        <div class="glass-card">
            <div class="metric-title" style="margin-bottom: 8px;">Быстрый подход</div>
            <div class="preset-grid">
                <button class="btn-matte" onclick="addPushups(10)">+10</button>
                <button class="btn-matte" onclick="addPushups(20)">+20</button>
                <button class="btn-matte" onclick="addPushups(30)">+30</button>
                <button class="btn-matte" onclick="addPushups(50)">+50</button>
            </div>
            <div style="margin-top: 12px;">
                <input type="number" id="customVal" placeholder="Введите число...">
                <select id="exType">
                    <option value="classic">💪 Классические</option>
                    <option value="diamond">💎 Алмазные</option>
                    <option value="wide">👐 Широкие</option>
                </select>
                <button class="btn-primary" onclick="addCustom()">Записать результат</button>
            </div>
        </div>
    </div>

    <!-- АНАЛИТИКА I HEATMAP -->
    <div id="tab-stats" class="tab-content">
        <div class="glass-card">
            <div class="metric-title">Тепловая карта активности (30 дней)</div>
            <div class="heatmap-grid" id="heatmapGrid"></div>
        </div>
        <div class="glass-card" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center;">
            <div>
                <div class="metric-title">ВСЕГО ПОВТОРЕНИЙ</div>
                <div class="metric-val" id="statTotal">0</div>
            </div>
            <div>
                <div class="metric-title">РЕКОРД В ПОДХОДЕ</div>
                <div class="metric-val" id="statMax">0</div>
            </div>
        </div>
    </div>

    <!-- НАСТРОЙКИ И ЭКСПОРТ -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div class="metric-title" style="margin-bottom: 12px;">Настройки расписания</div>
            <label style="font-size: 11px; color: var(--text-sub);">Дневная цель:</label>
            <input type="number" id="cfgGoal">

            <label style="font-size: 11px; color: var(--text-sub);">Интервал напоминаний (часы):</label>
            <input type="number" id="cfgFreq" value="3">

            <div style="display: flex; align-items: center; margin: 10px 0;">
                <input type="checkbox" id="cfgPause" style="width: auto; margin: 0 10px 0 0;">
                <label for="cfgPause" style="font-size: 13px;">Режим отдыха (Пауза всех уведомлений)</label>
            </div>

            <button class="btn-primary" onclick="saveSettings()">Сохранить настройки</button>
        </div>

        <div class="glass-card">
            <div class="metric-title">Резервное копирование</div>
            <p style="font-size: 12px; color: var(--text-sub); margin: 6px 0 12px;">Ваши данные под вашей защитой. Вы можете выгрузить всю историю подходов в CSV-файл.</p>
            <button class="btn-matte" style="width: 100%;" onclick="exportData()">📥 Скачать CSV с историей</button>
        </div>
    </div>

    <!-- TABBAR -->
    <div class="tab-bar">
        <div class="tab-item active" onclick="switchTab('home', this)">
            <div style="font-size: 16px;">⚡</div>
            <div>Главная</div>
        </div>
        <div class="tab-item" onclick="switchTab('stats', this)">
            <div style="font-size: 16px;">📅</div>
            <div>Карта</div>
        </div>
        <div class="tab-item" onclick="switchTab('settings', this)">
            <div style="font-size: 16px;">⚙️</div>
            <div>Настройки</div>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 12345;
        const username = user ? (user.username || user.first_name) : 'User';

        function haptic() { if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light'); }

        function switchTab(id, el) {
            haptic();
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-item').forEach(i => i.classList.remove('active'));
            document.getElementById('tab-' + id).classList.add('active');
            el.classList.add('active');
            if (id === 'stats') loadHeatmap();
        }

        async function loadSummary() {
            const res = await fetch('/api/user-summary?user_id=' + userId);
            const data = await res.json();

            const today = data.today || 0;
            const goal = data.settings?.daily_goal || 100;
            const pct = Math.min(100, Math.round((today / goal) * 100));

            document.getElementById('todayText').innerText = today + ' / ' + goal;
            document.getElementById('progressBar').style.width = pct + '%';
            document.getElementById('statTotal').innerText = data.total || 0;
            document.getElementById('statMax').innerText = data.max_set || 0;

            if (data.settings) {
                document.getElementById('cfgGoal').value = goal;
                document.getElementById('cfgFreq').value = data.settings.frequency || 3;
                document.getElementById('cfgPause').checked = data.settings.is_paused === 1;
                document.getElementById('statusBadge').innerText = data.settings.is_paused ? '🔴 На паузе' : '🟢 Активен';
            }
        }

        async function addPushups(count) {
            haptic();
            const type = document.getElementById('exType').value;
            await fetch('/api/pushups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, username, count, type })
            });
            loadSummary();
        }

        function addCustom() {
            const val = parseInt(document.getElementById('customVal').value);
            if (val > 0) {
                addPushups(val);
                document.getElementById('customVal').value = '';
            }
        }

        async function loadHeatmap() {
            const res = await fetch('/api/heatmap?user_id=' + userId);
            const rows = await res.json();
            const map = {};
            rows.forEach(r => map[r.day] = r.total);

            const grid = document.getElementById('heatmapGrid');
            grid.innerHTML = '';

            for (let i = 29; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const iso = d.toISOString().split('T')[0];
                const count = map[iso] || 0;

                const cell = document.createElement('div');
                cell.className = 'heatmap-cell';
                if (count > 0) {
                    const alpha = Math.min(1, count / 100);
                    cell.style.background = 'rgba(74, 114, 154, ' + (0.2 + alpha * 0.8) + ')';
                }
                grid.appendChild(cell);
            }
        }

        async function saveSettings() {
            haptic();
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    daily_goal: document.getElementById('cfgGoal').value,
                    frequency: document.getElementById('cfgFreq').value,
                    is_paused: document.getElementById('cfgPause').checked,
                    start_time: '09:00',
                    end_time: '21:00'
                })
            });
            tg.showPopup({ title: 'Успешно', message: 'Настройки сохранены.' });
            loadSummary();
        }

        function exportData() {
            window.location.href = '/api/export?user_id=' + userId;
        }

        loadSummary();
    </script>
</body>
</html>
`;

app.get('/webapp', (req, res) => res.send(htmlPage));
app.get('/', (req, res) => res.send(htmlPage));

// --- ИНТЕРАКТИВНЫЕ НАПОМИНАНИЯ И SNOOZE В TELEGRAM ---

bot.start((ctx) => {
    const webAppUrl = process.env.WEBAPP_URL || 'https://sport-ya.onrender.com/webapp';
    ctx.reply('💪 Матовый трекер подходов готов к работе!\n\nИспользуйте кнопки ниже или просто пишите число подходов в чат.', {
        reply_markup: {
            inline_keyboard: [[
                { text: "📊 Открыть iOS Трекер", web_app: { url: webAppUrl } }
            ]]
        }
    });
});

// Распознавание текста и умный ввод
bot.on('text', (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/\d+/);
    
    if (match) {
        const count = parseInt(match[0]);
        logExercise(ctx.from.id, ctx.from.username || ctx.from.first_name, count, 'pushups', 'classic', () => {
            ctx.reply(`✅ Записано: +${count} отжиманий! 🔥`);
        });
    } else {
        ctx.reply('Отправьте число (например: 25) или нажмите на кнопку снизу.');
    }
});

// Обработка Inline-кнопок прямо из сообщений напоминания
bot.on('callback_query', (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    if (data.startsWith('add_')) {
        const count = parseInt(data.split('_')[1]);
        logExercise(userId, ctx.from.username || ctx.from.first_name, count, 'pushups', 'classic', () => {
            ctx.answerCbQuery(`Записано +${count}!`);
            ctx.editMessageText(`✅ Отлично! Записано +${count} отжиманий.`);
        });
    } else if (data.startsWith('snooze_')) {
        const mins = parseInt(data.split('_')[1]);
        const nextTime = new Date(Date.now() + mins * 60 * 1000).toISOString();
        
        db.run(`UPDATE settings SET next_reminder = ? WHERE user_id = ?`, [nextTime, userId], () => {
            ctx.answerCbQuery(`Отложено на ${mins} мин`);
            ctx.editMessageText(`⏱ Напоминание отложено на ${mins} минут.`);
        });
    }
});

// ФОНОВЫЙ ТАЙМЕР НАПОМИНАНИЙ (Проверка каждую минуту)
setInterval(() => {
    const nowISO = new Date().toISOString();
    const currentHour = new Date().getHours();

    db.all(`SELECT * FROM settings WHERE is_paused = 0`, [], (err, rows) => {
        if (err || !rows) return;

        rows.forEach((user) => {
            // Тихие часы с 22:00 до 08:00
            if (currentHour >= 22 || currentHour < 8) return;

            const shouldRemind = !user.next_reminder || user.next_reminder <= nowISO;

            if (shouldRemind) {
                // Обновляем время следующего напоминания (через N часов)
                const nextRem = new Date(Date.now() + (user.frequency || 3) * 3600 * 1000).toISOString();
                db.run(`UPDATE settings SET next_reminder = ? WHERE user_id = ?`, [nextRem, user.user_id]);

                // Отправляем интерактивное сообщение
                bot.telegram.sendMessage(
                    user.user_id,
                    '🔔 Время сделать подход! Выберите действие или отложите:',
                    Markup.inlineKeyboard([
                        [
                            Markup.button.callback('+15', 'add_15'),
                            Markup.button.callback('+25', 'add_25'),
                            Markup.button.callback('+35', 'add_35')
                        ],
                        [
                            Markup.button.callback('⏱ 15 мин', 'snooze_15'),
                            Markup.button.callback('⏱ 30 мин', 'snooze_30'),
                            Markup.button.callback('⏱ 1 час', 'snooze_60')
                        ]
                    ])
                ).catch(() => {});
            }
        });
    });
}, 60000);

bot.launch();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
