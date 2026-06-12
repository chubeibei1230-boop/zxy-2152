const { getDb } = require('./db');

async function test() {
  const db = await getDb();
  
  console.log('测试1: 无筛选条件 (无参数数组)');
  try {
    const sql1 = `SELECT b.*, r.name as room_name, u.name as user_name, u.phone as user_phone 
                  FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
                  WHERE 1=1 ORDER BY b.date DESC LIMIT 10`;
    const result = await db.all(sql1);
    console.log('  ✓ 成功，记录数:', result.length);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
    console.log('    堆栈:', e.stack.split('\n').slice(0,3).join('\n'));
  }

  console.log('\n测试2: 带 room_id 参数 (数组参数)');
  try {
    const sql2 = `SELECT b.*, r.name as room_name, u.name as user_name, u.phone as user_phone 
                  FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id LEFT JOIN users u ON b.user_id = u.id 
                  WHERE 1=1 AND b.room_id = ? ORDER BY b.date DESC LIMIT 10`;
    const result = await db.all(sql2, [1]);
    console.log('  ✓ 成功，记录数:', result.length);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
    console.log('    堆栈:', e.stack.split('\n').slice(0,3).join('\n'));
  }

  console.log('\n测试3: count 查询 + 参数');
  try {
    const countSql = `SELECT COUNT(*) as total FROM bookings b WHERE 1=1 AND b.room_id = ?`;
    const result = await db.get(countSql, [1]);
    console.log('  ✓ 成功，总数:', result.total);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
  }

  console.log('\n测试4: 多参数组合');
  try {
    const sql = `SELECT b.*, r.name as room_name FROM bookings b LEFT JOIN rooms r ON b.room_id = r.id 
                 WHERE b.room_id = ? AND b.status = ? LIMIT 10`;
    const result = await db.all(sql, [1, 'booked']);
    console.log('  ✓ 成功，记录数:', result.length);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
  }

  console.log('\n测试5: 模板字符串 + 数组参数');
  try {
    const params = [1, 'booked'];
    const sql = `SELECT COUNT(*) as total FROM bookings b WHERE 1=1`
              + ` AND b.room_id = ? AND b.status = ?`;
    const result = await db.get(sql, params);
    console.log('  ✓ 成功，总数:', result.total);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
  }

  console.log('\n测试6: IN 查询 + ...扩展运算符');
  try {
    const statuses = ['booked', 'arrived'];
    const placeholders = statuses.map(() => '?').join(',');
    const sql = `SELECT COUNT(*) as total FROM bookings b WHERE b.status IN (${placeholders})`;
    const params = [];
    params.push(...statuses);
    console.log('  SQL:', sql);
    console.log('  params:', params);
    const result = await db.get(sql, params);
    console.log('  ✓ 成功，总数:', result.total);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
  }

  console.log('\n测试7: LIMIT ? OFFSET ? + 前置参数');
  try {
    const params = [1, 10, 0];
    const sql = `SELECT * FROM bookings b WHERE b.room_id = ? LIMIT ? OFFSET ?`;
    const result = await db.all(sql, params);
    console.log('  ✓ 成功，记录数:', result.length);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
  }

  console.log('\n测试8: is_overdue 多参数');
  try {
    const todayStr = '2026-06-12';
    const nowTimeStr = '10:00';
    const params = [todayStr, todayStr, nowTimeStr, 10, 0];
    const sql = `SELECT * FROM bookings b 
                 WHERE b.status = 'booked' AND (b.date < ? OR (b.date = ? AND b.end_time < ?))
                 LIMIT ? OFFSET ?`;
    const result = await db.all(sql, params);
    console.log('  ✓ 成功，记录数:', result.length);
  } catch (e) {
    console.log('  ✗ 失败:', e.message);
  }

  process.exit(0);
}

test().catch(e => { console.error('严重错误:', e); process.exit(1); });
