# Micros POS Interface - TCP Proxy Mode

ดักจับข้อมูล Guest Check-in / Check-out / Guest Change จาก Micros POS
โดย**แทรกกลาง**ระหว่าง SmartConnector (EBO) กับ Micros POS แบบ transparent

## สถาปัตยกรรม

```
  เดิม:
  SmartConnector ──────────────────── Micros POS
  192.168.204.2:49501  ──TCP──  10.242.28.4:5016


  ใหม่ (Proxy แทรกกลาง):
  SmartConnector ──▶ PROXY ──▶ Micros POS
  192.168.204.2      :5016     10.242.28.4:5016
                       │
                       ├─ Console Log
                       ├─ SQLite DB
                       └─ Webhook ──▶ API / BMS
```

## หลักการทำงาน

1. **Proxy ไม่แก้ไขข้อมูล** — ทุก byte ที่ SmartConnector ส่งมา จะถูก forward ไป Micros POS เหมือนเดิม ทุก byte ที่ Micros ตอบกลับ จะถูก forward กลับ SmartConnector เหมือนเดิม
2. **Proxy แค่อ่าน** — ขณะที่ forward ข้อมูล proxy จะ parse message ที่ผ่าน แล้ว log / เก็บ DB / ส่ง webhook
3. **SmartConnector ทำงานปกติ** — ได้รับข้อมูล GI/GO/GC ครบเหมือนเดิม

## ติดตั้ง

```bash
npm install
```

## ตั้งค่า config.json

```json
{
  "proxyPort": 5016,          // port ที่ proxy ฟัง
  "proxyHost": "0.0.0.0",

  "micros": {
    "host": "10.242.28.4",    // IP ของ Micros POS จริง
    "port": 5016              // port ของ Micros POS จริง
  },

  "webhook": {
    "url": "http://your-api/micros/event",   // หรือ null เพื่อปิด
    "retries": 3
  },

  "reconnect": {
    "enabled": true,          // auto-reconnect ถ้า Micros หลุด
    "delay": 5000,            // รอ 5 วินาที ก่อน retry
    "maxAttempts": 0          // 0 = retry ไม่จำกัด
  }
}
```

## ขั้นตอน Deploy

### Step 1: ติดตั้ง Proxy บนเครื่องกลาง

รัน proxy บนเครื่องที่ SmartConnector เข้าถึงได้ และ proxy เข้าถึง Micros POS ได้

```bash
npm install
npm start
```

### Step 2: เปลี่ยน SmartConnector ให้ชี้มาที่ Proxy

ใน EBO SmartConnector config เปลี่ยน Micros POS IP จากเดิม:
```
10.242.28.4:5016  (Micros POS ตรง)
```
เป็น:
```
<PROXY_IP>:5016   (Proxy)
```

### Step 3: Restart SmartConnector

หลัง restart, SmartConnector จะเชื่อมมาที่ proxy
→ proxy จะเชื่อมต่อไป Micros POS อัตโนมัติ
→ ข้อมูลไหลผ่านปกติ + ถูกดักเก็บ

## รัน

```bash
# Production
npm start

# Development (auto-reload)
npm run dev

# ทดสอบ (จำลอง Micros POS)
npm test
```

## Output ตัวอย่าง

```
========================================================
  Micros POS Interface - TCP PROXY MODE
========================================================

  SmartConnector --> :5016 --> 10.242.28.4:5016
      (EBO)          PROXY          (Micros POS)

  Waiting for SmartConnector connection...
========================================================

SmartConnector connected: 192.168.204.2:49501
Connecting to Micros POS 10.242.28.4:5016...
Connected to Micros POS
Proxy active: SmartConnector <-> Micros POS

=======================================================
  <-- CHECK-IN  GUEST CHECK-IN  (micros>ebo)
-------------------------------------------------------
  Guest#:     12402
  Room:       117
  Title:      Ms
  First Name: Diana
  Last Name:  EA
  VIP Level:  Gold
  Arrival:    2026-02-24
  Departure:  2026-02-25
  Share:      No
=======================================================
  -> Webhook OK (200)
```

## Database Query ตัวอย่าง

```sql
-- ดู check-in วันนี้
SELECT * FROM guest_events
WHERE event_type = 'GI' AND date(created_at) = date('now');

-- ดูประวัติห้อง 117
SELECT event_type, first_name, guest_name, share, created_at
FROM guest_events WHERE room_number = '117'
ORDER BY created_at;

-- สรุป event
SELECT event_type, direction, COUNT(*) as count
FROM guest_events GROUP BY event_type, direction;
```

## ความเสี่ยงและข้อควรระวัง

| ความเสี่ยง | ระดับ | วิธีรับมือ |
|------------|-------|-----------|
| Proxy พัง → SmartConnector หลุด | สูง | ใช้ pm2/systemd ให้ auto-restart |
| Network latency เพิ่ม | ต่ำ | Proxy เพิ่ม latency < 1ms |
| Proxy เครื่อง down | สูง | ตั้ง monitoring / fallback DNS |

### แนะนำ: ใช้ pm2 เพื่อให้ proxy ไม่ตาย

```bash
npm install -g pm2
pm2 start index.js --name micros-proxy
pm2 save
pm2 startup    # auto-start เมื่อเครื่อง reboot
```
