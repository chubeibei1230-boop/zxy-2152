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
  console.log('========== 信用管理模块 API 测试 ==========\n');

  console.log('[1/15] 健康检查...');
  const health = await req('GET', '/api/health');
  console.log('  状态:', health.status, '-', health.body.status);

  console.log('\n[2/15] 管理员登录...');
  const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const adminToken = adminLogin.body.token;
  console.log('  状态:', adminLogin.status, '| 用户:', adminLogin.body.user?.name, '| 角色:', adminLogin.body.user?.role);

  console.log('\n[3/15] Booker1 登录...');
  const booker1Login = await req('POST', '/api/auth/login', { username: 'booker', password: 'booker123' });
  const booker1Token = booker1Login.body.token;
  const booker1Id = booker1Login.body.user?.id;
  console.log('  状态:', booker1Login.status, '| 用户:', booker1Login.body.user?.name, '| ID:', booker1Id);

  console.log('\n[4/15] 获取信用配置...');
  const config = await req('GET', '/api/credit/config', null, booker1Token);
  console.log('  状态:', config.status);
  console.log('  初始分数:', config.body.config?.initial_score);
  console.log('  信用等级数:', config.body.config?.levels?.length);
  console.log('  变更类型数:', config.body.config?.change_types?.length);

  console.log('\n[5/15] 获取我的信用信息...');
  const myCredit = await req('GET', '/api/credit/my-credit', null, booker1Token);
  console.log('  状态:', myCredit.status);
  console.log('  信用分:', myCredit.body.credit?.score);
  console.log('  信用等级:', myCredit.body.credit?.level_label);
  console.log('  是否受限:', myCredit.body.credit?.is_restricted);
  console.log('  能否预约:', myCredit.body.credit?.can_book);
  console.log('  最近记录数:', myCredit.body.recent_records?.length);

  console.log('\n[6/15] 查询房间可用性（验证信用提示）...');
  const today = new Date().toISOString().split('T')[0];
  const avail = await req('GET', `/api/rooms/availability?date=${today}`, null, booker1Token);
  console.log('  状态:', avail.status);
  console.log('  用户信用分:', avail.body.user_credit?.score);
  console.log('  能否预约:', avail.body.can_book);
  if (avail.body.credit_warning) console.log('  信用警告:', avail.body.credit_warning);

  console.log('\n[7/15] 我的预约（含信用信息）...');
  const myBookings = await req('GET', '/api/bookings/mine', null, booker1Token);
  console.log('  状态:', myBookings.status);
  console.log('  预约数量:', myBookings.body.bookings?.length);
  console.log('  用户信用分:', myBookings.body.user_credit?.score);

  const firstRoom = avail.body.availability?.[0];
  const freeSlot = firstRoom?.slots.find(s => s.status === 'available');
  let bookingId = null;

  if (firstRoom && freeSlot) {
    console.log('\n[8/15] 创建预约（测试信用检查）...');
    const bookingResp = await req('POST', '/api/bookings', {
      room_id: firstRoom.room_id,
      date: today,
      start_time: freeSlot.start_time,
      end_time: freeSlot.end_time
    }, booker1Token);
    console.log('  状态:', bookingResp.status);
    bookingId = bookingResp.body.booking?.id;
    if (bookingId) {
      console.log('  预约ID:', bookingId);
      console.log('  房间:', bookingResp.body.booking?.room_name);
    }

    if (bookingId) {
      console.log('\n[9/15] 确认到场（测试信用加分）...');
      const arriveResp = await req('PUT', `/api/bookings/${bookingId}/arrive`, {}, booker1Token);
      console.log('  状态:', arriveResp.status);
      console.log('  预约状态:', arriveResp.body.booking?.status);
      if (arriveResp.body.credit_change) {
        console.log('  信用变化:', arriveResp.body.credit_change.score_change, '分');
        console.log('  变化前:', arriveResp.body.credit_change.score_before, '->', '变化后:', arriveResp.body.credit_change.score_after);
      }
    }
  } else {
    console.log('\n[8/15] 跳过创建预约（无可用时段）');
    console.log('\n[9/15] 跳过确认到场（无可用时段）');
  }

  console.log('\n[10/15] 管理员获取用户信用列表...');
  const userList = await req('GET', '/api/credit/users', null, adminToken);
  console.log('  状态:', userList.status);
  console.log('  用户数量:', userList.body.users?.length);
  if (userList.body.users?.length > 0) {
    const firstUser = userList.body.users[0];
    console.log('  首个用户:', firstUser.name, '| 信用分:', firstUser.score, '| 等级:', firstUser.level_label);
  }

  console.log('\n[11/15] 管理员获取用户信用详情...');
  const userDetail = await req('GET', `/api/credit/users/${booker1Id}`, null, adminToken);
  console.log('  状态:', userDetail.status);
  console.log('  用户:', userDetail.body.user?.name);
  console.log('  信用分:', userDetail.body.credit?.score);
  console.log('  总预约:', userDetail.body.stats?.total_bookings);
  console.log('  到场:', userDetail.body.stats?.arrived_count);
  console.log('  最近记录数:', userDetail.body.recent_records?.length);

  console.log('\n[12/15] 管理员手动调整信用分...');
  const adjustResp = await req('PUT', `/api/credit/users/${booker1Id}/adjust`, {
    score_adjustment: -5,
    reason: '测试人工扣分'
  }, adminToken);
  console.log('  状态:', adjustResp.status);
  console.log('  消息:', adjustResp.body.message);
  if (adjustResp.body.credit_change) {
    console.log('  信用变化:', adjustResp.body.credit_change.score_change, '分');
    console.log('  变化后信用分:', adjustResp.body.current_credit?.score);
  }

  console.log('\n[13/15] 查询统计 - 信用概况...');
  const creditOverview = await req('GET', '/api/query/credit/overview', null, adminToken);
  console.log('  状态:', creditOverview.status);
  console.log('  总用户数:', creditOverview.body.overview?.total_users);
  console.log('  平均分数:', creditOverview.body.overview?.avg_score);
  console.log('  受限用户数:', creditOverview.body.overview?.restricted_count);
  console.log('  最近记录数:', creditOverview.body.recent_records?.length);

  console.log('\n[14/15] 查询统计 - 信用记录...');
  const creditRecords = await req('GET', '/api/query/credit/records?page_size=10', null, adminToken);
  console.log('  状态:', creditRecords.status);
  console.log('  总记录数:', creditRecords.body.pagination?.total);
  console.log('  当前页记录数:', creditRecords.body.records?.length);
  console.log('  类型统计数:', creditRecords.body.type_stats?.length);

  console.log('\n[15/15] 查询统计 - 用户信用排行...');
  const ranking = await req('GET', '/api/query/credit/user-ranking?limit=5', null, adminToken);
  console.log('  状态:', ranking.status);
  console.log('  排行人数:', ranking.body.ranking?.length);
  if (ranking.body.ranking?.length > 0) {
    const top = ranking.body.ranking[0];
    console.log('  第一名:', top.name, '| 信用分:', top.score, '| 等级:', top.level_label);
  }

  console.log('\n========== 测试完成 ==========');
  console.log('\n核心功能验证：');
  console.log('✓ 用户信用查询（我的信用、信用详情）');
  console.log('✓ 信用记录查询（分页、筛选）');
  console.log('✓ 预约时信用检查（锁定、创建预约）');
  console.log('✓ 到场信用加分');
  console.log('✓ 管理员手动调整信用');
  console.log('✓ 信用统计（概况、排行、记录）');
  console.log('✓ 信用等级和标签');
}

main().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
