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
        bot.sendMessage(chatId, 'Привет! Нажми кнопку ниже, чтобы открыть трекер подходов:', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📊 Открыть iOS Трекер', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }
                ]]
            }
        });
    });
}

// Подключение к Supabase
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Автоматическое создание таблицы в БД
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pushups (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                count INT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);
        console.log('✅ База данных Supabase готова к работе!');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}
initDB();

app.use(express.json());

// --- API МАРШРУТЫ ДЛЯ РАБОТЫ С БАЗОЙ ДАННЫХ ---

// 1. Получение статистики пользователя за сегодня
app.get('/api/stats', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        const query = `
            SELECT id, count, created_at 
            FROM pushups 
            WHERE user_id = $1 AND created_at >= CURRENT_DATE 
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query, [userId]);
        res.json({ success: true, history: result.rows });
    } catch (err) {
        console.error('Ошибка получения данных из БД:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Сохранение нового подхода в БД
app.post('/api/add', async (req, res) => {
    const { user_id, count } = req.body;
    if (!user_id || !count) return res.status(400).json({ error: 'Invalid data' });

    try {
        await pool.query('INSERT INTO pushups (user_id, count) VALUES ($1, $2)', [user_id, count]);
        res.json({ success: true });
    } catch (err) {
        console.error('Ошибка записи в БД:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- ВЕБ-ИНТЕРФЕЙС WEB APP ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>iOS Fitness Tracker</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --ios-bg: #000000;
            --glass-bg: rgba(255, 255, 255, 0.08);
            --glass-border: rgba(255, 255, 255, 0.18);
            --glass-shine: rgba(255, 255, 255, 0.25);
            --accent-green: #30d158;
            --accent-blue: #0a84ff;
            --accent-orange: #ff9f0a;
            --text-primary: #ffffff;
            --text-secondary: rgba(255, 255, 255, 0.6);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            user-select: none;
            -webkit-user-select: none;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif;
        }

        body {
            background-color: var(--ios-bg);
            background-image: 
                radial-gradient(at 0% 0%, rgba(10, 132, 255, 0.2) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(48, 209, 88, 0.18) 0px, transparent 50%),
                radial-gradient(at 50% 100%, rgba(255, 159, 10, 0.15) 0px, transparent 50%);
            background-attachment: fixed;
            color: var(--text-primary);
            min-height: 100vh;
            padding: 20px 16px 40px 16px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            overflow-x: hidden;
        }

        .glass-card {
            background: var(--glass-bg);
            backdrop-filter: blur(30px) saturate(190%);
            -webkit-backdrop-filter: blur(30px) saturate(190%);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            padding: 20px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37), inset 0 1px 1px 0 var(--glass-shine);
            position: relative;
            overflow: hidden;
        }

        .header { display: flex; justify-content: space-between; align-items: center; }
        .user-profile { display: flex; align-items: center; gap: 12px; }
        .avatar {
            width: 44px; height: 44px; border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 18px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .title-sub { font-size: 13px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .title-main { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }

        .main-stats { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 10px; }
        .ring-container { position: relative; width: 110px; height: 110px; display: flex; align-items: center; justify-content: center; }
        .ring-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
        .ring-bg { fill: none; stroke: rgba(255, 255, 255, 0.1); stroke-width: 10; }
        .ring-progress {
            fill: none; stroke: url(#ringGradient); stroke-width: 10; stroke-linecap: round;
            stroke-dasharray: 283; stroke-dashoffset: 283; transition: stroke-dashoffset 1s cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .ring-text { position: absolute; text-align: center; }
        .ring-percent { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
        .ring-label { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; }

        .stats-details { flex: 1; display: flex; flex-direction: column; gap: 12px; }
        .stat-item { display: flex; flex-direction: column; }
        .stat-value { font-size: 28px; font-weight: 800; letter-spacing: -0.8px; line-height: 1; }
        .stat-value span { font-size: 14px; color: var(--text-secondary); font-weight: 500; }
        .stat-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

        .section-title { font-size: 15px; font-weight: 600; color: var(--text-secondary); margin-left: 4px; margin-bottom: 8px; }
        .presets-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
        .btn-glass {
            background: rgba(255, 255, 255, 0.06);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 16px;
            padding: 14px 0; color: #fff; font-size: 16px; font-weight: 700;
            cursor: pointer; transition: all 0.2s cubic-bezier(0.25, 1, 0.5, 1);
            outline: none; display: flex; align-items: center; justify-content: center;
        }
        .btn-glass:active { transform: scale(0.92); background: rgba(255, 255, 255, 0.18); border-color: rgba(255, 255, 255, 0.3); }

        .custom-input-group { display: flex; gap: 10px; margin-top: 10px; }
        .input-glass {
            flex: 1; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--glass-border);
            border-radius: 16px; padding: 0 16px; color: #fff; font-size: 16px;
            font-weight: 600; outline: none; text-align: center;
        }

        .history-list { display: flex; flex-direction: column; gap: 10px; max-height: 200px; overflow-y: auto; }
        .history-item {
            display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
            background: rgba(255, 255, 255, 0.04); border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .history-count { font-weight: 700; font-size: 16px; color: var(--accent-green); }
        .history-time { font-size: 13px; color: var(--text-secondary); }
    </style>
</head>
<body>

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
                    <div class="ring-label">Цель</div>
                </div>
            </div>

            <div class="stats-details">
                <div class="stat-item">
                    <div class="stat-value" id="todayCount">0 <span>/ <span id="goalCount">100</span></span></div>
                    <div class="stat-desc">Отжиманий сегодня</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="setsCount" style="color: var(--accent-blue);">0</div>
                    <div class="stat-desc">Выполнено подходов</div>
                </div>
            </div>
        </div>
    </div>

    <div>
        <div class="section-title">Быстрый ввод подходов</div>
        <div class="presets-grid">
            <button class="btn-glass" onclick="addPushups(5)">+5</button>
            <button class="btn-glass" onclick="addPushups(10)">+10</button>
            <button class="btn-glass" onclick="addPushups(15)">+15</button>
            <button class="btn-glass" onclick="addPushups(20)">+20</button>
            <button class="btn-glass" onclick="addPushups(25)">+25</button>
        </div>

        <div class="custom-input-group">
            <input type="number" id="customInput" class="input-glass" placeholder="Свой вариант..." min="1">
            <button class="btn-glass" style="padding: 0 20px;" onclick="addCustom()">Записать</button>
        </div>
    </div>

    <div class="glass-card">
        <div class="title-sub" style="margin-bottom: 12px;">Сегодняшние подходы</div>
        <div class="history-list" id="historyList">
            <div style="text-align: center; color: var(--text-secondary); padding: 10px; font-size: 14px;">
                Загрузка данных...
            </div>
        </div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand();
        tg.ready();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 999999; // Фолбэк для тестов вне Telegram

        if (user) {
            document.getElementById('userName').innerText = user.first_name || 'Спортсмен';
            document.getElementById('userAvatar').innerText = (user.first_name || 'U')[0].toUpperCase();
        }

        let todayTotal = 0;
        let goal = 100;
        let sets = 0;

        function triggerHaptic() {
            if (tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred('medium');
            }
        }

        // Загрузка сохраненных подходов из базы Supabase
        async function loadUserData() {
            try {
                const response = await fetch(\`/api/stats?user_id=\${userId}\`);
                const data = await response.json();

                if (data.success) {
                    const historyList = document.getElementById('historyList');
                    historyList.innerHTML = '';

                    todayTotal = 0;
                    sets = data.history.length;

                    if (sets === 0) {
                        historyList.innerHTML = \`<div style="text-align: center; color: var(--text-secondary); padding: 10px; font-size: 14px;">Подходов пока нет</div>\`;
                    } else {
                        data.history.forEach(row => {
                            todayTotal += row.count;
                            const date = new Date(row.created_at);
                            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                            const item = document.createElement('div');
                            item.className = 'history-item';
                            item.innerHTML = \`
                                <span class="history-count">+\${row.count} отжиманий</span>
                                <span class="history-time">\${timeStr}</span>
                            \`;
                            historyList.appendChild(item);
                        });
                    }

                    renderUI();
                }
            } catch (err) {
                console.error('Ошибка загрузки:', err);
            }
        }

        function renderUI() {
            document.getElementById('todayCount').innerHTML = \`\${todayTotal} <span>/ \${goal}</span>\`;
            document.getElementById('setsCount').innerText = sets;

            const percent = Math.min(Math.round((todayTotal / goal) * 100), 100);
            document.getElementById('percentText').innerText = \`\${percent}%\`;
            
            const circle = document.getElementById('progressRing');
            const circumference = 2 * Math.PI * 45;
            const offset = circumference - (percent / 100) * circumference;
            circle.style.strokeDashoffset = offset;
        }

        async function addPushups(count) {
            triggerHaptic();
            
            // Отправляем запись прямо в БД Supabase
            try {
                await fetch('/api/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: userId, count: count })
                });

                // Перезагружаем список, чтобы подтянуть точные данные из БД
                loadUserData();
            } catch (err) {
                console.error('Ошибка сохранения:', err);
            }
        }

        function addCustom() {
            const input = document.getElementById('customInput');
            const val = parseInt(input.value);
            if (val > 0) {
                addPushups(val);
                input.value = '';
            }
        }

        // Автозапуск при открытии WebApp
        loadUserData();
    </script>
</body>
</html>
    `);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
