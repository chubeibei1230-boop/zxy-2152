const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware, requireRole('admin'));

router.get('/rooms', async (req, res) => {
  try {
    const db = await getDb();
    const rooms = await db.all('SELECT * FROM rooms ORDER BY id');
    for (const room of rooms) {
      const slots = await db.all(
        'SELECT id, start_time, end_time, is_active FROM time_slot_templates WHERE room_id = ? ORDER BY start_time',
        [room.id]
      );
      room.time_slots = slots;
    }
    res.json({ rooms });
  } catch (err) {
    console.error('获取房间列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/rooms', async (req, res) => {
  try {
    const { name, description, capacity = 1 } = req.body;
    if (!name) {
      return res.status(400).json({ error: '房间名称不能为空' });
    }
    const db = await getDb();
    const existing = await db.get('SELECT id FROM rooms WHERE name = ?', name);
    if (existing) {
      return res.status(400).json({ error: '房间名称已存在' });
    }
    const result = await db.run(
      'INSERT INTO rooms (name, description, capacity, status) VALUES (?, ?, ?, ?)',
      [name, description || '', capacity, 'active']
    );
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', result.lastID);
    res.status(201).json({ message: '房间创建成功', room });
  } catch (err) {
    console.error('创建房间错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, capacity, status } = req.body;
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    if (name && name !== room.name) {
      const existing = await db.get('SELECT id FROM rooms WHERE name = ? AND id != ?', [name, id]);
      if (existing) {
        return res.status(400).json({ error: '房间名称已存在' });
      }
    }
    await db.run(
      'UPDATE rooms SET name = ?, description = ?, capacity = ?, status = ? WHERE id = ?',
      [name || room.name, description !== undefined ? description : room.description,
       capacity || room.capacity, status || room.status, id]
    );
    const updated = await db.get('SELECT * FROM rooms WHERE id = ?', id);
    res.json({ message: '房间更新成功', room: updated });
  } catch (err) {
    console.error('更新房间错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.delete('/rooms/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const bookingCount = await db.get('SELECT COUNT(*) as count FROM bookings WHERE room_id = ? AND status != ?', [id, 'cancelled']);
    if (bookingCount.count > 0) {
      return res.status(400).json({ error: '该房间存在有效预约，无法删除' });
    }
    await db.run('DELETE FROM time_slot_templates WHERE room_id = ?', id);
    await db.run('DELETE FROM rooms WHERE id = ?', id);
    res.json({ message: '房间删除成功' });
  } catch (err) {
    console.error('删除房间错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/rooms/:id/time-slots', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_time, end_time } = req.body;
    if (!start_time || !end_time) {
      return res.status(400).json({ error: '开始和结束时间不能为空' });
    }
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const existing = await db.get(
      'SELECT id FROM time_slot_templates WHERE room_id = ? AND start_time = ? AND end_time = ?',
      [id, start_time, end_time]
    );
    if (existing) {
      return res.status(400).json({ error: '该时段已存在' });
    }
    const result = await db.run(
      'INSERT INTO time_slot_templates (room_id, start_time, end_time, is_active) VALUES (?, ?, ?, 1)',
      [id, start_time, end_time]
    );
    const slot = await db.get('SELECT * FROM time_slot_templates WHERE id = ?', result.lastID);
    res.status(201).json({ message: '时段创建成功', time_slot: slot });
  } catch (err) {
    console.error('创建时段错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/time-slots/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const { start_time, end_time, is_active } = req.body;
    const db = await getDb();
    const slot = await db.get('SELECT * FROM time_slot_templates WHERE id = ?', slotId);
    if (!slot) {
      return res.status(404).json({ error: '时段不存在' });
    }
    await db.run(
      'UPDATE time_slot_templates SET start_time = ?, end_time = ?, is_active = ? WHERE id = ?',
      [start_time || slot.start_time, end_time || slot.end_time, is_active !== undefined ? is_active : slot.is_active, slotId]
    );
    const updated = await db.get('SELECT * FROM time_slot_templates WHERE id = ?', slotId);
    res.json({ message: '时段更新成功', time_slot: updated });
  } catch (err) {
    console.error('更新时段错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.delete('/time-slots/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const db = await getDb();
    const slot = await db.get('SELECT * FROM time_slot_templates WHERE id = ?', slotId);
    if (!slot) {
      return res.status(404).json({ error: '时段不存在' });
    }
    await db.run('DELETE FROM time_slot_templates WHERE id = ?', slotId);
    res.json({ message: '时段删除成功' });
  } catch (err) {
    console.error('删除时段错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/open-dates', async (req, res) => {
  try {
    const { room_id, start_date, end_date } = req.query;
    const db = await getDb();
    let sql = 'SELECT od.*, r.name as room_name FROM open_dates od LEFT JOIN rooms r ON od.room_id = r.id WHERE 1=1';
    const params = [];
    if (room_id) { sql += ' AND od.room_id = ?'; params.push(room_id); }
    if (start_date) { sql += ' AND od.date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND od.date <= ?'; params.push(end_date); }
    sql += ' ORDER BY od.date, od.room_id';
    const dates = await db.all(sql, params);
    res.json({ open_dates: dates });
  } catch (err) {
    console.error('获取开放日期错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/open-dates', async (req, res) => {
  try {
    const { room_id, date, is_open = 1, close_reason } = req.body;
    if (!room_id || !date) {
      return res.status(400).json({ error: '房间ID和日期不能为空' });
    }
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', room_id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const existing = await db.get('SELECT * FROM open_dates WHERE room_id = ? AND date = ?', [room_id, date]);
    if (existing) {
      await db.run(
        'UPDATE open_dates SET is_open = ?, close_reason = ?, created_by = ? WHERE id = ?',
        [is_open, is_open ? null : (close_reason || '管理员关闭'), req.user.id, existing.id]
      );
      const updated = await db.get('SELECT * FROM open_dates WHERE id = ?', existing.id);
      return res.json({ message: '开放日期更新成功', open_date: updated });
    } else {
      const result = await db.run(
        'INSERT INTO open_dates (room_id, date, is_open, close_reason, created_by) VALUES (?, ?, ?, ?, ?)',
        [room_id, date, is_open, is_open ? null : (close_reason || '管理员关闭'), req.user.id]
      );
      const created = await db.get('SELECT * FROM open_dates WHERE id = ?', result.lastID);
      return res.status(201).json({ message: '开放日期创建成功', open_date: created });
    }
  } catch (err) {
    console.error('设置开放日期错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/open-dates/batch', async (req, res) => {
  try {
    const { room_id, start_date, end_date, is_open = 1, close_reason } = req.body;
    if (!room_id || !start_date || !end_date) {
      return res.status(400).json({ error: '房间ID、开始和结束日期不能为空' });
    }
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', room_id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const start = new Date(start_date);
    const end = new Date(end_date);
    const created = [];
    const stmt = await db.prepare('INSERT OR REPLACE INTO open_dates (room_id, date, is_open, close_reason, created_by) VALUES (?, ?, ?, ?, ?)');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      await stmt.run(room_id, dateStr, is_open, is_open ? null : (close_reason || '管理员关闭'), req.user.id);
      created.push(dateStr);
    }
    await stmt.finalize();
    res.json({ message: `批量设置成功，共处理 ${created.length} 天`, dates: created });
  } catch (err) {
    console.error('批量设置开放日期错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/deactivations', async (req, res) => {
  try {
    const { room_id } = req.query;
    const db = await getDb();
    let sql = "SELECT dr.*, r.name as room_name, u.name as creator_name FROM deactivation_records dr LEFT JOIN rooms r ON dr.room_id = r.id LEFT JOIN users u ON dr.created_by = u.id WHERE 1=1";
    const params = [];
    if (room_id) { sql += ' AND dr.room_id = ?'; params.push(room_id); }
    sql += ' ORDER BY dr.created_at DESC';
    const records = await db.all(sql, params);
    res.json({ deactivations: records });
  } catch (err) {
    console.error('获取停用记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/deactivations', async (req, res) => {
  try {
    const { room_id, reason, start_date, end_date } = req.body;
    if (!room_id || !reason || !start_date) {
      return res.status(400).json({ error: '房间ID、停用原因和开始日期不能为空' });
    }
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', room_id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }
    const result = await db.run(
      'INSERT INTO deactivation_records (room_id, reason, start_date, end_date, created_by) VALUES (?, ?, ?, ?, ?)',
      [room_id, reason, start_date, end_date || null, req.user.id]
    );
    const record = await db.get('SELECT * FROM deactivation_records WHERE id = ?', result.lastID);
    res.status(201).json({ message: '停用记录创建成功', deactivation: record });
  } catch (err) {
    console.error('创建停用记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
