const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// Переменные окружения (добавьте их в Render Environment Variables)
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.json());

// --- ОТПРАВКА УВЕДОМЛЕНИЙ В TELEGRAM ---
function sendTelegramMessage(chatId, text) {
    if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') return;
    const data = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + BOT_TOKEN + '/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('error', (e) => console.error('Ошибка отправки в TG:', e));
    req.write(data);
    req.end();
}

// Проверка напоминаний каждую минуту
setInterval(async () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const currentTime = hours + ':' + minutes;

    try {
        const { data: users, error } = await supabase
            .from('user_settings')
            .select('user_id, daily_goal')
            .eq('reminder_time', currentTime)
            .eq('notifications_enabled', true);

        if (!error && users) {
            users.forEach(user => {
                const msg = '🏋️ <b>Время тренировки!</b>\nПора отжаться. Твоя дневная цель: <b>' + user.daily_goal + '</b> повторений.';
                sendTelegramMessage(user.user_id, msg);
            });
        }
    } catch (e) {
        console.error('Ошибка проверки напоминаний:', e);
    }
}, 60000);

// --- API ENDPOINTS ---

// Сохранение подхода в таблицу pushups
app.post('/api/add', async (req, res) => {
    const { user_id, count, exercise_type } = req.body;
    if (!count || count <= 0) return res.status(400).json({ error: 'Некорректное значение' });

    const { data, error } = await supabase
        .from('pushups')
        .insert([{
            user_id: String(user_id || 'guest'),
            count: parseInt(count),
            exercise_type: exercise_type || 'pushups'
        }])
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
});

// Получение данных для календаря и графика
app.get('/api/stats', async (req, res) => {
    const userId = String(req.query.user_id || 'guest');

    const { data, error } = await supabase
        .from('pushups')
        .select('created_at, count')
        .eq('user_id', userId);

    if (error) return res.status(500).json({ error: error.message });

    const activeDates = Array.from(new Set(
        (data || []).map(r => new Date(r.created_at).toISOString().split('T')[0])
    ));

    res.json({ activeDates, rawData: data || [] });
});

// История подходов
app.get('/api/history', async (req, res) => {
    const userId = String(req.query.user_id || 'guest');
    const { data, error } = await supabase
        .from('pushups')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ history: data || [] });
});

// Удаление подхода
app.delete('/api/delete/:id', async (req, res) => {
    const { error } = await supabase
        .from('pushups')
        .delete()
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// Настройки
app.get('/api/settings', async (req, res) => {
    const userId = String(req.query.user_id || 'guest');
    const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || { daily_goal: 100, reminder_time: '20:00', notifications_enabled: true });
});

app.post('/api/settings', async (req, res) => {
    const { user_id, daily_goal, reminder_time, notifications_enabled } = req.body;
    const { error } = await supabase
        .from('user_settings')
        .upsert({
            user_id: String(user_id || 'guest'),
            daily_goal: parseInt(daily_goal),
            reminder_time: reminder_time,
            notifications_enabled: Boolean(notifications_enabled)
        });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- ФРОНТЕНД WEBAPP ---
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
            <div class="card-title">Календарь активности</div>
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

    <!-- НАСТРОЙКИ -->
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
            document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.nav-item').forEach(function(b) { b.classList.remove('active'); });
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
                body: JSON.stringify({ user_id: userId, count: currentCount, exercise_type: 'pushups' })
            });
            if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
            resetCounter();
            alert('Подход сохранен!');
        }

        async function loadAnalytics() {
            const res = await fetch('/api/stats?user_id=' + userId);
            const data = await res.json();
            renderCalendar(data.activeDates || []);
            renderChart(data.rawData || []);
        }

        function renderCalendar(activeDates) {
            const calGrid = document.getElementById('calendarGrid');
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth();
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
            let html = dayNames.map(function(d) {
                return '<div class="cal-day-name">' + d + '</div>';
            }).join('');

            for (let day = 1; day <= daysInMonth; day++) {
                const mStr = String(month + 1).padStart(2, '0');
                const dStr = String(day).padStart(2, '0');
                const dateStr = year + '-' + mStr + '-' + dStr;
                const isActive = activeDates.includes(dateStr) ? 'active' : '';
                html += '<div class="cal-day ' + isActive + '">' + day + '</div>';
            }
            calGrid.innerHTML = html;
        }

        function renderChart(rawData) {
            const ctx = document.getElementById('progressChart').getContext('2d');
            
            const labels = [];
            const values = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().split('T')[0];
                labels.push(d.toLocaleDateString('ru', { weekday: 'short', day: 'numeric' }));
                
                const sum = rawData
                    .filter(function(item) { return item.created_at.startsWith(dateStr); })
                    .reduce(function(acc, curr) { return acc + curr.count; }, 0);

                values.push(sum);
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

            container.innerHTML = data.history.map(function(item) {
                return '<div class="history-item">' +
                    '<div>' +
                        '<div style="font-weight:600;">' + (item.exercise_type || 'Отжимания') + '</div>' +
                        '<div class="history-date">' + new Date(item.created_at).toLocaleString('ru') + '</div>' +
                    '</div>' +
                    '<div style="display:flex; align-items:center; gap:10px;">' +
                        '<span class="history-val">+' + item.count + '</span>' +
                        '<button class="btn-del" onclick="deleteHistory(' + item.id + ')">🗑</button>' +
                    '</div>' +
                '</div>';
            }).join('');
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
            document.getElementById('settingNotify').checked = settings.notifications_enabled !== false;
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

app.listen(port, () => console.log('Сервер запущен на порту ' + port));
