const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 10000;

// Инициализация Telegram-бота
const token = process.env.BOT_TOKEN;
let bot;
if (token) {
    bot = new TelegramBot(token, { polling: true });

    // 16. Быстрый ввод из чата бота + Inline-клавиатура
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, '💪 Привет! Выберите действие или быстрый подход:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 Открыть WebApp Трекер', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }],
                    [
                        { text: '+15', callback_data: 'quick_add_15' },
                        { text: '+20', callback_data: 'quick_add_20' },
                        { text: '+25', callback_data: 'quick_add_25' },
                        { text: '+30', callback_data: 'quick_add_30' }
                    ]
                ]
            }
        });
    });

    bot.on('callback_query', async (query) => {
        if (query.data && query.data.startsWith('quick_add_')) {
            const count = parseInt(query.data.split('_')[2]);
            const userId = query.from.id;
            try {
                await pool.query(
                    'INSERT INTO exercises (user_id, count, exercise_type) VALUES ($1, $2, $3)',
                    [userId, count, 'pushups']
                );
                bot.answerCallbackQuery(query.id, { text: `✅ Добавлено +${count} отжиманий!` });
                bot.sendMessage(userId, `🚀 Записано +${count} отжиманий из чата!`);
            } catch (err) {
                console.error('Ошибка добавления из чата:', err);
                bot.answerCallbackQuery(query.id, { text: '❌ Ошибка записи' });
            }
        }
    });
}

// Подключение к Supabase (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Автоинициализация и миграция таблиц
async function initDB() {
    try {
        // Миграция старых таблиц и создание новых
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id BIGINT PRIMARY KEY,
                goal INT DEFAULT 100,
                reminders_enabled BOOLEAN DEFAULT true,
                reminder_interval_hours INT DEFAULT 3,
                reminder_start_hour INT DEFAULT 10,
                reminder_end_hour INT DEFAULT 23,
                timezone VARCHAR(50) DEFAULT 'UTC',
                presets JSONB DEFAULT '[15, 20, 25, 30, 35]'::jsonb,
                last_reminder_sent TIMESTAMP WITH TIME ZONE
            );

            CREATE TABLE IF NOT EXISTS exercises (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                exercise_type VARCHAR(50) DEFAULT 'pushups',
                count INT NOT NULL,
                note TEXT DEFAULT '',
                rpe INT DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS user_achievements (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                achievement_key VARCHAR(50) NOT NULL,
                unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(user_id, achievement_key)
            );

            -- Миграция данных из старой таблицы pushups при наличии
            DO $$
            BEGIN
                IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'pushups') THEN
                    INSERT INTO exercises (user_id, count, created_at, exercise_type)
                    SELECT user_id, count, created_at, 'pushups' FROM pushups;
                    ALTER TABLE pushups RENAME TO pushups_old_backup;
                END IF;
            END $$;
        `);
        console.log('✅ База данных Supabase обновлена и готова к работе!');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}
initDB();

app.use(express.json());

// 1. Валидация initData Telegram
function verifyTelegramInitData(initData) {
    if (!token || !initData) return true; // Разрешаем локальное тестирование если токена нет
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

// 4. Rate Limiting Middleware
const rateLimitMap = new Map();
function rateLimiter(req, res, next) {
    const userId = req.body.user_id || req.query.user_id;
    if (!userId) return next();
    const now = Date.now();
    const lastRequest = rateLimitMap.get(userId) || 0;
    if (now - lastRequest < 500) { // Минимум 500мс между запросами
        return res.status(429).json({ error: 'Слишком много запросов. Подождите.' });
    }
    rateLimitMap.set(userId, now);
    next();
}

// 17. Автоматические отчеты и уведомления
setInterval(async () => {
    if (!bot) return;
    try {
        const res = await pool.query(`
            SELECT s.user_id, s.reminder_interval_hours 
            FROM user_settings s
            WHERE s.reminders_enabled = true 
              AND EXTRACT(HOUR FROM NOW() AT TIMEZONE s.timezone) >= s.reminder_start_hour
              AND EXTRACT(HOUR FROM NOW() AT TIMEZONE s.timezone) < s.reminder_end_hour
              AND (s.last_reminder_sent IS NULL OR s.last_reminder_sent < NOW() - (s.reminder_interval_hours || ' hours')::INTERVAL)
              AND NOT EXISTS (
                  SELECT 1 FROM exercises e 
                  WHERE e.user_id = s.user_id 
                    AND e.created_at >= CURRENT_DATE
              )
        `);

        for (const row of res.rows) {
            bot.sendMessage(row.user_id, '💪 Время подходить к цели! Сделайте быстрый подход через кнопки ниже:', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '+15', callback_data: 'quick_add_15' },
                        { text: '+25', callback_data: 'quick_add_25' },
                        { text: '📊 Открыть WebApp', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }
                    ]]
                }
            });
            await pool.query('UPDATE user_settings SET last_reminder_sent = NOW() WHERE user_id = $1', [row.user_id]);
        }
    } catch (e) {
        console.error('Ошибка планировщика:', e);
    }
}, 5 * 60 * 1000);

// --- API ---

// 1 & 6 & 7. Данные пользователя, Серии (Streaks) и Достижения
app.get('/api/user-data', async (req, res) => {
    const userId = req.query.user_id;
    const exerciseType = req.query.exercise_type || 'pushups';
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        let settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        if (settingsRes.rows.length === 0) {
            await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
            settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        }

        const todayRes = await pool.query(`
            SELECT id, count, note, rpe, created_at 
            FROM exercises 
            WHERE user_id = $1 AND exercise_type = $2 AND created_at >= CURRENT_DATE 
            ORDER BY created_at DESC
        `, [userId, exerciseType]);

        const totalRes = await pool.query(`
            SELECT SUM(count) as total_count, COUNT(DISTINCT DATE(created_at)) as active_days 
            FROM exercises WHERE user_id = $1 AND exercise_type = $2
        `, [userId, exerciseType]);

        // Расчет серий (Streak)
        const streakRes = await pool.query(`
            WITH days AS (
                SELECT DISTINCT DATE(created_at) as day
                FROM exercises
                WHERE user_id = $1 AND exercise_type = $2
                ORDER BY day DESC
            )
            SELECT day FROM days;
        `, [userId, exerciseType]);

        let streak = 0;
        let checkDate = new Date();
        const dates = streakRes.rows.map(r => new Date(r.day).toISOString().split('T')[0]);
        
        while (true) {
            const dateStr = checkDate.toISOString().split('T')[0];
            if (dates.includes(dateStr)) {
                streak++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else if (streak === 0) {
                // Пытаемся проверить вчерашний день, если сегодня еще не делал
                checkDate.setDate(checkDate.getDate() - 1);
                const prevStr = checkDate.toISOString().split('T')[0];
                if (dates.includes(prevStr)) {
                    streak++;
                    checkDate.setDate(checkDate.getDate() - 1);
                } else break;
            } else break;
        }

        // Проверка ачивок
        const achievementsRes = await pool.query('SELECT achievement_key FROM user_achievements WHERE user_id = $1', [userId]);

        res.json({
            success: true,
            settings: settingsRes.rows[0],
            todayHistory: todayRes.rows,
            totalCount: parseInt(totalRes.rows[0].total_count) || 0,
            activeDays: parseInt(totalRes.rows[0].active_days) || 0,
            streak: streak,
            achievements: achievementsRes.rows.map(a => a.achievement_key)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2 & 12 & 14 & 15. Добавление подхода с RPE, заметкой и упражнением
app.post('/api/add', rateLimiter, async (req, res) => {
    const { user_id, count, exercise_type, note, rpe, initData } = req.body;
    if (!verifyTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid initData' });
    if (!user_id || !count) return res.status(400).json({ error: 'Invalid data' });

    try {
        await pool.query(
            'INSERT INTO exercises (user_id, count, exercise_type, note, rpe) VALUES ($1, $2, $3, $4, $5)',
            [user_id, count, exercise_type || 'pushups', note || '', rpe || 0]
        );

        // Проверка достижений при добавлении
        const totalRes = await pool.query('SELECT SUM(count) as total FROM exercises WHERE user_id = $1', [user_id]);
        const total = parseInt(totalRes.rows[0].total) || 0;

        if (total >= 1000) {
            await pool.query('INSERT INTO user_achievements (user_id, achievement_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user_id, '1000_rep_club']);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Редактирование и удаление подхода
app.delete('/api/delete-set/:id', async (req, res) => {
    const { user_id } = req.body;
    try {
        await pool.query('DELETE FROM exercises WHERE id = $1 AND user_id = $2', [req.params.id, user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.put('/api/edit-set/:id', async (req, res) => {
    const { user_id, count, note } = req.body;
    try {
        await pool.query('UPDATE exercises SET count = $1, note = $2 WHERE id = $3 AND user_id = $4', [count, note, req.params.id, user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 2 & 13. Сохранение настроек (таймзона, пресеты)
app.post('/api/settings', async (req, res) => {
    const { user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour, timezone, presets } = req.body;
    try {
        await pool.query(`
            INSERT INTO user_settings (user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour, timezone, presets)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (user_id) DO UPDATE SET
                goal = EXCLUDED.goal,
                reminders_enabled = EXCLUDED.reminders_enabled,
                reminder_interval_hours = EXCLUDED.reminder_interval_hours,
                reminder_start_hour = EXCLUDED.reminder_start_hour,
                reminder_end_hour = EXCLUDED.reminder_end_hour,
                timezone = EXCLUDED.timezone,
                presets = EXCLUDED.presets
        `, [user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour, timezone || 'UTC', JSON.stringify(presets || [15, 20, 25, 30, 35])]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 8. Лидерборд
app.get('/api/leaderboard', async (req, res) => {
    const exerciseType = req.query.exercise_type || 'pushups';
    try {
        const result = await pool.query(`
            SELECT user_id, SUM(count) as total
            FROM exercises
            WHERE exercise_type = $1 AND created_at >= CURRENT_DATE
            GROUP BY user_id
            ORDER BY total DESC
            LIMIT 10
        `, [exerciseType]);
        res.json({ success: true, leaders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 18. Экспорт данных в CSV
app.get('/api/export-csv', async (req, res) => {
    const userId = req.query.user_id;
    try {
        const result = await pool.query(
            'SELECT created_at, exercise_type, count, note, rpe FROM exercises WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        let csv = 'Date,Exercise,Count,Note,RPE\n';
        result.rows.forEach(r => {
            csv += `"${r.created_at.toISOString()}","${r.exercise_type}",${r.count},"${r.note || ''}",${r.rpe || 0}\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=fitness_export.csv');
        res.send(csv);
    } catch (err) {
        res.status(500).send('Export error');
    }
});

// Вспомогательные календарь и статистика
app.get('/api/calendar-year', async (req, res) => {
    const userId = req.query.user_id;
    const year = req.query.year || new Date().getFullYear();
    const exerciseType = req.query.exercise_type || 'pushups';

    try {
        const result = await pool.query(`
            SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, SUM(count) as total, COUNT(id) as sets_count
            FROM exercises
            WHERE user_id = $1 AND exercise_type = $3 AND EXTRACT(YEAR FROM created_at) = $2
            GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
        `, [userId, year, exerciseType]);

        const map = {};
        result.rows.forEach(r => { map[r.date] = { total: parseInt(r.total), sets: parseInt(r.sets_count) }; });
        res.json({ success: true, calendarMap: map });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/stats-charts', async (req, res) => {
    const userId = req.query.user_id;
    const exerciseType = req.query.exercise_type || 'pushups';
    try {
        const weeklyRes = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD.MM') as day_label, SUM(count) as total
            FROM exercises
            WHERE user_id = $1 AND exercise_type = $2 AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(created_at), TO_CHAR(created_at, 'DD.MM')
            ORDER BY DATE(created_at) ASC
        `, [userId, exerciseType]);

        const monthlyRes = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD.MM') as day_label, SUM(count) as total
            FROM exercises
            WHERE user_id = $1 AND exercise_type = $2 AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at), TO_CHAR(created_at, 'DD.MM')
            ORDER BY DATE(created_at) ASC
        `, [userId, exerciseType]);

        res.json({ success: true, weekly: weeklyRes.rows, monthly: monthlyRes.rows });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// --- ВЕБ-ИНТЕРФЕЙС (19. Поддержка системных тем Telegram) ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>iOS Fitness Tracker Pro</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --ios-bg: var(--tg-theme-bg-color, #000000);
            --glass-bg: rgba(255, 255, 255, 0.08);
            --glass-border: rgba(255, 255, 255, 0.12);
            --accent-green: #30d158;
            --accent-blue: #0a84ff;
            --accent-orange: #ff9f0a;
            --accent-red: #ff453a;
            --text-primary: var(--tg-theme-text-color, #ffffff);
            --text-secondary: rgba(255, 255, 255, 0.55);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif; }

        body {
            background-color: var(--ios-bg);
            background-image: radial-gradient(at 0% 0%, rgba(10, 132, 255, 0.15) 0px, transparent 45%),
                              radial-gradient(at 100% 0%, rgba(48, 209, 88, 0.12) 0px, transparent 45%);
            background-attachment: fixed;
            color: var(--text-primary); min-height: 100vh;
            padding: max(16px, env(safe-area-inset-top)) 16px max(95px, env(safe-area-inset-bottom)) 16px;
            display: flex; flex-direction: column; gap: 14px;
        }

        .glass-card {
            background: var(--glass-bg); backdrop-filter: blur(25px) saturate(180%);
            -webkit-backdrop-filter: blur(25px) saturate(180%);
            border: 1px solid var(--glass-border); border-radius: 20px; padding: 16px;
        }

        .header { display: flex; justify-content: space-between; align-items: center; }
        .user-profile { display: flex; align-items: center; gap: 12px; }
        .avatar {
            width: 42px; height: 42px; border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
            display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px;
        }
        .title-sub { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .title-main { font-size: 18px; font-weight: 700; }

        .exercise-selector {
            display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-top: 6px;
        }
        .exercise-chip {
            background: rgba(255,255,255,0.06); border: 1px solid var(--glass-border);
            padding: 8px 14px; border-radius: 20px; font-size: 13px; font-weight: 600;
            white-space: nowrap; cursor: pointer; color: var(--text-secondary);
        }
        .exercise-chip.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }

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

        .presets-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 6px; }
        .btn-glass {
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 12px; padding: 12px 0; color: #fff; font-size: 15px; font-weight: 700;
            cursor: pointer; outline: none; transition: all 0.15s;
        }
        .btn-glass:active { transform: scale(0.92); background: rgba(255, 255, 255, 0.2); }

        .custom-input-box {
            display: flex; flex-direction: column; gap: 8px; margin-top: 8px;
        }
        .input-row { display: flex; gap: 8px; align-items: center; }
        .input-glass {
            flex: 1; background: rgba(255, 255, 255, 0.06); border: 1px solid var(--glass-border);
            border-radius: 12px; color: #fff; font-size: 14px; padding: 10px 12px; outline: none;
        }
        .btn-add-action {
            background: linear-gradient(135deg, var(--accent-green), #249d42);
            border: none; border-radius: 12px; padding: 12px 20px; color: #fff;
            font-weight: 700; font-size: 14px; cursor: pointer; flex-shrink: 0;
        }

        /* 11. Таймер отдыха */
        .rest-timer-bar {
            display: none; background: rgba(10, 132, 255, 0.2); border: 1px solid var(--accent-blue);
            border-radius: 12px; padding: 10px; text-align: center; font-weight: 700; font-size: 14px;
        }

        .history-list { display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow-y: auto; margin-top: 6px; }
        .history-item-compact {
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px 10px; background: rgba(255, 255, 255, 0.03);
            border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.05); font-size: 13px;
        }

        /* 7. Награды */
        .achievements-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
        .badge { background: rgba(255,255,255,0.04); border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px; text-align: center; opacity: 0.4; }
        .badge.unlocked { opacity: 1; border-color: var(--accent-orange); background: rgba(255, 159, 10, 0.1); }

        .tab-bar {
            position: fixed; bottom: 0; left: 0; right: 0;
            background: rgba(18, 18, 18, 0.9); backdrop-filter: blur(25px);
            border-top: 1px solid var(--glass-border); display: flex; justify-content: space-around;
            padding-top: 8px; padding-bottom: max(10px, env(safe-area-inset-bottom)); z-index: 1000;
        }
        .tab-btn { background: none; border: none; color: var(--text-secondary); font-size: 10px; display: flex; flex-direction: column; align-items: center; gap: 3px; }
        .tab-btn.active { color: var(--accent-blue); font-weight: 700; }
        .tab-content { display: none; }
        .tab-content.active { display: flex; flex-direction: column; gap: 14px; }
    </style>
</head>
<body>

    <!-- Вкладка 1: Главная -->
    <div id="tab-home" class="tab-content active">
        <div class="glass-card header">
            <div class="user-profile">
                <div class="avatar" id="userAvatar">U</div>
                <div>
                    <div class="title-sub" id="streakBadge">🔥 0 дней подряд</div>
                    <div class="title-main" id="userName">Спортсмен</div>
                </div>
            </div>
            <button class="btn-glass" style="padding:6px 12px; font-size:12px;" onclick="exportCSV()">📥 CSV</button>
        </div>

        <!-- 12. Мульти-упражнения -->
        <div class="exercise-selector">
            <div class="exercise-chip active" onclick="setExercise('pushups', this)">💪 Отжимания</div>
            <div class="exercise-chip" onclick="setExercise('squats', this)">🦵 Приседания</div>
            <div class="exercise-chip" onclick="setExercise('pullups', this)">🏋️ Подтягивания</div>
            <div class="exercise-chip" onclick="setExercise('plank', this)">⏱️ Планка (сек)</div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Прогресс дня</div>
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
                        <div class="stat-desc">Выполнено сегодня</div>
                    </div>
                    <div>
                        <div class="stat-value" id="setsCount" style="color:var(--accent-blue);">0</div>
                        <div class="stat-desc">Всего подходов</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 11. Таймер отдыха -->
        <div id="restTimer" class="rest-timer-bar">
            ⏱ Отдых: <span id="timerSeconds">60</span> сек
        </div>

        <!-- Быстрый ввод -->
        <div>
            <div class="title-sub">Быстрый набор</div>
            <div class="presets-grid" id="presetsGrid"></div>

            <div class="custom-input-box">
                <div class="input-row">
                    <input type="number" id="customInput" class="input-glass" placeholder="Количество..." min="1">
                    <!-- 15. RPE Оценка сложности -->
                    <select id="rpeInput" class="input-glass" style="max-width:110px;">
                        <option value="0">RPE (1-10)</option>
                        <option value="6">6 - Легко</option>
                        <option value="8">8 - Норм</option>
                        <option value="10">10 - Макс</option>
                    </select>
                </div>
                <!-- 14. Заметка к подходу -->
                <div class="input-row">
                    <input type="text" id="noteInput" class="input-glass" placeholder="Заметка (напр. узкий хват)...">
                    <button class="btn-add-action" onclick="addCustom()">Записать</button>
                </div>
            </div>
        </div>

        <!-- Сегодняшняя история с поддержкой удаления (3) -->
        <div class="glass-card">
            <div class="title-sub">Сегодняшние подходы</div>
            <div class="history-list" id="historyList"></div>
        </div>

        <!-- 20. Генератор карточки результатов -->
        <button class="btn-glass" style="width:100%; border-color:var(--accent-blue);" onclick="shareResultCard()">📸 Поделиться результатом в Story</button>
    </div>

    <!-- Вкладка 2: Прогресс и Лидерборд -->
    <div id="tab-progress" class="tab-content">
        <!-- 8. Лидерборд -->
        <div class="glass-card">
            <div class="title-sub">🏆 Лидеры дня</div>
            <div id="leaderboardList" style="display:flex; flex-direction:column; gap:6px; margin-top:8px;"></div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Активность за 7 дней</div>
            <div style="height: 150px; margin-top: 10px;"><canvas id="weeklyChart"></canvas></div>
        </div>

        <!-- 7. Достижения -->
        <div class="glass-card">
            <div class="title-sub">Награды</div>
            <div class="achievements-grid">
                <div class="badge" id="badge_1000_rep_club">🏆<br><span style="font-size:10px;">1,000 Повторов</span></div>
                <div class="badge" id="badge_7_streak">🔥<br><span style="font-size:10px;">7 дней подряд</span></div>
                <div class="badge" id="badge_first_step">⭐<br><span style="font-size:10px;">Первый шаг</span></div>
            </div>
        </div>
    </div>

    <!-- Вкладка 3: Настройки -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div class="title-sub" style="margin-bottom: 12px;">Параметры</div>
            <div style="display:flex; flex-direction:column; gap:10px;">
                <div>
                    <label class="title-sub">Дневная цель</label>
                    <input type="number" id="settingGoal" class="input-glass" style="width:100%; margin-top:4px;" value="100">
                </div>
                <div>
                    <label class="title-sub">Часовой пояс (Timezone)</label>
                    <input type="text" id="settingTimezone" class="input-glass" style="width:100%; margin-top:4px;" value="UTC">
                </div>
                <div>
                    <label class="title-sub">Пресеты (через запятую)</label>
                    <input type="text" id="settingPresets" class="input-glass" style="width:100%; margin-top:4px;" value="15,20,25,30,35">
                </div>
                <button class="btn-add-action" style="margin-top:8px;" onclick="saveSettings()">Сохранить настройки</button>
            </div>
        </div>
    </div>

    <!-- Таббар -->
    <div class="tab-bar">
        <button class="tab-btn active" onclick="switchTab('home', this)">📊<span>Трекер</span></button>
        <button class="tab-btn" onclick="switchTab('progress', this)">📈<span>Прогресс</span></button>
        <button class="tab-btn" onclick="switchTab('settings', this)">⚙️<span>Настройки</span></button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand(); tg.ready();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 999999;
        let currentExercise = 'pushups';
        let userGoal = 100;
        let restTimerInterval;

        if (user) {
            document.getElementById('userName').innerText = user.first_name || 'Спортсмен';
            document.getElementById('userAvatar').innerText = (user.first_name || 'U')[0].toUpperCase();
        }

        // 10. Тактильный отклик (Haptics)
        function triggerHaptic(style = 'medium') {
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred(style);
        }

        function switchTab(tabName, btn) {
            triggerHaptic('light');
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
            document.getElementById('tab-' + tabName).classList.add('active');
            btn.classList.add('active');
            if (tabName === 'progress') { loadCharts(); loadLeaderboard(); }
        }

        function setExercise(type, el) {
            triggerHaptic('light');
            currentExercise = type;
            document.querySelectorAll('.exercise-chip').forEach(c => c.classList.remove('active'));
            el.classList.add('active');
            loadUserData();
        }

        // 5. Офлайн режим (LocalStorage fallback)
        async function apiFetch(url, options = {}) {
            try {
                const res = await fetch(url, options);
                return await res.json();
            } catch (e) {
                if (options.method === 'POST' && url.includes('/api/add')) {
                    const queue = JSON.parse(localStorage.getItem('offline_add_queue') || '[]');
                    queue.push(JSON.parse(options.body));
                    localStorage.setItem('offline_add_queue', JSON.stringify(queue));
                    alert('Сеть недоступна. Подход сохранен локально и будет отправлен позже!');
                }
                return { success: false, offline: true };
            }
        }

        // Синхронизация офлайн подходов при появлении сети
        window.addEventListener('online', async () => {
            const queue = JSON.parse(localStorage.getItem('offline_add_queue') || '[]');
            if (queue.length > 0) {
                for (const item of queue) {
                    await fetch('/api/add', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(item)
                    });
                }
                localStorage.removeItem('offline_add_queue');
                loadUserData();
            }
        });

        async function loadUserData() {
            const data = await apiFetch(\`/api/user-data?user_id=\${userId}&exercise_type=\${currentExercise}\`);
            if (data.success) {
                userGoal = data.settings.goal || 100;
                document.getElementById('goalCount').innerText = userGoal;
                document.getElementById('settingGoal').value = userGoal;
                document.getElementById('settingTimezone').value = data.settings.timezone || 'UTC';
                document.getElementById('streakBadge').innerText = \`🔥 \${data.streak} дней подряд\`;

                // Пресеты (13)
                const presets = data.settings.presets || [15, 20, 25, 30, 35];
                document.getElementById('settingPresets').value = presets.join(',');
                const presetsGrid = document.getElementById('presetsGrid');
                presetsGrid.innerHTML = '';
                presets.forEach(val => {
                    presetsGrid.innerHTML += \`<button class="btn-glass" onclick="addExercise(\${val})">+\${val}</button>\`;
                });

                let todayTotal = 0;
                const historyList = document.getElementById('historyList');
                historyList.innerHTML = '';
                document.getElementById('setsCount').innerText = data.todayHistory.length;

                data.todayHistory.forEach(row => {
                    todayTotal += row.count;
                    const timeStr = new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    historyList.innerHTML += \`
                        <div class="history-item-compact">
                            <div>
                                <span style="font-weight:700; color:var(--accent-green);">+\${row.count}</span>
                                \${row.note ? \`<span style="color:var(--text-secondary); font-size:11px;"> (\${row.note})</span>\` : ''}
                            </div>
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span style="color:var(--text-secondary); font-size:11px;">\${timeStr}</span>
                                <span style="color:var(--accent-red); cursor:pointer;" onclick="deleteSet(\${row.id})">🗑</span>
                            </div>
                        </div>\`;
                });

                document.getElementById('todayCount').innerHTML = \`\${todayTotal} <span style="font-size:13px; color:var(--text-secondary);">/ \${userGoal}</span>\`;
                const percent = Math.min(Math.round((todayTotal / userGoal) * 100), 100);
                document.getElementById('percentText').innerText = \`\${percent}%\`;
                document.getElementById('progressRing').style.strokeDashoffset = 283 - (percent / 100) * 283;

                // Отображение ачивок
                (data.achievements || []).forEach(key => {
                    const el = document.getElementById('badge_' + key);
                    if (el) el.classList.add('unlocked');
                });
            }
        }

        async function addExercise(count) {
            triggerHaptic('medium');
            const note = document.getElementById('noteInput').value;
            const rpe = parseInt(document.getElementById('rpeInput').value) || 0;

            await apiFetch('/api/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId, count: count, exercise_type: currentExercise,
                    note: note, rpe: rpe, initData: tg.initData
                })
            });

            document.getElementById('customInput').value = '';
            document.getElementById('noteInput').value = '';
            startRestTimer(60); // 11. Запуск таймера отдыха на 60 сек
            loadUserData();
        }

        function addCustom() {
            const val = parseInt(document.getElementById('customInput').value);
            if (val > 0) addExercise(val);
        }

        // 3. Удаление подхода
        async function deleteSet(id) {
            triggerHaptic('heavy');
            await apiFetch('/api/delete-set/' + id, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId })
            });
            loadUserData();
        }

        // 11. Логика таймера отдыха
        function startRestTimer(seconds) {
            clearInterval(restTimerInterval);
            const timerEl = document.getElementById('restTimer');
            const secEl = document.getElementById('timerSeconds');
            timerEl.style.display = 'block';
            let left = seconds;
            secEl.innerText = left;

            restTimerInterval = setInterval(() => {
                left--;
                secEl.innerText = left;
                if (left <= 0) {
                    clearInterval(restTimerInterval);
                    timerEl.style.display = 'none';
                    triggerHaptic('heavy');
                }
            }, 1000);
        }

        // 8. Загрузка Лидерборда
        async function loadLeaderboard() {
            const data = await apiFetch(\`/api/leaderboard?exercise_type=\${currentExercise}\`);
            const list = document.getElementById('leaderboardList');
            list.innerHTML = '';
            if (data.success) {
                data.leaders.forEach((item, index) => {
                    list.innerHTML += \`
                        <div class="history-item-compact">
                            <span>#\${index + 1} Атлет ID: \${item.user_id}</span>
                            <span style="font-weight:700; color:var(--accent-blue);">\${item.total}</span>
                        </div>\`;
                });
            }
        }

        async function saveSettings() {
            triggerHaptic('medium');
            const goal = parseInt(document.getElementById('settingGoal').value);
            const tz = document.getElementById('settingTimezone').value;
            const presets = document.getElementById('settingPresets').value.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));

            await apiFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId, goal: goal, timezone: tz, presets: presets })
            });
            alert('Настройки сохранены!');
            loadUserData();
        }

        // 18. Экспорт CSV
        function exportCSV() {
            window.location.href = \`/api/export-csv?user_id=\${userId}\`;
        }

        // 20. Генерация карточки результатов для отправки в Telegram
        function shareResultCard() {
            const text = encodeURIComponent(\`💪 Мой результат сегодня: \${document.getElementById('todayCount').innerText} в трекере!\`);
            tg.openTelegramLink(\`https://t.me/share/url?url=\${process.env.WEBAPP_URL || 'https://sport-ya.onrender.com'}&text=\${text}\`);
        }

        async function loadCharts() {
            const data = await apiFetch(\`/api/stats-charts?user_id=\${userId}&exercise_type=\${currentExercise}\`);
            if (!data.success) return;

            new Chart(document.getElementById('weeklyChart'), {
                type: 'bar',
                data: {
                    labels: data.weekly.map(i => i.day_label),
                    datasets: [{ data: data.weekly.map(i => i.total), backgroundColor: '#30d158', borderRadius: 6 }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
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
