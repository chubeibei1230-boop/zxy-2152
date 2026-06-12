const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { isSlotAvailable, releaseLock } = require('./bookings');

const router = express.Router();

router.use(authMiddleware, requireRole('attendant', 'admin'));

router.put('/bookings/:id/no-show', async (req, res) => {
  try {
    const { id } = req.params;
    const { no_show_note } = req.body;
    const db = await getDb();
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', id);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: '已取消的预约不能标记未到场' });
    }
    if (booking.status === 'arrived') {
      return res.status(400).json({ error: '已到场的预约不能标记未到场' });
    }
    if (booking.status === 'no_show') {
      return res.json({ message: '已标记未到场' });
    }

    await db.run(
      `UPDATE bookings SET status = 'no_show', no_show_at = CURRENT_TIMESTAMP, no_show_note = ? WHERE id = ?`,
      [no_show_note || '', id]
    );

    if (booking.lock_id) {
      await releaseLock(db, booking.lock_id, '未到场释放');
    }

    const updated = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name, u.phone FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [id]
    );
    res.json({ message: '已标记未到场', booking: updated });
  } catch (err) {
    console.error('标记未到场错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/bookings/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { new_date, new_start_time, new_end_time } = req.body;
    if (!new_date || !new_start_time || !new_end_time) {
      return res.status(400).json({ error: '新日期、开始和结束时间不能为空' });
    }
    const db = await getDb();
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', id);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    if (booking.status === 'cancelled' || booking.status === 'no_show') {
      return res.status(400).json({ error: '已取消或未到场的预约不能改时' });
    }

    const availability = await isSlotAvailable(db, booking.room_id, new_date, new_start_time, new_end_time, null, id);
    if (!availability.available) {
      return res.status(409).json({ error: availability.reason });
    }

    const oldDate = booking.date;
    const oldStart = booking.start_time;
    const oldEnd = booking.end_time;

    await db.run(
      `UPDATE bookings SET date = ?, start_time = ?, end_time = ? WHERE id = ?`,
      [new_date, new_start_time, new_end_time, id]
    );

    const updated = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name, u.phone FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [id]
    );
    res.json({
      message: '现场改时成功',
      booking: updated,
      changed_from: { date: oldDate, start_time: oldStart, end_time: oldEnd },
      changed_to: { date: new_date, start_time: new_start_time, end_time: new_end_time }
    });
  } catch (err) {
    console.error('现场改时错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/temp-closures', async (req, res) => {
  try {
    const { room_id, date, start_time, end_time, reason } = req.body;
    if (!room_id || !date || !start_time || !end_time || !reason) {
      return res.status(400).json({ error: '房间ID、日期、开始时间、结束时间和原因不能为空' });
    }
    const db = await getDb();
    const room = await db.get('SELECT * FROM rooms WHERE id = ?', room_id);
    if (!room) {
      return res.status(404).json({ error: '房间不存在' });
    }

    const overlap = await db.get(
      `SELECT * FROM temp_closures WHERE room_id = ? AND date = ? 
       AND start_time < ? AND end_time > ?`,
      [room_id, date, end_time, start_time]
    );
    if (overlap) {
      return res.status(409).json({ error: '存在时间重叠的临时关闭记录' });
    }

    const result = await db.run(
      `INSERT INTO temp_closures (room_id, date, start_time, end_time, reason, created_by) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [room_id, date, start_time, end_time, reason, req.user.id]
    );

    const bookingsToCancel = await db.all(
      `SELECT id, lock_id FROM bookings WHERE room_id = ? AND date = ? 
       AND start_time = ? AND end_time = ? AND status = 'booked'`,
      [room_id, date, start_time, end_time]
    );
    for (const bk of bookingsToCancel) {
      await db.run(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ?`,
        ['临时关闭：' + reason, bk.id]
      );
      if (bk.lock_id) {
        await releaseLock(db, bk.lock_id, '临时关闭释放');
      }
    }

    const closure = await db.get(
      `SELECT tc.*, r.name as room_name, u.name as creator_name FROM temp_closures tc 
       LEFT JOIN rooms r ON tc.room_id = r.id LEFT JOIN users u ON tc.created_by = u.id 
       WHERE tc.id = ?`,
      [result.lastID]
    );
    res.status(201).json({
      message: '临时关闭设置成功',
      temp_closure: closure,
      cancelled_bookings_count: bookingsToCancel.length
    });
  } catch (err) {
    console.error('设置临时关闭错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.delete('/temp-closures/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const closure = await db.get('SELECT * FROM temp_closures WHERE id = ?', id);
    if (!closure) {
      return res.status(404).json({ error: '临时关闭记录不存在' });
    }
    await db.run('DELETE FROM temp_closures WHERE id = ?', [id]);
    res.json({ message: '临时关闭已撤销' });
  } catch (err) {
    console.error('撤销临时关闭错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/temp-closures', async (req, res) => {
  try {
    const { room_id, date, start_date, end_date } = req.query;
    const db = await getDb();
    let sql = `SELECT tc.*, r.name as room_name, u.name as creator_name FROM temp_closures tc 
               LEFT JOIN rooms r ON tc.room_id = r.id LEFT JOIN users u ON tc.created_by = u.id WHERE 1=1`;
    const params = [];
    if (room_id) { sql += ' AND tc.room_id = ?'; params.push(room_id); }
    if (date) { sql += ' AND tc.date = ?'; params.push(date); }
    if (start_date) { sql += ' AND tc.date >= ?'; params.push(start_date); }
    if (end_date) { sql += ' AND tc.date <= ?'; params.push(end_date); }
    sql += ' ORDER BY tc.date DESC, tc.created_at DESC';
    const closures = await db.all(sql, params);
    res.json({ temp_closures: closures });
  } catch (err) {
    console.error('获取临时关闭列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
