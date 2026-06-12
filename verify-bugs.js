const http = require('http');

const BASE = 'localhost';
const PORT = 8112;

function req(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BASE, port: PORT, path, method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    if (postData) opts.headers['Content-Length'] = Buffer.byteLength(postData);

    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (postData) r.write(postData);
    r.end();
  });
}

async function main() {
  console.log('========== Bug 修复验证测试 ==========\n');

  let adminToken, booker1Token, booker2Token, attToken;
  const today = new Date().toISOString().split('T')[0];

  console.log('[准备] 登录各个账号...');
  const admin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  adminToken = admin.body.token;
  const b1 = await req('POST', '/api/auth/login', { username: 'booker', password: 'booker123' });
  booker1Token = b1.body.token;
  const b2 = await req('POST', '/api/auth/login', { username: 'booker2', password: 'booker123' });
  booker2Token = b2.body.token;
  const att = await req('POST', '/api/auth/login', { username: 'attendant', password: 'attendant123' });
  attToken = att.body.token;
  console.log('  ✓ 全部登录成功\n');

  console.log('===== Bug 1: 预约列表多条件筛选 500 =====');
  const testCases = [
    { name: '无筛选条件', path: '/api/query/bookings' },
    { name: '按房间筛选 room_id=1', path: '/api/query/bookings?room_id=1' },
    { name: '按预约人筛选 user_id=2', path: '/api/query/bookings?user_id=2' },
    { name: '按状态筛选 status=booked', path: '/api/query/bookings?status=booked' },
    { name: '按状态筛选 status=arrived,no_show', path: '/api/query/bookings?status=arrived,no_show' },
    { name: '日期筛选 start_date+end_date', path: '/api/query/bookings?start_date=2026-01-01&end_date=2026-12-31' },
    { name: '按日期筛选 date=' + today, path: '/api/query/bookings?date=' + today },
    { name: '是否超时筛选 is_overdue=0', path: '/api/query/bookings?is_overdue=0' },
    { name: '是否超时筛选 is_overdue=1', path: '/api/query/bookings?is_overdue=1' },
    { name: '多条件组合 room_id+status+user_id', path: '/api/query/bookings?room_id=1&status=booked&user_id=2' },
    { name: '全量组合筛选', path: '/api/query/bookings?room_id=1&user_id=2&status=booked&start_date=2026-01-01&end_date=2026-12-31&is_overdue=0&page=1&page_size=20' },
    { name: '分页参数 page=2&page_size=5', path: '/api/query/bookings?page=2&page_size=5' },
  ];

  let bug1Passed = true;
  for (const tc of testCases) {
    const r = await req('GET', tc.path, null, adminToken);
    const ok = r.status === 200 && r.body.bookings !== undefined;
    if (!ok) {
      bug1Passed = false;
      console.log(`  ✗ ${tc.name}: 状态=${r.status}`);
      console.log(`     错误: ${r.body.error || JSON.stringify(r.body).slice(0, 200)}`);
    } else {
      console.log(`  ✓ ${tc.name}: 状态=${r.status}, 总数=${r.body.pagination?.total ?? 'N/A'}`);
    }
  }
  console.log('  Bug1 结果:', bug1Passed ? 'PASS ✓' : 'FAIL ✗', '\n');

  console.log('===== Bug 2: 值守人员现场改时 500 =====');
  
  const bkCreate = await req('POST', '/api/bookings', {
    room_id: 3, date: today, start_time: '14:00', end_time: '15:00'
  }, booker1Token);
  console.log('  先创建预约: 状态=' + bkCreate.status + ', ID=' + bkCreate.body.booking?.id);
  
  let bug2Passed = false;
  if (bkCreate.body.booking?.id) {
    const reResp = await req('PUT', '/api/attendant/bookings/' + bkCreate.body.booking.id + '/reschedule', {
      new_date: today, new_start_time: '17:00', new_end_time: '18:00'
    }, attToken);
    if (reResp.status === 200 && reResp.body.booking?.start_time === '17:00') {
      bug2Passed = true;
      console.log('  ✓ 现场改时成功: 新时段=' + reResp.body.changed_to?.start_time + '-' + reResp.body.changed_to?.end_time);
    } else {
      console.log('  ✗ 现场改时失败: 状态=' + reResp.status);
      console.log('    错误:', reResp.body.error || JSON.stringify(reResp.body).slice(0, 300));
    }
  }
  console.log('  Bug2 结果:', bug2Passed ? 'PASS ✓' : 'FAIL ✗', '\n');

  console.log('===== Bug 3: 带锁的预约标记未到场 500 =====');
  
  console.log('  步骤1: 创建临时锁...');
  const lockResp = await req('POST', '/api/locks', {
    room_id: 4, date: today, start_time: '19:00', end_time: '20:00'
  }, booker2Token);
  const lockId = lockResp.body.lock?.id;
  console.log('    锁ID=' + lockId + ', 状态=' + lockResp.status);

  console.log('  步骤2: 使用锁创建预约...');
  const bkWithLock = await req('POST', '/api/bookings', {
    room_id: 4, date: today, start_time: '19:00', end_time: '20:00', lock_id: lockId
  }, booker2Token);
  const bk3Id = bkWithLock.body.booking?.id;
  console.log('    预约ID=' + bk3Id + ', 状态=' + bkWithLock.status);

  let bug3Passed = false;
  if (bk3Id) {
    console.log('  步骤3: 值守人员标记未到场...');
    const nsResp = await req('PUT', '/api/attendant/bookings/' + bk3Id + '/no-show', {
      no_show_note: '测试带锁未到场'
    }, attToken);
    if (nsResp.status === 200 && nsResp.body.booking?.status === 'no_show') {
      bug3Passed = true;
      console.log('  ✓ 标记未到场成功: 状态=' + nsResp.body.booking.status);
      console.log('    锁释放日志也应该已记录');
    } else {
      console.log('  ✗ 标记未到场失败: 状态=' + nsResp.status);
      console.log('    错误:', nsResp.body.error || JSON.stringify(nsResp.body).slice(0, 300));
    }
  }
  console.log('  Bug3 结果:', bug3Passed ? 'PASS ✓' : 'FAIL ✗', '\n');

  console.log('===== Bug 4: 自己的临时锁显示 locked_by_me =====');
  
  console.log('  步骤1: 创建一个临时锁...');
  const lock4Resp = await req('POST', '/api/locks', {
    room_id: 1, date: today, start_time: '20:00', end_time: '21:00'
  }, booker1Token);
  console.log('    Booker1创建锁: 状态=' + lock4Resp.status + ', ID=' + lock4Resp.body.lock?.id);

  console.log('  步骤2: Booker1查询可用性，看锁是否显示为 locked_by_me...');
  const availResp = await req('GET', '/api/rooms/availability?date=' + today + '&room_id=1', null, booker1Token);
  let foundLockedByMe = false;
  if (availResp.status === 200 && availResp.body.availability) {
    for (const room of availResp.body.availability) {
      for (const slot of room.slots) {
        if (slot.start_time === '20:00' && slot.end_time === '21:00') {
          console.log('    时段 20:00-21:00 的状态:', slot.status);
          if (slot.status === 'locked_by_me') {
            foundLockedByMe = true;
            console.log('    lock_info:', JSON.stringify(slot.lock_info));
          }
        }
      }
    }
  }
  
  console.log('  步骤3: Booker2查询同一时段，看是否显示 temp_locked...');
  const availResp2 = await req('GET', '/api/rooms/availability?date=' + today + '&room_id=1', null, booker2Token);
  let foundTempLocked = false;
  if (availResp2.status === 200 && availResp2.body.availability) {
    for (const room of availResp2.body.availability) {
      for (const slot of room.slots) {
        if (slot.start_time === '20:00' && slot.end_time === '21:00') {
          console.log('    Booker2看到的状态:', slot.status);
          if (slot.status === 'temp_locked') {
            foundTempLocked = true;
          }
        }
      }
    }
  }

  const bug4Passed = foundLockedByMe && foundTempLocked;
  console.log('  Bug4 结果:', bug4Passed ? 'PASS ✓' : 'FAIL ✗');
  if (!foundLockedByMe) console.log('    ✗ 锁持有者没有看到 locked_by_me 状态');
  if (!foundTempLocked) console.log('    ✗ 其他人没有看到 temp_locked 状态');
  console.log('');

  console.log('========== 总 结 ==========');
  console.log('Bug 1 (预约列表筛选 500):', bug1Passed ? '✓ PASS' : '✗ FAIL');
  console.log('Bug 2 (现场改时 500):    ', bug2Passed ? '✓ PASS' : '✗ FAIL');
  console.log('Bug 3 (带锁预约未到场 500):', bug3Passed ? '✓ PASS' : '✗ FAIL');
  console.log('Bug 4 (locked_by_me 显示):  ', bug4Passed ? '✓ PASS' : '✗ FAIL');
  console.log('\n全部通过:', (bug1Passed && bug2Passed && bug3Passed && bug4Passed) ? '是 ✓' : '否 ✗');
}

main().catch(e => console.error('测试出错:', e.message, e.stack));
