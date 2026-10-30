# Feedback Hub — nhận thông báo & badge

## Luồng dữ liệu

```
Feedback Hub (server SoloHost)
    ↑  server-only token
Host app  GET /api/feedback/sync?anonymous_id=…
    ↓  { ok, policy, notices[], donate }
Browser UniversalFeedback.create({ onUnread, onSync })
    ↓
Badge trên nút AI (#aiBadge) + tab Feedback (#fbTabBadge)
```

## Cách app nhận thông báo

1. **Server** (`feedback-service.js`) gọi Hub:
   - `GET /api/client-policy?app_id=&version=` → `donate`, templates, payment
   - `GET /api/notices?app_id=&anonymous_id=` → danh sách notice chưa đọc

2. **Client** sau khi load trang:
   ```js
   const fb = window.UniversalFeedback.create({
     onUnread(n) { setUnread(n); },  // n = notices.length
     onSync(sync) {
       renderDonate(sync.donate);    // tài khoản ủng hộ từ Hub
       renderNotices(sync.notices);  // danh sách tin
     }
   });
   fb.sync();                        // lần đầu
   // optional: setInterval(() => fb.sync(), 60000);
   ```

3. **Badge**
   - `count > 0` → hiện số (tối đa `9+`)
   - `count === 0` → **không** hiện số 0; `hidden` + `display:none` + text rỗng

4. **Đã đọc**
   - User bấm “Đã đọc” trên notice → `POST /api/feedback/read/:id`
   - Giảm unread; khi hết tin → badge biến mất
   - Mở tab Feedback có thể gọi `setUnread(0)` nếu host coi là đã xem

5. **Donate**
   - Chỉ từ `sync.donate` (object có thể lồng: `pi_wallet`, `mb_account`, …)
   - Flatten để hiển thị; **không** hard-code số tài khoản trong app

6. **Gửi feedback**
   - `POST /api/feedback` body: `{ type, message, rating, anonymous_id, … }`
   - Token chỉ gắn ở server; browser không bao giờ thấy ingest token

## Cấu hình Hub (mặc định trong module — chỉ server)

| Field | Default |
|-------|---------|
| Hub ID | `SHFH-CANNOI-0905428801` |
| Base URL | `http://14.176.78.46:8090` |
| Ingest token | trong `feedback-service.js` / env `SHFH_INGEST_TOKEN` |

Public browser config (`GET /api/feedback/config`) chỉ trả: `enabled`, `hubId`, `appId`, `appName`, `version` — **không** có token.
