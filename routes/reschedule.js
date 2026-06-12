const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { isSlotAvailable } = require('./bookings');

const router = express.Router();

router.use(authMiddleware);

async function addRescheduleLog(db, requestId, bookingId, userId, action, actionDetail, operatorId, operatorRole) {
  await db.run(
    `INSERT INTO booking_reschedule_logs 
     (request_id, booking_id, user_id, action, action_detail, operator_id, operator_role) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [requestId, bookingId, userId, action, actionDetail || null, operatorId || null, operatorRole || null]
  );
}

function isBookingFutureAndValid(booking) {
  if (!booking || booking.status === 'cancelled' || booking.status === 'no_show') {
    return { valid: false, reason: '预约不存在或已取消/未到场' };
  }
  if (booking.status === 'arrived') {
    return { valid: false, reason: '已到场的预约不能改签' };
  }

  const now = new Date();
  const bookingDateTime = new Date(`${booking.date}T${booking.start_time}:00`);
  if (bookingDateTime <= now) {
    return { valid: false, reason: '已开始或已结束的预约不能改签' };
  }

  return { valid: true };
}

router.post('/reschedule', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { booking_id, target_date, target_start_time, target_end_time, reason } = req.body;

    if (!booking_id || !target_date || !target_start_time || !target_end_time || !reason) {
      return res.status(400).json({ error: '预约ID、目标日期、目标时段和改签原因不能为空' });
    }

    const db = await getDb();

    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [booking_id]);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }

    if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权为他人预约提交改签申请' });
    }

    const checkResult = isBookingFutureAndValid(booking);
    if (!checkResult.valid) {
      return res.status(400).json({ error: checkResult.reason });
    }

    const pendingRequest = await db.get(
      `SELECT id FROM booking_reschedule_requests 
       WHERE booking_id = ? AND status = 'pending'`,
      [booking_id]
    );
    if (pendingRequest) {
      return res.status(409).json({ error: '该预约已有待处理的改签申请，请等待审批' });
    }

    const availability = await isSlotAvailable(
      db, booking.room_id, target_date, target_start_time, target_end_time, null, booking_id
    );
    if (!availability.available) {
      return res.status(409).json({ error: '目标时段不可预约：' + availability.reason });
    }

    const result = await db.run(
      `INSERT INTO booking_reschedule_requests 
       (booking_id, user_id, room_id, original_date, original_start_time, original_end_time,
        target_date, target_start_time, target_end_time, reason, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        booking_id, booking.user_id, booking.room_id,
        booking.date, booking.start_time, booking.end_time,
        target_date, target_start_time, target_end_time, reason
      ]
    );

    await addRescheduleLog(
      db, result.lastID, booking_id, booking.user_id,
      'submit', `提交改签申请：${booking.date} ${booking.start_time}-${booking.end_time} → ${target_date} ${target_start_time}-${target_end_time}，原因：${reason}`,
      req.user.id, req.user.role
    );

    const request = await db.get(
      `SELECT brr.*, rm.name as room_name, u.name as user_name 
       FROM booking_reschedule_requests brr 
       LEFT JOIN rooms rm ON brr.room_id = rm.id 
       LEFT JOIN users u ON brr.user_id = u.id 
       WHERE brr.id = ?`,
      [result.lastID]
    );

    res.status(201).json({ message: '改签申请提交成功', request });
  } catch (err) {
    console.error('提交改签申请错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/reschedule/mine', async (req, res) => {
  try {
    const { status, page = 1, page_size = 20 } = req.query;
    const db = await getDb();

    let sql = `SELECT r.*, rm.name as room_name 
               FROM booking_reschedule_requests r 
               LEFT JOIN rooms rm ON r.room_id = rm.id 
               WHERE r.user_id = ?`;
    let countSql = `SELECT COUNT(*) as total FROM booking_reschedule_requests WHERE user_id = ?`;
    const params = [req.user.id];
    const countParams = [req.user.id];

    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      const placeholders = statuses.map(() => '?').join(',');
      sql += ` AND r.status IN (${placeholders})`;
      countSql += ` AND status IN (${placeholders})`;
      params.push(...statuses);
      countParams.push(...statuses);
    }

    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;

    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 100);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);

    const requests = await db.all(sql, params);

    res.json({
      requests,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取我的改签申请错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/reschedule/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const request = await db.get(
      `SELECT r.*, rm.name as room_name, u.name as user_name, u.phone as user_phone,
              ap.name as approver_name 
       FROM booking_reschedule_requests r 
       LEFT JOIN rooms rm ON r.room_id = rm.id 
       LEFT JOIN users u ON r.user_id = u.id 
       LEFT JOIN users ap ON r.approver_id = ap.id 
       WHERE r.id = ?`,
      [id]
    );

    if (!request) {
      return res.status(404).json({ error: '改签申请不存在' });
    }

    if (request.user_id !== req.user.id && 
        req.user.role !== 'admin' && 
        req.user.role !== 'attendant') {
      return res.status(403).json({ error: '无权查看该改签申请' });
    }

    const booking = await db.get(
      `SELECT b.*, rm.name as room_name, u.name as user_name, u.phone as user_phone 
       FROM bookings b 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [request.booking_id]
    );

    const logs = await db.all(
      `SELECT l.*, u.name as operator_name 
       FROM booking_reschedule_logs l 
       LEFT JOIN users u ON l.operator_id = u.id 
       WHERE l.request_id = ? 
       ORDER BY l.created_at ASC`,
      [id]
    );

    res.json({ request, booking, logs });
  } catch (err) {
    console.error('获取改签申请详情错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/bookings/:bookingId/reschedules', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const db = await getDb();

    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }

    if (booking.user_id !== req.user.id && 
        req.user.role !== 'admin' && 
        req.user.role !== 'attendant') {
      return res.status(403).json({ error: '无权查看该预约的改签记录' });
    }

    const reschedules = await db.all(
      `SELECT r.*, rm.name as room_name, ap.name as approver_name 
       FROM booking_reschedule_requests r 
       LEFT JOIN rooms rm ON r.room_id = rm.id 
       LEFT JOIN users ap ON r.approver_id = ap.id 
       WHERE r.booking_id = ? 
       ORDER BY r.created_at DESC`,
      [bookingId]
    );

    const logs = await db.all(
      `SELECT l.*, u.name as operator_name 
       FROM booking_reschedule_logs l 
       LEFT JOIN users u ON l.operator_id = u.id 
       WHERE l.booking_id = ? 
       ORDER BY l.created_at ASC`,
      [bookingId]
    );

    res.json({ booking, reschedules, logs });
  } catch (err) {
    console.error('获取预约改签记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/admin/reschedules', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const {
      status,
      room_id,
      user_id,
      target_date,
      start_date,
      end_date,
      page = 1,
      page_size = 20
    } = req.query;

    const db = await getDb();

    let sql = `SELECT r.*, rm.name as room_name, u.name as user_name, u.phone as user_phone 
               FROM booking_reschedule_requests r 
               LEFT JOIN rooms rm ON r.room_id = rm.id 
               LEFT JOIN users u ON r.user_id = u.id 
               WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total FROM booking_reschedule_requests WHERE 1=1`;
    const params = [];
    const countParams = [];

    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      const placeholders = statuses.map(() => '?').join(',');
      sql += ` AND r.status IN (${placeholders})`;
      countSql += ` AND status IN (${placeholders})`;
      params.push(...statuses);
      countParams.push(...statuses);
    }

    if (room_id) {
      sql += ' AND r.room_id = ?';
      countSql += ' AND room_id = ?';
      params.push(room_id);
      countParams.push(room_id);
    }

    if (user_id) {
      sql += ' AND r.user_id = ?';
      countSql += ' AND user_id = ?';
      params.push(user_id);
      countParams.push(user_id);
    }

    if (target_date) {
      sql += ' AND r.target_date = ?';
      countSql += ' AND target_date = ?';
      params.push(target_date);
      countParams.push(target_date);
    }

    if (start_date) {
      sql += ' AND r.target_date >= ?';
      countSql += ' AND target_date >= ?';
      params.push(start_date);
      countParams.push(start_date);
    }

    if (end_date) {
      sql += ' AND r.target_date <= ?';
      countSql += ' AND target_date <= ?';
      params.push(end_date);
      countParams.push(end_date);
    }

    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;

    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 200);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);

    const requests = await db.all(sql, params);

    const pendingCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE status = 'pending'`
    );
    const approvedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE status = 'approved'`
    );
    const rejectedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE status = 'rejected'`
    );

    res.json({
      requests,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      },
      stats: {
        pending: pendingCount.count,
        approved: approvedCount.count,
        rejected: rejectedCount.count
      }
    });
  } catch (err) {
    console.error('获取改签申请列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/admin/reschedules/:id/approve', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const request = await db.get('SELECT * FROM booking_reschedule_requests WHERE id = ?', [id]);
    if (!request) {
      return res.status(404).json({ error: '改签申请不存在' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: '该改签申请已处理，无法重复审批' });
    }

    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [request.booking_id]);
    if (!booking) {
      return res.status(404).json({ error: '关联预约不存在' });
    }

    const checkResult = isBookingFutureAndValid(booking);
    if (!checkResult.valid) {
      await db.run(
        `UPDATE booking_reschedule_requests 
         SET status = 'rejected', reject_reason = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        ['预约状态变更，无法改签：' + checkResult.reason, id]
      );
      await addRescheduleLog(
        db, id, request.booking_id, request.user_id,
        'auto_reject', '系统自动驳回：' + checkResult.reason,
        req.user.id, req.user.role
      );
      return res.status(400).json({ error: checkResult.reason });
    }

    const availability = await isSlotAvailable(
      db, request.room_id, request.target_date, 
      request.target_start_time, request.target_end_time, 
      null, request.booking_id
    );
    if (!availability.available) {
      return res.status(409).json({ error: '目标时段已不可预约：' + availability.reason });
    }

    await db.run('BEGIN TRANSACTION');

    try {
      const oldDate = booking.date;
      const oldStart = booking.start_time;
      const oldEnd = booking.end_time;

      await db.run(
        `UPDATE bookings 
         SET date = ?, start_time = ?, end_time = ? 
         WHERE id = ?`,
        [request.target_date, request.target_start_time, request.target_end_time, request.booking_id]
      );

      await db.run(
        `UPDATE booking_reschedule_requests 
         SET status = 'approved', approver_id = ?, approver_role = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [req.user.id, req.user.role, id]
      );

      await addRescheduleLog(
        db, id, request.booking_id, request.user_id,
        'approve', `审批通过：${oldDate} ${oldStart}-${oldEnd} → ${request.target_date} ${request.target_start_time}-${request.target_end_time}`,
        req.user.id, req.user.role
      );

      await db.run('COMMIT');

      const updatedRequest = await db.get(
        `SELECT r.*, rm.name as room_name, u.name as user_name, u.phone as user_phone,
                ap.name as approver_name 
         FROM booking_reschedule_requests r 
         LEFT JOIN rooms rm ON r.room_id = rm.id 
         LEFT JOIN users u ON r.user_id = u.id 
         LEFT JOIN users ap ON r.approver_id = ap.id 
         WHERE r.id = ?`,
        [id]
      );

      const updatedBooking = await db.get(
        `SELECT b.*, rm.name as room_name, u.name as user_name, u.phone as user_phone 
         FROM bookings b 
         LEFT JOIN rooms rm ON b.room_id = rm.id 
         LEFT JOIN users u ON b.user_id = u.id 
         WHERE b.id = ?`,
        [request.booking_id]
      );

      res.json({
        message: '改签审批通过',
        request: updatedRequest,
        booking: updatedBooking,
        changed_from: { date: oldDate, start_time: oldStart, end_time: oldEnd },
        changed_to: { date: request.target_date, start_time: request.target_start_time, end_time: request.target_end_time }
      });
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('审批改签申请错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/admin/reschedules/:id/reject', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reject_reason } = req.body;

    if (!reject_reason) {
      return res.status(400).json({ error: '驳回原因不能为空' });
    }

    const db = await getDb();

    const request = await db.get('SELECT * FROM booking_reschedule_requests WHERE id = ?', [id]);
    if (!request) {
      return res.status(404).json({ error: '改签申请不存在' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: '该改签申请已处理，无法重复审批' });
    }

    await db.run(
      `UPDATE booking_reschedule_requests 
       SET status = 'rejected', reject_reason = ?, approver_id = ?, approver_role = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [reject_reason, req.user.id, req.user.role, id]
    );

    await addRescheduleLog(
      db, id, request.booking_id, request.user_id,
      'reject', `审批驳回，原因：${reject_reason}`,
      req.user.id, req.user.role
    );

    const updatedRequest = await db.get(
      `SELECT r.*, rm.name as room_name, u.name as user_name, u.phone as user_phone,
              ap.name as approver_name 
       FROM booking_reschedule_requests r 
       LEFT JOIN rooms rm ON r.room_id = rm.id 
       LEFT JOIN users u ON r.user_id = u.id 
       LEFT JOIN users ap ON r.approver_id = ap.id 
       WHERE r.id = ?`,
      [id]
    );

    res.json({ message: '改签申请已驳回', request: updatedRequest });
  } catch (err) {
    console.error('驳回改签申请错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/stats/reschedule', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { start_date, end_date, room_id, user_id } = req.query;
    const db = await getDb();

    let dateFilter = '';
    const params = [];

    if (start_date) {
      dateFilter += ' AND target_date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      dateFilter += ' AND target_date <= ?';
      params.push(end_date);
    }
    if (room_id) {
      dateFilter += ' AND room_id = ?';
      params.push(room_id);
    }
    if (user_id) {
      dateFilter += ' AND user_id = ?';
      params.push(user_id);
    }

    const totalRequests = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE 1=1 ${dateFilter}`,
      params
    );
    const pendingCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE status = 'pending' ${dateFilter}`,
      params
    );
    const approvedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE status = 'approved' ${dateFilter}`,
      params
    );
    const rejectedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_reschedule_requests WHERE status = 'rejected' ${dateFilter}`,
      params
    );

    const roomStats = await db.all(
      `SELECT r.room_id, rm.name as room_name, 
              COUNT(*) as total_requests,
              SUM(CASE WHEN r.status = 'pending' THEN 1 ELSE 0 END) as pending_count,
              SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) as approved_count,
              SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM booking_reschedule_requests r 
       LEFT JOIN rooms rm ON r.room_id = rm.id 
       WHERE 1=1 ${dateFilter.replace(/r\./g, '')}
       GROUP BY r.room_id, rm.name 
       ORDER BY total_requests DESC`,
      params
    );

    const userTopStats = await db.all(
      `SELECT r.user_id, u.name as user_name, u.username,
              COUNT(*) as total_requests,
              SUM(CASE WHEN r.status = 'approved' THEN 1 ELSE 0 END) as approved_count,
              SUM(CASE WHEN r.status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM booking_reschedule_requests r 
       LEFT JOIN users u ON r.user_id = u.id 
       WHERE 1=1 ${dateFilter.replace(/r\./g, '')}
       GROUP BY r.user_id, u.name, u.username 
       ORDER BY total_requests DESC 
       LIMIT 10`,
      params
    );

    res.json({
      overview: {
        total_requests: totalRequests.count,
        pending: pendingCount.count,
        approved: approvedCount.count,
        rejected: rejectedCount.count,
        approval_rate: totalRequests.count > 0 
          ? ((approvedCount.count / totalRequests.count) * 100).toFixed(2) + '%' 
          : '0%'
      },
      room_stats: roomStats,
      user_top: userTopStats,
      period: { start_date: start_date || null, end_date: end_date || null }
    });
  } catch (err) {
    console.error('获取改签统计错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
