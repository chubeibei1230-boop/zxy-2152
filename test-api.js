const http = require('http');

const BASE_URL = 'localhost';
const PORT = 8112;

function req(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: BASE_URL,
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      }
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;
    if (postData) options.headers['Content-Length'] = Buffer.byteLength(postData);

    const reqObj = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    reqObj.on('error', reject);
    if (postData) reqObj.write(postData);
    reqObj.end();
  });
}

async function main() {
  console.log('========== 练琴房预约系统 API 测试 ==========\n');

  console.log('[1/12] 健康检查...');
  const health = await req('GET', '/api/health');
  console.log('  状态:', health.status, '-', health.body.status, health.body.database ? '(DB: ' + health.body.database + ')' : '');

  console.log('\n[2/12] Booker1 登录...');
  const booker1Login = await req('POST', '/api/auth/login', { username: 'booker', password: 'booker123' });
  const booker1Token = booker1Login.body.token;
  console.log('  状态:', booker1Login.status, booker1Login.body.message, '| 用户:', booker1Login.body.user?.name);

  console.log('\n[3/12] 查询今日房间可用性...');
  const today = new Date().toISOString().split('T')[0];
  const avail = await req('GET', `/api/rooms/availability?date=${today}`, null, booker1Token);
  console.log('  状态:', avail.status, '| 房间数:', avail.body.availability?.length);
  avail.body.availability?.forEach(r => {
    const availCount = r.slots.filter(s => s.status === 'available').length;
    console.log(`    房间[${r.room_name}]: 可用${availCount}/${r.slots.length}个时段`);
  });

  const firstRoom = avail.body.availability?.[0];
  const freeSlot = firstRoom?.slots.find(s => s.status === 'available');
  let lockId = null, bookingId = null;

  if (firstRoom && freeSlot) {
    console.log('\n[4/12] 创建临时锁 (房间', firstRoom.room_id, firstRoom.room_name, freeSlot.start_time + '-' + freeSlot.end_time, ')...');
    const lockResp = await req('POST', '/api/locks', {
      room_id: firstRoom.room_id, date: today,
      start_time: freeSlot.start_time, end_time: freeSlot.end_time
    }, booker1Token);
    console.log('  状态:', lockResp.status, lockResp.body.message);
    lockId = lockResp.body.lock?.id;
    if (lockId) console.log('  锁ID:', lockId, '| 过期时间:', lockResp.body.lock.expires_at);

    console.log('\n[5/12] 使用锁创建预约...');
    const bookingResp = await req('POST', '/api/bookings', {
      room_id: firstRoom.room_id, date: today,
      start_time: freeSlot.start_time, end_time: freeSlot.end_time,
      lock_id: lockId
    }, booker1Token);
    console.log('  状态:', bookingResp.status, bookingResp.body.message);
    bookingId = bookingResp.body.booking?.id;
    if (bookingId) console.log('  预约ID:', bookingId, '| 房间:', bookingResp.body.booking.room_name, '| 时段:', bookingResp.body.booking.start_time + '-' + bookingResp.body.booking.end_time);

    console.log('\n[6/12] 确认到场...');
    const arriveResp = await req('PUT', `/api/bookings/${bookingId}/arrive`, {}, booker1Token);
    console.log('  状态:', arriveResp.status, '| 预约状态:', arriveResp.body.booking?.status);
  } else {
    console.log('\n[4/12] 跳过创建锁 (无可用时段)');
    console.log('\n[5/12] 跳过创建预约');
    console.log('\n[6/12] 跳过确认到场');
  }

  console.log('\n[7/12] Booker2 登录并创建预约...');
  const booker2Login = await req('POST', '/api/auth/login', { username: 'booker2', password: 'booker123' });
  const booker2Token = booker2Login.body.token;
  console.log('  Booker2状态:', booker2Login.status, '| 用户:', booker2Login.body.user?.name);

  let booking2Id = null;
  const secondRoom = avail.body.availability?.[1] || avail.body.availability?.[0];
  const freeSlot2 = secondRoom?.slots.find(s => s.status === 'available' && s !== freeSlot);
  if (secondRoom && freeSlot2) {
    const b2Resp = await req('POST', '/api/bookings', {
      room_id: secondRoom.room_id, date: today,
      start_time: freeSlot2.start_time, end_time: freeSlot2.end_time
    }, booker2Token);
    booking2Id = b2Resp.body.booking?.id;
    console.log('  Booker2预约状态:', b2Resp.status, b2Resp.body.message, booking2Id ? '| ID=' + booking2Id : '');
  }

  console.log('\n[8/12] 值守人员登录并标记未到场...');
  const attLogin = await req('POST', '/api/auth/login', { username: 'attendant', password: 'attendant123' });
  const attToken = attLogin.body.token;
  console.log('  值守人员状态:', attLogin.status, '| 用户:', attLogin.body.user?.name);
  if (booking2Id) {
    const nsResp = await req('PUT', `/api/attendant/bookings/${booking2Id}/no-show`, { no_show_note: '测试标记未到场' }, attToken);
    console.log('  标记未到场状态:', nsResp.status, '| 预约状态:', nsResp.body.booking?.status);
  }

  console.log('\n[9/12] 管理员登录 + 获取房间列表...');
  const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const adminToken = adminLogin.body.token;
  console.log('  管理员登录:', adminLogin.status, '| 用户:', adminLogin.body.user?.name);
  const roomsResp = await req('GET', '/api/admin/rooms', null, adminToken);
  console.log('  房间列表:', roomsResp.status, '| 房间数:', roomsResp.body.rooms?.length);
  roomsResp.body.rooms?.forEach(r => {
    console.log(`    房间[${r.name}]: 状态=${r.status}, 容量=${r.capacity}, 时段数=${r.time_slots?.length}`);
  });

  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  console.log('\n[10/12] 设置开放日期 (' + tomorrow + ')...');
  const openResp = await req('POST', '/api/admin/open-dates', { room_id: 1, date: tomorrow, is_open: 1 }, adminToken);
  console.log('  状态:', openResp.status, openResp.body.message, '| is_open:', openResp.body.open_date?.is_open);

  console.log('\n[11/12] 查询预约列表...');
  const bookingsResp = await req('GET', '/api/query/bookings?page_size=10', null, adminToken);
  console.log('  状态:', bookingsResp.status, '| 总数:', bookingsResp.body.pagination?.total);
  bookingsResp.body.bookings?.forEach(b => {
    console.log(`    ID=${b.id} [${b.status}] ${b.user_name} | ${b.room_name} ${b.date} ${b.start_time}-${b.end_time}`);
  });

  console.log('\n[12/12] 查询统计数据...');
  const overview = await req('GET', '/api/query/stats/overview', null, adminToken);
  console.log('  概览统计:', overview.status);
  const ov = overview.body.overview;
  console.log(`    总预约:${ov?.total_bookings} 已到场:${ov?.arrived} 未到场:${ov?.no_show} 已取消:${ov?.cancelled}`);
  console.log(`    到场率:${ov?.arrival_rate} 未到场率:${ov?.no_show_rate} 锁释放总数:${ov?.locks_released_total}`);

  const startD = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const endD = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const util = await req('GET', `/api/query/stats/room-utilization?start_date=${startD}&end_date=${endD}`, null, adminToken);
  console.log('  房间利用率:', util.status);
  util.body.room_utilization?.forEach(u => {
    console.log(`    房间[${u.room_name}]: 可用时段=${u.total_available_slots}, 已用=${u.used_slots}, 利用率=${u.utilization_rate}`);
  });

  console.log('\n========== 测试完成 ==========');
}

main().catch(e => console.error('测试出错:', e.message));
