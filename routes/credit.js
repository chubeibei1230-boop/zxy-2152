const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const {
  CREDIT_CONFIG,
  getLevelLabel,
  getUserCredit,
  getLevelByScore,
  checkBookingPermission,
  manualAdjust,
  setRestriction
} = require('../utils/creditManager');

const router = express.Router();

router.use(authMiddleware);

router.get('/my-credit', async (req, res) => {
  try {
    const db = await getDb();
    const credit = await getUserCredit(db, req.user.id);
    const levelLabel = getLevelLabel(credit.level);
    
    const permission = await checkBookingPermission(db, req.user.id);
    
    const recentRecords = await db.all(
      `SELECT cr.*, u.name as operator_name 
       FROM credit_records cr 
       LEFT JOIN users u ON cr.operator_id = u.id 
       WHERE cr.user_id = ? 
       ORDER BY cr.created_at DESC 
       LIMIT 10`,
      [req.user.id]
    );
    
    res.json({
      credit: {
        ...credit,
        level_label: levelLabel,
        can_book: permission.allowed,
        warning: permission.warning,
        restrict_message: !permission.allowed ? permission.reason : null
      },
      recent_records: recentRecords,
      config: {
        initial_score: CREDIT_CONFIG.initialScore,
        arrive_bonus: CREDIT_CONFIG.arriveBonus,
        no_show_penalty: CREDIT_CONFIG.noShowPenalty,
        late_cancel_penalty: CREDIT_CONFIG.lateCancelPenalty,
        late_cancel_hours: CREDIT_CONFIG.lateCancelHours,
        levels: CREDIT_CONFIG.levels.map(l => ({
          level: l.level,
          label: l.label,
          min_score: l.minScore,
          max_score: l.maxScore
        }))
      }
    });
  } catch (err) {
    console.error('获取我的信用错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/my-credit/records', async (req, res) => {
  try {
    const { page = 1, page_size = 20, change_type } = req.query;
    const db = await getDb();
    
    let sql = `SELECT cr.*, u.name as operator_name 
               FROM credit_records cr 
               LEFT JOIN users u ON cr.operator_id = u.id 
               WHERE cr.user_id = ?`;
    let countSql = `SELECT COUNT(*) as total FROM credit_records WHERE user_id = ?`;
    const params = [req.user.id];
    const countParams = [req.user.id];
    
    if (change_type) {
      const types = Array.isArray(change_type) ? change_type : change_type.split(',');
      const placeholders = types.map(() => '?').join(',');
      sql += ` AND cr.change_type IN (${placeholders})`;
      countSql += ` AND change_type IN (${placeholders})`;
      params.push(...types);
      countParams.push(...types);
    }
    
    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;
    
    sql += ' ORDER BY cr.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 100);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);
    
    const records = await db.all(sql, params);
    
    res.json({
      records,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取信用记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/users', requireRole('admin', 'attendant'), async (req, res) => {
  try {
    const { keyword, level, is_restricted, page = 1, page_size = 20 } = req.query;
    const db = await getDb();
    
    let sql = `SELECT uc.*, u.username, u.name, u.phone, u.role 
               FROM user_credit uc 
               LEFT JOIN users u ON uc.user_id = u.id 
               WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total FROM user_credit uc LEFT JOIN users u ON uc.user_id = u.id WHERE 1=1`;
    const params = [];
    const countParams = [];
    
    if (keyword) {
      sql += ' AND (u.name LIKE ? OR u.username LIKE ? OR u.phone LIKE ?)';
      countSql += ' AND (u.name LIKE ? OR u.username LIKE ? OR u.phone LIKE ?)';
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
      countParams.push(kw, kw, kw);
    }
    
    if (level) {
      const levels = Array.isArray(level) ? level : level.split(',');
      const placeholders = levels.map(() => '?').join(',');
      sql += ` AND uc.level IN (${placeholders})`;
      countSql += ` AND uc.level IN (${placeholders})`;
      params.push(...levels);
      countParams.push(...levels);
    }
    
    if (is_restricted !== undefined && is_restricted !== '') {
      const restrictedVal = is_restricted === '1' || is_restricted === 'true' ? 1 : 0;
      sql += ' AND uc.is_restricted = ?';
      countSql += ' AND uc.is_restricted = ?';
      params.push(restrictedVal);
      countParams.push(restrictedVal);
    }
    
    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;
    
    sql += ' ORDER BY uc.score DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 100);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);
    
    const users = await db.all(sql, params);
    
    for (const user of users) {
      user.level_label = getLevelLabel(user.level);
    }
    
    res.json({
      users,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取用户信用列表错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/users/:userId', requireRole('admin', 'attendant'), async (req, res) => {
  try {
    const { userId } = req.params;
    const db = await getDb();
    
    const user = await db.get('SELECT id, username, name, phone, role, created_at FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const credit = await getUserCredit(db, userId);
    const levelLabel = getLevelLabel(credit.level);
    
    const recentRecords = await db.all(
      `SELECT cr.*, u.name as operator_name 
       FROM credit_records cr 
       LEFT JOIN users u ON cr.operator_id = u.id 
       WHERE cr.user_id = ? 
       ORDER BY cr.created_at DESC 
       LIMIT 20`,
      [userId]
    );
    
    const stats = await db.get(
      `SELECT 
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'arrived' THEN 1 ELSE 0 END) as arrived_count,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked_count
       FROM bookings WHERE user_id = ?`,
      [userId]
    );
    
    res.json({
      user,
      credit: {
        ...credit,
        level_label: levelLabel
      },
      stats: stats || {
        total_bookings: 0,
        arrived_count: 0,
        no_show_count: 0,
        cancelled_count: 0,
        booked_count: 0
      },
      recent_records: recentRecords
    });
  } catch (err) {
    console.error('获取用户信用详情错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/users/:userId/records', requireRole('admin', 'attendant'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, page_size = 20, change_type } = req.query;
    const db = await getDb();
    
    const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    let sql = `SELECT cr.*, u.name as operator_name 
               FROM credit_records cr 
               LEFT JOIN users u ON cr.operator_id = u.id 
               WHERE cr.user_id = ?`;
    let countSql = `SELECT COUNT(*) as total FROM credit_records WHERE user_id = ?`;
    const params = [userId];
    const countParams = [userId];
    
    if (change_type) {
      const types = Array.isArray(change_type) ? change_type : change_type.split(',');
      const placeholders = types.map(() => '?').join(',');
      sql += ` AND cr.change_type IN (${placeholders})`;
      countSql += ` AND change_type IN (${placeholders})`;
      params.push(...types);
      countParams.push(...types);
    }
    
    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;
    
    sql += ' ORDER BY cr.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 100);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);
    
    const records = await db.all(sql, params);
    
    res.json({
      records,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('获取用户信用记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/users/:userId/adjust', requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { score_adjustment, reason } = req.body;
    
    if (score_adjustment === undefined || score_adjustment === null) {
      return res.status(400).json({ error: '信用分调整值不能为空' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: '调整原因不能为空' });
    }
    
    const adjustment = parseInt(score_adjustment);
    if (isNaN(adjustment) || adjustment === 0) {
      return res.status(400).json({ error: '请输入有效的调整分值' });
    }
    if (Math.abs(adjustment) > 100) {
      return res.status(400).json({ error: '单次调整幅度不能超过100分' });
    }
    
    const db = await getDb();
    
    const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const result = await manualAdjust(db, userId, adjustment, reason, req.user.id, req.user.role);
    
    const credit = await getUserCredit(db, userId);
    credit.level_label = getLevelLabel(credit.level);
    
    res.json({
      message: '信用调整成功',
      credit_change: result,
      current_credit: credit
    });
  } catch (err) {
    console.error('调整用户信用错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.put('/users/:userId/restriction', requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { is_restricted, reason, restrict_until } = req.body;
    
    if (is_restricted === undefined || is_restricted === null) {
      return res.status(400).json({ error: '请指定是否限制' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: '限制原因不能为空' });
    }
    
    const db = await getDb();
    
    const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const restricted = is_restricted === true || is_restricted === '1' || is_restricted === 'true';
    const result = await setRestriction(db, userId, restricted, reason, req.user.id, req.user.role, restrict_until || null);
    
    const credit = await getUserCredit(db, userId);
    credit.level_label = getLevelLabel(credit.level);
    
    res.json({
      message: restricted ? '已设置信用限制' : '已解除信用限制',
      restriction: result,
      current_credit: credit
    });
  } catch (err) {
    console.error('设置信用限制错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/config', async (req, res) => {
  try {
    res.json({
      config: {
        initial_score: CREDIT_CONFIG.initialScore,
        min_score: CREDIT_CONFIG.minScore,
        max_score: CREDIT_CONFIG.maxScore,
        arrive_bonus: CREDIT_CONFIG.arriveBonus,
        no_show_penalty: CREDIT_CONFIG.noShowPenalty,
        late_cancel_penalty: CREDIT_CONFIG.lateCancelPenalty,
        early_cancel_bonus: CREDIT_CONFIG.earlyCancelBonus,
        late_cancel_hours: CREDIT_CONFIG.lateCancelHours,
        levels: CREDIT_CONFIG.levels.map(l => ({
          level: l.level,
          label: l.label,
          min_score: l.minScore,
          max_score: l.maxScore
        })),
        change_types: [
          { type: 'arrive', label: '正常到场' },
          { type: 'no_show', label: '未到场' },
          { type: 'cancel_late', label: '临时取消' },
          { type: 'cancel_early', label: '提前取消' },
          { type: 'manual_adjust', label: '人工调整' },
          { type: 'reset', label: '重置' },
          { type: 'penalty', label: '处罚' },
          { type: 'reward', label: '奖励' }
        ]
      }
    });
  } catch (err) {
    console.error('获取信用配置错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
