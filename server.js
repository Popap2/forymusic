const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== КОНФИГ ВЛАДЕЛЬЦА / ЛЁГКАЯ ЗАЩИТА ======
// Email владельца, которому разрешено управлять треками
const OWNER_EMAIL = 'zilajrik7@gmail.com';
// Простой admin-пароль. На Render.com нужно задать переменную окружения ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password';

// чтобы читать JSON из fetch
app.use(express.json());

// Папка для загруженных аудио-файлов
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Настройка Multer для загрузки файлов
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

// раздаём статику и загруженные треки
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// ====== БД SQLite ======
const db = new sqlite3.Database(path.join(__dirname, 'music.db'));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT,
      url TEXT NOT NULL
    )
  `);

  // Мягкая миграция: добавляем столбец owner_email, если его ещё нет
  db.all(`PRAGMA table_info(tracks)`, (err, rows) => {
    if (err) {
      console.error('PRAGMA table_info(tracks) error:', err);
      return;
    }
    const hasOwnerEmail = rows && rows.some((c) => c.name === 'owner_email');
    if (!hasOwnerEmail) {
      db.run(`ALTER TABLE tracks ADD COLUMN owner_email TEXT`, (alterErr) => {
        if (alterErr) {
          console.error('ALTER TABLE tracks ADD COLUMN owner_email error:', alterErr);
        } else {
          console.log('Column owner_email added to tracks table');
        }
      });
    }
  });
});

// ====== ВСПОМОГАТЕЛЬНАЯ ПРОВЕРКА ВЛАДЕЛЬЦА ======
function requireOwner(req, res, next) {
  const adminPassword = req.body.adminPassword || (req.headers['x-admin-password'] || '');
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }
  next();
}

// ====== API АККАУНТЫ (БАЗОВО, МОЖНО ИСПОЛЬЗОВАТЬ ДЛЯ БУДУЩЕГО) ======
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email и пароль обязательны' });

  db.run(
    'INSERT INTO users (email, password) VALUES (?,?)',
    [email.toLowerCase(), password],
    function (err) {
      if (err) {
        if (err.code === 'SQLITE_CONSTRAINT') {
          return res.status(409).json({ error: 'Пользователь уже существует' });
        }
        return res.status(500).json({ error: 'Ошибка БД' });
      }
      res.json({ id: this.lastID, email });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(
    'SELECT id, email FROM users WHERE email = ? AND password = ?',
    [email.toLowerCase(), password],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Ошибка БД' });
      if (!row) return res.status(401).json({ error: 'Неверный email или пароль' });
      res.json(row); // {id, email}
    }
  );
});

// ====== API ТРЕКИ (с сохранением в БД) ======

// Получение всех треков из БД
app.get('/api/tracks', (req, res) => {
  db.all('SELECT id, title, artist, url FROM tracks ORDER BY id DESC', (err, rows) => {
    if (err) {
      console.error('DB error (GET /api/tracks):', err);
      return res.status(500).json({ error: 'Ошибка БД: ' + err.message });
    }
    res.json(rows);
  });
});

// Добавление трека по готовому URL (например, внешний ресурс) — только владелец
app.post('/api/tracks', requireOwner, (req, res) => {
  const { title, artist, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title и url обязательны' });

  db.run(
    'INSERT INTO tracks (owner_email, title, artist, url) VALUES (?,?,?,?)',
    [OWNER_EMAIL, title, artist || null, url],
    function (err) {
      if (err) {
        console.error('DB error (POST /api/tracks):', err);
        return res.status(500).json({ error: 'Ошибка БД: ' + err.message });
      }
      res.json({ id: this.lastID, title, artist, url });
    }
  );
});

// Загрузка файла трека и сохранение в БД — только владелец
app.post('/api/tracks/upload', upload.single('file'), (req, res) => {
  const adminPassword = req.body.adminPassword;
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    // если файл уже был сохранён, удалим его при ошибке прав
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }

  const title = (req.body.title || '').trim();
  const artist = (req.body.artist || '').trim();

  if (!title) {
    return res.status(400).json({ error: 'title обязателен' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Нужен audio-файл (поле file)' });
  }

  const relativeUrl = '/uploads/' + req.file.filename;

  db.run(
    'INSERT INTO tracks (owner_email, title, artist, url) VALUES (?,?,?,?)',
    [OWNER_EMAIL, title, artist || null, relativeUrl],
    function (err) {
      if (err) {
        console.error('DB error (POST /api/tracks/upload):', err);
        return res.status(500).json({ error: 'Ошибка БД: ' + err.message });
      }
      res.json({ id: this.lastID, title, artist, url: relativeUrl });
    }
  );
});

// Обновление метаданных трека — только владелец
app.put('/api/tracks/:id', requireOwner, (req, res) => {
  const trackId = parseInt(req.params.id, 10);
  const { title, artist } = req.body;

  if (!trackId || !title) {
    return res.status(400).json({ error: 'id и title обязательны' });
  }

  db.run(
    'UPDATE tracks SET title = ?, artist = ? WHERE id = ?',
    [title, artist || null, trackId],
    function (err) {
      if (err) {
        console.error('DB error (PUT /api/tracks/:id):', err);
        return res.status(500).json({ error: 'Ошибка БД: ' + err.message });
      }
      if (this.changes === 0) return res.status(404).json({ error: 'Трек не найден' });
      res.json({ id: trackId, title, artist });
    }
  );
});

// Удаление трека — только владелец
app.delete('/api/tracks/:id', requireOwner, (req, res) => {
  const trackId = parseInt(req.params.id, 10);
  if (!trackId) return res.status(400).json({ error: 'id обязателен' });

  // сначала получаем трек, чтобы при необходимости удалить файл
  db.get('SELECT url FROM tracks WHERE id = ?', [trackId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Ошибка БД' });
    if (!row) return res.status(404).json({ error: 'Трек не найден' });

    db.run('DELETE FROM tracks WHERE id = ?', [trackId], function (err2) {
      if (err2) {
        console.error('DB error (DELETE /api/tracks/:id):', err2);
        return res.status(500).json({ error: 'Ошибка БД при удалении: ' + err2.message });
      }

      // если трек указывал на локальный файл, попробуем удалить его
      if (row.url && row.url.indexOf('/uploads/') === 0) {
        const filePath = path.join(__dirname, row.url.replace('/uploads/', 'uploads/'));
        fs.unlink(filePath, () => {});
      }

      res.json({ success: true });
    });
  });
});

// главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Музыка 3.html'));
});

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});