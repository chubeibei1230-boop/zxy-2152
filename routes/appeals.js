const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { getLevelLabel, getUserCredit, handleAppealApprove, CREDIT_CONFIG } = require('../utils/creditManager');

const router = express.Router();

router.use(authMiddleware);

const APPEAL_TYPES = [
  { type: 'no_show', label: '未到场标记申诉' },
  { type: 'cancel_late', label: '临时取消扣分申诉' },
  { type: 'credit_deduction', label: '信用分扣减申诉' }
];

const APPEAL_STATUSES = [
  { status: 'pending', label: '待处理' },
  { status: 'processing', label: '处理中' },
  { status: 'approved', label: '已通过' },
  { status: 'rejected', label: '已驳回' }
];

async function addAppealLog(db, appealId, bookingId, userId, action, actionDetail, operatorId, operatorRole) {
  await db.run(
    `INSERT INTO booking_appeal_logs 
     (appeal_id, booking_id, user_id, action, action_detail, operator_id, operator_role) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [appealId, bookingId, userId, action, actionDetail || null, operatorId || null, operatorRole || null]
  );
}

router.get('/appeals/types', async (req, res) => {
  try {
    res.json({
      types: APPEAL_TYPES,
      statuses: APPEAL_STATUSES
    });
  } catch (err) {
    console.error('获取申诉类型错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.post('/appeals', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { booking_id, appeal_type, reason, evidence } = req.body;

    if (!booking_id || !appeal_type || !reason) {
      return res.status(400).json({ error: '预约ID、申诉类型和申诉原因不能为空' });
    }

    const validTypes = APPEAL_TYPES.map(t => t.type);
    if (!validTypes.includes(appeal_type)) {
      return res.status(400).json({ error: '无效的申诉类型' });
    }

    if (!reason.trim()) {
      return res.status(400).json({ error: '申诉原因不能为空' });
    }

    const db = await getDb();

    const booking = await db.get(
      `SELECT b.*, r.name as room_name FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id WHERE b.id = ?`,
      [booking_id]
    );
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }

    if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权为他人预约提交申诉' });
    }

    if (appeal_type === 'no_show' && booking.status !== 'no_show') {
      return res.status(400).json({ error: '该预约未被标记为未到场，无法提交此类申诉' });
    }

    if (appeal_type === 'cancel_late' && booking.status !== 'cancelled') {
      return res.status(400).json({ error: '该预约未取消，无法提交临时取消扣分申诉' });
    }

    const pendingAppeal = await db.get(
      `SELECT id FROM booking_appeals 
       WHERE booking_id = ? AND status IN ('pending', 'processing')`,
      [booking_id]
    );
    if (pendingAppeal) {
      return res.status(409).json({ error: '该预约已有待处理的申诉，请等待审核' });
    }

    let originalCreditChange = 0;
    if (appeal_type === 'no_show') {
      originalCreditChange = -CREDIT_CONFIG.noShowPenalty;
    } else if (appeal_type === 'cancel_late') {
      const creditRecord = await db.get(
        `SELECT score_change FROM credit_records 
         WHERE booking_id = ? AND change_type = 'cancel_late' 
         ORDER BY id DESC LIMIT 1`,
        [booking_id]
      );
      originalCreditChange = creditRecord ? creditRecord.score_change : -CREDIT_CONFIG.lateCancelPenalty;
    } else if (appeal_type === 'credit_deduction') {
      const creditRecord = await db.get(
        `SELECT score_change FROM credit_records 
         WHERE booking_id = ? AND score_change < 0 
         ORDER BY id DESC LIMIT 1`,
        [booking_id]
      );
      originalCreditChange = creditRecord ? creditRecord.score_change : 0;
    }

    const result = await db.run(
      `INSERT INTO booking_appeals 
       (booking_id, user_id, appeal_type, reason, evidence, status, 
        original_status, original_credit_change) 
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        booking_id, booking.user_id, appeal_type, reason.trim(),
        evidence || null, booking.status, originalCreditChange
      ]
    );

    await addAppealLog(
      db, result.lastID, booking_id, booking.user_id,
      'submit',
      `提交申诉：类型=${appeal_type}，原因=${reason.trim()}`,
      req.user.id, req.user.role
    );

    const appeal = await db.get(
      `SELECT a.*, rm.name as room_name, u.name as user_name 
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON a.user_id = u.id 
       WHERE a.id = ?`,
      [result.lastID]
    );

    res.status(201).json({ message: '申诉提交成功', appeal });
  } catch (err) {
    console.error('提交申诉错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/appeals/mine', async (req, res) => {
  try {
    const { status, appeal_type, page = 1, page_size = 20 } = req.query;
    const db = await getDb();

    let sql = `SELECT a.*, rm.name as room_name, b.date, b.start_time, b.end_time 
               FROM booking_appeals a 
               LEFT JOIN bookings b ON a.booking_id = b.id 
               LEFT JOIN rooms rm ON b.room_id = rm.id 
               WHERE a.user_id = ?`;
    let countSql = `SELECT COUNT(*) as total FROM booking_appeals WHERE user_id = ?`;
    const params = [req.user.id];
    const countParams = [req.user.id];

    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      const placeholders = statuses.map(() => '?').join(',');
      sql += ` AND a.status IN (${placeholders})`;
      countSql += ` AND status IN (${placeholders})`;
      params.push(...statuses);
      countParams.push(...statuses);
    }

    if (appeal_type) {
      const types = Array.isArray(appeal_type) ? appeal_type : appeal_type.split(',');
      const placeholders = types.map(() => '?').join(',');
      sql += ` AND a.appeal_type IN (${placeholders})`;
      countSql += ` AND appeal_type IN (${placeholders})`;
      params.push(...types);
      countParams.push(...types);
    }

    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;

    sql += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 100);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);

    const appeals = await db.all(sql, params);

    const typeLabelMap = {};
    APPEAL_TYPES.forEach(t => { typeLabelMap[t.type] = t.label; });
    const statusLabelMap = {};
    APPEAL_STATUSES.forEach(s => { statusLabelMap[s.status] = s.label; });

    appeals.forEach(a => {
      a.appeal_type_label = typeLabelMap[a.appeal_type] || a.appeal_type;
      a.status_label = statusLabelMap[a.status] || a.status;
    });

    res.json({
      appeals,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取我的申诉列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/appeals/:id(\\d+)', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();

    const appeal = await db.get(
      `SELECT a.*, rm.name as room_name, 
              u.name as user_name, u.phone as user_phone, u.username as user_username,
              hd.name as handler_name 
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON a.user_id = u.id 
       LEFT JOIN users hd ON a.handler_id = hd.id 
       WHERE a.id = ?`,
      [id]
    );

    if (!appeal) {
      return res.status(404).json({ error: '申诉不存在' });
    }

    if (appeal.user_id !== req.user.id && 
        req.user.role !== 'admin' && 
        req.user.role !== 'attendant') {
      return res.status(403).json({ error: '无权查看该申诉' });
    }

    const typeLabelMap = {};
    APPEAL_TYPES.forEach(t => { typeLabelMap[t.type] = t.label; });
    const statusLabelMap = {};
    APPEAL_STATUSES.forEach(s => { statusLabelMap[s.status] = s.label; });
    appeal.appeal_type_label = typeLabelMap[appeal.appeal_type] || appeal.appeal_type;
    appeal.status_label = statusLabelMap[appeal.status] || appeal.status;

    const booking = await db.get(
      `SELECT b.*, rm.name as room_name, u.name as user_name, u.phone as user_phone 
       FROM bookings b 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [appeal.booking_id]
    );

    const userCredit = await getUserCredit(db, appeal.user_id);
    userCredit.level_label = getLevelLabel(userCredit.level);

    const creditRecords = await db.all(
      `SELECT cr.*, op.name as operator_name 
       FROM credit_records cr 
       LEFT JOIN users op ON cr.operator_id = op.id 
       WHERE cr.booking_id = ? 
       ORDER BY cr.created_at DESC`,
      [appeal.booking_id]
    );

    const logs = await db.all(
      `SELECT l.*, u.name as operator_name 
       FROM booking_appeal_logs l 
       LEFT JOIN users u ON l.operator_id = u.id 
       WHERE l.appeal_id = ? 
       ORDER BY l.created_at ASC`,
      [id]
    );

    const pastAppeals = await db.all(
      `SELECT a.*, rm.name as room_name, b.date, b.start_time, b.end_time 
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       WHERE a.user_id = ? AND a.id != ? 
       ORDER BY a.created_at DESC 
       LIMIT 10`,
      [appeal.user_id, id]
    );
    pastAppeals.forEach(a => {
      a.appeal_type_label = typeLabelMap[a.appeal_type] || a.appeal_type;
      a.status_label = statusLabelMap[a.status] || a.status;
    });

    res.json({
      appeal,
      booking,
      user_credit: userCredit,
      credit_records: creditRecords,
      logs,
      past_appeals: pastAppeals
    });
  } catch (err) {
    console.error('获取申诉详情错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/appeals/:id(\\d+)/note', requireRole('booker', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, evidence } = req.body;
    const db = await getDb();

    const appeal = await db.get('SELECT * FROM booking_appeals WHERE id = ?', [id]);
    if (!appeal) {
      return res.status(404).json({ error: '申诉不存在' });
    }

    if (appeal.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '无权修改该申诉' });
    }

    if (appeal.status !== 'pending') {
      return res.status(400).json({ error: '仅待处理状态的申诉可补充信息' });
    }

    if (!reason && !evidence) {
      return res.status(400).json({ error: '申诉原因或补充证据不能为空' });
    }

    await db.run(
      `UPDATE booking_appeals 
       SET reason = COALESCE(?, reason), evidence = COALESCE(?, evidence), 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [reason || null, evidence || null, id]
    );

    const detail = [];
    if (reason) detail.push(`原因补充：${reason}`);
    if (evidence) detail.push(`证据补充：${evidence}`);

    await addAppealLog(
      db, id, appeal.booking_id, appeal.user_id,
      'update_note', detail.join('；'),
      req.user.id, req.user.role
    );

    const updated = await db.get(
      `SELECT a.*, rm.name as room_name, u.name as user_name 
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON a.user_id = u.id 
       WHERE a.id = ?`,
      [id]
    );

    res.json({ message: '申诉信息已更新', appeal: updated });
  } catch (err) {
    console.error('更新申诉信息错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/appeals/management', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const {
      status,
      appeal_type,
      room_id,
      user_id,
      start_date,
      end_date,
      page = 1,
      page_size = 20
    } = req.query;

    const db = await getDb();

    let sql = `SELECT a.*, rm.name as room_name, 
                      u.name as user_name, u.phone as user_phone, u.username as user_username,
                      b.date, b.start_time, b.end_time, b.status as booking_status,
                      hd.name as handler_name 
               FROM booking_appeals a 
               LEFT JOIN bookings b ON a.booking_id = b.id 
               LEFT JOIN rooms rm ON b.room_id = rm.id 
               LEFT JOIN users u ON a.user_id = u.id 
               LEFT JOIN users hd ON a.handler_id = hd.id 
               WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total FROM booking_appeals a 
                    LEFT JOIN bookings b ON a.booking_id = b.id 
                    WHERE 1=1`;
    const params = [];
    const countParams = [];

    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      const placeholders = statuses.map(() => '?').join(',');
      sql += ` AND a.status IN (${placeholders})`;
      countSql += ` AND a.status IN (${placeholders})`;
      params.push(...statuses);
      countParams.push(...statuses);
    }

    if (appeal_type) {
      const types = Array.isArray(appeal_type) ? appeal_type : appeal_type.split(',');
      const placeholders = types.map(() => '?').join(',');
      sql += ` AND a.appeal_type IN (${placeholders})`;
      countSql += ` AND a.appeal_type IN (${placeholders})`;
      params.push(...types);
      countParams.push(...types);
    }

    if (room_id) {
      sql += ' AND b.room_id = ?';
      countSql += ' AND b.room_id = ?';
      params.push(room_id);
      countParams.push(room_id);
    }

    if (user_id) {
      sql += ' AND a.user_id = ?';
      countSql += ' AND a.user_id = ?';
      params.push(user_id);
      countParams.push(user_id);
    }

    if (start_date) {
      sql += ' AND DATE(a.created_at) >= ?';
      countSql += ' AND DATE(a.created_at) >= ?';
      params.push(start_date);
      countParams.push(start_date);
    }

    if (end_date) {
      sql += ' AND DATE(a.created_at) <= ?';
      countSql += ' AND DATE(a.created_at) <= ?';
      params.push(end_date);
      countParams.push(end_date);
    }

    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;

    sql += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 200);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);

    const appeals = await db.all(sql, params);

    const typeLabelMap = {};
    APPEAL_TYPES.forEach(t => { typeLabelMap[t.type] = t.label; });
    const statusLabelMap = {};
    APPEAL_STATUSES.forEach(s => { statusLabelMap[s.status] = s.label; });

    appeals.forEach(a => {
      a.appeal_type_label = typeLabelMap[a.appeal_type] || a.appeal_type;
      a.status_label = statusLabelMap[a.status] || a.status;
    });

    const pendingCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals WHERE status = 'pending'`
    );
    const processingCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals WHERE status = 'processing'`
    );
    const approvedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals WHERE status = 'approved'`
    );
    const rejectedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals WHERE status = 'rejected'`
    );

    res.json({
      appeals,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      },
      stats: {
        pending: pendingCount.count,
        processing: processingCount.count,
        approved: approvedCount.count,
        rejected: rejectedCount.count
      }
    });
  } catch (err) {
    console.error('获取申诉列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/appeals/management/:id/approve', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { handle_note } = req.body;
    const db = await getDb();

    const appeal = await db.get('SELECT * FROM booking_appeals WHERE id = ?', [id]);
    if (!appeal) {
      return res.status(404).json({ error: '申诉不存在' });
    }

    if (appeal.status !== 'pending' && appeal.status !== 'processing') {
      return res.status(400).json({ error: '该申诉已处理，无法重复审批' });
    }

    await db.run('BEGIN TRANSACTION');

    try {
      const handleResult = await handleAppealApprove(
        db, appeal, req.user.id, req.user.role
      );

      await db.run(
        `UPDATE booking_appeals 
         SET status = 'approved', handler_id = ?, handler_role = ?, 
             handle_note = ?, handled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [
          req.user.id, req.user.role,
          handle_note || '申诉通过，已修正异常状态和信用影响',
          id
        ]
      );

      const logParts = ['审批通过'];
      if (handleResult.booking_updated) {
        logParts.push(`预约状态：${handleResult.old_status} → ${handleResult.new_status}`);
      }
      if (handleResult.credit_reverted && handleResult.credit_change) {
        logParts.push(`信用分恢复：${handleResult.credit_change.score_before} → ${handleResult.credit_change.score_after}（+${handleResult.credit_change.score_change}分）`);
      }
      if (handle_note) {
        logParts.push(`备注：${handle_note}`);
      }

      await addAppealLog(
        db, id, appeal.booking_id, appeal.user_id,
        'approve', logParts.join('；'),
        req.user.id, req.user.role
      );

      await db.run('COMMIT');

      const updatedAppeal = await db.get(
        `SELECT a.*, rm.name as room_name, u.name as user_name, u.phone as user_phone,
                hd.name as handler_name 
         FROM booking_appeals a 
         LEFT JOIN bookings b ON a.booking_id = b.id 
         LEFT JOIN rooms rm ON b.room_id = rm.id 
         LEFT JOIN users u ON a.user_id = u.id 
         LEFT JOIN users hd ON a.handler_id = hd.id 
         WHERE a.id = ?`,
        [id]
      );

      const updatedBooking = await db.get(
        `SELECT b.*, rm.name as room_name, u.name as user_name, u.phone as user_phone 
         FROM bookings b 
         LEFT JOIN rooms rm ON b.room_id = rm.id 
         LEFT JOIN users u ON b.user_id = u.id 
         WHERE b.id = ?`,
        [appeal.booking_id]
      );

      const updatedCredit = await getUserCredit(db, appeal.user_id);
      updatedCredit.level_label = getLevelLabel(updatedCredit.level);

      res.json({
        message: '申诉审批通过',
        appeal: updatedAppeal,
        booking: updatedBooking,
        user_credit: updatedCredit,
        handle_result: handleResult
      });
    } catch (err) {
      await db.run('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('审批申诉通过错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/appeals/management/:id/reject', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { handle_note } = req.body;

    if (!handle_note || !handle_note.trim()) {
      return res.status(400).json({ error: '驳回原因不能为空' });
    }

    const db = await getDb();

    const appeal = await db.get('SELECT * FROM booking_appeals WHERE id = ?', [id]);
    if (!appeal) {
      return res.status(404).json({ error: '申诉不存在' });
    }

    if (appeal.status !== 'pending' && appeal.status !== 'processing') {
      return res.status(400).json({ error: '该申诉已处理，无法重复审批' });
    }

    await db.run(
      `UPDATE booking_appeals 
       SET status = 'rejected', handler_id = ?, handler_role = ?, 
           handle_note = ?, handled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [req.user.id, req.user.role, handle_note.trim(), id]
    );

    await addAppealLog(
      db, id, appeal.booking_id, appeal.user_id,
      'reject', `审批驳回，原因：${handle_note.trim()}`,
      req.user.id, req.user.role
    );

    const updatedAppeal = await db.get(
      `SELECT a.*, rm.name as room_name, u.name as user_name, u.phone as user_phone,
              hd.name as handler_name 
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON a.user_id = u.id 
       LEFT JOIN users hd ON a.handler_id = hd.id 
       WHERE a.id = ?`,
      [id]
    );

    res.json({ message: '申诉已驳回', appeal: updatedAppeal });
  } catch (err) {
    console.error('驳回申诉错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/appeals/management/:id/note', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { handle_note } = req.body;

    if (!handle_note || !handle_note.trim()) {
      return res.status(400).json({ error: '备注内容不能为空' });
    }

    const db = await getDb();

    const appeal = await db.get('SELECT * FROM booking_appeals WHERE id = ?', [id]);
    if (!appeal) {
      return res.status(404).json({ error: '申诉不存在' });
    }

    if (appeal.status === 'approved' || appeal.status === 'rejected') {
      return res.status(400).json({ error: '已完成审批的申诉无法添加处理备注' });
    }

    if (appeal.status === 'pending') {
      await db.run(
        `UPDATE booking_appeals SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
    }

    await db.run(
      `UPDATE booking_appeals 
       SET handle_note = COALESCE(handle_note || CHAR(10) || ?, ?), 
           handler_id = ?, handler_role = ?, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [
        handle_note.trim(), handle_note.trim(),
        req.user.id, req.user.role, id
      ]
    );

    await addAppealLog(
      db, id, appeal.booking_id, appeal.user_id,
      'add_note', `处理备注：${handle_note.trim()}`,
      req.user.id, req.user.role
    );

    const updatedAppeal = await db.get(
      `SELECT a.*, rm.name as room_name, u.name as user_name, u.phone as user_phone,
              hd.name as handler_name 
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       LEFT JOIN users u ON a.user_id = u.id 
       LEFT JOIN users hd ON a.handler_id = hd.id 
       WHERE a.id = ?`,
      [id]
    );

    res.json({ message: '备注已添加', appeal: updatedAppeal });
  } catch (err) {
    console.error('添加申诉备注错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/appeals/stats', requireRole('attendant', 'admin'), async (req, res) => {
  try {
    const { start_date, end_date, room_id, user_id, appeal_type } = req.query;
    const db = await getDb();

    const whereClauses = ['1=1'];
    const params = [];

    if (start_date) {
      whereClauses.push('DATE(a.created_at) >= ?');
      params.push(start_date);
    }
    if (end_date) {
      whereClauses.push('DATE(a.created_at) <= ?');
      params.push(end_date);
    }
    if (room_id) {
      whereClauses.push('b.room_id = ?');
      params.push(room_id);
    }
    if (user_id) {
      whereClauses.push('a.user_id = ?');
      params.push(user_id);
    }
    if (appeal_type) {
      whereClauses.push('a.appeal_type = ?');
      params.push(appeal_type);
    }

    const baseWhere = whereClauses.join(' AND ');
    const noRoomWhere = whereClauses
      .filter(c => !c.includes('b.room_id'))
      .join(' AND ');
    const simpleWhere = whereClauses
      .filter(c => !c.includes('b.room_id'))
      .join(' AND ')
      .replace(/a\./g, '');

    const totalAppeals = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE ${baseWhere}`,
      params
    );
    const pendingCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE a.status = 'pending' AND ${baseWhere.replace('1=1 AND ', '')}`,
      params
    );
    const processingCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE a.status = 'processing' AND ${baseWhere.replace('1=1 AND ', '')}`,
      params
    );
    const approvedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE a.status = 'approved' AND ${baseWhere.replace('1=1 AND ', '')}`,
      params
    );
    const rejectedCount = await db.get(
      `SELECT COUNT(*) as count FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE a.status = 'rejected' AND ${baseWhere.replace('1=1 AND ', '')}`,
      params
    );

    const handledTotal = approvedCount.count + rejectedCount.count;

    const typeStatsParams = params.filter((_, i) => {
      const clausesWithRoom = whereClauses.filter(c => c.includes('b.room_id'));
      return !clausesWithRoom.length || true;
    });

    const typeStats = await db.all(
      `SELECT a.appeal_type, 
              COUNT(*) as total_count,
              SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) as pending_count,
              SUM(CASE WHEN a.status = 'processing' THEN 1 ELSE 0 END) as processing_count,
              SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved_count,
              SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE ${baseWhere}
       GROUP BY a.appeal_type 
       ORDER BY total_count DESC`,
      params
    );

    const typeLabelMap = {};
    APPEAL_TYPES.forEach(t => { typeLabelMap[t.type] = t.label; });
    typeStats.forEach(t => {
      t.appeal_type_label = typeLabelMap[t.appeal_type] || t.appeal_type;
      t.approval_rate = (t.approved_count + t.rejected_count) > 0
        ? ((t.approved_count / (t.approved_count + t.rejected_count)) * 100).toFixed(2) + '%'
        : '0%';
    });

    const roomStats = await db.all(
      `SELECT b.room_id, rm.name as room_name, 
              COUNT(*) as total_count,
              SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved_count,
              SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       LEFT JOIN rooms rm ON b.room_id = rm.id 
       WHERE ${baseWhere}
       GROUP BY b.room_id, rm.name 
       ORDER BY total_count DESC`,
      params
    );

    const userParams = params.filter(p => true);
    const userWhere = whereClauses.filter(c => !c.includes('b.room_id')).join(' AND ');

    const userTopStats = await db.all(
      `SELECT a.user_id, u.name as user_name, u.username, u.phone,
              COUNT(*) as total_appeals,
              SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved_count,
              SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM booking_appeals a 
       LEFT JOIN users u ON a.user_id = u.id 
       WHERE ${userWhere}
       GROUP BY a.user_id, u.name, u.username, u.phone 
       ORDER BY total_appeals DESC 
       LIMIT 10`,
      userParams
    );
    userTopStats.forEach(u => {
      u.approval_rate = (u.approved_count + u.rejected_count) > 0
        ? ((u.approved_count / (u.approved_count + u.rejected_count)) * 100).toFixed(2) + '%'
        : '0%';
    });

    const handlerParams = params.filter(p => true);
    const handlerWhere = whereClauses
      .filter(c => !c.includes('b.room_id'))
      .join(' AND ')
      .replace('1=1 AND ', '');

    const handlerStats = await db.all(
      `SELECT a.handler_id, u.name as handler_name, u.username,
              COUNT(*) as handled_count,
              SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved_count,
              SUM(CASE WHEN a.status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
       FROM booking_appeals a 
       LEFT JOIN users u ON a.handler_id = u.id 
       WHERE a.handler_id IS NOT NULL ${handlerWhere ? ' AND ' + handlerWhere.replace(/a\./g, '') : ''}
       GROUP BY a.handler_id, u.name, u.username 
       ORDER BY handled_count DESC`,
      handlerParams
    );

    const bookingStatusChanges = await db.get(
      `SELECT 
        SUM(CASE WHEN a.appeal_type = 'no_show' AND a.status = 'approved' THEN 1 ELSE 0 END) as no_show_reverted,
        SUM(CASE WHEN a.appeal_type = 'cancel_late' AND a.status = 'approved' THEN 1 ELSE 0 END) as late_cancel_reverted,
        SUM(CASE WHEN a.appeal_type = 'credit_deduction' AND a.status = 'approved' THEN 1 ELSE 0 END) as credit_reverted
       FROM booking_appeals a 
       LEFT JOIN bookings b ON a.booking_id = b.id 
       WHERE ${baseWhere}`,
      params
    );

    res.json({
      overview: {
        total_appeals: totalAppeals.count,
        pending: pendingCount.count,
        processing: processingCount.count,
        approved: approvedCount.count,
        rejected: rejectedCount.count,
        handled_total: handledTotal,
        approval_rate: handledTotal > 0
          ? ((approvedCount.count / handledTotal) * 100).toFixed(2) + '%'
          : '0%',
        reject_rate: handledTotal > 0
          ? ((rejectedCount.count / handledTotal) * 100).toFixed(2) + '%'
          : '0%'
      },
      booking_status_changes: bookingStatusChanges,
      type_stats: typeStats,
      room_stats: roomStats,
      user_top: userTopStats,
      handler_stats: handlerStats,
      period: { start_date: start_date || null, end_date: end_date || null }
    });
  } catch (err) {
    console.error('获取申诉统计错误:', err);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

router.get('/bookings/:bookingId/appeals', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const db = await getDb();

    const booking = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name, u.phone as user_phone 
       FROM bookings b 
       LEFT JOIN rooms r ON b.room_id = r.id 
       LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [bookingId]
    );
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }

    if (booking.user_id !== req.user.id && 
        req.user.role !== 'admin' && 
        req.user.role !== 'attendant') {
      return res.status(403).json({ error: '无权查看该预约的申诉记录' });
    }

    const appeals = await db.all(
      `SELECT a.*, hd.name as handler_name 
       FROM booking_appeals a 
       LEFT JOIN users hd ON a.handler_id = hd.id 
       WHERE a.booking_id = ? 
       ORDER BY a.created_at DESC`,
      [bookingId]
    );

    const typeLabelMap = {};
    APPEAL_TYPES.forEach(t => { typeLabelMap[t.type] = t.label; });
    const statusLabelMap = {};
    APPEAL_STATUSES.forEach(s => { statusLabelMap[s.status] = s.label; });

    appeals.forEach(a => {
      a.appeal_type_label = typeLabelMap[a.appeal_type] || a.appeal_type;
      a.status_label = statusLabelMap[a.status] || a.status;
    });

    const logs = await db.all(
      `SELECT l.*, u.name as operator_name 
       FROM booking_appeal_logs l 
       LEFT JOIN users u ON l.operator_id = u.id 
       WHERE l.booking_id = ? 
       ORDER BY l.created_at ASC`,
      [bookingId]
    );

    res.json({ booking, appeals, logs });
  } catch (err) {
    console.error('获取预约申诉记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
