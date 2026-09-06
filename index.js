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
        bot.sendMessage(chatId, 'Привет! Нажми кнопку ниже, чтобы открыть обновленный трекер:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📊 Открыть iOS Трекер', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }
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

// Автоинициализация и миграция таблиц
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
                reminder_start_hour INT DEFAULT 10,
                reminder_end_hour INT DEFAULT 23,
                last_reminder_sent TIMESTAMP WITH TIME ZONE
            );
            ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reminder_start_hour INT DEFAULT 10;
            ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS reminder_end_hour INT DEFAULT 23;
        `);
        console.log('✅ База данных Supabase и таблицы готовы к работе!');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}
initDB();

app.use(express.json());

// Планировщик напоминаний с учетом временного диапазона
setInterval(async () => {
    if (!bot) return;
    try {
        const res = await pool.query(`
            SELECT s.user_id, s.reminder_interval_hours 
            FROM user_settings s
            WHERE s.reminders_enabled = true 
              AND EXTRACT(HOUR FROM NOW() AT TIMEZONE 'UTC') >= s.reminder_start_hour
              AND EXTRACT(HOUR FROM NOW() AT TIMEZONE 'UTC') < s.reminder_end_hour
              AND (s.last_reminder_sent IS NULL OR s.last_reminder_sent < NOW() - (s.reminder_interval_hours || ' hours')::INTERVAL)
              AND NOT EXISTS (
                  SELECT 1 FROM pushups p 
                  WHERE p.user_id = s.user_id 
                    AND p.created_at >= CURRENT_DATE
              )
        `);

        for (const row of res.rows) {
            bot.sendMessage(row.user_id, '💪 Не забудь выполнить подход сегодня! Трекер ждет новых отжиманий.');
            await pool.query('UPDATE user_settings SET last_reminder_sent = NOW() WHERE user_id = $1', [row.user_id]);
        }
    } catch (e) {
        console.error('Ошибка планировщика:', e);
    }
}, 5 * 60 * 1000);

// --- API ---

// 1. Данные пользователя
app.get('/api/user-data', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        let settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        if (settingsRes.rows.length === 0) {
            await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
            settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        }

        const todayRes = await pool.query(`
            SELECT id, count, created_at 
            FROM pushups 
            WHERE user_id = $1 AND created_at >= CURRENT_DATE 
            ORDER BY created_at DESC
        `, [userId]);

        const totalRes = await pool.query('SELECT SUM(count) as total_count, COUNT(DISTINCT DATE(created_at)) as active_days FROM pushups WHERE user_id = $1', [userId]);

        res.json({
            success: true,
            settings: settingsRes.rows[0],
            todayHistory: todayRes.rows,
            totalCount: parseInt(totalRes.rows[0].total_count) || 0,
            activeDays: parseInt(totalRes.rows[0].active_days) || 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Добавление подхода
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

// 3. Сохранение настроек
app.post('/api/settings', async (req, res) => {
    const { user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour } = req.body;
    try {
        await pool.query(`
            INSERT INTO user_settings (user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_id) DO UPDATE SET
                goal = EXCLUDED.goal,
                reminders_enabled = EXCLUDED.reminders_enabled,
                reminder_interval_hours = EXCLUDED.reminder_interval_hours,
                reminder_start_hour = EXCLUDED.reminder_start_hour,
                reminder_end_hour = EXCLUDED.reminder_end_hour
        `, [user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 4. Календарь за весь год (по дням)
app.get('/api/calendar-year', async (req, res) => {
    const userId = req.query.user_id;
    const year = req.query.year || new Date().getFullYear();

    try {
        const result = await pool.query(`
            SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, SUM(count) as total, COUNT(id) as sets_count
            FROM pushups
            WHERE user_id = $1 AND EXTRACT(YEAR FROM created_at) = $2
            GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
        `, [userId, year]);

        const map = {};
        result.rows.forEach(r => { map[r.date] = { total: parseInt(r.total), sets: parseInt(r.sets_count) }; });
        res.json({ success: true, calendarMap: map });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 5. Данные для аналитики и графиков
app.get('/api/stats-charts', async (req, res) => {
    const userId = req.query.user_id;
    try {
        const weeklyRes = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD.MM') as day_label, SUM(count) as total
            FROM pushups
            WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(created_at), TO_CHAR(created_at, 'DD.MM')
            ORDER BY DATE(created_at) ASC
        `, [userId]);

        const monthlyRes = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD.MM') as day_label, SUM(count) as total
            FROM pushups
            WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at), TO_CHAR(created_at, 'DD.MM')
            ORDER BY DATE(created_at) ASC
        `, [userId]);

        res.json({
            success: true,
            weekly: weeklyRes.rows,
            monthly: monthlyRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// --- ВЕБ-ИНТЕРФЕЙС ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>iOS Fitness Tracker</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --ios-bg: #000000;
            --glass-bg: rgba(255, 255, 255, 0.07);
            --glass-border: rgba(255, 255, 255, 0.12);
            --accent-green: #30d158;
            --accent-blue: #0a84ff;
            --accent-orange: #ff9f0a;
            --text-primary: #ffffff;
            --text-secondary: rgba(255, 255, 255, 0.55);
        }

        * {
            box-sizing: border-box; margin: 0; padding: 0;
            user-select: none; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", Roboto, sans-serif;
        }

        body {
            background-color: var(--ios-bg);
            background-image: 
                radial-gradient(at 0% 0%, rgba(10, 132, 255, 0.18) 0px, transparent 45%),
                radial-gradient(at 100% 0%, rgba(48, 209, 88, 0.15) 0px, transparent 45%);
            background-attachment: fixed;
            color: var(--text-primary);
            min-height: 100vh;
            padding: max(16px, env(safe-area-inset-top)) 16px max(95px, env(safe-area-inset-bottom)) 16px;
            display: flex; flex-direction: column; gap: 14px;
        }

        .glass-card {
            background: var(--glass-bg);
            backdrop-filter: blur(25px) saturate(180%);
            -webkit-backdrop-filter: blur(25px) saturate(180%);
            border: 1px solid var(--glass-border);
            border-radius: 20px; padding: 16px;
        }

        .header { display: flex; justify-content: space-between; align-items: center; }
        .user-profile { display: flex; align-items: center; gap: 12px; }
        .avatar {
            width: 40px; height: 40px; border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 17px;
        }
        .title-sub { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .title-main { font-size: 18px; font-weight: 700; }

        .main-stats { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 8px; }
        .ring-container { position: relative; width: 95px; height: 95px; display: flex; align-items: center; justify-content: center; }
        .ring-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
        .ring-bg { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 9; }
        .ring-progress {
            fill: none; stroke: url(#ringGradient); stroke-width: 9; stroke-linecap: round;
            stroke-dasharray: 283; stroke-dashoffset: 283; transition: stroke-dashoffset 0.8s ease;
        }
        .ring-text { position: absolute; text-align: center; }
        .ring-percent { font-size: 19px; font-weight: 800; }

        .stat-value { font-size: 24px; font-weight: 800; line-height: 1; }
        .stat-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

        .presets-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
        .btn-glass {
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 12px; padding: 12px 0; color: #fff; font-size: 15px; font-weight: 700;
            cursor: pointer; outline: none; transition: all 0.15s;
        }
        .btn-glass:active { transform: scale(0.92); background: rgba(255, 255, 255, 0.2); }

        /* Адаптированная строка ввода собственного значения */
        .custom-input-box {
            display: flex; align-items: center; background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--glass-border); border-radius: 16px; padding: 4px 6px 4px 14px;
            margin-top: 8px; gap: 8px; width: 100%; box-sizing: border-box;
        }
        .input-glass {
            flex: 1; min-width: 0; background: transparent; border: none; color: #fff; font-size: 15px;
            font-weight: 600; outline: none; padding: 10px 0;
        }
        .input-glass::placeholder { color: var(--text-secondary); font-weight: 400; font-size: 14px; }
        .btn-add-action {
            background: linear-gradient(135deg, var(--accent-green), #249d42);
            border: none; border-radius: 12px; padding: 10px 18px; color: #fff;
            font-weight: 700; font-size: 14px; cursor: pointer; flex-shrink: 0;
            transition: transform 0.1s ease;
        }
        .btn-add-action:active { transform: scale(0.94); opacity: 0.9; }

        .compact-history-card { padding: 12px 14px; }
        .history-list { display: flex; flex-direction: column; gap: 6px; max-height: 140px; overflow-y: auto; }
        .history-item-compact {
            display: flex; justify-content: space-between; align-items: center;
            padding: 7px 10px; background: rgba(255, 255, 255, 0.03);
            border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05); font-size: 13px;
        }

        .calendar-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
        .day-name { font-size: 10px; color: var(--text-secondary); font-weight: 600; padding-bottom: 4px; }
        .day-cell {
            aspect-ratio: 1; border-radius: 8px; display: flex; flex-direction: column;
            align-items: center; justify-content: center; font-size: 11px; font-weight: 600;
            background: rgba(255, 255, 255, 0.03); border: 1px solid transparent; cursor: pointer; position: relative;
        }
        .day-cell.empty { background: transparent; cursor: default; }
        .day-cell.has-data { background: rgba(48, 209, 88, 0.15); border-color: rgba(48, 209, 88, 0.4); color: var(--accent-green); }
        .day-cell.completed { background: rgba(48, 209, 88, 0.35); border-color: var(--accent-green); color: #fff; }
        .day-cell.today { border-color: var(--accent-blue); }

        .tab-bar {
            position: fixed; bottom: 0; left: 0; right: 0;
            background: rgba(18, 18, 18, 0.88); backdrop-filter: blur(25px);
            border-top: 1px solid var(--glass-border); display: flex; justify-content: space-around;
            padding-top: 8px; padding-bottom: max(10px, env(safe-area-inset-bottom)); z-index: 1000;
        }
        .tab-btn {
            background: none; border: none; color: var(--text-secondary);
            font-size: 10px; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer;
        }
        .tab-btn.active { color: var(--accent-blue); font-weight: 700; }

        .tab-content { display: none; }
        .tab-content.active { display: flex; flex-direction: column; gap: 14px; }

        .settings-group { display: flex; flex-direction: column; gap: 12px; }
        .setting-card-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 14px 16px; background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--glass-border); border-radius: 14px; gap: 12px;
        }
        .select-glass {
            background: rgba(255, 255, 255, 0.1); border: 1px solid var(--glass-border);
            color: #fff; padding: 6px 10px; border-radius: 8px; outline: none; font-size: 13px;
        }
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

                <div style="flex:1; display:flex; flex-direction:column; gap:8px;">
                    <div>
                        <div class="stat-value" id="todayCount">0 <span style="font-size:13px; color:var(--text-secondary);">/ <span id="goalCount">100</span></span></div>
                        <div class="stat-desc">Отжиманий сегодня</div>
                    </div>
                    <div>
                        <div class="stat-value" id="setsCount" style="color:var(--accent-blue);">0</div>
                        <div class="stat-desc">Выполнено подходов</div>
                    </div>
                </div>
            </div>
        </div>

        <div>
            <div class="title-sub" style="margin-left: 4px; margin-bottom: 6px;">Быстрый ввод</div>
            <div class="presets-grid">
                <button class="btn-glass" onclick="addPushups(15)">+15</button>
                <button class="btn-glass" onclick="addPushups(20)">+20</button>
                <button class="btn-glass" onclick="addPushups(25)">+25</button>
                <button class="btn-glass" onclick="addPushups(30)">+30</button>
                <button class="btn-glass" onclick="addPushups(35)">+35</button>
            </div>

            <div class="custom-input-box">
                <input type="number" id="customInput" class="input-glass" placeholder="Введите своё число..." min="1">
                <button class="btn-add-action" onclick="addCustom()">Записать</button>
            </div>
        </div>

        <div class="glass-card compact-history-card">
            <div class="title-sub" style="margin-bottom: 8px;">Сегодняшние подходы</div>
            <div class="history-list" id="historyList"></div>
        </div>
    </div>

    <!-- Вкладка 2: Календарь на год -->
    <div id="tab-calendar" class="tab-content">
        <div class="glass-card">
            <div class="calendar-header">
                <button class="btn-glass" style="padding:4px 12px; font-size:12px;" onclick="changeMonth(-1)">◀</button>
                <div style="text-align:center;">
                    <div class="title-main" id="calendarMonthYear" style="font-size:16px;">Сентябрь 2026</div>
                </div>
                <button class="btn-glass" style="padding:4px 12px; font-size:12px;" onclick="changeMonth(1)">▶</button>
            </div>

            <div class="calendar-grid">
                <div class="day-name">Пн</div><div class="day-name">Вт</div><div class="day-name">Ср</div>
                <div class="day-name">Чт</div><div class="day-name">Пт</div><div class="day-name">Сб</div><div class="day-name">Вс</div>
            </div>
            <div class="calendar-grid" id="calendarGrid" style="margin-top:4px;"></div>
        </div>

        <div class="glass-card" id="dayDetailCard" style="display:none;">
            <div class="title-sub" id="selectedDateTitle">Информация за день</div>
            <div class="stat-value" id="selectedDateCount" style="color:var(--accent-green); margin-top:4px;">0 отжиманий</div>
            <div class="stat-desc" id="selectedDateSets">Подходов: 0</div>
        </div>
    </div>

    <!-- Вкладка 3: Графики и аналитика -->
    <div id="tab-progress" class="tab-content">
        <div class="glass-card">
            <div class="title-sub">Активность за 7 дней</div>
            <div style="height: 160px; margin-top: 10px;">
                <canvas id="weeklyChart"></canvas>
            </div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Динамика за 30 дней</div>
            <div style="height: 160px; margin-top: 10px;">
                <canvas id="monthlyChart"></canvas>
            </div>
        </div>
    </div>

    <!-- Вкладка 4: Настройки -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div class="title-sub" style="margin-bottom: 14px;">Параметры тренировок</div>
            
            <div class="settings-group">
                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:15px;">Дневная цель</div>
                        <div style="font-size:12px; color:var(--text-secondary);">Количество отжиманий</div>
                    </div>
                    <input type="number" id="settingGoal" class="input-glass" style="width:70px; text-align:center; background:rgba(255,255,255,0.08); border-radius:8px; padding:6px;" value="100">
                </div>

                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:15px;">Напоминания в Telegram</div>
                        <div style="font-size:12px; color:var(--text-secondary);">Пуши от бота при паузе</div>
                    </div>
                    <input type="checkbox" id="settingReminders" checked style="width: 22px; height: 22px; accent-color: var(--accent-green);">
                </div>

                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:15px;">Интервал уведомлений</div>
                        <div style="font-size:12px; color:var(--text-secondary);">Частота отправки</div>
                    </div>
                    <select id="settingInterval" class="select-glass">
                        <option value="1">Каждый 1 час</option>
                        <option value="2">Каждые 2 часа</option>
                        <option value="3" selected>Каждые 3 часа</option>
                        <option value="4">Каждые 4 часа</option>
                        <option value="6">Каждые 6 часов</option>
                    </select>
                </div>

                <!-- Диапазон времени работы пушей -->
                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:15px;">Диапазон времени</div>
                        <div style="font-size:12px; color:var(--text-secondary);">Часы активности бота</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <select id="settingStartHour" class="select-glass"></select>
                        <span style="font-size:12px; color:var(--text-secondary);">—</span>
                        <select id="settingEndHour" class="select-glass"></select>
                    </div>
                </div>

                <button class="btn-add-action" style="width:100%; padding:14px; margin-top:6px;" onclick="saveSettings()">Сохранить настройки</button>
            </div>
        </div>
    </div>

    <!-- Таббар -->
    <div class="tab-bar">
        <button class="tab-btn active" onclick="switchTab('home', this)">
            <span style="font-size:16px;">📊</span>
            <span>Главная</span>
        </button>
        <button class="tab-btn" onclick="switchTab('calendar', this)">
            <span style="font-size:16px;">📅</span>
            <span>Календарь</span>
        </button>
        <button class="tab-btn" onclick="switchTab('progress', this)">
            <span style="font-size:16px;">📈</span>
            <span>Прогресс</span>
        </button>
        <button class="tab-btn" onclick="switchTab('settings', this)">
            <span style="font-size:16px;">⚙️</span>
            <span>Настройки</span>
        </button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand(); tg.ready();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 999999;

        if (user) {
            document.getElementById('userName').innerText = user.first_name || 'Спортсмен';
            document.getElementById('userAvatar').innerText = (user.first_name || 'U')[0].toUpperCase();
        }

        let userGoal = 100;
        let currentDate = new Date();
        let yearDataMap = {};
        let weeklyChartInstance, monthlyChartInstance;

        // Заполнение селектов времени (00:00 - 23:00)
        function initTimeSelects() {
            const startSelect = document.getElementById('settingStartHour');
            const endSelect = document.getElementById('settingEndHour');
            startSelect.innerHTML = '';
            endSelect.innerHTML = '';

            for (let i = 0; i < 24; i++) {
                const hourStr = String(i).padStart(2, '0') + ':00';
                startSelect.innerHTML += \`<option value="\${i}">\${hourStr}</option>\`;
                endSelect.innerHTML += \`<option value="\${i}">\${hourStr}</option>\`;
            }
        }
        initTimeSelects();

        function triggerHaptic() {
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
        }

        function switchTab(tabName, btn) {
            triggerHaptic();
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

            document.getElementById('tab-' + tabName).classList.add('active');
            btn.classList.add('active');

            if (tabName === 'calendar') loadYearCalendar();
            if (tabName === 'progress') loadCharts();
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
                    document.getElementById('settingStartHour').value = data.settings.reminder_start_hour ?? 10;
                    document.getElementById('settingEndHour').value = data.settings.reminder_end_hour ?? 23;

                    let todayTotal = 0;
                    const historyList = document.getElementById('historyList');
                    historyList.innerHTML = '';

                    document.getElementById('setsCount').innerText = data.todayHistory.length;

                    if (data.todayHistory.length === 0) {
                        historyList.innerHTML = '<div style="text-align:center; color:var(--text-secondary); font-size:12px; padding:6px;">Подходов пока нет</div>';
                    } else {
                        data.todayHistory.forEach(row => {
                            todayTotal += row.count;
                            const timeStr = new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            historyList.innerHTML += \`
                                <div class="history-item-compact">
                                    <span style="font-weight:700; color:var(--accent-green);">+\${row.count}</span>
                                    <span style="color:var(--text-secondary); font-size:11px;">\${timeStr}</span>
                                </div>\`;
                        });
                    }

                    document.getElementById('todayCount').innerHTML = \`\${todayTotal} <span style="font-size:13px; color:var(--text-secondary);">/ \${userGoal}</span>\`;
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
            const startHour = parseInt(document.getElementById('settingStartHour').value);
            const endHour = parseInt(document.getElementById('settingEndHour').value);

            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId,
                    goal: goal,
                    reminders_enabled: reminders,
                    reminder_interval_hours: interval,
                    reminder_start_hour: startHour,
                    reminder_end_hour: endHour
                })
            });
            alert('Настройки успешно сохранены!');
            loadUserData();
        }

        // --- Календарь ---
        async function loadYearCalendar() {
            const year = currentDate.getFullYear();
            const res = await fetch(\`/api/calendar-year?user_id=\${userId}&year=\${year}\`);
            const data = await res.json();
            if (data.success) {
                yearDataMap = data.calendarMap;
                renderCalendar();
            }
        }

        function changeMonth(delta) {
            currentDate.setMonth(currentDate.getMonth() + delta);
            renderCalendar();
        }

        function renderCalendar() {
            const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
            const year = currentDate.getFullYear();
            const month = currentDate.getMonth();

            document.getElementById('calendarMonthYear').innerText = \`\${monthNames[month]} \${year}\`;

            const firstDay = new Date(year, month, 1).getDay();
            const startingDay = firstDay === 0 ? 6 : firstDay - 1;
            const totalDays = new Date(year, month + 1, 0).getDate();

            const grid = document.getElementById('calendarGrid');
            grid.innerHTML = '';

            for (let i = 0; i < startingDay; i++) {
                grid.innerHTML += '<div class="day-cell empty"></div>';
            }

            const todayStr = new Date().toISOString().split('T')[0];

            for (let day = 1; day <= totalDays; day++) {
                const dayFormatted = String(day).padStart(2, '0');
                const monthFormatted = String(month + 1).padStart(2, '0');
                const dateKey = \`\${year}-\${monthFormatted}-\${dayFormatted}\`;

                const dayData = yearDataMap[dateKey];
                let classes = 'day-cell';
                if (dateKey === todayStr) classes += ' today';
                if (dayData) {
                    classes += dayData.total >= userGoal ? ' completed' : ' has-data';
                }

                grid.innerHTML += \`
                    <div class="\${classes}" onclick="selectCalendarDay('\${dateKey}', \${dayData ? dayData.total : 0}, \${dayData ? dayData.sets : 0})">
                        <span>\${day}</span>
                    </div>\`;
            }
        }

        function selectCalendarDay(dateStr, total, sets) {
            triggerHaptic();
            const card = document.getElementById('dayDetailCard');
            card.style.display = 'block';
            document.getElementById('selectedDateTitle').innerText = \`Дата: \${dateStr}\`;
            document.getElementById('selectedDateCount').innerText = \`\${total} отжиманий\`;
            document.getElementById('selectedDateSets').innerText = \`Выполнено подходов: \${sets}\`;
        }

        // --- Графики ---
        async function loadCharts() {
            const res = await fetch(\`/api/stats-charts?user_id=\${userId}\`);
            const data = await res.json();

            if (!data.success) return;

            const wLabels = data.weekly.map(i => i.day_label);
            const wTotals = data.weekly.map(i => i.total);

            if (weeklyChartInstance) weeklyChartInstance.destroy();
            weeklyChartInstance = new Chart(document.getElementById('weeklyChart'), {
                type: 'bar',
                data: {
                    labels: wLabels,
                    datasets: [{
                        data: wTotals,
                        backgroundColor: '#30d158',
                        borderRadius: 6
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.5)' } },
                        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.5)' } }
                    }
                }
            });

            const mLabels = data.monthly.map(i => i.day_label);
            const mTotals = data.monthly.map(i => i.total);

            if (monthlyChartInstance) monthlyChartInstance.destroy();
            monthlyChartInstance = new Chart(document.getElementById('monthlyChart'), {
                type: 'line',
                data: {
                    labels: mLabels,
                    datasets: [{
                        data: mTotals,
                        borderColor: '#0a84ff',
                        backgroundColor: 'rgba(10, 132, 255, 0.15)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.5)' } },
                        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.5)' } }
                    }
                }
            });
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
