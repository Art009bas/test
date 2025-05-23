require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 5000;

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Проверка подключения к БД
pool.query('SELECT NOW()', (err) => {
  if (err) console.error('Ошибка подключения к БД:', err);
  else console.log('Успешное подключение к БД');
});

// API маршруты

// Получить текущую планёрку
app.get('/api/meetings/current', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM meetings 
       WHERE completed = FALSE 
       ORDER BY created_at DESC 
       LIMIT 1`
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Текущая планёрка не найдена' });
    }
    
    const meeting = rows[0];
    const tasks = await pool.query(
      'SELECT * FROM tasks WHERE meeting_id = $1 ORDER BY created_at DESC',
      [meeting.id]
    );
    
    meeting.tasks = tasks.rows;
    res.json(meeting);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать новую планёрку
app.post('/api/meetings', async (req, res) => {
  const { title } = req.body;
  const now = new Date();
  const dateString = now.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  try {
    const { rows } = await pool.query(
      `INSERT INTO meetings (title, date, date_string) 
       VALUES ($1, $2, $3) 
       RETURNING *`,
      [title || `Планёрка от ${dateString}`, now, dateString]
    );
    
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить планёрку
app.put('/api/meetings/:id', async (req, res) => {
  const { id } = req.params;
  const { title, notes } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE meetings 
       SET title = $1, notes = $2 
       WHERE id = $3 
       RETURNING *`,
      [title, notes, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Планёрка не найдена' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Завершить планёрку
app.put('/api/meetings/:id/complete', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `UPDATE meetings 
       SET completed = TRUE 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Планёрка не найдена' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить список завершенных планёрок
app.get('/api/meetings/history', async (req, res) => {
  const { search, sort } = req.query;

  try {
    let query = `
      SELECT m.*, 
      (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) as task_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id AND t.completed = TRUE) as completed_count
      FROM meetings m
      WHERE m.completed = TRUE
    `;

    const params = [];
    
    if (search) {
      query += ` AND (
        m.title ILIKE $${params.length + 1} OR
        m.notes ILIKE $${params.length + 1} OR
        EXISTS (
          SELECT 1 FROM tasks t 
          WHERE t.meeting_id = m.id AND 
          (t.text ILIKE $${params.length + 1} OR t.responsible ILIKE $${params.length + 1})
        )
      )`;
      params.push(`%${search}%`);
    }

    // Сортировка
    if (sort === 'completion') {
      query += ` ORDER BY completed_count::float / NULLIF(task_count, 0) DESC`;
    } else if (sort === 'tasks') {
      query += ` ORDER BY task_count DESC`;
    } else {
      query += ` ORDER BY m.date DESC`;
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить детали планёрки
app.get('/api/meetings/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const meeting = await pool.query(
      'SELECT * FROM meetings WHERE id = $1',
      [id]
    );
    
    if (meeting.rows.length === 0) {
      return res.status(404).json({ error: 'Планёрка не найдена' });
    }
    
    const tasks = await pool.query(
      'SELECT * FROM tasks WHERE meeting_id = $1 ORDER BY created_at DESC',
      [id]
    );
    
    const result = meeting.rows[0];
    result.tasks = tasks.rows;
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить задачу
app.post('/api/meetings/:id/tasks', async (req, res) => {
  const { id } = req.params;
  const { text, responsible, deadline, priority } = req.body;

  try {
    // Проверяем существование планёрки
    const meeting = await pool.query(
      'SELECT id FROM meetings WHERE id = $1',
      [id]
    );
    
    if (meeting.rows.length === 0) {
      return res.status(404).json({ error: 'Планёрка не найдена' });
    }
    
    // Добавляем ответственного в историю, если указан
    if (responsible) {
      await pool.query(
        'INSERT INTO responsible (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [responsible]
      );
    }
    
    // Добавляем задачу
    const { rows } = await pool.query(
      `INSERT INTO tasks 
       (meeting_id, text, responsible, deadline, priority) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [id, text, responsible, deadline, priority]
    );
    
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить задачу
app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { text, completed, responsible, deadline, priority } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE tasks 
       SET text = $1, completed = $2, responsible = $3, deadline = $4, priority = $5 
       WHERE id = $6 
       RETURNING *`,
      [text, completed, responsible, deadline, priority, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить задачу
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM tasks WHERE id = $1',
      [id]
    );
    
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }
    
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить список ответственных
app.get('/api/responsible', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT name FROM responsible ORDER BY name'
    );
    
    res.json(rows.map(r => r.name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить статистику
app.get('/api/stats', async (req, res) => {
  try {
    // Общая статистика
    const meetingsCount = await pool.query(
      'SELECT COUNT(*) FROM meetings WHERE completed = TRUE'
    );
    
    const tasksStats = await pool.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN completed = TRUE THEN 1 ELSE 0 END) as completed
       FROM tasks`
    );
    
    // Статистика по последним планёркам
    const recentMeetings = await pool.query(
      `SELECT m.id, m.title, 
       COUNT(t.id) as task_count,
       SUM(CASE WHEN t.completed = TRUE THEN 1 ELSE 0 END) as completed_count
       FROM meetings m
       LEFT JOIN tasks t ON m.id = t.meeting_id
       WHERE m.completed = TRUE
       GROUP BY m.id
       ORDER BY m.date DESC
       LIMIT 5`
    );
    
    // Статистика по незавершенным задачам
    const unfinishedTasks = await pool.query(
      `SELECT COUNT(*) FROM tasks WHERE completed = FALSE`
    );
    
    res.json({
      totalMeetings: parseInt(meetingsCount.rows[0].count),
      totalTasks: parseInt(tasksStats.rows[0].total),
      completedTasks: parseInt(tasksStats.rows[0].completed),
      unfinishedTasks: parseInt(unfinishedTasks.rows[0].count),
      recentMeetings: recentMeetings.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить незавершенные задачи
app.get('/api/tasks/unfinished', async (req, res) => {
  const { sort } = req.query;

  try {
    let query = `
      SELECT t.*, m.title as meeting_title, m.date as meeting_date
      FROM tasks t
      JOIN meetings m ON t.meeting_id = m.id
      WHERE t.completed = FALSE
    `;

    // Сортировка
    if (sort === 'priority') {
      query += ` ORDER BY t.priority DESC NULLS LAST, t.created_at DESC`;
    } else if (sort === 'deadline') {
      query += ` ORDER BY t.deadline ASC NULLS LAST, t.created_at DESC`;
    } else {
      query += ` ORDER BY m.date DESC, t.created_at DESC`;
    }

    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Запуск сервера
app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});
