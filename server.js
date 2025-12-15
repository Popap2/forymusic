const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== ВЛАДЕЛЕЦ / ПРОСТАЯ ЗАЩИТА ======
const OWNER_EMAIL = 'zilajrik7@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password';

// ====== ПОДКЛЮЧЕНИЕ К POSTGRES (SUPABASE) ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

// инициализация схемы
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      url TEXT NOT NULL
    )
  `);
}

initDb().catch((err) => {
  console.error('DB init error:', err);
});

// ====== MIDDLEWARE ======
app.use(express.json());

// папка для загруженных файлов
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.mp3';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_');
    cb(null, Date.now() + '_' + base + ext);
  },
});
const upload = multer({ storage });

// статика
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// ====== ПРОВЕРКА ВЛАДЕЛЬЦА ======
function requireOwner(req, res, next) {
  const adminPassword = req.body.adminPassword || (req.headers['x-admin-password'] || '');
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }
  next();
}

// ====== API АККАУНТЫ (в Postgres) ======
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email и пароль обязательны' });

  try {
    const lowered = email.toLowerCase();
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1,$2) RETURNING id',
      [lowered, password]
    );
    res.json({ id: result.rows[0].id, email: lowered });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }
    console.error('DB error (POST /api/register):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const lowered = email.toLowerCase();
    const result = await pool.query(
      'SELECT id, email FROM users WHERE email = $1 AND password = $2',
      [lowered, password]
    );
    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('DB error (POST /api/login):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// ====== API ТРЕКИ (Postgres) ======

// Получение всех треков
app.get('/api/tracks', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, title, artist, url FROM tracks ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('DB error (GET /api/tracks):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Добавление трека по URL
app.post('/api/tracks', requireOwner, async (req, res) => {
  const { title, artist, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title и url обязательны' });

  try {
    const result = await pool.query(
      'INSERT INTO tracks (title, artist, url) VALUES ($1,$2,$3) RETURNING id',
      [title, artist || null, url]
    );
    res.json({ id: result.rows[0].id, title, artist, url });
  } catch (err) {
    console.error('DB error (POST /api/tracks):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Загрузка файла и сохранение трека
app.post('/api/tracks/upload', upload.single('file'), async (req, res) => {
  const adminPassword = req.body.adminPassword;
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }

  const title = (req.body.title || '').trim();
  const artist = (req.body.artist || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  if (!req.file) return res.status(400).json({ error: 'Нужен audio-файл (поле file)' });

  const relativeUrl = '/uploads/' + req.file.filename;

  try {
    const result = await pool.query(
      'INSERT INTO tracks (title, artist, url) VALUES ($1,$2,$3) RETURNING id',
      [title, artist || null, relativeUrl]
    );
    res.json({ id: result.rows[0].id, title, artist, url: relativeUrl });
  } catch (err) {
    console.error('DB error (POST /api/tracks/upload):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Обновление трека
app.put('/api/tracks/:id', requireOwner, async (req, res) => {
  const trackId = parseInt(req.params.id, 10);
  const { title, artist } = req.body;
  if (!trackId || !title) return res.status(400).json({ error: 'id и title обязательны' });

  try {
    const result = await pool.query(
      'UPDATE tracks SET title = $1, artist = $2 WHERE id = $3',
      [title, artist || null, trackId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Трек не найден' });
    res.json({ id: trackId, title, artist });
  } catch (err) {
    console.error('DB error (PUT /api/tracks/:id):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Удаление трека
app.delete('/api/tracks/:id', requireOwner, async (req, res) => {
  const trackId = parseInt(req.params.id, 10);
  if (!trackId) return res.status(400).json({ error: 'id обязателен' });

  try {
    const sel = await pool.query('SELECT url FROM tracks WHERE id = $1', [trackId]);
    const row = sel.rows[0];
    if (!row) return res.status(404).json({ error: 'Трек не найден' });

    const del = await pool.query('DELETE FROM tracks WHERE id = $1', [trackId]);
    if (del.rowCount === 0) return res.status(404).json({ error: 'Трек не найден' });

    if (row.url && row.url.indexOf('/uploads/') === 0) {
      const filePath = path.join(__dirname, row.url.replace('/uploads/', 'uploads/'));
      fs.unlink(filePath, () => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DB error (DELETE /api/tracks/:id):', err);
    res.status(500).json({ error: 'Ошибка БД при удалении: ' + err.message });
  }
});

// ====== FRONTEND ======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Музыка 3.html'));
});

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
