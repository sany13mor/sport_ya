try { require('dotenv').config(); } catch (e) {}
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

// Раздача статических файлов
['public', 'src', 'views', ''].forEach(folder => {
    app.use(express.static(path.join(__dirname, folder)));
});

// Пул подключения к БД
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Инициализация структуры таблиц БД
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pushups (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                count INT NOT NULL,
                exercise_type VARCHAR(50) DEFAULT 'pushups',
                note TEXT DEFAULT '',
                rpe INT DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS user_settings (
                user_id BIGINT PRIMARY KEY,
                goal INT DEFAULT 100,
                reminders_enabled BOOLEAN DEFAULT true,
                timezone VARCHAR(50) DEFAULT 'UTC'
            );
        `);
        console.log('✅ БД успешно инициализирована');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}
initDB();

// --- API эндпоинты для Telegram Mini App ---

// Добавление нового подхода
app.post('/api/add', async (req, res) => {
    const { user_id, count, exercise_type = 'pushups', note = '', rpe = 0 } = req.body;
    if (!user_id || !count || count <= 0) {
        return res.status(400).json({ error: 'Некорректные данные' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO pushups (user_id, count, exercise_type, note, rpe) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [user_id, count, exercise_type, note, rpe]
        );
        res.json({ success: true, entry: result.rows[0] });
    } catch (err) {
        console.error('Ошибка записи:', err);
        res.status(500).json({ error: 'Ошибка сервера при сохранении' });
    }
});

// Получение истории подходов
app.get('/api/history', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id обязателен' });

    try {
        const result = await pool.query(
            `SELECT id, count, exercise_type, note, rpe, created_at 
             FROM pushups 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 30`,
            [userId]
        );
        res.json({ history: result.rows });
    } catch (err) {
        console.error('Ошибка истории:', err);
        res.status(500).json({ error: 'Ошибка получения истории' });
    }
});

// Получение сводной статистики
app.get('/api/stats', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id обязателен' });

    try {
        const todayRes = await pool.query(
            `SELECT COALESCE(SUM(count), 0) as today_total 
             FROM pushups 
             WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
            [userId]
        );
        
        const totalRes = await pool.query(
            `SELECT COALESCE(SUM(count), 0) as all_total, COUNT(*) as sets_count 
             FROM pushups 
             WHERE user_id = $1`,
            [userId]
        );

        res.json({
            today_total: parseInt(todayRes.rows[0].today_total, 10),
            all_total: parseInt(totalRes.rows[0].all_total, 10),
            sets_count: parseInt(totalRes.rows[0].sets_count, 10),
            daily_goal: 100
        });
    } catch (err) {
        console.error('Ошибка статистики:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Отдача файла Mini App
const serveIndex = (req, res) => {
    const possiblePaths = [
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, 'index.html'),
        path.join(__dirname, 'src', 'index.html')
    ];
    for (const filePath of possiblePaths) {
        if (fs.existsSync(filePath)) return res.sendFile(filePath);
    }
    res.status(404).send('index.html не найден');
};

app.get('/', serveIndex);
app.get('/webapp', serveIndex);
app.get('*', serveIndex);

app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

// Инициализация бота Telegram
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token) {
    const bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, 'Привет! Открывай веб-приложение для удобного учета тренировок и просмотра истории.');
    });
}
