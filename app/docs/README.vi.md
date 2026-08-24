# Tianjiang App

[简体中文](../README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md) · [ไทย](./README.th.md) · [Tiếng Việt](./README.vi.md) · [繁體中文](./README.zhtw.md)

Tianjiang là ứng dụng cục bộ để sản xuất manga drama bằng AI, bao gồm chuẩn bị truyện, chuyển thể kịch bản, tài sản nhân vật và bối cảnh, storyboard và tạo video. Dự án cùng cấu hình mô hình cá nhân được lưu trong vùng dữ liệu cục bộ của tài khoản trung tâm đang đăng nhập.

## Yêu cầu

- Nền tảng phát hành được kiểm soát hiện tại là Windows x64.
- Phát triển từ mã nguồn cần Node.js 24.13.1 và Yarn 1.22.22.
- Tên bộ cài: `天将漫创-<version>-win-x64-setup.exe`.

## Cài đặt

1. Lấy bộ cài Windows x64 từ kênh Release chính thức do nhóm bảo trì công bố. Không dùng URL phỏng đoán hoặc mirror chưa xác minh.
2. Chạy bộ cài và chọn thư mục đích; ứng dụng được cài trực tiếp vào thư mục đó.
3. Microsoft VC++ x64 đã được đóng gói để cài ngoại tuyến.
4. Khởi động Tianjiang và đăng nhập bằng tài khoản trung tâm; thông tin đăng nhập cục bộ cũ không còn áp dụng.

## Sử dụng lần đầu

1. Mở **Cài đặt → Dịch vụ mô hình** và cấu hình nhà cung cấp văn bản, hình ảnh và video.
2. Tạo dự án hoặc nhập tiểu thuyết hay kịch bản.
3. Thực hiện lần lượt phần truyện, kịch bản, tài sản, storyboard và video; theo dõi tác vụ từ xa trong Trung tâm tác vụ.
4. Dự án và cấu hình cá nhân được tách theo tài khoản; quyền nhóm, khóa và đồng bộ do dịch vụ trung tâm quyết định.

## Nhà cung cấp mô hình

- Endpoint, tên mô hình và khóa thuộc cấu hình cục bộ của tài khoản hiện tại.
- Không đưa bí mật vào nhật ký, đồng bộ nhóm hoặc thư mục của tài khoản khác.
- Kiểm tra riêng nhà cung cấp văn bản, hình ảnh và video.
- Kiểm tra cập nhật cần `TIANJIANG_UPDATE_MANIFEST_URL`; thiếu cấu hình này không chặn bàn làm việc.

## Di chuyển dữ liệu

Định danh máy hiện tại là `tianjiang`, giao thức desktop là `tianjiang://`. Di chuyển một chiều có phiên bản sẽ nâng cấp ID nhà cung cấp, tham chiếu mô hình, thư mục tài khoản và tệp động. SQLite được sao lưu trước khi ghi; lỗi xác minh hay phân tích sẽ dừng mà không ghi đè bản dữ liệu duy nhất.

## Phát triển và kiểm tra

```powershell
cd app
yarn install --frozen-lockfile
yarn dev
yarn test:tianjiang
yarn lint
yarn build
```

## Khắc phục sự cố

- Phân biệt lỗi mạng trung tâm, xác thực và runtime cục bộ.
- Khi mô hình lỗi, kiểm tra URL, khóa, tên mô hình, tài khoản, mã lỗi và request ID.
- Khi di chuyển xung đột, giữ nguyên `migration-backups` và thư mục recovery.
- Với lỗi bộ cài, xác nhận đang dùng gói Windows x64 chính thức.

## Giấy phép và thông báo

Bản quyền và điều khoản nằm trong [LICENSE](../LICENSE); thành phần bên thứ ba và ghi nhận nguồn nằm trong [NOTICES.txt](../NOTICES.txt). Phải giữ cả hai tệp khi phân phối lại.
