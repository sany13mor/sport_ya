const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('./pushups.db');

// Инициализация базы данных
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS pushups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        count INTEGER,
        type TEXT DEFAULT 'classic',
        date DATE DEFAULT (date('now'))
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        start_time TEXT DEFAULT '09:00',
        end_time TEXT DEFAULT '21:00',
        frequency INTEGER DEFAULT 2,
        daily_goal INTEGER DEFAULT 100
    )`);
});

const app = express();
app.use(express.json());

// --- API ENDPOINTS ---

// Добавление отжиманий из Mini App
app.post('/api/pushups', (req, res) => {
    const { user_id, username, count, type } = req.body;
    if (!user_id || !count) return res.status(400).json({ error: 'Invalid data' });

    db.run(
        `INSERT INTO pushups (user_id, username, count, type) VALUES (?, ?, ?, ?)`,
        [user_id, username || 'Аноним', parseInt(count), type || 'classic'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Получение сводки пользователя (Стрики, Прогресс за сегодня, Статистика)
app.get('/api/user-summary', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'No user_id' });

    const todaySql = `SELECT SUM(count) as today_total FROM pushups WHERE user_id = ? AND date = date('now')`;
    const totalSql = `SELECT SUM(count) as total_all, MAX(count) as max_set FROM pushups WHERE user_id = ?`;
    const settingsSql = `SELECT daily_goal, start_time, end_time, frequency FROM settings WHERE user_id = ?`;

    db.get(todaySql, [userId], (err, todayRow) => {
        db.get(totalSql, [userId], (err, totalRow) => {
            db.get(settingsSql, [userId], (err, setRow) => {
                res.json({
                    today: todayRow?.today_total || 0,
                    total: totalRow?.total_all || 0,
                    max_set: totalRow?.max_set || 0,
                    daily_goal: setRow?.daily_goal || 100,
                    settings: setRow || { start_time: '09:00', end_time: '21:00', frequency: 2, daily_goal: 100 }
                });
            });
        });
    });
});

// Аналитика для графиков (За 7 дней / 30 дней)
app.get('/api/stats', (req, res) => {
    const userId = req.query.user_id;
    const days = parseInt(req.query.days) || 7;

    const sql = `
        SELECT date(date) as date_str, SUM(count) as total
        FROM pushups
        WHERE user_id = ? AND date >= date('now', '-${days - 1} days')
        GROUP BY date(date)
    `;

    db.all(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const resultMap = {};
        (rows || []).forEach(r => { resultMap[r.date_str] = r.total; });

        const labels = [];
        const data = [];
        const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const isoDate = d.toISOString().split('T')[0];

            labels.push(days === 7 ? dayNames[d.getDay()] : d.getDate());
            data.push(resultMap[isoDate] || 0);
        }

        res.json({ labels, data });
    });
});

// Таблица лидеров (Leaderboard)
app.get('/api/leaderboard', (req, res) => {
    const sql = `
        SELECT username, SUM(count) as total_count 
        FROM pushups 
        GROUP BY user_id 
        ORDER BY total_count DESC 
        LIMIT 10
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Сохранение настроек
app.post('/api/settings', (req, res) => {
    const { user_id, username, start_time, end_time, frequency, daily_goal } = req.body;
    
    const sql = `
        INSERT INTO settings (user_id, username, start_time, end_time, frequency, daily_goal)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            frequency = excluded.frequency,
            daily_goal = excluded.daily_goal
    `;

    db.run(sql, [user_id, username || 'User', start_time, end_time, frequency, daily_goal], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- iOS GLASSMORPHISM HTML ИНТЕРФЕЙС MINI APP ---

const htmlPage = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>PushUp iOS Glass</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --glass-bg: rgba(255, 255, 255, 0.07);
            --glass-border: rgba(255, 255, 255, 0.12);
            --glass-glow: rgba(0, 229, 255, 0.15);
            --accent-color: #00E5FF;
            --accent-gradient: linear-gradient(135deg, #00E5FF 0%, #7000FF 100%);
            --text-main: #FFFFFF;
            --text-sub: rgba(255, 255, 255, 0.6);
        }

        body {
            font-family: -apple-system, SF Pro Display, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 16px 16px 90px 16px;
            background: radial-gradient(circle at top left, #1a103c, #0b071a, #05030a);
            color: var(--text-main);
            min-height: 100vh;
            box-sizing: border-box;
            user-select: none;
            -webkit-user-select: none;
        }

        /* Glassmorphism Cards */
        .glass-card {
            background: var(--glass-bg);
            backdrop-filter: blur(25px) saturate(190%);
            -webkit-backdrop-filter: blur(25px) saturate(190%);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            padding: 20px;
            margin-bottom: 16px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
        }

        .tab-content { display: none; }
        .tab-content.active { display: block; animation: fadeIn 0.3s ease; }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Ring Progress & Goal */
        .progress-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .goal-title { font-size: 14px; color: var(--text-sub); }
        .goal-value { font-size: 28px; font-weight: 800; background: var(--accent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }

        .progress-bar-bg {
            width: 100%;
            height: 12px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            overflow: hidden;
            margin-top: 12px;
        }

        .progress-bar-fill {
            height: 100%;
            width: 0%;
            background: var(--accent-gradient);
            border-radius: 10px;
            transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Preset Buttons Grid */
        .preset-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-top: 14px;
        }

        .btn-glass-btn {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid var(--glass-border);
            color: #fff;
            padding: 12px 0;
            border-radius: 16px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            backdrop-filter: blur(10px);
            transition: all 0.2s ease;
        }

        .btn-glass-btn:active {
            transform: scale(0.94);
            background: rgba(255, 255, 255, 0.2);
        }

        .btn-main {
            width: 100%;
            padding: 16px;
            border-radius: 18px;
            border: none;
            background: var(--accent-gradient);
            color: #fff;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 4px 20px var(--glass-glow);
            margin-top: 12px;
            transition: transform 0.2s;
        }

        .btn-main:active { transform: scale(0.97); }

        /* Timer Section */
        .timer-display {
            font-size: 32px;
            font-weight: 800;
            text-align: center;
            letter-spacing: 2px;
            margin: 10px 0;
            font-variant-numeric: tabular-nums;
        }

        /* Leaderboard List */
        .leader-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }
        .leader-item:last-child { border-bottom: none; }
        .rank { font-weight: 800; width: 30px; color: var(--accent-color); }

        /* Navigation Bar (iOS Tabbar) */
        .tab-bar {
            position: fixed;
            bottom: 15px;
            left: 50%;
            transform: translateX(-50%);
            width: calc(100% - 32px);
            max-width: 420px;
            background: rgba(18, 12, 38, 0.75);
            backdrop-filter: blur(30px) saturate(200%);
            -webkit-backdrop-filter: blur(30px) saturate(200%);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 28px;
            display: flex;
            justify-content: space-around;
            padding: 8px 0;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            z-index: 1000;
        }

        .tab-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            color: var(--text-sub);
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            transition: color 0.2s;
        }

        .tab-item.active { color: var(--accent-color); }
        .tab-icon { font-size: 20px; margin-bottom: 2px; }

        input, select {
            width: 100%;
            padding: 12px;
            border-radius: 12px;
            border: 1px solid var(--glass-border);
            background: rgba(0, 0, 0, 0.2);
            color: #fff;
            box-sizing: border-box;
            margin-top: 6px;
            margin-bottom: 12px;
            font-size: 15px;
        }
    </style>
</head>
<body>

    <!-- ВКЛАДКА 1: ГЛАВНАЯ -->
    <div id="tab-home" class="tab-content active">
        <div class="glass-card">
            <div class="progress-header">
                <div>
                    <div class="goal-title">ДНЕВНАЯ ЦЕЛЬ</div>
                    <div class="goal-value" id="todayProgressText">0 / 100</div>
                </div>
                <div style="text-align: right;">
                    <div class="goal-title">СТРИК</div>
                    <div style="font-size: 22px; font-weight: 800;">🔥 1 день</div>
                </div>
            </div>
            <div class="progress-bar-bg">
                <div class="progress-bar-fill" id="progressBar"></div>
            </div>
        </div>

        <!-- Быстрый ввод -->
        <div class="glass-card">
            <div style="font-size: 15px; font-weight: 700; margin-bottom: 8px;">Быстрый подход</div>
            <div class="preset-grid">
                <button class="btn-glass-btn" onclick="addPushups(10)">+10</button>
                <button class="btn-glass-btn" onclick="addPushups(20)">+20</button>
                <button class="btn-glass-btn" onclick="addPushups(30)">+30</button>
                <button class="btn-glass-btn" onclick="addPushups(50)">+50</button>
            </div>
            
            <div style="margin-top: 14px;">
                <input type="number" id="customInput" placeholder="Или введите свое число...">
                <select id="pushupType">
                    <option value="classic">💪 Классические</option>
                    <option value="diamond">💎 Алмазные (Diamond)</option>
                    <option value="wide">👐 Широкий хват</option>
                    <option value="elevated">📐 С ногами на скамье</option>
                </select>
                <button class="btn-main" onclick="addCustomPushups()">Записать подход</button>
            </div>
        </div>

        <!-- Таймер отдыха -->
        <div class="glass-card">
            <div style="font-size: 14px; color: var(--text-sub);">⏱️ ТАЙМЕР ОТДЫХА</div>
            <div class="timer-display" id="timer">00:45</div>
            <div class="preset-grid">
                <button class="btn-glass-btn" onclick="startTimer(30)">30 сек</button>
                <button class="btn-glass-btn" onclick="startTimer(45)">45 сек</button>
                <button class="btn-glass-btn" onclick="startTimer(60)">60 сек</button>
                <button class="btn-glass-btn" onclick="startTimer(90)">90 сек</button>
            </div>
        </div>
    </div>

    <!-- ВКЛАДКА 2: АНАЛИТИКА -->
    <div id="tab-stats" class="tab-content">
        <div class="glass-card">
            <div style="font-size: 16px; font-weight: 700; margin-bottom: 12px;">📊 Активность</div>
            <canvas id="chartCanvas"></canvas>
        </div>
        <div class="glass-card" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center;">
            <div>
                <div style="font-size: 12px; color: var(--text-sub);">ВСЕГО ОТЖАТО</div>
                <div style="font-size: 22px; font-weight: 800; color: var(--accent-color);" id="statTotal">0</div>
            </div>
            <div>
                <div style="font-size: 12px; color: var(--text-sub);">РЕКОРД ЗА ПОДХОД</div>
                <div style="font-size: 22px; font-weight: 800; color: #00FF87;" id="statMax">0</div>
            </div>
        </div>
    </div>

    <!-- ВКЛАДКА 3: ЛИДЕРЫ И АЧИВКИ -->
    <div id="tab-leaderboard" class="tab-content">
        <div class="glass-card">
            <div style="font-size: 16px; font-weight: 700; margin-bottom: 12px;">🏆 Топ атлетов</div>
            <div id="leaderboardList">Загрузка...</div>
        </div>
    </div>

    <!-- ВКЛАДКА 4: НАСТРОЙКИ -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div style="font-size: 16px; font-weight: 700; margin-bottom: 12px;">⚙️ Напоминания & Цели</div>
            <label style="font-size: 12px; color: var(--text-sub);">Дневная цель (раз):</label>
            <input type="number" id="cfgGoal" value="100">

            <label style="font-size: 12px; color: var(--text-sub);">Начало дня:</label>
            <input type="time" id="cfgStart" value="09:00">

            <label style="font-size: 12px; color: var(--text-sub);">Конец дня:</label>
            <input type="time" id="cfgEnd" value="21:00">

            <label style="font-size: 12px; color: var(--text-sub);">Интервал (часы):</label>
            <input type="number" id="cfgFreq" value="2">

            <button class="btn-main" onclick="saveSettings()">Сохранить настройки</button>
        </div>
    </div>

    <!-- iOS TABBAR -->
    <div class="tab-bar">
        <div class="tab-item active" onclick="switchTab('home', this)">
            <div class="tab-icon">⚡</div>
            <div>Главная</div>
        </div>
        <div class="tab-item" onclick="switchTab('stats', this)">
            <div class="tab-icon">📊</div>
            <div>Аналитика</div>
        </div>
        <div class="tab-item" onclick="switchTab('leaderboard', this)">
            <div class="tab-icon">🏆</div>
            <div>Лидеры</div>
        </div>
        <div class="tab-item" onclick="switchTab('settings', this)">
            <div class="tab-icon">⚙️</div>
            <div>Настройки</div>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 12345;
        const username = user ? (user.username || user.first_name) : 'Спортсмен';

        let chartInstance = null;
        let timerInterval = null;

        function triggerHaptic() {
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
        }

        function switchTab(tabId, el) {
            triggerHaptic();
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-item').forEach(i => i.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            el.classList.add('active');

            if (tabId === 'stats') loadStats();
            if (tabId === 'leaderboard') loadLeaderboard();
        }

        async function loadSummary() {
            try {
                const res = await fetch('/api/user-summary?user_id=' + userId);
                const data = await res.json();
                
                const today = data.today || 0;
                const goal = data.daily_goal || 100;
                const pct = Math.min(100, Math.round((today / goal) * 100));

                document.getElementById('todayProgressText').innerText = today + ' / ' + goal;
                document.getElementById('progressBar').style.width = pct + '%';
                document.getElementById('statTotal').innerText = data.total || 0;
                document.getElementById('statMax').innerText = data.max_set || 0;

                if (data.settings) {
                    document.getElementById('cfgGoal').value = goal;
                    document.getElementById('cfgStart').value = data.settings.start_time || '09:00';
                    document.getElementById('cfgEnd').value = data.settings.end_time || '21:00';
                    document.getElementById('cfgFreq').value = data.settings.frequency || 2;
                }
            } catch(e){}
        }

        async function addPushups(count) {
            triggerHaptic();
            const type = document.getElementById('pushupType').value;

            await fetch('/api/pushups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, username, count, type })
            });

            if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            loadSummary();
        }

        function addCustomPushups() {
            const val = parseInt(document.getElementById('customInput').value);
            if (val > 0) {
                addPushups(val);
                document.getElementById('customInput').value = '';
            }
        }

        function startTimer(seconds) {
            triggerHaptic();
            clearInterval(timerInterval);
            let left = seconds;
            
            const updateDisp = () => {
                const m = String(Math.floor(left / 60)).padStart(2, '0');
                const s = String(left % 60).padStart(2, '0');
                document.getElementById('timer').innerText = m + ':' + s;
            };

            updateDisp();
            timerInterval = setInterval(() => {
                left--;
                if (left <= 0) {
                    clearInterval(timerInterval);
                    document.getElementById('timer').innerText = '00:00';
                    if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('warning');
                } else {
                    updateDisp();
                }
            }, 1000);
        }

        async function loadStats() {
            const res = await fetch('/api/stats?user_id=' + userId + '&days=7');
            const stats = await res.json();

            const ctx = document.getElementById('chartCanvas').getContext('2d');
            if (chartInstance) chartInstance.destroy();

            chartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: stats.labels,
                    datasets: [{
                        data: stats.data,
                        backgroundColor: '#00E5FF',
                        borderRadius: 8
                    }]
                },
                options: {
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { display: false } },
                        y: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { color: 'rgba(255,255,255,0.05)' } }
                    }
                }
            });
        }

        async function loadLeaderboard() {
            const res = await fetch('/api/leaderboard');
            const data = await res.json();
            const container = document.getElementById('leaderboardList');
            
            container.innerHTML = data.map((item, index) => \`
                <div class="leader-item">
                    <div style="display:flex; align-items:center;">
                        <span class="rank">#\${index + 1}</span>
                        <span style="font-weight:600;">\${item.username}</span>
                    </div>
                    <span style="font-weight:800; color:#00FF87;">\${item.total_count}</span>
                </div>
            \`).join('');
        }

        async function saveSettings() {
            triggerHaptic();
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    username,
                    daily_goal: document.getElementById('cfgGoal').value,
                    start_time: document.getElementById('cfgStart').value,
                    end_time: document.getElementById('cfgEnd').value,
                    frequency: document.getElementById('cfgFreq').value
                })
            });
            if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            tg.showPopup({ title: 'Сохранено', message: 'Настройки обновлены!' });
            loadSummary();
        }

        loadSummary();
    </script>
</body>
</html>
`;

app.get('/webapp', (req, res) => res.send(htmlPage));
app.get('/', (req, res) => res.send(htmlPage));

// --- ЛОГИКА ТЕЛЕГРАМ-БОТА ---

bot.start((ctx) => {
    const webAppUrl = process.env.WEBAPP_URL || 'https://sport-ya.onrender.com/webapp';
    ctx.reply('💪 Добро пожаловать в премиум трекер отжиманий!', {
        reply_markup: {
            inline_keyboard: [[
                { text: "🚀 Открыть iOS Трекер", web_app: { url: webAppUrl } }
            ]]
        }
    });
});

bot.on('text', (ctx) => {
    const count = parseInt(ctx.message.text);
    if (!isNaN(count) && count > 0) {
        db.run(
            `INSERT INTO pushups (user_id, username, count) VALUES (?, ?, ?)`,
            [ctx.from.id, ctx.from.username || ctx.from.first_name, count],
            (err) => {
                if (err) return ctx.reply('❌ Ошибка записи.');
                ctx.reply(`✅ Записано: +${count} отжиманий! 🔥`);
            }
        );
    } else {
        ctx.reply('Отправьте число отжиманий (например: 25) или нажмите кнопку снизу для открытия Mini App.');
    }
});

schedule.scheduleJob('0 * * * *', () => {
    const currentHour = new Date().getHours();
    db.each(`SELECT * FROM settings`, (err, row) => {
        if (err || !row) return;
        const start = parseInt(row.start_time.split(':')[0]);
        const end = parseInt(row.end_time.split(':')[0]);

        if (currentHour >= start && currentHour <= end && (currentHour % row.frequency === 0)) {
            bot.telegram.sendMessage(row.user_id, '🔔 Время размяться! Сделай подход и запиши результат.').catch(() => {});
        }
    });
});

bot.launch();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
