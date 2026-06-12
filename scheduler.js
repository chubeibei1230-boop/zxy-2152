const cron = require('node-cron');
const { getDb } = require('./db');

async function releaseExpiredLocks() {
  try {
    const db = await getDb();
    const now = new Date().toISOString();

    const expiredLocks = await db.all(
      `SELECT * FROM temp_locks WHERE is_released = 0 AND expires_at <= ?`,
      [now]
    );

    if (expiredLocks.length === 0) return;

    for (const lock of expiredLocks) {
      await db.run(
        `UPDATE temp_locks SET is_released = 1, release_reason = ?, released_at = CURRENT_TIMESTAMP WHERE id = ?`,
        ['锁过期自动释放', lock.id]
      );
      await db.run(
        `INSERT INTO lock_release_logs (lock_id, user_id, room_id, date, start_time, end_time, release_reason) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [lock.id, lock.user_id, lock.room_id, lock.date, lock.start_time, lock.end_time, '锁过期自动释放']
      );
    }

    console.log(`[定时任务] 已释放 ${expiredLocks.length} 个过期临时锁`);
  } catch (err) {
    console.error('[定时任务] 释放过期锁失败:', err.message);
  }
}

async function markOverdueBookings() {
  try {
    const db = await getDb();
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nowTimeStr = now.toTimeString().slice(0, 5);

    const overdueBookings = await db.all(
      `SELECT * FROM bookings WHERE status = 'booked' 
       AND (date < ? OR (date = ? AND end_time < ?))`,
      [todayStr, todayStr, nowTimeStr]
    );

    if (overdueBookings.length === 0) return;

    console.log(`[定时任务] 发现 ${overdueBookings.length} 个超时未确认的预约，值守人员需处理`);
  } catch (err) {
    console.error('[定时任务] 检查超时预约失败:', err.message);
  }
}

async function cleanupOldRecords() {
  try {
    const db = await getDb();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const cutoff = threeMonthsAgo.toISOString();

    await db.run(`DELETE FROM temp_locks WHERE is_released = 1 AND released_at < ?`, [cutoff]);
    await db.run(`DELETE FROM lock_release_logs WHERE released_at < ?`, [cutoff]);

    console.log(`[定时任务] 已清理 3 个月前的临时锁和释放记录`);
  } catch (err) {
    console.error('[定时任务] 清理旧记录失败:', err.message);
  }
}

function startScheduledTasks() {
  cron.schedule('*/30 * * * * *', () => {
    releaseExpiredLocks();
  });

  cron.schedule('0 */5 * * * *', () => {
    markOverdueBookings();
  });

  cron.schedule('0 0 3 * * *', () => {
    cleanupOldRecords();
  });

  setTimeout(() => {
    releaseExpiredLocks();
  }, 5000);

  console.log('[定时任务] 已启动：过期锁清理(每30秒)、超时预约检查(每5分钟)、旧记录清理(每天3点)');
}

module.exports = { startScheduledTasks, releaseExpiredLocks };
