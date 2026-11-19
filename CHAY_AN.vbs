Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 1. Tự động dọn dẹp và tắt sạch tiến trình cũ trước khi chạy để đảm bảo nạp 100% code mới nhất
WshShell.Run "cmd /c taskkill /F /IM node.exe", 0, True
WScript.Sleep 800

' 2. Khởi động máy chủ Node.js hoàn toàn ẩn dưới nền (WindowStyle = 0: Không hiện cửa sổ đen)
WshShell.Run "cmd /c cd /d """ & currentDir & """ && runtime\node.exe server.js", 0, False

' 3. Đợi 1.5 giây để server sẵn sàng rồi tự động mở trình duyệt
WScript.Sleep 1500
WshShell.Run "http://localhost:4000"
