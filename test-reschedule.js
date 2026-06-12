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

function getFutureDate(days = 7) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function main() {
  console.log('========== 改签功能 API 测试 ==========\n');

  console.log('[1/15] 健康检查...');
  try {
    const health = await req('GET', '/api/health');
    console.log('  状态:', health.status, '-', health.body.status);
  } catch (e) {
    console.log('  错误: 服务器未启动 -', e.message);
    console.log('  请先运行 "node app.js" 启动服务器');
    process.exit(1);
  }

  console.log('\n[2/15] Booker1 登录...');
  const booker1Login = await req('POST', '/api/auth/login', { 
    username: 'booker', password: 'booker123' 
  });
  const booker1Token = booker1Login.body.token;
  console.log('  状态:', booker1Login.status, '| 用户:', booker1Login.body.user?.name);

  console.log('\n[3/15] Booker2 登录...');
  const booker2Login = await req('POST', '/api/auth/login', { 
    username: 'booker2', password: 'booker123' 
  });
  const booker2Token = booker2Login.body.token;
  console.log('  状态:', booker2Login.status, '| 用户:', booker2Login.body.user?.name);

  console.log('\n[4/15] 管理员登录...');
  const adminLogin = await req('POST', '/api/auth/login', { 
    username: 'admin', password: 'admin123' 
  });
  const adminToken = adminLogin.body.token;
  console.log('  状态:', adminLogin.status, '| 用户:', adminLogin.body.user?.name);

  console.log('\n[5/15] 值守人员登录...');
  const attLogin = await req('POST', '/api/auth/login', { 
    username: 'attendant', password: 'attendant123' 
  });
  const attToken = attLogin.body.token;
  console.log('  状态:', attLogin.status, '| 用户:', attLogin.body.user?.name);

  const futureDate = getFutureDate(7);
  console.log('\n[6/15] 查询未来房间可用性 (' + futureDate + ')...');
  const avail = await req('GET', `/api/rooms/availability?date=${futureDate}`, null, booker1Token);
  console.log('  状态:', avail.status);
  if (avail.body.availability) {
    avail.body.availability.forEach(r => {
      const availCount = r.slots.filter(s => s.status === 'available').length;
      console.log(`    房间[${r.room_name}]: 可用${availCount}/${r.slots.length}个时段`);
    });
  }

  const firstRoom = avail.body.availability?.[0];
  const freeSlots = firstRoom?.slots.filter(s => s.status === 'available') || [];
  
  if (freeSlots.length < 2) {
    console.log('\n可用时段不足，无法测试改签，跳过后续测试');
    console.log('========== 测试结束 ==========');
    return;
  }

  const slot1 = freeSlots[0];
  const slot2 = freeSlots[1];

  console.log('\n[7/15] 创建测试预约 (使用第一个时段)...');
  const bookingResp = await req('POST', '/api/bookings', {
    room_id: firstRoom.room_id,
    date: futureDate,
    start_time: slot1.start_time,
    end_time: slot1.end_time
  }, booker1Token);
  console.log('  状态:', bookingResp.status, bookingResp.body.message);
  const bookingId = bookingResp.body.booking?.id;
  if (bookingId) {
    console.log('  预约ID:', bookingId);
    console.log('  原时段:', futureDate, slot1.start_time + '-' + slot1.end_time);
  }

  if (!bookingId) {
    console.log('\n预约创建失败，无法继续测试改签');
    return;
  }

  console.log('\n[8/15] 提交改签申请 (改到第二个时段)...');
  const submitResp = await req('POST', '/api/reschedule', {
    booking_id: bookingId,
    target_date: futureDate,
    target_start_time: slot2.start_time,
    target_end_time: slot2.end_time,
    reason: '个人时间调整，需要改到稍后时段'
  }, booker1Token);
  console.log('  状态:', submitResp.status, submitResp.body.message || submitResp.body.error);
  const requestId = submitResp.body.request?.id;
  if (requestId) {
    console.log('  申请ID:', requestId);
    console.log('  目标时段:', futureDate, slot2.start_time + '-' + slot2.end_time);
    console.log('  状态:', submitResp.body.request?.status);
  }

  console.log('\n[9/15] 测试：同一预约重复提交改签申请...');
  const dupSubmitResp = await req('POST', '/api/reschedule', {
    booking_id: bookingId,
    target_date: futureDate,
    target_start_time: slot2.start_time,
    target_end_time: slot2.end_time,
    reason: '重复提交测试'
  }, booker1Token);
  console.log('  状态:', dupSubmitResp.status, dupSubmitResp.body.error);
  console.log('  预期: 409 冲突，提示已有待处理申请');

  console.log('\n[10/15] 用户查看我的改签申请列表...');
  const myReschedules = await req('GET', '/api/reschedule/mine?page_size=10', null, booker1Token);
  console.log('  状态:', myReschedules.status);
  console.log('  总数:', myReschedules.body.pagination?.total);
  if (myReschedules.body.requests?.length > 0) {
    const r = myReschedules.body.requests[0];
    console.log('  最新申请: ID=' + r.id + ', 状态=' + r.status + ', 房间=' + r.room_name);
  }

  console.log('\n[11/15] 查看预约的改签记录...');
  const bookingReschedules = await req('GET', `/api/bookings/${bookingId}/reschedules`, null, booker1Token);
  console.log('  状态:', bookingReschedules.status);
  console.log('  改签申请数:', bookingReschedules.body.reschedules?.length);
  console.log('  操作日志数:', bookingReschedules.body.logs?.length);

  console.log('\n[12/15] 管理员查看改签申请列表...');
  const adminList = await req('GET', '/api/admin/reschedules?page_size=10', null, adminToken);
  console.log('  状态:', adminList.status);
  console.log('  总数:', adminList.body.pagination?.total);
  console.log('  统计: 待处理=' + adminList.body.stats?.pending + 
              ', 已通过=' + adminList.body.stats?.approved + 
              ', 已驳回=' + adminList.body.stats?.rejected);

  if (requestId) {
    console.log('\n[13/15] 查看改签申请详情...');
    const detailResp = await req('GET', `/api/reschedule/${requestId}`, null, adminToken);
    console.log('  状态:', detailResp.status);
    if (detailResp.body.request) {
      console.log('  申请人:', detailResp.body.request.user_name);
      console.log('  改签原因:', detailResp.body.request.reason);
      console.log('  原时段:', detailResp.body.request.original_date, 
                  detailResp.body.request.original_start_time + '-' + detailResp.body.request.original_end_time);
      console.log('  目标时段:', detailResp.body.request.target_date, 
                  detailResp.body.request.target_start_time + '-' + detailResp.body.request.target_end_time);
      console.log('  操作日志数:', detailResp.body.logs?.length);
    }
  }

  if (requestId) {
    console.log('\n[14/15] 测试：驳回改签申请...');
    const rejectResp = await req('PUT', `/api/admin/reschedules/${requestId}/reject`, {
      reject_reason: '该时段已有重要安排，暂不支持改签'
    }, adminToken);
    console.log('  状态:', rejectResp.status, rejectResp.body.message || rejectResp.body.error);
    console.log('  申请状态:', rejectResp.body.request?.status);
    console.log('  驳回原因:', rejectResp.body.request?.reject_reason);
  }

  console.log('\n[15/15] 再次提交改签并测试审批通过...');
  
  const submitResp2 = await req('POST', '/api/reschedule', {
    booking_id: bookingId,
    target_date: futureDate,
    target_start_time: slot2.start_time,
    target_end_time: slot2.end_time,
    reason: '再次申请改签，确认时间可行'
  }, booker1Token);
  console.log('  二次提交状态:', submitResp2.status, submitResp2.body.message || submitResp2.body.error);
  const requestId2 = submitResp2.body.request?.id;

  if (requestId2) {
    console.log('\n  审批通过改签申请...');
    const approveResp = await req('PUT', `/api/admin/reschedules/${requestId2}/approve`, {}, adminToken);
    console.log('  状态:', approveResp.status, approveResp.body.message || approveResp.body.error);
    if (approveResp.body.booking) {
      console.log('  预约更新后日期:', approveResp.body.booking.date);
      console.log('  预约更新后时段:', approveResp.body.booking.start_time + '-' + approveResp.body.booking.end_time);
    }
    if (approveResp.body.changed_from && approveResp.body.changed_to) {
      console.log('  变更前:', approveResp.body.changed_from.date, 
                  approveResp.body.changed_from.start_time + '-' + approveResp.body.changed_from.end_time);
      console.log('  变更后:', approveResp.body.changed_to.date, 
                  approveResp.body.changed_to.start_time + '-' + approveResp.body.changed_to.end_time);
    }
  }

  console.log('\n[附加] 改签统计数据...');
  const statsResp = await req('GET', '/api/stats/reschedule?start_date=' + getFutureDate(-30) + '&end_date=' + getFutureDate(30), null, adminToken);
  console.log('  状态:', statsResp.status);
  if (statsResp.body.overview) {
    const ov = statsResp.body.overview;
    console.log('  总申请数:', ov.total_requests);
    console.log('  待处理:', ov.pending);
    console.log('  已通过:', ov.approved);
    console.log('  已驳回:', ov.rejected);
    console.log('  通过率:', ov.approval_rate);
  }

  console.log('\n========== 改签功能测试完成 ==========');
  console.log('\n主要API端点:');
  console.log('  用户端:');
  console.log('    POST /api/reschedule          - 提交改签申请');
  console.log('    GET  /api/reschedule/mine     - 我的改签申请');
  console.log('    GET  /api/reschedule/:id      - 改签申请详情');
  console.log('    GET  /api/bookings/:id/reschedules - 预约的改签记录');
  console.log('  管理端 (attendant/admin):');
  console.log('    GET  /api/admin/reschedules           - 改签申请列表');
  console.log('    PUT  /api/admin/reschedules/:id/approve - 审批通过');
  console.log('    PUT  /api/admin/reschedules/:id/reject  - 审批驳回');
  console.log('    GET  /api/stats/reschedule             - 改签统计');
}

main().catch(e => {
  console.error('测试出错:', e.message);
  console.error(e.stack);
});
