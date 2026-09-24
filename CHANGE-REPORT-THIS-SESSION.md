# App Builder — Pi SoloHost — Phiên sửa lỗi này

## Đã làm

### 1. Phân loại/sắp xếp lại nút hành động nhanh
UI vốn đã được nhóm gần đúng cấu trúc yêu cầu từ trước (5 nhóm: Create App / Upgrade App / Publish / Tools / Support). Chỉ có **thứ tự trong nhóm Tools** chưa khớp — đã sửa từ `Import, Zip, Run ZIP, GitHub, Sandbox` thành đúng thứ tự yêu cầu: **Zip, Import, Run ZIP, Sandbox, GitHub**.
- Chỉ di chuyển vị trí thẻ `<button>` trong file `public/index.html`.
- Không đổi `data-action`, `id`, text, hay bất kỳ logic nào của nút nào.
- Không gộp/xóa/thay thế bất kỳ chức năng nào (Publish và GitHub vẫn tách biệt, Sandbox vẫn tách biệt khỏi Run, Upgrade vẫn là workflow riêng).
- Không tạo thêm nút mới.

### 2. Lỗi nút Upgrade
Không thể chạy lại server thật (cần Docker + database) để tái hiện 100% trong sandbox này, nhưng đọc kỹ luồng code thì phát hiện một lỗ hổng thật: hàm kiểm tra app trước khi nâng cấp (`inspectUpgrade`) **không có giới hạn thời gian ở tầng ngoài cùng**. Nếu bước kiểm tra (cài đặt/test app vừa import) bị treo vì một repo GitHub bất thường, job sẽ **kẹt ở trạng thái "running" mãi mãi** — không báo lỗi, không báo xong, giống hệt hiện tượng bạn mô tả (bấm Upgrade, thấy "GitHub source imported. Starting..." rồi im lặng, phải thử lại nhiều lần).

**Đã sửa** (`src/jobs/pipeline.js`): thêm một giới hạn thời gian an toàn (5 phút) bọc quanh bước kiểm tra này. Đây là thay đổi CHỈ THÊM VÀO (additive) — không đổi logic kiểm tra/nâng cấp hiện có, chỉ đảm bảo nếu nó treo, job sẽ tự động báo lỗi rõ ràng thay vì im lặng mãi mãi. Hàng "catch lỗi" xử lý thất bại đã có sẵn trong hệ thống job từ trước, tôi chỉ tận dụng nó.

## Giữ nguyên

- Toàn bộ logic Build phía sau (theo đúng yêu cầu, không hiện nút riêng vì người dùng bắt đầu bằng chat).
- Toàn bộ workflow Improve/Edit/Run, Publish, GitHub import, Sandbox, Import/Export ZIP — không đổi hành vi.
- 4 nhóm còn lại (Create App, Upgrade App, Publish, Support) — không cần sửa vì đã đúng cấu trúc yêu cầu từ trước.

## Phát hiện thêm (không tự sửa, cần bạn quyết định)

Bộ test có sẵn của chính project (`tests/ui.test.js`) có 2 test kiểm tra sự tồn tại của nút `data-action="build"` và `data-action="analyze"` — nhưng **2 nút này không tồn tại trong UI hiện tại** (đã có từ trước khi tôi sửa, không phải do tôi gây ra). Vì yêu cầu của bạn nói rõ "không tạo thêm nút mới" và danh sách nút bạn liệt kê không có Build/Analyze, tôi **không tự thêm nút** để thỏa mãn 2 test này. Nếu bạn muốn, có 2 hướng xử lý: (a) xóa/cập nhật 2 test này cho khớp UI hiện tại, hoặc (b) nếu Build/Analyze thực ra vẫn cần một nút, cho tôi biết để thêm đúng vị trí theo cấu trúc bạn muốn.

## Kiểm tra đã chạy

- Rà soát toàn bộ `public/index.html`: đủ 11 nút `data-action`, không mất nút nào sau khi sắp xếp lại.
- `node --check src/jobs/pipeline.js`: cú pháp hợp lệ.
- `node --test tests/*.test.js` (toàn bộ 174 test có sẵn của project): **172 pass / 2 fail** — 2 fail là lỗi có sẵn từ trước (nêu trên), không phải do thay đổi lần này. So với trạng thái trước khi sửa: không có test nào bị hỏng thêm.
