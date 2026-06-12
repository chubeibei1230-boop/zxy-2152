const { getDb } = require('../db');

const CREDIT_CONFIG = {
  initialScore: 100,
  minScore: 0,
  maxScore: 100,
  arriveBonus: 1,
  noShowPenalty: 10,
  lateCancelPenalty: 5,
  earlyCancelBonus: 0,
  lateCancelHours: 24,
  levels: [
    { level: 'excellent', minScore: 90, maxScore: 100, label: '优秀' },
    { level: 'good', minScore: 75, maxScore: 89, label: '良好' },
    { level: 'fair', minScore: 60, maxScore: 74, label: '一般' },
    { level: 'poor', minScore: 40, maxScore: 59, label: '较差' },
    { level: 'restricted', minScore: 0, maxScore: 39, label: '受限' }
  ],
  restrictions: {
    poor: { maxDailyBookings: 2, warning: '信用状态较差，每日限约2次' },
    restricted: { canBook: false, message: '信用状态受限，暂时无法预约，请联系管理员' }
  }
};

function getLevelByScore(score) {
  for (const level of CREDIT_CONFIG.levels) {
    if (score >= level.minScore && score <= level.maxScore) {
      return level.level;
    }
  }
  return 'fair';
}

function getLevelLabel(level) {
  const found = CREDIT_CONFIG.levels.find(l => l.level === level);
  return found ? found.label : level;
}

async function getUserCredit(db, userId) {
  let credit = await db.get('SELECT * FROM user_credit WHERE user_id = ?', [userId]);
  if (!credit) {
    await db.run(
      'INSERT INTO user_credit (user_id, score, level, is_restricted) VALUES (?, ?, ?, 0)',
      [userId, CREDIT_CONFIG.initialScore, getLevelByScore(CREDIT_CONFIG.initialScore)]
    );
    credit = await db.get('SELECT * FROM user_credit WHERE user_id = ?', [userId]);
    
    const stats = await db.get(
      `SELECT 
        COUNT(*) as total_bookings,
        SUM(CASE WHEN status = 'arrived' THEN 1 ELSE 0 END) as arrived_count,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
       FROM bookings WHERE user_id = ?`,
      [userId]
    );
    
    if (stats && stats.total_bookings > 0) {
      let calculatedScore = CREDIT_CONFIG.initialScore;
      calculatedScore += stats.arrived_count * CREDIT_CONFIG.arriveBonus;
      calculatedScore -= stats.no_show_count * CREDIT_CONFIG.noShowPenalty;
      calculatedScore = Math.max(CREDIT_CONFIG.minScore, Math.min(CREDIT_CONFIG.maxScore, calculatedScore));
      
      const newLevel = getLevelByScore(calculatedScore);
      const isRestricted = calculatedScore <= CREDIT_CONFIG.levels.find(l => l.level === 'restricted').maxScore ? 1 : 0;
      
      await db.run(
        `UPDATE user_credit SET score = ?, level = ?, is_restricted = ?, 
         total_bookings = ?, arrived_count = ?, no_show_count = ?, cancelled_count = ?,
         last_updated = CURRENT_TIMESTAMP WHERE user_id = ?`,
        [calculatedScore, newLevel, isRestricted, 
         stats.total_bookings, stats.arrived_count, stats.no_show_count, stats.cancelled_count,
         userId]
      );
      credit = await db.get('SELECT * FROM user_credit WHERE user_id = ?', [userId]);
    }
  }
  return credit;
}

async function updateCreditScore(db, userId, scoreChange, changeType, reason, options = {}) {
  const { bookingId, operatorId, operatorRole } = options;
  
  const credit = await getUserCredit(db, userId);
  const scoreBefore = credit.score;
  const levelBefore = credit.level;
  
  let scoreAfter = scoreBefore + scoreChange;
  scoreAfter = Math.max(CREDIT_CONFIG.minScore, Math.min(CREDIT_CONFIG.maxScore, scoreAfter));
  
  const levelAfter = getLevelByScore(scoreAfter);
  const restrictedLevel = CREDIT_CONFIG.levels.find(l => l.level === 'restricted');
  const isRestricted = scoreAfter <= restrictedLevel.maxScore ? 1 : 0;
  
  await db.run(
    `UPDATE user_credit SET score = ?, level = ?, is_restricted = ?, last_updated = CURRENT_TIMESTAMP 
     WHERE user_id = ?`,
    [scoreAfter, levelAfter, isRestricted, userId]
  );
  
  await db.run(
    `INSERT INTO credit_records 
     (user_id, booking_id, change_type, score_change, score_before, score_after, 
      level_before, level_after, reason, operator_id, operator_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, bookingId || null, changeType, scoreChange, scoreBefore, scoreAfter,
     levelBefore, levelAfter, reason, operatorId || null, operatorRole || null]
  );
  
  return {
    score_before: scoreBefore,
    score_after: scoreAfter,
    level_before: levelBefore,
    level_after: levelAfter,
    score_change: scoreChange,
    is_restricted: isRestricted === 1
  };
}

async function updateCreditStats(db, userId) {
  const stats = await db.get(
    `SELECT 
      COUNT(*) as total_bookings,
      SUM(CASE WHEN status = 'arrived' THEN 1 ELSE 0 END) as arrived_count,
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_show_count,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
     FROM bookings WHERE user_id = ?`,
    [userId]
  );
  
  if (stats) {
    await db.run(
      `UPDATE user_credit SET total_bookings = ?, arrived_count = ?, no_show_count = ?, cancelled_count = ?,
       last_updated = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [stats.total_bookings, stats.arrived_count, stats.no_show_count, stats.cancelled_count, userId]
    );
  }
  
  return stats;
}

async function handleArrive(db, bookingId, userId, operatorId, operatorRole) {
  const result = await updateCreditScore(db, userId, CREDIT_CONFIG.arriveBonus, 'arrive', '正常到场', {
    bookingId,
    operatorId,
    operatorRole
  });
  await updateCreditStats(db, userId);
  return result;
}

async function handleNoShow(db, bookingId, userId, operatorId, operatorRole, note = '') {
  const reason = note ? `未到场：${note}` : '未到场';
  const result = await updateCreditScore(db, userId, -CREDIT_CONFIG.noShowPenalty, 'no_show', reason, {
    bookingId,
    operatorId,
    operatorRole
  });
  await updateCreditStats(db, userId);
  return result;
}

async function handleCancel(db, bookingId, userId, bookingDate, startTime, cancelReason, operatorId, operatorRole) {
  const bookingDateTime = new Date(`${bookingDate}T${startTime}:00`);
  const now = new Date();
  const hoursDiff = (bookingDateTime - now) / (1000 * 60 * 60);
  
  let changeType, scoreChange, reason;
  
  if (hoursDiff < CREDIT_CONFIG.lateCancelHours) {
    changeType = 'cancel_late';
    scoreChange = -CREDIT_CONFIG.lateCancelPenalty;
    reason = cancelReason ? `临时取消（${hoursDiff.toFixed(1)}小时内）：${cancelReason}` : `临时取消（${hoursDiff.toFixed(1)}小时内）`;
  } else {
    changeType = 'cancel_early';
    scoreChange = CREDIT_CONFIG.earlyCancelBonus;
    reason = cancelReason ? `提前取消：${cancelReason}` : '提前取消';
  }
  
  const result = await updateCreditScore(db, userId, scoreChange, changeType, reason, {
    bookingId,
    operatorId,
    operatorRole
  });
  await updateCreditStats(db, userId);
  return result;
}

async function checkBookingPermission(db, userId) {
  const credit = await getUserCredit(db, userId);
  
  if (credit.is_restricted === 1) {
    return {
      allowed: false,
      reason: CREDIT_CONFIG.restrictions.restricted.message,
      credit: credit
    };
  }
  
  let warning = null;
  const levelConfig = CREDIT_CONFIG.restrictions[credit.level];
  if (levelConfig && levelConfig.warning) {
    warning = levelConfig.warning;
  }
  
  if (levelConfig && levelConfig.maxDailyBookings) {
    const today = new Date().toISOString().split('T')[0];
    const todayBookings = await db.get(
      `SELECT COUNT(*) as count FROM bookings 
       WHERE user_id = ? AND date = ? AND status != 'cancelled'`,
      [userId, today]
    );
    
    if (todayBookings.count >= levelConfig.maxDailyBookings) {
      return {
        allowed: false,
        reason: `${warning || '信用限制'}，今日预约已达上限（${levelConfig.maxDailyBookings}次）`,
        credit: credit
      };
    }
  }
  
  return {
    allowed: true,
    warning,
    credit: credit
  };
}

async function manualAdjust(db, userId, scoreAdjustment, reason, operatorId, operatorRole) {
  const result = await updateCreditScore(db, userId, scoreAdjustment, 'manual_adjust', reason, {
    operatorId,
    operatorRole
  });
  return result;
}

async function setRestriction(db, userId, isRestricted, reason, operatorId, operatorRole, restrictUntil = null) {
  const credit = await getUserCredit(db, userId);
  
  await db.run(
    `UPDATE user_credit SET is_restricted = ?, restrict_reason = ?, restrict_until = ?, last_updated = CURRENT_TIMESTAMP 
     WHERE user_id = ?`,
    [isRestricted ? 1 : 0, reason, restrictUntil, userId]
  );
  
  const changeType = isRestricted ? 'penalty' : 'reward';
  const changeReason = isRestricted ? `人工限制：${reason}` : `解除限制：${reason}`;
  
  await db.run(
    `INSERT INTO credit_records 
     (user_id, change_type, score_change, score_before, score_after, 
      level_before, level_after, reason, operator_id, operator_role)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, changeType, credit.score, credit.score, credit.level, credit.level,
     changeReason, operatorId, operatorRole]
  );
  
  return { is_restricted: isRestricted, reason };
}

async function handleAppealApprove(db, appeal, operatorId, operatorRole) {
  const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [appeal.booking_id]);
  if (!booking) {
    throw new Error('关联预约不存在');
  }

  const result = {
    booking_updated: false,
    credit_reverted: false,
    credit_change: null,
    old_status: booking.status,
    new_status: null
  };

  if (appeal.appeal_type === 'no_show' && booking.status === 'no_show') {
    await db.run(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, 
       cancel_reason = ?, no_show_at = NULL, no_show_note = NULL WHERE id = ?`,
      ['申诉通过：未到场标记撤销', appeal.booking_id]
    );
    result.booking_updated = true;
    result.new_status = 'cancelled';

    const revertedCredit = await updateCreditScore(
      db, booking.user_id, CREDIT_CONFIG.noShowPenalty, 'reset',
      `申诉通过：撤销未到场扣分（预约#${appeal.booking_id}）`,
      { bookingId: appeal.booking_id, operatorId, operatorRole }
    );
    result.credit_reverted = true;
    result.credit_change = revertedCredit;
  } else if (appeal.appeal_type === 'cancel_late') {
    const creditRecords = await db.all(
      `SELECT * FROM credit_records WHERE booking_id = ? AND change_type = 'cancel_late' ORDER BY id DESC LIMIT 1`,
      [appeal.booking_id]
    );
    if (creditRecords.length > 0) {
      const record = creditRecords[0];
      const revertAmount = Math.abs(record.score_change);
      const revertedCredit = await updateCreditScore(
        db, booking.user_id, revertAmount, 'reset',
        `申诉通过：撤销临时取消扣分（预约#${appeal.booking_id}）`,
        { bookingId: appeal.booking_id, operatorId, operatorRole }
      );
      result.credit_reverted = true;
      result.credit_change = revertedCredit;
    }
  } else if (appeal.appeal_type === 'credit_deduction') {
    const revertAmount = Math.abs(appeal.original_credit_change) || CREDIT_CONFIG.noShowPenalty;
    const revertedCredit = await updateCreditScore(
      db, booking.user_id, revertAmount, 'reset',
      `申诉通过：信用分扣减撤销（预约#${appeal.booking_id}）`,
      { bookingId: appeal.booking_id, operatorId, operatorRole }
    );
    result.credit_reverted = true;
    result.credit_change = revertedCredit;

    if (booking.status === 'no_show') {
      await db.run(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, 
         cancel_reason = ?, no_show_at = NULL, no_show_note = NULL WHERE id = ?`,
        ['申诉通过：异常状态修正', appeal.booking_id]
      );
      result.booking_updated = true;
      result.new_status = 'cancelled';
    }
  }

  if (result.booking_updated || result.credit_reverted) {
    await updateCreditStats(db, booking.user_id);
  }

  return result;
}

module.exports = {
  CREDIT_CONFIG,
  getLevelByScore,
  getLevelLabel,
  getUserCredit,
  updateCreditScore,
  updateCreditStats,
  handleArrive,
  handleNoShow,
  handleCancel,
  checkBookingPermission,
  manualAdjust,
  setRestriction,
  handleAppealApprove
};
