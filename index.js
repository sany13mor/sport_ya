const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

app.use(express.json());

// --- БАЗА ДАННЫХ ---
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Ошибка БД:', err.message);
    else console.log('SQLite подключена.');
});

db.serialize(() => {
    // Таблица подходов
    db.run(`CREATE TABLE IF NOT EXISTS workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        count INTEGER,
        exercise TEXT DEFAULT 'pushups',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Таблица настроек и времени напоминаний
    db.run(`CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        daily_goal INTEGER DEFAULT 100,
        reminder_time TEXT DEFAULT '20:00',
        notifications_enabled INTEGER DEFAULT 1
    )`);
});

// --- ВНИМАНИЕ: СЕРВИС УВЕДОМЛЕНИЙ ПО ВРЕМЕНИ ---
function sendTelegramMessage(chatId, text) {
    if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') return;
    const data = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('error', (e) => console.error('Ошибка отправки в TG:', e));
    req.write(data);
    req.end();
}

// Проверка совпадения времени каждую минуту (HH:MM)
setInterval(() => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;

    db.all(
        `SELECT user_id, daily_goal FROM user_settings WHERE reminder_time = ? AND notifications_enabled = 1`,
        [currentTime],
        (err, rows) => {
            if (err || !rows) return;
            rows.forEach(user => {
                const msg = `🏋️ <b>Время тренировки!</b>\nПора отжаться. Твоя дневная цель: <b>${user.daily_goal}</b> повторений.`;
                sendTelegramMessage(user.user_id, msg);
            });
        }
    );
}, 60000);

// --- API ENDPOINTS ---

// Сохранение подхода
app.post('/api/add', (req, res) => {
    const { user_id, count, exercise } = req.body;
    if (!count || count <= 0) return res.status(400).json({ error: 'Некорректное значение' });

    db.run(
        `INSERT INTO workouts (user_id, count, exercise) VALUES (?, ?, ?)`,
        [String(user_id || 'guest'), count, exercise || 'pushups'],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Реальная статистика, активные дни для календаря и данные графика за 7 дней
app.get('/api/stats', (req, res) => {
    const userId = String(req.query.user_id || 'guest');

    // 1. Даты активности для Календаря
    db.all(
        `SELECT DISTINCT DATE(created_at, 'localtime') as date FROM workouts WHERE user_id = ?`,
        [userId],
        (err, activeRows) => {
            if (err) return res.status(500).json({ error: err.message });
            const activeDates = activeRows.map(r => r.date);

            // 2. Статистика за последние 7 дней для Графика
            db.all(
                `SELECT DATE(created_at, 'localtime') as date, SUM(count) as total 
                 FROM workouts 
                 WHERE user_id = ? AND created_at >= DATE('now', '-6 days', 'localtime')
                 GROUP BY DATE(created_at, 'localtime')`,
                [userId],
                (err, chartRows) => {
                    if (err) return res.status(500).json({ error: err.message });

                    res.json({
                        activeDates: activeDates,
                        chartData: chartRows
                    });
                }
            );
        }
    );
});

// История подходов
app.get('/api/history', (req, res) => {
    const userId = String(req.query.user_id || 'guest');
    db.all(
        `SELECT id, count, exercise, created_at FROM workouts WHERE user_id = ? ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ history: rows });
        }
    );
});

// Удаление записи
app.delete('/api/delete/:id', (req, res) => {
    db.run(`DELETE FROM workouts WHERE id = ?`, [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Настройки пользователя (цель и время уведомлений)
app.get('/api/settings', (req, res) => {
    const userId = String(req.query.user_id || 'guest');
    db.get(`SELECT * FROM user_settings WHERE user_id = ?`, [userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { daily_goal: 100, reminder_time: '20:00', notifications_enabled: 1 });
    });
});

app.post('/api/settings', (req, res) => {
    const { user_id, daily_goal, reminder_time, notifications_enabled } = req.body;
    db.run(
        `INSERT INTO user_settings (user_id, daily_goal, reminder_time, notifications_enabled) 
         VALUES (?, ?, ?, ?) 
         ON CONFLICT(user_id) DO UPDATE SET 
            daily_goal = excluded.daily_goal,
            reminder_time = excluded.reminder_time,
            notifications_enabled = excluded.notifications_enabled`,
        [String(user_id || 'guest'), daily_goal, reminder_time, notifications_enabled ? 1 : 0],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// --- ФРОНТЕНД ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Sport App</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
        body { background: #0f172a; color: #f8fafc; min-height: 100vh; padding-bottom: 80px; }

        .header { background: rgba(30, 41, 59, 0.8); backdrop-filter: blur(12px); padding: 16px; border-bottom: 1px solid #334155; position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; }
        .user-badge { font-weight: 700; font-size: 16px; display: flex; align-items: center; gap: 8px; }

        .tab-content { display: none; padding: 16px; max-width: 480px; margin: 0 auto; }
        .tab-content.active { display: block; }

        .card { background: #1e293b; border-radius: 16px; padding: 20px; border: 1px solid #334155; margin-bottom: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3); }
        .card-title { font-size: 13px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.05em; font-weight: 700; margin-bottom: 12px; }

        .big-counter { font-size: 42px; font-weight: 800; text-align: center; color: #38bdf8; margin: 10px 0; }
        .presets-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0; }
        .btn-preset { background: #334155; border: none; color: #fff; padding: 12px; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; }
        .btn-preset:active { background: #475569; transform: scale(0.96); }
        .btn-primary { width: 100%; background: #22c55e; border: none; color: #fff; padding: 16px; border-radius: 12px; font-size: 18px; font-weight: 700; cursor: pointer; }
        .btn-primary:active { background: #16a34a; transform: scale(0.98); }

        .form-group { margin-bottom: 14px; }
        .form-label { font-size: 13px; color: #94a3b8; display: block; margin-bottom: 6px; }
        .form-input { width: 100%; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 12px; border-radius: 10px; font-size: 16px; outline: none; }

        .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; text-align: center; margin-top: 10px; }
        .cal-day-name { font-size: 11px; color: #64748b; font-weight: 700; padding-bottom: 4px; }
        .cal-day { aspect-ratio: 1; border-radius: 8px; background: #0f172a; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #64748b; }
        .cal-day.active { background: rgba(34, 197, 94, 0.25); color: #4ade80; border: 1px solid #22c55e; font-weight: 700; }

        .history-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #0f172a; border-radius: 10px; margin-bottom: 8px; border: 1px solid #334155; }
        .history-date { font-size: 11px; color: #64748b; }
        .history-val { font-weight: 700; color: #38bdf8; font-size: 16px; }
        .btn-del { background: none; border: none; color: #ef4444; font-size: 18px; padding: 4px; cursor: pointer; }

        .navbar { position: fixed; bottom: 0; left: 0; right: 0; background: #1e293b; border-top: 1px solid #334155; display: flex; justify-content: space-around; padding: 10px 0; z-index: 100; }
        .nav-item { border: none; background: none; color: #64748b; font-size: 11px; font-weight: 600; display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; width: 25%; }
        .nav-item.active { color: #38bdf8; }
    </style>
</head>
<body>

    <div class="header">
        <div class="user-badge">💪 <span id="username">Спортсмен</span></div>
        <div style="font-size: 13px; color: #38bdf8;">Цель: <b id="headerGoal">100</b></div>
    </div>

    <!-- ТРЕНИРОВКА -->
    <div id="tab-workout" class="tab-content active">
        <div class="card">
            <div class="card-title">Новый подход</div>
            <div class="big-counter" id="counter">0</div>
            <div class="presets-grid">
                <button class="btn-preset" onclick="addValue(10)">+10</button>
                <button class="btn-preset" onclick="addValue(15)">+15</button>
                <button class="btn-preset" onclick="addValue(20)">+20</button>
                <button class="btn-preset" onclick="addValue(25)">+25</button>
                <button class="btn-preset" onclick="addValue(30)">+30</button>
                <button class="btn-preset" onclick="resetCounter()">Сброс</button>
            </div>
            <button class="btn-primary" onclick="submitWorkout()">Сохранить подход</button>
        </div>
    </div>

    <!-- АНАЛИТИКА И КАЛЕНДАРЬ -->
    <div id="tab-analytics" class="tab-content">
        <div class="card">
            <div class="card-title">Прогресс за 7 дней</div>
            <canvas id="progressChart" height="200"></canvas>
        </div>

        <div class="card">
            <div class="card-title" id="calendarTitle">Календарь активности</div>
            <div class="calendar-grid" id="calendarGrid"></div>
        </div>
    </div>

    <!-- ИСТОРИЯ -->
    <div id="tab-history" class="tab-content">
        <div class="card">
            <div class="card-title">История подходов</div>
            <div id="historyList">Загрузка...</div>
        </div>
    </div>

    <!-- НАСТРОЙКИ УВЕДОМЛЕНИЙ -->
    <div id="tab-settings" class="tab-content">
        <div class="card">
            <div class="card-title">Настройки и Напоминания</div>
            <div class="form-group">
                <label class="form-label">Дневная цель (повторений)</label>
                <input type="number" id="settingGoal" class="form-input" value="100">
            </div>
            <div class="form-group">
                <label class="form-label">Время напоминания бота (ЧЧ:ММ)</label>
                <input type="time" id="settingTime" class="form-input" value="20:00">
            </div>
            <div class="form-group" style="display:flex; align-items:center; gap:10px; margin-top:16px;">
                <input type="checkbox" id="settingNotify" style="width:20px; height:20px;" checked>
                <label for="settingNotify" style="font-size:14px;">Включить уведомления</label>
            </div>
            <button class="btn-primary" style="margin-top:16px;" onclick="saveSettings()">Сохранить настройки</button>
        </div>
    </div>

    <div class="navbar">
        <button class="nav-item active" onclick="switchTab('workout', this)"><span>🏋️</span>Запись</button>
        <button class="nav-item" onclick="switchTab('analytics', this)"><span>📊</span>Прогресс</button>
        <button class="nav-item" onclick="switchTab('history', this)"><span>📜</span>История</button>
        <button class="nav-item" onclick="switchTab('settings', this)"><span>⚙️</span>Настройки</button>
    </div>

    <script>
        const tg = window.Telegram?.WebApp;
        if (tg) { tg.expand(); tg.ready(); }

        const userId = tg?.initDataUnsafe?.user?.id || 'demo_user';
        if (tg?.initDataUnsafe?.user?.first_name) {
            document.getElementById('username').innerText = tg.initDataUnsafe.user.first_name;
        }

        let currentCount = 0;
        let chartInstance = null;

        function addValue(v) {
            currentCount += v;
            document.getElementById('counter').innerText = currentCount;
            if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
        }

        function resetCounter() {
            currentCount = 0;
            document.getElementById('counter').innerText = '0';
        }

        function switchTab(tabId, btn) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            btn.classList.add('active');

            if (tabId === 'analytics') loadAnalytics();
            if (tabId === 'history') loadHistory();
            if (tabId === 'settings') loadSettings();
        }

        async function submitWorkout() {
            if (currentCount <= 0) return alert('Укажите количество');
            await fetch('/api/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, count: currentCount, exercise: 'pushups' })
            });
            if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            resetCounter();
            alert('Подход сохранен!');
        }

        async function loadAnalytics() {
            const res = await fetch('/api/stats?user_id=' + userId);
            const data = await res.json();

            // 1. Построение календаря текущего месяца с активными днями из БД
            renderCalendar(data.activeDates || []);

            // 2. Построение графика за последние 7 дней из БД
            renderChart(data.chartData || []);
        }

        function renderCalendar(activeDates) {
            const calGrid = document.getElementById('calendarGrid');
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth();
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
            let html = dayNames.map(d => `<div class="cal-day-name">\${d}</div>`).join('');

            for (let day = 1; day <= daysInMonth; day++) {
                const dateStr = `\${year}-\${String(month + 1).padStart(2, '0')}-\${String(day).padStart(2, '0')}`;
                const isActive = activeDates.includes(dateStr) ? 'active' : '';
                html += `<div class="cal-day \${isActive}">\${day}</div>`;
            }
            calGrid.innerHTML = html;
        }

        function renderChart(chartData) {
            const ctx = document.getElementById('progressChart').getContext('2d');
            
            // Генерация последних 7 дней для оси X
            const labels = [];
            const values = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().split('T')[0];
                labels.push(d.toLocaleDateString('ru', { weekday: 'short', day: 'numeric' }));
                
                const found = chartData.find(item => item.date === dateStr);
                values.push(found ? found.total : 0);
            }

            if (chartInstance) chartInstance.destroy();
            chartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Повторения',
                        data: values,
                        backgroundColor: '#38bdf8',
                        borderRadius: 6
                    }]
                },
                options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
        }

        async function loadHistory() {
            const res = await fetch('/api/history?user_id=' + userId);
            const data = await res.json();
            const container = document.getElementById('historyList');

            if (!data.history.length) {
                container.innerHTML = '<div style="color:#64748b; text-align:center;">Записей не найдено</div>';
                return;
            }

            container.innerHTML = data.history.map(item => `
                <div class="history-item">
                    <div>
                        <div style="font-weight:600;">Отжимания</div>
                        <div class="history-date">\${new Date(item.created_at).toLocaleString('ru')}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span class="history-val">+\${item.count}</span>
                        <button class="btn-del" onclick="deleteHistory(\${item.id})">🗑</button>
                    </div>
                </div>
            `).join('');
        }

        async function deleteHistory(id) {
            await fetch('/api/delete/' + id, { method: 'DELETE' });
            loadHistory();
        }

        async function loadSettings() {
            const res = await fetch('/api/settings?user_id=' + userId);
            const settings = await res.json();
            document.getElementById('settingGoal').value = settings.daily_goal || 100;
            document.getElementById('settingTime').value = settings.reminder_time || '20:00';
            document.getElementById('settingNotify').checked = settings.notifications_enabled === 1;
            document.getElementById('headerGoal').innerText = settings.daily_goal || 100;
        }

        async function saveSettings() {
            const goal = parseInt(document.getElementById('settingGoal').value);
            const time = document.getElementById('settingTime').value;
            const notify = document.getElementById('settingNotify').checked;

            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    daily_goal: goal,
                    reminder_time: time,
                    notifications_enabled: notify
                })
            });

            document.getElementById('headerGoal').innerText = goal;
            alert('Настройки сохранены!');
        }

        loadSettings();
    </script>
</body>
</html>
    `);
});

app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));
