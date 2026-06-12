$baseUrl = "http://localhost:8112/api"

Write-Host "========== 测试1: Booker登录 ==========" -ForegroundColor Cyan
$bookerBody = @{username="booker";password="booker123"} | ConvertTo-Json
$bookerResp = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $bookerBody -ContentType "application/json"
$bookerToken = $bookerResp.token
Write-Host "Booker登录成功: $($bookerResp.user.name)" -ForegroundColor Green
$bookerHeaders = @{ Authorization = "Bearer $bookerToken" }

Write-Host ""
Write-Host "========== 测试2: 查询房间可用性 ==========" -ForegroundColor Cyan
$today = Get-Date -Format "yyyy-MM-dd"
$availability = Invoke-RestMethod -Uri "$baseUrl/rooms/availability?date=$today" -Method Get -Headers $bookerHeaders
Write-Host "查询日期: $today" -ForegroundColor Yellow
foreach ($room in $availability.availability) {
    $availCount = ($room.slots | Where-Object { $_.status -eq "available" }).Count
    $bookedCount = ($room.slots | Where-Object { $_.status -eq "booked" }).Count
    Write-Host "  房间[$($room.room_name)]: 可用时段=$availCount, 已预约=$bookedCount, 总时段=$($room.slots.Count)" -ForegroundColor White
}

Write-Host ""
Write-Host "========== 测试3: 创建临时锁 ==========" -ForegroundColor Cyan
$roomData = $availability.availability[0]
$freeSlot = $roomData.slots | Where-Object { $_.status -eq "available" } | Select-Object -First 1
if ($freeSlot) {
    $lockBody = @{
        room_id = $roomData.room_id
        date = $today
        start_time = $freeSlot.start_time
        end_time = $freeSlot.end_time
    } | ConvertTo-Json
    Write-Host "锁定房间[$($roomData.room_name)]时段[$($freeSlot.start_time)-$($freeSlot.end_time)]" -ForegroundColor Yellow
    $lockResp = Invoke-RestMethod -Uri "$baseUrl/locks" -Method Post -Body $lockBody -ContentType "application/json" -Headers $bookerHeaders
    $lockId = $lockResp.lock.id
    Write-Host "锁定成功, 锁ID=$lockId, 过期时间=$($lockResp.lock.expires_at)" -ForegroundColor Green
} else {
    Write-Host "没有可用时段，跳过创建锁" -ForegroundColor Red
    $lockId = $null
}

Write-Host ""
Write-Host "========== 测试4: 使用锁创建预约 ==========" -ForegroundColor Cyan
if ($lockId) {
    $bookingBody = @{
        room_id = $roomData.room_id
        date = $today
        start_time = $freeSlot.start_time
        end_time = $freeSlot.end_time
        lock_id = $lockId
    } | ConvertTo-Json
    $bookingResp = Invoke-RestMethod -Uri "$baseUrl/bookings" -Method Post -Body $bookingBody -ContentType "application/json" -Headers $bookerHeaders
    $bookingId = $bookingResp.booking.id
    Write-Host "预约成功: 预约ID=$bookingId, 房间=$($bookingResp.booking.room_name), 时段=$($bookingResp.booking.start_time)-$($bookingResp.booking.end_time)" -ForegroundColor Green
} else {
    $bookingId = $null
    Write-Host "跳过创建预约" -ForegroundColor Red
}

Write-Host ""
Write-Host "========== 测试5: 确认到场 ==========" -ForegroundColor Cyan
if ($bookingId) {
    $arriveResp = Invoke-RestMethod -Uri "$baseUrl/bookings/$bookingId/arrive" -Method Put -Headers $bookerHeaders
    Write-Host "到场确认成功: 状态=$($arriveResp.booking.status)" -ForegroundColor Green
}

Write-Host ""
Write-Host "========== 测试6: 创建第二个预约(booker2) ==========" -ForegroundColor Cyan
$booker2Body = @{username="booker2";password="booker123"} | ConvertTo-Json
$booker2Resp = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $booker2Body -ContentType "application/json"
$booker2Headers = @{ Authorization = "Bearer $($booker2Resp.token)" }
Write-Host "Booker2登录成功: $($booker2Resp.user.name)" -ForegroundColor Green

$roomData2 = $availability.availability[1]
$freeSlot2 = $roomData2.slots | Where-Object { $_.status -eq "available" } | Select-Object -First 1
if ($freeSlot2) {
    $bookingBody2 = @{
        room_id = $roomData2.room_id
        date = $today
        start_time = $freeSlot2.start_time
        end_time = $freeSlot2.end_time
    } | ConvertTo-Json
    $bookingResp2 = Invoke-RestMethod -Uri "$baseUrl/bookings" -Method Post -Body $bookingBody2 -ContentType "application/json" -Headers $booker2Headers
    $bookingId2 = $bookingResp2.booking.id
    Write-Host "Booker2预约成功: ID=$bookingId2, 房间=$($bookingResp2.booking.room_name)" -ForegroundColor Green
} else { $bookingId2 = $null }

Write-Host ""
Write-Host "========== 测试7: 值守人员标记未到场 ==========" -ForegroundColor Cyan
$attBody = @{username="attendant";password="attendant123"} | ConvertTo-Json
$attResp = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $attBody -ContentType "application/json"
$attHeaders = @{ Authorization = "Bearer $($attResp.token)" }
Write-Host "值守人员登录成功: $($attResp.user.name)" -ForegroundColor Green
if ($bookingId2) {
    $noShowResp = Invoke-RestMethod -Uri "$baseUrl/attendant/bookings/$bookingId2/no-show" -Method Put -Body '{"no_show_note":"超时未到"}' -ContentType "application/json" -Headers $attHeaders
    Write-Host "标记未到场成功: 状态=$($noShowResp.booking.status)" -ForegroundColor Green
}

Write-Host ""
Write-Host "========== 测试8: 管理员获取房间列表 ==========" -ForegroundColor Cyan
$adminBody = @{username="admin";password="admin123"} | ConvertTo-Json
$adminResp = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -Body $adminBody -ContentType "application/json"
$adminHeaders = @{ Authorization = "Bearer $($adminResp.token)" }
$roomsResp = Invoke-RestMethod -Uri "$baseUrl/admin/rooms" -Method Get -Headers $adminHeaders
Write-Host "房间总数: $($roomsResp.rooms.Count)" -ForegroundColor Yellow
foreach ($r in $roomsResp.rooms) {
    Write-Host "  房间[$($r.name)]: 状态=$($r.status), 容量=$($r.capacity), 时段数=$($r.time_slots.Count)" -ForegroundColor White
}

Write-Host ""
Write-Host "========== 测试9: 设置开放日期 ==========" -ForegroundColor Cyan
$tomorrow = (Get-Date).AddDays(1).ToString("yyyy-MM-dd")
$openBody = @{room_id=1; date=$tomorrow; is_open=1} | ConvertTo-Json
$openResp = Invoke-RestMethod -Uri "$baseUrl/admin/open-dates" -Method Post -Body $openBody -ContentType "application/json" -Headers $adminHeaders
Write-Host "设置开放日期[$tomorrow]成功: is_open=$($openResp.open_date.is_open)" -ForegroundColor Green

Write-Host ""
Write-Host "========== 测试10: 查询预约列表 ==========" -ForegroundColor Cyan
$bookingsResp = Invoke-RestMethod -Uri "$baseUrl/query/bookings?page_size=10" -Method Get -Headers $adminHeaders
Write-Host "预约总数: $($bookingsResp.pagination.total)" -ForegroundColor Yellow
foreach ($b in $bookingsResp.bookings) {
    Write-Host "  ID=$($b.id) [$($b.status)] 用户=$($b.user_name) 房间=$($b.room_name) $($b.date) $($b.start_time)-$($b.end_time)" -ForegroundColor White
}

Write-Host ""
Write-Host "========== 测试11: 统计-概览 ==========" -ForegroundColor Cyan
$overview = Invoke-RestMethod -Uri "$baseUrl/query/stats/overview" -Method Get -Headers $adminHeaders
Write-Host "总预约数: $($overview.overview.total_bookings)" -ForegroundColor Yellow
Write-Host "  已到场: $($overview.overview.arrived), 未到场: $($overview.overview.no_show), 已取消: $($overview.overview.cancelled)" -ForegroundColor White
Write-Host "  到场率: $($overview.overview.arrival_rate), 未到场率: $($overview.overview.no_show_rate)" -ForegroundColor White
Write-Host "  锁释放总数: $($overview.overview.locks_released_total), 过期释放: $($overview.overview.locks_expired_count)" -ForegroundColor White

Write-Host ""
Write-Host "========== 测试12: 统计-房间利用率 ==========" -ForegroundColor Cyan
$startD = (Get-Date).AddDays(-7).ToString("yyyy-MM-dd")
$endD = (Get-Date).AddDays(7).ToString("yyyy-MM-dd")
$utilResp = Invoke-RestMethod -Uri "$baseUrl/query/stats/room-utilization?start_date=$startD&end_date=$endD" -Method Get -Headers $adminHeaders
foreach ($u in $utilResp.room_utilization) {
    Write-Host "  房间[$($u.room_name)]: 可用时段=$($u.total_available_slots), 已用=$($u.used_slots), 利用率=$($u.utilization_rate)" -ForegroundColor White
}

Write-Host ""
Write-Host "========== 所有测试完成! ==========" -ForegroundColor Green
