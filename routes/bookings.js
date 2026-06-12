const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { checkBookingPermission, handleCancel, handleArrive, getLevelLabel, getUserCredit } = require('../utils/creditManager');

const router = express.Router();
const LOCK_DURATION_MINUTES = 5;

router.use(authMiddleware);

async function isSlotAvailable(db, room_id, date, start_time, end_time, excludeLockId = null, excludeBookingId = null) {
  const openDate = await db.get(
    'SELECT is_open FROM open_dates WHERE room_id = ? AND date = ?',
    [room_id, date]
  );
  if (openDate && openDate.is_open === 0) {
    return { available: false, reason: '该日期此房间未开放预约' };
  }

  const template = await db.get(
    'SELECT id FROM time_slot_templates WHERE room_id = ? AND start_time = ? AND end_time = ? AND is_active = 1',
    [room_id, start_time, end_time]
  );
  if (!template) {
    return { available: false, reason: '此时段不在可预约范围内' };
  }

  const room = await db.get('SELECT status FROM rooms WHERE id = ?', room_id);
  if (!room || room.status !== 'active') {
    return { available: false, reason: '该房间已停用' };
  }

  const tempClosure = await db.get(
    `SELECT id FROM temp_closures WHERE room_id = ? AND date = ? 
     AND start_time < ? AND end_time > ?`,
    [room_id, date, end_time, start_time]
  );
  if (tempClosure) {
    return { available: false, reason: '此时段已被临时关闭' };
  }

  const booking = await db.get(
    `SELECT id, status FROM bookings WHERE room_id = ? AND date = ? 
     AND start_time = ? AND end_time = ? AND status IN ('booked', 'arrived')
     ${excludeBookingId ? 'AND id != ' + excludeBookingId : ''}`,
    [room_id, date, start_time, end_time]
  );
  if (booking) {
    return { available: false, reason: '此时段已被预约' };
  }

  const now = new Date().toISOString();
  const lockQuery = `
    SELECT id FROM temp_locks 
    WHERE room_id = ? AND date = ? AND start_time = ? AND end_time = ? 
    AND is_released = 0 AND expires_at > ?
    ${excludeLockId ? "AND id != '" + excludeLockId + "'" : ''}
  `;
  const lock = await db.get(lockQuery, [room_id, date, start_time, end_time, now]);
  if (lock) {
    return { available: false, reason: '此时段正被其他用户锁定中' };
  }

  return { available: true };
}

async function releaseLock(db, lockId, reason) {
  const lock = await db.get('SELECT * FROM temp_locks WHERE id = ?', lockId);
  if (!lock) return;
  
  await db.run(
    'UPDATE temp_locks SET is_released = 1, release_reason = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?',
    [reason, lockId]
  );
  await db.run(
    `INSERT INTO lock_release_logs (lock_id, user_id, room_id, date, start_time, end_time, release_reason) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [lockId, lock.user_id, lock.room_id, lock.date, lock.start_time, lock.end_time, reason]
  );
}

router.get('/rooms/availability', async (req, res) => {
  try {
    const { room_id, date } = req.query;
    if (!date) {
      return res.status(400).json({ error: '日期不能为空' });
    }

    const db = await getDb();
    
    let userCredit = null;
    let creditPermission = null;
    if (req.user.role === 'booker') {
      creditPermission = await checkBookingPermission(db, req.user.id);
      userCredit = creditPermission.credit;
      userCredit.level_label = getLevelLabel(userCredit.level);
    }
    let roomFilter = '';
    const params = [date];
    if (room_id) {
      roomFilter = ' AND r.id = ?';
      params.push(room_id);
    }

    const rooms = await db.all(`SELECT r.* FROM rooms r WHERE r.status = 'active' ${roomFilter} ORDER BY r.id`, params.slice(1));
    
    const result = [];
    for (const room of rooms) {
      const slots = await db.all(
        'SELECT t.id, t.start_time, t.end_time, t.is_active FROM time_slot_templates t WHERE t.room_id = ? AND t.is_active = 1 ORDER BY t.start_time',
        [room.id]
      );
      
      const roomData = {
        room_id: room.id,
        room_name: room.name,
        description: room.description,
        capacity: room.capacity,
        slots: []
      };

      const openDate = await db.get('SELECT is_open FROM open_dates WHERE room_id = ? AND date = ?', [room.id, date]);
      const isRoomOpen = !openDate || openDate.is_open === 1;

      for (const slot of slots) {
        const availability = await isSlotAvailable(db, room.id, date, slot.start_time, slot.end_time);
        let status = 'available';
        let lockInfo = null;

        if (!isRoomOpen) {
          status = 'closed';
        } else if (!availability.available) {
          if (availability.reason === '此时段已被预约') {
            status = 'booked';
          } else if (availability.reason === '此时段正被其他用户锁定中') {
            status = 'temp_locked';
            const lock = await db.get(
              `SELECT tl.id, tl.user_id, tl.expires_at, u.name as user_name FROM temp_locks tl 
               LEFT JOIN users u ON tl.user_id = u.id 
               WHERE tl.room_id = ? AND tl.date = ? AND tl.start_time = ? AND tl.end_time = ? 
               AND tl.is_released = 0 AND tl.expires_at > CURRENT_TIMESTAMP`,
              [room.id, date, slot.start_time, slot.end_time]
            );
            if (lock && lock.user_id === req.user.id) {
              status = 'locked_by_me';
              lockInfo = { lock_id: lock.id, expires_at: lock.expires_at };
            } else if (lock) {
              lockInfo = { expires_at: lock.expires_at, user_name: lock.user_name };
            }
          } else if (availability.reason === '此时段已被临时关闭') {
            status = 'temp_closed';
          } else {
            status = 'unavailable';
          }
        }

        const booking = await db.get(
          `SELECT b.id, b.status, b.user_id, u.name as user_name, u.phone 
           FROM bookings b LEFT JOIN users u ON b.user_id = u.id 
           WHERE b.room_id = ? AND b.date = ? AND b.start_time = ? AND b.end_time = ? 
           AND b.status != 'cancelled'`,
          [room.id, date, slot.start_time, slot.end_time]
        );

        roomData.slots.push({
          start_time: slot.start_time,
          end_time: slot.end_time,
          status,
          lock_info: lockInfo,
          booking: booking || null,
          note: !availability.available && isRoomOpen ? availability.reason : null
        });
      }
      result.push(roomData);
    }

    const response = { date, availability: result };
    if (userCredit) {
      response.user_credit = userCredit;
      response.can_book = creditPermission.allowed;
      if (!creditPermission.allowed) {
        response.credit_restriction = creditPermission.reason;
      }
      if (creditPermission.warning) {
        response.credit_warning = creditPermission.warning;
      }
    }
    res.json(response);
  } catch (err) {
    console.error('查询可用性错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/locks', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { room_id, date, start_time, end_time } = req.body;
    if (!room_id || !date || !start_time || !end_time) {
      return res.status(400).json({ error: '房间ID、日期、开始和结束时间不能为空' });
    }

    const db = await getDb();

    if (req.user.role === 'booker') {
      const permission = await checkBookingPermission(db, req.user.id);
      if (!permission.allowed) {
        return res.status(403).json({ 
          error: permission.reason,
          credit: permission.credit,
          credit_warning: true
        });
      }
    }

    const availability = await isSlotAvailable(db, room_id, date, start_time, end_time);
    if (!availability.available) {
      return res.status(409).json({ error: availability.reason });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_DURATION_MINUTES * 60 * 1000);
    const lockId = uuidv4();

    await db.run(
      `INSERT INTO temp_locks (id, user_id, room_id, date, start_time, end_time, expires_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lockId, req.user.id, room_id, date, start_time, end_time, expiresAt.toISOString()]
    );

    const lock = await db.get(
      `SELECT tl.*, r.name as room_name FROM temp_locks tl 
       LEFT JOIN rooms r ON tl.room_id = r.id WHERE tl.id = ?`,
      [lockId]
    );

    res.status(201).json({
      message: '锁定成功',
      lock: {
        id: lock.id,
        room_id: lock.room_id,
        room_name: lock.room_name,
        date: lock.date,
        start_time: lock.start_time,
        end_time: lock.end_time,
        expires_at: lock.expires_at,
        duration_minutes: LOCK_DURATION_MINUTES
      }
    });
  } catch (err) {
    console.error('创建锁定错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.delete('/locks/:lockId', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { lockId } = req.params;
    const db = await getDb();
    const lock = await db.get('SELECT * FROM temp_locks WHERE id = ?', lockId);
    if (!lock) {
      return res.status(404).json({ error: '锁不存在' });
    }
    if (lock.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权释放他人的锁定' });
    }
    if (lock.is_released) {
      return res.json({ message: '锁已被释放' });
    }

    await releaseLock(db, lockId, '用户主动释放');
    res.json({ message: '锁释放成功' });
  } catch (err) {
    console.error('释放锁定错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/bookings', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { room_id, date, start_time, end_time, lock_id } = req.body;
    if (!room_id || !date || !start_time || !end_time) {
      return res.status(400).json({ error: '房间ID、日期、开始和结束时间不能为空' });
    }

    const db = await getDb();

    if (req.user.role === 'booker') {
      const permission = await checkBookingPermission(db, req.user.id);
      if (!permission.allowed) {
        return res.status(403).json({ 
          error: permission.reason,
          credit: permission.credit,
          credit_warning: true
        });
      }
    }

    if (lock_id) {
      const lock = await db.get('SELECT * FROM temp_locks WHERE id = ?', lock_id);
      if (!lock) {
        return res.status(400).json({ error: '临时锁不存在或已过期' });
      }
      if (lock.is_released) {
        return res.status(400).json({ error: '临时锁已被释放' });
      }
      if (lock.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: '无权使用他人的锁定创建预约' });
      }
      if (new Date(lock.expires_at) <= new Date()) {
        await releaseLock(db, lock_id, '锁过期自动释放');
        return res.status(400).json({ error: '临时锁已过期' });
      }
      if (lock.room_id != room_id || lock.date !== date || lock.start_time !== start_time || lock.end_time !== end_time) {
        return res.status(400).json({ error: '锁定信息与预约信息不匹配' });
      }

      const result = await db.run(
        `INSERT INTO bookings (user_id, room_id, date, start_time, end_time, status, lock_id) 
         VALUES (?, ?, ?, ?, ?, 'booked', ?)`,
        [req.user.id, room_id, date, start_time, end_time, lock_id]
      );

      await releaseLock(db, lock_id, '已转换为预约');
      const booking = await db.get(
        `SELECT b.*, r.name as room_name, u.name as user_name, u.phone 
         FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
         WHERE b.id = ?`,
        [result.lastID]
      );
      return res.status(201).json({ message: '预约成功', booking });
    }

    const availability = await isSlotAvailable(db, room_id, date, start_time, end_time);
    if (!availability.available) {
      return res.status(409).json({ error: availability.reason });
    }

    const result = await db.run(
      `INSERT INTO bookings (user_id, room_id, date, start_time, end_time, status) 
       VALUES (?, ?, ?, ?, ?, 'booked')`,
      [req.user.id, room_id, date, start_time, end_time]
    );

    const booking = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name, u.phone 
       FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [result.lastID]
    );
    res.status(201).json({ message: '预约成功', booking });
  } catch (err) {
    console.error('创建预约错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/bookings/mine', async (req, res) => {
  try {
    const db = await getDb();
    const bookings = await db.all(
      `SELECT b.*, r.name as room_name FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id 
       WHERE b.user_id = ? ORDER BY b.date DESC, b.start_time DESC`,
      [req.user.id]
    );
    
    const credit = await getUserCredit(db, req.user.id);
    credit.level_label = getLevelLabel(credit.level);
    
    res.json({ 
      bookings,
      user_credit: credit
    });
  } catch (err) {
    console.error('获取我的预约错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/bookings/:id/cancel', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { cancel_reason } = req.body;
    const db = await getDb();
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', id);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权取消他人预约' });
    }
    if (booking.status === 'cancelled') {
      return res.json({ message: '预约已取消' });
    }
    if (booking.status === 'arrived') {
      return res.status(400).json({ error: '已到场的预约不能取消' });
    }

    await db.run(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = ? WHERE id = ?`,
      [cancel_reason || '用户取消', id]
    );

    const creditChange = await handleCancel(
      db, id, booking.user_id, booking.date, booking.start_time,
      cancel_reason || '用户取消', req.user.id, req.user.role
    );

    const updated = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [id]
    );
    res.json({ 
      message: '预约取消成功', 
      booking: updated,
      credit_change: creditChange
    });
  } catch (err) {
    console.error('取消预约错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/bookings/:id/arrive', requireRole('booker', 'attendant', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', id);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: '已取消的预约不能确认到场' });
    }
    if (booking.status === 'arrived') {
      return res.json({ message: '已确认到场' });
    }
    if (booking.status === 'no_show') {
      return res.status(400).json({ error: '已标记未到场的预约不能确认到场' });
    }
    if (booking.user_id !== req.user.id && req.user.role === 'booker') {
      return res.status(403).json({ error: '无权确认他人预约' });
    }

    await db.run(
      `UPDATE bookings SET status = 'arrived', arrived_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );

    const creditChange = await handleArrive(db, id, booking.user_id, req.user.id, req.user.role);

    const updated = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [id]
    );
    res.json({ 
      message: '到场确认成功', 
      booking: updated,
      credit_change: creditChange
    });
  } catch (err) {
    console.error('确认到场错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
module.exports.isSlotAvailable = isSlotAvailable;
module.exports.releaseLock = releaseLock;
