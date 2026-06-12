const express = require('express');
const { getDb } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { getLevelLabel, CREDIT_CONFIG } = require('../utils/creditManager');

const router = express.Router();

router.use(authMiddleware);

router.get('/bookings', async (req, res) => {
  try {
    const {
      room_id,
      user_id,
      status,
      date,
      start_date,
      end_date,
      is_overdue,
      page = 1,
      page_size = 50
    } = req.query;

    const db = await getDb();
    let sql = `SELECT b.*, r.name as room_name, u.name as user_name, u.phone as user_phone 
               FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
               WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total FROM bookings b WHERE 1=1`;
    const params = [];
    const countParams = [];

    if (room_id) {
      sql += ' AND b.room_id = ?'; params.push(room_id);
      countSql += ' AND b.room_id = ?'; countParams.push(room_id);
    }
    if (user_id) {
      sql += ' AND b.user_id = ?'; params.push(user_id);
      countSql += ' AND b.user_id = ?'; countParams.push(user_id);
    }
    if (status) {
      const statuses = Array.isArray(status) ? status : status.split(',');
      const placeholders = statuses.map(() => '?').join(',');
      sql += ` AND b.status IN (${placeholders})`; params.push(...statuses);
      countSql += ` AND b.status IN (${placeholders})`; countParams.push(...statuses);
    }
    if (date) {
      sql += ' AND b.date = ?'; params.push(date);
      countSql += ' AND b.date = ?'; countParams.push(date);
    }
    if (start_date) {
      sql += ' AND b.date >= ?'; params.push(start_date);
      countSql += ' AND b.date >= ?'; countParams.push(start_date);
    }
    if (end_date) {
      sql += ' AND b.date <= ?'; params.push(end_date);
      countSql += ' AND b.date <= ?'; countParams.push(end_date);
    }

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nowTimeStr = now.toTimeString().slice(0, 5);

    if (is_overdue === '1' || is_overdue === 'true') {
      sql += ` AND b.status = 'booked' AND (b.date < ? OR (b.date = ? AND b.end_time < ?))`;
      params.push(todayStr, todayStr, nowTimeStr);
      countSql += ` AND b.status = 'booked' AND (b.date < ? OR (b.date = ? AND b.end_time < ?))`;
      countParams.push(todayStr, todayStr, nowTimeStr);
    } else if (is_overdue === '0' || is_overdue === 'false') {
      sql += ` AND NOT (b.status = 'booked' AND (b.date < ? OR (b.date = ? AND b.end_time < ?)))`;
      params.push(todayStr, todayStr, nowTimeStr);
      countSql += ` AND NOT (b.status = 'booked' AND (b.date < ? OR (b.date = ? AND b.end_time < ?)))`;
      countParams.push(todayStr, todayStr, nowTimeStr);
    }

    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;

    sql += ' ORDER BY b.date DESC, b.start_time DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 200);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);

    const bookings = await db.all(sql, params);

    for (const b of bookings) {
      if (b.status === 'booked') {
        const bookingDateTime = new Date(`${b.date}T${b.end_time}:00`);
        b.is_overdue = bookingDateTime < now;
      } else {
        b.is_overdue = false;
      }
    }

    res.json({
      bookings,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('查询预约错误:', err.message);
    console.error('错误堆栈:', err.stack);
    res.status(500).json({ error: '服务器内部错误', detail: err.message });
  }
});

router.get('/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const booking = await db.get(
      `SELECT b.*, r.name as room_name, u.name as user_name, u.phone as user_phone 
       FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.id = ?`,
      [id]
    );
    if (!booking) {
      return res.status(404).json({ error: '预约不存在' });
    }
    res.json({ booking });
  } catch (err) {
    console.error('获取预约详情错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/stats/overview', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const db = await getDb();

    let dateFilter = '';
    const params = [];
    if (start_date) { dateFilter += ' AND date >= ?'; params.push(start_date); }
    if (end_date) { dateFilter += ' AND date <= ?'; params.push(end_date); }

    const totalBookings = await db.get(`SELECT COUNT(*) as count FROM bookings WHERE 1=1 ${dateFilter}`, params);
    const arrivedBookings = await db.get(`SELECT COUNT(*) as count FROM bookings WHERE status = 'arrived' ${dateFilter}`, params);
    const noShowBookings = await db.get(`SELECT COUNT(*) as count FROM bookings WHERE status = 'no_show' ${dateFilter}`, params);
    const cancelledBookings = await db.get(`SELECT COUNT(*) as count FROM bookings WHERE status = 'cancelled' ${dateFilter}`, params);
    const bookedCount = await db.get(`SELECT COUNT(*) as count FROM bookings WHERE status = 'booked' ${dateFilter}`, params);

    const locksReleased = await db.get(`SELECT COUNT(*) as count FROM lock_release_logs WHERE 1=1 ${dateFilter.replace(/b\./g, '').replace(/date/g, 'DATE(released_at)')}`, params);
    const locksExpired = await db.get(`SELECT COUNT(*) as count FROM lock_release_logs WHERE release_reason LIKE '%过期%' ${dateFilter.replace(/b\./g, '').replace(/date/g, 'DATE(released_at)')}`, params);

    const roomCount = await db.get(`SELECT COUNT(*) as count FROM rooms WHERE status = 'active'`);

    res.json({
      overview: {
        total_bookings: totalBookings.count,
        arrived: arrivedBookings.count,
        no_show: noShowBookings.count,
        cancelled: cancelledBookings.count,
        pending: bookedCount.count,
        arrival_rate: totalBookings.count > 0 ? ((arrivedBookings.count / (totalBookings.count - cancelledBookings.count)) * 100).toFixed(2) + '%' : '0%',
        no_show_rate: totalBookings.count > 0 ? ((noShowBookings.count / (totalBookings.count - cancelledBookings.count)) * 100).toFixed(2) + '%' : '0%',
        active_rooms: roomCount.count,
        locks_released_total: locksReleased.count,
        locks_expired_count: locksExpired.count
      },
      period: { start_date: start_date || null, end_date: end_date || null }
    });
  } catch (err) {
    console.error('获取概览统计错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/stats/room-utilization', async (req, res) => {
  try {
    const { start_date, end_date, room_id } = req.query;
    const db = await getDb();

    if (!start_date || !end_date) {
      return res.status(400).json({ error: '请指定开始和结束日期' });
    }

    const rooms = room_id
      ? await db.all('SELECT * FROM rooms WHERE id = ?', [room_id])
      : await db.all('SELECT * FROM rooms WHERE status = ?', ['active']);

    const result = [];
    for (const room of rooms) {
      const slotTemplates = await db.all(
        'SELECT COUNT(*) as count FROM time_slot_templates WHERE room_id = ? AND is_active = 1',
        [room.id]
      );
      const slotsPerDay = slotTemplates[0].count;

      const start = new Date(start_date);
      const end = new Date(end_date);
      let totalDays = 0;
      const closedDates = await db.all(
        'SELECT date FROM open_dates WHERE room_id = ? AND date >= ? AND date <= ? AND is_open = 0',
        [room.id, start_date, end_date]
      );
      const closedSet = new Set(closedDates.map(d => d.date));
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        if (!closedSet.has(d.toISOString().split('T')[0])) {
          totalDays++;
        }
      }

      const totalSlots = totalDays * slotsPerDay;

      const usedSlots = await db.get(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE room_id = ? AND status IN ('booked', 'arrived') 
         AND date >= ? AND date <= ?`,
        [room.id, start_date, end_date]
      );

      const arrivedSlots = await db.get(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE room_id = ? AND status = 'arrived' 
         AND date >= ? AND date <= ?`,
        [room.id, start_date, end_date]
      );

      result.push({
        room_id: room.id,
        room_name: room.name,
        capacity: room.capacity,
        period_days: totalDays,
        slots_per_day: slotsPerDay,
        total_available_slots: totalSlots,
        used_slots: usedSlots.count,
        arrived_slots: arrivedSlots.count,
        utilization_rate: totalSlots > 0 ? ((usedSlots.count / totalSlots) * 100).toFixed(2) + '%' : '0%',
        actual_use_rate: totalSlots > 0 ? ((arrivedSlots.count / totalSlots) * 100).toFixed(2) + '%' : '0%'
      });
    }

    result.sort((a, b) => parseFloat(b.utilization_rate) - parseFloat(a.utilization_rate));
    res.json({ room_utilization: result });
  } catch (err) {
    console.error('获取房间利用率错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/stats/no-show-ranking', async (req, res) => {
  try {
    const { start_date, end_date, limit = 20 } = req.query;
    const db = await getDb();

    let dateFilter = '';
    const params = [];
    if (start_date) { dateFilter += ' AND b.date >= ?'; params.push(start_date); }
    if (end_date) { dateFilter += ' AND b.date <= ?'; params.push(end_date); }
    params.push(parseInt(limit));

    const ranking = await db.all(
      `SELECT u.id as user_id, u.name as user_name, u.username, u.phone,
              COUNT(*) as total_bookings,
              SUM(CASE WHEN b.status = 'arrived' THEN 1 ELSE 0 END) as arrived_count,
              SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
              SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
       FROM bookings b LEFT JOIN users u ON b.user_id = u.id 
       WHERE b.status != 'cancelled' ${dateFilter}
       GROUP BY u.id, u.name, u.username, u.phone
       HAVING no_show_count > 0
       ORDER BY no_show_count DESC, total_bookings DESC
       LIMIT ?`,
      params
    );

    for (const r of ranking) {
      const effective = r.total_bookings - r.cancelled_count;
      r.no_show_rate = effective > 0 ? ((r.no_show_count / effective) * 100).toFixed(2) + '%' : '0%';
    }

    res.json({ no_show_ranking: ranking });
  } catch (err) {
    console.error('获取未到场排行错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/stats/lock-releases', async (req, res) => {
  try {
    const { start_date, end_date, release_reason } = req.query;
    const db = await getDb();

    let sql = `SELECT lrl.*, r.name as room_name, u.name as user_name 
               FROM lock_release_logs lrl 
               LEFT JOIN rooms r ON lrl.room_id = r.id LEFT JOIN users u ON lrl.user_id = u.id 
               WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total, 
                      SUM(CASE WHEN release_reason LIKE '%过期%' THEN 1 ELSE 0 END) as expired_count,
                      SUM(CASE WHEN release_reason LIKE '%主动%' THEN 1 ELSE 0 END) as manual_count,
                      SUM(CASE WHEN release_reason LIKE '%转换%' THEN 1 ELSE 0 END) as converted_count
                      FROM lock_release_logs WHERE 1=1`;
    const params = [];
    const countParams = [];

    if (start_date) {
      sql += ' AND DATE(lrl.released_at) >= ?'; params.push(start_date);
      countSql += ' AND DATE(released_at) >= ?'; countParams.push(start_date);
    }
    if (end_date) {
      sql += ' AND DATE(lrl.released_at) <= ?'; params.push(end_date);
      countSql += ' AND DATE(released_at) <= ?'; countParams.push(end_date);
    }
    if (release_reason) {
      sql += ' AND lrl.release_reason LIKE ?'; params.push('%' + release_reason + '%');
      countSql += ' AND release_reason LIKE ?'; countParams.push('%' + release_reason + '%');
    }

    const stats = await db.get(countSql, countParams);
    sql += ' ORDER BY lrl.released_at DESC LIMIT 200';
    const logs = await db.all(sql, params);

    res.json({
      lock_release_stats: {
        total_releases: stats.total,
        expired_releases: stats.expired_count || 0,
        manual_releases: stats.manual_count || 0,
        converted_releases: stats.converted_count || 0
      },
      lock_release_logs: logs
    });
  } catch (err) {
    console.error('获取锁释放统计错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/locks', async (req, res) => {
  try {
    const { include_expired = '0' } = req.query;
    const db = await getDb();
    let sql = `SELECT tl.*, r.name as room_name, u.name as user_name 
               FROM temp_locks tl LEFT JOIN rooms r ON tl.room_id = r.id LEFT JOIN users u ON tl.user_id = u.id`;
    const params = [];
    if (include_expired === '0') {
      sql += ' WHERE tl.is_released = 0 AND tl.expires_at > CURRENT_TIMESTAMP';
    }
    sql += ' ORDER BY tl.created_at DESC';
    const locks = await db.all(sql, params);
    res.json({ temp_locks: locks });
  } catch (err) {
    console.error('获取临时锁错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/credit/overview', async (req, res) => {
  try {
    const db = await getDb();
    
    const totalUsers = await db.get('SELECT COUNT(*) as count FROM user_credit');
    const levelStats = await db.all(
      'SELECT level, COUNT(*) as count FROM user_credit GROUP BY level ORDER BY level'
    );
    const restrictedCount = await db.get(
      'SELECT COUNT(*) as count FROM user_credit WHERE is_restricted = 1'
    );
    
    const avgScore = await db.get('SELECT AVG(score) as avg FROM user_credit');
    
    const recentRecords = await db.all(
      `SELECT cr.*, u.name as user_name, op.name as operator_name 
       FROM credit_records cr 
       LEFT JOIN users u ON cr.user_id = u.id 
       LEFT JOIN users op ON cr.operator_id = op.id 
       ORDER BY cr.created_at DESC 
       LIMIT 20`
    );
    
    const levelDistribution = CREDIT_CONFIG.levels.map(level => {
      const stat = levelStats.find(s => s.level === level.level);
      return {
        level: level.level,
        label: level.label,
        count: stat ? stat.count : 0,
        min_score: level.minScore,
        max_score: level.maxScore
      };
    });
    
    res.json({
      overview: {
        total_users: totalUsers.count,
        avg_score: avgScore.avg ? parseFloat(avgScore.avg).toFixed(1) : 0,
        restricted_count: restrictedCount.count,
        level_distribution: levelDistribution
      },
      recent_records: recentRecords
    });
  } catch (err) {
    console.error('获取信用概况统计错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/credit/user-ranking', async (req, res) => {
  try {
    const { sort_by = 'score', order = 'desc', limit = 20, level } = req.query;
    const db = await getDb();
    
    let sql = `SELECT uc.*, u.username, u.name, u.phone 
               FROM user_credit uc 
               LEFT JOIN users u ON uc.user_id = u.id 
               WHERE 1=1`;
    const params = [];
    
    if (level) {
      const levels = Array.isArray(level) ? level : level.split(',');
      const placeholders = levels.map(() => '?').join(',');
      sql += ` AND uc.level IN (${placeholders})`;
      params.push(...levels);
    }
    
    const validSortFields = ['score', 'total_bookings', 'arrived_count', 'no_show_count', 'cancelled_count'];
    const sortField = validSortFields.includes(sort_by) ? sort_by : 'score';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY uc.${sortField} ${sortOrder}`;
    
    sql += ' LIMIT ?';
    params.push(Math.min(parseInt(limit), 100));
    
    const ranking = await db.all(sql, params);
    
    for (const user of ranking) {
      user.level_label = getLevelLabel(user.level);
      const effective = user.total_bookings - user.cancelled_count;
      user.arrival_rate = effective > 0 
        ? ((user.arrived_count / effective) * 100).toFixed(2) + '%' 
        : '0%';
      user.no_show_rate = effective > 0 
        ? ((user.no_show_count / effective) * 100).toFixed(2) + '%' 
        : '0%';
    }
    
    res.json({ ranking });
  } catch (err) {
    console.error('获取用户信用排行错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/credit/records', async (req, res) => {
  try {
    const {
      user_id,
      change_type,
      start_date,
      end_date,
      page = 1,
      page_size = 20
    } = req.query;
    
    const db = await getDb();
    
    let sql = `SELECT cr.*, u.name as user_name, u.username, u.phone,
                      op.name as operator_name 
               FROM credit_records cr 
               LEFT JOIN users u ON cr.user_id = u.id 
               LEFT JOIN users op ON cr.operator_id = op.id 
               WHERE 1=1`;
    let countSql = 'SELECT COUNT(*) as total FROM credit_records WHERE 1=1';
    const params = [];
    const countParams = [];
    
    if (user_id) {
      sql += ' AND cr.user_id = ?';
      countSql += ' AND user_id = ?';
      params.push(user_id);
      countParams.push(user_id);
    }
    
    if (change_type) {
      const types = Array.isArray(change_type) ? change_type : change_type.split(',');
      const placeholders = types.map(() => '?').join(',');
      sql += ` AND cr.change_type IN (${placeholders})`;
      countSql += ` AND change_type IN (${placeholders})`;
      params.push(...types);
      countParams.push(...types);
    }
    
    if (start_date) {
      sql += ' AND DATE(cr.created_at) >= ?';
      countSql += ' AND DATE(created_at) >= ?';
      params.push(start_date);
      countParams.push(start_date);
    }
    
    if (end_date) {
      sql += ' AND DATE(cr.created_at) <= ?';
      countSql += ' AND DATE(created_at) <= ?';
      params.push(end_date);
      countParams.push(end_date);
    }
    
    const countResult = await db.get(countSql, countParams);
    const total = countResult.total;
    
    sql += ' ORDER BY cr.created_at DESC LIMIT ? OFFSET ?';
    const limit = Math.min(parseInt(page_size), 200);
    const offset = (parseInt(page) - 1) * limit;
    params.push(limit, offset);
    
    const records = await db.all(sql, params);
    
    const typeStats = await db.all(
      `SELECT change_type, COUNT(*) as count, SUM(score_change) as total_change 
       FROM credit_records 
       WHERE 1=1${user_id ? ' AND user_id = ?' : ''} 
       GROUP BY change_type`,
      user_id ? [user_id] : []
    );
    
    res.json({
      records,
      pagination: {
        page: parseInt(page),
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      },
      type_stats: typeStats
    });
  } catch (err) {
    console.error('查询信用记录错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

router.get('/credit/user-summary/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { start_date, end_date } = req.query;
    const db = await getDb();
    
    const user = await db.get('SELECT id, username, name, phone, role FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    let dateFilter = '';
    const params = [userId];
    if (start_date) { dateFilter += ' AND date >= ?'; params.push(start_date); }
    if (end_date) { dateFilter += ' AND date <= ?'; params.push(end_date); }
    
    const bookingStats = await db.get(
      `SELECT 
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'arrived' THEN 1 ELSE 0 END) as arrived_count,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked_count
       FROM bookings WHERE user_id = ?${dateFilter}`,
      params
    );
    
    const credit = await db.get('SELECT * FROM user_credit WHERE user_id = ?', [userId]);
    if (credit) {
      credit.level_label = getLevelLabel(credit.level);
    }
    
    const creditRecordStats = await db.get(
      `SELECT 
        COUNT(*) as total_records,
        SUM(CASE WHEN score_change > 0 THEN 1 ELSE 0 END) as bonus_count,
        SUM(CASE WHEN score_change < 0 THEN 1 ELSE 0 END) as penalty_count,
        SUM(score_change) as total_score_change
       FROM credit_records WHERE user_id = ?`,
      [userId]
    );
    
    const recentRecords = await db.all(
      `SELECT cr.*, op.name as operator_name 
       FROM credit_records cr 
       LEFT JOIN users op ON cr.operator_id = op.id 
       WHERE cr.user_id = ? 
       ORDER BY cr.created_at DESC 
       LIMIT 10`,
      [userId]
    );
    
    const effectiveBookings = (bookingStats.total_bookings || 0) - (bookingStats.cancelled_count || 0);
    
    res.json({
      user,
      credit: credit || null,
      booking_stats: {
        ...bookingStats,
        effective_bookings: effectiveBookings,
        arrival_rate: effectiveBookings > 0 
          ? ((bookingStats.arrived_count / effectiveBookings) * 100).toFixed(2) + '%' 
          : '0%',
        no_show_rate: effectiveBookings > 0 
          ? ((bookingStats.no_show_count / effectiveBookings) * 100).toFixed(2) + '%' 
          : '0%'
      },
      credit_record_stats: creditRecordStats || {
        total_records: 0,
        bonus_count: 0,
        penalty_count: 0,
        total_score_change: 0
      },
      recent_records: recentRecords,
      period: { start_date: start_date || null, end_date: end_date || null }
    });
  } catch (err) {
    console.error('获取用户信用汇总错误:', err);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

module.exports = router;
