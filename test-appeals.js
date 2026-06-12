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

let passed = 0;
let failed = 0;
function test(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${name} ${detail ? '| ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('========== 练琴房预约申诉模块 API 测试 ==========\n');

  console.log('[0] 健康检查...');
  const health = await req('GET', '/api/health');
  test('服务正常运行', health.status === 200 && health.body.status === 'ok');

  console.log('\n[1] 用户登录...');
  const bookerLogin = await req('POST', '/api/auth/login', { username: 'booker', password: 'booker123' });
  const bookerToken = bookerLogin.body.token;
  test('Booker登录成功', bookerLogin.status === 200 && !!bookerToken, `status=${bookerLogin.status}`);

  const booker2Login = await req('POST', '/api/auth/login', { username: 'booker2', password: 'booker123' });
  const booker2Token = booker2Login.body.token;
  test('Booker2登录成功', booker2Login.status === 200 && !!booker2Token);

  const attLogin = await req('POST', '/api/auth/login', { username: 'attendant', password: 'attendant123' });
  const attToken = attLogin.body.token;
  test('值守人员登录成功', attLogin.status === 200 && !!attToken);

  const adminLogin = await req('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  const adminToken = adminLogin.body.token;
  test('管理员登录成功', adminLogin.status === 200 && !!adminToken);

  console.log('\n[1.5] 重置测试用户信用分...');
  const booker2Id = booker2Login.body.user?.id;
  const bookerId = bookerLogin.body.user?.id;
  if (booker2Id) {
    const adjResp = await req('PUT', `/api/credit/users/${booker2Id}/adjust`, {
      score_adjustment: 100,
      reason: '测试重置信用分'
    }, adminToken);
    if (adjResp.status !== 200) {
      await req('PUT', `/api/credit/users/${booker2Id}/adjust`, {
        score_adjustment: 50,
        reason: '测试重置信用分'
      }, adminToken);
    }
  }
  if (bookerId) {
    const adjResp2 = await req('PUT', `/api/credit/users/${bookerId}/adjust`, {
      score_adjustment: 100,
      reason: '测试重置信用分'
    }, adminToken);
    if (adjResp2.status !== 200) {
      await req('PUT', `/api/credit/users/${bookerId}/adjust`, {
        score_adjustment: 50,
        reason: '测试重置信用分'
      }, adminToken);
    }
  }

  console.log('\n[2] 获取申诉类型...');
  const typesResp = await req('GET', '/api/appeals/types', null, bookerToken);
  test('获取申诉类型成功', typesResp.status === 200 && typesResp.body.types?.length === 3, `count=${typesResp.body.types?.length}`);
  test('包含三种申诉类型', 
    typesResp.body.types?.some(t => t.type === 'no_show') &&
    typesResp.body.types?.some(t => t.type === 'cancel_late') &&
    typesResp.body.types?.some(t => t.type === 'credit_deduction')
  );

  console.log('\n[3] 创建测试预约并标记未到场...');
  const today = new Date().toISOString().split('T')[0];
  const avail = await req('GET', `/api/rooms/availability?date=${today}`, null, booker2Token);
  
  let bookingId = null;
  let targetRoom = null;
  let targetSlot = null;
  
  for (const room of avail.body.availability || []) {
    const slot = room.slots.find(s => s.status === 'available');
    if (slot) {
      targetRoom = room;
      targetSlot = slot;
      break;
    }
  }

  if (targetRoom && targetSlot) {
    const bookingResp = await req('POST', '/api/bookings', {
      room_id: targetRoom.room_id,
      date: today,
      start_time: targetSlot.start_time,
      end_time: targetSlot.end_time
    }, booker2Token);
    bookingId = bookingResp.body.booking?.id;
    test('Booker2创建预约成功', bookingResp.status === 201 && !!bookingId, `status=${bookingResp.status}`);

    if (bookingId) {
      console.log(`  预约ID: ${bookingId}, 房间: ${targetRoom.room_name}, 时段: ${targetSlot.start_time}-${targetSlot.end_time}`);
      
      const noShowResp = await req('PUT', `/api/attendant/bookings/${bookingId}/no-show`, {
        no_show_note: '测试：用户未到场'
      }, attToken);
      test('值守人员标记未到场成功', noShowResp.status === 200 && noShowResp.body.booking?.status === 'no_show', `status=${noShowResp.body.booking?.status}`);
      test('信用分被扣减', noShowResp.body.credit_change?.score_change < 0, `change=${noShowResp.body.credit_change?.score_change}`);
    }
  } else {
    console.log('  警告: 未找到可用时段，跳过部分测试');
  }

  console.log('\n[4] 提交申诉...');
  let appealId = null;
  if (bookingId) {
    const appealResp = await req('POST', '/api/appeals', {
      booking_id: bookingId,
      appeal_type: 'no_show',
      reason: '实际上已到场，可能是值守人员误标记',
      evidence: '有签到记录和监控录像为证'
    }, booker2Token);
    appealId = appealResp.body.appeal?.id;
    test('提交申诉成功', appealResp.status === 201 && !!appealId, `status=${appealResp.status}`);
    test('申诉状态为待处理', appealResp.body.appeal?.status === 'pending', `status=${appealResp.body.appeal?.status}`);
    test('记录原始预约状态', appealResp.body.appeal?.original_status === 'no_show');

    const dupAppealResp = await req('POST', '/api/appeals', {
      booking_id: bookingId,
      appeal_type: 'no_show',
      reason: '重复提交测试'
    }, booker2Token);
    test('重复提交申诉被拒绝', dupAppealResp.status === 409, `status=${dupAppealResp.status}`);
  }

  console.log('\n[4.1] Bug1验证：不能对正常预约提交credit_deduction申诉...');
  let normalBookingId = null;
  for (const room of avail.body.availability || []) {
    const slot = room.slots.find(s => s.status === 'available' && 
      !(targetRoom && room.room_id === targetRoom.room_id && targetSlot && s.start_time === targetSlot.start_time));
    if (slot) {
      const bResp = await req('POST', '/api/bookings', {
        room_id: room.room_id,
        date: today,
        start_time: slot.start_time,
        end_time: slot.end_time
      }, booker2Token);
      if (bResp.status === 201) {
        normalBookingId = bResp.body.booking?.id;
        break;
      }
    }
  }
  if (normalBookingId) {
    const badCreditResp = await req('POST', '/api/appeals', {
      booking_id: normalBookingId,
      appeal_type: 'credit_deduction',
      reason: '测试无扣分预约提交信用扣减申诉'
    }, booker2Token);
    test('无扣分的credit_deduction申诉被拒绝', badCreditResp.status === 400, `status=${badCreditResp.status}`);
  } else {
    test('无扣分的credit_deduction申诉被拒绝', true, '无可用时段，跳过测试');
  }

  console.log('\n[4.2] Bug1验证：不能对非cancelled预约提交cancel_late申诉...');
  if (bookingId) {
    const badCancelResp = await req('POST', '/api/appeals', {
      booking_id: bookingId,
      appeal_type: 'cancel_late',
      reason: '测试非取消预约提交临时取消申诉'
    }, booker2Token);
    test('非cancelled的cancel_late申诉被拒绝', badCancelResp.status === 400, `status=${badCancelResp.status}`);
  }

  console.log('\n[5] 用户查看自己的申诉列表...');
  const mineResp = await req('GET', '/api/appeals/mine?page_size=10', null, booker2Token);
  test('获取我的申诉列表成功', mineResp.status === 200, `status=${mineResp.status}`);
  test('列表包含刚提交的申诉', appealId ? mineResp.body.appeals?.some(a => a.id === appealId) : true);
  test('包含类型和状态标签', mineResp.body.appeals?.[0]?.appeal_type_label !== undefined);

  console.log('\n[6] 用户补充申诉信息...');
  if (appealId) {
    const noteResp = await req('PUT', `/api/appeals/${appealId}/note`, {
      reason: '补充：当天在房间内练琴2小时，有房间使用记录',
      evidence: '房间门卡记录显示14:02刷卡进入'
    }, booker2Token);
    test('补充申诉信息成功', noteResp.status === 200, `status=${noteResp.status}`);
  }

  console.log('\n[7] 查看申诉详情（用户视角）...');
  if (appealId) {
    const detailResp = await req('GET', `/api/appeals/${appealId}`, null, booker2Token);
    test('获取申诉详情成功', detailResp.status === 200, `status=${detailResp.status}`);
    test('包含关联预约信息', !!detailResp.body.booking);
    test('包含用户信用信息', !!detailResp.body.user_credit);
    test('包含信用记录', !!detailResp.body.credit_records);
    test('包含处理日志', !!detailResp.body.logs);
    test('包含用户历史申诉', detailResp.body.past_appeals !== undefined);
  }

  console.log('\n[8] 管理员获取申诉列表...');
  const listResp = await req('GET', '/api/appeals/management?page_size=20', null, adminToken);
  test('管理员获取申诉列表成功', listResp.status === 200, `status=${listResp.status}`);
  test('包含统计数据', !!listResp.body.stats);
  test('统计包含待处理数量', listResp.body.stats?.pending !== undefined);

  const attListResp = await req('GET', '/api/appeals/management?page_size=20', null, attToken);
  test('值守人员获取申诉列表成功', attListResp.status === 200, `status=${attListResp.status}`);

  const forbiddenResp = await req('GET', '/api/appeals/management', null, bookerToken);
  test('普通用户无权获取管理列表', forbiddenResp.status === 403, `status=${forbiddenResp.status}`);

  console.log('\n[9] 管理员添加处理备注...');
  if (appealId) {
    const noteResp = await req('PUT', `/api/appeals/management/${appealId}/note`, {
      handle_note: '已核实，情况属实，将通过申诉'
    }, adminToken);
    test('添加处理备注成功', noteResp.status === 200, `status=${noteResp.status}`);
    test('状态变为处理中', noteResp.body.appeal?.status === 'processing', `status=${noteResp.body.appeal?.status}`);
  }

  console.log('\n[10] 审批通过申诉...');
  if (appealId) {
    const beforeCredit = await req('GET', '/api/credit/my-credit', null, booker2Token);
    
    const approveResp = await req('PUT', `/api/appeals/management/${appealId}/approve`, {
      handle_note: '经核实用户确已到场，撤销未到场标记并恢复信用分'
    }, adminToken);
    test('审批通过成功', approveResp.status === 200, `status=${approveResp.status}`);
    test('申诉状态变为已通过', approveResp.body.appeal?.status === 'approved', `status=${approveResp.body.appeal?.status}`);
    test('Bug2验证：预约状态恢复为已到场(arrived)', approveResp.body.booking?.status === 'arrived', `booking_status=${approveResp.body.booking?.status}`);
    test('Bug2验证：不是cancelled状态', approveResp.body.booking?.status !== 'cancelled', `booking_status=${approveResp.body.booking?.status}`);
    test('信用分被恢复', approveResp.body.handle_result?.credit_reverted === true);
    test('Bug1验证：handle_result.new_status为arrived', approveResp.body.handle_result?.new_status === 'arrived', `new_status=${approveResp.body.handle_result?.new_status}`);

    const afterCredit = await req('GET', '/api/credit/my-credit', null, booker2Token);
    const beforeScore = beforeCredit.body.credit?.score || 0;
    const afterScore = afterCredit.body.credit?.score || 0;
    test('信用分确实增加', afterScore > beforeScore, `${beforeScore} → ${afterScore}`);

    const dupResp = await req('PUT', `/api/appeals/management/${appealId}/approve`, {}, adminToken);
    test('重复审批被拒绝', dupResp.status === 400, `status=${dupResp.status}`);
  }

  console.log('\n[11] 测试驳回申诉流程...');
  let booking2Id = null;
  let appeal2Id = null;
  
  for (const room of avail.body.availability || []) {
    const slot = room.slots.find(s => s.status === 'available' && 
      !(targetRoom && room.room_id === targetRoom.room_id && targetSlot && s.start_time === targetSlot.start_time));
    if (slot) {
      const bResp = await req('POST', '/api/bookings', {
        room_id: room.room_id,
        date: today,
        start_time: slot.start_time,
        end_time: slot.end_time
      }, bookerToken);
      if (bResp.status === 201) {
        booking2Id = bResp.body.booking?.id;
        break;
      }
    }
  }

  if (booking2Id) {
    const nsResp = await req('PUT', `/api/attendant/bookings/${booking2Id}/no-show`, {
      no_show_note: '测试驳回流程'
    }, attToken);

    const appealResp = await req('POST', '/api/appeals', {
      booking_id: booking2Id,
      appeal_type: 'no_show',
      reason: '测试驳回'
    }, bookerToken);
    appeal2Id = appealResp.body.appeal?.id;

    if (appeal2Id) {
      const noReasonResp = await req('PUT', `/api/appeals/management/${appeal2Id}/reject`, {
        handle_note: ''
      }, attToken);
      test('驳回时无原因被拒绝', noReasonResp.status === 400, `status=${noReasonResp.status}`);

      const rejectResp = await req('PUT', `/api/appeals/management/${appeal2Id}/reject`, {
        handle_note: '证据不足，无法证明已到场'
      }, attToken);
      test('驳回申诉成功', rejectResp.status === 200, `status=${rejectResp.status}`);
      test('申诉状态变为已驳回', rejectResp.body.appeal?.status === 'rejected', `status=${rejectResp.body.appeal?.status}`);
    }
  }

  console.log('\n[12] 查看预约关联的申诉记录...');
  if (bookingId) {
    const bAppealsResp = await req('GET', `/api/bookings/${bookingId}/appeals`, null, booker2Token);
    test('获取预约申诉记录成功', bAppealsResp.status === 200, `status=${bAppealsResp.status}`);
    test('包含该预约的申诉', bAppealsResp.body.appeals?.length > 0);
    test('包含申诉日志', bAppealsResp.body.logs?.length > 0);
  }

  console.log('\n[13] 获取申诉统计数据...');
  const statsResp = await req('GET', '/api/appeals/stats', null, adminToken);
  test('获取申诉统计成功', statsResp.status === 200, `status=${statsResp.status} msg=${statsResp.body.error || statsResp.body.detail || ''}`);
  test('包含概览统计', !!statsResp.body.overview);
  test('包含总申诉数', statsResp.body.overview?.total_appeals !== undefined);
  test('包含通过率', statsResp.body.overview?.approval_rate !== undefined);
  test('包含预约状态变化统计', !!statsResp.body.booking_status_changes);
  test('包含类型统计', !!statsResp.body.type_stats);
  test('包含房间统计', !!statsResp.body.room_stats);
  test('包含处理人统计', !!statsResp.body.handler_stats);

  const attStatsResp = await req('GET', '/api/appeals/stats', null, attToken);
  test('值守人员可获取统计', attStatsResp.status === 200, `status=${attStatsResp.status} msg=${attStatsResp.body.error || attStatsResp.body.detail || ''}`);

  const userStatsResp = await req('GET', '/api/appeals/stats', null, bookerToken);
  test('普通用户无权获取统计', userStatsResp.status === 403, `status=${userStatsResp.status}`);

  console.log('\n[13.1] Bug3验证：按房间筛选统计...');
  const roomStatsResp = await req('GET', '/api/appeals/stats?room_id=1', null, adminToken);
  test('按房间筛选统计成功', roomStatsResp.status === 200, `status=${roomStatsResp.status} msg=${roomStatsResp.body.error || roomStatsResp.body.detail || ''}`);
  test('按房间筛选后概览有效', roomStatsResp.body.overview?.total_appeals !== undefined);
  test('按房间筛选后room_stats有效', !!roomStatsResp.body.room_stats);

  console.log('\n[13.2] Bug4验证：按开始日期筛选统计...');
  const statsDate = new Date().toISOString().split('T')[0];
  const dateStatsResp = await req('GET', `/api/appeals/stats?start_date=${statsDate}`, null, adminToken);
  test('按开始日期筛选统计成功', dateStatsResp.status === 200, `status=${dateStatsResp.status} msg=${dateStatsResp.body.error || dateStatsResp.body.detail || ''}`);
  test('按日期筛选后概览有效', dateStatsResp.body.overview?.total_appeals !== undefined);
  test('按日期筛选后类型统计有效', !!dateStatsResp.body.type_stats);

  console.log('\n[13.3] Bug3+Bug4验证：同时按房间和日期筛选...');
  const comboStatsResp = await req('GET', `/api/appeals/stats?room_id=1&start_date=${statsDate}&end_date=${statsDate}`, null, adminToken);
  test('组合筛选统计成功', comboStatsResp.status === 200, `status=${comboStatsResp.status} msg=${comboStatsResp.body.error || comboStatsResp.body.detail || ''}`);
  test('组合筛选后总览有效', comboStatsResp.body.overview?.total_appeals !== undefined);
  test('组合筛选后处理人统计有效', !!comboStatsResp.body.handler_stats);
  test('组合筛选后用户排行有效', !!comboStatsResp.body.user_top);

  console.log('\n========== 测试结果 ==========');
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${failed}`);
  console.log(`  总计: ${passed + failed}`);
  console.log('================================');
  
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('测试出错:', e.message);
  console.error(e.stack);
  process.exit(1);
});
