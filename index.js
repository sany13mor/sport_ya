const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!SUPABASE_URL || !SUPABASE_URL.startsWith('http')) {
    console.error('❌ SUPABASE_URL не задан или некорректен.');
}

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

app.use(express.json());

// --- TELEGRAM BOT HELPER (С поддержки Inline-кнопок) ---
function sendTelegramMessage(chatId, text, replyMarkup = null) {
    if (!BOT_TOKEN) return;
    const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const data = JSON.stringify(payload);
    const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + BOT_TOKEN + '/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('error', (e) => console.error('Ошибка TG API:', e));
    req.write(data);
    req.end();
}

// --- СЛУЖБА НАПОМИНАНИЙ С УЧЕТОМ ДИАПАЗОНА ВРЕМЕНИ ---
setInterval(async () => {
    if (!supabase) return;
    const now = new Date();
    const currentHHMM = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    try {
        const { data: users } = await supabase.from('user_settings').select('*').eq('notifications_enabled', true);
        if (!users) return;

        users.forEach(user => {
            const start = user.reminder_start || '09:00';
            const end = user.reminder_end || '22:00';

            // Проверка попадания в диапазон времени
            if (currentHHMM >= start && currentHHMM <= end && currentHHMM.endsWith(':00')) {
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '+10 🏋️', callback_data: 'add_10' },
                            { text: '+20 🏋️', callback_data: 'add_20' },
                            { text: '+30 🏋️', callback_data: 'add_30' }
                        ],
                        [
                            { text: '⏳ 15 мин', callback_data: 'snooze_15' },
                            { text: '⏳ 30 мин', callback_data: 'snooze_30' },
                            { text: '⏳ 1 час', callback_data: 'snooze_60' }
                        ]
                    ]
                };

                const msg = `🔥 <b>iOS Fitness Reminder</b>\nПора сделать подход! Дневная цель: <b>${user.daily_goal || 100}</b>.`;
                sendTelegramMessage(user.user_id, msg, keyboard);
            }
        });
    } catch (e) {
        console.error('Ошибка проверки напоминаний:', e);
    }
}, 60000);

// --- WEBHOOK ДЛЯ ОБРАБОТКИ ИНТЕРАКТИВНЫХ КНОПОК TELEGRAM ---
app.post('/api/telegram-webhook', async (req, res) => {
    const { callback_query } = req.body;
    if (callback_query && supabase) {
        const chatId = callback_query.message.chat.id;
        const action = callback_query.data;

        if (action.startsWith('add_')) {
            const count = parseInt(action.replace('add_', ''));
            await supabase.from('pushups').insert([{ user_id: String(chatId), count: count, exercise_type: 'pushups' }]);
            sendTelegramMessage(chatId, `✅ Добавлено <b>+${count}</b> подтягиваний/отжиманий в статистику!`);
        } else if (action.startsWith('snooze_')) {
            const mins = action.replace('snooze_', '');
            sendTelegramMessage(chatId, `⏳ Напоминание отложено на <b>${mins} минут</b>.`);
        }
    }
    res.sendStatus(200);
});

// --- API ENDPOINTS ---

app.post('/api/add', async (req, res) => {
    const { user_id, count, exercise_type } = req.body;
    if (!supabase) return res.status(500).json({ error: 'База данных не настроена' });
    const { data, error } = await supabase.from('pushups').insert([{
        user_id: String(user_id || 'guest'),
        count: parseInt(count),
        exercise_type: exercise_type || 'pushups'
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, data });
});

app.get('/api/stats', async (req, res) => {
    if (!supabase) return res.json({ activeDates: [], rawData: [] });
    const userId = String(req.query.user_id || 'guest');
    const { data } = await supabase.from('pushups').select('created_at, count').eq('user_id', userId);
    const activeDates = Array.from(new Set((data || []).map(r => new Date(r.created_at).toISOString().split('T')[0])));
    res.json({ activeDates, rawData: data || [] });
});

app.get('/api/history', async (req, res) => {
    if (!supabase) return res.json({ history: [] });
    const userId = String(req.query.user_id || 'guest');
    const { data } = await supabase.from('pushups').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    res.json({ history: data || [] });
});

app.delete('/api/delete/:id', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'DB Error' });
    await supabase.from('pushups').delete().eq('id', req.params.id);
    res.json({ success: true });
});

app.get('/api/profile', async (req, res) => {
    if (!supabase) return res.json({});
    const userId = String(req.query.user_id || 'guest');
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', userId).maybeSingle();
    res.json(data || {
        daily_goal: 100,
        reminder_start: '09:00',
        reminder_end: '21:00',
        notifications_enabled: true,
        weight: 75,
        height: 180,
        target_weight: 70,
        body_fat: 15,
        level: 'Продвинутый'
    });
});

app.post('/api/profile', async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'DB Error' });
    const { user_id, ...settings } = req.body;
    const { error } = await supabase.from('user_settings').upsert({ user_id: String(user_id || 'guest'), ...settings });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- ФРОНТЕНД С ИНТЕРФЕЙСОМ iOS 19 GLASS ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Fitness iOS 19 Glass</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --glass-bg: rgba(255, 255, 255, 0.07);
            --glass-border: rgba(255, 255, 255, 0.15);
            --glass-card: rgba(30, 41, 59, 0.45);
            --accent-blue: #38bdf8;
            --accent-green: #22c55e;
            --accent-purple: #a855f7;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
        
        body {
            background: radial-gradient(circle at 50% -20%, #1e1b4b 0%, #0f172a 50%, #020617 100%);
            background-attachment: fixed;
            color: #f8fafc;
            min-height: 100vh;
            padding-top: env(safe-area-inset-top);
            padding-bottom: calc(90px + env(safe-area-inset-bottom));
        }

        /* Glass Header */
        .header {
            background: rgba(15, 23, 42, 0.65);
            backdrop-filter: blur(25px) saturate(180%);
            -webkit-backdrop-filter: blur(25px) saturate(180%);
            border-bottom: 1px solid var(--glass-border);
            padding: 16px 20px;
            position: sticky;
            top: 0;
            z-index: 50;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .user-title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; display: flex; align-items: center; gap: 8px; }

        .tab-content { display: none; padding: 16px; max-width: 500px; margin: 0 auto; animation: fadeIn 0.25s ease-out; }
        .tab-content.active { display: block; }

        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

        /* Liquid Glass Cards */
        .glass-card {
            background: var(--glass-card);
            backdrop-filter: blur(20px) saturate(160%);
            -webkit-backdrop-filter: blur(20px) saturate(160%);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            padding: 20px;
            margin-bottom: 16px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        }

        .card-label { font-size: 12px; text-transform: uppercase; color: #94a3b8; font-weight: 700; letter-spacing: 0.08em; margin-bottom: 12px; }

        .counter-val { font-size: 56px; font-weight: 900; text-align: center; color: var(--accent-blue); text-shadow: 0 0 20px rgba(56, 189, 248, 0.4); margin: 10px 0; }

        /* Glass Grids & Buttons */
        .presets-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0; }
        .btn-glass {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: #fff;
            padding: 14px;
            border-radius: 16px;
            font-size: 17px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .btn-glass:active { transform: scale(0.95); background: rgba(255, 255, 255, 0.18); }

        .btn-action {
            width: 100%;
            background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
            border: none;
            color: #fff;
            padding: 18px;
            border-radius: 18px;
            font-size: 18px;
            font-weight: 800;
            box-shadow: 0 10px 25px rgba(34, 197, 94, 0.35);
            cursor: pointer;
        }
        .btn-action:active { transform: scale(0.97); }

        /* Athlete Profile Glass Card */
        .profile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
        .profile-stat { background: rgba(15, 23, 42, 0.5); padding: 14px; border-radius: 16px; border: 1px solid var(--glass-border); text-align: center; }
        .profile-stat-val { font-size: 22px; font-weight: 800; color: #38bdf8; }
        .profile-stat-lbl { font-size: 11px; color: #94a3b8; text-transform: uppercase; margin-top: 2px; }

        /* Form Inputs */
        .form-row { margin-bottom: 14px; }
        .form-label { font-size: 12px; color: #94a3b8; display: block; margin-bottom: 6px; font-weight: 600; }
        .form-input {
            width: 100%;
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid var(--glass-border);
            color: #fff;
            padding: 14px;
            border-radius: 14px;
            font-size: 16px;
            outline: none;
        }

        /* iOS Bottom Glass Navbar */
        .navbar {
            position: fixed;
            bottom: 0; left: 0; right: 0;
            background: rgba(15, 23, 42, 0.75);
            backdrop-filter: blur(30px) saturate(200%);
            -webkit-backdrop-filter: blur(30px) saturate(200%);
            border-top: 1px solid var(--glass-border);
            display: flex;
            justify-content: space-around;
            padding: 12px 0 calc(12px + env(safe-area-inset-bottom));
            z-index: 100;
        }
        .nav-btn { background: none; border: none; color: #64748b; font-size: 11px; font-weight: 700; display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; width: 25%; }
        .nav-btn.active { color: var(--accent-blue); }
        .nav-btn span { font-size: 20px; }

        /* Calendar Grid */
        .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; text-align: center; margin-top: 10px; }
        .cal-day-name { font-size: 11px; color: #64748b; font-weight: 700; }
        .cal-day { aspect-ratio: 1; border-radius: 10px; background: rgba(15, 23, 42, 0.4); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #64748b; }
        .cal-day.active { background: rgba(34, 197, 94, 0.25); color: #4ade80; border: 1px solid #22c55e; font-weight: 800; }
    </style>
</head>
<body>

    <div class="header">
        <div class="user-title">⚡ <span id="username">Атлет</span></div>
        <div style="font-size: 13px; color: var(--accent-blue); font-weight: 700;">Цель: <span id="headerGoal">100</span></div>
    </div>

    <!-- ТАБ: ЗАПИСЬ -->
    <div id="tab-workout" class="tab-content active">
        <div class="glass-card">
            <div class="card-label">Новый подход</div>
            <div class="counter-val" id="counter">0</div>
            <div class="presets-grid">
                <button class="btn-glass" onclick="addValue(10)">+10</button>
                <button class="btn-glass" onclick="addValue(15)">+15</button>
                <button class="btn-glass" onclick="addValue(20)">+20</button>
                <button class="btn-glass" onclick="addValue(25)">+25</button>
                <button class="btn-glass" onclick="addValue(30)">+30</button>
                <button class="btn-glass" onclick="resetCounter()">Сброс</button>
            </div>
            <button class="btn-action" onclick="submitWorkout()">Сохранить подход</button>
        </div>
    </div>

    <!-- ТАБ: ПРОФИЛЬ / КАРТОЧКА СПОРТСМЕНА -->
    <div id="tab-profile" class="tab-content">
        <div class="glass-card">
            <div class="card-label">Карточка Атлета (iOS Health)</div>
            <div class="profile-grid">
                <div class="profile-stat">
                    <div class="profile-stat-val" id="profWeight">75 кг</div>
                    <div class="profile-stat-lbl">Текущий вес</div>
                </div>
                <div class="profile-stat">
                    <div class="profile-stat-val" id="profHeight">180 см</div>
                    <div class="profile-stat-lbl">Рост</div>
                </div>
                <div class="profile-stat">
                    <div class="profile-stat-val" id="profBmi">23.1</div>
                    <div class="profile-stat-lbl">Индекс ИМТ</div>
                </div>
                <div class="profile-stat">
                    <div class="profile-stat-val" id="profFat">15%</div>
                    <div class="profile-stat-lbl">Процент жира</div>
                </div>
            </div>
        </div>

        <div class="glass-card">
            <div class="card-label">Редактировать параметры</div>
            <div class="form-row">
                <label class="form-label">Вес (кг)</label>
                <input type="number" id="editWeight" class="form-input" value="75">
            </div>
            <div class="form-row">
                <label class="form-label">Рост (см)</label>
                <input type="number" id="editHeight" class="form-input" value="180">
            </div>
            <div class="form-row">
                <label class="form-label">Целевой вес (кг)</label>
                <input type="number" id="editTargetWeight" class="form-input" value="70">
            </div>
            <div class="form-row">
                <label class="form-label">% жира в организме</label>
                <input type="number" id="editFat" class="form-input" value="15">
            </div>
            <button class="btn-action" style="background: linear-gradient(135deg, #38bdf8 0%, #0284c7 100%);" onclick="saveProfile()">Обновить профиль</button>
        </div>
    </div>

    <!-- ТАБ: ПРОГРЕСС -->
    <div id="tab-analytics" class="tab-content">
        <div class="glass-card">
            <div class="card-label">Динамика за 7 дней</div>
            <canvas id="progressChart" height="180"></canvas>
        </div>
        <div class="glass-card">
            <div class="card-label">Календарь активности</div>
            <div class="calendar-grid" id="calendarGrid"></div>
        </div>
    </div>

    <!-- ТАБ: НАСТРОЙКИ -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div class="card-label">Уведомления и диапазон времени</div>
            <div class="form-row">
                <label class="form-label">Дневная цель (повторений)</label>
                <input type="number" id="settingGoal" class="form-input" value="100">
            </div>
            <div class="form-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div>
                    <label class="form-label">Начало (С скольки)</label>
                    <input type="time" id="settingStart" class="form-input" value="09:00">
                </div>
                <div>
                    <label class="form-label">Конец (До скольки)</label>
                    <input type="time" id="settingEnd" class="form-input" value="21:00">
                </div>
            </div>
            <button class="btn-action" onclick="saveSettings()">Сохранить настройки</button>
        </div>
    </div>

    <!-- NAVBAR -->
    <div class="navbar">
        <button class="nav-btn active" onclick="switchTab('workout', this)"><span>🏋️</span>Запись</button>
        <button class="nav-btn" onclick="switchTab('profile', this)"><span>👤</span>Профиль</button>
        <button class="nav-btn" onclick="switchTab('analytics', this)"><span>📊</span>Прогресс</button>
        <button class="nav-btn" onclick="switchTab('settings', this)"><span>⚙️</span>Настройки</button>
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
            if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
        }

        function resetCounter() {
            currentCount = 0;
            document.getElementById('counter').innerText = '0';
        }

        function switchTab(tabId, btn) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('tab-' + tabId).classList.add('active');
            btn.classList.add('active');

            if (tabId === 'profile') loadProfile();
            if (tabId === 'analytics') loadAnalytics();
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
            alert('Подход успешно зафиксирован!');
        }

        async function loadProfile() {
            const res = await fetch('/api/profile?user_id=' + userId);
            const p = await res.json();
            
            document.getElementById('profWeight').innerText = (p.weight || 75) + ' кг';
            document.getElementById('profHeight').innerText = (p.height || 180) + ' см';
            document.getElementById('profFat').innerText = (p.body_fat || 15) + '%';
            
            // ИМТ калькулятор
            const hM = (p.height || 180) / 100;
            const bmi = ((p.weight || 75) / (hM * hM)).toFixed(1);
            document.getElementById('profBmi').innerText = bmi;

            document.getElementById('editWeight').value = p.weight || 75;
            document.getElementById('editHeight').value = p.height || 180;
            document.getElementById('editTargetWeight').value = p.target_weight || 70;
            document.getElementById('editFat').value = p.body_fat || 15;
        }

        async function saveProfile() {
            const weight = parseFloat(document.getElementById('editWeight').value);
            const height = parseFloat(document.getElementById('editHeight').value);
            const target_weight = parseFloat(document.getElementById('editTargetWeight').value);
            const body_fat = parseFloat(document.getElementById('editFat').value);

            await fetch('/api/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, weight, height, target_weight, body_fat })
            });
            alert('Карточка атлета обновлена!');
            loadProfile();
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
            let html = dayNames.map(d => `<div class="cal-day-name">${d}</div>`).join('');

            for (let day = 1; day <= daysInMonth; day++) {
                const mStr = String(month + 1).padStart(2, '0');
                const dStr = String(day).padStart(2, '0');
                const dateStr = `${year}-${mStr}-${dStr}`;
                const isActive = activeDates.includes(dateStr) ? 'active' : '';
                html += `<div class="cal-day ${isActive}">${day}</div>`;
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
                labels.push(d.toLocaleDateString('ru', { weekday: 'short' }));
                
                const sum = rawData
                    .filter(item => item.created_at.startsWith(dateStr))
                    .reduce((acc, curr) => acc + curr.count, 0);

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
                        borderRadius: 8
                    }]
                },
                options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
        }

        async function loadSettings() {
            const res = await fetch('/api/profile?user_id=' + userId);
            const settings = await res.json();
            document.getElementById('settingGoal').value = settings.daily_goal || 100;
            document.getElementById('settingStart').value = settings.reminder_start || '09:00';
            document.getElementById('settingEnd').value = settings.reminder_end || '21:00';
            document.getElementById('headerGoal').innerText = settings.daily_goal || 100;
        }

        async function saveSettings() {
            const goal = parseInt(document.getElementById('settingGoal').value);
            const start = document.getElementById('settingStart').value;
            const end = document.getElementById('settingEnd').value;

            await fetch('/api/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    daily_goal: goal,
                    reminder_start: start,
                    reminder_end: end
                })
            });

            document.getElementById('headerGoal').innerText = goal;
            alert('Настройки диапазонов сохранены!');
        }

        loadSettings();
    </script>
</body>
</html>
    `);
});

app.listen(port, () => console.log('Сервер запущен на порту ' + port));
