const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const port = process.env.PORT || 10000;

// Инициализация Telegram-бота
const token = process.env.BOT_TOKEN;
let bot;
if (token) {
    bot = new TelegramBot(token, { polling: true });
    
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, 'Привет! Нажми кнопку ниже, чтобы открыть фитнес-трекер:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📊 Открыть Трекер', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }
                ]]
            }
        });
    });
}

// Подключение к Supabase (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Автоматическая инициализация таблиц
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pushups (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                count INT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id BIGINT PRIMARY KEY,
                goal INT DEFAULT 100,
                reminders_enabled BOOLEAN DEFAULT true,
                reminder_interval_hours INT DEFAULT 3,
                last_reminder_sent TIMESTAMP WITH TIME ZONE
            );
        `);
        console.log('✅ База данных Supabase и таблицы готовы к работе!');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}
initDB();

app.use(express.json());

// Фоновый планировщик напоминаний в Telegram (проверка каждые 5 минут)
setInterval(async () => {
    if (!bot) return;
    try {
        const res = await pool.query(`
            SELECT s.user_id, s.reminder_interval_hours 
            FROM user_settings s
            WHERE s.reminders_enabled = true 
              AND (s.last_reminder_sent IS NULL OR s.last_reminder_sent < NOW() - (s.reminder_interval_hours || ' hours')::INTERVAL)
              AND NOT EXISTS (
                  SELECT 1 FROM pushups p 
                  WHERE p.user_id = s.user_id 
                    AND p.created_at >= CURRENT_DATE
              )
        `);

        for (const row of res.rows) {
            bot.sendMessage(row.user_id, '💪 Пора сделать подход! Не забывай про свою дневную цель. Открой трекер в меню ниже.');
            await pool.query('UPDATE user_settings SET last_reminder_sent = NOW() WHERE user_id = $1', [row.user_id]);
        }
    } catch (e) {
        console.error('Ошибка отправки уведомлений:', e);
    }
}, 5 * 60 * 1000);

// --- API ЭНДПОИНТЫ ---

// 1. Получение полной информации пользователя
app.get('/api/user-data', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        // Настройки
        let settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        if (settingsRes.rows.length === 0) {
            await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
            settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        }

        // Сегодняшние подходы
        const todayRes = await pool.query(`
            SELECT id, count, created_at 
            FROM pushups 
            WHERE user_id = $1 AND created_at >= CURRENT_DATE 
            ORDER BY created_at DESC
        `, [userId]);

        // Общая статистика
        const totalRes = await pool.query('SELECT SUM(count) as total_count FROM pushups WHERE user_id = $1', [userId]);

        res.json({
            success: true,
            settings: settingsRes.rows[0],
            todayHistory: todayRes.rows,
            totalCount: parseInt(totalRes.rows[0].total_count) || 0
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Добавление подходов
app.post('/api/add', async (req, res) => {
    const { user_id, count } = req.body;
    if (!user_id || !count) return res.status(400).json({ error: 'Invalid data' });

    try {
        await pool.query('INSERT INTO pushups (user_id, count) VALUES ($1, $2)', [user_id, count]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Сохранение настроек (Цель, Напоминания)
app.post('/api/settings', async (req, res) => {
    const { user_id, goal, reminders_enabled, reminder_interval_hours } = req.body;
    try {
        await pool.query(`
            INSERT INTO user_settings (user_id, goal, reminders_enabled, reminder_interval_hours)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id) DO UPDATE SET
                goal = EXCLUDED.goal,
                reminders_enabled = EXCLUDED.reminders_enabled,
                reminder_interval_hours = EXCLUDED.reminder_interval_hours
        `, [user_id, goal, reminders_enabled, reminder_interval_hours]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 4. Данные для календаря
app.get('/api/calendar', async (req, res) => {
    const userId = req.query.user_id;
    try {
        const result = await pool.query(`
            SELECT DATE(created_at) as date, SUM(count) as total
            FROM pushups
            WHERE user_id = $1
            GROUP BY DATE(created_at)
            ORDER BY date DESC
            LIMIT 30
        `, [userId]);
        res.json({ success: true, calendar: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// --- ВЕБ ИНТЕРФЕЙС WEB APP (HTML/CSS/JS) ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>iOS Fitness Tracker</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --ios-bg: #000000;
            --glass-bg: rgba(255, 255, 255, 0.08);
            --glass-border: rgba(255, 255, 255, 0.15);
            --accent-green: #30d158;
            --accent-blue: #0a84ff;
            --accent-orange: #ff9f0a;
            --text-primary: #ffffff;
            --text-secondary: rgba(255, 255, 255, 0.6);
        }

        * {
            box-sizing: border-box;
            margin: 0; padding: 0;
            user-select: none;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Roboto, sans-serif;
        }

        body {
            background-color: var(--ios-bg);
            background-image: 
                radial-gradient(at 0% 0%, rgba(10, 132, 255, 0.2) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(48, 209, 88, 0.18) 0px, transparent 50%);
            background-attachment: fixed;
            color: var(--text-primary);
            min-height: 100vh;
            padding-top: max(16px, env(safe-area-inset-top));
            padding-bottom: max(90px, env(safe-area-inset-bottom));
            padding-left: 16px; padding-right: 16px;
            display: flex; flex-direction: column; gap: 16px;
        }

        .glass-card {
            background: var(--glass-bg);
            backdrop-filter: blur(25px) saturate(180%);
            -webkit-backdrop-filter: blur(25px) saturate(180%);
            border: 1px solid var(--glass-border);
            border-radius: 22px; padding: 18px;
        }

        .header { display: flex; justify-content: space-between; align-items: center; }
        .user-profile { display: flex; align-items: center; gap: 12px; }
        .avatar {
            width: 42px; height: 42px; border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 18px;
        }
        .title-sub { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .title-main { font-size: 19px; font-weight: 700; }

        .main-stats { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 10px; }
        .ring-container { position: relative; width: 100px; height: 100px; display: flex; align-items: center; justify-content: center; }
        .ring-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
        .ring-bg { fill: none; stroke: rgba(255, 255, 255, 0.1); stroke-width: 9; }
        .ring-progress {
            fill: none; stroke: url(#ringGradient); stroke-width: 9; stroke-linecap: round;
            stroke-dasharray: 283; stroke-dashoffset: 283; transition: stroke-dashoffset 0.8s ease;
        }
        .ring-text { position: absolute; text-align: center; }
        .ring-percent { font-size: 20px; font-weight: 800; }

        .stat-value { font-size: 26px; font-weight: 800; line-height: 1; }
        .stat-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

        .presets-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
        .btn-glass {
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 14px; padding: 12px 0; color: #fff; font-size: 15px; font-weight: 700;
            cursor: pointer; outline: none; display: flex; align-items: center; justify-content: center;
        }
        .btn-glass:active { transform: scale(0.93); background: rgba(255, 255, 255, 0.2); }

        .custom-input-group { display: flex; gap: 8px; margin-top: 10px; }
        .input-glass {
            flex: 1; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--glass-border);
            border-radius: 14px; padding: 0 14px; color: #fff; font-size: 15px; text-align: center; outline: none;
        }

        .history-list { display: flex; flex-direction: column; gap: 8px; max-height: 180px; overflow-y: auto; }
        .history-item {
            display: flex; justify-content: space-between; align-items: center; padding: 10px 14px;
            background: rgba(255, 255, 255, 0.04); border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.08);
        }

        /* Нижнее меню вкладок (TabBar) */
        .tab-bar {
            position: fixed; bottom: 0; left: 0; right: 0;
            background: rgba(20, 20, 20, 0.85);
            backdrop-filter: blur(25px) saturate(190%);
            border-top: 1px solid var(--glass-border);
            display: flex; justify-content: space-around;
            padding-top: 8px; padding-bottom: max(12px, env(safe-area-inset-bottom));
            z-index: 1000;
        }
        .tab-btn {
            background: none; border: none; color: var(--text-secondary);
            font-size: 11px; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer;
        }
        .tab-btn.active { color: var(--accent-blue); font-weight: 700; }
        .tab-icon { font-size: 18px; }

        .tab-content { display: none; }
        .tab-content.active { display: flex; flex-direction: column; gap: 16px; }

        .setting-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    </style>
</head>
<body>

    <!-- Вкладка 1: Главная -->
    <div id="tab-home" class="tab-content active">
        <div class="glass-card header">
            <div class="user-profile">
                <div class="avatar" id="userAvatar">U</div>
                <div>
                    <div class="title-sub">iOS Fitness Tracker</div>
                    <div class="title-main" id="userName">Пользователь</div>
                </div>
            </div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Дневной прогресс</div>
            <div class="main-stats">
                <div class="ring-container">
                    <svg class="ring-svg" viewBox="0 0 100 100">
                        <defs>
                            <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#30d158" />
                                <stop offset="100%" stop-color="#0a84ff" />
                            </linearGradient>
                        </defs>
                        <circle class="ring-bg" cx="50" cy="50" r="45"></circle>
                        <circle class="ring-progress" id="progressRing" cx="50" cy="50" r="45"></circle>
                    </svg>
                    <div class="ring-text">
                        <div class="ring-percent" id="percentText">0%</div>
                    </div>
                </div>

                <div style="flex:1; display:flex; flex-direction:column; gap:10px;">
                    <div>
                        <div class="stat-value" id="todayCount">0 <span style="font-size:14px; color:var(--text-secondary);">/ <span id="goalCount">100</span></span></div>
                        <div class="stat-desc">Отжиманий сегодня</div>
                    </div>
                    <div>
                        <div class="stat-value" id="setsCount" style="color:var(--accent-blue);">0</div>
                        <div class="stat-desc">Подходов сегодня</div>
                    </div>
                </div>
            </div>
        </div>

        <div>
            <div class="title-sub" style="margin-left: 4px; margin-bottom: 8px;">Быстрый ввод</div>
            <div class="presets-grid">
                <button class="btn-glass" onclick="addPushups(5)">+5</button>
                <button class="btn-glass" onclick="addPushups(10)">+10</button>
                <button class="btn-glass" onclick="addPushups(15)">+15</button>
                <button class="btn-glass" onclick="addPushups(20)">+20</button>
                <button class="btn-glass" onclick="addPushups(25)">+25</button>
            </div>
            <div class="custom-input-group">
                <input type="number" id="customInput" class="input-glass" placeholder="Свое число..." min="1">
                <button class="btn-glass" style="padding: 0 16px;" onclick="addCustom()">Записать</button>
            </div>
        </div>

        <div class="glass-card">
            <div class="title-sub" style="margin-bottom: 10px;">Сегодняшние подходы</div>
            <div class="history-list" id="historyList"></div>
        </div>
    </div>

    <!-- Вкладка 2: Календарь -->
    <div id="tab-calendar" class="tab-content">
        <div class="glass-card">
            <div class="title-sub" style="margin-bottom: 12px;">История по дням</div>
            <div class="history-list" id="calendarList">Загрузка...</div>
        </div>
    </div>

    <!-- Вкладка 3: Прогресс -->
    <div id="tab-progress" class="tab-content">
        <div class="glass-card">
            <div class="title-sub">Всего отжато за всё время</div>
            <div class="stat-value" id="totalAllTime" style="font-size:36px; color:var(--accent-green); margin-top:8px;">0</div>
        </div>
    </div>

    <!-- Вкладка 4: Настройки -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div class="title-sub" style="margin-bottom: 16px;">Настройки профиля</div>
            
            <div class="setting-row">
                <span>Дневная цель:</span>
                <input type="number" id="settingGoal" class="input-glass" style="width: 80px;" value="100">
            </div>

            <div class="setting-row">
                <span>Напоминания в боте:</span>
                <input type="checkbox" id="settingReminders" checked style="width: 20px; height: 20px;">
            </div>

            <div class="setting-row">
                <span>Частота (каждые N часов):</span>
                <input type="number" id="settingInterval" class="input-glass" style="width: 80px;" value="3" min="1" max="24">
            </div>

            <button class="btn-glass" style="width:100%; margin-top: 10px;" onclick="saveSettings()">Сохранить настройки</button>
        </div>
    </div>

    <!-- Нижняя панель навигации -->
    <div class="tab-bar">
        <button class="tab-btn active" onclick="switchTab('home', this)">
            <span class="tab-icon">📊</span>
            <span>Главная</span>
        </button>
        <button class="tab-btn" onclick="switchTab('calendar', this)">
            <span class="tab-icon">📅</span>
            <span>Календарь</span>
        </button>
        <button class="tab-btn" onclick="switchTab('progress', this)">
            <span class="tab-icon">📈</span>
            <span>Прогресс</span>
        </button>
        <button class="tab-btn" onclick="switchTab('settings', this)">
            <span class="tab-icon">⚙️</span>
            <span>Настройки</span>
        </button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        tg.ready();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 999999;

        if (user) {
            document.getElementById('userName').innerText = user.first_name || 'Спортсмен';
            document.getElementById('userAvatar').innerText = (user.first_name || 'U')[0].toUpperCase();
        }

        let userGoal = 100;

        function triggerHaptic() {
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
        }

        function switchTab(tabName, btn) {
            triggerHaptic();
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

            document.getElementById('tab-' + tabName).classList.add('active');
            btn.classList.add('active');

            if (tabName === 'calendar') loadCalendar();
        }

        async function loadUserData() {
            try {
                const res = await fetch(\`/api/user-data?user_id=\${userId}\`);
                const data = await res.json();

                if (data.success) {
                    userGoal = data.settings.goal || 100;
                    document.getElementById('goalCount').innerText = userGoal;
                    document.getElementById('settingGoal').value = userGoal;
                    document.getElementById('settingReminders').checked = data.settings.reminders_enabled;
                    document.getElementById('settingInterval').value = data.settings.reminder_interval_hours || 3;
                    document.getElementById('totalAllTime').innerText = data.totalCount;

                    let todayTotal = 0;
                    const historyList = document.getElementById('historyList');
                    historyList.innerHTML = '';

                    document.getElementById('setsCount').innerText = data.todayHistory.length;

                    if (data.todayHistory.length === 0) {
                        historyList.innerHTML = '<div style="text-align:center; color:var(--text-secondary); font-size:13px;">Подходов пока нет</div>';
                    } else {
                        data.todayHistory.forEach(row => {
                            todayTotal += row.count;
                            const timeStr = new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            historyList.innerHTML += \`
                                <div class="history-item">
                                    <span style="font-weight:700; color:var(--accent-green);">+\${row.count} отжиманий</span>
                                    <span style="font-size:12px; color:var(--text-secondary);">\${timeStr}</span>
                                </div>\`;
                        });
                    }

                    document.getElementById('todayCount').innerHTML = \`\${todayTotal} <span style="font-size:14px; color:var(--text-secondary);">/ \${userGoal}</span>\`;
                    const percent = Math.min(Math.round((todayTotal / userGoal) * 100), 100);
                    document.getElementById('percentText').innerText = \`\${percent}%\`;

                    const circle = document.getElementById('progressRing');
                    circle.style.strokeDashoffset = 283 - (percent / 100) * 283;
                }
            } catch (err) { console.error(err); }
        }

        async function addPushups(count) {
            triggerHaptic();
            await fetch('/api/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, count: count })
            });
            loadUserData();
        }

        function addCustom() {
            const val = parseInt(document.getElementById('customInput').value);
            if (val > 0) {
                addPushups(val);
                document.getElementById('customInput').value = '';
            }
        }

        async function saveSettings() {
            triggerHaptic();
            const goal = parseInt(document.getElementById('settingGoal').value);
            const reminders = document.getElementById('settingReminders').checked;
            const interval = parseInt(document.getElementById('settingInterval').value);

            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    goal: goal,
                    reminders_enabled: reminders,
                    reminder_interval_hours: interval
                })
            });
            alert('Настройки сохранены!');
            loadUserData();
        }

        async function loadCalendar() {
            const res = await fetch(\`/api/calendar?user_id=\${userId}\`);
            const data = await res.json();
            const list = document.getElementById('calendarList');
            list.innerHTML = '';
            if (data.calendar.length === 0) {
                list.innerHTML = '<div style="text-align:center; color:var(--text-secondary);">Записей нет</div>';
            } else {
                data.calendar.forEach(row => {
                    const dateStr = new Date(row.date).toLocaleDateString();
                    list.innerHTML += \`
                        <div class="history-item">
                            <span>\${dateStr}</span>
                            <span style="font-weight:700; color:var(--accent-blue);">\${row.total} отжиманий</span>
                        </div>\`;
                });
            }
        }

        loadUserData();
    </script>
</body>
</html>
    `);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
