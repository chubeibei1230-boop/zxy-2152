const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, password, role = 'booker', name, phone } = req.body;

    if (!username || !password || !name) {
      return res.status(400).json({ error: '用户名、密码和姓名不能为空' });
    }

    if (!['admin', 'booker', 'attendant'].includes(role)) {
      return res.status(400).json({ error: '无效的角色' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6位' });
    }

    const db = await getDb();
    const existing = await db.get('SELECT id FROM users WHERE username = ?', username);
    if (existing) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.run(
      'INSERT INTO users (username, password, role, name, phone) VALUES (?, ?, ?, ?, ?)',
      [username, hashedPassword, role, name, phone]
    );

    const user = await db.get('SELECT id, username, role, name, phone FROM users WHERE id = ?', result.lastID);
    const token = generateToken(user);

    res.status(201).json({
      message: '注册成功',
      token,
      user
    });
  } catch (err) {
    console.error('注册错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const userInfo = {
      id: user.id,
      username: user.username,
      role: user.role,
      name: user.name,
      phone: user.phone
    };
    const token = generateToken(userInfo);

    res.json({
      message: '登录成功',
      token,
      user: userInfo
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

router.get('/users', authMiddleware, async (req, res) => {
  try {
    const db = await getDb();
    const users = await db.all('SELECT id, username, role, name, phone, created_at FROM users ORDER BY id');
    res.json({ users });
  } catch (err) {
    console.error('获取用户列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
