const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'practice_room.db');

let dbInstance = null;

async function getDb() {
  if (!dbInstance) {
    dbInstance = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });
    await initDb(dbInstance);
  }
  return dbInstance;
}

async function initDb(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'booker', 'attendant')),
      name TEXT NOT NULL,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      capacity INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS open_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      is_open INTEGER NOT NULL DEFAULT 1,
      close_reason TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (created_by) REFERENCES users(id),
      UNIQUE(room_id, date)
    );

    CREATE TABLE IF NOT EXISTS time_slot_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS temp_locks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      is_released INTEGER NOT NULL DEFAULT 0,
      release_reason TEXT,
      released_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked', 'arrived', 'no_show', 'cancelled')),
      lock_id TEXT,
      arrived_at DATETIME,
      cancelled_at DATETIME,
      no_show_at DATETIME,
      cancel_reason TEXT,
      no_show_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (lock_id) REFERENCES temp_locks(id)
    );

    CREATE TABLE IF NOT EXISTS temp_closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS deactivation_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS lock_release_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lock_id TEXT NOT NULL,
      user_id INTEGER,
      room_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      release_reason TEXT NOT NULL,
      released_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_credit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      score INTEGER NOT NULL DEFAULT 100,
      level TEXT NOT NULL DEFAULT 'good' CHECK(level IN ('excellent', 'good', 'fair', 'poor', 'restricted')),
      is_restricted INTEGER NOT NULL DEFAULT 0,
      restrict_reason TEXT,
      restrict_until DATETIME,
      total_bookings INTEGER NOT NULL DEFAULT 0,
      arrived_count INTEGER NOT NULL DEFAULT 0,
      no_show_count INTEGER NOT NULL DEFAULT 0,
      cancelled_count INTEGER NOT NULL DEFAULT 0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS credit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      booking_id INTEGER,
      change_type TEXT NOT NULL CHECK(change_type IN ('arrive', 'no_show', 'cancel_late', 'cancel_early', 'manual_adjust', 'reset', 'penalty', 'reward')),
      score_change INTEGER NOT NULL DEFAULT 0,
      score_before INTEGER NOT NULL,
      score_after INTEGER NOT NULL,
      level_before TEXT,
      level_after TEXT,
      reason TEXT NOT NULL,
      operator_id INTEGER,
      operator_role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (booking_id) REFERENCES bookings(id),
      FOREIGN KEY (operator_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS booking_reschedule_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      original_date TEXT NOT NULL,
      original_start_time TEXT NOT NULL,
      original_end_time TEXT NOT NULL,
      target_date TEXT NOT NULL,
      target_start_time TEXT NOT NULL,
      target_end_time TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      approver_id INTEGER,
      approver_role TEXT,
      reject_reason TEXT,
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (booking_id) REFERENCES bookings(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (approver_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS booking_reschedule_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      booking_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      action_detail TEXT,
      operator_id INTEGER,
      operator_role TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id) REFERENCES booking_reschedule_requests(id),
      FOREIGN KEY (booking_id) REFERENCES bookings(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (operator_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_room_date ON bookings(room_id, date);
    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_temp_locks_expires ON temp_locks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_temp_closures_room_date ON temp_closures(room_id, date);
    CREATE INDEX IF NOT EXISTS idx_open_dates_room_date ON open_dates(room_id, date);
    CREATE INDEX IF NOT EXISTS idx_user_credit_user ON user_credit(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_records_user ON credit_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_records_booking ON credit_records(booking_id);
    CREATE INDEX IF NOT EXISTS idx_reschedule_booking ON booking_reschedule_requests(booking_id);
    CREATE INDEX IF NOT EXISTS idx_reschedule_user ON booking_reschedule_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_reschedule_status ON booking_reschedule_requests(status);
    CREATE INDEX IF NOT EXISTS idx_reschedule_room_date ON booking_reschedule_requests(room_id, target_date);
    CREATE INDEX IF NOT EXISTS idx_reschedule_logs_booking ON booking_reschedule_logs(booking_id);
    CREATE INDEX IF NOT EXISTS idx_reschedule_logs_request ON booking_reschedule_logs(request_id);
  `);

  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    const hashedAdmin = await bcrypt.hash('admin123', 10);
    const hashedBooker = await bcrypt.hash('booker123', 10);
    const hashedAttendant = await bcrypt.hash('attendant123', 10);

    await db.run(`
      INSERT INTO users (username, password, role, name, phone) VALUES
      ('admin', ?, 'admin', '系统管理员', '13800000000'),
      ('booker', ?, 'booker', '预约用户张三', '13800000001'),
      ('booker2', ?, 'booker', '预约用户李四', '13800000002'),
      ('attendant', ?, 'attendant', '值守人员王五', '13800000003')
    `, [hashedAdmin, hashedBooker, hashedBooker, hashedAttendant]);

    await db.run(`
      INSERT INTO rooms (name, description, capacity, status) VALUES
      ('A101', '小型练琴房，立式钢琴', 1, 'active'),
      ('A102', '小型练琴房，立式钢琴', 1, 'active'),
      ('B201', '中型练琴房，三角钢琴', 2, 'active'),
      ('B202', '大型合奏室，多种乐器', 5, 'active')
    `);

    const rooms = await db.all('SELECT id FROM rooms');
    const timeSlots = [
      ['08:00', '09:00'], ['09:00', '10:00'], ['10:00', '11:00'],
      ['11:00', '12:00'], ['14:00', '15:00'], ['15:00', '16:00'],
      ['16:00', '17:00'], ['17:00', '18:00'], ['19:00', '20:00'],
      ['20:00', '21:00'], ['21:00', '22:00']
    ];

    for (const room of rooms) {
      for (const [start, end] of timeSlots) {
        await db.run(
          'INSERT INTO time_slot_templates (room_id, start_time, end_time, is_active) VALUES (?, ?, ?, 1)',
          [room.id, start, end]
        );
      }
    }

    console.log('数据库初始化完成，已创建默认数据');
    console.log('默认账号: admin/admin123, booker/booker123, booker2/booker123, attendant/attendant123');
  }
}

module.exports = { getDb };
