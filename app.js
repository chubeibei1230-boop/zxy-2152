require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');
const { startScheduledTasks } = require('./scheduler');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const bookingRoutes = require('./routes/bookings');
const attendantRoutes = require('./routes/attendant');
const queryRoutes = require('./routes/query');
const creditRoutes = require('./routes/credit');

const PORT = process.env.PORT || 8112;

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${req.ip}`);
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.get('SELECT 1 as ok');
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: result.ok === 1 ? 'connected' : 'error',
      version: '1.0.0'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/info', (req, res) => {
  res.json({
    name: '共享练琴房预约管理系统',
    version: '1.0.0',
    description: '基于 Node.js Express + SQLite 的练琴房预约服务端',
    port: PORT,
    endpoints: {
      auth: '/api/auth/*',
      admin: '/api/admin/* (需要 admin 角色)',
      bookings: '/api/* (预约人员功能)',
      attendant: '/api/attendant/* (需要 attendant 或 admin 角色)',
      query: '/api/query/* (已登录用户)',
      credit: '/api/credit/* (信用管理)',
      health: '/api/health',
      info: '/api/info'
    },
    default_accounts: [
      { username: 'admin', password: 'admin123', role: 'admin', desc: '系统管理员' },
      { username: 'booker', password: 'booker123', role: 'booker', desc: '预约用户张三' },
      { username: 'booker2', password: 'booker123', role: 'booker', desc: '预约用户李四' },
      { username: 'attendant', password: 'attendant123', role: 'attendant', desc: '值守人员王五' }
    ],
    statuses: [
      { code: 'available', desc: '可预约' },
      { code: 'temp_locked', desc: '临时锁定' },
      { code: 'locked_by_me', desc: '被当前用户锁定' },
      { code: 'booked', desc: '已预约' },
      { code: 'arrived', desc: '已到场' },
      { code: 'no_show', desc: '未到场' },
      { code: 'cancelled', desc: '已取消' },
      { code: 'temp_closed', desc: '临时关闭' },
      { code: 'closed', desc: '该日期关闭' },
      { code: 'unavailable', desc: '不可用' }
    ]
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', bookingRoutes);
app.use('/api/attendant', attendantRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/credit', creditRoutes);

app.use((err, req, res, next) => {
  console.error('[未处理异常]', err);
  res.status(500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: '接口不存在',
    path: req.url,
    method: req.method
  });
});

async function startServer() {
  try {
    await getDb();
    console.log('✓ 数据库连接成功');

    startScheduledTasks();

    app.listen(PORT, () => {
      console.log('');
      console.log('========================================');
      console.log('  共享练琴房预约管理系统 服务已启动');
      console.log('========================================');
      console.log(`  端口: ${PORT}`);
      console.log(`  健康检查: http://localhost:${PORT}/api/health`);
      console.log(`  系统信息: http://localhost:${PORT}/api/info`);
      console.log('========================================');
      console.log('  默认账号:');
      console.log('    admin    / admin123      (管理员)');
      console.log('    booker   / booker123     (预约用户)');
      console.log('    booker2  / booker123     (预约用户)');
      console.log('    attendant/ attendant123  (值守人员)');
      console.log('========================================');
      console.log('');
    });
  } catch (err) {
    console.error('✗ 启动失败:', err);
    process.exit(1);
  }
}

startServer();
